import fs from 'node:fs';
import path from 'node:path';
import type { Db, MemoryRecord, MemoryStatus, MemoryType } from '../types.js';
import {
  get,
  list,
  stats,
  history,
  getGraphData,
  getSubgraph,
  renderMermaidGraph,
} from '../core/store.js';
import {
  approveCandidate,
  rollback as rollbackVersion,
  confirmMemory,
  mergeMemories,
  restoreMemory,
  pin as writerPin,
  unpin as writerUnpin,
  freeze as writerFreeze,
  unfreeze as writerUnfreeze,
} from '../core/writer.js';
import {
  exportToMarkdown,
  importFromMarkdown,
  restoreFromTrash,
  resolveTrashDir,
  exportMemoryBank,
  importMemoryBank,
  atomicWriteFileSync,
} from '../core/markdown.js';
import {
  getCoreMemory,
  getAllCoreMemories,
  setCoreMemory,
  renderCoreMemoryMarkdown,
} from '../core/core-memory.js';
import { reconcileAndUpsert } from '../evolution/reconciler.js';
import { auditMemoryHealth, autoHealMemoryHealth, weaveZettelkastenLinks } from '../core/health.js';
import { autoBootstrapMemory } from '../core/bootstrap.js';
import {
  runHindsightReflect,
  formatHindsightReflectReport,
} from '../core/hindsight.js';
import {
  resolveMemoryByVikingUriOrId,
  browseVikingDirectory,
  findInVikingTree,
  getVikingEvolutionDiff,
  formatVikingEvolutionDiff,
  exportVikingContextTree,
  importVikingContextTree,
} from '../core/viking.js';
import { workspaceId } from '../core/scope.js';
import { runBackfill } from '../ingest/backfill.js';
import { generateDataset } from '../eval/gen-dataset.js';
import { runEvalSuite } from '../eval/runner.js';
import { getLedgerUsage } from '../evolution/ledger.js';
import { runStrategyEvolution } from '../evolution/lab.js';
import { listStrategies, rollbackStrategy, initDefaultStrategy } from '../evolution/strategy.js';
import { approveRepairProposal, rejectRepairProposal, listRepairProposals } from '../evolution/repair.js';
import { exportDatabaseFile, importDatabaseFile } from '../evolution/maintenance.js';
import {
  forgetWithTrash,
  getMemoryDetail,
  importJsonMemories,
  queryInjectionTelemetry7d,
  VALID_MEMORY_TYPES,
} from '../service/index.js';
import { DEFAULTS, type PluginConfig } from '../config.js';
import {
  isWorkspaceOrMappedExcluded,
  resolveWorkspaceDir,
} from './scope-resolver.js';

export interface CommandContext {
  workspaceId: string;
  sessionId?: string;
  cwd?: string;
}

export interface CommandResult {
  kind: 'success' | 'error';
  text: string;
}

const VALID_LIST_STATUSES = new Set<MemoryStatus>([
  'active',
  'candidate',
  'frozen',
  'superseded',
  'archived',
]);

const STRICT_POSITIVE_INT_RE = /^\d+$/;
const MAX_LIST_PAGE = 1000;

/**
 * 支持双引号与单引号的命令行参数分词器（正确保留 Windows 路径中的反斜杠，如 "C:\My Docs\mem.json"）
 */
export function tokenizeCommandArgs(
  input: string
): { ok: true; tokens: string[] } | { ok: false; error: string } {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let tokenStarted = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (quote === '"' && ch === '\\' && i + 1 < input.length && (input[i + 1] === '"' || input[i + 1] === '\\')) {
        // 仅在双引号内转义 \" 与 \\（当后面紧跟 " 或 \），不破坏 Windows 路径分隔符如 \Users
        if (input[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          current += '\\';
          if (i + 2 < input.length && input[i + 2] === '"') {
            i++;
          }
        }
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      tokenStarted = true;
    } else if (/\s/.test(ch)) {
      if (tokenStarted) {
        tokens.push(current);
        current = '';
        tokenStarted = false;
      }
    } else {
      current += ch;
      tokenStarted = true;
    }
  }

  if (quote) {
    return { ok: false, error: 'Error: unclosed quote in command arguments.' };
  }
  if (tokenStarted) {
    tokens.push(current);
  }
  return { ok: true, tokens };
}

function okResult(text: string): CommandResult {
  return { kind: 'success', text };
}

function errResult(text: string): CommandResult {
  return { kind: 'error', text };
}

interface CommandEntry {
  name: string;
  aliases?: string[];
  usage: string;
  allowWhenExcluded?: boolean;
  execute: (
    self: MemoryCommands,
    rest: string[],
    ctx: CommandContext
  ) => CommandResult;
}

