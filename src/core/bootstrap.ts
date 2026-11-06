import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Db } from '../types.js';
import { DEFAULTS, type PluginConfig } from '../config.js';
import { workspaceId } from './scope.js';
import { getCoreMemory, setCoreMemory } from './core-memory.js';
import { upsertCandidate } from './writer.js';
import { importFromMarkdown, importMemoryBank } from './markdown.js';
import { backfillMissingEmbeddings } from './vector.js';
import { weaveZettelkastenLinks } from './health.js';
import { initDefaultStrategy, listStrategies } from '../evolution/strategy.js';
import { runBackfill } from '../ingest/backfill.js';

export interface AutoBootstrapOptions {
  workspacePath?: string;
  cfg?: PluginConfig;
  force?: boolean;
  includeBackfill?: boolean;
  sessionsDir?: string;
  now?: number;
}

export interface AutoBootstrapResult {
  alreadyInitialized: boolean;
  workspaceId: string;
  strategyInitialized: boolean;
  coreBlocksInitialized: string[];
  workspaceMemoriesSeeded: number;
  markdownMemoriesImported: number;
  backfillMemoriesCreated: number;
  backfillEventsAdded: number;
  embeddingsBackfilled: number;
  linksWeaved: number;
}

interface WorkspaceProfile {
  name: string;
  version: string;
  description: string;
  moduleType: string;
  scripts: Record<string, string>;
  srcDirs: string[];
  hasStrictTs: boolean;
  testFramework: string;
}

function inspectWorkspaceProfile(wsPath: string): WorkspaceProfile {
  const fallbackName = path.basename(wsPath) || 'workspace-project';
  const profile: WorkspaceProfile = {
    name: fallbackName,
    version: '0.1.0',
    description: '',
    moduleType: 'ESM',
    scripts: {},
    srcDirs: [],
    hasStrictTs: true,
    testFramework: 'vitest',
  };

  try {
    const pkgPath = path.join(wsPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (typeof pkg.name === 'string' && pkg.name.trim()) profile.name = pkg.name.trim();
      if (typeof pkg.version === 'string' && pkg.version.trim()) profile.version = pkg.version.trim();
      if (typeof pkg.description === 'string' && pkg.description.trim()) {
        profile.description = pkg.description.trim();
      }
      profile.moduleType = pkg.type === 'module' ? 'ESM (type=module)' : 'CommonJS';
      if (pkg.scripts && typeof pkg.scripts === 'object') {
        for (const [k, v] of Object.entries(pkg.scripts)) {
          if (typeof v === 'string') profile.scripts[k] = v;
        }
      }
      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if ('vitest' in allDeps) profile.testFramework = 'Vitest';
      else if ('jest' in allDeps) profile.testFramework = 'Jest';
    }
  } catch {}

  try {
    const tsPath = path.join(wsPath, 'tsconfig.json');
    if (fs.existsSync(tsPath)) {
      const tsRaw = fs.readFileSync(tsPath, 'utf8');
      profile.hasStrictTs = /"strict"\s*:\s*true/i.test(tsRaw);
    }
  } catch {}

  try {
    const srcRoot = path.join(wsPath, 'src');
    if (fs.existsSync(srcRoot)) {
      const entries = fs.readdirSync(srcRoot, { withFileTypes: true });
      profile.srcDirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => `src/${e.name}`)
        .slice(0, 8);
    }
  } catch {}

  return profile;
}

/**
 * 安装后与首次启动自动记忆初始化引擎 (Auto-Bootstrap Memory Engine, v0.4.0)
 * 幂等执行：
 * 1. 确保默认检索策略版本 (strategy_versions v1) 初始化
 * 2. 自动扫描当前环境与工程结构，初始化 Letta Core Memory 三大常驻块 (human / persona / project)
 * 3. 自动导入工作区已有的 .dsh/memory-bank 与 .dsh/memory Markdown 笔记
 * 4. 自动提取工作区 package.json / tsconfig.json 构建测试规范与架构冷启动记忆
 * 5. 自动扫描并回填本机历史 DSH 会话日志 (runBackfill)
 * 6. 自动补齐 128D 本地特征哈希向量并运行 A-Mem Zettelkasten 双链织网
 */
