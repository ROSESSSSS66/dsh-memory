import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as fzstd from 'fzstd';
import { DEFAULTS, type PluginConfig } from '../config.js';
import { isWorkspaceExcluded, redactSecrets } from '../core/privacy.js';
import { normalizeWorkspacePath, rememberWorkspacePath, workspaceId } from '../core/scope.js';
import { IGNORED_EVENT_TYPES, isIgnoredUserMessageSource } from '../dsh/session-listener.js';
import type { Db, RawEvent } from '../types.js';
import { runRules } from './rules.js';

export const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_SKIPPABLE_MAGIC_MIN = 0x184d2a50;
const ZSTD_SKIPPABLE_MAGIC_MAX = 0x184d2a5f;

export const MAX_COMPRESSED_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_DECOMPRESSED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ZSTD_WINDOW_BYTES = 64 * 1024 * 1024;
const MAX_SCAN_RECURSION_DEPTH = 8;
const HEADER_PROBE_BYTES = 64 * 1024;
const CHECKPOINT_META_KEY = 'backfill_checkpoints_v1';
const MAX_CHECKPOINT_ENTRIES = 5000;

const SESSION_FILE_RE = /\.(?:jsonl|jsonl\.zstd|zstd)$/i;
const JSON_FILE_RE = /\.json$/i;

export interface FrameRange {
  start: number;
  end: number;
  windowSize?: number;
  contentSize?: number;
}

export interface ScanResult {
  frames: FrameRange[];
  tornStart?: number;
}

interface ParsedZstdHeader {
  headerEnd: number;
  checksum: boolean;
  windowSize?: number;
  contentSize?: number;
}

interface FileCheckpoint {
  size: number;
  mtimeMs: number;
}

type CheckpointMap = Record<string, FileCheckpoint>;

/**
 * 共享工具调用 ID 提取辅助函数（供 backfill.ts 与 session-listener.ts 统一复用）
 */
export function extractToolCallId(data: any): string | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data.callId ?? data.toolCallId ?? data.id;
  if (raw === undefined || raw === null || raw === '') return null;
  return String(raw);
}

/**
 * 共享工具结果调用 ID 提取辅助函数（覆盖 DSH 真实日志中 data.message / data.source 多种结构）
 */
export function extractToolResultCallId(data: any): string | null {
  if (!data || typeof data !== 'object') return null;
  const raw =
    data.toolCallId ?? data.message?.toolCallId ?? data.source?.callId ?? data.callId ?? data.id;
  if (raw === undefined || raw === null || raw === '') return null;
  return String(raw);
}

function makeBudgetError(maxBytes: number): Error & { code: string } {
  const err = new Error(`Zstd decompressed output exceeds budget (${maxBytes} bytes)`) as Error & {
    code: string;
  };
  err.code = 'ERR_BUFFER_TOO_LARGE';
  return err;
}

function isBudgetOverflowError(err: any): boolean {
  if (!err) return false;
  if (err.code === 'ERR_BUFFER_TOO_LARGE') return true;
  const msg = String(err.message || '');
  return /maxOutputLength|exceeds budget|ERR_BUFFER_TOO_LARGE/i.test(msg);
}

/**
 * 解析单个标准 Zstd 帧头部（含 Window_Descriptor 与 Frame_Content_Size，RFC 8878 §3.1.1）
 */
