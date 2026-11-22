-- Schema v3: 补齐高规模检索与治理索引、FTS5 删除同步触发器及基础索引完整性

-- 1. 关系表与遥测表既有性能优化索引（收归正式版本化迁移）
CREATE INDEX IF NOT EXISTS ix_mem_rel_to ON memory_relations(to_id, rel);
CREATE INDEX IF NOT EXISTS ix_rel_type ON memory_relations(rel, from_id, to_id);
CREATE INDEX IF NOT EXISTS ix_rel_type_to ON memory_relations(rel, to_id, from_id);
CREATE INDEX IF NOT EXISTS ix_mem_vec_rank
  ON memories(pinned DESC, utility DESC, updated_at DESC, status, type, scope, workspace_id, session_id, id, hash)
  WHERE status IN ('active', 'frozen') AND type != 'meta';

CREATE INDEX IF NOT EXISTS ix_inj_created ON injections(created_at);
CREATE INDEX IF NOT EXISTS ix_turn_metrics_created ON turn_metrics(created_at);
CREATE INDEX IF NOT EXISTS ix_jobs_status_eligible ON jobs(status, next_eligible_at);

-- 2. 新增缺失索引：消除全表扫描与临时 B-Tree 排序
CREATE INDEX IF NOT EXISTS ix_mem_missing_embedding
  ON memories(id) WHERE status IN ('active', 'frozen') AND embedding IS NULL;

CREATE INDEX IF NOT EXISTS ix_mem_temporal
  ON memories(scope, workspace_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_mem_created
  ON memories(created_at DESC);

CREATE INDEX IF NOT EXISTS ix_mem_weave
  ON memories(scope, workspace_id, status, utility DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS ix_raw_tool_err
  ON raw_events(session_id, turn, tool_name, seq) WHERE is_error = 1;

CREATE INDEX IF NOT EXISTS ix_repair_status
  ON repair_proposals(status, memory_id);

-- 3. FTS5 删除同步触发器：防止从 memories 删除行后残留 FTS5 幽灵记录
CREATE TRIGGER IF NOT EXISTS tr_mem_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memory_fts WHERE rowid = OLD.rowid_;
END;
