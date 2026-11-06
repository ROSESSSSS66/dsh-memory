#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const force = args.includes('--force') || args.includes('-f');
const quiet = args.includes('--quiet') || process.env.DSH_MEMORY_SKIP_BOOTSTRAP === '1';

if (quiet && process.env.DSH_MEMORY_SKIP_BOOTSTRAP === '1') {
  process.exit(0);
}

const defaultDataDir = path.join(os.homedir(), '.dsh', 'storages', 'dsh-memory');
const dbPath =
  process.env.DSH_MEMORY_DB_PATH ||
  path.join(process.env.DSH_MEMORY_DATA_DIR || defaultDataDir, 'memory.db');

async function ensureBuiltOrImport() {
  const distIndex = path.join(projectRoot, 'dist', 'index.js');
  if (!fs.existsSync(distIndex)) {
    // 首次 npm install 时若尚未构建 dist/index.js，自动触发轻量构建以便执行完整冷启动记忆初始化
    try {
      const tsupBin = path.join(
        projectRoot,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'tsup.cmd' : 'tsup'
      );
      if (fs.existsSync(tsupBin)) {
        spawnSync(tsupBin, {
          cwd: projectRoot,
          stdio: 'ignore',
          shell: process.platform === 'win32',
        });
      }
      const clientBuildScript = path.join(__dirname, 'build-client.mjs');
      if (fs.existsSync(clientBuildScript) && !fs.existsSync(path.join(projectRoot, 'dist', 'client.js'))) {
        spawnSync(process.execPath, [clientBuildScript], {
          cwd: projectRoot,
          stdio: 'ignore',
        });
      }
    } catch {}
  }

  if (fs.existsSync(distIndex)) {
    return await import(pathToFileURL(distIndex).href);
  }
  return null;
}

async function main() {
  try {
    const parentDir = path.dirname(path.resolve(dbPath));
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const mod = await ensureBuiltOrImport();
    if (mod && typeof mod.openDb === 'function' && typeof mod.autoBootstrapMemory === 'function') {
      const db = mod.openDb(dbPath);
      try {
        const res = mod.autoBootstrapMemory(db, {
          workspacePath: projectRoot,
          force,
          includeBackfill: true,
        });

        if (res.alreadyInitialized && !force) {
          console.log(
            `[dsh-memory] ✅ 记忆库已就绪 (${dbPath}) — 如需强制重新扫描与初始化，请运行: npm run init`
          );
        } else {
          console.log(
            `[dsh-memory] 🚀 安装后自动记忆初始化完成 (${dbPath}):\n` +
              `  • Letta 常驻核心块: ${
                res.coreBlocksInitialized.length > 0
                  ? res.coreBlocksInitialized.join(', ')
                  : 'human, persona, project (已就绪)'
              }\n` +
              `  • 工作区冷启动记忆: +${res.workspaceMemoriesSeeded} 条 (Markdown 导入: +${res.markdownMemoriesImported} 条)\n` +
              `  • 历史 DSH 会话回填: +${res.backfillEventsAdded} 条事件 -> 提炼 +${res.backfillMemoriesCreated} 条规则记忆\n` +
              `  • 128D 本地向量回填: ${res.embeddingsBackfilled} 条 | A-Mem 自动双链织网: +${res.linksWeaved} 条关联边`
          );
        }
      } finally {
        db.close();
      }
      return;
    }

    // 兜底：若处于最小化环境且 dist 尚未生成，使用 Node 24 原生 node:sqlite 直接初始化 schema 与核心元数据
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req('node:sqlite');
    const sqlPath = path.join(projectRoot, 'src', 'core', 'migrations', '001_init.sql');
    if (fs.existsSync(sqlPath)) {
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec('PRAGMA journal_mode = WAL;');
      rawDb.exec(fs.readFileSync(sqlPath, 'utf8'));
      const now = Date.now().toString();
      rawDb.exec(
        `INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1'), ('contract_version', '1.1'), ('created_at', '${now}');`
      );
      rawDb.close();
      console.log(`[dsh-memory] ✅ 数据库基础 Schema 已初始化: ${dbPath}`);
    }
  } catch (err) {
    // postinstall 绝不阻断 npm install 主流程
    console.warn('[dsh-memory] Post-install memory bootstrap skipped:', err?.message || err);
  }
}

main();
