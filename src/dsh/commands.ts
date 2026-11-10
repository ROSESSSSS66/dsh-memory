import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Db, MemoryRecord } from '../types.js';
import { get, list, stats, sources, history, getGraphData, getSubgraph, renderMermaidGraph } from '../core/store.js';
import {
  approveCandidate,
  editContent,
  rollback as rollbackVersion,
  confirmMemory,
  mergeMemories,
  restoreMemory,
  forget as writerForget,
  pin as writerPin,
  unpin as writerUnpin,
  freeze as writerFreeze,
  unfreeze as writerUnfreeze,
} from '../core/writer.js';
import { ftsText, contentHash, extractEntities } from '../core/text.js';
import { estimateTokens } from '../core/tokens.js';
import {
  computeLocalEmbedding,
  encodeEmbeddingBlob,
  primeRuntimeVectorCache,
} from '../core/vector.js';
import {
  exportToMarkdown,
  importFromMarkdown,
  trashMemory,
  restoreFromTrash,
  exportMemoryBank,
  importMemoryBank,
} from '../core/markdown.js';
import {
  getCoreMemory,
  getAllCoreMemories,
  setCoreMemory,
  appendCoreMemory,
  renderCoreMemoryMarkdown,
} from '../core/core-memory.js';
import { reconcileAndUpsert } from '../evolution/reconciler.js';
import { auditMemoryHealth, autoHealMemoryHealth, weaveZettelkastenLinks } from '../core/health.js';
import { autoBootstrapMemory } from '../core/bootstrap.js';
import { workspaceId } from '../core/scope.js';
import { redactSecrets } from '../core/privacy.js';
import { runBackfill } from '../ingest/backfill.js';
import { generateDataset } from '../eval/gen-dataset.js';
import { runEvalSuite } from '../eval/runner.js';
import { getLedgerUsage } from '../evolution/ledger.js';
import { runStrategyEvolution } from '../evolution/lab.js';
import { listStrategies, rollbackStrategy, initDefaultStrategy } from '../evolution/strategy.js';
import { approveRepairProposal, rejectRepairProposal, listRepairProposals } from '../evolution/repair.js';
import { exportDatabaseFile, importDatabaseFile } from '../evolution/maintenance.js';
import { DEFAULTS, type PluginConfig } from '../config.js';

export interface CommandContext {
  workspaceId: string;
  sessionId?: string;
}

export class MemoryCommands {
  private db: Db;
  private cfg: PluginConfig;

  constructor(db: Db, cfg: PluginConfig = DEFAULTS) {
    this.db = db;
    this.cfg = cfg;
  }

