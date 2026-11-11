# DSH Self-Evolving Memory · 落地执行方案 v1.1

> **执行方：** DeepSeek-V4.1-Flash（以下称"执行模型"）。
> **来源：** `DSH_Self_Evolving_Memory_Design_v2026.10.docx`（以下称"原设计"）。本文把原设计压缩成**可逐条执行、每步可验证**的任务清单。原设计负责"为什么"，本文只负责"做什么、怎么做、做到什么算完"。
> **冲突时以本文为准。** 本文与原设计不一致之处都在 §1 列出，并给出了理由。
> 日期：2026-10-03
> 修订：2026-10-03 审查后的执行合同；主计划与两份附录必须一起使用。本文定义调度、信任、预算与内部数据合同；附录 A 定义经核实的 DSH 接口；附录 B 定义外部 LLM 输入输出格式。若仍发现矛盾，停止相关任务并修正文档，不得自行任选一份实现。

---

## 目录

- §0 执行模型工作守则（必读，先读这节）
- §1 相对原设计的修订（共 12 处）
- §2 技术选型（已定，不要改）
- §3 项目结构
- §4 数据库 Schema（完整 DDL）
- §5 核心算法规格（文本切分 / Token 估算 / 检索 / 打分 / 预算 / 写入 / 效用 / 进化）
- §6 DSH 适配层（接口以 `APPENDIX-A-dsh-api.md` 为准）
- §7 任务清单 M0–M6（每个任务都有验收命令）
- §8 评测集格式与回归门禁
- §9 配置项与默认值
- §10 部署、备份、回滚
- §11 不做的事（Out of scope）
- 附录 A：DSH API 速查（`APPENDIX-A-dsh-api.md`，单独文件）
- 附录 B：离线 LLM Prompt 全文（`APPENDIX-B-prompts.md`，单独文件）

---

## §0 执行模型工作守则

**按顺序读、按顺序做。** 本节的规则在整个项目中都有效。

1. **严格按 §7 的任务编号顺序执行。** 一个任务的"验收"没有全部通过，不允许开始下一个任务。M0–M3 完成核心功能，M4 完成可量化的 MVP 验收；M5–M6 是增强，不作为 M3 已完成的能力宣称。
2. **不许编造 DSH API。** 任何 `ctx.xxx`、事件名、类型名，必须能在 `APPENDIX-A-dsh-api.md` 或 DSH 安装目录的 `.d.ts` 里找到。找不到 → 停下来，在 `NOTES.md` 写明"缺少什么、在哪里找过"，然后只在 `src/dsh/` 适配层里做最小假设，并加 `// TODO(dsh-api): 未验证` 注释。
3. **DSH 相关代码只能出现在 `src/dsh/` 目录。** `src/core/`、`src/retrieval/`、`src/evolution/` 等目录**禁止 import 任何 `@deepseek-ai/*` 包**。这样 DSH API 变化时只需要改一个目录，核心逻辑也能脱离 DSH 单独测试。
4. **在线路径（`agent/pre-step` 及其调用的所有函数）禁止：** 发起网络请求（包括本机 HTTP embedding）、调用 LLM、同步读取大文件、执行超过 50ms 的循环。可选向量通道只能使用已在离线阶段计算好的查询向量缓存；缓存未命中就跳过。
5. **插件自身的异常不允许抛给 DSH。** 所有插件操作都要 `try/catch`，出错时记脱敏日志并**放行**；pre-step 只调用一次 `next()`，得到下游 decision 后，插件失败时返回该 decision。`next()` 自身的下游异常不属于插件故障，不得通过再次调用 `next()` 掩盖。事件监听器失败时直接 return。
6. **数据库写操作只能经过 `src/core/writer.ts`。** 其他模块不许直接对 `memories` 表执行 INSERT/UPDATE。
7. **每完成一个任务：** 运行 `npm run check`（类型检查 + 测试；见 M0-T3），全部通过后再在 `PROGRESS.md` 追加一行：`[任务号] 完成 · 新增/修改的文件 · 测试数`。
8. **不确定时选最简单的实现。** 本文没有要求的功能不要做，本文没有要求的依赖不要加。
9. **数字、阈值一律从 `config.ts` 读取**，不许在业务代码里写魔法数字（测试代码除外）。
10. **所有时间用 Unix 毫秒整数（`number`）存储和比较。** 只在展示时格式化。
11. **信任和预算是不可被进化降低的硬约束。** LLM 输出、模型工具调用、跨 session 重复出现、utility 或成功计数都不是用户审批。未经授权的内容不得晋升、替换已生效记忆或被发送到离线 provider。

---

## §1 相对原设计的修订

| # | 原设计 | 修订为 | 理由 |
|---|---|---|---|
| R1 | 每次 `agent/pre-step` 都调用 `agent.inject()` 注入记忆块 | **分两层注入**：① 稳定记忆放进 system prompt 段；② 动态记忆改写首步 decision，只注入当前上下文中尚不可见的 `id@content_rev`；完整引用落盘到 `source.memoryRefs`，只按真正的历史替换更新可见状态 | 消息 UUID 不等于记忆 ID；压缩开始/失败不等于历史已替换。system prompt 段不反复追加为插件 user 消息，但 provider 的 `in-history` 模式仍可能记录系统更新，不能承诺绝不进入日志。 |
| R2 | 多路召回包含"vector + BM25 + graph"，建议使用 FAISS | MVP 阶段：**BM25（SQLite FTS5）+ 实体精确匹配 + 时间 + 类型过滤**。向量检索做成**可插拔接口，默认关闭**；开启后使用 SQLite BLOB 存向量、暴力计算余弦相似度 | Windows + Electron 环境下 FAISS 和原生向量扩展需要编译，是最大的落地风险。单机 5 万条记忆以内，暴力余弦检索 < 30ms，完全够用。 |
| R3 | 本地 reranker 模型 | 用**确定性打分公式**代替（§5.6），公式的权重交给 Evolution Lab 进化 | 不引入模型依赖，结果可复现，便于做回归测试。 |
| R4 | 冲突检测没有给出具体算法 | 引入 **`slot_key`（槽位键）**，例如 `project.database`、`user.pref.reply_language`。同一个 scope 下同一个槽位只允许有一条 `active` 记录；新值到来时走 supersede 链 | 把"冲突检测"从语义判断（需要 LLM）变成精确匹配（本地即可完成），这样执行模型也能写对。 |
| R5 | 中文检索没有说明 | FTS5 使用**预切分文本**：中文切成重叠的二元组（bigram），英文/代码按单词切分并拆开驼峰和路径（§5.1） | SQLite 自带的 `unicode61` 分词器无法切分中文；`trigram` 分词器要求查询词至少 3 个字，而中文里大量关键词只有 2 个字。 |
| R6 | 效用（utility）的更新方式没有给出公式 | 采用 **EMA 更新 + "是否真正被使用"归因**（§5.9） | Fine-Mem 思想的最小可行版本：只有被回答或工具参数真正用到的记忆，才拿到全额奖惩。 |
| R7 | P0–P9 共十个阶段 | 本文只覆盖 **M0–M6**（对应原设计 P0–P6，以及 P7 的精简版）。P8（AgeMem 强化学习）和 P9（LoRA）**不在本次范围内** | 这两项是研究课题，没有确定的验收标准，不适合交给执行模型。 |
| R8 | 原设计没有涉及冷启动 | 增加 **历史回填任务**：导入 `~/.dsh/sessions/**/session.v4.jsonl.zstd` | 本机已有 8 个工作区的历史 Session，回填后系统第一天就有记忆可用。 |
| R9 | "离线预算化"没有给出具体数字 | 默认每日 40 次 / 200k tokens；**每次 HTTP attempt 发送前原子预留输入上界、最大输出与一次调用额度**，失败和重试也记账 | 只检查输入或仅在任务开始检查，无法保证硬上限。 |
| R10 | 工具和网页内容"默认 untrusted" | 按证据传播 `origin_kinds`；包含 tool/web 的未批准记忆置信度不超过 0.5。所有非显式用户写入的学习结果均为 candidate；MVP **只允许真实用户审批晋升**，重复出现与任务成功只作为审批证据 | 防止 merge、rule 包装和 repair 洗白来源；候选不得使旧 active 失效。 |
| R11 | 原设计列出了 4 个模型可见工具 | 保留 4 个：`memory_search` / `memory_expand` / `memory_feedback` / `memory_note`；原 `memory_mark` 改名为 `memory_note`，只能提候选 | 模型不能直接批准或修改已生效记忆。 |
| R12 | Strategy A/B 测试 | MVP 只做**离线回放 A/B**（在回归集上比较）+ **上线后哨兵监控**（纠正率变差就自动回滚），不做在线流量切分 | 单用户场景下，在线流量太少，切分后统计不出显著差异。 |

---

## §2 技术选型（已定，不要改）

| 项 | 选择 | 说明 |
|---|---|---|
| 语言 | TypeScript 5.x，`"strict": true`，ESM | 与 DSH 插件体系保持一致 |
| 运行时 | DSH Desktop 内嵌的 Node（版本见附录 A §A.0） | **不要假设**一定是 Node 24 |
| 主存储 | SQLite：**优先用 `node:sqlite`（内置模块）**；不可用时退回 `sql.js`（WASM 版 SQLite，纯 JS，无需编译） | **禁止使用 `better-sqlite3`** 等需要 node-gyp 编译的原生模块。具体选哪个由 M0-T1 的探测结果决定，统一封装在 `src/core/db.ts` 里 |
| 全文检索 | SQLite FTS5 + 自行预切分（§5.1） | M0-T1 必须验证 FTS5 可用 |
| 向量（可选） | `EmbeddingProvider` 接口；实现两个：`none`（默认）和 `openai-compatible` | 记忆向量、历史查询向量都只在离线阶段计算，经过隐私授权及 ledger；在线只查查询哈希对应的缓存，未命中直接跳过，不调用任何 HTTP 服务 |
| zstd 解压 | 优先 `node:zlib` 的 `zstdDecompressSync`；不存在时用 `fzstd`（纯 JS） | 只在历史回填时用到 |
| 测试 | `vitest` | |
| 构建 | `tsup`，输出 ESM 到 `dist/` | 如果附录 A 显示 DSH 需要 CJS，改为输出 CJS |
| 运行时依赖白名单 | `sql.js`（仅在需要回退时）、`fzstd`、`zod`（仅用于宿主会话投影状态校验） | `zod` 对齐附录 A 的投影 schema；其他运行时依赖仍需单独说明用途 |

---

## §3 项目结构

```
dsh-memory/
├─ package.json            # 含 dsh 字段，见 §10
├─ tsconfig.json
├─ tsup.config.ts
├─ vitest.config.ts
├─ NOTES.md                # 执行中遇到的不确定点、API 差异
├─ PROGRESS.md             # 每个任务完成后追加一行
├─ src/
│  ├─ index.ts             # 仅重新导出 src/dsh/plugin.ts，不直接 import DSH 包
│  ├─ config.ts            # §9 全部配置 + 默认值 + 校验
│  ├─ types.ts             # MemoryRecord 等核心类型
│  ├─ dsh/                 # ★ 唯一允许 import @deepseek-ai/* 的目录
│  │  ├─ plugin.ts         # Config/apply/inject/name；组装模块与生命周期
│  │  ├─ adapter.ts        # 把 DSH 对象转换为内部类型（SessionRef, TurnEvent…）
│  │  ├─ session-listener.ts   # session/event → ingest 队列
│  │  ├─ pre-step.ts       # agent/pre-step → recall → inject
│  │  ├─ prompt-section.ts # 稳定记忆 → system prompt 段
│  │  ├─ turn-stopping.ts  # turn 结束 → 结果评估 + 任务入队
│  │  ├─ tools.ts          # memory_search / memory_expand / memory_feedback / memory_note
│  │  ├─ commands.ts       # /memory 系列命令
│  │  └─ jobs.ts           # 组装 src/jobs/* 的插件内部 scheduler（不注册 ctx.jobs）
│  ├─ core/
│  │  ├─ db.ts             # SQLite 封装（node:sqlite / sql.js 二选一），迁移
│  │  ├─ migrations/001_init.sql
│  │  ├─ text.ts           # 切分、规范化、哈希、Jaccard、实体抽取
│  │  ├─ tokens.ts         # Token 估算
│  │  ├─ store.ts          # 只读查询（按 id 取、按条件列出）
│  │  ├─ writer.ts         # ★ 唯一写入口：upsert / supersede / version / forget
│  │  ├─ scope.ts          # workspace_id 计算、scope 过滤
│  │  ├─ ledger.ts         # LLM 调用账本与每日预算
│  │  └─ privacy.ts        # ingest / writer / 请求发送前共用的脱敏与授权闸门
│  ├─ ingest/
│  │  ├─ queue.ts          # 异步批量写入 raw_events
│  │  ├─ rules.ts          # R1–R5 规则抽取器（本地执行，不调用 LLM）
│  │  └─ backfill.ts       # 历史 session 回填
│  ├─ retrieval/
│  │  ├─ query.ts          # QueryPlan：意图、实体、时间范围
│  │  ├─ channels.ts       # lexical / entity / temporal / typed / standing / vector
│  │  ├─ fuse.ts           # 加权 RRF 融合 + 打分
│  │  ├─ governor.ts       # 去重、冲突过滤、Token 预算装箱
│  │  ├─ render.ts         # 生成 <memory_context> 文本
│  │  └─ recall.ts         # 对外入口 recall(plan, budget, filters)
│  ├─ evolution/
│  │  ├─ llm.ts            # 离线 LLM 客户端（OpenAI 兼容接口，经过 ledger 计费）
│  │  ├─ parse.ts          # 附录 B schema 校验、证据映射、内部 CandidateInput 转换
│  │  ├─ prompts.ts        # 附录 B 的版本化提示词
│  │  ├─ extractor.ts      # 会话蒸馏（附录 B-1）
│  │  ├─ reflector.ts      # 失败/纠正反思（附录 B-2）
│  │  ├─ outcome.ts        # turn 结果判定 + utility 更新
│  │  ├─ consolidator.ts   # 聚类、合并、技能蒸馏（附录 B-3）
│  │  ├─ maintenance.ts    # 衰减、归档、FTS 重建、备份
│  │  ├─ strategy.ts       # StrategyConfig 的版本管理
│  │  ├─ lab.ts            # 回放 A/B、变异、晋升、回滚
│  │  └─ repair.ts         # 查询触发修复（M6）
│  ├─ jobs/
│  │  ├─ scheduler.ts      # 空闲/夜间触发、互斥锁、预算检查
│  │  └─ runners.ts        # 每类 job 的执行函数
│  └─ eval/
│     ├─ runner.ts         # 加载 JSONL 回归集，逐条跑 recall 并判分
│     ├─ metrics.ts
│     ├─ gen-dataset.ts    # 根据模板生成 ≥120 条回归用例
│     └─ datasets/*.jsonl
└─ test/                   # vitest 单元测试，目录结构与 src 一一对应
```

---

## §4 数据库 Schema