function parseZstdFrameHeader(buffer: Buffer, frameStart: number): ParsedZstdHeader | null {
  const len = buffer.length;
  if (frameStart + 5 > len) return null;
  if (buffer.readUInt32LE(frameStart) !== ZSTD_MAGIC) return null;

  let offset = frameStart + 4;
  const descriptor = buffer[offset++];

  // descriptor bits 3 & 4 (mask 24) 必须为 0
  if ((descriptor & 24) !== 0) return null;

  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 32) !== 0;
  const checksum = (descriptor & 4) !== 0;
  const dictionaryFlag = descriptor & 3;

  const windowDescLen = singleSegment ? 0 : 1;
  const dictIdLen = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentSizeLen = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;

  if (offset + windowDescLen + dictIdLen + contentSizeLen > len) {
    return null;
  }

  let windowSize: number | undefined;
  if (!singleSegment) {
    const windowDesc = buffer[offset++];
    const exponent = windowDesc >>> 3;
    const mantissa = windowDesc & 7;
    // 使用 Math.pow 避免 exponent >= 22 时 32 位左移溢出回绕成小值
    const windowBase = 2 ** (10 + exponent);
    windowSize = windowBase + (windowBase / 8) * mantissa;
  }

  offset += dictIdLen;

  let contentSize: number | undefined;
  if (contentSizeLen === 1) {
    contentSize = buffer[offset];
  } else if (contentSizeLen === 2) {
    contentSize = buffer.readUInt16LE(offset) + 256;
  } else if (contentSizeLen === 4) {
    contentSize = buffer.readUInt32LE(offset);
  } else if (contentSizeLen === 8) {
    const big = buffer.readBigUInt64LE(offset);
    contentSize = big > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(big);
  }
  offset += contentSizeLen;

  if (singleSegment && contentSize !== undefined) {
    windowSize = contentSize;
  }

  return {
    headerEnd: offset,
    checksum,
    windowSize,
    contentSize,
  };
}

/**
 * 按结构扫描 zstd 帧边界，支持 RFC 8878 Skippable Frames 并解析 Window_Descriptor / Frame_Content_Size (§A.4.1)
 */
export function scanZstdFrames(buffer: Buffer): ScanResult {
  const frames: FrameRange[] = [];
  let offset = 0;
  const len = buffer.length;

  while (offset < len) {
    const frameStart = offset;

    if (offset + 4 > len) {
      return { frames, tornStart: frameStart };
    }

    const magic = buffer.readUInt32LE(offset);

    // RFC 8878 §3.1.2 Skippable Frames (0x184D2A50 .. 0x184D2A5F)
    if (magic >= ZSTD_SKIPPABLE_MAGIC_MIN && magic <= ZSTD_SKIPPABLE_MAGIC_MAX) {
      if (offset + 8 > len) {
        return { frames, tornStart: frameStart };
      }
      const skipSize = buffer.readUInt32LE(offset + 4);
      const frameEnd = offset + 8 + skipSize;
      if (frameEnd > len) {
        return { frames, tornStart: frameStart };
      }
      offset = frameEnd;
      continue;
    }

    if (magic !== ZSTD_MAGIC) {
      return { frames, tornStart: frameStart };
    }

    const parsedHeader = parseZstdFrameHeader(buffer, frameStart);
    if (!parsedHeader) {
      return { frames, tornStart: frameStart };
    }
    offset = parsedHeader.headerEnd;

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
    if (parsedHeader.checksum) {
      if (offset + 4 > len) {
        return { frames, tornStart: frameStart };
      }
      offset += 4;
    }

    frames.push({
      start: frameStart,
      end: offset,
      windowSize: parsedHeader.windowSize,
      contentSize: parsedHeader.contentSize,
    });
  }

  return { frames };
}

/**
 * 使用流式 fzstd.Decompress 做严格有界解压，绝不调用无上限的 fzstd.decompress()
 */
function decompressWithBoundedFzstd(
  input: Uint8Array,
  maxOutputBytes: number,
  allowIncomplete = false
): Buffer {
  if (maxOutputBytes <= 0) {
    throw makeBudgetError(maxOutputBytes);
  }
  const parts: Buffer[] = [];
  let total = 0;
  const decompressor = new fzstd.Decompress((chunk) => {
    if (!chunk || chunk.length === 0) return;
    total += chunk.length;
    if (total > maxOutputBytes) {
      throw makeBudgetError(maxOutputBytes);
    }
    parts.push(Buffer.from(chunk));
  });

  try {
    decompressor.push(input, !allowIncomplete);
  } catch (err: any) {
    if (isBudgetOverflowError(err)) throw err;
    if (allowIncomplete && parts.length > 0) {
      return Buffer.concat(parts, total);
    }
    throw err;
  }

  return Buffer.concat(parts, total);
}

