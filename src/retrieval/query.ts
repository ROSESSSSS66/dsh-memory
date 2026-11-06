import { segment, extractEntities, STOPWORDS } from '../core/text.js';
import { DEFAULTS, type PluginConfig } from '../config.js';
import type { QueryPlan } from '../types.js';

export const TEMPORAL_INTENT_REGEX =
  /(?:昨天|今天|前天|上周|上个月|最近|之前|以前|上次|刚才|何时|什么时候|几号|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}月\d{1,2}[日号]|yesterday|today|last (?:week|month|time)|recently|when|before)/i;

export const CAUSAL_INTENT_REGEX =
  /(?:为什么|原因|导致|因为|怎么回事|为何|根因|why|because|cause|reason)/i;

export const PROCEDURAL_INTENT_REGEX =
  /(?:怎么|如何|步骤|流程|修复|解决|报错|错误|失败|异常|部署|配置|安装|how to|how do|fix|error|exception|fail|deploy|install|setup)/i;

export const PREFERENCE_INTENT_REGEX =
  /(?:喜欢|习惯|偏好|风格|格式|不要|别|prefer|style|format)/i;

export const TEMPORAL_BROWSE_REGEX =
  /(?:回顾|历史记录|做了什么|发生了什么|干了什么|列出记录|history|what did|list events|show history|look back)/i;

export const PREFERENCE_BROWSE_REGEX =
  /(?:我的偏好有哪些|列出(?:我的)?偏好|看(?:一下)?(?:我的)?偏好|list (?:my )?preferences|show (?:my )?preferences|what are my preferences)/i;

export const QUERY_PROMPT_WORDS = new Set([
  '今天', '昨天', '前天', '最近', '怎么', '如何', '什么', '为什么', '哪个', '哪些',
  'the', 'how', 'today', 'yesterday', 'why', 'what', 'which', 'is', 'are', 'a', 'an',
  'in', 'on', 'of', 'for', 'to', '请', '帮我', '一下', '这个', '那个', '怎么做',
  '请问', '多少', '哪一', '一个', '有什', '是什', '是哪', '查看', '我们', '应该',
]);

const CJK_PARTICLE_BOUNDARY_REGEX = /^[的是了吗呢吧啊么哪怎何]|[\s]*[的是了吗呢吧啊么哪怎何]$/;

/**
 * 解析查询中的时间区间
 */
export function parseTimeRange(text: string, now: number): { from: number; to: number } | undefined {
  const nowDate = new Date(now);

  // 1. 具体日期 YYYY-MM-DD
  const ymdMatch = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (ymdMatch) {
    const year = parseInt(ymdMatch[1], 10);
    const month = parseInt(ymdMatch[2], 10) - 1;
    const day = parseInt(ymdMatch[3], 10);
    const start = new Date(year, month, day, 0, 0, 0, 0).getTime();
    const end = new Date(year, month, day, 23, 59, 59, 999).getTime();
    return { from: start, to: end };
  }

  // 2. M月D日
  const mdMatch = text.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (mdMatch) {
    let year = nowDate.getFullYear();
    const month = parseInt(mdMatch[1], 10) - 1;
    const day = parseInt(mdMatch[2], 10);
    let start = new Date(year, month, day, 0, 0, 0, 0).getTime();
    if (start > now) {
      year -= 1;
      start = new Date(year, month, day, 0, 0, 0, 0).getTime();
    }
    const end = new Date(year, month, day, 23, 59, 59, 999).getTime();
    return { from: start, to: end };
  }

  // 3. 今天 / today
  if (/(?:今天|today)/i.test(text)) {
    const start = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate(), 0, 0, 0, 0).getTime();
    return { from: start, to: now };
  }

  // 4. 昨天 / yesterday
  if (/(?:昨天|yesterday)/i.test(text)) {
    const yDate = new Date(now - 86400000);
    const start = new Date(yDate.getFullYear(), yDate.getMonth(), yDate.getDate(), 0, 0, 0, 0).getTime();
    const end = new Date(yDate.getFullYear(), yDate.getMonth(), yDate.getDate(), 23, 59, 59, 999).getTime();
    return { from: start, to: end };
  }

  // 5. 前天
  if (/(?:前天)/i.test(text)) {
    const bDate = new Date(now - 2 * 86400000);
    const start = new Date(bDate.getFullYear(), bDate.getMonth(), bDate.getDate(), 0, 0, 0, 0).getTime();
    const end = new Date(bDate.getFullYear(), bDate.getMonth(), bDate.getDate(), 23, 59, 59, 999).getTime();
    return { from: start, to: end };
  }

  // 6. 上周 / last week
  if (/(?:上周|last week)/i.test(text)) {
    return { from: now - 14 * 86400000, to: now - 7 * 86400000 };
  }

  // 7. 最近 / 这几天 / recently
  if (/(?:最近|这几天|recently)/i.test(text)) {
    return { from: now - 7 * 86400000, to: now };
  }

  // 8. 上个月 / last month
  if (/(?:上个月|last month)/i.test(text)) {
    return { from: now - 60 * 86400000, to: now - 30 * 86400000 };
  }

  return undefined;
}

