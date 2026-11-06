import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import type { Db, RawEvent } from '../types.js';
import { workspaceId } from '../core/scope.js';
import { isWorkspaceExcluded, redactSecrets } from '../core/privacy.js';
import { DEFAULTS, type PluginConfig } from '../config.js';
import { IGNORED_EVENT_TYPES } from '../dsh/session-listener.js';
import { runRules } from './rules.js';

export const ZSTD_MAGIC = 0xFD2FB528;

export interface FrameRange {
  start: number;
  end: number;
}

export interface ScanResult {
  frames: FrameRange[];
  tornStart?: number;
}

/**
 * 按结构扫描 zstd 帧边界，不使用扫描 magic 子串的脆弱方法 (§A.4.1)
 */
export function scanZstdFrames(buffer: Buffer): ScanResult {
  const frames: FrameRange[] = [];
  let offset = 0;
  const len = buffer.length;

  while (offset < len) {
    const frameStart = offset;

    // 至少需要 4 字节 magic
    if (offset + 4 > len) {
      return { frames, tornStart: frameStart };
    }

    const magic = buffer.readUInt32LE(offset);
    if (magic !== ZSTD_MAGIC) {
      // magic 错误，说明损坏，返回已有完整帧和撕裂起点
      return { frames, tornStart: frameStart };
    }
    offset += 4;

    // 至少需要 1 字节 descriptor
    if (offset + 1 > len) {
      return { frames, tornStart: frameStart };
    }

    const descriptor = buffer[offset];
    offset += 1;

    // descriptor & 24 必须为 0 (保留位)
    if ((descriptor & 24) !== 0) {
      return { frames, tornStart: frameStart };
    }

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;

    // window descriptor 长度为 singleSegment ? 0 : 1
    const windowDescLen = singleSegment ? 0 : 1;
    // dictionary id 长度为 dictionaryFlag === 3 ? 4 : dictionaryFlag
    const dictIdLen = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    // content size 长度为 contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag)
    const contentSizeLen = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);

    const headerRemaining = windowDescLen + dictIdLen + contentSizeLen;
    if (offset + headerRemaining > len) {
      return { frames, tornStart: frameStart };
    }
    offset += headerRemaining;

    // 循环读取 3 字节小端 block header
    let isLastBlock = false;
    let corrupted = false;

    while (!isLastBlock) {
      if (offset + 3 > len) {
        return { frames, tornStart: frameStart };
      }

      const b0 = buffer[offset];
      const b1 = buffer[offset + 1];
      const b2 = buffer[offset + 2];
      const blockHeader = b0 | (b1 << 8) | (b2 << 16);
      offset += 3;

      isLastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;

      if (blockType === 3) {
        // Reserved block type (invalid)
        corrupted = true;
        break;
      }

      // type = 1 (RLE block), payload 长度为 1; 其它为 blockSize
      const payloadLen = blockType === 1 ? 1 : blockSize;

      if (offset + payloadLen > len) {
        return { frames, tornStart: frameStart };
      }
      offset += payloadLen;
    }

    if (corrupted) {
      return { frames, tornStart: frameStart };
    }

    // 若 checksum=true，跳过 4 字节校验和
    if (checksum) {
      if (offset + 4 > len) {
        return { frames, tornStart: frameStart };
      }
      offset += 4;
    }

    frames.push({ start: frameStart, end: offset });
  }

  return { frames };
}

const SUBAGENT_PROMPT_RE =
  /(?:Your parent agent id is|\bSubagent\b|<system-reminder>\s*You are teammate|你是智能体团队成员|你是团队中的|你现在是《|你是《|你是一名资深|你是三人称微缩场景项目中的|你是服务器只读基线调查员)/i;

