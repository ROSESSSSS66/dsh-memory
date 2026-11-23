import { DEFAULTS, type PluginConfig } from '../config.js';
import { extractEntities, STOPWORDS, segment } from '../core/text.js';
import type { QueryPlan } from '../types.js';

export const TEMPORAL_INTENT_REGEX =
  /(?:昨天|今天|前天|前几天|这几天|上周|上个月|最近|之前|以前|上次|刚才|何时|什么时候|几号|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}月\d{1,2}[日号]|\b(?:yesterday|today|last (?:week|month|time)|recently|when|before)\b)/i;

export const CAUSAL_INTENT_REGEX =
  /(?:为什么|原因|导致|因为|怎么回事|为何|根因|\b(?:why|because|cause[ds]?|reason(?:s|ing)?)\b)/i;

export const PROCEDURAL_INTENT_REGEX =
  /(?:怎么|如何|步骤|流程|修复|解决|报错|错误|失败|异常|部署|配置|安装|调试|\b(?:how to|how do|fix(?:ed|es|ing)?|error[s]?|exception[s]?|fail(?:s|ed|ure|ures|ing)?|deploy(?:ed|ing|ment)?|install(?:ed|ing|ation)?|setup|debug(?:ging|ged)?|troubleshoot(?:ing)?)\b)/i;

export const PREFERENCE_INTENT_REGEX =
  /(?:喜欢|习惯|偏好|风格|格式|不要|切勿|请勿|请别|尽量别|千万别|以后别|最好别|别再|(?:^|[\s，,。；;：:！!])别(?=[再用给把写发加改删做让使提输打])|\b(?:prefer(?:s|red|ence|ences)?|style|format(?:ting)?)\b)/i;

export const TEMPORAL_BROWSE_REGEX =
  /(?:回顾|历史记录|做了什么|发生了什么|干了什么|列出记录|\b(?:history|what did|list events|show history|look back)\b)/i;

export const PREFERENCE_BROWSE_REGEX =
  /(?:我的偏好有哪些|列出(?:我的)?偏好|看(?:一下)?(?:我的)?偏好|\b(?:list (?:my )?preferences|show (?:my )?preferences|what are my preferences)\b)/i;

export const QUERY_PROMPT_WORDS = new Set([
  // 中文查询提示词 / 常见虚词二元组
  '今天',
  '昨天',
  '前天',
  '最近',
  '上周',
  '上次',
  '之前',
  '以前',
  '刚才',
  '时候',
  '怎么',
  '如何',
  '什么',
  '为什么',
  '为何',
  '哪个',
  '哪些',
  '哪一',
  '多少',
  '是否',
  '请',
  '帮',
  '帮我',
  '帮忙',
  '请问',
  '一下',
  '这个',
  '那个',
  '一个',
  '我们',
  '应该',
  '能否',
  '可以',
  '不能',
  '告诉',
  '记得',
  '回忆',
  '忘记',
  '查看',
  '看看',
  '说说',
  '怎么做',
  '有什',
  '是什',
  '是哪',
  '到底',
  '目前',
  '现在',
  '已经',
  '需要',
  '想要',
  // 英文自然问句提示词与功能词
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'am',
  'be',
  'been',
  'being',
  'in',
  'on',
  'of',
  'for',
  'to',
  'at',
  'by',
  'from',
  'with',
  'without',
  'about',
  'into',
  'how',
  'why',
  'what',
  'which',
  'who',
  'whom',
  'whose',
  'where',
  'when',
  'today',
  'yesterday',
  'recently',
  'previously',
  'earlier',
  'ago',
  'last',
  'can',
  'could',
  'will',
  'would',
  'shall',
  'should',
  'may',
  'might',
  'must',
  'do',
  'does',
  'did',
  'done',
  'have',
  'has',
  'had',
  'having',
  'i',
  'me',
  'my',
  'we',
  'us',
  'our',
  'you',
  'your',
  'he',
  'him',
  'his',
  'she',
  'her',
  'they',
  'them',
  'their',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'there',
  'here',
  'please',
  'help',
  'tell',
  'remember',
  'recall',
  'remind',
  'forgot',
  'forget',
  'know',
  'explain',
  'describe',
  'hey',
  'hi',
  'hello',
  'thanks',
  'thank',
  'just',
  'very',
  'really',
  'actually',
  'basically',
  'currently',
  'still',
  'already',
  'again',
  'also',
  'then',
  'than',
  'so',
  'if',
  'not',
  'no',
  'yes',
  'only',
  'want',
  'need',
  'any',
  'some',
  'all',
  'anything',
  'something',
  'someone',
  'anyone',
]);

