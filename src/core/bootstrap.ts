import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Db } from '../types.js';
import { DEFAULTS, type PluginConfig } from '../config.js';
import { workspaceId, rememberWorkspacePath } from './scope.js';
import { isWorkspaceExcluded, redactSecrets } from './privacy.js';
import { getCoreMemory, setCoreMemory } from './core-memory.js';
import { upsertCandidate } from './writer.js';
import {
  importFromMarkdown,
  importMemoryBank,
  isPathInsideRoot,
  safeReadTextFileSync,
} from './markdown.js';
import { importVikingContextTree } from './viking.js';
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
  warnings: string[];
}

interface WorkspaceProfile {
  name: string;
  version: string | null;
  description: string;
  hasPackageJson: boolean;
  moduleType: string | null;
  scriptNames: string[];
  srcDirs: string[];
  hasTsConfig: boolean;
  hasStrictTs: boolean | null;
  hasTypeScript: boolean;
  testFramework: string | null;
  detectedLanguages: string[];
}

const MAX_CONFIG_FILE_BYTES = 128 * 1024;
const SAFE_SCRIPT_NAME_REGEX = /^[a-zA-Z0-9:._-]{1,40}$/;
const SAFE_DIR_NAME_REGEX = /^[a-zA-Z0-9._-]{1,64}$/;

/**
 * 清洗来自仓库配置文件的不可信文本字段：
 * 剥离 XML/HTML 标签、控制字符与换行、折叠空白、检测并丢弃敏感凭证、封顶 <= 120 字符
 */
function sanitizeWorkspaceField(raw: unknown, maxLen: number = 120): string {
  if (typeof raw !== 'string') return '';
  const stripped = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return '';
  if (redactSecrets(stripped).hasSensitive) {
    return '';
  }
  return stripped.slice(0, maxLen).trim();
}

function isRegularNonSymlinkFile(filePath: string, rootDir: string): boolean {
  try {
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile()) return false;
    return isPathInsideRoot(filePath, rootDir);
  } catch {
    return false;
  }
}

function isSafeWorkspaceSubdir(
  subDir: string,
  wsPath: string,
  warnings: string[],
  label: string
): boolean {
  try {
    const st = fs.lstatSync(subDir);
    if (st.isSymbolicLink()) {
      warnings.push(`Skipped symlink directory: ${label}`);
      return false;
    }
    if (!st.isDirectory()) return false;

    // 检查所有位于 wsPath 与 subDir 之间的父目录（如 .dsh），阻止中间符号链接越界
    let cur = path.dirname(path.resolve(subDir));
    const rootResolved = path.resolve(wsPath);
    while (cur !== rootResolved && cur !== path.dirname(cur)) {
      const pst = fs.lstatSync(cur);
      if (pst.isSymbolicLink() || !pst.isDirectory()) {
        warnings.push(`Skipped directory under symlink parent: ${label}`);
        return false;
      }
      cur = path.dirname(cur);
    }

    if (!isPathInsideRoot(subDir, wsPath)) {
      warnings.push(`Skipped directory escaping workspace root: ${label}`);
      return false;
    }
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      warnings.push(`Failed inspecting ${label}: ${(err as Error)?.message || String(err)}`);
    }
    return false;
  }
}