const COMMAND_TABLE: readonly CommandEntry[] = [
  {
    name: 'help',
    usage: 'help',
    allowWhenExcluded: true,
    execute: () => okResult(formatHelpText()),
  },
  {
    name: 'init',
    aliases: ['bootstrap'],
    usage: 'init [--force]',
    execute: (self, rest, ctx) =>
      okResult(self.init(ctx, rest.includes('--force') || rest.includes('force'))),
  },
  {
    name: 'stats',
    aliases: ['status'],
    usage: 'stats',
    execute: (self, _rest, ctx) => okResult(self.stats(ctx)),
  },
  {
    name: 'doctor',
    aliases: ['health'],
    usage: 'doctor [--fix]',
    execute: (self, rest, ctx) =>
      okResult(self.doctor(ctx, rest.includes('--fix') || rest.includes('fix'))),
  },
  {
    name: 'heal',
    usage: 'heal',
    execute: (self, _rest, ctx) => okResult(self.heal(ctx)),
  },
  {
    name: 'tree',
    aliases: ['viking', 'ls'],
    usage: 'tree [viking://uri] [--l1|--l2]',
    execute: (self, rest, ctx) => {
      const tier = rest.some((r) => /^--?l2$/i.test(r))
        ? 'L2'
        : rest.some((r) => /^--?l1$/i.test(r))
          ? 'L1'
          : 'L0';
      const nonFlagArgs = rest.filter((r) => !r.startsWith('-'));
      const uriArg = nonFlagArgs[0];
      const queryArg = nonFlagArgs.slice(1).join(' ').trim();
      const text = queryArg
        ? findInVikingTree(self.getDb(), {
            uri: uriArg,
            query: queryArg,
            workspaceId: ctx.workspaceId,
            sessionId: ctx.sessionId,
            tier: tier === 'L0' ? 'L1' : tier,
          })
        : browseVikingDirectory(self.getDb(), {
            uri: uriArg,
            workspaceId: ctx.workspaceId,
            sessionId: ctx.sessionId,
            tier,
          });
      return okResult(text);
    },
  },
  {
    name: 'find',
    usage: 'find [viking://uri] <query> [--l0|--l1|--l2]',
    execute: (self, rest, ctx) => {
      const tier = rest.some((r) => /^--?l2$/i.test(r))
        ? 'L2'
        : rest.some((r) => /^--?l0$/i.test(r))
          ? 'L0'
          : 'L1';
      const nonFlagArgs = rest.filter((r) => !r.startsWith('-'));
      if (nonFlagArgs.length === 0) {
        return errResult('Usage: /memory find [viking://uri] <query> [--l0|--l1|--l2]');
      }
      const hasUriFirst =
        nonFlagArgs.length >= 2 &&
        (nonFlagArgs[0].startsWith('viking://') ||
          /^(?:core|profile|preferences|entities|events|cases|skills|models)(?:\/|$)/i.test(
            nonFlagArgs[0]
          ));
      const uriArg = hasUriFirst ? nonFlagArgs[0] : 'viking://';
      const queryArg = (hasUriFirst ? nonFlagArgs.slice(1) : nonFlagArgs).join(' ').trim();
      if (!queryArg) {
        return errResult('Usage: /memory find [viking://uri] <query> [--l0|--l1|--l2]');
      }
      return okResult(
        findInVikingTree(self.getDb(), {
          uri: uriArg,
          query: queryArg,
          workspaceId: ctx.workspaceId,
          sessionId: ctx.sessionId,
          tier,
        })
      );
    },
  },
  {
    name: 'diff',
    aliases: ['viking-diff'],
    usage: 'diff',
    execute: (self, _rest, ctx) => {
      const cfg = self.getLiveConfig();
      return okResult(
        formatVikingEvolutionDiff(
          getVikingEvolutionDiff(self.getDb(), {
            workspaceId: ctx.workspaceId,
            sessionId: ctx.sessionId,
            excludeWorkspaces: cfg.excludeWorkspaces,
          })
        )
      );
    },
  },
  {
    name: 'reflect',
    usage: 'reflect [topic] [--no-synth]',
    execute: (self, rest, ctx) => {
      const cfg = self.getLiveConfig();
      const topic = rest.filter((r) => !r.startsWith('-')).join(' ').trim() || undefined;
      const report = runHindsightReflect(self.getDb(), {
        workspaceId: ctx.workspaceId,
        sessionId: ctx.sessionId,
        topic,
        autoSynthesize: !rest.includes('--no-synth'),
        excludeWorkspaces: cfg.excludeWorkspaces,
      });
      return okResult(formatHindsightReflectReport(report));
    },
  },
  {
    name: 'inspect',
    usage: 'inspect <id|viking://uri>',
    execute: (self, rest, ctx) => {
      const target = (rest[0] || '').trim();
      if (!target) return errResult('Usage: /memory inspect <id|viking://uri>');
      const out = self.inspect(target, ctx);
      if (out.startsWith('Error:') || out.startsWith('Usage:') || out.includes('not found')) {
        return errResult(out);
      }
      return okResult(out);
    },
  },
  {
    name: 'list',
    usage: 'list [type] [status] [page]',
    execute: (self, rest, ctx) => {
      const listFilter: { type?: MemoryType; status?: MemoryStatus; limit?: number; offset?: number } = {};
      for (const arg of rest) {
        const low = arg.toLowerCase();
        if (STRICT_POSITIVE_INT_RE.test(low)) {
          const parsedPage = parseInt(low, 10);
          if (parsedPage < 1) {
            return errResult('Error: page number must be between 1 and 1000.');
          }
          const clampedPage = Math.min(MAX_LIST_PAGE, parsedPage);
          listFilter.offset = (clampedPage - 1) * 20;
        } else if (VALID_LIST_STATUSES.has(low as MemoryStatus)) {
          listFilter.status = low as MemoryStatus;
        } else if (VALID_MEMORY_TYPES.has(low as MemoryType)) {
          listFilter.type = low as MemoryType;
        } else {
          return errResult(
            `Error: invalid list argument '${arg}'. Usage: /memory list [type] [status] [page(1..1000)]`
          );
        }
      }
      return okResult(self.list(listFilter, ctx));
    },
  },
  {
    name: 'confirm',
    usage: 'confirm <id>',
    execute: (self, rest, ctx) => {
      const target = (rest[0] || '').trim();
      if (!target) return errResult('Usage: /memory confirm <id>');
      const out = self.confirm(target, ctx);
      if (out.startsWith('Error:') || out.includes('not found')) return errResult(out);
      return okResult(out);
    },
  },
  {
    name: 'merge',
    usage: 'merge <src> <tgt>',
    execute: (self, rest, ctx) => {
      const src = (rest[0] || '').trim();
      const tgt = (rest[1] || '').trim();
      if (!src || !tgt) return errResult('Usage: /memory merge <sourceId> <targetId>');
      const out = self.merge(src, tgt, ctx);
      if (out.startsWith('Error:') || out.startsWith('Usage:') || out.includes('not found')) {
        return errResult(out);
      }
      return okResult(out);
    },
  },
  {
    name: 'restore',
    usage: 'restore <id>',
    execute: (self, rest, ctx) => {
      const target = (rest[0] || '').trim();
      if (!target) return errResult('Usage: /memory restore <id>');
      const out = self.restore(target, ctx);
      if (out.startsWith('Error:') || out.includes('not found') || out.includes('Cannot restore')) {
        return errResult(out);
      }
      return okResult(out);
    },
  },
  {
    name: 'core',
    usage: 'core [block] [text]',
    execute: (self, rest, ctx) => {
      const block = rest[0];
      const content = rest.slice(1).join(' ').trim();
      const wsId = workspaceId(ctx.workspaceId);
      if (block && content) {
        const res = setCoreMemory(self.getDb(), block, content, { workspaceId: wsId, actor: 'user' });
        return okResult(`Core memory block '${block}' ${res.action} successfully (id: ${res.id}).`);
      }
      if (block) {
        const entry = getCoreMemory(self.getDb(), block, { workspaceId: wsId });
        return okResult(
          entry
            ? `[CORE MEMORY: ${entry.block.toUpperCase()}] (v${entry.version})\n${entry.content}`
            : `Core memory block '${block}' is empty.`
        );
      }
      const all = getAllCoreMemories(self.getDb(), { workspaceId: wsId });
      return okResult(
        all.length > 0
          ? renderCoreMemoryMarkdown(all)
          : 'No core memory blocks configured. Usage: /memory core <human|persona|project> <content>'
      );
    },
  },
  {
    name: 'reconcile',
    usage: 'reconcile <content>',
    execute: (self, rest, ctx) => {
      const content = rest.join(' ').trim();
      if (!content) return errResult('Usage: /memory reconcile <content>');
      const wsId = workspaceId(ctx.workspaceId);
      const sessId = ctx.sessionId || 'default_session';
      const res = reconcileAndUpsert(self.getDb(), {
        type: 'semantic',
        content,
        scope: 'workspace',
        workspaceId: wsId,
        sessionId: sessId,
        source_kind: 'user',
        confidence: 0.9,
        importance: 8,
        status: 'active',
        origin_kinds: ['user'],
        sources: [{ session_id: sessId, seq: 0, kind: 'manual', excerpt: content }],
        actor: 'user',
      });
      return okResult(
        `Reconciliation finished: action=${res.decision.action} (${res.decision.reason}), databaseAction=${res.action}`
      );
    },
  },
  {
    name: 'graph',
    usage: 'graph [limit|<id>]',
    execute: (self, rest, ctx) => {
      const out = self.graph(rest[0], ctx);
      if (out.includes('not found in current scope')) return errResult(out);
      return okResult(out);
    },
  },
  {
    name: 'export-viking',
    usage: 'export-viking [dir]',
    execute: (self, rest, ctx) => {
      const cfg = self.getLiveConfig();
      const wsDir = resolveWorkspaceDir(ctx, self.getDb());
      const targetDir = rest[0] || path.join(wsDir, '.dsh', 'viking-context');
      const res = exportVikingContextTree(self.getDb(), targetDir, {
        workspaceId: ctx.workspaceId,
        excludeWorkspaces: cfg.excludeWorkspaces,
      });
      return okResult(
        `Successfully exported ${res.totalMemories} memories across [${res.categoriesExported.join(', ')}] (with L0 .abstract.md, L1 .overview.md, and L2 .md files) to OpenViking context tree at: ${res.dir}`
      );
    },
  },
  {
    name: 'import-viking',
    usage: 'import-viking [dir] [--trust]',
    execute: (self, rest, ctx) => {
      const trusted = rest.includes('--trust');
      const nonFlags = rest.filter((r) => !r.startsWith('-'));
      const wsDir = resolveWorkspaceDir(ctx, self.getDb());
      const sourceDir = nonFlags[0] || path.join(wsDir, '.dsh', 'viking-context');
      const res = importVikingContextTree(self.getDb(), sourceDir, {
        workspaceId: ctx.workspaceId,
        trusted,
      });
      return okResult(
        `Successfully imported OpenViking context tree from ${sourceDir} (trusted=${trusted}): ${res.importedCount} inserted, ${res.updatedCount} updated (${res.skippedIndexes} L0/L1 index files skipped).`
      );
    },
  },
  {
    name: 'export-md',
    usage: 'export-md [dir]',
    execute: (self, rest, ctx) => {
      const wsDir = resolveWorkspaceDir(ctx, self.getDb());
      const targetDir = rest[0] || path.join(wsDir, '.dsh', 'memory');
      return okResult(self.exportToMarkdownDir(targetDir, ctx));
    },
  },
  {
    name: 'import-md',
    usage: 'import-md [dir]',
    execute: (self, rest, ctx) => {
      const wsDir = resolveWorkspaceDir(ctx, self.getDb());
      const sourceDir = rest[0] || path.join(wsDir, '.dsh', 'memory');
      return okResult(self.importFromMarkdownDir(sourceDir, ctx));
    },
  },
  {
    name: 'export-bank',
    usage: 'export-bank [dir]',
    execute: (self, rest, ctx) => {
      const wsDir = resolveWorkspaceDir(ctx, self.getDb());
      const targetDir = rest[0] || path.join(wsDir, '.dsh', 'memory-bank');
      const res = exportMemoryBank(self.getDb(), targetDir, { workspaceId: ctx.workspaceId });
      return okResult(
        `Successfully exported ${res.totalMemories} memories to Memory Bank at: ${targetDir}\nFiles: ${res.filesWritten.map((f) => path.basename(f)).join(', ')}`
      );
    },
  },
  {
    name: 'import-bank',
    usage: 'import-bank [dir] [--untrusted]',
    execute: (self, rest, ctx) => {
      const untrusted = rest.includes('--untrusted');
      const nonFlags = rest.filter((r) => !r.startsWith('-'));
      const wsDir = resolveWorkspaceDir(ctx, self.getDb());
      const sourceDir = nonFlags[0] || path.join(wsDir, '.dsh', 'memory-bank');
      const res = importMemoryBank(self.getDb(), sourceDir, {
        workspaceId: ctx.workspaceId,
        trusted: !untrusted,
      });
      return okResult(
        `Successfully processed ${res.filesProcessed} files and imported/updated ${res.imported} memories from Memory Bank at: ${sourceDir}`
      );
    },
  },
  {
    name: 'migrate',
    usage: 'migrate <markdown|json> <path>',
    execute: (self, rest, ctx) => {
      const format = (rest[0] || '').trim();
      const sourcePath = (rest[1] || '').trim();
      if (!format || !sourcePath) {
        return errResult('Usage: /memory migrate <markdown|json> <path>');
      }
      const out = self.migrate(format, sourcePath, ctx);
      if (out.startsWith('Error:') || out.startsWith('Usage:')) return errResult(out);
      return okResult(out);
    },
  },
  {
    name: 'history',
    usage: 'history <id>',
    execute: (self, rest, ctx) => {
      const target = (rest[0] || '').trim();
      if (!target) return errResult('Usage: /memory history <id>');
      const wsId = workspaceId(ctx.workspaceId);
      let mem: MemoryRecord | undefined;
      try {
        mem = get(self.getDb(), target, { workspaceId: wsId, sessionId: ctx.sessionId });
      } catch (err: any) {
        return errResult(err?.message || `Error resolving memory '${target}'`);
      }
      if (!mem) {
        return errResult(`Memory '${target}' not found in current scope.`);
      }
      const hist = history(self.getDb(), mem.id);
      if (hist.length === 0) {
        return okResult(`No history found for memory '${target}'.`);
      }
      return okResult(
        hist
          .map(
            (h) =>
              `v${h.version} (${new Date(h.created_at).toISOString()}, by ${h.actor}): ${h.snapshot?.summary || h.snapshot?.content?.slice(0, 60) || h.reason}`
          )
          .join('\n')
      );
    },
  },
  {
    name: 'rollback',
    usage: 'rollback <id> <version>',
    execute: (self, rest, ctx) => {
      const target = (rest[0] || '').trim();
      const rawVer = (rest[1] || '').trim();
      if (!target || !STRICT_POSITIVE_INT_RE.test(rawVer)) {
        return errResult('Usage: /memory rollback <id> <version>');
      }
      const targetVersion = parseInt(rawVer, 10);
      if (targetVersion < 1) {
        return errResult('Usage: /memory rollback <id> <version>');
      }
      const wsId = workspaceId(ctx.workspaceId);
      const mem = get(self.getDb(), target, { workspaceId: wsId, sessionId: ctx.sessionId });
      if (!mem) {
        return errResult(`Memory '${target}' not found in current scope.`);
      }
      const res = rollbackVersion(self.getDb(), mem.id, targetVersion, 'user', Date.now());
      return okResult(
        `Memory ${mem.id} rolled back to version ${targetVersion} (new version v${res.version}).`
      );
    },
  },
  {
    name: 'forget',
    usage: 'forget <id>',
    execute: (self, rest, ctx) => {
      const target = (rest[0] || '').trim();
      if (!target) return errResult('Usage: /memory forget <id>');
      const out = self.forget(target, ctx);
      if (out.startsWith('Error:') || out.includes('not found') || out.includes('cannot')) {
        return errResult(out);
      }
      return okResult(out);
    },
  },
  {
    name: 'pin',
    usage: 'pin <id>',
    execute: (self, rest, ctx) => {
      const target = (rest[0] || '').trim();
      if (!target) return errResult('Usage: /memory pin <id>');
      const out = self.setPin(target, true, ctx);
      if (out.startsWith('Error:') || out.includes('not found')) return errResult(out);
      return okResult(out);
    },
  },
  {
    name: 'unpin',
    usage: 'unpin <id>',
    execute: (self, rest, ctx) => {
      const target = (rest[0] || '').trim();
      if (!target) return errResult('Usage: /memory unpin <id>');
      const out = self.setPin(target, false, ctx);
      if (out.startsWith('Error:') || out.includes('not found')) return errResult(out);
      return okResult(out);
    },
  },
  {
    name: 'freeze',
    usage: 'freeze <id>',
    execute: (self, rest, ctx) => {
      const target = (rest[0] || '').trim();
      if (!target) return errResult('Usage: /memory freeze <id>');
      const out = self.setFreeze(target, true, ctx);
      if (out.startsWith('Error:') || out.includes('not found') || out.includes('cannot')) {
        return errResult(out);
      }
      return okResult(out);
    },
  },
  {
    name: 'unfreeze',
    usage: 'unfreeze <id>',
    execute: (self, rest, ctx) => {
      const target = (rest[0] || '').trim();
      if (!target) return errResult('Usage: /memory unfreeze <id>');
      const out = self.setFreeze(target, false, ctx);
      if (out.startsWith('Error:') || out.includes('not found') || out.includes('cannot')) {
        return errResult(out);
      }
      return okResult(out);
    },
  },
  {
    name: 'approve',
    usage: 'approve <id>',
    execute: (self, rest, ctx) => {
      const target = (rest[0] || '').trim();
      if (!target) return errResult('Usage: /memory approve <id>');
      const out = self.approve(target, ctx);
      if (out.startsWith('Error:') || out.startsWith('Failed') || out.includes('not found')) {
        return errResult(out);
      }
      return okResult(out);
    },
  },
  {
    name: 'pending',
    usage: 'pending',
    execute: (self, _rest, ctx) => okResult(self.pending(ctx)),
  },
  {
    name: 'approve-repair',
    usage: 'approve-repair <proposalId>',
    execute: (self, rest, ctx) => {
      const rawId = (rest[0] || '').trim();
      if (!STRICT_POSITIVE_INT_RE.test(rawId)) {
        return errResult('Usage: /memory approve-repair <proposalId>');
      }
      const pId = parseInt(rawId, 10);
      const wsId = workspaceId(ctx.workspaceId);
      const propRow = self
        .getDb()
        .get<{ memory_id: string }>('SELECT memory_id FROM repair_proposals WHERE id = ?', [pId]);
      if (propRow && !get(self.getDb(), propRow.memory_id, { workspaceId: wsId, sessionId: ctx.sessionId })) {
        return errResult(
          `Failed to approve repair proposal #${pId}: Proposal #${pId} not found in current scope.`
        );
      }
      const res = approveRepairProposal(self.getDb(), pId);
      return res.ok
        ? okResult(`Repair proposal #${pId} approved successfully.`)
        : errResult(`Failed to approve repair proposal #${pId}: ${res.reason}`);
    },
  },
  {
    name: 'reject-repair',
    usage: 'reject-repair <proposalId>',
    execute: (self, rest, ctx) => {
      const rawId = (rest[0] || '').trim();
      if (!STRICT_POSITIVE_INT_RE.test(rawId)) {
        return errResult('Usage: /memory reject-repair <proposalId>');
      }
      const pId = parseInt(rawId, 10);
      const wsId = workspaceId(ctx.workspaceId);
      const propRow = self
        .getDb()
        .get<{ memory_id: string }>('SELECT memory_id FROM repair_proposals WHERE id = ?', [pId]);
      if (propRow && !get(self.getDb(), propRow.memory_id, { workspaceId: wsId, sessionId: ctx.sessionId })) {
        return errResult(
          `Failed to reject repair proposal #${pId}: Proposal #${pId} not found in current scope.`
        );
      }
      const res = rejectRepairProposal(self.getDb(), pId);
      return res.ok
        ? okResult(`Repair proposal #${pId} rejected.`)
        : errResult(`Failed to reject repair proposal #${pId}: ${res.reason}`);
    },
  },
  {
    name: 'evolve',
    usage: 'evolve',
    execute: (self) => {
      const res = runStrategyEvolution(self.getDb(), {}, self.getLiveConfig());
      if (res.promoted) {
        const recallPct = ((res.bestMetrics?.recallAtInject ?? 0) * 100).toFixed(1);
        return okResult(
          `策略实验室进化成功！已晋升至版本 v${res.promotedVersion}（Recall: ${recallPct}%, 平均 Token: ${res.bestMetrics?.avgInjectTokens ?? 0}）`
        );
      }
      return okResult(`策略实验室未发现满足晋升条件的候选：${res.reason || '无更优候选'}`);
    },
  },
  {
    name: 'strategy',
    usage: 'strategy [list|rollback <v>]',
    execute: (self, rest) => {
      const action = rest[0]?.toLowerCase();
      if (action === 'rollback') {
        let targetV: number | undefined;
        if (rest[1] !== undefined) {
          if (!STRICT_POSITIVE_INT_RE.test(rest[1])) {
            return errResult('Usage: /memory strategy rollback [version]');
          }
          targetV = parseInt(rest[1], 10);
        }
        const res = rollbackStrategy(self.getDb(), targetV);
        return res.ok
          ? okResult(`策略已成功回滚至版本 v${res.rolledBackTo}。`)
          : errResult(`策略回滚失败：${res.reason}`);
      }
      let strats = listStrategies(self.getDb());
      if (strats.length === 0) {
        initDefaultStrategy(self.getDb(), self.getLiveConfig());
        strats = listStrategies(self.getDb());
      }
      return okResult(
        strats
          .map(
            (s) =>
              `v${s.version} [${s.status}] (parent: ${s.parent ?? 'none'}, dynamicBudget: ${s.config.dynamicBudgetTokens}, maxItems: ${s.config.maxItems}, rrfK: ${s.config.rrfK})`
          )
          .join('\n')
      );
    },
  },
  {
    name: 'backfill',
    usage: 'backfill [--dry-run]',
    execute: (self, rest) => {
      const dryRun = rest.includes('--dry-run');
      const liveCfg = self.getLiveConfig();
      // P0 修复：显式传递 liveCfg，确保 excludeWorkspaces 等配置生效
      const st = runBackfill(self.getDb(), { dryRun, cfg: liveCfg });
      return okResult(
        `Backfill ${dryRun ? '(dry-run)' : 'completed'}: raw=${st.rawEvents}, filtered=${st.filteredEvents}, privacyRejected=${st.privacyRejected}, writable=${st.writableEvents}, added=${st.newEventsAdded}, memories=${st.memoriesCreated}, processedFiles=${st.processedFiles}`
      );
    },
  },
  {
    name: 'eval',
    usage: 'eval [suite]',
    execute: (_self, rest) => {
      const suite = rest[0];
      const allCases = generateDataset();
      const cases = suite
        ? allCases.filter((c) => c.suite.toLowerCase() === suite.toLowerCase())
        : allCases;
      if (cases.length === 0) {
        return errResult(
          `No test cases found for suite '${suite}'. (Options: factual, temporal, procedural, implicit)`
        );
      }
      const report = runEvalSuite(cases);
      return okResult(
        [
          `评测集 ${suite || '全部'}（${report.overall.passedCases}/${report.overall.totalCases} 通过）：`,
          `Recall@Inject: ${(report.overall.recallAtInject * 100).toFixed(1)}%`,
          `Exclude 违规: ${report.overall.excludeViolations}`,
          `空门槛精度: ${(report.overall.emptyPrecision * 100).toFixed(1)}%`,
          `Critical 通过率: ${(report.overall.criticalPassRate * 100).toFixed(1)}% (${report.overall.criticalPassed}/${report.overall.criticalTotal})`,
          `平均注入 Tokens: ${report.overall.avgInjectTokens}`,
          `P95 延迟: ${report.overall.p95LatencyMs.toFixed(1)}ms`,
          `MVP 门槛: ${report.mvpPassed ? '已达标 (PASS)' : '未达标 (FAIL)'}`,
        ].join('\n')
      );
    },
  },
  {
    name: 'budget',
    usage: 'budget',
    allowWhenExcluded: true,
    execute: (self) => {
      const usage = getLedgerUsage(self.getDb(), undefined, self.getLiveConfig());
      return okResult(
        [
          `今日离线 LLM 用量（${usage.day}）：`,
          `调用次数: ${usage.callsCount} / ${usage.callsLimit}`,
          `Token 消耗: ${usage.tokensConsumed.toLocaleString()} / ${usage.tokensLimit.toLocaleString()}`,
          `已结算: ${usage.tokensSettled.toLocaleString()} Tokens`,
          `预留/处理中: ${usage.tokensPending.toLocaleString()} Tokens`,
        ].join('\n')
      );
    },
  },
  {
    name: 'export',
    usage: 'export [path] [--force]',
    execute: (self, rest, ctx) => {
      const force = rest.includes('--force');
      const nonFlags = rest.filter((r) => !r.startsWith('-'));
      const wsDir = resolveWorkspaceDir(ctx, self.getDb());
      const targetPath = nonFlags[0] || path.join(wsDir, 'memory-export.db');
      if (targetPath.endsWith('.json')) {
        const out = self.exportToJson(targetPath, ctx, force);
        return out.startsWith('Error:') ? errResult(out) : okResult(out);
      }
      const res = exportDatabaseFile(self.getDb(), self.getDb().filePath || '', targetPath);
      return res.success
        ? okResult(`Successfully exported database to ${res.path}`)
        : errResult(`Error exporting database: ${res.error}`);
    },
  },
  {
    name: 'import',
    usage: 'import [path]',
    execute: (self, rest, ctx) => {
      const wsDir = resolveWorkspaceDir(ctx, self.getDb());
      const sourcePath = rest[0] || path.join(wsDir, 'memory-export.db');
      if (sourcePath.endsWith('.json')) {
        const out = self.importFromJson(sourcePath, ctx);
        return out.startsWith('Error:') ? errResult(out) : okResult(out);
      }
      const res = importDatabaseFile(self.getDb(), self.getDb().filePath || '', sourcePath);
      return res.success
        ? okResult(`Successfully imported ${res.importedRecords} memories from ${sourcePath}`)
        : errResult(`Error importing database: ${res.error}`);
    },
  },
];