function decompressZstdFrameBounded(
  frameBuf: Buffer,
  maxOutputBytes: number,
  options: {
    windowSize?: number;
    contentSize?: number;
    isTorn?: boolean;
  } = {}
): Buffer {
  if (maxOutputBytes <= 0) {
    throw makeBudgetError(maxOutputBytes);
  }

  // 先根据帧头元数据拦截解压炸弹（防止 fzstd / libzstd 分配超大窗口）
  const headerInfo =
    options.windowSize !== undefined || options.contentSize !== undefined
      ? options
      : (parseZstdFrameHeader(frameBuf, 0) ?? {});

  if (headerInfo.windowSize !== undefined && headerInfo.windowSize > MAX_ZSTD_WINDOW_BYTES) {
    throw makeBudgetError(MAX_ZSTD_WINDOW_BYTES);
  }
  if (headerInfo.contentSize !== undefined && headerInfo.contentSize > maxOutputBytes) {
    throw makeBudgetError(maxOutputBytes);
  }

  const nativeZstd = (zlib as any).zstdDecompressSync;
  const flushOpt = (zlib as any).constants?.ZSTD_e_flush;
  const canUseNative =
    typeof nativeZstd === 'function' && (!options.isTorn || typeof flushOpt === 'number');

  if (canUseNative) {
    const zstdOpts: Record<string, unknown> = {
      maxOutputLength: maxOutputBytes,
    };
    if (options.isTorn && typeof flushOpt === 'number') {
      zstdOpts.finishFlush = flushOpt;
    }
    return nativeZstd(frameBuf, zstdOpts) as Buffer;
  }

  const view = new Uint8Array(frameBuf.buffer, frameBuf.byteOffset, frameBuf.byteLength);
  return decompressWithBoundedFzstd(view, maxOutputBytes, options.isTorn ?? false);
}

const SUBAGENT_PROMPT_RE =
  /(?:Your parent agent id is|<system-reminder>\s*You are teammate|You are running as a subagent|你是智能体团队成员|你是团队中的(?:子智能体|协作成员))/i;

