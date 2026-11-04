import type { EvalCase, EvalCaseSetup } from './types.js';

export function createSeededRandom(seed = 0x12345678) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 干扰事实池 (用于 factual 检索抗干扰能力测试)
const DISTRACTORS = [
  '文档生成工具采用 VitePress 构建并部署在 GitHub Pages。',
  '团队前端规范强制使用 ESLint 9 与 Prettier 格式化。',
  '日志系统输出等级生产环境为 info，开发环境为 debug。',
  '全局超时时间在 HTTP 客户端中默认统一配置为 30 秒。',
  '用户认证采用 RS256 签名的 JWT 鉴权体系。',
  '前端构建产物默认输出到 dist/ 目录。',
  '微服务间通信使用 gRPC 协议与 Protobuf 序列化。',
  '缓存系统使用的是 Redis 7 集群架构。',
  '自动化流水线在每次提交 PR 时自动触发 Vitest 单元测试。',
  '所有异步队列任务采用 BullMQ 基于 Redis 进行调度与消费。',
  '对象存储使用 MinIO 兼容 S3 协议进行文件存储。',
  '全局字符编码强制使用 UTF-8，禁止使用 GBK 编码。',
  '数据库连接池最大连接数配置为 20，最小空闲数为 5。',
  '项目依赖管理锁文件统一提交 pnpm-lock.yaml。',
  '消息中间件统一采用 Kafka 3.6 版本进行事件削峰。',
  '代码仓库主分支受保护，合并代码必须经过 2 人 Code Review。',
  '容器编排统一采用 Kubernetes 1.28 集群。',
  '所有外部请求均通过 Nginx 反向代理层进入网关。',
  '静态资源 CDN 缓存过期时间统一设置为 30 天。',
  '环境变量配置文件统一存放在项目根目录的 .env 文件中。',
  '性能监控采用 Prometheus 采集结合 Grafana 大盘展示。',
  '后端接口规范遵循 RESTful 规范，统一返回 code 与 data。',
  '内部依赖包发布在私有 NPM 源 registry.internal.corp。',
  'API 文档遵循 OpenAPI 3.0 规范由代码注解自动生成。',
];

/**
 * 生成符合 §8.2 规范的 120 条可复现评测用例 (包含 20 条 critical)
 */