const COMMAND_MAP = new Map<string, CommandEntry>();
for (const entry of COMMAND_TABLE) {
  COMMAND_MAP.set(entry.name, entry);
  if (entry.aliases) {
    for (const alias of entry.aliases) {
      COMMAND_MAP.set(alias, entry);
    }
  }
}

export function formatHelpText(): string {
  const usages = COMMAND_TABLE.filter((c) => c.name !== 'help').map((c) => c.usage);
  return `Available commands: ${usages.join(' | ')}`;
}

export function getMemoryCommandHint(): string {
  return COMMAND_TABLE.filter((c) => c.name !== 'help')
    .map((c) => c.usage)
    .join(' | ');
}

export class MemoryCommands {
  private db: Db;
  private cfg: PluginConfig;
  private getCfg?: () => PluginConfig;

  constructor(db: Db, cfg: PluginConfig = DEFAULTS, getCfg?: () => PluginConfig) {
    this.db = db;
    this.cfg = cfg;
    this.getCfg = getCfg;
  }

  /** @internal */
  public getDb(): Db {
    return this.db;
  }

  /** @internal */
  public getLiveConfig(): PluginConfig {
    return this.getCfg ? this.getCfg() : this.cfg;
  }

  private isExcluded(ctx?: CommandContext): boolean {
    if (!ctx?.workspaceId && !ctx?.cwd) return false;
    const cfg = this.getLiveConfig();
    return (
      isWorkspaceOrMappedExcluded(ctx.workspaceId, cfg.excludeWorkspaces, this.db) ||
      isWorkspaceOrMappedExcluded(ctx.cwd, cfg.excludeWorkspaces, this.db)
    );
  }

