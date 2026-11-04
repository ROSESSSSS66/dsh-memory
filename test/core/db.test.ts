import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/core/db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('M1-T1: db.ts & Migrations', () => {
  it('should run migrations on new in-memory db and create all required tables', () => {
    const db = openDb(':memory:');
    
    // 验证核心表存在
    const tables = [
      'meta',
      'memories',
      'memory_entities',
      'memory_sources',
      'memory_relations',
      'memory_versions',
      'raw_events',
      'injections',
      'turn_metrics',
      'strategies',
      'eval_cases',
      'jobs',
      'llm_ledger',
      'repair_proposals',
      'failure_sigs'
    ];

    for (const table of tables) {
      const row = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [table]
      );
      expect(row?.name, `Table ${table} should exist`).toBe(table);
    }

    // 验证 FTS 虚拟表
    const ftsRow = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'"
    );
    expect(ftsRow?.name).toBe('memory_fts');

    // 验证 meta 初始化值
    const versionRow = db.get<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'");
    expect(versionRow?.value).toBe('1');

    const contractRow = db.get<{ value: string }>("SELECT value FROM meta WHERE key='contract_version'");
    expect(contractRow?.value).toBe('1.1');

    db.close();
  });

  it('should not fail on repeated open/migration on same database', () => {
    const tmpFile = path.join(os.tmpdir(), `dsh_test_db_${Date.now()}.db`);
    try {
      const db1 = openDb(tmpFile);
      db1.close();

      // 再次打开并执行迁移
      const db2 = openDb(tmpFile);
      const versionRow = db2.get<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'");
      expect(versionRow?.value).toBe('1');
      db2.close();
    } finally {
      try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
    }
  });

  it('should rollback transaction on error', () => {
    const db = openDb(':memory:');

    expect(() => {
      db.transaction(() => {
        db.run(
          "INSERT INTO memories (id, type, status, content, summary, scope, source_kind, token_cost, summary_cost, hash, version, content_rev, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ['m_tx_test_01', 'semantic', 'active', 'Test content', 'Test summary', 'global', 'user', 10, 5, 'hash1', 1, 1, 0, Date.now(), Date.now()]
        );
        throw new Error('intentional_rollback_error');
      });
    }).toThrow('intentional_rollback_error');

    const row = db.get("SELECT * FROM memories WHERE id='m_tx_test_01'");
    expect(row).toBeUndefined();

    db.close();
  });

  it('should commit transaction on success', () => {
    const db = openDb(':memory:');

    const id = db.transaction(() => {
      db.run(
        "INSERT INTO memories (id, type, status, content, summary, scope, source_kind, token_cost, summary_cost, hash, version, content_rev, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ['m_tx_test_02', 'semantic', 'active', 'Test content 2', 'Test summary 2', 'global', 'user', 10, 5, 'hash2', 1, 1, 0, Date.now(), Date.now()]
      );
      return 'm_tx_test_02';
    });

    expect(id).toBe('m_tx_test_02');
    const row = db.get<{ id: string }>("SELECT id FROM memories WHERE id='m_tx_test_02'");
    expect(row?.id).toBe('m_tx_test_02');

    db.close();
  });

  it('should handle nested savepoint transactions properly', () => {
    const db = openDb(':memory:');

    db.transaction(() => {
      db.run(
        "INSERT INTO memories (id, type, status, content, summary, scope, source_kind, token_cost, summary_cost, hash, version, content_rev, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ['m_outer_1', 'semantic', 'active', 'Outer', 'Outer', 'global', 'user', 10, 5, 'hash_outer', 1, 1, 0, Date.now(), Date.now()]
      );

      // 嵌套成功
      db.transaction(() => {
        db.run(
          "INSERT INTO memories (id, type, status, content, summary, scope, source_kind, token_cost, summary_cost, hash, version, content_rev, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ['m_inner_1', 'semantic', 'active', 'Inner', 'Inner', 'global', 'user', 10, 5, 'hash_inner', 1, 1, 0, Date.now(), Date.now()]
        );
      });

      // 嵌套回滚不影响外层
      try {
        db.transaction(() => {
          db.run(
            "INSERT INTO memories (id, type, status, content, summary, scope, source_kind, token_cost, summary_cost, hash, version, content_rev, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ['m_inner_fail', 'semantic', 'active', 'Fail', 'Fail', 'global', 'user', 10, 5, 'hash_fail', 1, 1, 0, Date.now(), Date.now()]
          );
          throw new Error('inner_error');
        });
      } catch {}
    });

    expect(db.get("SELECT id FROM memories WHERE id='m_outer_1'")).toBeDefined();
    expect(db.get("SELECT id FROM memories WHERE id='m_inner_1'")).toBeDefined();
    expect(db.get("SELECT id FROM memories WHERE id='m_inner_fail'")).toBeUndefined();

    db.close();
  });
});