export function generateDataset(seed = 0x12345678): EvalCase[] {
  const rand = createSeededRandom(seed);
  const cases: EvalCase[] = [];

  const fixedNow = '2026-10-01T10:00:00+08:00';
  const defaultWs = '/ws/demo';

  // --------------------------------------------------------------------------
  // 1. Factual Suite (30 条：27 条事实检索 + 3 条空门槛，其中 5 条 critical)
  // --------------------------------------------------------------------------
  const factualTopics = [
    {
      keyword: 'PostgreSQL',
      content: '本项目核心主数据库使用的是 PostgreSQL 16 关系型数据库。',
      queries: ['请问项目主数据库使用的是什么？', '当前系统使用的关系型数据库类型是什么？', '我们要连接什么主数据库？'],
    },
    {
      keyword: '8080',
      content: '后端服务默认本地监听端口为 8080 端口。',
      queries: ['后端服务本地启动的端口号是多少？', '后端服务 HTTP 监听端口是多少？', '应该访问后端哪个监听端口查看服务？'],
    },
    {
      keyword: 'Python 3.12',
      content: '数据处理脚本运行环境固定为 Python 3.12 版本虚拟环境。',
      queries: ['数据处理脚本需要使用哪个版本的 Python 运行？', '系统支持的数据处理 Python 版本是什么？', '数据处理 Python 运行时环境版本是什么？'],
    },
    {
      keyword: 'pnpm build',
      content: '前端与模块编译构建命令统一使用 pnpm build 执行。',
      queries: ['前端与模块项目的编译构建命令是什么？', '前端如何编译构建产物？', '怎么执行 pnpm build 编译构建脚本？'],
    },
    {
      keyword: 'Docker 镜像',
      content: '发布部署采用基于 Alpine Linux 基础镜像构建的 Docker 镜像。',
      queries: ['项目的发布部署采用什么 Docker 容器镜像？', 'Docker 基础镜像是哪一个发布部署镜像？', '发布部署的 Docker 镜像构建规范是什么？'],
    },
    {
      keyword: 'vitest run',
      content: '单元测试单测运行执行命令为 vitest run，且单测必须全部通过。',
      queries: ['怎么在本地运行单测与单元测试？', '单元测试单测命令怎么写？', '如何运行单元测试单测测试套件？'],
    },
    {
      keyword: 'Bearer Token',
      content: '外部 API 接口鉴权请求头必须携带 Bearer Token 认证凭据。',
      queries: ['调用 API 接口时请求头怎么传认证凭据？', 'API 接口鉴权认证方式是什么？', '外部接口认证使用哪种 Token 凭据？'],
    },
    {
      keyword: 'ES2022',
      content: 'TypeScript (TS) 编译目标 target 在 tsconfig 中统一配置为 ECMAScript ES2022 版本。',
      queries: ['项目的 TypeScript 编译目标版本是哪一个？', 'tsconfig 的 target 编译目标是什么？', 'TS 编译到哪个 ECMAScript 目标版本？'],
    },
    {
      keyword: 'commitlint',
      content: 'Git 提交信息强制使用 commitlint 校验 Conventional Commits 规范。',
      queries: ['Git Commit 提交信息有什么格式检查要求？', '使用什么工具校验 git commit 提交信息？', 'Git Commit 提交代码时的校验规则是什么？'],
    },
  ];

  for (let i = 0; i < 27; i++) {
    const topic = factualTopics[i % factualTopics.length];
    const query = topic.queries[i % topic.queries.length];
    const isCritical = i < 5; // 前 5 条为 critical

    // 随机挑选 20 条干扰事实
    const shuffled = [...DISTRACTORS].sort(() => rand() - 0.5);
    const distractors = shuffled.slice(0, 20);

    const setup: EvalCaseSetup[] = [
      {
        type: 'semantic',
        content: topic.content,
        slot_key: `factual.topic.${i}`,
        source_kind: 'user',
        status: 'active',
        pinned: 0,
        utility: 0.8,
      },
      ...distractors.map(d => ({
        type: 'semantic' as const,
        content: d,
        source_kind: 'user' as const,
        status: 'active' as const,
        pinned: 0,
        utility: 0.5,
      })),
    ];

    cases.push({
      id: `factual-${String(i + 1).padStart(3, '0')}`,
      suite: 'factual',
      critical: isCritical,
      now: fixedNow,
      workspace: defaultWs,
      setup,
      query,
      expect: {
        include: [topic.keyword],
        exclude: [],
        maxTokens: 1600,
      },
    });
  }

  // Factual 门槛测试 (3 条，include 为空)
  for (let i = 27; i < 30; i++) {
    cases.push({
      id: `factual-empty-${String(i + 1).padStart(3, '0')}`,
      suite: 'factual',
      critical: false,
      now: fixedNow,
      workspace: defaultWs,
      setup: [
        {
          type: 'semantic',
          content: '项目数据库使用 PostgreSQL 16 数据库服务。',
          source_kind: 'user',
          status: 'active',
        },
      ],
      query: '今天晚上的月亮是什么形状的天文现象？',
      expect: {
        include: [],
        exclude: ['PostgreSQL'],
        maxTokens: 1600,
      },
    });
  }

  // --------------------------------------------------------------------------
  // 2. Temporal Suite (30 条：22 条更新覆盖 + 5 条时间词 + 3 条空门槛)
  // --------------------------------------------------------------------------
  const temporalSlots = [
    {
      slot: 'project.database',
      oldVal: '项目数据库是 MySQL 8.0 关系型数据库',
      newVal: '项目数据库已全面迁移到 PostgreSQL 16 数据库',
      query: '项目数据库连接串怎么配置？',
      inc: 'PostgreSQL',
      exc: 'MySQL',
    },
    {
      slot: 'infra.port',
      oldVal: '服务对外的本地监听端口配置为 3000 端口',
      newVal: '服务对外的本地监听端口已调整为 8080 端口',
      query: '服务对外的本地监听端口是多少？',
      inc: '8080',
      exc: '3000',
    },
    {
      slot: 'deploy.cluster',
      oldVal: '项目部署目标集群是 k8s-dev-01 开发集群',
      newVal: '项目部署目标集群已切换为 k8s-prod-us 生产集群',
      query: '项目部署目标集群叫什么名字？',
      inc: 'k8s-prod-us',
      exc: 'k8s-dev-01',
    },
    {
      slot: 'tool.pkg_manager',
      oldVal: '项目包管理依赖安装工具使用的是 yarn',
      newVal: '项目包管理依赖安装工具已迁移到 pnpm',
      query: '项目使用的是哪个包管理依赖工具？',
      inc: 'pnpm',
      exc: 'yarn',
    },
  ];

  for (let i = 0; i < 22; i++) {
    const t = temporalSlots[i % temporalSlots.length];
    const isCritical = i < 5; // 前 5 条为 critical

    const setup: EvalCaseSetup[] = [
      {
        type: 'semantic',
        content: t.oldVal,
        slot_key: t.slot,
        at: '2026-08-01T10:00:00+08:00',
        source_kind: 'user',
        status: 'active',
      },
      {
        type: 'semantic',
        content: t.newVal,
        slot_key: t.slot,
        at: '2026-09-20T10:00:00+08:00',
        source_kind: 'user',
        status: 'active',
      },
    ];

    cases.push({
      id: `temporal-${String(i + 1).padStart(3, '0')}`,
      suite: 'temporal',
      critical: isCritical,
      now: fixedNow,
      workspace: defaultWs,
      setup,
      query: t.query,
      expect: {
        include: [t.inc],
        exclude: [t.exc],
        maxTokens: 1600,
      },
    });
  }

  // 5 条带有明确时间词的查询 (如 "上周", "昨天")
  const relativeQueries = [
    { q: '上周更新的数据库配置是什么？', inc: 'PostgreSQL', exc: 'MySQL' },
    { q: '昨天调整的服务端口是多少？', inc: '8080', exc: '3000' },
    { q: '最近迁移的新集群叫什么？', inc: 'k8s-prod-us', exc: 'k8s-dev-01' },
    { q: '前几天改用的包管理工具是哪个？', inc: 'pnpm', exc: 'yarn' },
    { q: '最新确定的项目主数据库是什么？', inc: 'PostgreSQL', exc: 'MySQL' },
  ];

  for (let i = 22; i < 27; i++) {
    const item = relativeQueries[i - 22];
    cases.push({
      id: `temporal-rel-${String(i + 1).padStart(3, '0')}`,
      suite: 'temporal',
      critical: false,
      now: fixedNow,
      workspace: defaultWs,
      setup: [
        {
          type: 'semantic',
          content: '上个月记录：项目数据库配置为 MySQL 8.0 关系型数据库。',
          slot_key: 'project.database',
          at: '2026-08-01T10:00:00+08:00',
          source_kind: 'user',
          status: 'active',
        },
        {
          type: 'semantic',
          content: '上周最新记录：项目数据库已全面更新至 PostgreSQL 16 数据库服务。',
          slot_key: 'project.database',
          at: '2026-09-25T10:00:00+08:00',
          source_kind: 'user',
          status: 'active',
        },
        {
          type: 'semantic',
          content: '旧配置：服务监听端口为 3000 端口。',
          slot_key: 'infra.port',
          at: '2026-08-01T10:00:00+08:00',
          source_kind: 'user',
          status: 'active',
        },
        {
          type: 'semantic',
          content: '前几天的配置：服务监听端口已调整为 8080 端口。',
          slot_key: 'infra.port',
          at: '2026-09-26T10:00:00+08:00',
          source_kind: 'user',
          status: 'active',
        },
        {
          type: 'semantic',
          content: '旧集群部署配置：k8s-dev-01 集群。',
          slot_key: 'deploy.cluster',
          at: '2026-08-01T10:00:00+08:00',
          source_kind: 'user',
          status: 'active',
        },
        {
          type: 'semantic',
          content: '最新集群部署配置：k8s-prod-us 集群。',
          slot_key: 'deploy.cluster',
          at: '2026-09-27T10:00:00+08:00',
          source_kind: 'user',
          status: 'active',
        },
        {
          type: 'semantic',
          content: '旧包管理工具：项目使用 yarn 管理依赖。',
          slot_key: 'tool.pkg_manager',
          at: '2026-08-01T10:00:00+08:00',
          source_kind: 'user',
          status: 'active',
        },
        {
          type: 'semantic',
          content: '最新包管理工具：项目已全面换为 pnpm 管理依赖。',
          slot_key: 'tool.pkg_manager',
          at: '2026-09-28T10:00:00+08:00',
          source_kind: 'user',
          status: 'active',
        },
      ],
      query: item.q,
      expect: {
        include: [item.inc],
        exclude: [item.exc],
        maxTokens: 1600,
      },
    });
  }

  // Temporal 门槛测试 (3 条，include 为空)
  for (let i = 27; i < 30; i++) {
    cases.push({
      id: `temporal-empty-${String(i + 1).padStart(3, '0')}`,
      suite: 'temporal',
      critical: false,
      now: fixedNow,
      workspace: defaultWs,
      setup: [
        {
          type: 'semantic',
          content: '数据库配置为 PostgreSQL 16。',
          slot_key: 'project.database',
          at: '2026-09-20T10:00:00+08:00',
          source_kind: 'user',
          status: 'active',
        },
      ],
      query: '明天食堂中午吃什么特色菜？',
      expect: {
        include: [],
        exclude: ['PostgreSQL'],
        maxTokens: 1600,
      },
    });
  }

  // --------------------------------------------------------------------------
  // 3. Procedural / Failure Suite (30 条：27 条规程与失败联动 + 3 条空门槛)
  // --------------------------------------------------------------------------
  const failurePairs = [
    {
      sig: 'ERR_MODULE_NOT_FOUND',
      failContent: '工具报错提示 ERR_MODULE_NOT_FOUND：dist/index.js 模块缺失。',
      procContent: '遇到 ERR_MODULE_NOT_FOUND 报错时，必须先运行 pnpm build 重新生成 dist/ 产物。',
      query: '又报 ERR_MODULE_NOT_FOUND 错误了怎么解决？',
      inc: ['ERR_MODULE_NOT_FOUND', 'pnpm build'],
    },
    {
      sig: 'ECONNREFUSED',
      failContent: '网络请求连接失败 ECONNREFUSED：本地代理 7890 端口未启动。',
      procContent: '出现 ECONNREFUSED 错误时，先检查代理服务是否在 7890 端口正常监听。',
      query: '接口请求报 ECONNREFUSED 怎么排查？',
      inc: ['ECONNREFUSED', '7890'],
    },
    {
      sig: 'EADDRINUSE',
      failContent: '本地启动服务报错提示 EADDRINUSE：端口已被其它进程持有占用。',
      procContent: '遇到本地启动提示 EADDRINUSE 报错时，使用 lsof 查找占用进程并安全 kill 终止。',
      query: '本地启动提示 EADDRINUSE 怎么处理？',
      inc: ['EADDRINUSE', 'kill'],
    },
    {
      sig: 'ETIMEDOUT',
      failContent: '单测运行超时 ETIMEDOUT：网络请求由于无响应挂起。',
      procContent: '单测遭遇 ETIMEDOUT 时，将 vitest testTimeout 增加到 30000ms。',
      query: '单测频繁报 ETIMEDOUT 怎么办？',
      inc: ['ETIMEDOUT', '30000'],
    },
  ];

  for (let i = 0; i < 27; i++) {
    const pair = failurePairs[i % failurePairs.length];
    const isCritical = i < 5; // 前 5 条为 critical

    const setup: EvalCaseSetup[] = [
      {
        type: 'failure',
        content: pair.failContent,
        slot_key: `failure.${pair.sig}`,
        source_kind: 'user',
        status: 'active',
      },
      {
        type: 'procedural',
        content: pair.procContent,
        slot_key: `procedure.${pair.sig}`,
        source_kind: 'user',
        status: 'active',
      },
    ];

    cases.push({
      id: `procedural-${String(i + 1).padStart(3, '0')}`,
      suite: 'procedural',
      critical: isCritical,
      now: fixedNow,
      workspace: defaultWs,
      setup,
      query: pair.query,
      expect: {
        include: pair.inc,
        exclude: [],
        maxTokens: 1600,
      },
    });
  }

  // Procedural 门槛测试 (3 条，include 为空)
  for (let i = 27; i < 30; i++) {
    cases.push({
      id: `procedural-empty-${String(i + 1).padStart(3, '0')}`,
      suite: 'procedural',
      critical: false,
      now: fixedNow,
      workspace: defaultWs,
      setup: [
        {
          type: 'procedural',
          content: '遇到 ERR_MODULE_NOT_FOUND 时执行 pnpm build 重新构建。',
          source_kind: 'user',
          status: 'active',
        },
      ],
      query: '如何手冲一杯风味良好的耶加雪菲咖啡？',
      expect: {
        include: [],
        exclude: ['pnpm build'],
        maxTokens: 1600,
      },
    });
  }

  // --------------------------------------------------------------------------
  // 4. Implicit Suite (30 条：20 条偏好置顶验证 + 7 条动态不重复注入 + 3 条空门槛)
  // --------------------------------------------------------------------------
  const prefContent = '用户偏好使用简洁严谨的命令式步骤回答，绝不啰嗦寒暄。';
  const prefKeyword = '简洁严谨';

  for (let i = 0; i < 20; i++) {
    const isCritical = i < 5; // 前 5 条为 critical
    const setup: EvalCaseSetup[] = [
      {
        type: 'preference',
        content: prefContent,
        pinned: 1, // 稳定层置顶
        status: 'active',
        source_kind: 'user',
        utility: 0.9,
      },
      {
        type: 'semantic',
        content: '项目构建命令使用 pnpm build 执行完整打包编译。',
        pinned: 0,
        status: 'active',
        source_kind: 'user',
        utility: 0.8,
      },
    ];

    cases.push({
      id: `implicit-${String(i + 1).padStart(3, '0')}`,
      suite: 'implicit',
      critical: isCritical,
      now: fixedNow,
      workspace: defaultWs,
      setup,
      query: '请问如何构建项目？',
      expect: {
        include: ['pnpm build'],
        expectStable: [prefKeyword], // 验证稳定层呈现该偏好
        maxTokens: 1600,
      },
    });
  }

  // 7 条与偏好无关的查询，确保动态层不把稳定层已有偏好重复注入
  const generalQueries = [
    { q: '查看一下当前项目的 Git 状态', fact: '当前项目的 Git 状态分支为 main 分支' },
    { q: '项目数据库端口是多少？', fact: '项目数据库端口为 5432 端口' },
    { q: '系统 Node 版本要求是多少？', fact: '系统 Node 运行版本要求 >= 24' },
    { q: '项目单测测试命令是什么？', fact: '项目单测运行测试使用 pnpm test 命令' },
    { q: '项目本地缓存目录在哪里？', fact: '项目本地缓存保存在 .cache 目录下' },
    { q: '系统配置文件叫什么？', fact: '系统配置文件是 config.yaml 文件' },
    { q: '系统运行日志轮转周期多长？', fact: '系统运行日志每天凌晨轮转一次' },
  ];

  for (let i = 20; i < 27; i++) {
    const item = generalQueries[i - 20];
    cases.push({
      id: `implicit-nodup-${String(i + 1).padStart(3, '0')}`,
      suite: 'implicit',
      critical: false,
      now: fixedNow,
      workspace: defaultWs,
      setup: [
        {
          type: 'preference',
          content: prefContent,
          pinned: 1,
          status: 'active',
          source_kind: 'user',
          utility: 0.9,
        },
        {
          type: 'semantic',
          content: item.fact,
          pinned: 0,
          status: 'active',
          source_kind: 'user',
          utility: 0.8,
        },
      ],
      query: item.q,
      expect: {
        include: [item.fact.split(' ')[0]],
        exclude: [prefKeyword], // 动态层不得重复注入稳定层已有的偏好关键字
        expectStable: [prefKeyword], // 稳定层依然应有
        maxTokens: 1600,
      },
    });
  }

  // Implicit 门槛测试 (3 条，include 为空)
  for (let i = 27; i < 30; i++) {
    cases.push({
      id: `implicit-empty-${String(i + 1).padStart(3, '0')}`,
      suite: 'implicit',
      critical: false,
      now: fixedNow,
      workspace: defaultWs,
      setup: [
        {
          type: 'preference',
          content: prefContent,
          pinned: 1,
          status: 'active',
          source_kind: 'user',
          utility: 0.9,
        },
      ],
      query: '世界上最深的海沟是哪一个？',
      expect: {
        include: [],
        exclude: ['pnpm'],
        expectStable: [prefKeyword],
        maxTokens: 1600,
      },
    });
  }

  return cases;
}