  /**
   * /memory init [--force] (v0.4.0 安装后与工作区冷启动自动初始化记忆)
   */
  public init(ctx: CommandContext, force: boolean = false): string {
    const wsPath = ctx.workspaceId && fs.existsSync(ctx.workspaceId) ? ctx.workspaceId : process.cwd();
    const res = autoBootstrapMemory(this.db, {
      workspacePath: wsPath,
      cfg: this.cfg,
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
    const wsId = workspaceId(ctx.workspaceId);
    const st = stats(this.db, wsId);

    const active = st.byStatus['active'] || 0;
    const candidate = st.byStatus['candidate'] || 0;
    const superseded = st.byStatus['superseded'] || 0;
    const archived = st.byStatus['archived'] || 0;
    const frozen = st.byStatus['frozen'] || 0;

    const typeParts = Object.entries(st.byType)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ');

    // 统计近 7 天注入数据
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 86400000;
    const injRows = this.db.all<{ tokens: number; outcome: number | null }>(
      'SELECT tokens, outcome FROM injections WHERE created_at >= ?',
      [sevenDaysAgo]
    );

    const injCount = injRows.length;
    let totalTokens = 0;
    let corrections = 0;
    for (const r of injRows) {
      totalTokens += r.tokens;
      if (r.outcome !== null && r.outcome <= -0.5) {
        corrections++;
      }
    }
    const avgTokens = injCount > 0 ? Math.round(totalTokens / injCount) : 0;
    const correctionRate = injCount > 0 ? ((corrections / injCount) * 100).toFixed(1) : '0.0';

    return [
      `记忆总数 ${st.total.toLocaleString()}（active ${active} / candidate ${candidate} / superseded ${superseded} / archived ${archived}${frozen > 0 ? ` / frozen ${frozen}` : ''}）`,
      `类型分布 ${typeParts || '无'}`,
      `近 7 天：注入 ${injCount} 次，平均 ${avgTokens} tokens/turn，纠正率 ${correctionRate}%`,
    ].join('\n');
  }

  /**
   * /memory doctor [--fix] (记忆库健康度体检与冲突医生)
   */
  public doctor(ctx: CommandContext, autoFix: boolean = false): string {
    if (autoFix) {
      return this.heal(ctx);
    }
    const wsId = workspaceId(ctx.workspaceId);
    const report = auditMemoryHealth(this.db, { workspaceId: wsId });
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
   * /memory heal (一键智能自愈修复：FTS5 重建 + 本地向量回填 + 冗余去重 + 矛盾消解 + A-Mem 双链织网)
   */
  public heal(ctx: CommandContext): string {
    const wsId = workspaceId(ctx.workspaceId);
    const res = autoHealMemoryHealth(this.db, { workspaceId: wsId });
    return [
      `⚡ 记忆库一键智能自愈完成：健康分 ${res.beforeScore} -> ${res.afterScore}/100 (等级 ${res.afterGrade})`,
      `修复明细：FTS5 重建=${res.ftsRebuilt ? '是' : '否'} · 本地向量回填=${res.embeddingsBackfilled} 条 · 合并冗余对=${res.duplicatesMerged} 对 · 消解矛盾链=${res.contradictionsResolved} 组 · A-Mem 自动织网=${res.linksWeaved} 条`,
    ].join('\n');
  }

  /**
   * /memory inspect <id>
   */
  public inspect(idOrShortId: string, ctx: CommandContext): string {
    const rawId = (idOrShortId || '').trim();
    if (!rawId) return 'Usage: /memory inspect <id>';

    const wsId = workspaceId(ctx.workspaceId);
    let mem: MemoryRecord | undefined;
    try {
      mem = get(this.db, rawId, { workspaceId: wsId });
    } catch (err: any) {
      return `Error: ${err?.message || 'Lookup failed'}`;
    }

    if (!mem) {
      return `Memory '${rawId}' not found in current scope.`;
    }

    const srcList = sources(this.db, mem.id, mem.content_rev);
    const srcLines = srcList.map(
      (s) => `  - Session: ${s.session_id} | seq: ${s.seq} | kind: ${s.kind}${s.excerpt ? ` | excerpt: "${s.excerpt}"` : ''}`
    );

    const relRows = this.db.all<{ to_id: string; rel: string }>(
      'SELECT to_id, rel FROM memory_relations WHERE from_id = ?',
      [mem.id]
    );
    const inRelRows = this.db.all<{ from_id: string; rel: string }>(
      'SELECT from_id, rel FROM memory_relations WHERE to_id = ?',
      [mem.id]
    );
    const relLines = [
      ...relRows.map((r) => `  - [${r.rel}] -> ${r.to_id}`),
      ...inRelRows.map((r) => `  - [${r.rel}] <- ${r.from_id}`),
    ];

    const lines = [
      `ID: ${mem.id} (rev ${mem.content_rev}, v${mem.version})`,
      `Type: ${mem.type} | Status: ${mem.status} | Scope: ${mem.scope}${mem.slot_key ? ` | Slot: ${mem.slot_key}` : ''}`,
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

    return lines.join('\n');
  }

  /**
   * /memory list [type] [status]
   */
  public list(filter: { type?: any; status?: any; limit?: number; offset?: number }, ctx: CommandContext): string {
    const wsId = workspaceId(ctx.workspaceId);
    const records = list(this.db, {
      ...filter,
      workspaceId: wsId,
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
   * /memory forget <id>
   */
  public forget(idOrShortId: string, ctx: CommandContext): string {
    const wsId = workspaceId(ctx.workspaceId);
    const mem = get(this.db, idOrShortId, { workspaceId: wsId });
    if (!mem) return `Memory '${idOrShortId}' not found.`;

    // 安全回收站：先存根备份到 .trash 目录 (汲取自 LZMW/dsh-memory)
    try {
      const trashDir = path.join(os.homedir(), '.dsh', 'storages', 'dsh-memory', '.trash');
      trashMemory(this.db, mem.id, trashDir);
    } catch {}

    writerForget(this.db, mem.id, 'user', Date.now());
    return `Memory ${mem.id} archived.`;
  }

  /**
   * /memory confirm <id> (汲取自 tr1v3r/dsh-ltm)
   */
  public confirm(idOrShortId: string, ctx: CommandContext): string {
    const wsId = workspaceId(ctx.workspaceId);
    const mem = get(this.db, idOrShortId, { workspaceId: wsId });
    if (!mem) return `Memory '${idOrShortId}' not found.`;

    const res = confirmMemory(this.db, mem.id, 'user');
    return res.message;
  }

  /**
   * /memory merge <sourceId> <targetId> (汲取自 tr1v3r/dsh-ltm)
   */
  public merge(sourceId: string, targetId: string, ctx: CommandContext): string {
    if (!sourceId || !targetId) {
      return 'Usage: /memory merge <sourceId> <targetId>';
    }
    const wsId = workspaceId(ctx.workspaceId);
    const srcMem = get(this.db, sourceId, { workspaceId: wsId });
    const tgtMem = get(this.db, targetId, { workspaceId: wsId });
    if (!srcMem) return `Source memory '${sourceId}' not found.`;
    if (!tgtMem) return `Target memory '${targetId}' not found.`;

    const res = mergeMemories(this.db, srcMem.id, tgtMem.id, 'manual_merge', 'user');
    return res.message;
  }

  /**
   * /memory restore <id>
   */
  public restore(idOrShortId: string, ctx: CommandContext): string {
    const wsId = workspaceId(ctx.workspaceId);
    let mem: MemoryRecord | undefined;
    try {
      mem = get(this.db, idOrShortId, { workspaceId: wsId });
    } catch {}

    const trashDir = path.join(os.homedir(), '.dsh', 'storages', 'dsh-memory', '.trash');
    if (mem) {
      const res = restoreMemory(this.db, mem.id, 'user');
      return res.message;
    }
    const res = restoreFromTrash(this.db, idOrShortId, trashDir);
    return res.message;
  }

  /**
   * /memory graph [limitOrId] (支持全库拓扑与单节点 K-Hop 局部子图)
   */
  public graph(argStr?: string, ctx?: CommandContext): string {
    const wsId = ctx ? workspaceId(ctx.workspaceId) : undefined;
    const rawArg = (argStr || '').trim();
    if (rawArg && (rawArg.startsWith('m_') || isNaN(parseInt(rawArg, 10)))) {
      const subGraph = getSubgraph(this.db, rawArg, { workspaceId: wsId, hops: 2, maxNodes: 25 });
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
    const limit = rawArg ? parseInt(rawArg, 10) : 30;
    const gData = getGraphData(this.db, { workspaceId: wsId, limit: isNaN(limit) ? 30 : limit });
    const mermaid = renderMermaidGraph(gData, 25);

    return [
      `📊 知识拓扑图谱概览 (共 ${gData.stats.totalNodes} 节点: ${gData.stats.memoryNodes} 记忆 / ${gData.stats.entityNodes} 实体，${gData.stats.totalLinks} 条关联关系):`,
      '',
      mermaid,
    ].join('\n');
  }

  /**
   * /memory export-md <path> (汲取自 LZMW/dsh-memory)
   */
  public exportToMarkdownDir(targetDir: string, ctx: CommandContext): string {
    const wsId = workspaceId(ctx.workspaceId);
    const res = exportToMarkdown(this.db, targetDir, { workspaceId: wsId });
    return `Successfully exported ${res.exportedCount} memories to Markdown directory: ${res.dir}`;
  }

  /**
   * /memory import-md <path> (汲取自 LZMW/dsh-memory)
   */
  public importFromMarkdownDir(sourceDir: string, ctx: CommandContext): string {
    const wsId = workspaceId(ctx.workspaceId);
    const res = importFromMarkdown(this.db, sourceDir, { workspaceId: wsId, actor: 'user' });
    let msg = `Import completed: ${res.importedCount} new memories inserted, ${res.updatedCount} updated.`;
    if (res.errors.length > 0) {
      msg += ` (${res.errors.length} warnings/skipped)`;
    }
    return msg;
  }

  /**
   * /memory migrate <format> <path> (汲取自 tr1v3r/dsh-ltm 迁移工具)
   */
  public migrate(format: string, sourcePath: string, ctx: CommandContext): string {
    const fmt = (format || '').toLowerCase();
    if (fmt === 'markdown' || fmt === 'md') {
      return this.importFromMarkdownDir(sourcePath, ctx);
    }
    if (fmt === 'json') {
      return this.importFromJson(sourcePath, ctx);
    }
    if (fs.existsSync(sourcePath)) {
      const stat = fs.statSync(sourcePath);
      if (stat.isDirectory()) {
        return this.importFromMarkdownDir(sourcePath, ctx);
      }
      if (sourcePath.endsWith('.json')) {
        return this.importFromJson(sourcePath, ctx);
      }
    }
    return `Usage: /memory migrate <markdown|json> <path>`;
  }

  /**
   * /memory pin <id> / unpin <id>
   */
  public setPin(idOrShortId: string, pinned: boolean, ctx: CommandContext): string {
    const wsId = workspaceId(ctx.workspaceId);
    const mem = get(this.db, idOrShortId, { workspaceId: wsId });
    if (!mem) return `Memory '${idOrShortId}' not found.`;

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
    const wsId = workspaceId(ctx.workspaceId);
    const mem = get(this.db, idOrShortId, { workspaceId: wsId });
    if (!mem) return `Memory '${idOrShortId}' not found.`;

    const targetStatus = freeze ? 'frozen' : 'active';
    if (freeze) {
      writerFreeze(this.db, mem.id, 'user', Date.now());
    } else {
      writerUnfreeze(this.db, mem.id, 'user', Date.now());
    }
    return `Memory ${mem.id} status changed to ${targetStatus}.`;
  }

  /**
   * /memory approve <id>
   */
  public approve(idOrShortId: string, ctx: CommandContext): string {
    const wsId = workspaceId(ctx.workspaceId);
    const mem = get(this.db, idOrShortId, { workspaceId: wsId });
    if (!mem) return `Memory '${idOrShortId}' not found.`;

    const res = approveCandidate(this.db, mem.id, 'user', Date.now());
    if (res.action === 'rejected') {
      return `Failed to approve ${mem.id}: ${res.reason}`;
    }
    return `Candidate ${mem.id} approved (${res.action}).`;
  }

  /**
   * /memory pending
   */
  public pending(ctx: CommandContext): string {
    const wsId = workspaceId(ctx.workspaceId);
    const candidates = list(this.db, {
      status: 'candidate',
      workspaceId: wsId,
      limit: 20,
    });
    const proposals = listRepairProposals(this.db, 'candidate');

    const lines: string[] = [];
    if (candidates.length > 0) {
      lines.push(`Pending Candidates (${candidates.length}):`);
      for (const c of candidates) {
        lines.push(
          `  - [${c.id}] ${c.type} (${c.source_kind}, conf=${c.confidence.toFixed(2)}): ${c.summary || c.content}`
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
   * /memory export <path>
   */
  public exportToJson(filePath: string, ctx: CommandContext): string {
    const wsId = workspaceId(ctx.workspaceId);
    const records = list(this.db, { workspaceId: wsId, limit: 10000 }).map(
      ({ embedding, ...rest }) => rest
    );
    fs.writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf8');
    return `Exported ${records.length} memories to ${filePath}`;
  }

  /**
   * /memory import <path>
   */
  public importFromJson(filePath: string, ctx: CommandContext): string {
    if (!fs.existsSync(filePath)) return `Error: File not found at ${filePath}`;
    const raw = fs.readFileSync(filePath, 'utf8');
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) return 'Error: Invalid JSON format (must be an array of records)';

    let imported = 0;
    let skipped = 0;
    const now = Date.now();
    const VALID_TYPES = ['episodic', 'semantic', 'procedural', 'belief', 'preference', 'goal', 'failure', 'meta'];
    const VALID_STATUS = ['active', 'candidate', 'frozen', 'superseded', 'archived', 'rejected'];
    const VALID_SCOPES = ['session', 'workspace', 'user', 'global'];
    const VALID_SOURCE_KINDS = ['user', 'assistant', 'tool', 'web', 'llm_extract', 'rule', 'system'];
    const num = (v: unknown, def: number, min: number, max: number): number => {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
    };
    const int = (v: unknown, def: number, min: number, max: number): number => Math.round(num(v, def, min, max));
    this.db.transaction(() => {
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        if (!it.id || typeof it.id !== 'string' || !it.content || typeof it.content !== 'string') continue;
        const priv = redactSecrets(it.content);
        if (priv.hasSensitive || it.content.includes('[REDACTED:')) continue;

        const cleanContent = priv.text.trim();
        const rawSummary = typeof it.summary === 'string' && it.summary.trim() ? it.summary.trim() : cleanContent.slice(0, 60);
        const cleanSummary = redactSecrets(rawSummary).text;
        const memType = VALID_TYPES.includes(it.type) ? it.type : 'semantic';
        const memStatus = VALID_STATUS.includes(it.status) ? it.status : 'active';
        const memScope = VALID_SCOPES.includes(it.scope) ? it.scope : 'workspace';
        const sourceKind = VALID_SOURCE_KINDS.includes(it.source_kind) ? it.source_kind : 'user';
        const slotKey = typeof it.slot_key === 'string' && it.slot_key.trim() ? it.slot_key.trim() : null;
        // 始终按导入后的正文重算哈希：文件中的 hash 不可信，错误的哈希会破坏去重与向量缓存一致性
        const hash = contentHash(memType, cleanContent);
        const vec = computeLocalEmbedding(`${cleanSummary}\n${cleanContent}${slotKey ? `\n${slotKey}` : ''}`);

        try {
          // 单条记录使用 SAVEPOINT：某条违反约束只跳过该条，不回滚整个导入
          this.db.transaction(() => {
            const res = this.db.run(
              `INSERT OR IGNORE INTO memories (
                id, type, status, content, summary, slot_key, scope, workspace_id, session_id,
                origin_kinds, source_kind, confidence, utility, use_count, success_count, fail_count,
                token_cost, summary_cost, hash, version, content_rev, pinned, created_at, updated_at,
                importance, embedding
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                it.id,
                memType,
                memStatus,
                cleanContent,
                cleanSummary,
                slotKey,
                memScope,
                (memScope === 'global' || memScope === 'user') ? null : (typeof it.workspace_id === 'string' && it.workspace_id ? workspaceId(it.workspace_id) : workspaceId(ctx.workspaceId)),
                memScope === 'session' ? (typeof it.session_id === 'string' && it.session_id ? it.session_id : ctx.sessionId || 'default_session') : null,
                typeof it.origin_kinds === 'string' ? it.origin_kinds : JSON.stringify(Array.isArray(it.origin_kinds) ? it.origin_kinds : ['user']),
                sourceKind,
                num(it.confidence, 0.8, 0, 1),
                num(it.utility, 0.5, 0, 1),
                int(it.use_count, 0, 0, 1e9),
                int(it.success_count, 0, 0, 1e9),
                int(it.fail_count, 0, 0, 1e9),
                estimateTokens(cleanContent),
                estimateTokens(cleanSummary),
                hash,
                int(it.version, 1, 1, 1e9),
                int(it.content_rev, 1, 1, 1e9),
                it.pinned ? 1 : 0,
                int(it.created_at, now, 0, 8.64e15),
                int(it.updated_at, now, 0, 8.64e15),
                int(it.importance, 5, 1, 10),
                encodeEmbeddingBlob(vec),
              ]
            );
            if (Number(res.changes) > 0) {
              const rowid = Number(res.lastInsertRowid);
              this.db.run(`DELETE FROM memory_fts WHERE rowid = ?`, [rowid]);
              this.db.run(`INSERT INTO memory_fts(rowid, fts_text) VALUES (?, ?)`, [
                rowid,
                ftsText(cleanContent + ' ' + cleanSummary),
              ]);
              const entities = extractEntities(`${cleanSummary} ${cleanContent}`);
              for (const ent of entities) {
                const normEnt = ent.toLowerCase().replace(/\\/g, '/').trim();
                if (normEnt) {
                  this.db.run(`INSERT OR IGNORE INTO memory_entities(memory_id, entity) VALUES (?, ?)`, [
                    it.id,
                    normEnt,
                  ]);
                }
              }
              primeRuntimeVectorCache(it.id, hash, vec);
              imported++;
            }
          });
        } catch {
          skipped++;
        }
      }
    });

    if (imported > 0) {
      try {
        weaveZettelkastenLinks(this.db, { workspaceId: workspaceId(ctx.workspaceId), now });
      } catch {}
    }

    return `Imported ${imported} records from ${filePath}${skipped ? ` (${skipped} invalid records skipped)` : ''}`;
  }

  /**
   * 处理 /memory 原始输入 (§6.7)
   */
  public handleCommand(rawInput: string, ctx: CommandContext): { kind: 'success' | 'error'; text: string } {
    const trimmed = (rawInput || '').trim();
    if (!trimmed || trimmed === 'help') {
      return {
        kind: 'success',
        text: 'Available commands: init [--force] | stats | doctor [--fix] | heal | inspect <id> | list | confirm <id> | merge <src> <tgt> | restore <id> | graph [limit|<id>] | export-md <dir> | import-md <dir> | migrate <format> <path> | history <id> | rollback <id> <version> | forget <id> | pin <id> | unpin <id> | freeze <id> | unfreeze <id> | approve <id> | pending | approve-repair <proposalId> | reject-repair <proposalId> | evolve | strategy [list|rollback <v>] | backfill [--dry-run] | eval [suite] | budget | export <path> | import <path>',
      };
    }

    const parts = trimmed.split(/\s+/);
    const sub = parts[0].toLowerCase();
    const rest = parts.slice(1);

    try {
      let output = '';
      if (sub === 'init' || sub === 'bootstrap') {
        output = this.init(ctx, rest.includes('--force') || rest.includes('force'));
      } else if (sub === 'stats' || sub === 'status') {
        output = this.stats(ctx);
      } else if (sub === 'doctor' || sub === 'health') {
        output = this.doctor(ctx, rest.includes('--fix') || rest.includes('fix'));
      } else if (sub === 'heal') {
        output = this.heal(ctx);
      } else if (sub === 'inspect') {
        output = this.inspect(rest[0], ctx);
      } else if (sub === 'history') {
        const wsId = workspaceId(ctx.workspaceId);
        const mem = get(this.db, rest[0], { workspaceId: wsId });
        const targetId = mem ? mem.id : rest[0];
        const hist = history(this.db, targetId);
        if (hist.length === 0) {
          output = `No history found for memory '${rest[0]}'.`;
        } else {
          output = hist
            .map(
              (h) =>
                `v${h.version} (${new Date(h.created_at).toISOString()}, by ${h.actor}): ${h.snapshot?.summary || h.snapshot?.content?.slice(0, 60) || h.reason}`
            )
            .join('\n');
        }
      } else if (sub === 'rollback') {
        const targetVersion = parseInt(rest[1], 10);
        if (isNaN(targetVersion)) {
          output = 'Usage: /memory rollback <id> <version>';
        } else {
          const wsId = workspaceId(ctx.workspaceId);
          const mem = get(this.db, rest[0], { workspaceId: wsId });
          const targetId = mem ? mem.id : rest[0];
          const res = rollbackVersion(this.db, targetId, targetVersion, 'user', Date.now());
          output = `Memory ${targetId} rolled back to version ${targetVersion} (new version v${res.version}).`;
        }
      } else if (sub === 'list') {
        const listFilter: { type?: any; status?: any; limit?: number; offset?: number } = {};
        const validStatuses = new Set(['active', 'candidate', 'frozen', 'superseded', 'archived']);
        const validTypes = new Set(['semantic', 'preference', 'procedural', 'episodic', 'belief', 'goal', 'failure', 'meta']);
        for (const arg of rest) {
          const low = arg.toLowerCase();
          const num = parseInt(low, 10);
          if (!isNaN(num) && num >= 1) {
            listFilter.offset = (num - 1) * 20;
          } else if (validStatuses.has(low)) {
            listFilter.status = low;
          } else if (validTypes.has(low)) {
            listFilter.type = low;
          }
        }
        output = this.list(listFilter, ctx);
      } else if (sub === 'forget') {
        output = this.forget(rest[0], ctx);
      } else if (sub === 'pin') {
        output = this.setPin(rest[0], true, ctx);
      } else if (sub === 'unpin') {
        output = this.setPin(rest[0], false, ctx);
      } else if (sub === 'freeze') {
        output = this.setFreeze(rest[0], true, ctx);
      } else if (sub === 'unfreeze') {
        output = this.setFreeze(rest[0], false, ctx);
      } else if (sub === 'approve') {
        output = this.approve(rest[0], ctx);
      } else if (sub === 'confirm') {
        output = this.confirm(rest[0], ctx);
      } else if (sub === 'merge') {
        output = this.merge(rest[0], rest[1], ctx);
      } else if (sub === 'restore') {
        output = this.restore(rest[0], ctx);
      } else if (sub === 'graph') {
        output = this.graph(rest[0], ctx);
      } else if (sub === 'core') {
        const block = rest[0];
        const content = rest.slice(1).join(' ').trim();
        const wsId = workspaceId(ctx.workspaceId);
        if (block && content) {
          const res = setCoreMemory(this.db, block, content, { workspaceId: wsId, actor: 'user' });
          output = `Core memory block '${block}' ${res.action} successfully (id: ${res.id}).`;
        } else if (block) {
          const entry = getCoreMemory(this.db, block, { workspaceId: wsId });
          output = entry ? `[CORE MEMORY: ${entry.block.toUpperCase()}] (v${entry.version})\n${entry.content}` : `Core memory block '${block}' is empty.`;
        } else {
          const all = getAllCoreMemories(this.db, { workspaceId: wsId });
          output = all.length > 0 ? renderCoreMemoryMarkdown(all) : 'No core memory blocks configured. Usage: /memory core <human|persona|project> <content>';
        }
      } else if (sub === 'export-bank') {
        const targetDir = rest[0] || path.join(process.cwd(), '.dsh', 'memory-bank');
        const res = exportMemoryBank(this.db, targetDir, { workspaceId: ctx.workspaceId });
        output = `Successfully exported ${res.totalMemories} memories to Memory Bank at: ${targetDir}\nFiles: ${res.filesWritten.map((f) => path.basename(f)).join(', ')}`;
      } else if (sub === 'import-bank') {
        const sourceDir = rest[0] || path.join(process.cwd(), '.dsh', 'memory-bank');
        const res = importMemoryBank(this.db, sourceDir, { workspaceId: ctx.workspaceId });
        output = `Successfully processed ${res.filesProcessed} files and imported/updated ${res.imported} memories from Memory Bank at: ${sourceDir}`;
      } else if (sub === 'reconcile') {
        const content = rest.join(' ').trim();
        if (!content) {
          output = 'Usage: /memory reconcile <content>';
        } else {
          const wsId = workspaceId(ctx.workspaceId);
          const sessId = ctx.sessionId || 'default_session';
          const res = reconcileAndUpsert(this.db, {
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
          output = `Reconciliation finished: action=${res.decision.action} (${res.decision.reason}), databaseAction=${res.action}`;
        }
      } else if (sub === 'export-md') {
        output = this.exportToMarkdownDir(rest[0] || path.join(process.cwd(), '.dsh', 'memory'), ctx);
      } else if (sub === 'import-md') {
        output = this.importFromMarkdownDir(rest[0] || path.join(process.cwd(), '.dsh', 'memory'), ctx);
      } else if (sub === 'migrate') {
        output = this.migrate(rest[0], rest[1], ctx);
      } else if (sub === 'approve-repair') {
        const pId = parseInt(rest[0], 10);
        if (isNaN(pId)) {
          output = 'Usage: /memory approve-repair <proposalId>';
        } else {
          const res = approveRepairProposal(this.db, pId);
          output = res.ok
            ? `Repair proposal #${pId} approved successfully.`
            : `Failed to approve repair proposal #${pId}: ${res.reason}`;
        }
      } else if (sub === 'reject-repair') {
        const pId = parseInt(rest[0], 10);
        if (isNaN(pId)) {
          output = 'Usage: /memory reject-repair <proposalId>';
        } else {
          const res = rejectRepairProposal(this.db, pId);
          output = res.ok
            ? `Repair proposal #${pId} rejected.`
            : `Failed to reject repair proposal #${pId}: ${res.reason}`;
        }
      } else if (sub === 'pending') {
        output = this.pending(ctx);
      } else if (sub === 'eval') {
        const suite = rest[0];
        const allCases = generateDataset();
        const cases = suite ? allCases.filter((c) => c.suite.toLowerCase() === suite.toLowerCase()) : allCases;
        if (cases.length === 0) {
          output = `No test cases found for suite '${suite}'. (Options: factual, temporal, procedural, implicit)`;
        } else {
          const report = runEvalSuite(cases);
          output = [
            `评测集 ${suite || '全部'}（${report.overall.passedCases}/${report.overall.totalCases} 通过）：`,
            `Recall@Inject: ${(report.overall.recallAtInject * 100).toFixed(1)}%`,
            `Exclude 违规: ${report.overall.excludeViolations}`,
            `空门槛精度: ${(report.overall.emptyPrecision * 100).toFixed(1)}%`,
            `Critical 通过率: ${(report.overall.criticalPassRate * 100).toFixed(1)}% (${report.overall.criticalPassed}/${report.overall.criticalTotal})`,
            `平均注入 Tokens: ${report.overall.avgInjectTokens}`,
            `P95 延迟: ${report.overall.p95LatencyMs.toFixed(1)}ms`,
            `MVP 门槛: ${report.mvpPassed ? '已达标 (PASS)' : '未达标 (FAIL)'}`,
          ].join('\n');
        }
      } else if (sub === 'budget') {
        const usage = getLedgerUsage(this.db, undefined, this.cfg);
        output = [
          `今日离线 LLM 用量（${usage.day}）：`,
          `调用次数: ${usage.callsCount} / ${usage.callsLimit}`,
          `Token 消耗: ${usage.tokensConsumed.toLocaleString()} / ${usage.tokensLimit.toLocaleString()}`,
          `已结算: ${usage.tokensSettled.toLocaleString()} Tokens`,
          `预留/处理中: ${usage.tokensPending.toLocaleString()} Tokens`,
        ].join('\n');
      } else if (sub === 'evolve') {
        const res = runStrategyEvolution(this.db, {}, this.cfg);
        if (res.promoted) {
          output = `策略实验室进化成功！已晋升至版本 v${res.promotedVersion}（Recall: ${(res.bestMetrics?.recallAtInject! * 100).toFixed(1)}%, 平均 Token: ${res.bestMetrics?.avgInjectTokens}）`;
        } else {
          output = `策略实验室未发现满足晋升条件的候选：${res.reason || '无更优候选'}`;
        }
      } else if (sub === 'strategy') {
        const action = rest[0]?.toLowerCase();
        if (action === 'rollback') {
          const targetV = rest[1] ? parseInt(rest[1], 10) : undefined;
          const res = rollbackStrategy(this.db, targetV);
          output = res.ok
            ? `策略已成功回滚至版本 v${res.rolledBackTo}。`
            : `策略回滚失败：${res.reason}`;
        } else {
          let strats = listStrategies(this.db);
          if (strats.length === 0) {
            initDefaultStrategy(this.db, this.cfg);
            strats = listStrategies(this.db);
          }
          output = strats
            .map(
              (s) =>
                `v${s.version} [${s.status}] (parent: ${s.parent ?? 'none'}, dynamicBudget: ${s.config.dynamicBudgetTokens}, maxItems: ${s.config.maxItems}, rrfK: ${s.config.rrfK})`
            )
            .join('\n');
        }
      } else if (sub === 'backfill') {
        const dryRun = rest.includes('--dry-run');
        const st = runBackfill(this.db, { dryRun });
        output = `Backfill ${dryRun ? '(dry-run)' : 'completed'}: raw=${st.rawEvents}, filtered=${st.filteredEvents}, privacyRejected=${st.privacyRejected}, writable=${st.writableEvents}, added=${st.newEventsAdded}, memories=${st.memoriesCreated}, processedFiles=${st.processedFiles}`;
      } else if (sub === 'export') {
        const targetPath = rest[0] || 'memory-export.db';
        if (targetPath.endsWith('.json')) {
          output = this.exportToJson(targetPath, ctx);
        } else {
          const res = exportDatabaseFile(this.db, (this.db as any).filePath || '', targetPath);
          output = res.success
            ? `Successfully exported database to ${res.path}`
            : `Error exporting database: ${res.error}`;
        }
      } else if (sub === 'import') {
        const sourcePath = rest[0] || 'memory-export.db';
        if (sourcePath.endsWith('.json')) {
          output = this.importFromJson(sourcePath, ctx);
        } else {
          const res = importDatabaseFile(this.db, (this.db as any).filePath || '', sourcePath);
          output = res.success
            ? `Successfully imported ${res.importedRecords} memories from ${sourcePath}`
            : `Error importing database: ${res.error}`;
        }
      } else {
        return {
          kind: 'error',
          text: `Unknown memory command '${sub}'. Type '/memory help' for available commands.`,
        };
      }

      return { kind: 'success', text: output };
    } catch (err: any) {
      return { kind: 'error', text: err?.message || 'Command execution failed' };
    }
  }
}