function readProjCacheJsonFile(
  filePath: string
): { header: any; rawLines: string[] } | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    const rec = data?.record;
    const identity = rec?.identity;
    if (!identity || identity.formatVersion !== 4 || typeof identity.cwd !== 'string' || !identity.cwd) {
      return null;
    }

    const firstText = rec?.rows?.titleInput?.val?.first?.text || '';
    if (firstText && SUBAGENT_PROMPT_RE.test(firstText)) {
      return null;
    }

    const turns = rec?.rows?.turnOutline?.val?.turns;
    if (!Array.isArray(turns) || turns.length === 0) {
      return null;
    }

    const firstPrompt = typeof turns[0]?.prompt === 'string' ? turns[0].prompt : '';
    if (firstPrompt && SUBAGENT_PROMPT_RE.test(firstPrompt)) {
      return null;
    }

    const sessionId =
      rec.sessionId ||
      path.basename(filePath, '.json').replace(/^session_/, 'session-');
    const baseTime = typeof identity.createdAt === 'number' ? identity.createdAt : Date.now();

    const rawLines: string[] = [];
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      if (!t || typeof t !== 'object') continue;
      const turnNum = typeof t.turn === 'number' ? t.turn : i + 1;
      const seqBase = typeof t.seq === 'number' ? t.seq : (i + 1) * 10;
      const promptText = typeof t.prompt === 'string' ? t.prompt.trim() : '';
      const respText = typeof t.response === 'string' ? t.response.trim() : '';

      if (promptText && !SUBAGENT_PROMPT_RE.test(promptText)) {
        rawLines.push(
          JSON.stringify({
            seq: seqBase,
            time: baseTime + i * 2000,
            type: 'user/message',
            data: {
              turn: turnNum,
              source: { kind: 'user' },
              text: promptText,
            },
          })
        );
      }
      if (respText) {
        rawLines.push(
          JSON.stringify({
            seq: seqBase + 1,
            time: baseTime + i * 2000 + 1000,
            type: 'assistant/message',
            data: {
              turn: turnNum,
              text: respText,
            },
          })
        );
      }
    }

    if (rawLines.length === 0) return null;

    return {
      header: {
        version: 4,
        id: sessionId,
        cwd: identity.cwd,
        createdAt: baseTime,
      },
      rawLines,
    };
  } catch {
    return null;
  }
}

/**
 * 解压与读取 session 文件 (.jsonl / .jsonl.zstd / .json)
 */
export function readSessionFile(filePath: string): { header: any; rawLines: string[] } | null {
  if (!fs.existsSync(filePath)) return null;
  if (filePath.endsWith('.json')) {
    return readProjCacheJsonFile(filePath);
  }

  let text = '';
  const isZstd = filePath.endsWith('.zstd');

  if (isZstd) {
    const buf = fs.readFileSync(filePath);
    const { frames, tornStart } = scanZstdFrames(buf);
    if (frames.length === 0 && tornStart === undefined) {
      return null;
    }

    const decompressedChunks: Buffer[] = [];
    for (const frame of frames) {
      try {
        const chunk = (zlib as any).zstdDecompressSync(buf.subarray(frame.start, frame.end));
        decompressedChunks.push(chunk);
      } catch (err: any) {
        console.warn(`[dsh-memory] Frame decompress failed in ${filePath}:`, err?.message || err);
        return null;
      }
    }

    // 尝试恢复撕裂尾帧
    if (tornStart !== undefined && tornStart < buf.length) {
      try {
        const tornBuf = buf.subarray(tornStart);
        const flushOpt = (zlib as any).constants?.ZSTD_e_flush;
        if (typeof flushOpt === 'number') {
          const recovered = (zlib as any).zstdDecompressSync(tornBuf, {
            finishFlush: flushOpt,
          });
          if (recovered && recovered.length > 0) {
            decompressedChunks.push(recovered);
          }
        }
      } catch {
        // 撕裂尾帧恢复失败时仅忽略撕裂尾部，保留前面已解出的完整帧
      }
    }

    text = Buffer.concat(decompressedChunks).toString('utf8');
  } else {
    text = fs.readFileSync(filePath, 'utf8');
  }

  if (!text) return null;

  // 丢弃未完整换行的 JSONL 尾行 (§A.4.1)
  const hadTrailingNewline = text.endsWith('\n');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!hadTrailingNewline && lines.length > 0) {
    lines.pop(); // 丢弃未完整换行的半条尾行
  }

  if (lines.length === 0) return null;

  // 第 1 行为 header
  let header: any;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return null;
  }

  // 只支持 version=4
  if (!header || header.version !== 4) {
    return null;
  }

  // 必须有 cwd
  if (!header.cwd || typeof header.cwd !== 'string') {
    return null;
  }

  return {
    header,
    rawLines: lines.slice(1),
  };
}

export interface BackfillStats {
  rawEvents: number;
  filteredEvents: number;
  privacyRejected: number;
  writableEvents: number;
  newEventsAdded: number;
  memoriesCreated: number;
  skippedFiles: number;
  processedFiles: number;
}

export interface BackfillOptions {
  sessionsDir?: string;
  filePaths?: string[];
  dryRun?: boolean;
  cfg?: PluginConfig;
}