  /**
   * /memory init [--force] (工作区冷启动自动初始化记忆)
   */
  public init(ctx: CommandContext, force: boolean = false): string {
    const cfg = this.getLiveConfig();
    const wsPath = resolveWorkspaceDir(ctx, this.db);
    const res = autoBootstrapMemory(this.db, {
      workspacePath: wsPath,
      cfg,
      force,
      includeBackfill: true,
    });
    if (res.alreadyInitialized && !force) {
      return `✅ 当前工作区 (${res.workspaceId}) 已完成冷启动初始化。如需强制重新扫描工程并同步初始化，请运行: /memory init --force`;
    }
    return [
      `🚀 工作区记忆冷启动初始化完成 (${res.workspaceId})：`,
      `  • Letta 常驻核心块: ${
        res.coreBlocksInitialized.length > 0
          ? res.coreBlocksInitialized.join(', ')
          : 'human, persona, project (已就绪)'
      }`,
      `  • 工作区冷启动种子记忆: +${res.workspaceMemoriesSeeded} 条 | Markdown 导入: +${res.markdownMemoriesImported} 条`,
      `  • 历史 DSH 会话回填: +${res.backfillEventsAdded} 条事件 -> 提炼 +${res.backfillMemoriesCreated} 条规则记忆`,
      `  • 128D 本地向量回填: ${res.embeddingsBackfilled} 条 | A-Mem 自动双链织网: +${res.linksWeaved} 条关联边`,
    ].join('\n');
  }

