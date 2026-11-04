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
    } catch {}
  }
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
        const sp = `sp_${savepointDepth++}`;
        rawDb.exec(`SAVEPOINT ${sp};`);
        try {
          const result = fn();
          rawDb.exec(`RELEASE SAVEPOINT ${sp};`);
          savepointDepth--;
          return result;
        } catch (err) {
          try {
            rawDb.exec(`ROLLBACK TO SAVEPOINT ${sp};`);
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