/**
 * 构建查询分析计划 (§5.4)
 */
export function buildQueryPlan(input: {
  userText: string;
  recentToolNames?: string[];
  now?: number;
  cfg?: PluginConfig;
}): QueryPlan {
  const cfg = input.cfg || DEFAULTS;
  const now = input.now ?? Date.now();
  const rawText = input.userText || '';
  const text = rawText.slice(0, cfg.queryMaxChars);

  // 1. 切词并去重，最多 64 个
  const allTokens = segment(text);
  const uniqueTokens: string[] = [];
  const seenTokens = new Set<string>();
  for (const t of allTokens) {
    const lower = t.toLowerCase();
    if (!seenTokens.has(lower)) {
      seenTokens.add(lower);
      uniqueTokens.push(lower);
      if (uniqueTokens.length >= 64) break;
    }
  }

  // 2. contentTokens: 去除检索提示词、停用词与中文虚词跨界二元组，用于绝对相关性硬门槛
  const baseContentTokens = uniqueTokens.filter((t) => {
    const lower = t.toLowerCase();
    return !QUERY_PROMPT_WORDS.has(lower) && !STOPWORDS.has(lower);
  });
  const refinedContentTokens = baseContentTokens.filter((t) => {
    if (t.length === 2 && /[\u4e00-\u9fa5]{2}/.test(t) && CJK_PARTICLE_BOUNDARY_REGEX.test(t)) {
      return false;
    }
    return true;
  });
  const contentTokens = refinedContentTokens.length > 0 ? refinedContentTokens : baseContentTokens;

  // 3. 实体抽取
  const entities = extractEntities(text, cfg.maxEntitiesPerText);

  // 4. 上下文实体 (recentToolNames，仅辅助排序，不放入主实体)
  const contextEntities = Array.isArray(input.recentToolNames)
    ? Array.from(new Set(input.recentToolNames.filter(Boolean).map((n) => n.toLowerCase())))
    : [];

  // 5. 意图检测
  const intents = {
    temporal: TEMPORAL_INTENT_REGEX.test(text),
    causal: CAUSAL_INTENT_REGEX.test(text),
    procedural: PROCEDURAL_INTENT_REGEX.test(text),
    preference: PREFERENCE_INTENT_REGEX.test(text),
  };

  // 6. 时间范围解析
  const timeRange = parseTimeRange(text, now);

  // 7. temporalBrowse: 必须有 timeRange 且明确包含历史记录回顾表达
  const temporalBrowse = Boolean(timeRange && TEMPORAL_BROWSE_REGEX.test(text));

  // 8. preferenceBrowse: 必须包含“列出我的偏好”类表达
  const preferenceBrowse = PREFERENCE_BROWSE_REGEX.test(text);

  return {
    text,
    tokens: uniqueTokens,
    contentTokens,
    entities,
    contextEntities,
    intents,
    timeRange,
    temporalBrowse,
    preferenceBrowse,
    now,
  };
}