export function autoBootstrapMemory(
  db: Db,
  options: AutoBootstrapOptions = {}
): AutoBootstrapResult {
  const cfg = options.cfg || DEFAULTS;
  const now = options.now ?? Date.now();
  const wsPath = path.resolve(options.workspacePath || process.cwd());
  const wsId = workspaceId(wsPath);
  const metaKey = `bootstrap_ws:${wsId}`;

  // 1. 确保检索策略表已初始化
  let strategyInitialized = false;
  const existingStrategies = listStrategies(db);
  if (existingStrategies.length === 0) {
    initDefaultStrategy(db, cfg);
    strategyInitialized = true;
  }

  const existingMeta = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [metaKey]);
  if (existingMeta && !options.force) {
    return {
      alreadyInitialized: true,
      workspaceId: wsId,
      strategyInitialized,
      coreBlocksInitialized: [],
      workspaceMemoriesSeeded: 0,
      markdownMemoriesImported: 0,
      backfillMemoriesCreated: 0,
      backfillEventsAdded: 0,
      embeddingsBackfilled: 0,
      linksWeaved: 0,
    };
  }

  const profile = inspectWorkspaceProfile(wsPath);
  const coreBlocksInitialized: string[] = [];

  // 2. 自动种子化 Letta Core Memory 三大核心块 (human / persona / project)
  if (!getCoreMemory(db, 'human', { workspaceId: wsId })) {
    const humanContent = [
      `- 运行环境：${os.platform()} (${os.arch()}), Node.js ${process.version}`,
      `- 技术栈偏好：TypeScript 严格模式、${profile.moduleType}、零冗余原生 C++ 编译依赖`,
      `- 协作习惯：中文交流，先给根因与核心结论，再展示代码实现与验证结果`,
    ].join('\n');
    setCoreMemory(db, 'human', humanContent, { workspaceId: wsId, actor: 'system' });
    coreBlocksInitialized.push('human');
  }

  if (!getCoreMemory(db, 'persona', { workspaceId: wsId })) {
    const personaContent = [
      `- 角色定位：DSH 资深全栈架构师与自进化结对编程搭档`,
      `- 执行纪律：修改核心代码后必须通过类型检查、单元测试与基准评测门禁验证`,
      `- 安全红线：严禁落盘或外发敏感凭证，保持所有数据库迁移与记忆修订幂等可回滚`,
    ].join('\n');
    setCoreMemory(db, 'persona', personaContent, { workspaceId: wsId, actor: 'system' });
    coreBlocksInitialized.push('persona');
  }

  if (!getCoreMemory(db, 'project', { workspaceId: wsId })) {
    const scriptParts: string[] = [];
    for (const k of ['build', 'check', 'test', 'typecheck', 'eval', 'init']) {
      if (profile.scripts[k]) {
        scriptParts.push(`${k}: \`npm run ${k}\``);
      }
    }
    const projectLines = [
      `- 项目标识：${profile.name} (v${profile.version})${profile.description ? ` — ${profile.description.slice(0, 100)}` : ''}`,
      scriptParts.length > 0
        ? `- 核心命令：${scriptParts.join(' · ')}`
        : `- 模块规范：${profile.moduleType} · 测试框架：${profile.testFramework}`,
      profile.srcDirs.length > 0
        ? `- 核心目录：${profile.srcDirs.join(', ')}`
        : `- 工作区路径：${wsPath}`,
    ];
    setCoreMemory(db, 'project', projectLines.join('\n'), { workspaceId: wsId, actor: 'system' });
    coreBlocksInitialized.push('project');
  }

  // 3. 自动导入已存在的 .dsh/memory-bank 或 .dsh/memory Markdown 知识库
  let markdownMemoriesImported = 0;
  try {
    const bankDir = path.join(wsPath, '.dsh', 'memory-bank');
    if (fs.existsSync(bankDir)) {
      const bankRes = importMemoryBank(db, bankDir, { workspaceId: wsId });
      markdownMemoriesImported += bankRes.imported;
    }
  } catch {}

  try {
    const mdDir = path.join(wsPath, '.dsh', 'memory');
    if (fs.existsSync(mdDir)) {
      const mdRes = importFromMarkdown(db, mdDir, { workspaceId: wsId, actor: 'maintenance' });
      markdownMemoriesImported += mdRes.importedCount + mdRes.updatedCount;
    }
  } catch {}

  // 4. 自动提取工作区冷启动结构化记忆 (架构概览、常用构建测试指令、代码规范)
  let workspaceMemoriesSeeded = 0;
  const seedCandidates = [
    {
      type: 'semantic' as const,
      slot_key: 'project.architecture_overview',
      summary: `${profile.name} 项目架构与模块概览`,
      content: `项目 ${profile.name} (v${profile.version}) 采用 ${profile.moduleType} 模块体系${
        profile.description ? `，定位为：${profile.description}` : ''
      }。${
        profile.srcDirs.length > 0 ? `核心源码目录结构包括 ${profile.srcDirs.join('、')}。` : ''
      }`,
      importance: 8,
    },
    {
      type: 'procedural' as const,
      slot_key: 'project.workflow_commands',
      summary: `${profile.name} 构建、检查与自动化评测命令`,
      content:
        Object.keys(profile.scripts).length > 0
          ? `项目常用开发与验证命令：${Object.entries(profile.scripts)
              .slice(0, 6)
              .map(([k, v]) => `npm run ${k} (${v})`)
              .join('；')}。提交代码前优先运行 npm run check 与 npm run build。`
          : `项目使用 Node.js 24+ 与 ${profile.testFramework} 执行构建与自动化测试验证。`,
      importance: 8,
    },
    {
      type: 'preference' as const,
      slot_key: 'project.coding_conventions',
      summary: `${profile.name} 工程编码与测试规范`,
      content: `工程开发遵循 ${
        profile.hasStrictTs ? 'TypeScript Strict 严格类型检查' : 'TypeScript 类型规范'
      } 与 ${profile.moduleType} 规范，测试套件基于 ${
        profile.testFramework
      } 运行，保持零原生 C++ 编译依赖与跨平台兼容性。`,
      importance: 7,
    },
  ];

  seedCandidates.forEach((cand, idx) => {
    const existingSlot = db.get<{ id: string }>(
      `SELECT id FROM memories WHERE scope = 'workspace' AND COALESCE(workspace_id, '') = ? AND slot_key = ? AND status IN ('active', 'frozen')`,
      [wsId, cand.slot_key]
    );
    if (existingSlot && !options.force) {
      return;
    }
    const res = upsertCandidate(
      db,
      {
        type: cand.type,
        content: cand.content,
        summary: cand.summary,
        slot_key: cand.slot_key,
        scope: 'workspace',
        workspaceId: wsId,
        source_kind: 'user',
        origin_kinds: ['user'],
        confidence: 0.92,
        importance: cand.importance,
        status: 'active',
        sources: [
          {
            session_id: 'auto_bootstrap',
            seq: idx + 1,
            kind: 'bootstrap',
            excerpt: cand.summary,
          },
        ],
        actor: 'user',
      },
      now + idx
    );
    if (res.action === 'inserted' || res.action === 'superseded') {
      workspaceMemoriesSeeded++;
    }
  });

  // 5. 自动扫描并回填历史 DSH 会话日志
  let backfillMemoriesCreated = 0;
  let backfillEventsAdded = 0;
  if (options.includeBackfill !== false) {
    try {
      const bfStats = runBackfill(db, {
        sessionsDir: options.sessionsDir,
        cfg,
      });
      backfillMemoriesCreated = bfStats.memoriesCreated;
      backfillEventsAdded = bfStats.newEventsAdded;
    } catch {}
  }

  // 6. 自动回填 128D 本地特征向量并执行 A-Mem Zettelkasten 关联双链织网
  let embeddingsBackfilled = 0;
  let linksWeaved = 0;
  try {
    embeddingsBackfilled = backfillMissingEmbeddings(db, { workspaceId: wsId, limit: 500 });
  } catch {}
  try {
    linksWeaved = weaveZettelkastenLinks(db, { workspaceId: wsId, maxNewLinks: 30, now });
  } catch {}

  // 7. 标记当前工作区与全局冷启动已完成
  const summaryPayload = JSON.stringify({
    bootstrappedAt: now,
    workspacePath: wsPath,
    version: profile.version,
    coreBlocksInitialized,
    workspaceMemoriesSeeded,
    backfillMemoriesCreated,
    embeddingsBackfilled,
    linksWeaved,
  });
  db.run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', [metaKey, summaryPayload]);
  db.run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', ['bootstrap_v1', String(now)]);

  return {
    alreadyInitialized: false,
    workspaceId: wsId,
    strategyInitialized,
    coreBlocksInitialized,
    workspaceMemoriesSeeded,
    markdownMemoriesImported,
    backfillMemoriesCreated,
    backfillEventsAdded,
    embeddingsBackfilled,
    linksWeaved,
  };
}