/**
 * 历史会话回填器 (§7 M2-T4)
 */
export function runBackfill(db: Db, options: BackfillOptions = {}): BackfillStats {
  const cfg = options.cfg || DEFAULTS;
  const dryRun = options.dryRun ?? false;

  const stats: BackfillStats = {
    rawEvents: 0,
    filteredEvents: 0,
    privacyRejected: 0,
    writableEvents: 0,
    newEventsAdded: 0,
    memoriesCreated: 0,
    skippedFiles: 0,
    processedFiles: 0,
  };

  // 收集待处理文件列表
  let targetFiles: string[] = [];
  if (options.filePaths && options.filePaths.length > 0) {
    targetFiles = options.filePaths;
  } else if (options.sessionsDir) {
    if (fs.existsSync(options.sessionsDir)) {
      targetFiles = findSessionFiles(options.sessionsDir, true);
    }
  } else {
    const dshHome = path.join(os.homedir(), '.dsh');
    const sessionsRoot = path.join(dshHome, 'sessions');
    if (fs.existsSync(sessionsRoot)) {
      targetFiles.push(...findSessionFiles(sessionsRoot, false));
    }
    const projCacheDirs = [
      path.join(dshHome, 'storages', 'session_projcache', 'sessions'),
      path.join(dshHome, 'storages', 'session_projcache_archive_manager_v2', 'sessions'),
    ];
    for (const dir of projCacheDirs) {
      if (fs.existsSync(dir)) {
        targetFiles.push(...findSessionFiles(dir, true));
      }
    }
  }

  if (targetFiles.length === 0) {
    return stats;
  }

  for (const file of targetFiles) {
    const parsed = readSessionFile(file);
    if (!parsed) {
      stats.skippedFiles++;
      continue;
    }

    const { header, rawLines } = parsed;

    // 工作区排除检查
    if (isWorkspaceExcluded(header.cwd, cfg.excludeWorkspaces)) {
      stats.skippedFiles++;
      continue;
    }

    const wsId = workspaceId(header.cwd);
    const sessionId = header.id || header.sessionId || path.basename(path.dirname(file));

    // 解析事件行并收集
    const validEvents: Array<{
      event: any;
      role: 'user' | 'assistant' | 'tool' | 'system' | 'compaction';
      origin_kind: 'user' | 'assistant' | 'tool' | 'web' | 'system';
      tool_name: string | null;
      is_error: number;
      text: string | null;
    }> = [];

    for (const line of rawLines) {
      stats.rawEvents++;

      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        stats.filteredEvents++;
        continue;
      }

      if (!ev || typeof ev.type !== 'string' || typeof ev.seq !== 'number') {
        stats.filteredEvents++;
        continue;
      }

      // 忽略事件类型
      if (IGNORED_EVENT_TYPES.has(ev.type)) {
        stats.filteredEvents++;
        continue;
      }

      // 回声过滤
      if (ev.type === 'user/message') {
        const source = ev.data?.source;
        if (source?.kind === 'plugin' && source?.plugin === 'dsh-memory') {
          stats.filteredEvents++;
          continue;
        }
        if (source?.kind === 'runtime-context') {
          stats.filteredEvents++;
          continue;
        }
      }

      // 角色与文本映射
      let role: 'user' | 'assistant' | 'tool' | 'system' | 'compaction' | null = null;
      let origin_kind: 'user' | 'assistant' | 'tool' | 'web' | 'system' = 'system';
      let tool_name: string | null = null;
      let is_error = 0;
      let rawText = '';

      if (ev.type === 'user/message') {
        role = 'user';
        origin_kind = ev.data?.source?.kind === 'user' ? 'user' : 'system';
        const content = ev.data?.content;
        if (Array.isArray(content)) {
          rawText = content
            .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b: any) => b.text)
            .join('\n');
        } else if (typeof ev.data?.text === 'string') {
          rawText = ev.data.text;
        }
      } else if (ev.type === 'assistant/message') {
        role = 'assistant';
        origin_kind = 'assistant';
        const content = ev.data?.message?.content || ev.data?.content;
        if (Array.isArray(content)) {
          rawText = content
            .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b: any) => b.text)
            .join('\n');
        } else if (typeof ev.data?.text === 'string') {
          rawText = ev.data.text;
        }
      } else if (ev.type === 'tool/call') {
        role = 'tool';
        origin_kind = 'tool';
        tool_name = ev.data?.name || null;
        if (typeof ev.data?.arguments === 'string') {
          rawText = ev.data.arguments;
        } else if (ev.data?.arguments) {
          try {
            rawText = JSON.stringify(ev.data.arguments);
          } catch {}
        }
      } else if (ev.type === 'tool/result') {
        role = 'tool';
        origin_kind = 'tool';
        tool_name = ev.data?.name || null;
        is_error = ev.data?.isError || ev.data?.is_error || ev.data?.status === 'error' ? 1 : 0;
        const content = ev.data?.message?.content || ev.data?.content;
        if (Array.isArray(content)) {
          rawText = content
            .filter((b: any) => b && typeof b.text === 'string')
            .map((b: any) => b.text)
            .join('\n');
        } else if (typeof ev.data?.text === 'string') {
          rawText = ev.data.text;
        }
      } else if (ev.type.startsWith('compaction')) {
        role = 'compaction';
        origin_kind = 'system';
      } else {
        stats.filteredEvents++;
        continue;
      }

      // 隐私检测：含敏感原值则统计为隐私拒绝，原值绝不入库
      const priv = redactSecrets(rawText);
      if (priv.hasSensitive) {
        stats.privacyRejected++;
        continue;
      }

      const maxLen = role === 'user' ? 2000 : 800;
      const finalText = rawText ? priv.text.slice(0, maxLen) : null;

      stats.writableEvents++;
      validEvents.push({
        event: ev,
        role,
        origin_kind,
        tool_name,
        is_error,
        text: finalText,
      });
    }

    stats.processedFiles++;

    if (dryRun || validEvents.length === 0) {
      continue;
    }

    // 按 (time, session_id, seq) 排序，保证历史事件先后顺序
    validEvents.sort((a, b) => {
      const timeA = typeof a.event.time === 'number' ? a.event.time : 0;
      const timeB = typeof b.event.time === 'number' ? b.event.time : 0;
      if (timeA !== timeB) return timeA - timeB;
      return a.event.seq - b.event.seq;
    });

    // 事务写入 raw_events 并执行规则抽取
    db.transaction(() => {
      for (const item of validEvents) {
        const ev = item.event;
        const time = typeof ev.time === 'number' ? ev.time : Date.now();
        const turn = typeof ev.data?.turn === 'number' ? ev.data.turn : null;

        const rawEvent: RawEvent = {
          session_id: sessionId,
          seq: ev.seq,
          workspace_id: wsId,
          type: ev.type,
          time,
          turn,
          role: item.role,
          origin_kind: item.origin_kind,
          tool_name: item.tool_name,
          is_error: item.is_error,
          text: item.text,
          processed: 0,
        };

        const res = db.run(
          `INSERT INTO raw_events (
            session_id, seq, workspace_id, type, time, turn, role, origin_kind, tool_name, is_error, text, processed
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT (session_id, seq) DO NOTHING`,
          [
            rawEvent.session_id,
            rawEvent.seq,
            rawEvent.workspace_id,
            rawEvent.type,
            rawEvent.time,
            rawEvent.turn,
            rawEvent.role,
            rawEvent.origin_kind,
            rawEvent.tool_name,
            rawEvent.is_error,
            rawEvent.text,
          ]
        );

        const isInserted = Number(res.changes) > 0;
        if (isInserted) {
          stats.newEventsAdded++;
        }

        if (isInserted || (rawEvent.role === 'user' && rawEvent.origin_kind === 'user')) {
          try {
            const initialMemCount = db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM memories')?.cnt || 0;
            runRules(db, rawEvent, cfg, time);
            const afterMemCount = db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM memories')?.cnt || 0;
            if (afterMemCount > initialMemCount) {
              stats.memoriesCreated += (afterMemCount - initialMemCount);
            }
          } catch (err: any) {
            console.warn('[dsh-memory] backfill runRules error:', err?.message || err);
          }
        }
      }
    });
  }

  return stats;
}

/**
 * 递归查找目录下的 session 文件
 */
function findSessionFiles(dir: string, includeJson = false): string[] {
  const result: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        result.push(...findSessionFiles(fullPath, includeJson));
      } else if (ent.isFile()) {
        if (
          ent.name.includes('.jsonl') ||
          ent.name.endsWith('.zstd') ||
          (includeJson && ent.name.endsWith('.json'))
        ) {
          result.push(fullPath);
        }
      }
    }
  } catch {}
  return result;
}