  /**
   * /memory stats (§6.7)
   */
  public stats(ctx: CommandContext): string {
    const cfg = this.getLiveConfig();
    const wsId = workspaceId(ctx.workspaceId);
    const st = stats(this.db, wsId, ctx.sessionId);

    const active = st.byStatus['active'] || 0;
    const candidate = st.byStatus['candidate'] || 0;
    const superseded = st.byStatus['superseded'] || 0;
    const archived = st.byStatus['archived'] || 0;
    const frozen = st.byStatus['frozen'] || 0;

    const typeParts = Object.entries(st.byType)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ');

    // 委托单一真相源 queryInjectionTelemetry7d 统计近 7 天注入与纠正率
    const telemetry = queryInjectionTelemetry7d(this.db, {
      workspaceId: wsId,
      excludeWorkspaces: cfg.excludeWorkspaces,
    });

    return [
      `记忆总数 ${st.total.toLocaleString()}（active ${active} / candidate ${candidate} / superseded ${superseded} / archived ${archived}${frozen > 0 ? ` / frozen ${frozen}` : ''}）`,
      `类型分布 ${typeParts || '无'}`,
      `近 7 天：注入 ${telemetry.totalInjections} 轮，平均 ${telemetry.avgTokens} tokens/turn，纠正率 ${telemetry.correctionRate.toFixed(1)}%`,
    ].join('\n');
  }

