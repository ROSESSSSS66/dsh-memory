import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db, DbResult } from '../types.js';

const req = createRequire(import.meta.url);
const { DatabaseSync } = req('node:sqlite');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CURRENT_SCHEMA_VERSION = 3;
const MAX_STMT_CACHE = 256;

// 模块级缓存已读取的 SQL 迁移文本（避免 eval/lab 反复同步读盘数百次）
const migrationSqlCache = new Map<string, string>();

function loadMigrationFile(fileName: string): string {
  const cached = migrationSqlCache.get(fileName);
  if (cached !== undefined) return cached;

  // 严格按模块自身路径解析，移除 process.cwd() 回退以防工作区 SQL 劫持
  const possiblePaths = [
    path.join(__dirname, 'migrations', fileName),
    path.join(__dirname, '..', 'src', 'core', 'migrations', fileName),
    path.join(__dirname, '..', '..', 'src', 'core', 'migrations', fileName),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      const sql = fs.readFileSync(p, 'utf8');
      migrationSqlCache.set(fileName, sql);
      return sql;
    }
  }

  throw new Error(`Migration file not found: ${fileName}`);
}

export function openDb(dbPath: string = ':memory:', options: { readOnly?: boolean } = {}): Db {
  const rawDb = new DatabaseSync(dbPath, { readOnly: options.readOnly ?? false });

  // 严格顺序：先设置 busy_timeout，再切换 WAL / synchronous / foreign_keys
  try {
    rawDb.exec('PRAGMA busy_timeout = 5000;');
  } catch (err) {
    console.warn('[dsh-memory] Failed to set busy_timeout:', err instanceof Error ? err.message : String(err));
  }

  if (dbPath !== ':memory:' && !options.readOnly) {
    try {
      rawDb.exec('PRAGMA journal_mode = WAL;');
      rawDb.exec('PRAGMA synchronous = NORMAL;');
    } catch (err) {
      console.warn('[dsh-memory] Failed to configure WAL mode:', err instanceof Error ? err.message : String(err));
    }
  }
  rawDb.exec('PRAGMA foreign_keys = ON;');

  let savepointDepth = 0;
  let pendingAfterCommit: Array<() => void> = [];
  const stmtCache = new Map<string, any>();

  function getCachedStmt(sql: string): any {
    const existing = stmtCache.get(sql);
    if (existing) {
      // 真 LRU 刷新
      stmtCache.delete(sql);
      stmtCache.set(sql, existing);
      return existing;
    }
    const stmt = rawDb.prepare(sql);
    if (stmtCache.size >= MAX_STMT_CACHE) {
      const oldestKey = stmtCache.keys().next().value;
      if (oldestKey !== undefined) stmtCache.delete(oldestKey);
    }
    stmtCache.set(sql, stmt);
    return stmt;
  }

  function flushAfterCommit(): void {
    if (pendingAfterCommit.length === 0) return;
    const callbacks = pendingAfterCommit;
    pendingAfterCommit = [];
    for (const cb of callbacks) {
      try {
        cb();
      } catch (err) {
        console.warn('[dsh-memory] afterCommit callback error:', err instanceof Error ? err.message : String(err));
      }
    }
  }

  const dbWrapper: Db = {
    filePath: dbPath !== ':memory:' ? dbPath : undefined,
    exec(sql: string): void {
      rawDb.exec(sql);
    },
    run(sql: string, params: readonly any[] = []): DbResult {
      const stmt = getCachedStmt(sql);
      return stmt.run(...params) as DbResult;
    },
    get<T = any>(sql: string, params: readonly any[] = []): T | undefined {
      const stmt = getCachedStmt(sql);
      return stmt.get(...params) as T | undefined;
    },
    all<T = any>(sql: string, params: readonly any[] = []): T[] {
      const stmt = getCachedStmt(sql);
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
    afterCommit(cb: () => void): void {
      if (savepointDepth === 0) {
        cb();
      } else {
        pendingAfterCommit.push(cb);
      }
    },
    transaction<T>(fn: () => T): T {
      if (savepointDepth === 0) {
        rawDb.exec('BEGIN IMMEDIATE TRANSACTION;');
        savepointDepth = 1;
        pendingAfterCommit = [];
        try {
          const result = fn();
          if (result && typeof (result as any).then === 'function') {
            throw new Error('Async callback is not allowed inside synchronous db.transaction()');
          }
          rawDb.exec('COMMIT;');
          savepointDepth = 0;
          flushAfterCommit();
          return result;
        } catch (err) {
          pendingAfterCommit = [];
          try {
            rawDb.exec('ROLLBACK;');
          } catch {}
          savepointDepth = 0;
          throw err;
        }
      } else {
        const sp = `sp_${savepointDepth}`;
        const checkpointLen = pendingAfterCommit.length;
        rawDb.exec(`SAVEPOINT ${sp};`);
        savepointDepth++;
        try {
          const result = fn();
          if (result && typeof (result as any).then === 'function') {
            throw new Error('Async callback is not allowed inside synchronous db.transaction()');
          }
          rawDb.exec(`RELEASE SAVEPOINT ${sp};`);
          savepointDepth--;
          return result;
        } catch (err) {
          pendingAfterCommit.length = checkpointLen;
          try {
            rawDb.exec(`ROLLBACK TO SAVEPOINT ${sp};`);
            rawDb.exec(`RELEASE SAVEPOINT ${sp};`);
            savepointDepth--;
          } catch {
            // 若 SQLite 因 SQLITE_FULL/IOERR 触发整事务自动回滚，重置深度避免外层 COMMIT 失步
            if ('isTransaction' in rawDb && !rawDb.isTransaction) {
              savepointDepth = 0;
              pendingAfterCommit = [];
            } else {
              savepointDepth = Math.max(0, savepointDepth - 1);
            }
          }
          throw err;
        }
      }
    },
    close(): void {
      stmtCache.clear();
      pendingAfterCommit = [];
      rawDb.close();
    },
  };

  try {
    if (!options.readOnly) {
      runMigrations(dbWrapper);
    } else {
      assertReadableSchemaVersion(dbWrapper);
    }
  } catch (err) {
    try {
      stmtCache.clear();
      rawDb.close();
    } catch {}
    throw err;
  }

  return dbWrapper;
}

function readSchemaVersion(db: Db): number {
  const metaTable = db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='meta'"
  );
  if (!metaTable) return 0;
  const row = db.get<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'");
  return row ? parseInt(row.value, 10) || 0 : 0;
}

