import fs from 'node:fs';
import type { Db, MemoryRecord } from '../types.js';
import { get, list, stats, sources, history } from '../core/store.js';
import { approveCandidate, editContent, rollback as rollbackVersion } from '../core/writer.js';
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
    const relLines = relRows.map((r) => `  - [${r.rel}] -> ${r.to_id}`);

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
  public list(filter: { type?: any; status?: any; limit?: number }, ctx: CommandContext): string {
    const wsId = workspaceId(ctx.workspaceId);
    const records = list(this.db, {
      ...filter,
      workspaceId: wsId,
      limit: filter.limit || 20,
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

    this.db.run(
      `UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?`,
      [Date.now(), mem.id]
    );
    return `Memory ${mem.id} archived.`;
  }

  /**
   * /memory pin <id> / unpin <id>
   */
  public setPin(idOrShortId: string, pinned: boolean, ctx: CommandContext): string {
    const wsId = workspaceId(ctx.workspaceId);
    const mem = get(this.db, idOrShortId, { workspaceId: wsId });
    if (!mem) return `Memory '${idOrShortId}' not found.`;

    this.db.run(`UPDATE memories SET pinned = ?, updated_at = ? WHERE id = ?`, [
      pinned ? 1 : 0,
      Date.now(),
      mem.id,
    ]);
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
    this.db.run(`UPDATE memories SET status = ?, updated_at = ? WHERE id = ?`, [
      targetStatus,
      Date.now(),
      mem.id,
    ]);
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
    const records = list(this.db, { workspaceId: wsId, limit: 10000 });
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
    const now = Date.now();
    this.db.transaction(() => {
      for (const it of items) {
        if (!it.id || !it.content) continue;
        this.db.run(
          `INSERT OR IGNORE INTO memories (
            id, type, status, content, summary, slot_key, scope, workspace_id, session_id,
            origin_kinds, source_kind, confidence, utility, use_count, success_count, fail_count,
            token_cost, summary_cost, hash, version, content_rev, pinned, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            it.id,
            it.type || 'semantic',
            it.status || 'active',
            it.content,
            it.summary || it.content.slice(0, 60),
            it.slot_key || null,
            it.scope || 'workspace',
            it.workspace_id || workspaceId(ctx.workspaceId),
            it.session_id || null,
            typeof it.origin_kinds === 'string' ? it.origin_kinds : JSON.stringify(it.origin_kinds || ['user']),
            it.source_kind || 'user',
            it.confidence ?? 0.8,
            it.utility ?? 0.5,
            it.use_count ?? 0,
            it.success_count ?? 0,
            it.fail_count ?? 0,
            it.token_cost ?? 30,
            it.summary_cost ?? 15,
            it.hash || 'imported',
            it.version ?? 1,
            it.content_rev ?? 1,
            it.pinned ?? 0,
            it.created_at || now,
            it.updated_at || now,
          ]
        );
        imported++;
      }
    });

    return `Imported ${imported} records from ${filePath}`;
  }

  /**
   * 处理 /memory 原始输入 (§6.7)
   */
  public handleCommand(rawInput: string, ctx: CommandContext): { kind: 'success' | 'error'; text: string } {
    const trimmed = (rawInput || '').trim();
    if (!trimmed || trimmed === 'help') {
      return {
        kind: 'success',
        text: 'Available commands: stats | inspect <id> | list | history <id> | rollback <id> <version> | forget <id> | pin <id> | unpin <id> | freeze <id> | unfreeze <id> | approve <id> | pending | approve-repair <proposalId> | reject-repair <proposalId> | evolve | strategy [list|rollback <v>] | backfill [--dry-run] | eval [suite] | budget | export <path> | import <path>',
      };
    }

    const parts = trimmed.split(/\s+/);
    const sub = parts[0].toLowerCase();
    const rest = parts.slice(1);

    try {
      let output = '';
      if (sub === 'stats') {
        output = this.stats(ctx);
      } else if (sub === 'inspect') {
        output = this.inspect(rest[0], ctx);
      } else if (sub === 'history') {
        const hist = history(this.db, rest[0]);
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
          const res = rollbackVersion(this.db, rest[0], targetVersion, 'user', Date.now());
          output = `Memory ${rest[0]} rolled back to version ${targetVersion} (new version v${res.version}).`;
        }
      } else if (sub === 'list') {
        output = this.list({}, ctx);
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
        const usage = getLedgerUsage(this.db);
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