function inspectWorkspaceProfile(wsPath: string, warnings: string[]): WorkspaceProfile {
  const fallbackName = sanitizeWorkspaceField(path.basename(wsPath), 120) || 'workspace-project';
  const profile: WorkspaceProfile = {
    name: fallbackName,
    version: null,
    description: '',
    hasPackageJson: false,
    moduleType: null,
    scriptNames: [],
    srcDirs: [],
    hasTsConfig: false,
    hasStrictTs: null,
    hasTypeScript: false,
    testFramework: null,
    detectedLanguages: [],
  };

  // 1. package.json（仅读取非符号链接常规文件；绝不嵌入 scripts 原始命令值，只记录脚本名称）
  const pkgPath = path.join(wsPath, 'package.json');
  try {
    const pkgStat = fs.lstatSync(pkgPath);
    if (pkgStat.isSymbolicLink()) {
      warnings.push('Skipped symlink package.json');
    } else if (pkgStat.isFile()) {
      const pkgRaw = safeReadTextFileSync(pkgPath, wsPath, MAX_CONFIG_FILE_BYTES);
      if (pkgRaw === null) {
        warnings.push('Skipped unreadable or oversized package.json');
      } else {
        const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
        if (pkg && typeof pkg === 'object' && !Array.isArray(pkg)) {
          profile.hasPackageJson = true;

          const cleanName = sanitizeWorkspaceField(pkg.name, 120);
          if (cleanName) profile.name = cleanName;

          const cleanVer = sanitizeWorkspaceField(pkg.version, 32).replace(/[^a-zA-Z0-9._+-]/g, '');
          if (cleanVer) profile.version = cleanVer;

          const cleanDesc = sanitizeWorkspaceField(pkg.description, 120);
          if (cleanDesc) profile.description = cleanDesc;

          if (pkg.type === 'module') {
            profile.moduleType = 'ESM (type=module)';
          } else if (pkg.type === 'commonjs') {
            profile.moduleType = 'CommonJS';
          }

          if (pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)) {
            profile.scriptNames = Object.keys(pkg.scripts as Record<string, unknown>)
              .filter((k) => SAFE_SCRIPT_NAME_REGEX.test(k))
              .slice(0, 20);
          }

          const deps =
            pkg.dependencies && typeof pkg.dependencies === 'object' && !Array.isArray(pkg.dependencies)
              ? (pkg.dependencies as Record<string, unknown>)
              : {};
          const devDeps =
            pkg.devDependencies &&
            typeof pkg.devDependencies === 'object' &&
            !Array.isArray(pkg.devDependencies)
              ? (pkg.devDependencies as Record<string, unknown>)
              : {};
          const allDeps = { ...deps, ...devDeps };

          if ('vitest' in allDeps) profile.testFramework = 'Vitest';
          else if ('jest' in allDeps) profile.testFramework = 'Jest';
          else if ('mocha' in allDeps) profile.testFramework = 'Mocha';
          else if ('ava' in allDeps) profile.testFramework = 'AVA';

          if ('typescript' in allDeps) {
            profile.hasTypeScript = true;
          }
        }
      }
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      warnings.push(`Failed parsing package.json: ${(err as Error)?.message || String(err)}`);
    }
  }

  // 2. tsconfig.json（如实检测 strict 设置，绝不臆造）
  const tsPath = path.join(wsPath, 'tsconfig.json');
  try {
    const tsStat = fs.lstatSync(tsPath);
    if (tsStat.isSymbolicLink()) {
      warnings.push('Skipped symlink tsconfig.json');
    } else if (tsStat.isFile()) {
      const tsRaw = safeReadTextFileSync(tsPath, wsPath, MAX_CONFIG_FILE_BYTES);
      if (tsRaw === null) {
        warnings.push('Skipped unreadable or oversized tsconfig.json');
      } else {
        profile.hasTsConfig = true;
        profile.hasTypeScript = true;
        if (/"strict"\s*:\s*true/i.test(tsRaw)) {
          profile.hasStrictTs = true;
        } else if (/"strict"\s*:\s*false/i.test(tsRaw)) {
          profile.hasStrictTs = false;
        }
      }
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      warnings.push(`Failed reading tsconfig.json: ${(err as Error)?.message || String(err)}`);
    }
  }

  // 3. 如实检测实际存在的技术栈语言标记
  if (profile.hasTypeScript) {
    profile.detectedLanguages.push('TypeScript');
  } else if (profile.hasPackageJson) {
    profile.detectedLanguages.push('JavaScript');
  }
  if (
    isRegularNonSymlinkFile(path.join(wsPath, 'pyproject.toml'), wsPath) ||
    isRegularNonSymlinkFile(path.join(wsPath, 'requirements.txt'), wsPath)
  ) {
    profile.detectedLanguages.push('Python');
  }
  if (isRegularNonSymlinkFile(path.join(wsPath, 'Cargo.toml'), wsPath)) {
    profile.detectedLanguages.push('Rust');
  }
  if (isRegularNonSymlinkFile(path.join(wsPath, 'go.mod'), wsPath)) {
    profile.detectedLanguages.push('Go');
  }

  // 4. src/ 目录结构探测（拒绝符号链接目录及子项）
  const srcRoot = path.join(wsPath, 'src');
  if (isSafeWorkspaceSubdir(srcRoot, wsPath, warnings, 'src')) {
    try {
      const entries = fs.readdirSync(srcRoot, { withFileTypes: true });
      profile.srcDirs = entries
        .filter((e) => !e.isSymbolicLink() && e.isDirectory() && SAFE_DIR_NAME_REGEX.test(e.name))
        .map((e) => `src/${e.name}`)
        .slice(0, 8);
    } catch (err: unknown) {
      warnings.push(`Failed listing src/: ${(err as Error)?.message || String(err)}`);
    }
  }

  return profile;
}