  /**
   * /memory doctor [--fix] (记忆库健康度体检与冲突医生)
   */
  public doctor(ctx: CommandContext, autoFix: boolean = false): string {
    if (autoFix) {
      return this.heal(ctx);
    }
    const cfg = this.getLiveConfig();
    const wsId = workspaceId(ctx.workspaceId);
    const report = auditMemoryHealth(this.db, {
      workspaceId: wsId,
      sessionId: ctx.sessionId,
      excludeWorkspaces: cfg.excludeWorkspaces,
    });
    const lines = [
      `🩺 记忆库健康度体检报告：${report.score}/100 (等级 ${report.grade})`,
      `状态分布：active ${report.counts.active} · candidate ${report.counts.candidate} · frozen ${report.counts.frozen} · superseded ${report.counts.superseded} · archived ${report.counts.archived} (置顶 ${report.counts.pinned})`,
      `FTS5 索引：${report.ftsConsistent ? '一致 (OK)' : '不一致 (需重建)'} (${report.ftsCount} 行) | 向量索引：${report.embeddingsReadyCount ?? 0} 已就绪 / ${report.missingEmbeddingsCount ?? 0} 待回填`,
      `冗余/同槽位冲突对：${report.duplicatePairs.length} 对 | 活跃矛盾关系：${report.contradictions.length} 组 | 陈旧低效用记忆：${report.staleMemories.length} 条 | 孤岛节点：${report.orphanMemoriesCount ?? 0} 条`,
    ];
    if (report.duplicatePairs.length > 0) {
      lines.push('待去重记忆对 (可执行 /memory merge <src> <tgt> 或 /memory heal 一键自愈):');
      for (const pair of report.duplicatePairs.slice(0, 5)) {
        lines.push(
          `  - ${pair.sourceId} -> ${pair.targetId} (相似度 ${pair.similarity}, 原因: ${pair.reason})`
        );
      }
    }
    if (report.recommendations.length > 0) {
      lines.push('优化建议：');
      for (const rec of report.recommendations) {
        lines.push(`  • ${rec}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * /memory heal (一键智能自愈修复)
   */
  public heal(ctx: CommandContext): string {
    const cfg = this.getLiveConfig();
    const wsId = workspaceId(ctx.workspaceId);
    const res = autoHealMemoryHealth(this.db, {
      workspaceId: wsId,
      sessionId: ctx.sessionId,
      excludeWorkspaces: cfg.excludeWorkspaces,
    });
    return [
      `⚡ 记忆库一键智能自愈完成：健康分 ${res.beforeScore} -> ${res.afterScore}/100 (等级 ${res.afterGrade})`,
      `修复明细：FTS5 重建=${res.ftsRebuilt ? '是' : '否'} · 本地向量回填=${res.embeddingsBackfilled} 条 · 合并冗余对=${res.duplicatesMerged} 对 · 消解矛盾链=${res.contradictionsResolved} 组 · A-Mem 自动织网=${res.linksWeaved} 条`,
    ].join('\n');
  }

  /**
   * /memory inspect <idOrVikingUri> (委托 service/memory-service.ts:getMemoryDetail)
   */
  public inspect(idOrShortId: string, ctx: CommandContext): string {
    const rawId = (idOrShortId || '').trim();
    if (!rawId) return 'Usage: /memory inspect <id|viking://uri>';

    const cfg = this.getLiveConfig();
    const wsId = workspaceId(ctx.workspaceId);
    const scopeCtx = { workspaceId: wsId, sessionId: ctx.sessionId };

    let resolvedId = rawId;
    if (rawId.toLowerCase().startsWith('viking://')) {
      try {
        const byUri = resolveMemoryByVikingUriOrId(this.db, rawId, scopeCtx);
        if (!byUri) {
          return `Memory '${rawId}' not found in current scope.`;
        }
        resolvedId = byUri.id;
      } catch (err: any) {
        return `Error: ${err?.message || 'Lookup failed'}`;
      }
    }

    let detail: ReturnType<typeof getMemoryDetail>;
    try {
      detail = getMemoryDetail(this.db, resolvedId, {
        scopeCtx,
        excludeWorkspaces: cfg.excludeWorkspaces,
      });
    } catch (err: any) {
      return `Error: ${err?.message || 'Lookup failed'}`;
    }

    if (!detail) {
      return `Memory '${rawId}' not found in current scope.`;
    }

    const mem = detail.memory;
    const srcLines = detail.sources.map(
      (s) =>
        `  - Session: ${s.session_id} | seq: ${s.seq} | kind: ${s.kind}${s.excerpt ? ` | excerpt: "${s.excerpt}"` : ''}`
    );
    const relLines = detail.relations.map((r) =>
      r.direction === 'outgoing'
        ? `  - [${r.rel}] -> ${r.to_id}`
        : `  - [${r.rel}] <- ${r.from_id}`
    );

    const lines = [
      `ID: ${mem.id} (rev ${mem.content_rev}, v${mem.version})`,
      `Type: ${mem.type} | Network: ${detail.hindsightNetwork.toUpperCase()} | Status: ${mem.status} | Scope: ${mem.scope}${mem.slot_key ? ` | Slot: ${mem.slot_key}` : ''}`,
      `Viking URI: ${detail.vikingUri}`,
      `Workspace: ${mem.workspace_id || 'global'} | Pinned: ${mem.pinned ? 'yes' : 'no'}`,
      `Confidence: ${mem.confidence.toFixed(2)} | Utility: ${mem.utility.toFixed(2)}`,
      `Stats: used ${mem.use_count} times (ok ${mem.success_count} / fail ${mem.fail_count})`,
      `Created: ${new Date(mem.created_at).toISOString()} | Updated: ${new Date(mem.updated_at).toISOString()}`,
      `Summary: ${mem.summary}`,
      `Content:\n${mem.content}`,
    ];

    if (srcLines.length > 0) {
      lines.push(`Sources (${srcLines.length}):\n${srcLines.join('\n')}`);
    } else {
      lines.push('Sources: none');
    }

    if (relLines.length > 0) {
      lines.push(`Relations:\n${relLines.join('\n')}`);
    }

    if (detail.hindsightTrace.timeline.length > 1) {
      const tlLines = detail.hindsightTrace.timeline.map(
        (n) =>
          `  - [${n.relationToCurrent}] ${n.id} (v${n.version}, ${n.status}, c=${n.confidence.toFixed(2)}): ${n.summary}`
      );
      lines.push(`Hindsight Evolution Timeline:\n${tlLines.join('\n')}`);
    }

    return lines.join('\n');
  }

  /**
   * /memory list [type] [status] [page]
   */
  public list(
    filter: { type?: MemoryType; status?: MemoryStatus; limit?: number; offset?: number },
    ctx: CommandContext
  ): string {
    const wsId = workspaceId(ctx.workspaceId);
    const records = list(this.db, {
      ...filter,
      workspaceId: wsId,
      sessionId: ctx.sessionId,
      limit: filter.limit || 20,
      offset: filter.offset || 0,
    });

    if (records.length === 0) return 'No memories found.';

    return records
      .map(
        (m) =>
          `[${m.type} ${m.id}] (${m.status}) ${m.summary || m.content.slice(0, 50)} (c=${m.confidence.toFixed(2)}, u=${m.utility.toFixed(2)})`
      )
      .join('\n');
  }

  /**
   * /memory forget <id> (委托 service/memory-service.ts:forgetWithTrash)
   */
  public forget(idOrShortId: string, ctx: CommandContext): string {
    const rawId = (idOrShortId || '').trim();
    if (!rawId) return 'Usage: /memory forget <id>';
    const cfg = this.getLiveConfig();
    const wsId = workspaceId(ctx.workspaceId);
    const res = forgetWithTrash(this.db, rawId, {
      actor: 'user',
      now: Date.now(),
      scopeCtx: { workspaceId: wsId, sessionId: ctx.sessionId },
      dataDir: cfg.dataDir,
    });
    if (!res.ok) {
      if (res.error === 'memory_not_found') return `Memory '${rawId}' not found.`;
      if (res.error === 'memory_is_frozen') {
        return `Memory '${res.id || rawId}' is frozen and cannot be forgotten.`;
      }
      return `Error: ${res.error || 'forget failed'}`;
    }
    return `Memory ${res.id} archived.`;
  }

  /**
   * /memory confirm <id>
   */
  public confirm(idOrShortId: string, ctx: CommandContext): string {
    const rawId = (idOrShortId || '').trim();
    if (!rawId) return 'Usage: /memory confirm <id>';
    const wsId = workspaceId(ctx.workspaceId);
    const mem = get(this.db, rawId, { workspaceId: wsId, sessionId: ctx.sessionId });
    if (!mem) return `Memory '${rawId}' not found.`;

    const res = confirmMemory(this.db, mem.id, 'user');
    return res.message;
  }

  /**
   * /memory merge <sourceId> <targetId>
   */
  public merge(sourceId: string, targetId: string, ctx: CommandContext): string {
    const src = (sourceId || '').trim();
    const tgt = (targetId || '').trim();
    if (!src || !tgt) {
      return 'Usage: /memory merge <sourceId> <targetId>';
    }
    const wsId = workspaceId(ctx.workspaceId);
    const srcMem = get(this.db, src, { workspaceId: wsId, sessionId: ctx.sessionId });
    const tgtMem = get(this.db, tgt, { workspaceId: wsId, sessionId: ctx.sessionId });
    if (!srcMem) return `Source memory '${src}' not found.`;
    if (!tgtMem) return `Target memory '${tgt}' not found.`;

    const res = mergeMemories(this.db, srcMem.id, tgtMem.id, 'manual_merge', 'user');
    return res.message;
  }

  /**
   * /memory restore <id>
   */
  public restore(idOrShortId: string, ctx: CommandContext): string {
    const rawId = (idOrShortId || '').trim();
    if (!rawId) return 'Usage: /memory restore <id>';
    const cfg = this.getLiveConfig();
    const wsId = workspaceId(ctx.workspaceId);
    let mem: MemoryRecord | undefined;
    try {
      mem = get(this.db, rawId, { workspaceId: wsId, sessionId: ctx.sessionId });
    } catch (err: any) {
      return `Error: ${err?.message || 'Lookup failed'}`;
    }

    const trashDir = resolveTrashDir(this.db, cfg.dataDir);
    if (mem) {
      const res = restoreMemory(this.db, mem.id, 'user');
      return res.message;
    }
    const res = restoreFromTrash(this.db, rawId, trashDir, {
      workspaceId: wsId,
      sessionId: ctx.sessionId,
    });
    return res.message;
  }

  /**
   * /memory graph [limitOrId]
   */
  public graph(argStr?: string, ctx?: CommandContext): string {
    const wsId = ctx ? workspaceId(ctx.workspaceId) : undefined;
    const rawArg = (argStr || '').trim();
    if (rawArg && (rawArg.startsWith('m_') || !STRICT_POSITIVE_INT_RE.test(rawArg))) {
      const subGraph = getSubgraph(this.db, rawArg, {
        workspaceId: wsId,
        sessionId: ctx?.sessionId,
        hops: 2,
        maxNodes: 25,
      });
      if (subGraph.nodes.length === 0) {
        return `Memory '${rawArg}' not found in current scope.`;
      }
      const mermaid = renderMermaidGraph(subGraph, 25);
      return [
        `🕸️ 记忆节点 ${rawArg} 的局部拓扑子图 (共 ${subGraph.stats.totalNodes} 节点: ${subGraph.stats.memoryNodes} 记忆 / ${subGraph.stats.entityNodes} 实体，${subGraph.stats.totalLinks} 条关联关系):`,
        '',
        mermaid,
      ].join('\n');
    }
    const parsedLimit = rawArg ? parseInt(rawArg, 10) : 30;
    const limit = Math.max(1, Math.min(200, Number.isFinite(parsedLimit) ? parsedLimit : 30));
    const gData = getGraphData(this.db, {
      workspaceId: wsId,
      sessionId: ctx?.sessionId,
      limit,
    });
    const mermaid = renderMermaidGraph(gData, 25);

    return [
      `📊 知识拓扑图谱概览 (共 ${gData.stats.totalNodes} 节点: ${gData.stats.memoryNodes} 记忆 / ${gData.stats.entityNodes} 实体，${gData.stats.totalLinks} 条关联关系):`,
      '',
      mermaid,
    ].join('\n');
  }

  /**
   * /memory export-md <path>
   */
  public exportToMarkdownDir(targetDir: string, ctx: CommandContext): string {
    const wsId = workspaceId(ctx.workspaceId);
    const res = exportToMarkdown(this.db, targetDir, {
      workspaceId: wsId,
      sessionId: ctx.sessionId,
    });
    return `Successfully exported ${res.exportedCount} memories to Markdown directory: ${res.dir}`;
  }

  /**
   * /memory import-md <path>
   */
  public importFromMarkdownDir(sourceDir: string, ctx: CommandContext): string {
    const wsId = workspaceId(ctx.workspaceId);
    const res = importFromMarkdown(this.db, sourceDir, {
      workspaceId: wsId,
      sessionId: ctx.sessionId,
      actor: 'user',
    });
    let msg = `Import completed: ${res.importedCount} new memories inserted, ${res.updatedCount} updated.`;
    if (res.errors.length > 0) {
      msg += ` (${res.errors.length} warnings/skipped)`;
    }
    return msg;
  }

  /**
   * /memory migrate <format> <path>
   */
  public migrate(format: string, sourcePath: string, ctx: CommandContext): string {
    const fmt = (format || '').trim().toLowerCase();
    const src = (sourcePath || '').trim();
    if (!fmt || !src) {
      return 'Usage: /memory migrate <markdown|json> <path>';
    }
    if (fmt === 'markdown' || fmt === 'md') {
      return this.importFromMarkdownDir(src, ctx);
    }
    if (fmt === 'json') {
      return this.importFromJson(src, ctx);
    }
    if (fs.existsSync(src)) {
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        return this.importFromMarkdownDir(src, ctx);
      }
      if (src.endsWith('.json')) {
        return this.importFromJson(src, ctx);
      }
    }
    return 'Usage: /memory migrate <markdown|json> <path>';
  }

  /**
   * /memory pin <id> / unpin <id>
   */
  public setPin(idOrShortId: string, pinned: boolean, ctx: CommandContext): string {
    const rawId = (idOrShortId || '').trim();
    if (!rawId) return `Usage: /memory ${pinned ? 'pin' : 'unpin'} <id>`;
    const wsId = workspaceId(ctx.workspaceId);
    const mem = get(this.db, rawId, { workspaceId: wsId, sessionId: ctx.sessionId });
    if (!mem) return `Memory '${rawId}' not found.`;

    if (pinned) {
      writerPin(this.db, mem.id, 'user', Date.now());
    } else {
      writerUnpin(this.db, mem.id, 'user', Date.now());
    }
    return `Memory ${mem.id} ${pinned ? 'pinned' : 'unpinned'}.`;
  }

  /**
   * /memory freeze <id> / unfreeze <id>
   */
  public setFreeze(idOrShortId: string, freeze: boolean, ctx: CommandContext): string {
    const rawId = (idOrShortId || '').trim();
    if (!rawId) return `Usage: /memory ${freeze ? 'freeze' : 'unfreeze'} <id>`;
    const wsId = workspaceId(ctx.workspaceId);
    const mem = get(this.db, rawId, { workspaceId: wsId, sessionId: ctx.sessionId });
    if (!mem) return `Memory '${rawId}' not found.`;

    const targetStatus = freeze ? 'frozen' : 'active';
    const ok = freeze
      ? writerFreeze(this.db, mem.id, 'user', Date.now())
      : writerUnfreeze(this.db, mem.id, 'user', Date.now());
    if (!ok) return `Memory ${mem.id} is ${mem.status}; cannot ${freeze ? 'freeze' : 'unfreeze'}.`;
    return `Memory ${mem.id} status changed to ${targetStatus}.`;
  }

  /**
   * /memory approve <id>
   */
  public approve(idOrShortId: string, ctx: CommandContext): string {
    const rawId = (idOrShortId || '').trim();
    if (!rawId) return 'Usage: /memory approve <id>';
    const wsId = workspaceId(ctx.workspaceId);
    const mem = get(this.db, rawId, { workspaceId: wsId, sessionId: ctx.sessionId });
    if (!mem) return `Memory '${rawId}' not found.`;

    const res = approveCandidate(this.db, mem.id, 'user', Date.now());
    if (res.action === 'rejected') {
      return `Failed to approve ${mem.id}: ${res.reason}`;
    }
    return `Candidate ${mem.id} approved (${res.action}).`;
  }

  /**
   * /memory pending (显著展示 slot_key 与 scope 以便安全复核审批)
   */
  public pending(ctx: CommandContext): string {
    const wsId = workspaceId(ctx.workspaceId);
    const candidates = list(this.db, {
      status: 'candidate',
      workspaceId: wsId,
      sessionId: ctx.sessionId,
      limit: 20,
    });
    const proposals = listRepairProposals(this.db, 'candidate').filter((p) => {
      const target = get(this.db, p.memoryId, { workspaceId: wsId, sessionId: ctx.sessionId });
      return Boolean(target);
    });

    const lines: string[] = [];
    if (candidates.length > 0) {
      lines.push(`Pending Candidates (${candidates.length}):`);
      for (const c of candidates) {
        const slotPart = c.slot_key ? `, slot=${c.slot_key}` : '';
        lines.push(
          `  - [${c.id}] ${c.type} [scope=${c.scope}${slotPart}] (${c.source_kind}, conf=${c.confidence.toFixed(2)}): ${c.summary || c.content}`
        );
      }
    }

    if (proposals.length > 0) {
      lines.push(`Pending Repair Proposals (${proposals.length}):`);
      for (const p of proposals) {
        lines.push(
          `  - [Proposal #${p.id}] action=${p.action} for memory ${p.memoryId} (rev ${p.contentRev}): "${p.reason}" -> candidates: [${p.candidateIds.join(', ')}]`
        );
      }
    }

    if (lines.length === 0) return 'No pending candidates or repair proposals.';
    return lines.join('\n');
  }

  /**
   * /memory export <path>.json [--force]
   */
  public exportToJson(filePath: string, ctx: CommandContext, force: boolean = false): string {
    if (!force && fs.existsSync(filePath)) {
      return `Error: target file already exists at ${filePath}. Pass --force to overwrite.`;
    }
    const wsId = workspaceId(ctx.workspaceId);
    const records = list(this.db, {
      workspaceId: wsId,
      sessionId: ctx.sessionId,
      limit: 10000,
    }).map(({ embedding, ...rest }) => rest);
    const parent = path.dirname(path.resolve(filePath));
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }
    atomicWriteFileSync(filePath, JSON.stringify(records, null, 2));
    return `Exported ${records.length} memories to ${filePath}`;
  }