function readProjCacheJsonFile(
  filePath: string,
  excludeWorkspaces: string[] = []
): { header: any; rawLines: string[] } | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    const rec = data?.record;
    const identity = rec?.identity;
    if (
      !identity ||
      identity.formatVersion !== 4 ||
      typeof identity.cwd !== 'string' ||
      !identity.cwd
    ) {
      return null;
    }

    if (excludeWorkspaces.length > 0 && isWorkspaceExcluded(identity.cwd, excludeWorkspaces)) {
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
      rec.sessionId || path.basename(filePath, '.json').replace(/^session_/, 'session-');
    const baseTime = typeof identity.createdAt === 'number' ? identity.createdAt : Date.now();

    const rawLines: string[] = [];
    let nextSeq = 1;
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      if (!t || typeof t !== 'object') continue;
      const turnNum = typeof t.turn === 'number' ? t.turn : i + 1;
      const rawSeq =
        typeof t.seq === 'number' && Number.isFinite(t.seq) && t.seq >= 1
          ? Math.floor(t.seq)
          : (i + 1) * 10;
      const promptSeq = Math.max(nextSeq, rawSeq);
      const promptText = typeof t.prompt === 'string' ? t.prompt.trim() : '';
      const respText = typeof t.response === 'string' ? t.response.trim() : '';

      if (promptText && !SUBAGENT_PROMPT_RE.test(promptText)) {
        rawLines.push(
          JSON.stringify({
            seq: promptSeq,
            time: baseTime + i * 2000,
            type: 'user/message',
            data: {
              turn: turnNum,
              // projcache 摘要缺少真实 user 来源证明，统一标记为 system，防止越权自动审批为 active 记忆
              source: { kind: 'projcache' },
              text: promptText,
            },
          })
        );
        nextSeq = promptSeq + 1;
      }
      if (respText) {
        const respSeq = Math.max(nextSeq, promptSeq + 1);
        rawLines.push(
          JSON.stringify({
            seq: respSeq,
            time: baseTime + i * 2000 + 1000,
            type: 'assistant/message',
            data: {
              turn: turnNum,
              text: respText,
            },
          })
        );
        nextSeq = respSeq + 1;
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

function parseAndValidateHeaderLine(line: string, excludeWorkspaces: string[] = []): any | null {
  let header: any;
  try {
    header = JSON.parse(line);
  } catch {
    return null;
  }
  if (!header || header.version !== 4) return null;
  if (!header.cwd || typeof header.cwd !== 'string') return null;
  if (excludeWorkspaces.length > 0 && isWorkspaceExcluded(header.cwd, excludeWorkspaces)) {
    return null;
  }
  return header;
}

export interface ReadSessionFileOptions {
  excludeWorkspaces?: string[];
  maxCompressedBytes?: number;
  maxDecompressedBytes?: number;
}

/**
 * 解压与读取 session 文件 (.jsonl / .jsonl.zstd / .zstd / .json)
 * 严格执行读取前文件大小/符号链接校验、累计输出预算、早停排除工作区校验及单帧损坏保留前序帧。
 */
export function readSessionFile(
  filePath: string,
  options: ReadSessionFileOptions = {}
): { header: any; rawLines: string[] } | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return null;
  }

  const excludeWorkspaces = options.excludeWorkspaces ?? [];
  const maxCompressedBytes = options.maxCompressedBytes ?? MAX_COMPRESSED_FILE_BYTES;
  const maxDecompressedBytes = options.maxDecompressedBytes ?? MAX_DECOMPRESSED_FILE_BYTES;

  const isJson = JSON_FILE_RE.test(filePath);
  const isZstd = filePath.endsWith('.zstd');
  const maxFileBytes = isZstd ? maxCompressedBytes : maxDecompressedBytes;
  if (stat.size <= 0 || stat.size > maxFileBytes) {
    return null;
  }

  if (isJson) {
    return readProjCacheJsonFile(filePath, excludeWorkspaces);
  }

  let text = '';

  if (isZstd) {
    const buf = fs.readFileSync(filePath);
    const { frames, tornStart } = scanZstdFrames(buf);
    if (frames.length === 0 && tornStart === undefined) {
      return null;
    }

    let remainingOutputBytes = maxDecompressedBytes;
    const decompressedChunks: Buffer[] = [];
    let headerChecked = false;
    let headerProbeText = '';
    let hitCorruptFrame = false;

    for (const frame of frames) {
      if (frame.windowSize !== undefined && frame.windowSize > MAX_ZSTD_WINDOW_BYTES) {
        console.warn(`[dsh-memory] Rejected zstd frame with oversized window in ${filePath}`);
        return null;
      }
      if (frame.contentSize !== undefined && frame.contentSize > remainingOutputBytes) {
        console.warn(`[dsh-memory] Rejected zstd frame exceeding output budget in ${filePath}`);
        return null;
      }

      const frameBuf = buf.subarray(frame.start, frame.end);
      let chunk: Buffer;
      try {
        chunk = decompressZstdFrameBounded(frameBuf, remainingOutputBytes, {
          windowSize: frame.windowSize,
          contentSize: frame.contentSize,
        });
      } catch (err: any) {
        if (isBudgetOverflowError(err)) {
          console.warn(
            `[dsh-memory] Zstd output budget exceeded in ${filePath}:`,
            err?.message || err
          );
          return null;
        }
        // 非 OOM 的单帧损坏：保留前面已成功解出的帧 0..K-1，仅截断后续帧
        console.warn(`[dsh-memory] Frame decompress failed in ${filePath}:`, err?.message || err);
        hitCorruptFrame = true;
        break;
      }

      remainingOutputBytes -= chunk.length;
      decompressedChunks.push(chunk);

      // 仅解压首帧（及首行）即检查 header.version 与 excludeWorkspaces，命中排除目录时绝不继续解压剩余帧
      if (!headerChecked) {
        headerProbeText += chunk.toString('utf8');
        const nlIdx = headerProbeText.indexOf('\n');
        if (nlIdx >= 0) {
          const firstLine = headerProbeText.slice(0, nlIdx).trim();
          const validHeader = parseAndValidateHeaderLine(firstLine, excludeWorkspaces);
          if (!validHeader) {
            return null;
          }
          headerChecked = true;
          headerProbeText = '';
        }
      }
    }

    // 尝试恢复撕裂尾帧（在剩余累计预算内）
    if (
      !hitCorruptFrame &&
      tornStart !== undefined &&
      tornStart < buf.length &&
      remainingOutputBytes > 0
    ) {
      try {
        const tornBuf = buf.subarray(tornStart);
        const recovered = decompressZstdFrameBounded(tornBuf, remainingOutputBytes, {
          isTorn: true,
        });
        if (recovered && recovered.length > 0) {
          remainingOutputBytes -= recovered.length;
          decompressedChunks.push(recovered);
        }
      } catch (err: any) {
        if (isBudgetOverflowError(err)) {
          console.warn(`[dsh-memory] Torn zstd tail exceeded output budget in ${filePath}`);
          return null;
        }
        // 撕裂尾帧恢复失败时仅忽略撕裂尾部，保留前面已解出的完整帧
      }
    }

    if (decompressedChunks.length === 0) return null;
    text = Buffer.concat(decompressedChunks).toString('utf8');
  } else {
    // 纯文本 JSONL：先读首行检查 header 与排除工作区，避免整文件读取排除目录或非 v4 大文件
    const probeLen = Math.min(stat.size, HEADER_PROBE_BYTES);
    const probeBuf = Buffer.allocUnsafe(probeLen);
    let bytesRead = 0;
    const fd = fs.openSync(filePath, 'r');
    try {
      bytesRead = fs.readSync(fd, probeBuf, 0, probeLen, 0);
    } finally {
      fs.closeSync(fd);
    }

    const actualProbe = probeBuf.subarray(0, bytesRead);
    const nlIdx = actualProbe.indexOf(0x0a);
    if (nlIdx < 0) {
      // 文件没有换行符（或单行超过 64KB），无法构成完整 v4 JSONL 头行
      return null;
    }

    const firstLine = actualProbe.subarray(0, nlIdx).toString('utf8').trim();
    if (!parseAndValidateHeaderLine(firstLine, excludeWorkspaces)) {
      return null;
    }

    text =
      bytesRead === stat.size ? actualProbe.toString('utf8') : fs.readFileSync(filePath, 'utf8');
  }

  if (!text) return null;

  // 先切分原始行并丢弃未以 '\n' 结尾的半条尾行，再 trim + filter(Boolean)，避免尾随空格误删最后一条合法事件
  const rawSplit = text.split('\n');
  if (!text.endsWith('\n') && rawSplit.length > 0) {
    rawSplit.pop();
  }
  const lines = rawSplit.map((l) => l.trim()).filter(Boolean);

  if (lines.length === 0) return null;

  // 第 1 行为 header
  const header = parseAndValidateHeaderLine(lines[0], excludeWorkspaces);
  if (!header) {
    return null;
  }

  return {
    header,
    rawLines: lines.slice(1),
  };
}

