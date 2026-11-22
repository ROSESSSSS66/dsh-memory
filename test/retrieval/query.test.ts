import { describe, it, expect } from 'vitest';
import {
  buildQueryPlan,
  TEMPORAL_INTENT_REGEX,
  CAUSAL_INTENT_REGEX,
  PROCEDURAL_INTENT_REGEX,
  PREFERENCE_INTENT_REGEX,
  TEMPORAL_BROWSE_REGEX,
  PREFERENCE_BROWSE_REGEX,
  parseTimeRange,
} from '../../src/retrieval/query.js';

describe('Query Analysis (query.ts)', () => {
  describe('Intent Regex Tests (验收项 1: 每个意图至少 4 个正例、2 个反例)', () => {
    describe('temporal intent', () => {
      const positives = [
        '昨天你说了什么',
        '今天帮我看一下日志',
        '上周讨论的内容',
        'what did we do yesterday',
        '2026-11-04发生的变更',
        'last month sales',
        '5月12日会议',
      ];
      const negatives = [
        '帮我重构这段代码',
        'PostgreSQL 连接超时',
        '这是一个纯算法实现',
      ];

      it('should match all positive cases', () => {
        expect(positives.length).toBeGreaterThanOrEqual(4);
        for (const text of positives) {
          expect(TEMPORAL_INTENT_REGEX.test(text), `Failed positive: ${text}`).toBe(true);
        }
      });

      it('should not match negative cases', () => {
        expect(negatives.length).toBeGreaterThanOrEqual(2);
        for (const text of negatives) {
          expect(TEMPORAL_INTENT_REGEX.test(text), `Failed negative: ${text}`).toBe(false);
        }
      });
    });

    describe('causal intent', () => {
      const positives = [
        '为什么会出现连接超时',
        '导致这个报错的原因是什么',
        '因为什么配置错误',
        'why did the process exit',
        '怎么回事啊服务挂了',
        '分析一下根本原因',
      ];
      const negatives = [
        '今天天气怎么样',
        '明天要开会',
        '请打印出这个数字',
      ];

      it('should match all positive cases', () => {
        expect(positives.length).toBeGreaterThanOrEqual(4);
        for (const text of positives) {
          expect(CAUSAL_INTENT_REGEX.test(text), `Failed positive: ${text}`).toBe(true);
        }
      });

      it('should not match negative cases', () => {
        expect(negatives.length).toBeGreaterThanOrEqual(2);
        for (const text of negatives) {
          expect(CAUSAL_INTENT_REGEX.test(text), `Failed negative: ${text}`).toBe(false);
        }
      });
    });

    describe('procedural intent', () => {
      const positives = [
        '怎么安装 PostgreSQL 16',
        '如何解决跨域报错',
        '修复这个网络异常的步骤',
        'how to deploy this service',
        '安装依赖失败怎么办',
        '部署生产环境流程',
        'please fix this build error',
        'the test failed during setup',
        'debug memory leak',
      ];
      const negatives = [
        '今天吃什么',
        '这是昨天发生的事情',
        '作者的名字叫张三',
        'what is the key prefix and suffix',
        'update the test fixture data',
      ];

      it('should match all positive cases', () => {
        expect(positives.length).toBeGreaterThanOrEqual(4);
        for (const text of positives) {
          expect(PROCEDURAL_INTENT_REGEX.test(text), `Failed positive: ${text}`).toBe(true);
        }
      });

      it('should not match negative cases', () => {
        expect(negatives.length).toBeGreaterThanOrEqual(2);
        for (const text of negatives) {
          expect(PROCEDURAL_INTENT_REGEX.test(text), `Failed negative: ${text}`).toBe(false);
        }
      });
    });

    describe('preference intent', () => {
      const positives = [
        '我喜欢使用 TypeScript',
        '回复格式一律用 Markdown',
        '不要在代码中使用 any',
        'I prefer dark theme style',
        '养成写测试的习惯',
        '别再输出多余的解释',
        '请别使用 var 声明变量',
        '切勿把密钥提交到仓库',
        '尽量别用全局状态',
        '别用默认导出',
      ];
      const negatives = [
        '这个函数返回一个数字',
        '为什么服务器挂了',
        '查询数据库中的所有表',
        '这两个版本有什么区别',
        '这个问题特别复杂',
        '分别启动前端和后端服务',
        '图像识别和日志级别与错误类别',
        'get user information from api',
      ];

      it('should match all positive cases', () => {
        expect(positives.length).toBeGreaterThanOrEqual(4);
        for (const text of positives) {
          expect(PREFERENCE_INTENT_REGEX.test(text), `Failed positive: ${text}`).toBe(true);
        }
      });

      it('should not match negative cases', () => {
        expect(negatives.length).toBeGreaterThanOrEqual(2);
        for (const text of negatives) {
          expect(PREFERENCE_INTENT_REGEX.test(text), `Failed negative: ${text}`).toBe(false);
        }
      });
    });
  });

  describe('temporalBrowse and preferenceBrowse regex', () => {
    it('should identify temporal browse correctly', () => {
      expect(TEMPORAL_BROWSE_REGEX.test('昨天做了什么')).toBe(true);
      expect(TEMPORAL_BROWSE_REGEX.test('回顾一下历史记录')).toBe(true);
      expect(TEMPORAL_BROWSE_REGEX.test('what did we discuss yesterday')).toBe(true);
      expect(TEMPORAL_BROWSE_REGEX.test('今天天气')).toBe(false);
      expect(TEMPORAL_BROWSE_REGEX.test('今天更新数据库')).toBe(false);
    });

    it('should identify preference browse correctly', () => {
      expect(PREFERENCE_BROWSE_REGEX.test('我的偏好有哪些')).toBe(true);
      expect(PREFERENCE_BROWSE_REGEX.test('列出我的偏好')).toBe(true);
      expect(PREFERENCE_BROWSE_REGEX.test('list my preferences')).toBe(true);
      expect(PREFERENCE_BROWSE_REGEX.test('我喜欢Python')).toBe(false);
    });
  });

  describe('parseTimeRange', () => {
    const fixedNow = new Date('2026-11-04T12:00:00Z').getTime();

    it('should parse YYYY-MM-DD', () => {
      const res = parseTimeRange('查看 2026-11-01 的日志', fixedNow);
      expect(res).toBeDefined();
      const fromDate = new Date(res!.from);
      expect(fromDate.getFullYear()).toBe(2026);
      expect(fromDate.getMonth()).toBe(10); // 11月是 10
      expect(fromDate.getDate()).toBe(1);
    });

    it('should parse M月D日 with year adjustment if future', () => {
      const res = parseTimeRange('查看 10月1日 的会议', fixedNow);
      expect(res).toBeDefined();
      const fromDate = new Date(res!.from);
      expect(fromDate.getMonth()).toBe(9); // 10月
      expect(fromDate.getDate()).toBe(1);
    });

    it('should parse 今天 / today', () => {
      const res = parseTimeRange('今天的工作', fixedNow);
      expect(res).toBeDefined();
      expect(res!.to).toBe(fixedNow);
    });

    it('should parse 昨天 / yesterday', () => {
      const res = parseTimeRange('昨天做了什么', fixedNow);
      expect(res).toBeDefined();
      expect(res!.to).toBeLessThan(fixedNow);
    });

    it('should parse 前天', () => {
      const res = parseTimeRange('前天提交的代码', fixedNow);
      expect(res).toBeDefined();
    });

    it('should parse 上周 / last week using calendar Monday through Sunday', () => {
      // 2026-11-04 is Wednesday -> previous calendar week is Mon 2026-10-26 00:00:00.000 to Sun 2026-11-01 23:59:59.999
      const res = parseTimeRange('上周有什么进展', fixedNow);
      expect(res).toBeDefined();
      const fromDate = new Date(res!.from);
      const toDate = new Date(res!.to);
      expect(fromDate.getFullYear()).toBe(2026);
      expect(fromDate.getMonth()).toBe(9); // October
      expect(fromDate.getDate()).toBe(26);
      expect(fromDate.getDay()).toBe(1); // Monday
      expect(toDate.getFullYear()).toBe(2026);
      expect(toDate.getMonth()).toBe(10); // November
      expect(toDate.getDate()).toBe(1);
      expect(toDate.getDay()).toBe(0); // Sunday
      expect(toDate.getHours()).toBe(23);
      expect(toDate.getMinutes()).toBe(59);
    });

    it('should parse 上个月 / last month using calendar 1st through last day including year rollover', () => {
      const res = parseTimeRange('上个月的变更记录', fixedNow);
      expect(res).toBeDefined();
      const fromDate = new Date(res!.from);
      const toDate = new Date(res!.to);
      expect(fromDate.getFullYear()).toBe(2026);
      expect(fromDate.getMonth()).toBe(9); // October
      expect(fromDate.getDate()).toBe(1);
      expect(toDate.getFullYear()).toBe(2026);
      expect(toDate.getMonth()).toBe(9);
      expect(toDate.getDate()).toBe(31);

      const janNow = new Date('2026-01-15T12:00:00Z').getTime();
      const decRes = parseTimeRange('last month summary', janNow);
      expect(decRes).toBeDefined();
      const decFrom = new Date(decRes!.from);
      const decTo = new Date(decRes!.to);
      expect(decFrom.getFullYear()).toBe(2025);
      expect(decFrom.getMonth()).toBe(11);
      expect(decFrom.getDate()).toBe(1);
      expect(decTo.getFullYear()).toBe(2025);
      expect(decTo.getMonth()).toBe(11);
      expect(decTo.getDate()).toBe(31);
    });

    it('should reject invalid calendar overflow dates like 2026-02-30 or 2026-04-31', () => {
      expect(parseTimeRange('查看 2026-02-30 的日志', fixedNow)).toBeUndefined();
      expect(parseTimeRange('查看 2026-04-31 的记录', fixedNow)).toBeUndefined();
      expect(parseTimeRange('查看 2025-02-29 的变更', fixedNow)).toBeUndefined();
      expect(parseTimeRange('查看 2月30日 的日志', fixedNow)).toBeUndefined();

      // Leap day 2024-02-29 IS valid
      const leap = parseTimeRange('查看 2024-02-29 的变更', fixedNow);
      expect(leap).toBeDefined();
      expect(new Date(leap!.from).getMonth()).toBe(1);
      expect(new Date(leap!.from).getDate()).toBe(29);
    });

    it('should parse 最近 / recently', () => {
      const res = parseTimeRange('最近有什么问题', fixedNow);
      expect(res).toBeDefined();
      expect(res!.from).toBe(fixedNow - 7 * 86400000);
      expect(res!.to).toBe(fixedNow);
    });

    it('should return undefined when no time expression is found', () => {
      const res = parseTimeRange('帮我写一个快速排序算法', fixedNow);
      expect(res).toBeUndefined();
    });
  });

  describe('buildQueryPlan', () => {
    it('should build a complete query plan and remove prompt words from contentTokens', () => {
      const plan = buildQueryPlan({
        userText: '今天 PostgreSQL 怎么配置连接池？',
        recentToolNames: ['bash', 'read_file'],
      });

      expect(plan.text).toBe('今天 PostgreSQL 怎么配置连接池？');
      expect(plan.intents.temporal).toBe(true);
      expect(plan.intents.procedural).toBe(true);
      // '今天', '怎么' 必须在 contentTokens 中被去除
      expect(plan.contentTokens).not.toContain('今天');
      expect(plan.contentTokens).not.toContain('怎么');
      expect(plan.contentTokens).toContain('postgresql');
      // contextEntities 只包含 recentToolNames
      expect(plan.contextEntities).toContain('bash');
      expect(plan.contextEntities).toContain('read_file');
      expect(plan.entities).not.toContain('bash');
      // temporalBrowse 应该为 false，因为这只是问配置，不是回顾记录
      expect(plan.temporalBrowse).toBe(false);
    });

    it('should truncate text to queryMaxChars', () => {
      const longText = 'a'.repeat(3000);
      const plan = buildQueryPlan({ userText: longText });
      expect(plan.text.length).toBeLessThanOrEqual(2000);
    });

    it('should yield clean contentTokens for natural English queries', () => {
      const plan = buildQueryPlan({
        userText: 'Can you please help me remember what port our backend listens on?',
      });
      expect(plan.contentTokens).toEqual(['port', 'backend', 'listens']);
    });

    it('should preserve trailing keywords on long 70+ char CJK queries', () => {
      const longQuery =
        '前面有一大段关于研发团队协作规范、日常评审流程、文档维护机制与测试环境准备工作的背景描述，最后核心想确认后端网关实际监听的端口号是不是 7890？';
      const plan = buildQueryPlan({ userText: longQuery });
      expect(plan.contentTokens).toContain('7890');
      expect(plan.contentTokens).toContain('端口');
    });
  });
});
