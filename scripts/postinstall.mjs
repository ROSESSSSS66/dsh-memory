#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const CURRENT_SCHEMA_VERSION = 3;

const args = process.argv.slice(2);
const force = args.includes('--force') || args.includes('-f');
const quiet = args.includes('--quiet') || args.includes('-q');
const dryRun = args.includes('--dry-run');
const includeBackfill = !args.includes('--no-backfill');

// CI / 自动化环境下跳过（除非显式 --force 或 --dry-run）：避免在构建机上扫描主目录、回填历史会话并写入 ~/.dsh
if (process.env.DSH_MEMORY_SKIP_BOOTSTRAP === '1' || (process.env.CI && !force && !dryRun)) {
  process.exit(0);
}

function logInfo(msg) {
  if (!quiet) console.log(msg);
}

function logWarn(...msg) {
  if (!quiet) console.warn(...msg);
}

const defaultDataDir = path.join(os.homedir(), '.dsh', 'storages', 'dsh-memory');
const dbPath =
  process.env.DSH_MEMORY_DB_PATH ||
  path.join(process.env.DSH_MEMORY_DATA_DIR || defaultDataDir, 'memory.db');

const workspacePath =
  process.env.INIT_CWD && !process.env.INIT_CWD.includes('node_modules')
    ? process.env.INIT_CWD
    : projectRoot;

async function ensureBuiltOrImport() {
  const distIndex = path.join(projectRoot, 'dist', 'index.js');
  if (!fs.existsSync(distIndex)) {
    // 首次安装时若尚未构建 dist/index.js，通过 process.execPath 直接执行 tsup（零 shell: true）
    const tsupCli = path.join(projectRoot, 'node_modules', 'tsup', 'dist', 'cli-default.js');
    if (fs.existsSync(tsupCli)) {
      const tsupRes = spawnSync(process.execPath, [tsupCli], {
        cwd: projectRoot,
        stdio: 'ignore',
      });
      if (tsupRes.error || tsupRes.status !== 0) {
        const reason = tsupRes.error?.message || `exit code ${tsupRes.status ?? 'unknown'}`;
        if (force) throw new Error(`tsup build failed: ${reason}`);
        logWarn(`[dsh-memory] tsup build skipped/failed: ${reason}`);
      }
    }

    const clientBuildScript = path.join(__dirname, 'build-client.mjs');
    const distClient = path.join(projectRoot, 'dist', 'client.js');
    if (
      fs.existsSync(distIndex) &&
      fs.existsSync(clientBuildScript) &&
      !fs.existsSync(distClient)
    ) {
      const clientRes = spawnSync(process.execPath, [clientBuildScript], {
        cwd: projectRoot,
        stdio: 'ignore',
      });
      if (clientRes.error || clientRes.status !== 0) {
        const reason = clientRes.error?.message || `exit code ${clientRes.status ?? 'unknown'}`;
        if (force) throw new Error(`client build failed: ${reason}`);
        logWarn(`[dsh-memory] client build skipped/failed: ${reason}`);
      }
    }
  }

  if (fs.existsSync(distIndex)) {
    return await import(pathToFileURL(distIndex).href);
  }
  return null;
}

function readRawSchemaVersion(rawDb) {
  const metaTable = rawDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
    .get();
  if (!metaTable) return 0;
  const row = rawDb.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  return row ? Number.parseInt(row.value, 10) || 0 : 0;
}