  /**
   * /memory import <path>.json (委托 service/memory-service.ts:importJsonMemories)
   */
  public importFromJson(filePath: string, ctx: CommandContext): string {
    if (!filePath || !fs.existsSync(filePath)) {
      return `Error: File not found at ${filePath}`;
    }
    let items: unknown;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      items = JSON.parse(raw);
    } catch (err: any) {
      return `Error: Failed to parse JSON at ${filePath}: ${err?.message || err}`;
    }
    if (!Array.isArray(items)) {
      return 'Error: Invalid JSON format (must be an array of records)';
    }

    const cfg = this.getLiveConfig();
    const res = importJsonMemories(this.db, items, {
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      trusted: true,
      actor: 'user',
      cfg,
    });

    if (res.imported > 0) {
      try {
        weaveZettelkastenLinks(this.db, {
          workspaceId: workspaceId(ctx.workspaceId),
          excludeWorkspaces: cfg.excludeWorkspaces,
        });
      } catch {}
    }

    const extra: string[] = [];
    if (res.merged > 0) extra.push(`${res.merged} merged`);
    if (res.skipped > 0) extra.push(`${res.skipped} skipped`);
    return `Imported ${res.imported} records from ${filePath}${extra.length ? ` (${extra.join(', ')})` : ''}`;
  }

  /**
   * 处理 /memory 原始输入 (§6.7)
   */
  public handleCommand(rawInput: string, ctx: CommandContext): CommandResult {
    const trimmed = (rawInput || '').trim();
    if (!trimmed) {
      return okResult(formatHelpText());
    }

    const tokenized = tokenizeCommandArgs(trimmed);
    if (!tokenized.ok) {
      return errResult(tokenized.error);
    }
    const parts = tokenized.tokens;
    if (parts.length === 0) {
      return okResult(formatHelpText());
    }

    const sub = parts[0].toLowerCase();
    const rest = parts.slice(1);
    const entry = COMMAND_MAP.get(sub);
    if (!entry) {
      return errResult(
        `Unknown memory command '${sub}'. Type '/memory help' for available commands.`
      );
    }

    // 隐私守门：除 help / budget 外，所有命令均在入口拦截 excluded workspace
    if (!entry.allowWhenExcluded && this.isExcluded(ctx)) {
      return errResult('Error: workspace is excluded by privacy configuration.');
    }

    try {
      return entry.execute(this, rest, ctx);
    } catch (err: any) {
      return errResult(err?.message || 'Command execution failed');
    }
  }
}