const CJK_PARTICLE_BOUNDARY_REGEX =
  /^[的是了吗呢吧啊么哪怎何呀嘛哦]|[\s]*[的是了吗呢吧啊么哪怎何呀嘛哦]$/;
const CJK_VALID_COMPOUNDS = new Set([
  '目的',
  '几何',
  '了解',
  '任何',
  '的确',
  '正确',
  '明确',
  '准确',
]);

/**
 * 校验公历年月日是否真实存在（防止 2026-02-30 静默溢出成 2026-03-02）
 */
function makeValidDayRange(
  year: number,
  monthZeroBased: number,
  day: number
): { from: number; to: number } | undefined {
  if (monthZeroBased < 0 || monthZeroBased > 11 || day < 1 || day > 31) return undefined;
  const startDate = new Date(year, monthZeroBased, day, 0, 0, 0, 0);
  if (
    startDate.getFullYear() !== year ||
    startDate.getMonth() !== monthZeroBased ||
    startDate.getDate() !== day
  ) {
    return undefined;
  }
  const endDate = new Date(year, monthZeroBased, day, 23, 59, 59, 999);
  return { from: startDate.getTime(), to: endDate.getTime() };
}

/**
 * 解析查询中的时间区间
 */
export function parseTimeRange(
  text: string,
  now: number
): { from: number; to: number } | undefined {
  const nowDate = new Date(now);

  // 1. 具体日期 YYYY-MM-DD（严格校验历法溢出，如 2026-02-30 返回 undefined）
  const ymdMatch = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (ymdMatch) {
    const year = parseInt(ymdMatch[1], 10);
    const month = parseInt(ymdMatch[2], 10) - 1;
    const day = parseInt(ymdMatch[3], 10);
    return makeValidDayRange(year, month, day);
  }

  // 2. [YYYY年]M月D日（同样严格校验历法溢出）
  const mdMatch = text.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]/);
  if (mdMatch) {
    const explicitYear = mdMatch[1] ? parseInt(mdMatch[1], 10) : undefined;
    let year = explicitYear ?? nowDate.getFullYear();
    const month = parseInt(mdMatch[2], 10) - 1;
    const day = parseInt(mdMatch[3], 10);
    if (explicitYear !== undefined) {
      return makeValidDayRange(year, month, day);
    }
    let range = makeValidDayRange(year, month, day);
    if (!range) {
      // 未显式指定年份时的 2月29日：若上一年为闰年则回退上一年，否则视为非法日期
      if (month === 1 && day === 29) {
        return makeValidDayRange(year - 1, month, day);
      }
      return undefined;
    }
    if (range.from > now) {
      year -= 1;
      range = makeValidDayRange(year, month, day);
    }
    return range;
  }

  // 3. 今天 / today
  if (/(?:今天|\btoday\b)/i.test(text)) {
    const start = new Date(
      nowDate.getFullYear(),
      nowDate.getMonth(),
      nowDate.getDate(),
      0,
      0,
      0,
      0
    ).getTime();
    return { from: start, to: now };
  }

  // 4. 昨天 / yesterday
  if (/(?:昨天|\byesterday\b)/i.test(text)) {
    const yDate = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - 1);
    const start = new Date(
      yDate.getFullYear(),
      yDate.getMonth(),
      yDate.getDate(),
      0,
      0,
      0,
      0
    ).getTime();
    const end = new Date(
      yDate.getFullYear(),
      yDate.getMonth(),
      yDate.getDate(),
      23,
      59,
      59,
      999
    ).getTime();
    return { from: start, to: end };
  }

  // 5. 前天
  if (/(?:前天)/i.test(text)) {
    const bDate = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - 2);
    const start = new Date(
      bDate.getFullYear(),
      bDate.getMonth(),
      bDate.getDate(),
      0,
      0,
      0,
      0
    ).getTime();
    const end = new Date(
      bDate.getFullYear(),
      bDate.getMonth(),
      bDate.getDate(),
      23,
      59,
      59,
      999
    ).getTime();
    return { from: start, to: end };
  }

  // 6. 上周 / last week（日历对齐：上一个自然周 周一 00:00:00.000 至 周日 23:59:59.999）
  if (/(?:上周|\blast week\b)/i.test(text)) {
    const dayOfWeek = nowDate.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    const thisWeekMonday = new Date(
      nowDate.getFullYear(),
      nowDate.getMonth(),
      nowDate.getDate() - daysSinceMonday,
      0,
      0,
      0,
      0
    );
    const lastWeekMonday = new Date(
      thisWeekMonday.getFullYear(),
      thisWeekMonday.getMonth(),
      thisWeekMonday.getDate() - 7,
      0,
      0,
      0,
      0
    );
    const lastWeekSunday = new Date(
      thisWeekMonday.getFullYear(),
      thisWeekMonday.getMonth(),
      thisWeekMonday.getDate() - 1,
      23,
      59,
      59,
      999
    );
    return { from: lastWeekMonday.getTime(), to: lastWeekSunday.getTime() };
  }

  // 7. 最近 / 这几天 / 前几天 / recently
  if (/(?:最近|这几天|前几天|\brecently\b)/i.test(text)) {
    return { from: now - 7 * 86400000, to: now };
  }

  // 8. 上个月 / last month（日历对齐：上一个自然月 1日 00:00:00.000 至 月末 23:59:59.999）
  if (/(?:上个月|\blast month\b)/i.test(text)) {
    const firstDay = new Date(nowDate.getFullYear(), nowDate.getMonth() - 1, 1, 0, 0, 0, 0);
    const lastDay = new Date(nowDate.getFullYear(), nowDate.getMonth(), 0, 23, 59, 59, 999);
    return { from: firstDay.getTime(), to: lastDay.getTime() };
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

  // 1. 切词并去重（超长查询头尾均衡采样，避免长中文问句末尾关键词被截断丢失）
  const allTokens = segment(text);
  const allUniqueTokens: string[] = [];
  const seenTokens = new Set<string>();
  for (const t of allTokens) {
    const lower = t.toLowerCase();
    if (!seenTokens.has(lower)) {
      seenTokens.add(lower);
      allUniqueTokens.push(lower);
    }
  }
  const uniqueTokens =
    allUniqueTokens.length <= 128
      ? allUniqueTokens
      : [...allUniqueTokens.slice(0, 64), ...allUniqueTokens.slice(allUniqueTokens.length - 64)];

  // 2. contentTokens: 去除检索提示词、停用词与中文虚词跨界二元组，用于绝对相关性硬门槛
  const baseContentTokens = uniqueTokens.filter((t) => {
    const lower = t.toLowerCase();
    return !QUERY_PROMPT_WORDS.has(lower) && !STOPWORDS.has(lower);
  });
  const refinedContentTokens = baseContentTokens.filter((t) => {
    if (
      t.length === 2 &&
      /[\u4e00-\u9fa5]{2}/.test(t) &&
      !CJK_VALID_COMPOUNDS.has(t) &&
      CJK_PARTICLE_BOUNDARY_REGEX.test(t)
    ) {
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