function deriveFallbackSessionId(filePath: string): string {
  const abs = path.resolve(filePath);
  const stem = path
    .basename(abs)
    .replace(/\.(?:v\d+\.)?(?:jsonl\.zstd|jsonl|zstd|json)$/i, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 48);
  const hash = crypto.createHash('sha256').update(abs).digest('hex').slice(0, 10);
  return `${stem || 'session'}_${hash}`;
}

function canonicalFileKey(filePath: string): string {
  return normalizeWorkspacePath(filePath) || path.resolve(filePath);
}

function loadBackfillCheckpoints(db: Db): CheckpointMap {
  try {
    const row = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
      CHECKPOINT_META_KEY,
    ]);
    if (!row?.value) return {};
    const parsed = JSON.parse(row.value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as CheckpointMap;
    }
  } catch {}
  return {};
}

function saveBackfillCheckpoints(db: Db, checkpoints: CheckpointMap): void {
  const keys = Object.keys(checkpoints);
  let toStore: CheckpointMap = checkpoints;
  if (keys.length > MAX_CHECKPOINT_ENTRIES) {
    // 仅保留最新 MAX_CHECKPOINT_ENTRIES 条，防止 meta 无限膨胀
    const sortedEntries = Object.entries(checkpoints)
      .sort((a, b) => (b[1]?.mtimeMs || 0) - (a[1]?.mtimeMs || 0))
      .slice(0, MAX_CHECKPOINT_ENTRIES);
    toStore = Object.fromEntries(sortedEntries);
  }
  db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
    CHECKPOINT_META_KEY,
    JSON.stringify(toStore),
  ]);
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
  enqueueOfflineJobs?: boolean;
  force?: boolean;
}

/**
 * 历史会话回填器 (§7 M2-T4)
 */
