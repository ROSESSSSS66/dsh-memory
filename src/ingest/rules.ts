import crypto from 'node:crypto';
import type { Db, RawEvent, CandidateInput, Scope, MemoryType } from '../types.js';
import { upsertCandidate } from '../core/writer.js';
import { redactSecrets } from '../core/privacy.js';
import { DEFAULTS, type PluginConfig } from '../config.js';

export const PREFERENCE_INDICATOR_REGEX =
  /(?:以后|今后|总是|一律|永远|不要再|别再|每次都|统一使用|必须使用|严禁|切勿|绝不|不能水文|不要产生新|上限上调到|from now on|always|never|must always|do not ever)/i;

const ONE_OFF_TASK_PROMPT_REGEX =
  /^(?:请\s*)?(?:帮我|给我|替我)?\s*(?:创建一个|写一个|生成一个|画一个|绘制一个|制作一个)/i;

const DURABLE_HABIT_MARKER_REGEX =
  /(?:以后|今后|总是|一律|永远|每次都|统一使用|必须使用|from now on|always|must always)/i;

export const CORRECTION_REGEX =
  /(?:不对|错了|不是这样|搞错|不行|没用|还是不行|重来|wrong|incorrect|doesn't work|not what)/i;

export interface SlotResolution {
  slotKey: string | null;
  scope?: Scope;
  type?: MemoryType;
}

/**
 * 固定槽位规则表 (§5.11)
 */
export function resolveFixedSlot(text: string): SlotResolution {
  const s = text.trim();

  // 1. 回复语言偏好
  if (
    /(?:回复|回答|说话)(?:一律|总是|全部|都)?用?(?:中文|汉语|zh-CN)/i.test(s) ||
    /(?:reply|respond|answer)\s+(?:in\s+)?chinese/i.test(s)
  ) {
    return { slotKey: 'user.pref.reply_language', scope: 'user', type: 'preference' };
  }
  if (
    /(?:回复|回答|说话)(?:一律|总是|全部|都)?用?(?:英文|英语|en-US)/i.test(s) ||
    /(?:reply|respond|answer)\s+(?:in\s+)?english/i.test(s)
  ) {
    return { slotKey: 'user.pref.reply_language', scope: 'user', type: 'preference' };
  }

  // 2. 项目数据库配置
  const dbMatch = s.match(/(?:项目|本项目)?(?:的)?(?:数据库|db)(?:是|已迁移到|使用|用|采用)\s*([a-zA-Z0-9_\-\.]+)/i);
  if (dbMatch) {
    return { slotKey: 'project.database', scope: 'workspace', type: 'semantic' };
  }

  // 3. 项目偏好：禁止/避免某技术
  const avoidMatch = s.match(/(?:本项目|当前项目|项目)?(?:中)?(?:不要再用|别再用|禁止使用|不再使用)\s*([a-zA-Z0-9_\-\.]+)/i);
  if (avoidMatch) {
    return {
      slotKey: `project.pref.avoid.${avoidMatch[1].toLowerCase()}`,
      scope: 'workspace',
      type: 'preference',
    };
  }

  // 4. 工程构建与打包约束
  if (/(?:打包成\s*exe|不要产生新的文件)/i.test(s)) {
    return { slotKey: 'project.pref.packaging', scope: 'workspace', type: 'preference' };
  }

  // 5. 站点/网关请求上限配置
  if (/(?:请求上限|单请求上限).*?(?:上调到|设为|改为)/i.test(s)) {
    return { slotKey: 'project.config.request_limit', scope: 'workspace', type: 'semantic' };
  }

  // 6. 创作与细纲防注水质量偏好
  if (/(?:不能水文|绝不水文)/i.test(s)) {
    return { slotKey: 'project.pref.writing_quality', scope: 'workspace', type: 'preference' };
  }

  return { slotKey: null };
}

/**
 * 规范化工具错误文本 (R4: 路径→十六进制→数字→引用内容)
 */
export function normalizeErrorText(rawText: string): string {
  if (!rawText) return '';
  // 1. 先脱敏
  let s = redactSecrets(rawText).text;
  // 2. 路径 (Windows 盘符路径 + Unix 路径)
  s = s.replace(/[a-zA-Z]:\\[^\s:;,)"']+/g, '<PATH>');
  s = s.replace(/(?:^|[\s:;,"'])\/(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+/g, ' <PATH>');
  // 3. 十六进制
  s = s.replace(/\b0x[0-9a-fA-F]+\b/g, '<HEX>');
  s = s.replace(/\b[0-9a-fA-F]{8,}\b/g, '<HEX>');
  // 4. 数字
  s = s.replace(/\b\d+\b/g, '<NUM>');
  // 5. 引用内容 (双引号和单引号中的文本)
  s = s.replace(/"[^"\r\n]*"/g, '<STR>');
  s = s.replace(/'[^'\r\n]*'/g, '<STR>');
  // 6. 收缩空白
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 规则抽取主入口 (纯本地、O(文本长度) 计算)
 */
export function runRules(
  db: Db,
  event: RawEvent,
  cfg: PluginConfig = DEFAULTS,
  now: number = Date.now()
): void {
  if (!event) return;

  // ==========================================
  // R1: 真实用户显式记忆
  // ==========================================
  if (event.origin_kind === 'user' && event.role === 'user' && event.text) {
    const trimmed = event.text.trim();
    const r1Match = trimmed.match(/^(?:请)?(?:记住|记下|remember)[:：,，\s]*([\s\S]{4,400})$/i);
    if (r1Match) {
      const rawContent = r1Match[1].trim();
      if (rawContent.length >= 4 && rawContent.length <= 400) {
        // 隐私扫描：若包含未脱敏敏感信息或 REDACTED 掩码，直接拒绝
        const privCheck = redactSecrets(rawContent);
        if (!privCheck.hasSensitive && !rawContent.includes('[REDACTED:')) {
          const slotRes = resolveFixedSlot(rawContent);
          let type: MemoryType = slotRes.type || (PREFERENCE_INDICATOR_REGEX.test(rawContent) ? 'preference' : 'semantic');
          
          let scope: Scope = slotRes.scope || (type === 'preference' ? 'user' : 'workspace');
          if (/(?:本项目|当前项目|这个项目|本仓库|当前工作区)/i.test(rawContent)) {
            scope = 'workspace';
          }

          const candidate: CandidateInput = {
            type,
            content: rawContent,
            slot_key: slotRes.slotKey,
            scope,
            workspaceId: event.workspace_id,
            sessionId: event.session_id,
            source_kind: 'user',
            origin_kinds: ['user'],
            confidence: 1.0,
            sources: [
              {
                session_id: event.session_id,
                seq: event.seq,
                kind: 'user_msg',
                excerpt: rawContent.slice(0, 300),
              },
            ],
            valid_from: event.time || now,
            status: 'active',
            actor: 'user',
          };

          upsertCandidate(db, candidate, now);
        }
      }
      // R1 匹配后不再尝试 R2
      db.run('UPDATE raw_events SET processed = 1 WHERE session_id = ? AND seq = ?', [event.session_id, event.seq]);
      return;
    }
  }

  // ==========================================
  // R2: 真实用户偏好陈述 (短消息 <= 300 字)
  // ==========================================
  if (event.origin_kind === 'user' && event.role === 'user' && event.text) {
    const trimmed = event.text.trim();
    if (trimmed.length <= 300 && PREFERENCE_INDICATOR_REGEX.test(trimmed)) {
      const slotRes = resolveFixedSlot(trimmed);
      const isOneOffTask =
        !slotRes.slotKey &&
        ONE_OFF_TASK_PROMPT_REGEX.test(trimmed) &&
        !DURABLE_HABIT_MARKER_REGEX.test(trimmed);
      const isQuotedOrExample = /(?:^>|```|例如|比如|有人说|示例|规则说明|“|”|")/i.test(trimmed);
      const privCheck = redactSecrets(trimmed);
      if (!isOneOffTask && !privCheck.hasSensitive && !trimmed.includes('[REDACTED:')) {
        let scope: Scope = slotRes.scope || 'user';
        if (/(?:本项目|当前项目|这个项目|本仓库|当前工作区)/i.test(trimmed)) {
          scope = 'workspace';
        }

        const candidate: CandidateInput = {
          type: slotRes.type || 'preference',
          content: trimmed,
          slot_key: slotRes.slotKey,
          scope,
          workspaceId: event.workspace_id,
          sessionId: event.session_id,
          source_kind: 'user',
          origin_kinds: ['user'],
          confidence: isQuotedOrExample ? 0.5 : 1.0,
          sources: [
            {
              session_id: event.session_id,
              seq: event.seq,
              kind: 'user_msg',
              excerpt: trimmed.slice(0, 300),
            },
          ],
          valid_from: event.time || now,
          status: isQuotedOrExample ? 'candidate' : 'active',
          actor: isQuotedOrExample ? 'rule' : 'user',
        };

        upsertCandidate(db, candidate, now);
      }
    }
  }

  // ==========================================
  // R3: 纠正检测
  // ==========================================
  if (event.origin_kind === 'user' && event.role === 'user' && event.text) {
    const trimmed = event.text.trim();
    if (CORRECTION_REGEX.test(trimmed)) {
      let prevTurn = event.turn ? event.turn - 1 : null;
      if (prevTurn === null || prevTurn < 1) {
        const row = db.get<{ maxTurn: number }>(
          'SELECT MAX(turn) as maxTurn FROM raw_events WHERE session_id = ? AND (turn < ? OR ? IS NULL)',
          [event.session_id, event.turn, event.turn]
        );
        if (row && typeof row.maxTurn === 'number' && row.maxTurn >= 1) {
          prevTurn = row.maxTurn;
        } else {
          prevTurn = 1;
        }
      }

      db.run('UPDATE turn_metrics SET correction = 1 WHERE session_id = ? AND turn = ?', [
        event.session_id,
        prevTurn,
      ]);

      const jobKey = `reflect:${event.session_id}:${prevTurn}`;
      db.run(
        'INSERT OR IGNORE INTO jobs (kind, key, payload, status, created_at, next_eligible_at) VALUES (\'reflect\', ?, ?, \'queued\', ?, 0)',
        [
          jobKey,
          JSON.stringify({ sessionId: event.session_id, turn: prevTurn, triggerSeq: event.seq }),
          now,
        ]
      );
    }
  }

  // ==========================================
  // R4: 工具失败签名
  // ==========================================
  if (event.role === 'tool' && event.is_error === 1 && event.tool_name) {
    const normalized = normalizeErrorText(event.text || '');
    const sig = `${event.tool_name}:${normalized}`;
    const seqRef = `${event.session_id}:${event.seq}`;

    const row = db.get<{
      count: number;
      sessions: string;
      last_seq_ref: string | null;
      memory_id: string | null;
    }>('SELECT count, sessions, last_seq_ref, memory_id FROM failure_sigs WHERE sig = ? AND workspace_id = ?', [
      sig,
      event.workspace_id,
    ]);

    if (!row || row.last_seq_ref !== seqRef) {
      let sessions: string[] = [];
      if (row) {
        try {
          sessions = JSON.parse(row.sessions);
        } catch {
          sessions = [];
        }
      }
      if (!sessions.includes(event.session_id)) {
        if (sessions.length < 20) {
          sessions.push(event.session_id);
        }
      }

      const newCount = row ? row.count + 1 : 1;

      if (row) {
        db.run(
          'UPDATE failure_sigs SET count = ?, sessions = ?, last_seq_ref = ?, updated_at = ? WHERE sig = ? AND workspace_id = ?',
          [newCount, JSON.stringify(sessions), seqRef, now, sig, event.workspace_id]
        );
      } else {
        db.run(
          'INSERT INTO failure_sigs (sig, workspace_id, count, sessions, last_seq_ref, memory_id, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?)',
          [sig, event.workspace_id, newCount, JSON.stringify(sessions), seqRef, now]
        );
      }

      // ≥2 个不同 session 时写 failure candidate
      if (sessions.length >= 2 && (!row || !row.memory_id)) {
        const candidateRes = upsertCandidate(
          db,
          {
            type: 'failure',
            content: `工具 ${event.tool_name} 执行失败: ${normalized}`,
            summary: `${event.tool_name} 失败: ${normalized.slice(0, 50)}`,
            scope: 'workspace',
            workspaceId: event.workspace_id,
            source_kind: 'rule',
            confidence: 0.5,
            origin_kinds: ['tool'],
            sources: [
              {
                session_id: event.session_id,
                seq: event.seq,
                kind: 'tool_result',
                excerpt: normalized.slice(0, 300),
              },
            ],
            status: 'candidate',
            actor: 'rule',
          },
          now
        );

        if (candidateRes.action === 'inserted' || candidateRes.action === 'merged') {
          db.run(
            'UPDATE failure_sigs SET memory_id = ? WHERE sig = ? AND workspace_id = ?',
            [candidateRes.id, sig, event.workspace_id]
          );
        }

        const sigHash = crypto.createHash('sha256').update(sig).digest('hex').slice(0, 16);
        const jobKey = `reflect:failure_sig:${sigHash}`;
        db.run(
          'INSERT OR IGNORE INTO jobs (kind, key, payload, status, created_at, next_eligible_at) VALUES (\'reflect\', ?, ?, \'queued\', ?, 0)',
          [
            jobKey,
            JSON.stringify({
              sig,
              workspaceId: event.workspace_id,
              sessionId: event.session_id,
              turn: event.turn ?? 0,
              signalKind: 'repeated_tool_failure',
              correctionMessage: `Repeated tool failure (${event.tool_name}): ${normalized.slice(0, 200)}`,
            }),
            now,
          ]
        );
      }
    }
  }

  // ==========================================
  // R5: 同一 turn 失败→修复检测
  // ==========================================
  if (event.role === 'tool' && event.is_error === 0 && event.tool_name && event.turn !== null) {
    const failedRow = db.get<{ seq: number }>(
      'SELECT seq FROM raw_events WHERE session_id = ? AND turn = ? AND tool_name = ? AND is_error = 1 AND seq < ? LIMIT 1',
      [event.session_id, event.turn, event.tool_name, event.seq]
    );
    if (failedRow) {
      const jobKey = `fixpair:${event.session_id}:${event.turn}`;
      db.run(
        'INSERT OR IGNORE INTO jobs (kind, key, payload, status, created_at, next_eligible_at) VALUES (\'distill\', ?, ?, \'queued\', ?, 0)',
        [
          jobKey,
          JSON.stringify({ sessionId: event.session_id, turn: event.turn, toolName: event.tool_name }),
          now,
        ]
      );
    }
  }

  db.run('UPDATE raw_events SET processed = 1 WHERE session_id = ? AND seq = ?', [
    event.session_id,
    event.seq,
  ]);
}