function assertReadableSchemaVersion(db: Db): void {
  const schemaVersion = readSchemaVersion(db);
  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported database schema_version=${schemaVersion} (max supported=${CURRENT_SCHEMA_VERSION})`
    );
  }
}

function hasColumn(db: Db, table: string, column: string): boolean {
  const cols = db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  return cols.some((c) => c.name === column);
}

function runMigrations(db: Db): void {
  // 快速跳过已处于最新版本的库（避免无意义写锁）
  const initialVersion = readSchemaVersion(db);
  if (initialVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported database schema_version=${initialVersion} (max supported=${CURRENT_SCHEMA_VERSION})`
    );
  }
  if (initialVersion === CURRENT_SCHEMA_VERSION) {
    return;
  }

  // 全程在 BEGIN IMMEDIATE 事务中重查 schema_version，防止多进程并发迁移竞态
  db.transaction(() => {
    let schemaVersion = readSchemaVersion(db);
    if (schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported database schema_version=${schemaVersion} (max supported=${CURRENT_SCHEMA_VERSION})`
      );
    }

    if (schemaVersion < 1) {
      db.exec(loadMigrationFile('001_init.sql'));
      const now = Date.now();
      db.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1')");
      db.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('contract_version', '1.1')");
      db.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('created_at', ?)", [now.toString()]);
      schemaVersion = 1;
    }

    if (schemaVersion < 2) {
      db.exec(loadMigrationFile('002_session_owners.sql'));
      db.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '2')");
      schemaVersion = 2;
    }

    if (schemaVersion < 3) {
      // 安全检查旧库是否缺失 importance / invalidated_at 字段后再添加，绝不用空 catch 掩盖真实错误
      if (!hasColumn(db, 'memories', 'importance')) {
        db.exec('ALTER TABLE memories ADD COLUMN importance INTEGER NOT NULL DEFAULT 5;');
      }
      if (!hasColumn(db, 'memories', 'invalidated_at')) {
        db.exec('ALTER TABLE memories ADD COLUMN invalidated_at INTEGER;');
      }
      db.exec(loadMigrationFile('003_integrity_and_indexes.sql'));
      db.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '3')");
    }
  });
}