/**
 * 安装后与首次启动自动记忆初始化引擎 (Auto-Bootstrap Memory Engine)
 * 幂等且遵守最小信任边界：
 * 1. 确保默认检索策略版本 (strategy_versions v1) 初始化
 * 2. 如实探测当前环境与工程结构，初始化 Letta Core Memory 常驻块（不臆造未声明的技术栈与语言偏好）
 * 3. 以 untrusted 隔离方式导入工作区已有的 .dsh/memory-bank / .dsh/memory / .dsh/viking-context
 * 4. 以 system 身份提取工作区结构化元数据种子记忆（不伪造 user 身份、不嵌入 scripts 命令体、不覆盖用户已编辑记忆）
 * 5. 全局只执行一次历史 DSH 会话回填（受 meta['bootstrap_backfill_v1'] 门控，除非 force=true）
 * 6. 补齐 128D 本地特征向量并运行 A-Mem Zettelkasten 双链织网
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
  const warnings: string[] = [];
  let criticalFailed = false;

  // 1. 确保检索策略表已初始化
  let strategyInitialized = false;
  try {
    const existingStrategies = listStrategies(db);
    if (existingStrategies.length === 0) {
      initDefaultStrategy(db, cfg);
      strategyInitialized = true;
    }
  } catch (err: unknown) {
    criticalFailed = true;
    warnings.push(`strategy init failed: ${(err as Error)?.message || String(err)}`);
  }

  if (isWorkspaceExcluded(wsPath, cfg.excludeWorkspaces)) {
    return {
      alreadyInitialized: false,
      workspaceId: wsId,
      strategyInitialized,
      coreBlocksInitialized: [],
      workspaceMemoriesSeeded: 0,
      markdownMemoriesImported: 0,
      backfillMemoriesCreated: 0,
      backfillEventsAdded: 0,
      embeddingsBackfilled: 0,
      linksWeaved: 0,
      warnings,
    };
  }

  // 本地登记 workspace_id -> 真实路径（供本地隐私脱敏与受控同步使用，不外泄）
  rememberWorkspacePath(db, wsPath);

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
      warnings,
    };
  }

  const profile = inspectWorkspaceProfile(wsPath, warnings);
  const coreBlocksInitialized: string[] = [];

  // 2. 如实初始化 Letta Core Memory 三大常驻块（绝不覆盖已存在的块，绝不臆造未声明的技术栈/语言偏好）
  try {
    if (!getCoreMemory(db, 'human', { workspaceId: wsId })) {
      const humanContent = [
        `- Runtime environment: ${os.platform()} (${os.arch()}), Node.js ${process.version}`,
        `- Preferences: Learn user language, style, and tooling preferences from explicit user instructions.`,
      ].join('\n');
      setCoreMemory(db, 'human', humanContent, { workspaceId: wsId, actor: 'system' });
      coreBlocksInitialized.push('human');
    }

    if (!getCoreMemory(db, 'persona', { workspaceId: wsId })) {
      const personaContent = [
        `- Role: Engineering pair-programming assistant focused on root-cause analysis and verifiable changes.`,
        `- Verification discipline: Run the workspace's declared build, typecheck, and test checks after code edits.`,
        `- Safety boundary: Never persist or exfiltrate secrets/credentials; keep migrations and memory edits reversible.`,
      ].join('\n');
      setCoreMemory(db, 'persona', personaContent, { workspaceId: wsId, actor: 'system' });
      coreBlocksInitialized.push('persona');
    }

    if (!getCoreMemory(db, 'project', { workspaceId: wsId })) {
      const preferredScripts = ['build', 'check', 'test', 'typecheck', 'lint', 'eval', 'init'].filter(
        (k) => profile.scriptNames.includes(k)
      );
      const displayScripts =
        preferredScripts.length > 0 ? preferredScripts : profile.scriptNames.slice(0, 6);

      const stackParts: string[] = [];
      if (profile.detectedLanguages.length > 0) {
        stackParts.push(profile.detectedLanguages.join('/'));
      }
      if (profile.moduleType) stackParts.push(profile.moduleType);
      if (profile.hasStrictTs === true) stackParts.push('TypeScript strict');
      if (profile.testFramework) stackParts.push(`Test: ${profile.testFramework}`);

      const projectLines = [
        `- Project: ${profile.name}${profile.version ? ` (v${profile.version})` : ''}${
          profile.description ? ` — ${profile.description}` : ''
        }`,
      ];
      if (displayScripts.length > 0) {
        projectLines.push(
          `- Declared scripts: ${displayScripts.map((k) => `npm run ${k}`).join(' · ')}`
        );
      }
      if (stackParts.length > 0) {
        projectLines.push(`- Detected stack: ${stackParts.join(' · ')}`);
      }
      if (profile.srcDirs.length > 0) {
        projectLines.push(`- Source directories: ${profile.srcDirs.join(', ')}`);
      }

      setCoreMemory(db, 'project', projectLines.join('\n'), { workspaceId: wsId, actor: 'system' });
      coreBlocksInitialized.push('project');
    }
  } catch (err: unknown) {
    criticalFailed = true;
    warnings.push(`core memory init failed: ${(err as Error)?.message || String(err)}`);
  }

  // 3. 以 untrusted 隔离模式自动导入工作区 .dsh/memory-bank / .dsh/memory / .dsh/viking-context
  let markdownMemoriesImported = 0;

  const bankDir = path.join(wsPath, '.dsh', 'memory-bank');
  if (isSafeWorkspaceSubdir(bankDir, wsPath, warnings, '.dsh/memory-bank')) {
    try {
      const bankRes = importMemoryBank(db, bankDir, { workspaceId: wsId, trusted: false });
      markdownMemoriesImported += bankRes.imported;
    } catch (err: unknown) {
      warnings.push(`memory-bank import failed: ${(err as Error)?.message || String(err)}`);
    }
  }

  const mdDir = path.join(wsPath, '.dsh', 'memory');
  if (isSafeWorkspaceSubdir(mdDir, wsPath, warnings, '.dsh/memory')) {
    try {
      const mdRes = importFromMarkdown(db, mdDir, {
        workspaceId: wsId,
        actor: 'maintenance',
        trusted: false,
      });
      markdownMemoriesImported += mdRes.importedCount + mdRes.updatedCount;
      for (const e of mdRes.errors.slice(0, 5)) {
        warnings.push(`markdown import: ${e}`);
      }
    } catch (err: unknown) {
      warnings.push(`markdown import failed: ${(err as Error)?.message || String(err)}`);
    }
  }

  const vikingDir = path.join(wsPath, '.dsh', 'viking-context');
  if (isSafeWorkspaceSubdir(vikingDir, wsPath, warnings, '.dsh/viking-context')) {
    try {
      const vkRes = importVikingContextTree(db, vikingDir, { workspaceId: wsId, trusted: false });
      markdownMemoriesImported += vkRes.importedCount + vkRes.updatedCount;
    } catch (err: unknown) {
      warnings.push(`viking-context import failed: ${(err as Error)?.message || String(err)}`);
    }
  }

  // 4. 提取工作区结构化元数据种子记忆（严格使用 system 身份，不嵌入 scripts 原始值，不臆造未声明技术栈）
  let workspaceMemoriesSeeded = 0;
  const seedCandidates: Array<{
    type: 'semantic' | 'procedural' | 'preference';
    slot_key: string;
    summary: string;
    content: string;
    importance: number;
  }> = [];

  const archDetails: string[] = [
    `Workspace ${profile.name}${profile.version ? ` (v${profile.version})` : ''}`,
  ];
  if (profile.description) {
    archDetails.push(`summary: ${profile.description}`);
  }
  if (profile.detectedLanguages.length > 0) {
    archDetails.push(`languages: ${profile.detectedLanguages.join(', ')}`);
  }
  if (profile.moduleType) {
    archDetails.push(`module format: ${profile.moduleType}`);
  }
  if (profile.srcDirs.length > 0) {
    archDetails.push(`source directories: ${profile.srcDirs.join(', ')}`);
  }
  seedCandidates.push({
    type: 'semantic',
    slot_key: 'project.architecture_overview',
    summary: `${profile.name} workspace architecture overview`,
    content: `${archDetails.join('; ')}.`,
    importance: 7,
  });

  if (profile.scriptNames.length > 0) {
    const listedScripts = profile.scriptNames
      .slice(0, 8)
      .map((name) => `npm run ${name}`)
      .join(', ');
    seedCandidates.push({
      type: 'procedural',
      slot_key: 'project.workflow_commands',
      summary: `${profile.name} declared npm scripts`,
      content: `Workspace ${profile.name} declares package.json scripts: ${listedScripts}.`,
      importance: 7,
    });
  }

  const conventionFacts: string[] = [];
  if (profile.hasStrictTs === true) {
    conventionFacts.push('TypeScript strict mode enabled in tsconfig.json');
  } else if (profile.hasStrictTs === false) {
    conventionFacts.push('TypeScript configured in tsconfig.json (strict=false)');
  } else if (profile.hasTsConfig) {
    conventionFacts.push('TypeScript configured via tsconfig.json');
  }
  if (profile.moduleType) {
    conventionFacts.push(`module system: ${profile.moduleType}`);
  }
  if (profile.testFramework) {
    conventionFacts.push(`test framework: ${profile.testFramework}`);
  }
  if (conventionFacts.length > 0) {
    seedCandidates.push({
      type: 'preference',
      slot_key: 'project.coding_conventions',
      summary: `${profile.name} declared build and test conventions`,
      content: `Workspace ${profile.name} declared conventions: ${conventionFacts.join('; ')}.`,
      importance: 6,
    });
  }

  seedCandidates.forEach((cand, idx) => {
    try {
      const existingSlot = db.get<{
        id: string;
        approved_by: string | null;
        version: number;
        status: string;
      }>(
        `SELECT id, approved_by, version, status
         FROM memories
         WHERE scope = 'workspace'
           AND COALESCE(workspace_id, '') = ?
           AND slot_key = ?
           AND status IN ('active', 'frozen')`,
        [wsId, cand.slot_key]
      );
      if (existingSlot) {
        if (existingSlot.status === 'frozen') return;
        const userEdited =
          (existingSlot.approved_by === 'user' && existingSlot.version > 1) ||
          existingSlot.approved_by === 'user' ||
          (existingSlot.version > 1 &&
            Boolean(
              db.get<{ v: number }>(
                `SELECT version AS v FROM memory_versions WHERE memory_id = ? AND actor = 'user' LIMIT 1`,
                [existingSlot.id]
              )
            ));
        // 永不覆盖用户编辑或批准过的槽位记忆（即使 force=true）
        if (userEdited) return;
        if (!options.force) return;
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
          source_kind: 'system',
          origin_kinds: ['system'],
          confidence: 0.8,
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
          actor: 'system',
        },
        now + idx
      );
      if (res.action === 'inserted' || res.action === 'superseded') {
        workspaceMemoriesSeeded++;
      }
    } catch (err: unknown) {
      criticalFailed = true;
      warnings.push(`seed '${cand.slot_key}' failed: ${(err as Error)?.message || String(err)}`);
    }
  });

  // 5. 全局单次历史 DSH 会话回填（受 bootstrap_backfill_v1 水位门控，避免切换工作区时重复全盘扫描）
  let backfillMemoriesCreated = 0;
  let backfillEventsAdded = 0;
  if (options.includeBackfill !== false) {
    const backfillKey = 'bootstrap_backfill_v1';
    const backfillDone = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
      backfillKey,
    ]);
    if (!backfillDone || options.force) {
      try {
        const bfStats = runBackfill(db, {
          sessionsDir: options.sessionsDir,
          cfg,
        });
        backfillMemoriesCreated = bfStats.memoriesCreated;
        backfillEventsAdded = bfStats.newEventsAdded;
        db.run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', [
          backfillKey,
          String(now),
        ]);
      } catch (err: unknown) {
        warnings.push(`backfill failed: ${(err as Error)?.message || String(err)}`);
      }
    }
  }

  // 6. 自动回填 128D 本地特征向量并执行 A-Mem Zettelkasten 关联双链织网
  let embeddingsBackfilled = 0;
  let linksWeaved = 0;
  try {
    embeddingsBackfilled = backfillMissingEmbeddings(db, { workspaceId: wsId, limit: 500 });
  } catch (err: unknown) {
    warnings.push(`embedding backfill failed: ${(err as Error)?.message || String(err)}`);
  }
  try {
    linksWeaved = weaveZettelkastenLinks(db, { workspaceId: wsId, maxNewLinks: 30, now });
  } catch (err: unknown) {
    warnings.push(`zettelkasten link weaving failed: ${(err as Error)?.message || String(err)}`);
  }

  // 7. 仅当关键初始化步骤未失败时，才标记当前工作区冷启动已完成
  if (!criticalFailed) {
    const summaryPayload = JSON.stringify({
      bootstrappedAt: now,
      version: profile.version,
      coreBlocksInitialized,
      workspaceMemoriesSeeded,
      backfillMemoriesCreated,
      embeddingsBackfilled,
      linksWeaved,
    });
    db.run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', [metaKey, summaryPayload]);
    db.run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', ['bootstrap_v1', String(now)]);
  }

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
    warnings,
  };
}