export function runBackfill(db: Db, options: BackfillOptions = {}): BackfillStats {
  const cfg = options.cfg || DEFAULTS;
  const dryRun = options.dryRun ?? false;
  const force = options.force ?? false;
  // 历史回填默认不入队离线 LLM 任务，防止陈年历史会话挤爆/饿死实时任务队列
  const enqueueOfflineJobs = options.enqueueOfflineJobs ?? false;

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

  // 收集待处理文件列表（真实会话日志优先于 projcache 兜底 JSON）
  let targetFiles: string[] = [];
  if (options.filePaths && options.filePaths.length > 0) {
    targetFiles = options.filePaths;
  } else if (options.sessionsDir) {
    if (fs.existsSync(options.sessionsDir)) {
      const found = findSessionFiles(options.sessionsDir, true);
      const primary = found.filter((f) => !JSON_FILE_RE.test(f));
      const fallbackJson = found.filter((f) => JSON_FILE_RE.test(f));
      targetFiles = [...primary, ...fallbackJson];
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

  const checkpoints: CheckpointMap = !dryRun ? loadBackfillCheckpoints(db) : {};
  const seenSessionIds = new Set<string>();

  for (const file of targetFiles) {
    // 校验文件为常规文件（拒绝符号链接与目录）
    let fileStat: fs.Stats;
    try {
      fileStat = fs.lstatSync(file);
    } catch {
      stats.skippedFiles++;
      continue;
    }
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      stats.skippedFiles++;
      continue;
    }

    const fileKey = canonicalFileKey(file);
    // 增量检查点：未变化且已完成的会话文件直接跳过（dryRun 或 force=true 时不跳过）
    if (!dryRun && !force) {
      const cp = checkpoints[fileKey];
      if (cp && cp.size === fileStat.size && cp.mtimeMs === fileStat.mtimeMs) {
        stats.skippedFiles++;
        continue;
      }
    }

    // 单个文件读取或解码失败（或命中排除工作区）只跳过该文件，不中断整次回填
    let parsed: ReturnType<typeof readSessionFile> = null;
    try {
      parsed = readSessionFile(file, { excludeWorkspaces: cfg.excludeWorkspaces });
    } catch {}
    if (!parsed) {
      stats.skippedFiles++;
      continue;
    }

    const { header, rawLines } = parsed;

    // 二次工作区排除防御检查
    if (isWorkspaceExcluded(header.cwd, cfg.excludeWorkspaces)) {
      stats.skippedFiles++;
      continue;
    }

    const wsId = workspaceId(header.cwd);
    const sessionId =
      (typeof header.id === 'string' && header.id.trim()) ||
      (typeof header.sessionId === 'string' && header.sessionId.trim()) ||
      deriveFallbackSessionId(file);

    const isProjCacheFile = JSON_FILE_RE.test(file);
    if (isProjCacheFile) {
      // sessions/ 真实日志已覆盖或 raw_events 中已有该 sessionId 时，projcache 仅作兜底直接跳过
      if (seenSessionIds.has(sessionId)) {
        stats.skippedFiles++;
        continue;
      }
      const alreadyInDb = db.get<{ ok: number }>(
        'SELECT 1 AS ok FROM raw_events WHERE session_id = ? LIMIT 1',
        [sessionId]
      );
      if (alreadyInDb) {
        stats.skippedFiles++;
        continue;
      }
    }

    // 解析事件行并收集（先用局部变量统计，事务提交成功后再计入 stats）
    let fileRawEvents = 0;
    let fileFilteredEvents = 0;
    let filePrivacyRejected = 0;
    let fileWritableEvents = 0;

    const validEvents: Array<{
      event: any;
      role: 'user' | 'assistant' | 'tool' | 'system' | 'compaction';
      origin_kind: 'user' | 'assistant' | 'tool' | 'web' | 'system';
      tool_name: string | null;
      is_error: number;
      text: string | null;
    }> = [];

    const toolCallNames = new Map<string, string>();
    for (const line of rawLines) {
      fileRawEvents++;

      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        fileFilteredEvents++;
        continue;
      }

      if (!ev || typeof ev.type !== 'string' || typeof ev.seq !== 'number') {
        fileFilteredEvents++;
        continue;
      }

      // 忽略事件类型
      if (IGNORED_EVENT_TYPES.has(ev.type)) {
        fileFilteredEvents++;
        continue;
      }

      // 回声过滤
      if (ev.type === 'user/message') {
        const source = ev.data?.source;
        const isDshMemory =
          source?.kind === 'dsh-memory' ||
          (source?.kind === 'plugin' && source?.plugin === 'dsh-memory');
        if (isDshMemory) {
          fileFilteredEvents++;
          continue;
        }
        if (isIgnoredUserMessageSource(source)) {
          fileFilteredEvents++;
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
        origin_kind = !isProjCacheFile && ev.data?.source?.kind === 'user' ? 'user' : 'system';
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
        const callId = extractToolCallId(ev.data);
        if (callId && tool_name) toolCallNames.set(callId, tool_name);
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
        const resCallId = extractToolResultCallId(ev.data);
        tool_name = (resCallId ? toolCallNames.get(resCallId) : undefined) || ev.data?.name || null;
        is_error =
          ev.data?.isError ||
          ev.data?.is_error ||
          ev.data?.message?.isError ||
          ev.data?.status === 'error'
            ? 1
            : 0;
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
        fileFilteredEvents++;
        continue;
      }

      // 隐私检测：含敏感原值则统计为隐私拒绝，原值绝不入库
      const priv = redactSecrets(rawText);
      if (priv.hasSensitive) {
        filePrivacyRejected++;
        continue;
      }

      const maxLen = role === 'user' ? 2000 : 800;
      const finalText = rawText ? priv.text.slice(0, maxLen) : null;

      fileWritableEvents++;
      validEvents.push({
        event: ev,
        role,
        origin_kind,
        tool_name,
        is_error,
        text: finalText,
      });
    }

    if (dryRun) {
      stats.rawEvents += fileRawEvents;
      stats.filteredEvents += fileFilteredEvents;
      stats.privacyRejected += filePrivacyRejected;
      stats.writableEvents += fileWritableEvents;
      stats.processedFiles++;
      seenSessionIds.add(sessionId);
      continue;
    }

    // 严格按 seq 升序排序，保证同会话事件与工具调用/结果因果顺序
    validEvents.sort((a, b) => a.event.seq - b.event.seq);

    // 事务写入 raw_events、执行规则抽取并原子更新检查点；仅在提交成功后累加 stats
    try {
      let fileNewEvents = 0;
      let fileMemoriesCreated = 0;
      const nextCheckpoint: FileCheckpoint = {
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      };
      const nextCheckpointsMap: CheckpointMap = {
        ...checkpoints,
        [fileKey]: nextCheckpoint,
      };

      db.transaction(() => {
        rememberWorkspacePath(db, header.cwd);

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
            fileNewEvents++;
            try {
              const ruleRes = db.transaction(() =>
                runRules(db, rawEvent, cfg, time, { enqueueOfflineJobs })
              );
              fileMemoriesCreated += ruleRes.memoriesCreated;
            } catch (err: any) {
              console.warn('[dsh-memory] backfill runRules error:', err?.message || err);
            }
          }
        }

        saveBackfillCheckpoints(db, nextCheckpointsMap);
      });

      // 事务提交成功后才更新内存检查点与统计数据
      checkpoints[fileKey] = nextCheckpoint;
      stats.rawEvents += fileRawEvents;
      stats.filteredEvents += fileFilteredEvents;
      stats.privacyRejected += filePrivacyRejected;
      stats.writableEvents += fileWritableEvents;
      stats.newEventsAdded += fileNewEvents;
      stats.memoriesCreated += fileMemoriesCreated;
      stats.processedFiles++;
      seenSessionIds.add(sessionId);
    } catch (txErr: any) {
      console.warn(
        `[dsh-memory] backfill transaction failed for ${file}:`,
        txErr?.message || txErr
      );
      stats.skippedFiles++;
    }
  }

  return stats;
}

/**
 * 递归查找目录下的 session 文件（严格扩展名匹配、拒绝符号链接、最大递归深度 8）
 */
function findSessionFiles(dir: string, includeJson = false, depth = 0): string[] {
  if (depth > MAX_SCAN_RECURSION_DEPTH) return [];
  const result: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        result.push(...findSessionFiles(fullPath, includeJson, depth + 1));
      } else if (ent.isFile()) {
        if (SESSION_FILE_RE.test(ent.name) || (includeJson && JSON_FILE_RE.test(ent.name))) {
          result.push(fullPath);
        }
      }
    }
  } catch {}
  return result;
}
