import crypto from 'node:crypto';
import type { Db, RawEvent, CandidateInput, Scope, MemoryType } from '../types.js';
import { upsertCandidate } from '../core/writer.js';
import { redactSecrets } from '../core/privacy.js';
import { estimateTokens } from '../core/tokens.js';
import { DEFAULTS, type PluginConfig } from '../config.js';

export const PREFERENCE_INDICATOR_REGEX =
  /(?:以后|今后|总是|一律|永远|不要再|别再|每次都|统一使用|必须使用|严禁|切勿|绝不|\b(?:from now on|always|never|must always|do not ever)\b)/i;

const NORMATIVE_DIRECTIVE_CUE_REGEX =
  /(?:使用|采用|改用|都用|一律用|不要再用|别再用|用(?:中文|英文|英语|汉语)|不要|避免|优先|回复|回答|说话|保持|一律|必须|禁止|严禁|切勿|绝不|统一|默认|遵循|改为|换成|写成|输出|格式化|加上|保留|开启|关闭|启用|禁用|\b(?:use|prefer|avoid|reply|respond|answer|format|keep|write|run|don't|do not|must|should|stick to|default to|make sure|ensure|follow|stop using)\b)/i;

const WORKSPACE_SCOPE_CUE_REGEX =
  /(?:本项目|当前项目|这个项目|本仓库|当前工作区|\b(?:this\s+(?:project|repo|repository|workspace|codebase|app)|(?:in|for)\s+this\s+(?:project|repo|repository|workspace|codebase|app))\b)/i;

const ONE_OFF_TASK_PROMPT_REGEX =
  /^(?:请\s*)?(?:帮我|给我|替我)?\s*(?:创建一个|写一个|生成一个|画一个|绘制一个|制作一个)/i;

const DURABLE_HABIT_MARKER_REGEX =
  /(?:以后|今后|总是|一律|永远|每次都|统一使用|必须使用|\b(?:from now on|always|must always)\b)/i;

const NON_PREFERENCE_CONVERSATIONAL_REGEX =
  /^(?:以后再(?:说|看|聊|议|处理|决定|讲|研究)|我(?:从来|从)?没(?:有)?(?:说过|见过|听过|想过|要过|写过)|从来没(?:见过|听说过)|i\s+never\s+(?:said|thought|saw|heard|knew|meant|asked|did|mentioned)\b)/i;

export const CORRECTION_REGEX =
  /(?:不对|错了|不是这样|搞错|不行|不可以|没用|还是不行|还是不可以|重来|\b(?:wrong|incorrect|not working|didn't work|doesn't work|not what|actually no)\b)/i;

const CORRECTION_LEADING_REGEX =
  /^(?:不对|错了|不是这样|不是|不行|不可以|搞错|没用|还是不行|还是不可以|重来|\b(?:wrong|incorrect|no|actually no)\b)/i;

const CORRECTION_NEGATED_OR_CONDITIONAL_REGEX =
  /(?:(?:如果|要是|假如|倘若|万一|若)[^。！!\n]{0,24}(?:不对|错了|不行|不可以|没用|搞错)|(?:没什么|没有|并不|并非)(?:不对|错|问题)|\b(?:nothing(?:\s+is)?\s+wrong|not\s+wrong|if\s+(?:it|this|that)\s+(?:doesn't|does\s+not|didn't|did\s+not)\s+work|if\s+it(?:'s|\s+is)\s+(?:wrong|incorrect|not\s+working)|in\s+case\s+[^.!?\n]{0,40}(?:doesn't\s+work|not\s+working|wrong))\b)/i;

const R1_ZH_REGEX = /^(?:请\s*)?(?:记住|记下)(?![了来过吗没])[:：,，\s]*([\s\S]+)$/;
const R1_EN_REGEX = /^(?:please\s+)?remember(?:[:：,]\s*|\s+(?:to|that)\s+)([\s\S]+)$/i;
const R1_EN_EXCLUDED_REGEX = /^(?:please\s+)?remember\s+(?:when|how|why|if|whether|what|where)\b/i;

const CODE_OR_BLOCKQUOTE_REGEX = /```|^\s*>/m;
const STACK_TRACE_REGEX =
  /(?:^\s*at\s+\S+\s*\([^)\r\n]+:\d+:\d+\)|Traceback \(most recent call last\)|^\s*File "[^"\r\n]+", line \d+|\b(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|AssertionError):\s)/m;

const INTERROGATIVE_REGEX =
  /(?:[?？]\s*$|(?:为什么|为何|怎么会|怎么总是|是不是总是|是否总是|难道|吗[?？。!！\s]*$)|\b(?:does\s+(?:this|it)\s+always|is\s+(?:this|it)\s+always|do\s+(?:you|we)\s+always|can\s+(?:this|it)\s+ever|would\s+it\s+ever|did\s+it\s+ever|how\s+come)\b|^(?:why|how|what|when|where|who|which|does|did|is|are|was|were|can|could|would|should|do\s+(?:you|we|they|i)\b)\b)/i;

const QUOTED_OR_EXAMPLE_REGEX = /(?:例如|比如|有人说|示例|规则说明|“|”|")/i;

const SLOT_INTERROGATIVE_REGEX =
  /(?:[?？]\s*$|(?:为什么|为何|怎么会|是不是|是否|吗[?？。!！\s]*$)|^(?:why|how|what|when|where|does|did|is|are|can|could|would|should|do\s+(?:you|we|they|i)\b)\b)/i;

const SLOT_SYMPTOM_OR_PROBLEM_REGEX =
  /(?:乱码|报错|失败|异常|崩溃|卡顿|太慢|过高|过低|暴涨|飙升|溢出|泄漏|故障|不足|超时|满载|太多|\b(?:garbled|mojibake|broken|crash(?:es|ing|ed)?|error|fail(?:s|ed|ing)?|bug|slow|spike|leak|high\s+cpu|oom|timeout|down)\b)/i;

const NON_DB_TOKENS = new Set([
  'cpu',
  'memory',
  'mem',
  'ram',
  'disk',
  'io',
  'network',
  'bandwidth',
  'connection',
  'connections',
  'pool',
  'lock',
  'locks',
  'thread',
  'threads',
  'space',
  'storage',
  'quota',
  'limit',
  'port',
  'timeout',
  'too',
  'much',
  'many',
  'more',
  'less',
  'high',
  'low',
  'down',
  'slow',
  'broken',
  'failing',
  'dead',
  'locked',
  'full',
  'empty',
  'not',
  'no',
  'none',
  'a',
  'an',
  'the',
  'very',
  'lots',
]);

const NON_AVOID_TECH_TOKENS = new Set([
  'it',
  'this',
  'that',
  'them',
  'these',
  'those',
  'here',
  'there',
  'anything',
  'something',
  'nothing',
  'any',
  'the',
  'a',
  'an',
  'to',
  'for',
  'in',
  'on',
  'at',
]);

export interface SlotResolution {
  slotKey: string | null;
  scope?: Scope;
  type?: MemoryType;
}

export interface RunRulesOptions {
  enqueueOfflineJobs?: boolean;
  onJobEnqueued?: () => void;
}

export interface RunRulesResult {
  memoriesCreated: number;
  jobsEnqueued: number;
}

/**
 * 共享纠正消息检测：排除疑问句、条件句与否定无误表述，供 rules.ts 与 outcome.ts 共用
 */
export function isCorrectionMessage(text: string): boolean {
  const trimmed = (text || '').trim();
  if (!trimmed) return false;
  if (!CORRECTION_REGEX.test(trimmed)) return false;

  const startsWithCorrection = CORRECTION_LEADING_REGEX.test(trimmed);

  // 疑问句默认排除，除非句首即为明确纠正词（如 "不对，为什么这么改？"）
  if (/[?？]\s*$/.test(trimmed) && !startsWithCorrection) {
    return false;
  }

  // 排除条件句与否定无误表述（如 "nothing is wrong"、"如果不行就回退"）
  if (CORRECTION_NEGATED_OR_CONDITIONAL_REGEX.test(trimmed) && !startsWithCorrection) {
    return false;
  }

  // 排除不含问号但语义为疑问的中文表述（如 "这样改是不是不对"）
  if (/(?:是不是|为什么|为何|怎么会|吗[?？。!！\s]*$)/.test(trimmed) && !startsWithCorrection) {
    return false;
  }

  return true;
}

/**
 * 固定槽位规则表 (§5.11)
 */
export function resolveFixedSlot(text: string): SlotResolution {
  // 限制扫描长度，防止超长输入在正则上产生回溯开销
  const s = (text || '').trim().slice(0, 500);
  if (!s) return { slotKey: null };

  // 排除疑问句与故障症状描述（如 "回复中文会乱码"、"数据库使用 CPU 过高"）
  if (SLOT_INTERROGATIVE_REGEX.test(s) || SLOT_SYMPTOM_OR_PROBLEM_REGEX.test(s)) {
    return { slotKey: null };
  }

  // 1. 回复语言偏好 (中/英)
  const zhReplyPref =
    /(?:回复|回答|说话)(?:一律|总是|全部|都|请|统一|默认)?(?:使用|用)(?:中文|汉语|zh-CN)/i.test(s) ||
    /(?:请|以后|今后|一律|总是|全部|都|统一)?(?:使用|用)(?:中文|汉语|zh-CN)(?:回复|回答|交流)/i.test(s) ||
    /(?<!\b(?:don't|do not|never|not)\s+)(?:\b(?:reply|respond|answer)\s+(?:always\s+)?in\s+chinese\b|\balways\s+(?:reply|respond|answer)\s+in\s+chinese\b)/i.test(s);
  if (zhReplyPref && !/(?:不要|别|禁止|避免)(?:用)?(?:中文|汉语)(?:回复|回答)/.test(s)) {
    return { slotKey: 'user.pref.reply_language', scope: 'user', type: 'preference' };
  }

  const enReplyPref =
    /(?:回复|回答|说话)(?:一律|总是|全部|都|请|统一|默认)?(?:使用|用)(?:英文|英语|en-US)/i.test(s) ||
    /(?:请|以后|今后|一律|总是|全部|都|统一)?(?:使用|用)(?:英文|英语|en-US)(?:回复|回答|交流)/i.test(s) ||
    /(?<!\b(?:don't|do not|never|not)\s+)(?:\b(?:reply|respond|answer)\s+(?:always\s+)?in\s+english\b|\balways\s+(?:reply|respond|answer)\s+in\s+english\b)/i.test(s);
  if (enReplyPref && !/(?:不要|别|禁止|避免)(?:用)?(?:英文|英语)(?:回复|回答)/.test(s)) {
    return { slotKey: 'user.pref.reply_language', scope: 'user', type: 'preference' };
  }

  // 2. 项目数据库配置 (中/英)
  const zhDbMatch = s.match(
    /(?:(?:我的|我们的|这个|当前|本)?项目)?(?:的)?(?:数据库|db)(?:是|为|已迁移到|迁移到|统一使用|使用|用|采用)\s*([a-zA-Z0-9][a-zA-Z0-9_\-.]{0,40})/i
  );
  if (zhDbMatch && !NON_DB_TOKENS.has(zhDbMatch[1].toLowerCase())) {
    return { slotKey: 'project.database', scope: 'workspace', type: 'semantic' };
  }

  const enDbMatch = s.match(
    /\b(?:our|the|this\s+project(?:'s)?|project|app|application|backend|service)?\s*(?:primary\s+|main\s+)?(?:database|db)\s+(?:is|uses|runs(?:\s+on)?|migrated\s+to|switched\s+to)\s+([a-zA-Z0-9][a-zA-Z0-9_\-.]{0,40})/i
  );
  if (enDbMatch && !NON_DB_TOKENS.has(enDbMatch[1].toLowerCase())) {
    return { slotKey: 'project.database', scope: 'workspace', type: 'semantic' };
  }

  // 3. 项目偏好：禁止/避免某技术 (中/英)
  const zhAvoidMatch = s.match(
    /(?:本项目|当前项目|项目)?(?:中)?(?:不要再用|别再用|禁止使用|不再使用)\s*([a-zA-Z0-9][a-zA-Z0-9_\-.]{0,40})/i
  );
  if (zhAvoidMatch && !NON_AVOID_TECH_TOKENS.has(zhAvoidMatch[1].toLowerCase())) {
    return {
      slotKey: `project.pref.avoid.${zhAvoidMatch[1].toLowerCase()}`,
      scope: 'workspace',
      type: 'preference',
    };
  }

  const enAvoidMatch = s.match(
    /\b(?:never\s+use|do\s+not\s+use|don't\s+use|stop\s+using|avoid\s+using)\s+([a-zA-Z0-9][a-zA-Z0-9_\-.]{0,40})/i
  );
  if (enAvoidMatch && !NON_AVOID_TECH_TOKENS.has(enAvoidMatch[1].toLowerCase())) {
    return {
      slotKey: `project.pref.avoid.${enAvoidMatch[1].toLowerCase()}`,
      scope: 'workspace',
      type: 'preference',
    };
  }

  return { slotKey: null };
}

/**
 * 规范化工具错误文本 (R4: 脱敏→UUID→时间戳→路径→十六进制→数字→引用内容)
 */
export function normalizeErrorText(rawText: string): string {
  if (!rawText) return '';
  // 1. 先脱敏
  let s = redactSecrets(rawText).text;
  // 2. UUID
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>');
  // 3. ISO 时间戳
  s = s.replace(
    /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
    '<TIME>'
  );
  // 4. 路径 (Windows 反斜杠与正斜杠盘符路径 + Unix 路径)
  s = s.replace(/[a-zA-Z]:\\[^\s:;,)"']+/g, '<PATH>');
  s = s.replace(/[a-zA-Z]:\/[^\s:;,)"']+/g, '<PATH>');
  s = s.replace(/(?:^|[\s:;,"'])\/(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+/g, ' <PATH>');
  // 5. 十六进制
  s = s.replace(/\b0x[0-9a-fA-F]+\b/g, '<HEX>');
  s = s.replace(/\b[0-9a-fA-F]{8,}\b/g, '<HEX>');
  // 6. 数字
  s = s.replace(/\b\d+\b/g, '<NUM>');
  // 7. 引用内容 (双引号和单引号中的文本)
  s = s.replace(/"[^"\r\n]*"/g, '<STR>');
  s = s.replace(/'[^'\r\n]*'/g, '<STR>');
  // 8. 收缩空白
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 将过长的显式记忆指令按 token 预算干净截断，避免静默丢弃或被 writer 拒收
 */
function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const targetBudget = Math.max(10, maxTokens - 2);
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= targetBudget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  let cut = text.slice(0, Math.max(4, lo)).trimEnd();
  // 尽量在空白或句末标点处收尾，不截断英文词中部
  const lastBreak = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('。'), cut.lastIndexOf('\n'));
  if (lastBreak > cut.length * 0.7) {
    cut = cut.slice(0, lastBreak).trimEnd();
  }
  return `${cut}...`;
}

function capFailureSignature(toolName: string, normalized: string): string {
  const rawSig = `${toolName}:${normalized}`;
  if (rawSig.length <= 256) return rawSig;
  const hash = crypto.createHash('sha256').update(rawSig).digest('hex').slice(0, 16);
  return `${rawSig.slice(0, 239)}#${hash}`;
}

function extractR1Content(trimmed: string): string | null {
  if (/[?？]\s*$/.test(trimmed)) return null;
  if (R1_EN_EXCLUDED_REGEX.test(trimmed)) return null;

  const zhMatch = trimmed.match(R1_ZH_REGEX);
  if (zhMatch) {
    return zhMatch[1].trim();
  }

  const enMatch = trimmed.match(R1_EN_REGEX);
  if (enMatch) {
    return enMatch[1].trim();
  }

  return null;
}

/**
 * 规则抽取主入口 (纯本地、O(文本长度) 计算)
 */
export function runRules(
  db: Db,
  event: RawEvent,
  cfg: PluginConfig = DEFAULTS,
  now: number = Date.now(),
  options: RunRulesOptions = {}
): RunRulesResult {
  const result: RunRulesResult = {
    memoriesCreated: 0,
    jobsEnqueued: 0,
  };
  if (!event) return result;

  const enqueueOfflineJobs = options.enqueueOfflineJobs !== false;
  const maxContentTokens = Math.min(
    cfg.maxContentTokens || DEFAULTS.maxContentTokens,
    DEFAULTS.maxContentTokens
  );

  let r1Matched = false;

  // ==========================================
  // R1: 真实用户显式记忆
  // ==========================================
  if (event.origin_kind === 'user' && event.role === 'user' && event.text) {
    const trimmed = event.text.trim();
    const extracted = extractR1Content(trimmed);
    if (extracted !== null) {
      r1Matched = true;
      if (extracted.length >= 4) {
        const boundedContent = truncateToTokenBudget(extracted, maxContentTokens);
        // 隐私扫描：若包含未脱敏敏感信息或 REDACTED 掩码，直接拒绝
        const privCheck = redactSecrets(boundedContent);
        if (!privCheck.hasSensitive && !boundedContent.includes('[REDACTED:')) {
          const hasCodeOrQuote = CODE_OR_BLOCKQUOTE_REGEX.test(boundedContent);
          const slotRes = hasCodeOrQuote ? { slotKey: null } : resolveFixedSlot(boundedContent);
          const type: MemoryType =
            slotRes.type ||
            (PREFERENCE_INDICATOR_REGEX.test(boundedContent) &&
            NORMATIVE_DIRECTIVE_CUE_REGEX.test(boundedContent)
              ? 'preference'
              : 'semantic');

          let scope: Scope = slotRes.scope || (type === 'preference' ? 'user' : 'workspace');
          if (WORKSPACE_SCOPE_CUE_REGEX.test(boundedContent)) {
            scope = 'workspace';
          }

          const candidate: CandidateInput = {
            type,
            content: boundedContent,
            slot_key: slotRes.slotKey,
            scope,
            workspaceId: event.workspace_id,
            sessionId: event.session_id,
            source_kind: 'user',
            origin_kinds: ['user'],
            confidence: hasCodeOrQuote ? 0.6 : 1.0,
            sources: [
              {
                session_id: event.session_id,
                seq: event.seq,
                kind: 'user_msg',
                excerpt: boundedContent.slice(0, 300),
              },
            ],
            valid_from: event.time || now,
            status: hasCodeOrQuote ? 'candidate' : 'active',
            actor: hasCodeOrQuote ? 'rule' : 'user',
          };

          const upsertRes = upsertCandidate(db, candidate, now);
          if (upsertRes.action === 'inserted' || upsertRes.action === 'superseded') {
            result.memoriesCreated++;
          }
        }
      }
    }
  }

  // ==========================================
  // R2: 真实用户偏好陈述 (短消息 <= 300 字；R1 已匹配时跳过)
  // ==========================================
  if (!r1Matched && event.origin_kind === 'user' && event.role === 'user' && event.text) {
    const trimmed = event.text.trim();
    if (trimmed.length <= 300 && PREFERENCE_INDICATOR_REGEX.test(trimmed)) {
      // 直接跳过疑问句、代码块、多行引用块与堆栈日志，不污染 candidate 表
      const isSkipContext =
        CODE_OR_BLOCKQUOTE_REGEX.test(trimmed) ||
        STACK_TRACE_REGEX.test(trimmed) ||
        INTERROGATIVE_REGEX.test(trimmed);

      if (!isSkipContext) {
        const slotRes = resolveFixedSlot(trimmed);
        const hasNormativeCue = slotRes.slotKey !== null || NORMATIVE_DIRECTIVE_CUE_REGEX.test(trimmed);
        const isOneOffTask =
          !slotRes.slotKey &&
          ((ONE_OFF_TASK_PROMPT_REGEX.test(trimmed) && !DURABLE_HABIT_MARKER_REGEX.test(trimmed)) ||
            NON_PREFERENCE_CONVERSATIONAL_REGEX.test(trimmed));

        if (hasNormativeCue && !isOneOffTask) {
          const privCheck = redactSecrets(trimmed);
          if (!privCheck.hasSensitive && !trimmed.includes('[REDACTED:')) {
            const isQuotedOrExample = QUOTED_OR_EXAMPLE_REGEX.test(trimmed);
            const isActiveSlot = slotRes.slotKey !== null && !isQuotedOrExample;

            let scope: Scope = slotRes.scope || 'user';
            if (WORKSPACE_SCOPE_CUE_REGEX.test(trimmed)) {
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
              confidence: isActiveSlot ? 1.0 : isQuotedOrExample ? 0.5 : 0.7,
              sources: [
                {
                  session_id: event.session_id,
                  seq: event.seq,
                  kind: 'user_msg',
                  excerpt: trimmed.slice(0, 300),
                },
              ],
              valid_from: event.time || now,
              status: isActiveSlot ? 'active' : 'candidate',
              actor: isActiveSlot ? 'user' : 'rule',
            };

            const upsertRes = upsertCandidate(db, candidate, now);
            if (upsertRes.action === 'inserted' || upsertRes.action === 'superseded') {
              result.memoriesCreated++;
            }
          }
        }
      }
    }
  }

  // ==========================================
  // R3: 纠正检测 (即使 R1 匹配也会执行，支持“记住+纠正”复合消息)
  // ==========================================
  if (event.origin_kind === 'user' && event.role === 'user' && event.text) {
    const trimmed = event.text.trim();
    if (isCorrectionMessage(trimmed)) {
      let prevTurn = event.turn ? event.turn - 1 : null;
      if (prevTurn === null || prevTurn < 1) {
        const turnVal = event.turn ?? null;
        const row = db.get<{ maxTurn: number | null }>(
          'SELECT COALESCE((SELECT MAX(turn) FROM raw_events WHERE session_id = ? AND (? IS NULL OR turn < ?)), (SELECT MAX(turn) FROM turn_metrics WHERE session_id = ? AND (? IS NULL OR turn < ?))) as maxTurn',
          [event.session_id, turnVal, turnVal, event.session_id, turnVal, turnVal]
        );
        if (row && typeof row.maxTurn === 'number' && row.maxTurn >= 1) {
          prevTurn = row.maxTurn;
        } else {
          prevTurn = null;
        }
      }

      if (prevTurn !== null && prevTurn >= 1) {
        db.run('UPDATE turn_metrics SET correction = 1 WHERE session_id = ? AND turn = ?', [
          event.session_id,
          prevTurn,
        ]);

        if (enqueueOfflineJobs) {
          const jobKey = `reflect:${event.session_id}:${prevTurn}`;
          const jobRes = db.run(
            "INSERT OR IGNORE INTO jobs (kind, key, payload, status, created_at, next_eligible_at) VALUES ('reflect', ?, ?, 'queued', ?, 0)",
            [
              jobKey,
              JSON.stringify({
                sessionId: event.session_id,
                turn: prevTurn,
                triggerSeq: event.seq,
                correctionMessage: trimmed.slice(0, 800),
                ...(event.workspace_id ? { workspaceId: event.workspace_id } : {}),
              }),
              now,
            ]
          );
          if (Number(jobRes.changes) > 0) {
            result.jobsEnqueued++;
          }
        }
      }
    }
  }

  // ==========================================
  // R4: 工具失败签名
  // ==========================================
  if (event.role === 'tool' && event.is_error === 1 && event.tool_name) {
    const normalized = normalizeErrorText(event.text || '');
    const sig = capFailureSignature(event.tool_name, normalized);
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
      if (!sessions.includes(event.session_id) && sessions.length < 20) {
        sessions.push(event.session_id);
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
        const prefix = `工具 ${event.tool_name} 执行失败: `;
        const maxNormLen = Math.max(0, 600 - prefix.length);
        const boundedFailureContent = `${prefix}${normalized.slice(0, maxNormLen)}`;

        const candidateRes = upsertCandidate(
          db,
          {
            type: 'failure',
            content: boundedFailureContent,
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

        if (candidateRes.action === 'inserted' || candidateRes.action === 'superseded') {
          result.memoriesCreated++;
        }

        if (candidateRes.action === 'inserted' || candidateRes.action === 'merged') {
          db.run(
            'UPDATE failure_sigs SET memory_id = ? WHERE sig = ? AND workspace_id = ?',
            [candidateRes.id, sig, event.workspace_id]
          );
        }

        if (enqueueOfflineJobs) {
          const sigHash = crypto.createHash('sha256').update(`${event.workspace_id}:${sig}`).digest('hex').slice(0, 16);
          const jobKey = `reflect:failure_sig:${sigHash}`;
          const jobRes = db.run(
            "INSERT OR IGNORE INTO jobs (kind, key, payload, status, created_at, next_eligible_at) VALUES ('reflect', ?, ?, 'queued', ?, 0)",
            [
              jobKey,
              JSON.stringify({
                sig,
                workspaceId: event.workspace_id,
                sessionId: event.session_id,
                triggerSeq: event.seq,
                ...(typeof event.turn === 'number' ? { turn: event.turn } : {}),
                signalKind: 'repeated_tool_failure',
                correctionMessage: `Repeated tool failure (${event.tool_name}): ${normalized.slice(0, 200)}`,
              }),
              now,
            ]
          );
          if (Number(jobRes.changes) > 0) {
            result.jobsEnqueued++;
          }
        }
      }
    }
  }

  // ==========================================
  // R5: 同一 turn 失败→修复检测 (仅限 tool/result 且成功)
  // ==========================================
  if (
    event.type === 'tool/result' &&
    event.role === 'tool' &&
    event.is_error === 0 &&
    event.tool_name &&
    event.turn != null
  ) {
    const failedRow = db.get<{ seq: number }>(
      'SELECT seq FROM raw_events WHERE session_id = ? AND turn = ? AND tool_name = ? AND is_error = 1 AND seq < ? LIMIT 1',
      [event.session_id, event.turn, event.tool_name, event.seq]
    );
    if (failedRow && enqueueOfflineJobs) {
      const jobKey = `fixpair:${event.session_id}:${event.turn}`;
      const jobRes = db.run(
        "INSERT OR IGNORE INTO jobs (kind, key, payload, status, created_at, next_eligible_at) VALUES ('distill', ?, ?, 'queued', ?, 0)",
        [
          jobKey,
          JSON.stringify({
            sessionId: event.session_id,
            turn: event.turn,
            toolName: event.tool_name,
            ...(event.workspace_id ? { workspaceId: event.workspace_id } : {}),
          }),
          now,
        ]
      );
      if (Number(jobRes.changes) > 0) {
        result.jobsEnqueued++;
      }
    }
  }

  db.run('UPDATE raw_events SET processed = 1 WHERE session_id = ? AND seq = ?', [
    event.session_id,
    event.seq,
  ]);

  if (result.jobsEnqueued > 0 && options.onJobEnqueued) {
    const notify = options.onJobEnqueued;
    if (typeof db.afterCommit === 'function') {
      db.afterCommit(() => {
        try {
          notify();
        } catch {}
      });
    } else {
      try {
        notify();
      } catch {}
    }
  }

  return result;
}