function rawHasColumn(rawDb, table, column) {
  const cols = rawDb.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

async function initFallbackSchema(targetDbPath) {
  const migrationsDir = path.join(projectRoot, 'src', 'core', 'migrations');
  const sql001 = path.join(migrationsDir, '001_init.sql');
  const sql002 = path.join(migrationsDir, '002_session_owners.sql');
  const sql003 = path.join(migrationsDir, '003_integrity_and_indexes.sql');

  if (!fs.existsSync(sql001) || !fs.existsSync(sql002) || !fs.existsSync(sql003)) {
    throw new Error(`Migration SQL files missing in ${migrationsDir}`);
  }

  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const { DatabaseSync } = req('node:sqlite');
  const rawDb = new DatabaseSync(targetDbPath);

  try {
    rawDb.exec('PRAGMA busy_timeout = 5000;');
    rawDb.exec('PRAGMA journal_mode = WAL;');
    rawDb.exec('PRAGMA synchronous = NORMAL;');
    rawDb.exec('PRAGMA foreign_keys = ON;');

    const initialVersion = readRawSchemaVersion(rawDb);
    if (initialVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported database schema_version=${initialVersion} (max supported=${CURRENT_SCHEMA_VERSION})`
      );
    }

    if (initialVersion < CURRENT_SCHEMA_VERSION) {
      rawDb.exec('BEGIN IMMEDIATE;');
      try {
        let schemaVersion = readRawSchemaVersion(rawDb);
        if (schemaVersion > CURRENT_SCHEMA_VERSION) {
          throw new Error(
            `Unsupported database schema_version=${schemaVersion} (max supported=${CURRENT_SCHEMA_VERSION})`
          );
        }

        if (schemaVersion < 1) {
          rawDb.exec(fs.readFileSync(sql001, 'utf8'));
          const now = Date.now().toString();
          rawDb
            .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1')")
            .run();
          rawDb
            .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('contract_version', '1.1')")
            .run();
          rawDb
            .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('created_at', ?)")
            .run(now);
          schemaVersion = 1;
        }

        if (schemaVersion < 2) {
          rawDb.exec(fs.readFileSync(sql002, 'utf8'));
          rawDb
            .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '2')")
            .run();
          schemaVersion = 2;
        }

        if (schemaVersion < 3) {
          if (!rawHasColumn(rawDb, 'memories', 'importance')) {
            rawDb.exec('ALTER TABLE memories ADD COLUMN importance INTEGER NOT NULL DEFAULT 5;');
          }
          if (!rawHasColumn(rawDb, 'memories', 'invalidated_at')) {
            rawDb.exec('ALTER TABLE memories ADD COLUMN invalidated_at INTEGER;');
          }
          rawDb.exec(fs.readFileSync(sql003, 'utf8'));
          rawDb
            .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '3')")
            .run();
        }

        rawDb.exec('COMMIT;');
      } catch (txErr) {
        try {
          rawDb.exec('ROLLBACK;');
        } catch {}
        throw txErr;
      }
    }

    logInfo(
      `[dsh-memory] ✅ 数据库基础 Schema (v${CURRENT_SCHEMA_VERSION}) 已初始化: ${targetDbPath}`
    );
  } finally {
    rawDb.close();
  }
}

async function main() {
  try {
    if (dryRun) {
      const distIndex = path.join(projectRoot, 'dist', 'index.js');
      logInfo(
        `[dsh-memory] Dry-run bootstrap plan (no files or database modified):\n` +
          `  • dbPath: ${dbPath} (${fs.existsSync(dbPath) ? 'exists' : 'will create'})\n` +
          `  • workspacePath: ${workspacePath}\n` +
          `  • force: ${force}\n` +
          `  • includeBackfill: ${includeBackfill}\n` +
          `  • dist/index.js: ${fs.existsSync(distIndex) ? 'ready' : 'not built yet'}`
      );
      return;
    }

    const parentDir = path.dirname(path.resolve(dbPath));
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const mod = await ensureBuiltOrImport();
    if (mod && typeof mod.openDb === 'function' && typeof mod.autoBootstrapMemory === 'function') {
      const db = mod.openDb(dbPath);
      try {
        const res = mod.autoBootstrapMemory(db, {
          workspacePath,
          force,
          includeBackfill,
        });

        if (res.alreadyInitialized && !force) {
          logInfo(
            `[dsh-memory] ✅ 记忆库已就绪 (${dbPath}) — 如需强制重新扫描与初始化，请运行: npm run init`
          );
        } else {
          logInfo(
            `[dsh-memory] 🚀 安装后自动记忆初始化完成 (${dbPath}):\n` +
              `  • Letta 常驻核心块: ${
                res.coreBlocksInitialized.length > 0
                  ? res.coreBlocksInitialized.join(', ')
                  : 'human, persona, project (已就绪)'
              }\n` +
              `  • 工作区冷启动记忆: +${res.workspaceMemoriesSeeded} 条 (Markdown 导入: +${res.markdownMemoriesImported} 条)\n` +
              `  • 历史 DSH 会话回填: ${
                includeBackfill
                  ? `+${res.backfillEventsAdded} 条事件 -> 提炼 +${res.backfillMemoriesCreated} 条规则记忆`
                  : '已跳过 (--no-backfill)'
              }\n` +
              `  • 128D 本地向量回填: ${res.embeddingsBackfilled} 条 | A-Mem 自动双链织网: +${res.linksWeaved} 条关联边`
          );
        }
      } finally {
        db.close();
      }
      return;
    }

    // 兜底：若处于最小化环境且 dist 尚未生成，使用 Node 24 原生 node:sqlite 在事务内初始化完整 Schema v3
    await initFallbackSchema(dbPath);
  } catch (err) {
    if (force) {
      console.error('[dsh-memory] Memory initialization failed:', err?.message || err);
      process.exitCode = 1;
      return;
    }
    // postinstall 绝不阻断 npm install 主流程
    logWarn('[dsh-memory] Post-install memory bootstrap skipped:', err?.message || err);
  }
}

main();
