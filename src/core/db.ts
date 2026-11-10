import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db, DbResult } from '../types.js';

const req = createRequire(import.meta.url);
const { DatabaseSync } = req('node:sqlite');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function openDb(dbPath: string = ':memory:'): Db {
  const rawDb = new DatabaseSync(dbPath);

  if (dbPath !== ':memory:') {
    try {
      rawDb.exec('PRAGMA journal_mode = WAL;');
      rawDb.exec('PRAGMA synchronous = NORMAL;');
    } catch {}
  }
  try {
    rawDb.exec('PRAGMA busy_timeout = 5000;');
  } catch {}
  rawDb.exec('PRAGMA foreign_keys = ON;');

  let savepointDepth = 0;

  const dbWrapper: Db = {
    exec(sql: string): void {
      rawDb.exec(sql);
    },
    run(sql: string, params: any[] = []): DbResult {
      const stmt = rawDb.prepare(sql);
      return stmt.run(...params) as DbResult;
    },
    get<T = any>(sql: string, params: any[] = []): T | undefined {
      const stmt = rawDb.prepare(sql);
      return stmt.get(...params) as T | undefined;
    },
    all<T = any>(sql: string, params: any[] = []): T[] {
      const stmt = rawDb.prepare(sql);
      return stmt.all(...params) as T[];
    },
    prepare(sql: string) {
      const stmt = rawDb.prepare(sql);
      return {
        run(...params: any[]): DbResult {
          return stmt.run(...params) as DbResult;
        },
        get(...params: any[]) {
          return stmt.get(...params);
        },
        all(...params: any[]) {
          return stmt.all(...params);
        },
      };
    },
    transaction<T>(fn: () => T): T {
      if (savepointDepth === 0) {
        rawDb.exec('BEGIN IMMEDIATE TRANSACTION;');
        savepointDepth++;
        try {
          const result = fn();
          rawDb.exec('COMMIT;');
          savepointDepth--;
          return result;
        } catch (err) {
          try {
            rawDb.exec('ROLLBACK;');
          } catch {}
          savepointDepth--;
          throw err;
        }
      } else {
        // 嵌套事务使用 SAVEPOINT
        const sp = `sp_${savepointDepth}`;
        rawDb.exec(`SAVEPOINT ${sp};`);
        savepointDepth++;
        try {
          const result = fn();
          rawDb.exec(`RELEASE SAVEPOINT ${sp};`);
          savepointDepth--;
          return result;
        } catch (err) {
          try {
            rawDb.exec(`ROLLBACK TO SAVEPOINT ${sp};`);
            rawDb.exec(`RELEASE SAVEPOINT ${sp};`);
          } catch {}
          savepointDepth--;
          throw err;
        }
      }
    },
    close(): void {
      rawDb.close();
    },
  };

  // 执行迁移
  try {
    runMigrations(dbWrapper);
  } catch (err) {
    try {
      rawDb.close();
    } catch {}
    throw err;
  }

  return dbWrapper;
}

function runMigrations(db: Db): void {
  // 检查 meta 表是否存在
  const metaTable = db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='meta'"
  );

  let schemaVersion = 0;
  if (metaTable) {
    const row = db.get<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'");
    if (row) {
      schemaVersion = parseInt(row.value, 10) || 0;
    }
  }

  if (schemaVersion < 1) {
    // 执行 001_init.sql
    const sql = loadMigrationFile('001_init.sql');
    db.exec(sql);

    const now = Date.now();
    db.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1')");
    db.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('contract_version', '1.1')");
    db.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('created_at', ?)", [now.toString()]);
  }

  // 保证关系表反向索引与高规模检索覆盖索引存在 (性能优化)
  try {
    db.exec("CREATE INDEX IF NOT EXISTS ix_mem_rel_to ON memory_relations(to_id, rel);");
    db.exec("CREATE INDEX IF NOT EXISTS ix_rel_type ON memory_relations(rel, from_id, to_id);");
    db.exec(
      "CREATE INDEX IF NOT EXISTS ix_mem_vec_rank ON memories(pinned DESC, utility DESC, updated_at DESC, status, type, scope, workspace_id, session_id, id, hash) WHERE status IN ('active', 'frozen') AND type != 'meta';"
    );
  } catch {}
  // 遥测表按时间窗口扫描（概览统计 / 沙盒最近注入 / 遥测清理），避免随注入日志增长退化为全表扫描
  try {
    db.exec('CREATE INDEX IF NOT EXISTS ix_inj_created ON injections(created_at);');
    db.exec('CREATE INDEX IF NOT EXISTS ix_turn_metrics_created ON turn_metrics(created_at);');
    db.exec('CREATE INDEX IF NOT EXISTS ix_jobs_status_eligible ON jobs(status, next_eligible_at);');
  } catch {}

  // 保证 Stanford / Zep 时序与重要度字段存在
  try {
    db.exec("ALTER TABLE memories ADD COLUMN importance INTEGER NOT NULL DEFAULT 5;");
  } catch {}
  try {
    db.exec("ALTER TABLE memories ADD COLUMN invalidated_at INTEGER;");
  } catch {}
}

function loadMigrationFile(fileName: string): string {
  const possiblePaths = [
    path.join(__dirname, 'migrations', fileName),
    path.join(__dirname, '..', 'src', 'core', 'migrations', fileName),
    path.join(process.cwd(), 'src', 'core', 'migrations', fileName),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf8');
    }
  }

  throw new Error(`Migration file not found: ${fileName}`);
}