文件：`src/core/migrations/001_init.sql`。新项目使用下面的 v1.1 DDL。若 v1.0 已经落地，必须新建 `002_review_fixes.sql` 迁移并备份，**不要改已执行过的 001**；历史来源/审批信息缺失的非用户记忆降为 candidate，无法重建可见引用的旧投影不得继续用于去重。

```sql
PRAGMA journal_mode = WAL;          -- sql.js 回退模式下忽略这行
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 初始写入: ('schema_version','1'), ('contract_version','1.1'), ('created_at', <ms>)

-- 记忆主表：每条记忆一行，存放的是"当前版本"
CREATE TABLE IF NOT EXISTS memories (
  rowid_        INTEGER PRIMARY KEY AUTOINCREMENT,  -- 与 FTS 的 rowid 对齐
  id            TEXT NOT NULL UNIQUE,               -- 'm_' + 16位base32随机串
  type          TEXT NOT NULL CHECK (type IN
                 ('episodic','semantic','procedural','belief','preference','goal','failure','meta')),
  status        TEXT NOT NULL CHECK (status IN
                 ('candidate','active','superseded','archived','rejected','frozen')),
  content       TEXT NOT NULL,          -- 完整表述，不超过 cfg.maxContentTokens(默认 400) tokens
  summary       TEXT NOT NULL,          -- 一句话摘要，不超过 cfg.maxSummaryTokens(默认 60) tokens
  slot_key      TEXT,                   -- 槽位键（可为空），见 §5.8
  scope         TEXT NOT NULL CHECK (scope IN ('session','workspace','user','global')),
  workspace_id  TEXT,                   -- scope='workspace' 时必填
  session_id    TEXT,                   -- scope='session' 时必填
  origin_kinds  TEXT NOT NULL DEFAULT '[]', -- JSON 数组；由真实证据推导，不接受 LLM 自报
  approved_at   INTEGER,                -- 显式用户写入/审批的时间；NULL 表示未审批
  approved_by   TEXT,                   -- 用户事件引用或手动命令审计引用
  source_kind   TEXT NOT NULL CHECK (source_kind IN
                 ('user','assistant','tool','web','llm_extract','rule','system')),
  confidence    REAL NOT NULL DEFAULT 0.5,   -- 0..1
  utility       REAL NOT NULL DEFAULT 0.5,   -- 0..1
  use_count     INTEGER NOT NULL DEFAULT 0,  -- 被注入的次数
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  token_cost    INTEGER NOT NULL,            -- content 的 token 估算值
  summary_cost  INTEGER NOT NULL,            -- summary 的 token 估算值
  hash          TEXT NOT NULL,               -- sha256(type|normalized content) 的前 32 位十六进制
  version       INTEGER NOT NULL DEFAULT 1,
  content_rev   INTEGER NOT NULL DEFAULT 1 CHECK (content_rev >= 1), -- 仅 content/summary 改变时递增，用于可见性去重
  pinned        INTEGER NOT NULL DEFAULT 0,  -- 1 表示属于稳定层（进入 system prompt 段）
  valid_from    INTEGER,
  valid_to      INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  last_repair_at INTEGER,                    -- 最近实际派发 repair 请求的时间
  embedding     BLOB,                        -- Float32Array 的字节；未开启向量时为 NULL
  CHECK (
    (scope IN ('user','global') AND workspace_id IS NULL AND session_id IS NULL)
    OR (scope='workspace' AND workspace_id IS NOT NULL AND session_id IS NULL)
    OR (scope='session' AND workspace_id IS NOT NULL AND session_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS ix_mem_status_scope ON memories(status, scope, workspace_id);
CREATE INDEX IF NOT EXISTS ix_mem_slot ON memories(slot_key, scope, workspace_id, status);
CREATE INDEX IF NOT EXISTS ix_mem_hash ON memories(hash);
CREATE INDEX IF NOT EXISTS ix_mem_type ON memories(type, status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_mem_live_slot
  ON memories(scope, COALESCE(workspace_id,''), COALESCE(session_id,''), slot_key)
  WHERE slot_key IS NOT NULL AND status IN ('active','frozen');

-- 全文索引：fts_text 是 §5.1 预切分后、用空格连接的 token 串
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  fts_text,
  tokenize = 'unicode61 remove_diacritics 2'
);
-- 约定：memory_fts.rowid == memories.rowid_；由 writer.ts 在同一事务内维护

-- 实体倒排表（文件路径、包名、标识符、错误码等）
CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id  TEXT NOT NULL,
  entity     TEXT NOT NULL,          -- 规范化后的实体（小写、路径统一用 /）
  PRIMARY KEY (memory_id, entity)
);
CREATE INDEX IF NOT EXISTS ix_ent ON memory_entities(entity);

-- 证据：记忆 → 原始 Session 事件
CREATE TABLE IF NOT EXISTS memory_sources (
  memory_id   TEXT NOT NULL,
  content_rev INTEGER NOT NULL CHECK (content_rev >= 1), -- 该证据支持的正文修订
  session_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,      -- SessionEvent.seq
  kind        TEXT NOT NULL,         -- 'user_msg','assistant_msg','tool_result','compaction','manual'
  excerpt     TEXT,                  -- 证据片段，最多 300 字符
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (memory_id, content_rev, session_id, seq)
);

-- 关系：supersedes / derived_from / contradicts / related
CREATE TABLE IF NOT EXISTS memory_relations (
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  rel        TEXT NOT NULL CHECK (rel IN ('supersedes','derived_from','contradicts','related')),
  metadata   TEXT NOT NULL DEFAULT '{}', -- JSON；derived_from 必须为 {"sources":[{"memory_id":...,"content_rev":...,"hash":...}]}
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, rel)
);

-- 版本快照：每次修改 memories 前，把旧行的完整 JSON 存到这里
CREATE TABLE IF NOT EXISTS memory_versions (
  memory_id  TEXT NOT NULL,
  version    INTEGER NOT NULL,
  snapshot   TEXT NOT NULL,          -- JSON.stringify(旧行，不含 embedding)
  reason     TEXT NOT NULL,          -- 'merge','supersede','edit','utility','status','rollback','repair'
  actor      TEXT NOT NULL,          -- 'rule','llm','user','lab','maintenance'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, version)
);

-- 原始事件暂存（只存抽取需要的精简信息，不存全文）
CREATE TABLE IF NOT EXISTS raw_events (
  session_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  type         TEXT NOT NULL,        -- SessionEvent.type
  time         INTEGER NOT NULL,
  turn         INTEGER,
  role         TEXT,                 -- 'user','assistant','tool','system','compaction'
  origin_kind  TEXT NOT NULL CHECK (origin_kind IN ('user','assistant','tool','web','system')),
  tool_name    TEXT,
  is_error     INTEGER NOT NULL DEFAULT 0,
  text         TEXT,                 -- 截断：用户消息 2000 字符，其余 800 字符
  processed    INTEGER NOT NULL DEFAULT 0,  -- 0 未处理, 1 已被规则处理, 2 已被 LLM 蒸馏
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS ix_raw_proc ON raw_events(processed, time);

-- 注入日志：用于增量注入和效用归因
CREATE TABLE IF NOT EXISTS injections (
  session_id  TEXT NOT NULL,
  turn        INTEGER NOT NULL,
  memory_id   TEXT NOT NULL,
  content_rev INTEGER NOT NULL CHECK (typeof(content_rev)='integer' AND content_rev >= 1),
  layer       TEXT NOT NULL CHECK (layer IN ('stable','dynamic','tool')),
  rank        INTEGER NOT NULL,
  tokens      INTEGER NOT NULL,
  form        TEXT NOT NULL CHECK (form IN ('content','summary')),
  strategy_v  INTEGER NOT NULL,
  outcome     REAL,                  -- 由 outcome.ts 回填，取值 -1..1
  used        INTEGER,               -- 1 表示归因判定为"真正被使用"
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn, memory_id, content_rev, layer)
);

-- 每个 turn 的在线指标
CREATE TABLE IF NOT EXISTS turn_metrics (
  session_id   TEXT NOT NULL,
  turn         INTEGER NOT NULL,
  query_tokens INTEGER,
  candidates   INTEGER,
  injected     INTEGER,
  inject_tokens INTEGER,
  latency_ms   REAL,
  outcome      REAL,
  correction   INTEGER NOT NULL DEFAULT 0,
  strategy_v   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn)
);

-- 检索策略版本
CREATE TABLE IF NOT EXISTS strategies (
  version     INTEGER PRIMARY KEY,
  config      TEXT NOT NULL,         -- StrategyConfig 的 JSON
  status      TEXT NOT NULL CHECK (status IN ('active','retired','candidate','rejected')),
  parent      INTEGER,
  eval_report TEXT,                  -- JSON：各项指标
  created_at  INTEGER NOT NULL,
  promoted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_strategies_one_active
  ON strategies(status) WHERE status = 'active';

-- 回归用例（自动采集 + 人工编写）
CREATE TABLE IF NOT EXISTS eval_cases (
  id        TEXT PRIMARY KEY,
  suite     TEXT NOT NULL,           -- factual|temporal|procedural|failure|implicit|harvested
  payload   TEXT NOT NULL,           -- JSON，格式见 §8
  critical  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- 后台任务
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,         -- distill|reflect|consolidate|maintain|evolve|repair|backfill
  key         TEXT NOT NULL,         -- 去重键；所有任务都必须生成稳定 key，例如 'reflect:<session>:<turn>'
  payload     TEXT,
  status      TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','skipped')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER,
  next_eligible_at INTEGER NOT NULL DEFAULT 0, -- 退避/次日配额恢复的持久时刻
  UNIQUE (kind, key)
);

-- 离线 LLM 账本
CREATE TABLE IF NOT EXISTS llm_ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day        TEXT NOT NULL,          -- 'YYYY-MM-DD'（本地时区）
  job_kind   TEXT NOT NULL,
  model      TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  reserved_tokens INTEGER NOT NULL,  -- 输入上界 + provider 强制的最大输出
  in_tokens  INTEGER NOT NULL DEFAULT 0,
  out_tokens INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL CHECK (status IN
              ('reserved','succeeded','failed','unknown','cancelled')),
  ok         INTEGER NOT NULL DEFAULT 0,
  note       TEXT,                   -- 仅脱敏诊断；禁止原始响应/密钥
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_ledger_day ON llm_ledger(day);

-- 修复提案：LLM 只能提议，用户批准前不修改原记忆
CREATE TABLE IF NOT EXISTS repair_proposals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL UNIQUE,
  memory_id   TEXT NOT NULL,
  content_rev INTEGER NOT NULL CHECK (typeof(content_rev)='integer' AND content_rev >= 1),     -- 提案绑定的原正文版本
  action      TEXT NOT NULL CHECK (action IN ('revise','split','invalidate')),
  candidate_ids TEXT NOT NULL,     -- JSON 数组；invalidate 为 []
  reason      TEXT NOT NULL,        -- 已脱敏
  status      TEXT NOT NULL CHECK (status IN ('candidate','approved','rejected')),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,     -- created_at + 固定 30 天；过期不可批准
  approved_at INTEGER,
  approved_by TEXT
);

-- 工具失败签名统计（规则 R4 使用）
CREATE TABLE IF NOT EXISTS failure_sigs (
  sig          TEXT NOT NULL,        -- tool_name + ':' + 规范化后的错误文本（§5.7 R4）
  workspace_id TEXT NOT NULL,
  count        INTEGER NOT NULL,
  sessions     TEXT NOT NULL,        -- JSON 数组，最多保留 20 个 session_id
  last_seq_ref TEXT,                 -- 最近一次的 'session_id:seq'
  memory_id    TEXT,                 -- 已经生成的 failure 记忆 id
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (sig, workspace_id)
);
```

**`002_review_fixes.sql` 迁移要点（已有 v1.0 数据库）：** 在临时副本中重建需要新增非空列的表：为 `memory_sources` 增加非空 `content_rev`（历史来源回填为当时可验证的正文修订；无法确定的来源随对应记忆降为 candidate 或脱离新版本证据），为 `memory_relations` 增加 `metadata` JSON（旧关系填 `{}`），为 `repair_proposals` 增加 `expires_at`（存量 candidate 按 `created_at + 30 天` 计算，已过期的不可批准），并将 `jobs.key` 的 NULL 行阻断迁移（不能猜测历史任务的幂等键）。重建完成后先验证 `strategies` 至多一个 `active`；若存在多个 active，迁移必须报告并停止，不能静默择优，然后创建 `ux_strategies_one_active`。全部校验通过后原子替换，不能直接改写已执行的 `001_init.sql`。

---

## §5 核心算法规格

本节所有函数都是**纯函数或只依赖 db**，必须有单元测试。**函数签名就是接口约定，不要改名。**

### 5.1 文本切分 `src/core/text.ts`

