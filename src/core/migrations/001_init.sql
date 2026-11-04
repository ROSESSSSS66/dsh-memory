PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

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