```ts
export function normalize(s: string): string
// 1) s.normalize('NFKC')  2) 转小写  3) 连续空白折叠成一个空格  4) 去掉首尾空白

export function segment(s: string): string[]
// 先 NFKC + 折叠空白，保留大小写扫描；每个最终 token 才转小写。
// 不得先调用会丢失驼峰边界的 normalize。输出保持原始顺序，不去重：
// A. 中日韩字符段（正则 /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/u）：
//    长度为 1 → 输出这个字；长度 ≥ 2 → 输出所有重叠的二元组。
//    例："数据库迁移" → ["数据","据库","库迁","迁移"]
// B. 非 CJK 单词段：按 Unicode code point 扫描 L/N/_ 与 . - / @ :；
//    遇到 A 中的字符必须结束当前段，不能让 \p{L} 吞掉相邻中文。
//    1) 去掉末尾的 . - / : 字符后，输出整段的小写形式（例如 "src/dsh/pre-step.ts"）
//    2) 如果整段包含 / . - _ @ : 中的任意字符，再按这些字符拆开，输出每个长度 ≥ 2 的部分
//    3) 每个部分在保留大小写的原文上拆驼峰/缩写：
//       先 /([A-Z]+)([A-Z][a-z])/g，再 /([a-z0-9])([A-Z])/g 插空格；
//       "sessionListener" → "session","listener"；"HTTPServer" → "http","server"。
//       子词转小写后输出，长度必须 ≥ 2；整段与子词相同不重复输出。
// C. 其他字符：丢弃
// D. 停用词：丢弃在 STOPWORDS 集合里的 token
//    （中文例如：的了是在我你他她它这那就也都和与或但吗呢吧啊；英文例如：the a an is are to of in on for and or but with this that it be）
// E. 长度超过 64 的 token：截断到 64

export function ftsText(s: string): string        // segment(s).join(' ')
export function tokenSet(s: string): Set<string>  // new Set(segment(s))
export function jaccard(a: Set<string>, b: Set<string>): number  // 两个集合都为空时返回 0
export function contentHash(type: string, content: string): string
// sha256(type + '|' + NFKC/折叠空白/trim 后的 content)，保留大小写；
// 前 32 位十六进制。检索可忽略大小写，但代码/路径事实去重不能忽略。

export function extractEntities(s: string): string[]
// 依次用下面的正则提取，结果规范化（转小写、反斜杠替换成 /）后去重：
// 1. 文件路径：/(?:[a-zA-Z]:)?[\w.\-]*[\/\\][\w.\-\/\\]+\.\w{1,8}/g  以及  /\b[\w\-]+\.(ts|tsx|js|mjs|cjs|py|json|ya?ml|toml|md|sql|rs|go|java|cs|cpp|h)\b/g
// 2. 包名：/@[\w\-]+\/[\w\-.]+/g
// 3. 反引号包裹的代码：/`([^`\n]{2,60})`/g（取第 1 个分组）
// 4. 错误码/常量：/\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/g  以及  /\b(?:E|ERR|TS)\d{3,5}\b/g
// 5. 驼峰/帕斯卡标识符：/\b[a-z]+[A-Z][A-Za-z0-9]+\b/g  以及  /\b[A-Z][a-z]+[A-Z][A-Za-z0-9]+\b/g
// 6. 主机名：/\b(?:[a-z0-9\-]+\.)+(?:com|cn|io|ai|dev|org|net|xyz)\b/gi
// 最多返回 cfg.maxEntitiesPerText（默认 16）个
```

**必测用例（写进 `test/core/text.test.ts`）：**
- `segment("项目使用PostgreSQL数据库")` 包含 `"项目"`, `"使用"`, `"postgresql"`, `"数据"`, `"据库"`
- `segment("修改 src/dsh/pre-step.ts 里的 sessionListener")` 包含 `"src/dsh/pre-step.ts"`, `"pre"`, `"step"`, `"session"`, `"listener"`, `"sessionlistener"`
- `extractEntities("报错 ERR_MODULE_NOT_FOUND 在 @deepseek-ai/dsh-agent")` 包含 `"err_module_not_found"`, `"@deepseek-ai/dsh-agent"`
- `segment("HTTPServer")` 包含 `"httpserver"`, `"http"`, `"server"`
- `jaccard(new Set(["a","b","c"]), new Set(["a","b","d"]))` 等于 0.5
- `jaccard(tokenSet("a b c"), tokenSet("a b d"))` 等于 `1/3`（`a` 是停用词）
- `segment("项目使用PostgreSQL数据库")` 不得包含跨中英文边界的单词 token

### 5.2 Token 估算 `src/core/tokens.ts`

```ts
export function estimateTokens(s: string): number
// cjk  = 中日韩字符数（与 5.1-A 使用同一个正则）
// rest = 去掉 cjk 字符和空白后剩下的字符数
// return Math.ceil(cjk * 0.75 + rest / 3.2) + 1
export function budgetTokens(s: string): number
// 已验证的真实 tokenizer；或已验证的 UTF-8 字节上界；用于硬预算
```

这个函数是装箱排序和统计用的近似值，**不是任意模型的 token 上界**。另提供 `budgetTokens(s)`：优先使用已验证、与当前 provider/model 一致的真实 tokenizer；否则使用经 M0/M3 验证的字节级 tokenizer 上界 `Buffer.byteLength(s, 'utf8')`，并计入消息封装开销。不能验证上界时禁止声称真实 token 硬上限；离线请求不发送，在线记忆注入降级为空。最终注入限制按完整渲染块的 `budgetTokens` 计算，ledger 按完整请求的输入上界计费，不能复用近似的 `estimateTokens`。

### 5.3 Scope `src/core/scope.ts`

```ts
export function workspaceId(cwd: string): string
// 1) path.resolve(cwd)  2) Windows 下转小写  3) 反斜杠替换成 /  4) 去掉末尾的 /
// 5) sha256 后取前 16 位十六进制
export function scopeFilterSQL(ctx: {workspaceId: string; sessionId: string}): {sql: string; params: unknown[]}
// 返回：
// "(scope IN ('user','global') OR (scope='workspace' AND workspace_id=?) OR (scope='session' AND workspace_id=? AND session_id=?))"
// params = [workspaceId, workspaceId, sessionId]
```

**默认 scope 规则（writer 在没有显式指定 scope 时使用）：** `preference` → `user`；`meta` → `global`；其余类型 → `workspace`。
包含“本项目/这个仓库”等局部限定的 preference 使用 workspace，不提升为 user。写入、去重、槽位唯一性均使用 `scopeKey = (scope, workspace_id ?? '', session_id ?? '')`，不是只比较 scope 枚举。user/global 的两个 owner 字段必须为 NULL；workspace 的 session_id 必须为 NULL。`excludeWorkspaces` 在监听、回填、工具、检索及离线发送前统一检查。

### 5.4 查询分析 `src/retrieval/query.ts`

```ts
export interface QueryPlan {
  text: string;               // 截断到 cfg.queryMaxChars（默认 2000）
  tokens: string[];           // 对 text 执行 segment 后去重，最多 64 个
  contentTokens: string[];    // tokens 去除检索提示词后的集合，用于绝对相关性
  entities: string[];         // extractEntities(text)
  contextEntities: string[];  // recentToolNames，只辅助排序，不能独自证明相关
  intents: { temporal: boolean; causal: boolean; procedural: boolean; preference: boolean };
  timeRange?: { from: number; to: number };
  temporalBrowse: boolean;    // 明确要求回顾时间区间内的记录，不是仅含时间词
  preferenceBrowse: boolean;  // 明确要求列出自己的偏好
  now: number;
}
export function buildQueryPlan(input: { userText: string; recentToolNames?: string[]; now: number }): QueryPlan
```

**意图正则**（中英文都要匹配，忽略大小写）：

| 意图 | 正则 |
|---|---|
| temporal | `昨天\|今天\|前天\|上周\|上个月\|最近\|之前\|以前\|上次\|刚才\|何时\|什么时候\|几号\|\d{4}-\d{1,2}-\d{1,2}\|\d{1,2}月\d{1,2}[日号]\|yesterday\|today\|last (week\|month\|time)\|recently\|when\|before` |
| causal | `为什么\|原因\|导致\|因为\|怎么回事\|为何\|根因\|why\|because\|cause\|reason` |
| procedural | `怎么\|如何\|步骤\|流程\|修复\|解决\|报错\|错误\|失败\|异常\|部署\|配置\|安装\|how to\|how do\|fix\|error\|exception\|fail\|deploy\|install\|setup` |
| preference | `喜欢\|习惯\|偏好\|风格\|格式\|不要\|别\|prefer\|style\|format` |

`recentToolNames` 里的工具名只放进 `contextEntities`，不得伪装成用户查询的精确实体。`contentTokens` 去掉配置中的检索提示词，例如“今天/昨天/最近/怎么/如何/什么/the/how/today”；该集合的定义固定，不能由 lab 放宽。

`temporalBrowse` 仅在存在 timeRange 且查询明确包含“回顾/历史记录/做了什么/发生了什么/列出记录/history/what did/list events”等记录浏览表达时为真；“今天天气”必须为假。`preferenceBrowse` 仅识别“我的偏好有哪些/列出我的偏好/list my preferences”等表达，不能用 preference 意图正则直接代替。

**时间范围解析**（只支持下面这些写法，其余情况 `timeRange` 为 `undefined`）：今天 → 当天 0 点到现在；昨天；前天；上周 → 现在往前 7–14 天；最近/这几天 → 往前 7 天；上个月 → 往前 30–60 天；`YYYY-MM-DD` → 那一整天；`M月D日` → 今年的那一整天（如果这个日期晚于今天，就换成去年）。

### 5.5 召回通道 `src/retrieval/channels.ts`

每个通道返回 `Candidate[]`，结构为 `{ id: string; channel: ChannelName; rank: number }`，`rank` 从 1 开始。**所有通道都必须带上 scope 过滤条件。默认只召回 `status IN ('active','frozen')`**（`frozen` 状态视同 `active`，可以被召回）；当 `temporalBrowse=true` 时，temporal 通道可额外读取同一 scope 内的 `superseded` 历史记录（仍须满足时间范围和绝对相关性硬门槛），不得读取 `candidate/rejected/archived`。

| 通道 | 何时运行 | 实现 | 上限 |
|---|---|---|---|
| `lexical` | 总是运行 | `SELECT m.id FROM memory_fts f JOIN memories m ON m.rowid_=f.rowid WHERE memory_fts MATCH ? AND <scope> AND m.status IN ('active','frozen') ORDER BY bm25(memory_fts) LIMIT ?`。MATCH 表达式：取 plan.tokens 的前 32 个，每个 token 去掉 `"` 后用双引号包起来，再用 ` OR ` 连接。tokens 为空时跳过这个通道 | 50 |
| `entity` | `plan.entities.length + plan.contextEntities.length > 0` | 先 JOIN memories，并在 WHERE 中过滤 scope、active/frozen 和实体，再 GROUP BY memory_id、ORDER BY COUNT(*) DESC、LIMIT；不得先 LIMIT 再过滤其他工作区 | 30 |
| `typed` | `intents.procedural` 或 `intents.causal` 为真 | 与 lexical 相同，但增加条件 `m.type IN ('procedural','failure','episodic')` | 20 |
| `temporal` | `plan.timeRange` 不为空 | 默认 scope/status 条件；`temporalBrowse=true` 时允许额外 `m.status='superseded'`。时间条件为 `((created_at BETWEEN from AND to) OR (valid_from <= to AND (valid_to IS NULL OR valid_to >= from)))`，按 created_at 倒序；时间命中本身不保证通过 §5.6 的硬门槛 | 20 |
| `preference` | `intents.preference` 为真 | `WHERE m.type='preference' AND <scope> AND m.status IN ('active','frozen')`，按 utility 倒序 | 10 |
| `vector` | provider 非 none，且本次规范化查询的向量缓存命中、模型/维度一致 | 只用内存缓存，先过滤 `<scope>` 与 `status IN ('active','frozen')` 后计算余弦；跨循环分片检查耗时，超时跳过剩余；候选保留实际 similarity 供硬门槛判断，在线不发 HTTP | 30 |

**稳定层（`standing`）不是召回通道**，由 `prompt-section.ts` 单独处理（§5.10）。

### 5.6 融合与打分 `src/retrieval/fuse.ts`

**第一步：绝对相关性硬门槛（先过滤，再做 RRF）**

对候选正文/摘要计算 `matched = |plan.contentTokens ∩ tokenSet(memory)|`、`coverage = matched / max(1, plan.contentTokens.length)`。以下至少一项为真才保留：
- `coverage ≥ cfg.minLexicalCoverage`（默认 0.25），且 matched ≥ 2；当查询 contentTokens 只有 1 个时，允许该 token 精确命中。
- 用户查询本身的某个完整实体精确命中；contextEntities 不算。
- 缓存向量相似度 ≥ `cfg.minVectorSimilarity`（默认 0.65）。
- 明确的 temporalBrowse 且记录时间确实落在查询区间，或 preferenceBrowse 且 type=preference。

候选的置信度、utility、时间新鲜度、通道排名和“它是唯一候选”均不能代替以上证据。硬门槛配置不属于可进化参数。全部不满足时返回空数组；“今天天气”遇到当天的数据库事实必须为空。

**第二步：加权 RRF 融合**

```
fused(m) = Σ_c  W[c] / (K + rank_c(m))        // 只累加 m 出现过的通道
K = strategy.rrfK（默认 60）
W = strategy.channelWeights（默认 lexical 1.0, entity 1.2, typed 0.8, temporal 0.8, preference 0.6, vector 1.0）
relevance(m) = fused(m) / max_m fused(m)      // 仅表达相对排序；不证明绝对相关
```

**第三步：综合打分**（6 个系数存放在 `strategy.scoreWeights` 中，可以被进化）

```
score = 0.30*relevance + 0.20*confidence + 0.20*utility
      + 0.10*freshness + 0.10*consistency + 0.10*specificity

freshness   = exp(-ln2 * ageDays / halfLife[type])
              ageDays = (now - (last_used_at ?? updated_at)) / 86400000
              halfLife(天)：episodic 30, semantic 365, procedural 180, preference 365,
                           failure 90, belief 60, goal 14, meta 365
consistency = 存在 'contradicts' 关系、且关系另一端仍是 active 的记录 → 0.3；否则 1.0
specificity = min(1, 0.4 + 0.2 * min(实体数, 3))
```

**第四步：相对排名过滤** —— `relevance < strategy.minRelevance`（默认 0.15）的候选丢弃；它只限制尾部候选，不能替代第一步硬门槛。空候选时不计算 max/除法，也不注入记忆。

### 5.7 Token 预算装箱 `src/retrieval/governor.ts`

```ts
export function govern(cands: Scored[], opts: {
  budget: number;            // min(strategy.dynamicBudgetTokens, hardBudgetTokens - stableTokens)
  maxItems: number;          // 默认 6
  alreadyInjected: Set<string>; // 当前可见的 id@content_rev；含本次稳定层的引用
}): Selected[]
```

算法：
1. 去掉 `alreadyInjected` 中的 `id@content_rev`。同一 ID 的正文修订可以再次注入；稳定层本轮已包含的内容不重复进入动态层。
2. **槽位冲突：** 同一个 `(scopeKey, slot_key)` 只保留当前有效记录；数据库唯一索引保证 active/frozen 不重复。发现损坏数据时按 valid_from、updated_at、id 确定顺序，并入队一致性检查，不跨不同 scopeKey 静默吞条目。
3. **去重：** 仅规范化正文 hash 相同的候选去重。Jaccard 高但 hash 不同只能影响排序，不能删除包含不同端口、版本、路径或否定词的事实。
4. 计算 `vpt = score / max(token_cost, 30)`。
5. 先放入 score 最高的那一条（只要放得下）；然后按 vpt 从高到低贪心装箱：
   - 剩余预算放得下 `content` → 以 `form='content'` 放入；
   - 否则，放得下 `summary` → 以 `form='summary'` 放入（渲染时附带 `expand` 指针）；
   - 否则跳过；
   - 放满 `maxItems` 条后停止。
6. `tokens + 12` 和块开销 40 只作预选估算；每次放入/摘要替换后，对**完整实际渲染块**计算 budgetTokens。超出 budget 时撤掉最低价值项重算；稳定层实际 tokens + 动态层实际 tokens 必须 ≤ hardBudgetTokens。不足以放入块头时返回空字符串，不保留空 memory_context。

### 5.8 写入流水线 `src/core/writer.ts`

```ts
export interface CandidateInput {
  type: MemoryType; content: string; summary?: string; slot_key?: string | null;
  scope?: Scope; workspaceId?: string; sessionId?: string;
  source_kind: SourceKind; confidence: number;
  origin_kinds: ('user'|'assistant'|'tool'|'web'|'system')[]; // 由适配器/证据推导
  sources: { session_id: string; seq: number; kind: string; excerpt?: string; content_rev?: number }[];
  entities?: string[]; valid_from?: number | null; status?: 'candidate' | 'active';
  actor: 'rule' | 'llm' | 'user' | 'lab' | 'maintenance';
}
export type UpsertResult =
  | { action: 'inserted'; id: string }
  | { action: 'merged'; id: string }          // 与已有记录合并：追加证据、提高置信度
  | { action: 'superseded'; id: string; oldId: string }
  | { action: 'conflict_pending'; id: string; withId: string }
  | { action: 'rejected'; reason: string };
export function upsertCandidate(db: Db, c: CandidateInput, now: number): UpsertResult
```

**整个函数在一个事务内完成。** 步骤如下：

0. **校验、隐私与 owner：** content 去首尾空白，经 §5.18 扫描，敏感/无法安全处理的条目拒绝。scopeKey 合法、sources 非空、confidence 有限且在 [0,1]；origin_kinds 从已验证证据重算，不能由模型传入决定。超过正文/摘要上限返回 rejected，不按比例截掉事实尾部。summary 缺失时生成首句，再校验。
1. **计算可信状态：** 只有真实、显式用户记忆事件（非任意 user 角色的插件消息）可以由规则写入 active，记录 approved_at/approved_by。source_kind=user 只能由该受信任适配路径赋值，LLM 不得伪造。其他新输入一律 candidate，即使 c.status='active'。包含 tool/web 的未批准条目 confidence ≤ 0.5；LLM 自评先乘 0.8，再施加来源上限。
2. **先检查槽位，不让相似度吞掉变化：** slot_key 非空时，按完整 scopeKey 查当前 active/frozen。hash 不同时，新输入为 candidate → 插入候选和 contradicts，**旧记录保持原状**。显式用户新值也不能覆盖 frozen，需先由用户 unfreeze；正常用户更新才允许在同事务内 supersede 旧值并激活新值。历史值 valid_from 早于当前值时保留为历史 superseded，不反向覆盖当前事实。
3. **精确去重：** 同 type、scopeKey、slot_key（含 NULL）且 hash 相同才 merge。证据按主键幂等追加；同一证据重复入队不提高 confidence。跨 session 本身不晋升。未批准记录可用 noisy-or 聚合独立证据，但合并后重施 ≤0.5 的 tool/web 上限；不可信新证据不得抬高已有 active/frozen 的 confidence。当前 candidate 遇到同内容的真实显式用户确认，按第 2 步检查槽位后才可激活并记审批。
4. **近似匹配仅供复核：** 同 type、scopeKey 内 lexical 前 5 条若 jaccard ≥ cfg.dupJaccard，只建立 related 关系/提示 pending；**hash 不同绝不自动 merge**，不同版本、数字、路径和否定内容分别保留。
5. **插入及审批：** 生成 id、content_rev=1，维护 memories、FTS、entities、按该正文修订绑定的 sources 与关系。新候选的来源默认绑定 `content_rev=1`；同内容 merge 将证据绑定当前修订；edit/rollback 递增正文修订并保留旧修订的证据，不把旧修订证据静默当作新正文的证明。`/memory approve <id>` 调用独立 `approveCandidate`：确认真实用户操作、范围、有效时间和全部内容，重新检查槽位与 frozen；若需替换当前值，必须显示差异并显式确认，在同一事务内 supersede + activate。唯一索引冲突时整事务回滚。
6. **事务提交后：** 使向量/只读缓存失效；任何影响稳定层选择或正文的修改均标脏。只有 content/summary 实际变化才递增 content_rev，merge 证据、utility、pin 和状态变化不冒充正文修订。

普通 approveCandidate 必须拒绝关联未决 repair_proposals 的候选，只能经 approve-repair 的目标 content_rev 校验；不能通过单独批准某个 split 子候选绕过整个提案的原子性。

**其他写操作：**
`setStatus` 不得成为批准旁路；candidate→active 只能走 approveCandidate。`editContent`、`forget`、`rollback`、`freeze/unfreeze` 只接受真实用户命令授权；LLM/repair/lab 不得直接改 user、approved 或 frozen 正文/状态。维护器仅可按 §5.15 执行冷归档、候选过期与自动 pin，不能修改正文、晋升或绕过 frozen；手动 pin 标识单独保存在 meta，维护器不得覆盖。非 utility 的修改写版本快照；内容编辑/rollback 同事务重建 FTS/entities、清空旧 embedding，并使用递增的当前 content_rev，不恢复过期计数。rollback 若触发活跃槽位冲突则要求用户明确解决，不能直接覆盖整个旧 JSON。forget 改 archived；purge 需要二次确认并事务清理关联表。`applyUtility`、使用计数及 last_repair_at 仅更新统计字段，不写快照、不改变审批/status/content_rev；反馈也不能晋升。

### 5.9 结果判定与效用更新 `src/evolution/outcome.ts`

在 `agent/turn-stopping` 时调用（只异步入队，不阻塞），以及在**下一个 turn 的第一条用户消息到达时**调用（用来判断用户是否在纠正上一轮）。

**turn 结果 r（取值 -1..1）：**

| 信号 | r |
|---|---|
| 下一条用户消息匹配纠正正则 `不对\|错了\|不是这样\|搞错\|不行\|没用\|还是不行\|重来\|wrong\|incorrect\|doesn't work\|not what` | -1 |
| 本 turn 最后一个工具结果 `is_error=1`，并且之后没有成功的工具调用 | -0.6 |
| 下一条用户消息匹配肯定正则 `好的\|可以\|谢谢\|完美\|成功了\|解决了\|不错\|works\|thanks\|great\|perfect\|lgtm` | +1 |
| 模型调用了 `memory_feedback({id,contentRev,helpful})` | 仅当 `contentRev` 与本轮实际引用一致时，对该条修订直接 ±1（覆盖下面的归因）；缺失或过期修订拒绝且不更新 |
| 以上都不满足，并且用户继续提出了新任务 | +0.3 |
| session 就此结束、没有下一条消息 | 0（不更新） |

**归因（"是否真正被使用"）：** 对本 turn 注入的每条记忆 m，令 `A` = 本 turn 所有 assistant 文本 + 所有工具调用参数的 tokenSet。
`used = jaccard(tokenSet(m.content), A) ≥ 0.08` **或** `m` 的任一实体出现在 `A` 中。
权重：`w = used ? 1.0 : 0.2`。

**更新：**
```
target  = (r + 1) / 2
utility = utility + cfg.utilityLR(0.1) * w * (target - utility)
r >  0.5 且 used → success_count += 1
r < -0.5 且 used → fail_count += 1
injections.outcome = r；injections.used = used
```
**纠正事件（r = -1）还要额外**入队一个 `reflect` 任务，key 为 `reflect:<session>:<turn>`（同一个 turn 只会入队一次，满足原设计中"深度反思冷却"的要求）。

结果是启发式信号，不是事实审批。turn-stopping 只保存待判定快照，下一条真实用户消息到达后才最终应用；session 结束且无后续反馈时不更新。按 `(session,turn,memory_id,content_rev)` 合并 stable/dynamic/tool 归因，同条记忆只更新一次；CAS/事务保证重复队列事件不重复奖惩。显式 memory_feedback 必须绑定本轮 `content_rev`，对该引用优先并幂等，正文已修订或引用未出现在本轮时拒绝，后续自动归因不能再覆盖。成功计数用于候选复核/聚类，不授权记忆晋升。

### 5.10 稳定层 `src/dsh/prompt-section.ts` + `src/retrieval/render.ts`

- **内容：** 当前 scope 内 `pinned=1` 且 status 为 active/frozen 的记录，**按 id 排序**（保证顺序稳定，才能命中前缀缓存），总量不超过 `cfg.stableBudgetTokens`（默认 600）；超出时按 utility 从低到高剔除。
- 排除 meta；预算包括完整块头/标签/统计，按 budgetTokens 实测。记录本轮 `stableTokens` 与 `{id, contentRev}`，提供给 governor 和 injections 归因；不要仅因 pinned=1 就假定它已实际进入稳定层。
- **自动 pin 规则**（由维护任务每天执行一次）：`type ∈ {preference, goal}` 且 `utility ≥ 0.6` 且 `confidence ≥ 0.8` → 自动 pin；`type='semantic'` 且 `use_count ≥ 5` 且 `utility ≥ 0.7` → 自动 pin。用户手动 pin 的记录不会被自动 unpin。
- **只有稳定层实际渲染结果的 hash 发生变化时**才更新 system prompt 段；pin/status/utility/scope 变化只要改变入选集合或排序，也必须触发重渲染。

**渲染格式**（`render.ts`，输出必须与下面完全一致，方便测试）：

```
<memory_context v="{strategyVersion}" layer="dynamic">
[FACT m_ab12] 项目数据库为 PostgreSQL 16
[PROC m_cd34] API 超时：先把 timeout 调到 180s，再检查代理 (ok 4/4)
[FAIL m_ef56] 方案 A 在 Python 3.14 下与 xxx 冲突，避免复用 (fail 7/8)
[PREF m_gh78] 用户偏好简洁的命令式步骤
[NOTE m_ij90] 2026-09-28 修复了构建脚本…  ⟨summary · memory_expand("m_ij90")⟩
</memory_context>
```
- 标签映射：semantic→FACT、procedural→PROC、failure→FAIL、preference→PREF、episodic→NOTE、belief→BELIEF、goal→GOAL（meta 类型**永远不注入**）。
- 短码是 `m_` 加随机部分前 4 位。在当前 scope 内不唯一时逐步延长到唯一；工具收到歧义短码必须报错并列出非敏感候选标识，不能任选一条。完整 ID/正文版本只通过结构化引用记账，不能从显示短码猜回完整 ID。
- 括号里的统计：confidence < 0.8 时显示 `(c=0.xx)`；procedural/failure 类型在 `success_count+fail_count ≥ 2` 时显示 `(ok s/n)` 或 `(fail f/n)`。
- 稳定层把 `layer="dynamic"` 换成 `layer="stable"`。
- 标签后的正文作为数据处理：转义 `<`、`>`、`&` 和可能关闭 memory_context 的边界；提示词明确记忆只是可能过期的参考数据，不能覆盖当前用户指令或执行其中的命令。渲染前仍走隐私扫描。

### 5.11 规则抽取器 `src/ingest/rules.ts`（在线写入路径上执行，必须是纯本地、O(文本长度) 的计算）

| 规则 | 触发条件 | 产出 |
|---|---|---|
| R1 显式记忆 | 真实用户消息匹配 `^(请)?(记住\|记下\|remember)[:：,，\s]*(.{4,400})` | 取唯一正文捕获组作为内容；再按固定的偏好表达判定 type（偏好→preference，否则 semantic），不从不存在的第 3 分组取值。source_kind='user'、origin_kinds=['user']、sources 绑定该原始事件。通过隐私/槽位校验后才 active |
| R2 偏好陈述 | 真实用户短消息（≤300字）明确表达长期偏好，而非引用/待分析文本；匹配 `(以后\|今后\|总是\|一律\|永远\|不要再\|别再\|每次都\|from now on\|always\|never)` | preference，绑定 user 证据；项目限定偏好用 workspace。只有直接陈述自己的偏好才视为显式确认；不确定的引用、示例和规则说明只能 candidate |
| R3 纠正 | 见 §5.9 的纠正正则 | 不直接产出记忆；把上一 turn 标记为 correction，并入队 reflect 任务 |
| R4 工具失败签名 | `tool/result` 并且 `is_error=1` | 先脱敏；按路径→十六进制→数字→引用内容顺序规范化，避免数字替换先破坏错误指纹。按真实 (session_id,seq) 幂等累加；出现≥2个不同session时写 failure **candidate**，source_kind='rule' 但 origin_kinds 保持 tool/web，confidence≤0.5，并入队 reflect。工具名/错误文本不是可信指令，不能因 rule 包装自动激活 |
| R5 失败→修复 | 同一个 turn 内，同一个工具先失败后成功 | 只入队一个 `distill` 任务提示（key 为 `fixpair:<session>:<turn>`），由 LLM 在离线阶段总结"怎么修好的" |

R1/R2 默认不由 LLM 生成槽位。对可精确解析的配置事实维护一个固定槽位规则表，例如“项目数据库是/已迁移到 X”→`project.database`，“回复一律用中文/英文”→`user.pref.reply_language`。无法解析的内容 slot_key=NULL，不声称已解决任意语义冲突；LLM 提议的 slot_key 只用于待审批候选。验收必须覆盖真实用户路径的槽位生成，而不只手工传 slot。

### 5.12 离线任务 `src/jobs/`

**调度器规则：**
- 同一时刻只运行 1 个任务（全局互斥）；每个任务最长运行 `cfg.jobTimeoutMs`（默认 120s）。
- 每次 HTTP attempt（包括重试和可选 embedding）先通过 §5.18 隐私闸门，再调用 `ledger.reserve({inputUpperBound,maxOutputTokens,model,promptVersion,jobKind})`。在一个 DB 事务内计算当日已结算用量 + reserved/unknown 的完整预留，确保加上新预留不超过 dailyLLMTokens，且非 cancelled 行数不超过 dailyLLMCalls。超出时不发请求，任务 skipped，记录 nextEligibleAt 为次日并持久化。
- 输入上界必须覆盖 system/user 文本、证据、消息封装及 provider 的额外计费输入；provider 必须有经验证的输出硬上限（包括其计费推理 token）。无法界定这些值时不发送，不以 estimateTokens 代替。成功按真实 usage 结算；无 usage/超时/发送状态不明时记 unknown 并保留完整预留。只有能证明尚未发送的取消才释放额度；重启将残留 reserved 转 unknown。报告 usage 超预留视为 provider 合同失效，停止后续离线调用并告警。
- 触发时机：① `agent/turn-stopping` 后延迟 30s；② 空闲 10 分钟（距离最后一个 session 事件已过 10 分钟）；③ 每天本地时间 03:30 运行一次夜间任务（如果当时 DSH 没有运行，下次启动 5 分钟后补跑）。
- 失败重试：**同一输入全局最多 2 次额外 HTTP attempt（总计最多 3 次发送）**，不因任务重启或“每任务最多 3 次执行”而重新获得额度；重试计数按输入指纹持久化在 job payload/ledger 中，跨重启继续累计。仅瞬时网络故障可重试，退避 1 分钟→10 分钟，并受总任务 120s 期限/每日额度约束；下一次请求超时取 min(90s,剩余时间)。解析/schema/证据错误不重试同一输入，隐私拒绝等待用户处理。超时必须 AbortController 中止请求并等待本 runner 收敛，不能让失控 runner 与下一任务并发写库。重启将 running 任务恢复为待核查 failed，确认未执行写入后才按该输入已持久化的剩余次数重试。

| kind | 触发 | 是否调用 LLM | 做什么 |
|---|---|---|---|
| `distill` | 某 session 未处理事件≥40；空闲时处理不足40的尾批；或R5 | 是（附录 B-1） | 按 seq 连续选批、一次只处理一个session，渲染≤6000输入预算；产0–5候选。仅将本次实际发送并成功解析的事件置 processed=2；过预算未发送的早期事件留给后续批，不能丢掉后全部标处理 |
| `reflect` | 纠正事件，或 R4 产出新的 failure 记忆 | 是（附录 B-2） | 根据失败/纠正前后的事件，产出 1 条 failure 或 procedural 记忆 + 可选的 1 条 belief |
| `consolidate` | 夜间 | 部分调用（附录 B-3） | §5.14 |
| `maintain` | 夜间 | 否 | §5.15 |
| `evolve` | 夜间，并且距上次运行 ≥ 3 天，并且新增 harvested 用例 ≥ 10 条 | 否 | §5.16 |
| `repair` | M6 | 是（附录 B-4） | §5.17 |
| `backfill` | 只能通过命令 `/memory backfill` 手动触发 | 否（只写 raw_events + 规则抽取）；之后由 distill 慢慢消化 | §7 M2-T4 |

### 5.13 紧凑转写稿（distill / reflect 的输入）

**只复用已提交、实际替换了历史的 compaction 摘要。** start/end/error 不是摘要也不提供覆盖证明。用附录 A 的 replacement surface 区间确定覆盖事件；脱敏后的摘要作为唯一证据文本发送，不把未发送的旧原文当作 quote 的校验依据。

所有任务先构建**本次请求专用 evidenceLedger**：按 `(time,session_id,original_seq)` 排序，将实际发送的脱敏证据赋唯一 request-local seq=1..N，冻结映射 `seq → {session_id, original_seq, redacted_text, origin_kinds, time}`。跨 session 的原始 seq 不能比较新旧，也不能作为全局证据 ID。

转写稿连同 system、上下文、模板和消息封装总输入不超过 cfg.distillMaxInputTokens（默认6000，按 §5.2 上界或真实 tokenizer）；从最早事件开始选连续可容纳的一批，不是丢弃早期事件：
```
[U#seq] 用户消息（≤500 字，seq 为 request-local 编号）
[A#seq] 助手消息（≤300 字）
[T#seq] tool=<name> ok|ERROR: <结果前 200 字>
```

片段被截断/遮罩/未发送时不能引用其隐藏原文；单事件过长按以上规则截断并标明，仅可见片段进 evidenceLedger。成功的候选写入、事件 processed 和批次 watermark 同事务提交；解析失败不推进 watermark，空 items 是成功 no-op。watermark 写 meta（key=`distill:<sessionId>`），processed/来源主键仍是幂等依据。B-3 发送聚类的内容及可校验 sources excerpt，B-4 发送目标记忆及其证据，均使用相同的 request-local 映射。

### 5.14 巩固 `consolidator.ts`

1. **聚类：** 在同一个 workspace 内，取 type ∈ {episodic, failure} 且 status 为 active 的记录，按"共享 ≥ 1 个实体 且 jaccard ≥ 0.35"建图，取连通分量。组装请求时冻结每个源记录的 `{id, content_rev, hash, content, summary, status, valid_from}` 快照；发送前和提交候选前都重新校验这些字段未变化，任一源发生变化就丢弃本次响应并重新聚类，不使用过期正文。
2. 分量大小≥3，且 injections 中存在≥3个不同session的 `used=1 AND outcome>0.5` 成功证据（单一 session 重复成功不能凑数）→按附录B-3产0–1条 procedural **candidate**。其 sources 必须可映射到实际发送的来源证据，并在 `derived_from` 中保存源 `memory_id/content_rev/hash` 快照；来源正文/status/utility 不因未批准提案而改变。用户审批后才成为可用技能。
3. 分量大小≥5但独立成功不足→不调用LLM；只提示相似关系，不能用jaccard自动合并不同hash事实。候选重复出现仍不晋升。
4. 每晚最多处理 cfg.consolidateMaxClusters（默认5）个分量；聚类输入/证据哈希作去重键，未增加证据时不每晚重复花费。所有调用逐请求预留预算。

### 5.15 维护 `maintenance.ts`

- **冷记忆归档：** 仅active且last_used_at（为空时created_at）早于coldDays、utility<0.35、pinned=0时经writer改archived；不把superseded改成archived破坏历史链，frozen永远不自动归档。
- **候选过期：** `candidate` 状态超过 30 天仍未晋升 → `rejected`。`repair_proposals` 另按 `expires_at`（固定为创建后 30 天）过期；过期提案只能标记为 `rejected`，不能批准，也不能改变原记忆。
- **自动 pin**（§5.10）。
- **FTS 一致性检查：** 检查rowid一一对应且fts_text与当前content/summary预切分结果相同，不能只比较count；不一致经writer事务重建。正常edit/rollback不得等夜间修复索引。
- **备份：** 唯一目标名memory-YYYYMMDD-HHmmss.db，先导出临时文件、校验后原子改名，只保留最近7份，不覆盖同名文件；sql.js导出同样遵守。备份只包含脱敏内容。
- **清理：** 删除 30 天前已处理的 raw_events（processed=2）；删除 90 天前的 turn_metrics。

### 5.16 检索策略进化 `lab.ts`（EvolveMem 精简版）

```ts
interface StrategyConfig {
  rrfK: number;
  channelWeights: Record<ChannelName, number>;
  scoreWeights: { relevance: number; confidence: number; utility: number; freshness: number; consistency: number; specificity: number };
  minRelevance: number;
  dynamicBudgetTokens: number;
  maxItems: number;
}
```

1. **基线：** 用当前 active 策略在全部 eval_cases 上跑一遍 `eval/runner`，得到指标 `M0`（§8）。
2. **变异：** 生成 cfg.labCandidates（默认8）个候选：数值参数乘以 `1+U(-s,s)`，s默认0.2，记录随机种子以便复现。scoreWeights 重新归一化且全部非负；minRelevance 限制在[0.05,0.4]；`dynamicCap = hardBudgetTokens - stableBudgetTokens`，动态预算限制在 `[min(800,dynamicCap), dynamicCap]`。maxItems 取整数并限制[1,cfg.maxLabItems]，其余参数校验有限值。隐私、审批、绝对相关性门槛及硬预算不参与变异。
3. **评估：** 每个候选跑一遍 → 得到 `Mi`。
4. **晋升条件（必须全部满足）：**
   - `Mi.recallAtInject ≥ M0.recallAtInject + 0.02`
   - `Mi.avgInjectTokens ≤ M0.avgInjectTokens * 1.10`
   - 每个 critical 用例都满足 `M0.caseResults[id].pass ⇒ Mi.caseResults[id].pass`；基线已通过的身份必须保持，不能只比较 criticalPass 总数
   - `Mi.excludeViolations ≤ M0.excludeViolations`
   - `Mi.emptyPrecision ≥ max(M0.emptyPrecision, 0.8)`；每条 maxTokens/expectStable/硬预算约束全部通过，不能靠平均值掩盖超预算
5. 满足条件的候选里取 recallAtInject 最高的一个；写 strategies 前再次以**当前配置**校验预算及硬约束，在同事务内晋升并退休旧策略。每次 recall 仍按稳定层实际开销取 min 限额；缓存里的旧策略也不能越过新配置。
6. **停滞探索：** 连续 3 次进化都没有晋升 → 下一次把 s 提高到 0.4（只用一次）。
7. **哨兵监控与自动回滚：** 新策略上线后，比较晋升后最近 50 个 turn 与晋升前最近 50 个 turn 的纠正率（`turn_metrics.correction`）。`新纠正率 > 旧纠正率 + 0.05` → 自动回滚到 parent 版本，新版本标记为 `rejected`。这项检查由 maintain 任务每天执行一次。

### 5.17 查询触发修复 `repair.ts`（M6，RIME 精简版）

触发条件：当前 scope 的 active 记忆被 memory_expand 展开，且同 turn 结果 r≤-0.6；仅入队建议任务，工具失败不等于事实有错。frozen 不自动修复；同条记忆距 last_repair_at 至少 cfg.repairCooldownDays（默认7天），无同目标排队任务。last_repair_at 在实际派发请求时经 writer 更新，重启不能绕过冷却。

输入：目标 `{id,content_rev,content}`、当前查询、来源证据，经脱敏和 request-local evidenceLedger 渲染；raw_events 已清理时可用已保存且通过扫描的 sources.excerpt。没有可验证证据就 skipped，不让 LLM 猜测。

B-4 唯一输出合同为 `{action: 'keep'|'revise'|'split'|'invalidate', reason: string, items: MemoryItem[]}`，MemoryItem 使用附录 B 的 `text/evidence` 外部格式：
- keep：items=[]，成功 no-op。
- revise：恰好1条 item；split：2–3条 item。校验后只写 candidate 和 derived_from，创建绑定目标 content_rev 的 repair_proposals；原记忆保持 active，不 editContent、不 supersede。
- invalidate：items=[]，只写待确认提案，不 archive 原记忆。

用户 `/memory approve-repair <proposalId>` 查看差异后才能应用：同事务确认提案仍为 `candidate`、`expires_at > now`，目标仍 active、未 frozen、`content_rev` 未变化，并重新验证范围/槽位/证据（B-4 只能使用与目标 `content_rev` 绑定的 `memory_sources`）。revise/split 批准候选并 supersede 原记录，invalidate 归档原记录。split 的新槽位若互相冲突则拒绝应用并要求用户明确拆分，不任选条目。user 来源也必须显式批准，LLM/反馈不能授权；提案过期或 `/memory reject-repair` 不改变原记忆，过期提案可标记为 rejected 但不能再次批准。验收使用真实 B-4 合同，不再用不同枚举的 mock。

### 5.18 隐私与发送闸门 `src/core/privacy.ts`

这是确定性代码边界，不依赖提示词“不要泄露”的服从程度：
1. **记录前：** 先检查 `excludeWorkspaces`；命中时整段跳过，不记录、不回填、不召回，也不发送外部请求。未命中的工作区才对用户、助手、工具和 compaction 文本、参数、证据 excerpt 统一扫描密钥/密码/Authorization/Cookie、JWT、PEM 私钥、含凭证 URL、私有 URL、邮箱/电话等个人信息；结合结构化敏感字段名与模式检测。先扫描后截断，掩码为 `[REDACTED:<kind>]`，不保存原值、原值 hash 或含原值的诊断；无法安全处理的整段拒绝。规则抽取与在线循环必须有长度上限及无灾难回溯测试。
2. **写入前：** writer 对 content/summary/sources 再扫描；关键事实被遮罩或无法验证时 rejected，不能以残缺句子激活。failure_sigs、memory_versions、repair_proposals、导出及日志同样只能包含脱敏后的内容；备份继承此限制。
3. **发送前：** 重新扫描整个实际 HTTP 请求（system/user/上下文/证据/重试诊断），替换绝对用户目录为 `<workspace>`/相对路径，外发 workspace 使用匿名 ID，不发原 cwd。quote 仅在本次真正发送的脱敏文本中精确校验。保留原始响应以“让模型修 JSON”的重试被禁止。
4. **明确授权：** 默认 `privacy.offlineConsent=false`、allowedOfflineEndpoints=[]；配置明确同意且实际解析后的目标 endpoint 在允许列表中才可发送。即使 127.0.0.1 也可能转发到远端，不豁免。DSH LLM 服务若无法在不读取密钥的情况下确认目标，则不使用；离线学习与可选 embeddings 都走同一闸门，未授权时只做本地规则/检索/维护。backfill 不隐含上传授权。
5. **拒绝策略：** 无法确定是否含敏感数据时保守跳过并输出不含原文的告警。模式扫描不能保证识别所有未知秘密，必须保留工作区排除、明确外发授权及人工复核；验收至少断言“未授权请求数=0”“已知密钥/个人信息不在存储与 mock HTTP body 中”。

---

## §6 DSH 适配层

> ⚠️ 本节中的**接口名称和签名以 `APPENDIX-A-dsh-api.md` 为准**。下面描述的是"每个文件要做什么"，与 DSH 的具体写法无关。

### 6.1 `src/dsh/plugin.ts`（插件入口，`src/index.ts` 仅重新导出）

1. 读取并校验配置（`config.ts`）。
2. 确定数据目录（附录 A §A.1 给出 DSH 提供的方式；找不到时使用 `<dshHome>/storages/dsh-memory/`）。
3. 打开数据库，执行迁移；**如果失败，记一条 error 日志后直接返回，不注册任何监听器**（插件降级为空操作，不影响 DSH）。
4. 依次注册会话投影、session-listener、pre-step、prompt-section、turn-stopping、tools、commands、内部 scheduler；声明 agents/sessionProjections/systemPrompt/tools/commands 依赖，不使用模型可见的 ctx.jobs。
5. dispose：撤销插件监听器和各 agent 段落 → 停止调度/取消并等待当前任务 → 停止接收 ingest 并刷盘 → 关闭数据库。不能在仍有 runner 写入时关闭 DB。

### 6.2 `session-listener.ts`

- 监听 `session/event`。**签名是 `(session, event)` 两个参数**（✅ 实测：dsl-session-persistence-jsonl 的用法 `ctx.on("session/event", (session, event) => {...})`）。**回调里只做一件事：把精简后的事件推入内存队列。** 不做任何数据库操作，不做任何 await。
- 事件形状：`{ type, seq, time, data }`。`time` 是**毫秒整数**。
- 精简映射（⚠️ 这些坑全部来自真实日志实测，见附录 A §A.3.1）：
  - `user/message` → 只有 `data.source.kind==='user'` 的真实用户消息为 origin_kind=user；其他插件上下文不得触发 R1/R2。text 取 data.content 的 text 块。
  - `assistant/message` → role=assistant，text 取 `data.message.content` 里**只取 `type === 'text'` 的块**。**必须过滤掉 `type === 'reasoning'`**，否则模型的内部推理会被当成事实抽取。
  - `tool/call` → 记录 `data.name`（**工具名只在这里出现**，`tool/result` 里没有）。`data.arguments` 是 **JSON 字符串**，要先 `JSON.parse` 再截断入库。按 seq 顺序维护 `callId → name` 映射。
  - `tool/result` → role=tool，用 `data.message.toolCallId` 回连 `tool/call` 拿工具名；文本取 `data.message.content`。
  - `compaction/start/end` 仅为生命周期，不当成摘要、不清空投影。实际提交的 replacement surface 消息才携带可复用摘要，按附录 A 区间映射记录为 compaction。
  - **忽略**：`session-log-deepseek/delivery-accepted`（占真实日志约 15%，纯噪声）、`agent/inbox/spliced`、`session/title-llm-request`、`request/header`、`request/context`、`session/end-seed` 等。
- 映射后经 privacy 扫描才入队；扫描失败不入队，不在日志写原始 event。queue 每2秒或50条批量写 raw_events；只对真正新插入的行做规则抽取，统计幂等，同主键的实时/回填事件不重复累计 failure_sigs。
- **注入回声过滤（M0-T2 通过后必须做，否则记忆会自我强化）：** 本插件写在 pre-step decision 里的消息会被 DSH 以 `user/message` 原样落盘（消息类型和追加操作已由源码确认，完整 source 扩展字段仍待 M0-T2）。**只有在 M0-T2 验证 `source.kind === 'plugin'`、`plugin === 'dsh-memory'` 与 `memoryRefs` 原样持久化后，才启用对 `data.source.kind === 'plugin' && data.source.plugin === 'dsh-memory'` 的直接丢弃；探测失败则暂停动态注入并阻断该过滤路径，不能把未知形状当作回声。**
  - ✅ **这个基础形状已实测确认：** `source: { kind: 'plugin', plugin: '<名字>' }`（第一方插件 `goal` 就是这么写的，见 `dsh-session-format-v1-to-v2/lib/index.js:641`）；扩展字段是否持久化不由此推断。
  - 顺便**也要丢弃 `source.kind === 'runtime-context'`** 的 `user/message`——那是 DSH 自己的运行时快照注入，同样不是用户说的话，把它当事实抽取会污染记忆库。这是一条容易漏掉的过滤。

### 6.3 `pre-step.ts`（在线关键路径）

**注入方式已经确定：不使用 `agent.inject`，改用改写 pre-step 返回值。** 依据见本节末尾的「为什么不用 `agent.inject`」。源码已确认这条路径就是 DSH 自己的 runtime-context 走的路。

```ts
// src/dsh/pre-step.ts —— 实际要写的形状
ctx.on('agent/pre-step', async (payload, next) => {
  const decision = await next()                    // 先让其他监听器完成决策
  const t0 = Date.now()                            // 只计本插件耗时
  try {
    if (decision.kind !== 'enter') return decision  // 保持 reject 原样
    if (payload.signal.aborted) return decision
    if (!isTurnFirstStep(payload)) return decision  // 修订 R1：只在 turn 首步注入
    const userText = lastUserText(decision.messages)
    if (!userText || userText.length < 2) return decision
    const plan = buildQueryPlan({ userText, now: t0 })
    const stable = stableSnapshot(payload.agent)    // 当前 agent 实际渲染的预算/完整引用
    const visible = visibleMemoryState(payload.agent.session)
    if (!visible.ready) return decision             // 投影未就绪/旧引用无法识别时不盲注入
    const sel = recall(plan, {
      budget: Math.max(0, Math.min(strategy.dynamicBudgetTokens, cfg.hardBudgetTokens - stable.tokens)),
      alreadyInjected: new Set([...visible.keys, ...stable.keys]),
    })
    if (sel.length === 0) { recordTurnMetrics(sel, t0); return decision }
    const block = render(sel)
    const message = createUserMessage({                 // ← 用 DSH 工厂函数，不要手写对象
      content: [{ type: 'text', text: block }],
      source: {
        kind: 'plugin', plugin: 'dsh-memory',
        memoryRefs: sel.map(m => ({ id: m.id, contentRev: m.content_rev })),
      },
    })
    if (stable.tokens + budgetTokens(block) > cfg.hardBudgetTokens) return decision
    // 注入成功/使用计数由实际提交的 user/message 回调记账，不在接纳前记成功。
    return { ...decision, messages: [...decision.messages, message] }   // ← 关键：必须展开 decision
  } catch (e) {
    logger.warn('[dsh-memory] pre-step failed', e)
    return decision                              // 出错放行，绝不影响 Agent
  }
}, { prepend: true })
```

- **`{ ...decision, messages: [...] }` 不能简化成 `{ kind: 'enter', messages: [...] }`。** enter 分支还带 `startsRequestSeries` 声明（见附录 A §A.2.1），丢掉它会让下游行为改变。**返回新批次时一律用展开。**
- **必须用 `createUserMessage(...)` 构造消息，不要手写对象。** 它来自 `@deepseek-ai/dsh-llm`，内部做 `deepFreeze(structuredClone({...input, id: brandString(randomUUID())}))`——**id 由它生成，消息被冻结**（decision 的批次本来就是冻结的，手写普通对象会破坏这个不变量）。见附录 A §A.6.3。
- **消息追加在末尾，不是最前面。** 新消息跟在真实用户消息之后，模型会把它读成"关于本轮任务的补充上下文"，这正是我们想要的语义；放到最前面会和用户的原始指令争抢注意力。
- **消息的 `content` 只放一个 `text` 块。** `textOf()` 这类判定依赖"恰好一个 text 块"的形状（`dsh-agent-loop/lib/index.js:224`：`message.content.length === 1 && block?.type === 'text'`）。保持单块，行为最可预测。
- **可见引用由会话投影重建。** memoryState 使用 stateVersion=2，保存 `{messageId,seq,refs:[{id,contentRev}]}`，refs 从已提交的 `user/message.data.source.memoryRefs` 读取；`event.data.id` 是消息 UUID，绝不能作为 memory ID。普通已提交注入追加可见键 `id@contentRev`；缺少/非法 refs 的旧注入标 ready=false，在实际替换掉这些旧消息或完成可靠重建前不自动注入。短码不能补齐映射。
- **只处理真实覆盖：** replacement 事件顶层 `surfaceOp={op:'replace',startSeq,endSeq}`；仅删除 seq 落在该闭区间且被 sourceEventSeqs 引用的注入消息。sourceEventSeqs 还可能包含因果引用，不能单看交集清空。compaction start/end/error 不改变可见集合，局部替换保留区间外条目；替换消息若含有效 memoryRefs 则再加入其引用。格式无法确认时暂停自动注入并报告，M0 必须验证。

> **完整样板：`@deepseek-ai/dsh-time-context/lib/index.js` 是我们要做的事的第一方参考实现**——它同样在 pre-step 里往 decision 追加消息，同样用会话投影记账，同样用 `prepend: true`。**M2 动手前先把它读完。**
- **整段必须在 `cfg.onlineBudgetMs`（默认 150ms）内完成。** 在 recall 内部的每个通道之间检查耗时，超时就停止后续通道，只使用已经得到的结果。注入消息的构造本身可以忽略不计。
- **injections 表是归因日志，不是当前可见性的真相源。** 重启从 DSH 会话日志重折叠投影，不从历史 injections 表恢复“永远已注入”。按实际提交消息幂等记录 injections/use_count；最终 rejection 或插件异常不计成功。
- **这条路径不会产生 `agent/inbox/*` 事件**，也不会经过 inbox 的 splice 记录。日志里只会有 step/start 之后 `session.append('user/message', ...)` 产生的那一条（见下）。

#### 为什么不用 `agent.inject`（源码依据）

`AgentHandle.inject(input)` 的实现是一行（`dsh-agent-loop/lib/index.js:812`）：

```js
inject(input) { this.send(input, "next-step", false); }   // wakeup = false
```

`send()` 把它拆进 inbox 的 `next-step` 队列，而 `pre-step` 的**第一步就是把这个队列整个取走**（`lib/index.js:906`）：

```js
async preStep(target, position) {
  const claimed = this.inbox.claim(target, position.turn)   // ← 先 claim
  ...
  const decision = await this.dispatch.waterfall("agent/pre-step", { messages: claimed, ... })
}
```

**先 claim，再跑 waterfall。** 所以任何监听器在 pre-step 里调用 `inject()` 追加的消息，都已经错过本次 claim，只能等下一次边界。对**首步**注入来说这不是"延迟一步"，而是**这一步永远不会被驱逐**（首步注入的内容压根不会出现在本次请求里）。→ 方式 A 和方式 C 都排除。

**这不是我的猜测，是 DSH 自己在做的事。** runtime-context 功能的做法是在 waterfall 里往 `decision.messages` 里追加：

```js
const decision = await this.dispatch.waterfall("agent/pre-step",
  { messages: claimed, ...position, signal },
  () => Promise.resolve({
    kind: "enter",
    messages: context === void 0 ? claimed : [...claimed, context],   // ← 和我们的形状完全一致
  }));
```

它给这条消息的 source 是 `{ kind: "runtime-context" }`（`const SOURCE = "runtime-context"`，`lib/index.js:218`），并且用这个 kind 认领自己的消息，在它被替换时清理（`isOwned` / `RuntimeContextProjection`）。**我们照抄这个模式，只换成 `{ kind: 'plugin', plugin: 'dsh-memory' }`。**

同族用法还有 `executeToolCalls` 的 context 回调（`lib/index.js:1154`），它把工具产生的上下文用 `inbox.splice('next-step', ...)` 塞进 pending 队列——**在工具循环里要影响下一个 step 时，splice 是对的做法；在 pre-step 里要影响当前 step 时，改写 decision 是对的做法。** 两者别搞混。

#### 落盘行为（回声过滤必须依赖的事实）

`lib/index.js:1061`：

```js
if (firstAttempt) for (const message of decision.messages) this.session.append("user/message", message, { surfaceOp: "append" });
```

- 源码显示追加消息会写入 `user/message`，类型和 `surfaceOp: 'append'` 已核实；但 `source.memoryRefs` 等扩展字段是否穿过完整 pre-step/持久化/重折叠链仍以 M0-T2 为准。**在 M0-T2 成功前，只能把 `source.kind === 'plugin' && source.plugin === 'dsh-memory'` 作为探测假设，不能据此宣称扩展字段原样落盘，也不能启用依赖完整引用的回声过滤。**
- 它只在 `firstAttempt` 时落盘。**重试路径不会重复写**，所以我们不需要做去重。
- ⚠️ **新消息的 `id` 必须全局唯一。** inbox 用 id 做去重和定位（`replace` / `remove` / `locate` 都按 id 找）。虽然我们不经 inbox，但这条路径的消息最终会和 inbox 消息进同一个日志，**用 `randomUUID()` 而不是自增或时间戳**。
- ✅ **一个对我们有利的额外发现：** `session.append('user/message', message, { surfaceOp: 'append' })` 里 `surfaceOp: 'append'` 是"追加"而非"替换"，所以 `isReplacementSurfaceEvent(event)` 对我们这条消息返回 false（`dsh-session/lib/index.js:199`：`isSurfaceEvent(event) && event.surfaceOp !== 'append'`）。**意味着我们的注入消息不会被当成"历史替换"事件参与各种清理逻辑。** 好消息，无需额外处理。

#### 顺序问题（M2 实现时必须注意）

waterfall 的默认顺序是各监听器按注册顺序串起来，**`next()` 之后才轮到我们**。而 runtime-context 的追加发生在**默认的 enter 处理器里**（也就是 `next()` 返回的那个 `{kind:'enter', messages: [...claimed, context]}`）。

所以实际顺序是：

```text
真实用户 claimed  →  [+ runtime-context 快照]  →  [+ 我们的记忆块]
```

记忆块排在 runtime-context 之后、真实用户消息之后；它是本轮的参考数据，不是更高优先级的新指令。不能把实际顺序描述为“最后是用户指令”。

> **修正（第一方样板推翻了我的初判）：应该用 `{ prepend: true }`。** `dsh-time-context` 的 pre-step 监听器注册时就带了 `{ prepend: true }`。原因：`prepend` 让我们的监听器排在**最外层**、最先拿到控制权，于是我们 `await next()` 之后拿到的 `decision.messages` 是**全部下游监听器都已追加完的完整批次**（含 runtime-context）。**不加 prepend 则可能在某个下游监听器之前就返回，导致我们的消息被后面的追加"隔开"。** → **照抄 `{ prepend: true }`。**

- ⚠️ **M0-T2 要验证的就是这个顺序**：在 probe 里打印 `decision.messages` 各条的 `source.kind`，记录真实完整批次；不得把 `['user', 'runtime-context']` 当成固定合同。验收要确认 runtime-context 与真实用户消息的相对顺序，并确认追加的 memory 消息保留 `source.kind='plugin'`、插件名和完整 `memoryRefs`。

### 6.4 `prompt-section.ts`

注册一个名为 `memory-stable` 的段落，内容取 §5.10 的稳定层渲染结果。

```ts
const disposeSection = agent.ctx.systemPrompt.section({
  name: 'memory-stable',
  order: 3000,             // 在第一方指导之后、运行时上下文（10000）之前
  text: renderStableLayer(agent),
  interpolate: false,      // ← 必须显式写！见下
})
```

- **`interpolate: false` 是硬性的。** 默认是 `true`，文本里的 `{{name}}` 会被当成变量引用做插值，**未知引用会让整个组装抛异常**。记忆正文来自用户内容，出现 `{{` 完全可能——不关掉插值，一条用户写下的 `{{ foo }}` 就能让整个 system prompt 组装失败。**这一条不写就是线上事故。**
- `order: 3000` 的依据（✅ 实测）：第一方固定开场白 `-1000`、persona 前缀 `0`、运行时上下文 `10000`/`10100`、persona 后缀 `10200`。`3000` 落在"第一方指导之后、运行时上下文之前"，位置稳定。
- 稳定层变脏时重渲染；hash 不变不更新。section 已核实返回 disposer、同作用域同名重复注册会抛异常；变更先撤销旧段再注册新段，保留每个 agent 的 disposer，失败时捕获并降级为空段。
- 使用 agent.ctx 注册，而非全局 ctx。**agent overlay 可被子作用域继承**，因此每个新建/恢复的 agent（包括子代理）必须注册自己的同名段，按自己的 workspace/session 渲染；即使没有记忆也注册空段遮蔽父项。agent 释放与插件 dispose 都要清理段落，不能依赖“天然不继承”。
- 不退化成每轮 inject 稳定层。稳定层不作为插件 user/message 重复追加；但 provider 的 systemPromptUpdate='in-history' 可能让 DSH 记录系统更新，验收应检查实际日志，不能宣称稳定层绝不进日志。

### 6.5 `turn-stopping.ts`

监听 `agent/turn-stopping`（serial 事件，没有 next）：只把 `{sessionId, turn}` 推入 outcome 队列，然后立即返回。outcome 的计算（§5.9）由调度器异步完成；"下一条用户消息是否在纠正"在下一个 turn 的 pre-step 里检测，结果写入队列，**不要在 pre-step 里同步计算 outcome**。

### 6.6 `tools.ts`（模型可见工具）

| 工具 | 参数（统一 schema DSL） | 返回 | 限制 |
|---|---|---|---|
| `memory_search` | `{ query: string (1..500), limit?: integer 1..8 = 5, types?: string[] }` | 每行一条：`[TAG id] summary (c=, u=)`，总长 ≤ 800 tokens | 不改变 injectedSet；写一条 layer='tool' 的 injections |
| `memory_expand` | `{ id: string }` | content + 最多 3 条证据（session 前 8 位、seq、excerpt），≤ 1500 tokens | 支持 4 位短码 |
| `memory_feedback` | `{ id: string, contentRev: integer, helpful: boolean, note?: string (≤200) }` | `"ok"` | 立即入队 utility 更新（w=1，r=±1）；`contentRev` 必须来自本轮实际注入/展开的完整引用，writer 以 `(id,contentRev,session,turn)` 做 CAS/幂等校验，正文修订不一致则拒绝 |
| `memory_note` | `{ content: string (8..400), kind: "fact"\|"preference"\|"procedure" }` | `"saved as candidate <id>"` | source_kind='assistant'，**强制 status='candidate'**；每个 turn 最多调用 3 次 |

工具描述（description）要写清楚："只有在当前注入的 memory_context 中找不到所需信息时才调用 memory_search"，避免模型频繁调用。

search/expand/feedback 必须按调用 agent 的 scope 和 active/frozen 状态过滤；直接传 ID 不得绕过范围。candidate 只能由用户命令 inspect/pending 复核，模型工具不能读取并自证有效。返回按完整文本 budgetTokens 校验，expand 优先削减证据；正文仍无法容纳时返回明确错误，不能静默截断改变含义。note/feedback 的 note 字段也经过 privacy；memory_note 的 origin_kinds=['assistant']、scope固定当前workspace，重复调用或跨session不晋升。

每次 memory_search 保存脱敏的 `{query,ids}` 候选用例；expand 只是“选择过”，不是正确性标签。只有该引用最终 used=1 且真实用户明确肯定时才成为 harvested 正样本；失败/纠正样本必须保留 exclude 或人工复核标签。无确定反馈的样本不进入晋升门禁。runner 将 query/expect、本次源记忆快照和固定 now/workspace 分开保存，不能用当前库里的新状态冒充当时 ground truth。

### 6.7 `commands.ts`（`/memory` 命令）

`stats` | `search <q>` | `inspect <id>` | `history <id>` | `rollback <id> <version>` | `freeze <id>` | `unfreeze <id>` | `pin <id>` | `unpin <id>` | `forget <id>` | `purge <id> --yes` | `pending`（候选、冲突关系和修复提案）| `approve <id>` | `reject <id>` | `approve-repair <proposalId>` | `reject-repair <proposalId>` | `evolve` | `eval [suite]` | `strategy [list|rollback <v>]` | `backfill [--dry-run]` | `export <path>` | `import <path>` | `budget`（已结算/预留/unknown 用量）

所有修改命令来自真实用户命令 handler，不允许通过模型工具转调；审批展示完整差异与来源风险，frozen 必须先 unfreeze。跨 workspace 管理需显式指定目标并确认，默认遵守当前 scope；诊断输出与路径不记录密钥。repair 提案已变更/被拒绝时禁止再次批准。

`stats` 的输出示例：
```
记忆总数 1,284（active 911 / candidate 37 / superseded 96 / archived 240）
类型分布 semantic 302 · episodic 410 · procedural 41 · failure 58 · preference 33 · …
近 7 天：注入 213 次，平均 742 tokens/turn，p95 延迟 38ms，纠正率 6.1%
策略 v4（2026-10-01 晋升），回归集 132 条，recall@inject 0.81
今日离线 LLM：11/40 次，48k/200k tokens
```

### 6.8 离线 LLM 客户端 `evolution/llm.ts`

- **优先**通过附录 A 中 `ctx.llm` 提供的方式调用 DSH 已配置好的模型（这样可以直接复用用户的 provider 配置和密钥，插件不需要接触任何密钥）。
- 不可行时，使用配置项 `cfg.offlineLLM = { baseURL, model, apiKeyEnv }`，按 OpenAI 兼容的 `/chat/completions` 接口调用；**密钥只从环境变量读取，不写入任何文件，也不写入日志**。
- 默认模型只在用户明确同意外发且 endpoint 可验证时使用；temperature=0。max_tokens 按附录 B 分任务固定，JSON 模式在 provider 支持时启用。发送流程固定为 privacy→完整输入上界→ledger.reserve→HTTP→settle→parse，不能绕过其中一环。
- 外部唯一 MemoryItem 合同是附录 B 的 `type/text/slot_key?/confidence/scope/evidence:[{seq,quote}]`；**不使用 evidence_seqs 或 content 作为外部字段**。parse.ts 映射 text→CandidateInput.content，request-local seq→真实 session_id/seq，quote→脱敏 excerpt，origin_kinds 从 evidenceLedger 推导；scope/owner 由本次上下文约束，LLM 不可跨 workspace 或升为 global/user。
- 解析先 JSON.parse；仅去掉包围整个响应的一个代码围栏后再解析一次，不从首个 `{` 到最后 `}` 猜对象。根 schema 严格，单 item 无效可丢弃；原本 items=[] 为成功 no-op，原本非空但全部无效为不可重试的失败。LLM 输出日志只存脱敏错误码，不存原始响应。
- 每条 text 8–800字符、type合法、confidence有限；每条 evidence.seq 必须在本次实际发送的 ledger 中，quote 10–200字符且为该脱敏 redacted_text 的连续子串，任一引用无效就丢弃整 item；不通过模糊匹配/去大小写来“修证据”。经 privacy 和 writer 再检验后，只写 candidate；B-4按 §5.17 创建提案。

---

## §7 任务清单

> 每个任务的格式：**目标 / 文件 / 步骤 / 验收**。验收中的命令必须真实运行并通过。
> M0–M3 是核心功能；M4 完成完整 MVP 的回归验收，M5–M6 是增强。规模估算不是删减安全门禁的理由。

### M0 · 环境探测与骨架（必须最先完成）

**M0-T1 运行时探测**
- 目标：确定 SQLite 方案、FTS5、zstd、DSH 的 Node 版本。
- 文件：`scripts/probe.mjs`
- 步骤：编写脚本，依次检测并打印：`process.versions.node`；`import('node:sqlite')` 是否成功；用 `:memory:` 数据库执行 `CREATE VIRTUAL TABLE t USING fts5(x)` 是否成功；`typeof zlib.zstdDecompressSync`。**这个脚本要在 DSH 插件环境中运行一次**（做法：写一个最小插件，在 apply 时执行探测并把结果写入日志，具体见附录 A §A.2），在普通 Node 中也运行一次。
- 验收：把两份输出贴进 NOTES；候选 DB 都必须实际验证 FTS5、事务及持久化重开。node:sqlite 不可用时不能直接假定 stock sql.js 有 FTS5；只有已验证的构建可回退，否则阻断 M0，无新依赖/自创替代检索。另确认实际 provider/model 的 tokenizer 或字节上界及请求输出硬限制；未完成验证时注入/离线调用保守禁用，不算相关功能已通过。

**M0-T2 注入路径探测（目标已因源码核实而改写）**

> 原目标是"确定用方式 A 还是 B"。**这个问题已经由源码回答了**（见 §6.3「为什么不用 `agent.inject`」）：`preStep` 先 `claim` 再跑 waterfall，所以 `inject()` 必然错过当前步骤。**注入一律走"改写 pre-step 返回值"。** M0-T2 的任务因此变成**验证这条路径的细节假设**，不再是做选择题。

- 文件：`probe/probe-inject.ts`
- 步骤：写最简插件，prepend:true 的 pre-step 中 await next 后用 createUserMessage 追加 PROBE 消息，source 包含 kind/plugin 及合法完整 memoryRefs；工厂生成 UUID，不手写 id。打印：
  1. `decision.messages` 里每条消息的 `source.kind`，记录真实批次，不预设数组（批次可能包含 `user`、`runtime-context` 以及新追加的 `plugin`）；验收只要求真实用户/运行时消息的顺序可解释，且新消息的 `source.kind === 'plugin'`、`plugin === 'dsh-memory'` 与完整 `memoryRefs` 保留；
  2. `payload.step` 和 `payload.turn`（确认首步判断依据）；
  3. `decision` 上除 `kind`/`messages` 外还有哪些字段（**确认 `startsRequestSeries` 是否存在、什么值**）。
- 然后运行会话，**用附录 A §A.4.1 的逐帧 zstd 解压脚本**打开对应的 session 文件，检查日志里：
  1. 是否出现 `user/message` 事件，其 `data.source` 和 `data.id` 是否就是我们放进去的那条（**确认落盘形状与回声过滤的判定字段**）；
  2. user→runtime-context→memory 的实际消息顺序，不以 system/message 位置代替 runtime-context user 消息。
- 验收：记录批次 source.kind、完整 decision 字段、落盘 source.memoryRefs 和消息UUID、实际顺序；完整 ID/contentRev 均原样保留。重启重折叠后能去掉已可见的 id@contentRev；修改正文后新版本可注入；失败 compaction 不重复注入，局部 replacement 只移除被覆盖项。缺失引用或 replacement 形状不明时阻断，不能只记“待确认”后进入 M2。

**M0-T3 项目骨架**
- 文件：§3 配置、src/index.ts（仅重新导出）、src/dsh/plugin.ts（空 apply + 合法具名 Config/inject/name）、config。DSH peer 包外置打包，不复制或打包另一份 Cordis 服务实现。
- `package.json` 的 scripts：`build`（tsup）、`test`（vitest run）、`typecheck`（tsc --noEmit）、`check`（依次运行 typecheck 和 test）、`eval`（node dist/eval-cli.js）。
- 验收：npm run check 通过；按 §10 的 insert 挂载空插件后能启动并出现 loaded 日志；section disposer/重复注册行为、父子覆盖、插件停用清理、stateVersion 重折叠及输入预算计数方案均记录到 NOTES。

### M1 · 存储与写入（对应原设计 P0 + P2）

**M1-T1 `db.ts` + 迁移**
- 实现 `openDb(path): Db`，`Db` 提供 `exec / run / get / all / transaction(fn)` 方法，内部根据 M0-T1 的结论选择 node:sqlite 或 sql.js。迁移逻辑：读取 `meta.schema_version`，按顺序执行 `migrations/*.sql`。
- 验收：测试——对新建数据库执行迁移后，所有表都存在；重复执行迁移不报错；`transaction` 中抛出异常时数据会回滚。

**M1-T2 `text.ts`、`tokens.ts`、`scope.ts`**
- 验收：§5.1 的全部必测用例通过；另外为每个函数至少补充 3 条测试。

**M1-T3 `writer.ts`**
- 按 §5.8 实现。
- 验收测试（每条都要单独写成一个 test）：
  1. 插入一条记录 → memories、memory_fts、memory_entities、memory_sources 四张表中都有对应数据。
   2. 两个独立来源插入同内容 → merged、证据幂等追加；未批准来源不会晋升。同一证据再次重放，confidence/use_count 不变。
   3. 两次**显式用户确认**先 MySQL 后 PostgreSQL，同 scopeKey/slot → superseded 链、valid_to/快照正确。
  4. 旧记录是 frozen → 结果为 `conflict_pending`。
  5. source_kind='web' → status='candidate'，confidence ≤ 0.5。
  6. `rollback(id, 1)` 之后，content 恢复为版本 1 的内容，version 递增。
   7. `forget` 之后，记录仍然存在，status='archived'。
   8. 同一 web 内容跨两个 session → 仍 candidate、confidence≤0.5；memory_note 和 rule 包装的工具内容同样不晋升。
   9. 同槽位 candidate 新值 → 已批准 active 完全不变；approve 时才按差异确认替换，frozen 拒绝。
  10. 长句只改端口 5432→6432、版本或否定词，即使 jaccard≥0.8，仍保留不同事实；不同 slot/scopeKey 不能错误 merge。
  11. 唯一索引禁止同 scopeKey/slot 两个 active/frozen；跨 workspace/session 同名槽位不互相覆盖。
  12. edit/rollback 更新 content_rev 与 FTS/entities，旧 embedding 清空；只有统计/证据变化不递增正文版本。敏感 content/excerpt 拒绝且不出现在快照/日志。

**M1-T4 `store.ts` 只读查询**：`get(id | shortId)`、`list(filter)`、`history(id)`、`sources(id)`、`stats()`。

### M2 · 接入 DSH 与在线召回（对应原设计 P0 + P1）

**M2-T1 ingest**：`queue.ts` + `rules.ts` + `session-listener.ts`。
- 验收：覆盖R1/R2/R4；真实用户“记住：回复一律用中文”→user preference并生成槽位；“本项目不要再用SQLite”→workspace偏好。user角色插件/time-context/runtime-context/本插件回声不触发用户审批；跨session工具失败仅产candidate；实时+backfill重复事件不重复统计。包含密钥/私有URL的事件原值不出现在raw_events、sources、failure_sigs及日志。

**M2-T2 retrieval**：`query.ts`、`channels.ts`、`fuse.ts`、`governor.ts`、`render.ts`、`recall.ts`。
- 验收：
  1. 意图正则测试：每个意图至少 4 个正例、2 个反例。
  2. 构造 200 条记忆，查询 "PostgreSQL 连接超时怎么办"，相关记录排进前 3。
   3. budget=300时完整渲染 budgetTokens≤300；稳定600、候选策略dynamic3200/maxItems12时总量≤3200；重复行头、summary和中文长文本都计入预算。
   4. 同session连续recall传入实际已提交的id@contentRev，第二次不返回旧版；正文修改后可返回新版；稳定层实际可见引用不再进入动态层。
   5. 库中仅一条当天数据库事实，查询“今天天气”→空；仅低覆盖单词命中也为空；“昨天做了什么”可以浏览昨天记录。显式历史浏览可返回同 scope 的 superseded 记录，但结果必须标为历史、不能伪装成当前事实；普通非 temporalBrowse 查询不得返回 superseded。改变RRF权重不能绕过绝对门槛。
  6. render 的输出与 §5.10 中的示例格式逐字一致（使用快照测试）。
   7. 性能：1 万条记忆，100 次 recall 的 p95 < 50ms（普通 Node 中测量）。
   8. entity 通道有其他workspace的30条干扰命中时，本scope目标仍能召回；meta/candidate/archived不注入，歧义短码不任选。

**M2-T3 pre-step + prompt-section + 工具 + 命令**
- 验收（在 DSH Desktop 中手动测试，把过程记录到 `NOTES.md`）：
  1. 会话 1 中说"记住：我的项目数据库是 PostgreSQL 16"。
  2. **新建**会话 2，问"我的数据库是什么版本？"→ 模型回答 PostgreSQL 16，并且 session 日志中能看到 memory_context 块。
  3. `/memory stats` 和 `/memory inspect <id>` 的输出正确，并且包含来源 session。
  4. 在同一个会话里连续问 5 个与数据库相关的问题 → 同一条记忆**只注入一次**（通过 injections 表验证）。
   5. 临时把数据库文件改名，让插件无法打开 → DSH 照常对话，日志中出现降级提示。
   6. 实际提交消息source.memoryRefs包含完整id/正文版本；重启、失败compaction、局部replacement及最终pre-step拒绝都保持准确计数。
   7. 子代理不同workspace不继承父稳定记忆，插件停用无残留段落/监听器；默认offlineConsent=false时HTTP请求数为0。

**M2-T4 历史回填**（`backfill.ts`）
- 只支持 header.version=4 的 .jsonl/.jsonl.zstd；workspace_id从header.cwd计算，不反解有损目录名。压缩文件按附录A帧头/块长度解析，不扫所有magic；只恢复可验证的尾部，丢弃未完整换行的JSONL尾行。按(time,session_id,seq)确定历史顺序，旧valid_from不得覆盖更新的活跃槽位。映射、隐私、排除与幂等规则和实时路径一致。
- `--dry-run` 只统计，不写入。
- 验收：dry-run分别统计原始/过滤/隐私拒绝/可写事件，正式运行新增数与可写统计一致；第二次新增0且failure_sigs计数不变。包含payload内magic、多完整帧+撕裂尾帧、半条JSONL、旧格式、无cwd的fixture；不读取被排除workspace、不触发未经授权的上传。

### M3 · 离线学习（对应原设计 P3 + P4）

**M3-T1** ledger/llm/privacy/parse。验收：已用199000、输入500、maxOutput1500时预留失败且HTTP=0；40次调用上限、并发预留、网络重试逐次计费、未知usage/重启保留额度、未发送取消释放。未授权endpoint请求为0；含密钥/PII的mock body和存储均无原值。只接受裸JSON/整个代码围栏，不接受前后杂文；合法空items成功，不发解析修复请求。
**M3-T2** scheduler/jobs。验收：kind+key幂等，预算skip次日可恢复；超时Abort并等runner收敛，全局不并发；running恢复和unknown账本保守一致，解析失败输入不重发。
**M3-T3** extractor。验收：用真正附录B-1 schema的3份fixture产candidate；伪造request-local seq/quote、同seq不同session、引用未发送/被遮罩文本均丢弃。连续有界批不能丢早期事件；事务失败不推进processed/watermark，空items可以推进实际消费区间。
**M3-T4** `reflector.ts`（reflect，附录 B-2）+ `outcome.ts`（§5.9）。验收：纠正场景 → 入队 reflect，并且对同一个 turn 重复触发只入队一次；used/unused 两种归因的 utility 变化量符合公式（用精确数值断言）。
**M3-T5** consolidator/maintenance。验收：3个session各有used且明确成功的已批准episodic→1条procedural candidate及3条derived_from（含每个源的 content_rev/hash 快照），源记录不变；源记录在请求发送前或候选提交前发生正文/状态/hash变化时，整次响应丢弃并重新聚类，不写候选；单session3次成功不满足门槛，近似但不同hash不合并。用户审批后才可召回；冷归档、自动pin、备份生成/轮换都有测试。

M3完成仅代表核心功能。继续M4并对照§8.4验收；不得在回归集/门槛尚不存在时宣称完整MVP完成。

### M4 · 评测体系（对应原设计 P5）

**M4-T1** 按 §8 的格式实现 `eval/runner.ts` 和 `metrics.ts`。
**M4-T2** `gen-dataset.ts`：按 §8.2 的模板生成 ≥ 120 条用例（factual 30 / temporal 30 / procedural+failure 30 / implicit 30），其中 ≥ 20 条标记为 critical。
**M4-T3** `/memory eval` 命令 + `npm run eval`（可以脱离 DSH 运行）。
- 验收：`npm run eval` 输出各个 suite 的指标表；基线 `recallAtInject ≥ 0.7`。如果达不到，先查原因（数据集问题还是算法问题），**不允许修改用例来凑数字**，把分析写进 NOTES.md。

### M5 · 策略进化（对应原设计 P6）

**M5-T1** `strategy.ts`：初始化时写入 v1（使用 §5.5/§5.6 的默认值）；recall 读取当前 active 策略（内存缓存，策略变化时刷新）。
基础v1策略与只读加载器在M2-T2即实现，M5才增加版本晋升/回滚；不能让M2/M4依赖尚未执行的M5代码。
**M5-T2** `lab.ts`：按 §5.16 实现。验收：① 人为构造一个"只把 entity 权重调高就能提升 recall"的数据集 → lab 能找到并晋升新策略；② 构造一个会导致 critical 用例回归的候选 → 不会被晋升；③ 哨兵回滚：模拟晋升后纠正率上升 → 自动回滚到 parent。
另测：critical A由通过变失败、B由失败变通过且总数不变时仍拒绝；expectStable/empty/maxTokens回归拒绝；dynamic3200在stable600下被限制≤2600，运行时配置收紧也不能越预算；maxItems变异后仍是有效整数。
**M5-T3** harvested 用例采集（§6.6）。

### M6 · 查询触发修复（对应原设计 P7 精简版）

**M6-T1** repair/proposals/审批命令。验收：使用真实B-4的keep/revise/split/invalidate四种fixture；自动阶段原active/user记录不变、frozen不调用。批准后才应用、拒绝或过期不改、源content_rev变化或split槽位冲突阻止应用；过期提案不能再次批准；7天冷却跨重启有效。旧miss/wrong/nothing合同应解析失败而非偷偷映射。

---

## §8 评测集与回归门禁

### 8.1 用例格式（JSONL，每行一个用例）

```json
{
  "id": "temporal-007",
  "suite": "temporal",
  "critical": true,
  "now": "2026-10-01T10:00:00+08:00",
  "workspace": "/ws/demo",
  "setup": [
    {"type":"semantic","content":"项目数据库是 MySQL 8","slot_key":"project.database","at":"2026-08-01T10:00:00+08:00","source_kind":"user"},
    {"type":"semantic","content":"项目数据库已迁移到 PostgreSQL 16","slot_key":"project.database","at":"2026-09-20T10:00:00+08:00","source_kind":"user"}
  ],
  "query": "数据库连接串怎么写？",
  "expect": {
    "include": ["PostgreSQL"],
    "exclude": ["MySQL"],
    "maxTokens": 1600
  }
}
```
- 每个用例使用独立内存库、固定now/随机ID种子和workspace/session，不读取生产库/网络。setup按at通过writer写入；夹具只能经受信任fixture适配器模拟真实user授权，origin_kinds=['user']且sources完整，不能让任意LLM输出source_kind=user。非user fixture必须按候选权限处理或明确模拟用户审批。
- `include`：注入块中必须出现的子串（全部都要出现）。`exclude`：注入块中**不允许**出现的子串。
- `implicit` 套件额外支持 `"expectStable": ["简洁"]`：检查稳定层渲染结果中必须包含的子串。
- `include` 为空数组表示"应该什么都不注入"（门槛测试）。
- 上一句仅指动态层为空；implicit可同时要求expectStable。每条pass必须同时满足include、exclude、动态maxTokens、稳定expectStable及总硬预算；不能仅匹配子串判通过。runner保存 `caseResults[id]={pass,includePass,excludePass,stablePass,budgetPass,...}`。

### 8.2 生成模板（`gen-dataset.ts`，必须用固定随机种子，保证可复现）

| suite | 模板 | 数量 |
|---|---|---|
| factual | 写入 1 条目标事实 + 20 条干扰事实（随机选取其他主题），用同义改写的问题去查询 | 30 |
| temporal | 同一个 slot 先后写入 2–3 个值 → 查询的结果只能包含最新的值（include 最新值，exclude 旧值）；另外 5 条用"上周/昨天"之类的时间词查询 | 30 |
| procedural / failure | 写入 failure 记录（某个错误签名）+ 对应的 procedural 记录 → 用"又报 X 错误了"查询，两条都要被注入 | 30 |
| implicit | 写入 preference（pinned=1）→ 不提问偏好本身，只检查 expectStable；外加 10 条与偏好无关的查询，确认动态层不会重复注入偏好 | 30 |
| 门槛 | 与库中所有内容都无关的查询，include=[] | 包含在上面各 suite 中，合计 ≥ 10 条 |

主题词库（数据库、构建工具、代理端口、Python 版本、编码规范、部署目标……）以数组形式写在生成器中，每个主题提供 3 种问法。

### 8.3 指标（`metrics.ts`）

| 指标 | 定义 |
|---|---|
| `recallAtInject` | include 全部命中的用例数 / include 非空的用例数 |
| `excludeViolations` | 出现了任何 exclude 子串的用例数 |
| `emptyPrecision` | include 为空、并且确实没有注入任何内容的用例数 / include 为空的用例数 |
| `criticalPass` | 满足全部逐用例约束的critical数，仅作报告；晋升检查caseResults中原通过项身份 |
| `avgInjectTokens` | 每条非空 `include` 用例的动态注入块完整渲染 `budgetTokens` 平均值；稳定层单独由 `stablePass` 守门，总硬预算由 `maxBudgetTokens` 守门，不能互相替代 |
| `maxBudgetTokens` | 所有用例稳定+动态完整渲染的budgetTokens最大值；用于硬上限，不能以平均值替代 |
| `p95LatencyMs` | recall 耗时的 p95 |

**MVP 门槛：** recallAtInject≥0.7、excludeViolations=0、emptyPrecision≥0.8、avgInjectTokens≤1600、p95≤50ms；全部critical通过，全部用例budgetPass=true、implicit的stablePass=true。后续晋升仍逐用例防回归，不能因当前基线损坏就放弃保护原有通过项。

### 8.4 MVP 验收清单（对应原设计 §22）

- [ ] 能跨 session 召回事实，并且 `/memory inspect` 能显示来源（M2-T3）
- [ ] 事实发生变化时形成 supersedes 链，旧版本保留（M1-T3 测试 3）
- [ ] 输入 Token 不随记忆库规模增长：分别在 1k 条和 10k 条记忆的库上跑 eval，avgInjectTokens 相差 < 10%
- [ ] 注入有硬预算：任何情况下注入块都不超过 `cfg.hardBudgetTokens`（默认 3200，= 稳定层 + 动态层的上限）
- [ ] 在线回调不调用LLM/embedding：禁用后台scheduler跑20turn，HTTP和ledger增量均0；后台启用时按有界批处理，每个实际消费批次最多一次成功蒸馏，尾批/重试独立记账
- [ ] 能产出Failure/Procedural候选，未批准不注入；用户审批后才active（M3-T4/M3-T5）
- [ ] 高价值记忆都具备 utility / confidence / sources / version
- [ ] 基线v1和M4回归门禁可运行；新策略A/B/自动回滚属于M5增强验收，不冒充M3/M4已经完成
- [ ] Compaction 与 Memory 不重复消费同一段历史（§5.13 复用摘要；distill 的事件区间记录了 watermark）
- [ ] 支持导出 / 备份 / 恢复（§10）
- [ ] 回归集 ≥ 120 条，覆盖四类 suite
- [ ] 原审查13项反例都有对应门禁：候选隔离、数值更新、真实B-4合同、首次insert、完整引用、隐私、绝对相关性、注入总预算、逐请求账本、zstd帧碰撞、压缩失败、分词断言、critical身份

---

## §9 配置项与默认值（`src/config.ts`）

```ts
export const DEFAULTS = {
  enabled: true,
  dataDir: '',                    // 为空时使用 <dshHome>/storages/dsh-memory
  // 在线
  onlineBudgetMs: 150,
  hardBudgetTokens: 3200,         // 稳定层 + 动态层的硬上限
  stableBudgetTokens: 600,
  dynamicBudgetTokens: 1600,      // 初始值，之后由 strategy 接管
  maxItems: 6,
  queryMaxChars: 2000,
  maxContentTokens: 400,
  maxSummaryTokens: 60,
  maxEntitiesPerText: 16,
  minLexicalCoverage: 0.25,       // 绝对相关性硬约束，不参与进化
  minVectorSimilarity: 0.65,
  // 写入
  dupJaccard: 0.8,
  utilityLR: 0.1,
  // 离线
  offlineLLM: { useDshLlm: true, baseURL: '', model: 'deepseek-ai/deepseek-v4-flash-0731', apiKeyEnv: '' },
  dailyLLMCalls: 40,
  dailyLLMTokens: 200_000,
  distillMaxInputTokens: 6000,
  distillMinEvents: 40,
  idleMinutes: 10,
  nightlyAt: '03:30',
  jobTimeoutMs: 120_000,
  coldDays: 60,
  consolidateMaxClusters: 5,
  repairCooldownDays: 7,
  // 进化
  labCandidates: 8,
  labMinEvalCases: 30,
  maxLabItems: 12,
  // 向量（默认关闭）
  embedding: { provider: 'none' as 'none' | 'openai-compatible', baseURL: '', model: '', apiKeyEnv: '', dim: 0 },
  // 隐私
  defaultScope: 'workspace' as const,
  excludeWorkspaces: [] as string[], // 这些工作区的 cwd 完全不记录、也不召回
  privacy: { offlineConsent: false, allowedOfflineEndpoints: [] as string[] },
};
```

校验：`hardBudgetTokens` 为正整数；`stableBudgetTokens`、`dynamicBudgetTokens` 为非负整数，且 `stableBudgetTokens ≤ hardBudgetTokens`、`dynamicBudgetTokens ≤ hardBudgetTokens - stableBudgetTokens`（因此稳定层与动态层总和永不超过硬上限；动态预算为 0 时只禁用动态层）。其余计数/时长为正整数，概率与相似度在[0,1]且有限；provider=none时dim=0合法，开启embedding才要求有效模型/正整数dim。每次策略读取/晋升/rollback也重新按当前配置校验 dynamic cap。无效检索数值可按字段回退并warn，预算合同无法满足时禁用注入；隐私/排除/授权字段无效时拒绝记录/发送，**不得用宽松默认值覆盖用户排除列表或拒绝授权**。不将错误抛给DSH。

---

## §10 部署、备份、回滚

**首次挂载**（以附录 A §A.6.4 的已核实 patch 语义为准）：
1. `npm run build` 生成 `dist/`。
2. 让 DSH 能够解析到本包：在 profile 中安装（附录 A 给出 DSH 支持的本地路径挂载方式）。
3. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` 的**末尾**追加：
   ```yaml
    - insert:
        - id: dsh-memory
          name: dsh-memory
          config:
            dynamicBudgetTokens: 1600
   ```
   **修改前先备份这个文件**（`cordis.patch.yml.bak-YYYYMMDD`）。这个文件里包含用户的模型 provider 配置，**只允许追加，不允许改动已有的任何一行**。
4. 首次插入前确认ID不存在，不重复insert；依赖安装成功后按profile加载规则重启/重载，确认loaded日志及/memory stats。普通id/name/config是覆写已有项，不会新增插件。

**后续停用：** 在末尾追加定向覆写，不修改已有provider配置：
```yaml
- id: dsh-memory
  disabled: true
```
后续启用追加disabled:false。修改配置使用已有ID覆写，注意config整体替换，提交完整插件配置且保留隐私拒绝/排除规则；不要重复insert。停用不删除数据库。

**备份 / 恢复：**
- 自动备份：每天夜间在短暂暂停写入并刷盘后导出到唯一临时文件，执行 `PRAGMA integrity_check`、schema/contract/必需表列、FTS/槽位/来源/隐私约束校验，校验通过后原子改名为 `memory-YYYYMMDD-HHmmss.db`；失败删除临时文件，不覆盖同名文件，只保留最近 7 份。SQLite 可用时可用 `VACUUM INTO` 作为导出实现，但它不是校验或替换协议本身；sql.js 导出同样遵守这套流程。
- `/memory export <path>`：按同一临时文件→校验→原子改名流程导出一个 `.db` 文件；目标已存在时拒绝覆盖，除非用户显式指定新的目标路径。
- `/memory import <path>`：在只读临时连接检查schema_version、contract_version及必需表/列、integrity_check、FTS/槽位/来源/隐私约束，旧合同先迁移到临时副本。通过后暂停回调/scheduler、取消并等待runner、刷盘关闭，再原子替换并保留唯一.bak；重开后刷新缓存、重新校验策略并恢复服务，任何失败恢复旧库。不得关闭DB时仍让后台任务写入，也不能只凭schema_version接受任意文件。

**回滚层级：** 单条记忆 → `/memory rollback <id> <v>`；检索策略 → `/memory strategy rollback <v>`；整个库 → 用备份文件 import；整个插件 → `disabled: true`。

---

## §11 不做的事（Out of scope）

- 不修改 DSH 核心代码，不 fork 任何 `@deepseek-ai/*` 包。
- 不训练模型，不做 LoRA 或参数化记忆（原设计 P9）。
- 不让 Agent 用强化学习自主决定记忆操作（原设计 P8）。
- 不做网络服务，不做跨设备同步。
- 不引入 FAISS、向量数据库或本地 reranker 模型。
- 不在在线路径上调用任何模型/HTTP服务，包括本机embedding；向量缓存未命中直接跳过。
- 不做 UI 界面（命令行 `/memory` 命令已经足够；以后需要 UI 时再单独设计）。
