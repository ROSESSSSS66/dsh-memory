import * as React from 'react';
import type {
  EvolutionDataResponse,
  EvalSuiteReportUI,
  BackfillStatsUI,
  MemoryHealthReportUI,
} from '../types.js';
import { fetchEvolutionData, fetchMemoryHealth, performAction } from '../api.js';
import {
  CpuIcon,
  SparklesIcon,
  RefreshIcon,
  CheckIcon,
  CloseIcon,
  UndoIcon,
  TargetIcon,
  HistoryIcon,
  ActivityIcon,
  ZapIcon,
  GitMergeIcon,
  ShieldIcon,
} from './Icons.js';
import { GlassCard, GlassButton, useGlassVariant } from './GlassUI.js';

interface EvolutionViewProps {
  onToast: (msg: string) => void;
  onInspect: (id: string) => void;
  onUpdated: () => void;
}

const SCORE_WEIGHT_LABELS: Record<string, string> = {
  relevance: '词汇/实体相关性 (Relevance)',
  confidence: '来源可信度 (Confidence)',
  utility: '历史反馈效用 (Utility)',
  freshness: '时间新鲜度 (Freshness)',
  consistency: '无矛盾一致性 (Consistency)',
  specificity: '槽位特异性 (Specificity)',
  importance: '先验重要度 (Importance)',
};

const REPAIR_ACTION_LABELS: Record<string, { label: string; colorClass: string }> = {
  revise: { label: 'REVISE · 修订替换', colorClass: 'is-blue' },
  split: { label: 'SPLIT · 拆分细化', colorClass: 'is-purple' },
  invalidate: { label: 'INVALIDATE · 失效归档', colorClass: 'is-danger' },
};

export const EvolutionView: React.FC<EvolutionViewProps> = ({
  onToast,
  onInspect,
  onUpdated,
}) => {
  const variant = useGlassVariant();
  const [data, setData] = React.useState<EvolutionDataResponse | null>(null);
  const [health, setHealth] = React.useState<MemoryHealthReportUI | null>(null);
  const [loading, setLoading] = React.useState(true);

  // Action states
  const [isEvolving, setIsEvolving] = React.useState(false);
  const [isMaintaining, setIsMaintaining] = React.useState(false);
  const [isHealing, setIsHealing] = React.useState(false);
  const [isConsolidating, setIsConsolidating] = React.useState(false);
  const [isDistilling, setIsDistilling] = React.useState(false);
  const [isBackfilling, setIsBackfilling] = React.useState(false);
  const [backfillResult, setBackfillResult] = React.useState<{
    dryRun: boolean;
    stats: BackfillStatsUI;
  } | null>(null);
  const [taskFeedback, setTaskFeedback] = React.useState<{
    tone: 'ok' | 'warn' | 'err';
    text: string;
  } | null>(null);

  const [evalSuiteName, setEvalSuiteName] = React.useState('all');
  const [isRunningEval, setIsRunningEval] = React.useState(false);
  const [evalReport, setEvalReport] = React.useState<EvalSuiteReportUI | null>(null);

  const loadEvolution = React.useCallback(async () => {
    setLoading(true);
    try {
      const [res, healthRes] = await Promise.all([
        fetchEvolutionData(),
        fetchMemoryHealth().catch(() => null),
      ]);
      setData(res);
      if (healthRes?.health) {
        setHealth(healthRes.health);
      }
    } catch (err: any) {
      onToast(err?.message || '加载进化实验室数据失败');
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  React.useEffect(() => {
    loadEvolution();
  }, [loadEvolution]);

  const handleMergeDuplicatePair = async (sourceId: string, targetId: string) => {
    try {
      await performAction('merge', {
        sourceId,
        targetId,
        reason: 'health_doctor_dedup',
      });
      onToast(`已将冗余记忆 ${sourceId.slice(0, 10)} 合并至权威记忆 ${targetId.slice(0, 10)}！`);
      await loadEvolution();
      onUpdated();
    } catch (err: any) {
      onToast(err?.message || '合并去重失败');
    }
  };

  const handleApproveRepair = async (proposalId: number) => {
    try {
      await performAction('approve-repair', { proposalId });
      onToast(`修复提案 #${proposalId} 已批准并原子生效！`);
      await loadEvolution();
      onUpdated();
    } catch (err: any) {
      onToast(err?.message || '批准修复提案失败');
    }
  };

  const handleRejectRepair = async (proposalId: number) => {
    try {
      await performAction('reject-repair', { proposalId });
      onToast(`已拒绝修复提案 #${proposalId}`);
      await loadEvolution();
      onUpdated();
    } catch (err: any) {
      onToast(err?.message || '操作失败');
    }
  };

  const handleEvolveStrategy = async () => {
    setIsEvolving(true);
    try {
      const res = await performAction('evolve-strategy');
      const r = res.result;
      if (r?.promoted) {
        onToast(
          `策略进化晋升成功！新版本 v${r.promotedVersion} (Recall: ${(
            (r.bestMetrics?.recallAtInject || 0) * 100
          ).toFixed(1)}%)`
        );
      } else {
        onToast(`策略实验室探索完毕：${r?.reason || '当前基线策略已是最优，未触发晋升'}`);
      }
      await loadEvolution();
      onUpdated();
    } catch (err: any) {
      onToast(err?.message || '策略进化执行异常');
    } finally {
      setIsEvolving(false);
    }
  };

  const handleRollbackStrategy = async (targetVersion?: number) => {
    try {
      const res = await performAction('rollback-strategy', { targetVersion });
      onToast(`检索策略已成功回滚至版本 v${res.rolledBackTo}！`);
      await loadEvolution();
      onUpdated();
    } catch (err: any) {
      onToast(err?.message || '策略回滚失败');
    }
  };

  const handleMaintain = async () => {
    setIsMaintaining(true);
    try {
      const res = await performAction('maintain');
      const st = res?.stats;
      const summary = st
        ? `归档冷记忆 ${st.archivedCold} 条，自动置顶 ${st.autoPinned} 条${
            st.embeddingsBackfilled ? `，回填向量 ${st.embeddingsBackfilled} 条` : ''
          }${st.ftsRebuilt ? '，已重建 FTS5' : ''}`
        : '冷记忆归档、过期候选清理、自动置顶与 FTS5 索引校验已就绪';
      const msg = `离线维护完成：${summary}！`;
      setTaskFeedback({ tone: 'ok', text: msg });
      onToast(msg);
      await loadEvolution();
      onUpdated();
    } catch (err: any) {
      const msg = err?.message || '维护执行失败';
      setTaskFeedback({ tone: 'err', text: msg });
      onToast(msg);
    } finally {
      setIsMaintaining(false);
    }
  };

  const handleAutoHeal = async () => {
    setIsHealing(true);
    try {
      const res = await performAction('heal');
      const h = res?.heal;
      if (h) {
        if (h.report || h.health) setHealth(h.report || h.health);
        const msg = `一键自愈完成：合并重复 ${h.duplicatesMerged} 对，消解矛盾 ${h.contradictionsResolved} 组，回填向量 ${h.embeddingsBackfilled} 条 (健康分 ${h.beforeScore} → ${h.afterScore} · ${h.afterGrade})`;
        setTaskFeedback({ tone: 'ok', text: msg });
        onToast(msg);
      } else {
        setTaskFeedback({ tone: 'ok', text: '记忆库一键自愈已完成！' });
        onToast('记忆库一键自愈已完成！');
      }
      await loadEvolution();
      onUpdated();
    } catch (err: any) {
      const msg = err?.message || '自愈执行失败';
      setTaskFeedback({ tone: 'err', text: msg });
      onToast(msg);
    } finally {
      setIsHealing(false);
    }
  };

  const handleConsolidateNow = async () => {
    setIsConsolidating(true);
    try {
      const res = await performAction('consolidate');
      const msg =
        res?.clustersFound > 0
          ? `记忆聚类巩固完成：发现 ${res.clustersFound} 个高价值簇，提炼 ${res.consolidated} 条程序性规则候选！`
          : '暂无满足跨 3 个独立会话正反馈条件的记忆簇可巩固';
      setTaskFeedback({ tone: res?.clustersFound > 0 ? 'ok' : 'warn', text: msg });
      onToast(msg);
      await loadEvolution();
      onUpdated();
    } catch (err: any) {
      const msg = err?.message || '聚类巩固执行失败';
      setTaskFeedback({ tone: 'err', text: msg });
      onToast(msg);
    } finally {
      setIsConsolidating(false);
    }
  };

  const handleDistillNow = async () => {
    setIsDistilling(true);
    try {
      const res = await performAction('distill');
      const r = res?.result;
      if (r?.success) {
        const consumed = r.consumedCount ?? r.eventsProcessed ?? 0;
        const created = r.itemsCreated ?? r.candidatesInserted ?? 0;
        const msg =
          consumed > 0
            ? `会话蒸馏完成：处理 ${consumed} 条事件，新增 ${created} 条候选记忆！`
            : '当前所有历史会话事件均已完成蒸馏处理';
        setTaskFeedback({ tone: consumed > 0 ? 'ok' : 'warn', text: msg });
        onToast(msg);
      } else {
        const msg = `会话蒸馏提示：${r?.error || '暂无满足蒸馏条件的未处理事件或离线权限未开启'}`;
        setTaskFeedback({ tone: 'warn', text: msg });
        onToast(msg);
      }
      await loadEvolution();
      onUpdated();
    } catch (err: any) {
      const msg = err?.message || '触发会话蒸馏失败';
      setTaskFeedback({ tone: 'err', text: msg });
      onToast(msg);
    } finally {
      setIsDistilling(false);
    }
  };

  const handleBackfill = async (dryRun: boolean) => {
    setIsBackfilling(true);
    try {
      const res = await performAction('backfill', { dryRun });
      setBackfillResult({ dryRun, stats: res.stats });
      const msg = dryRun
        ? `回填预演完成：扫描 ${res.stats.processedFiles} 个会话，发现 ${res.stats.writableEvents} 条可写事件`
        : `历史回填完成：扫描 ${res.stats.processedFiles} 个会话，入库 ${res.stats.newEventsAdded} 条事件，新增 ${res.stats.memoriesCreated} 条规则记忆！可继续点击「立即蒸馏会话」用 LLM 提炼深层记忆`;
      setTaskFeedback({ tone: 'ok', text: msg });
      onToast(msg);
      if (!dryRun) {
        await loadEvolution();
        onUpdated();
      }
    } catch (err: any) {
      const msg = err?.message || '历史会话回填失败';
      setTaskFeedback({ tone: 'err', text: msg });
      onToast(msg);
    } finally {
      setIsBackfilling(false);
    }
  };

  const handleRunEval = async () => {
    setIsRunningEval(true);
    try {
      const res = await performAction('eval', { suite: evalSuiteName });
      setEvalReport(res.report);
      onToast(
        `基准评测完成：Recall@Inject ${(res.report.overall.recallAtInject * 100).toFixed(1)}%，门禁 ${
          res.report.mvpPassed ? 'PASS' : 'FAIL'
        }`
      );
    } catch (err: any) {
      onToast(err?.message || '运行评测集失败');
    } finally {
      setIsRunningEval(false);
    }
  };

  if (loading && !data) {
    return (
      <GlassCard variant={variant} interactive={false} className="dshm-loading-state">
        <div className="dshm-spin">
          <RefreshIcon size={22} />
        </div>
        <span>正在加载自进化实验室与诊断中心…</span>
      </GlassCard>
    );
  }

  const activeStrat = data?.activeStrategy;
  const strategies = data?.strategies || [];
  const proposals = data?.repairProposals || [];
  const pendingProposals = proposals.filter((p) => p.status === 'candidate');
  const recentJobs = data?.recentJobs || [];

  return (
    <div className="dshm-evo-container">
      {/* 0. Memory Health & Conflict Doctor (v0.3.0) */}
      {health && (
        <GlassCard as="section" variant={variant} interactive={false} className="dshm-evo-panel">
          <div className="dshm-evo-panel-header">
            <div className="dshm-evo-title-group">
              <div className="dshm-stat-icon-wrapper dshm-icon-emerald">
                <ShieldIcon size={16} />
              </div>
              <div>
                <div className="dshm-evo-title-row">
                  <h3>记忆库健康度体检与冲突医生 (Memory Health Doctor)</h3>
                  <span
                    className={`dshm-tag ${
                      health.score >= 85 ? 'dshm-tag-fact' : 'dshm-tag-failure'
                    }`}
                  >
                    健康分 {health.score} / 100 · 等级 {health.grade}
                  </span>
                  <span className="dshm-tag dshm-tag-scope">
                    FTS5 {health.ftsConsistent ? '索引一致' : '需重建'} ({health.ftsCount})
                  </span>
                  {health.embeddingsReadyCount !== undefined && (
                    <span className="dshm-tag dshm-tag-preference">
                      128D 向量已就绪 {health.embeddingsReadyCount}
                      {health.missingEmbeddingsCount ? ` (待补 ${health.missingEmbeddingsCount})` : ' ✓'}
                    </span>
                  )}
                </div>
                <p className="dshm-evo-subtitle">
                  自动巡检同作用域槽位冲突、128D 语义与词汇高相似冗余对、未消解矛盾与陈旧低效用记忆
                </p>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <GlassButton
                type="button"
                variant={variant}
                intent="primary"
                className="dshm-btn dshm-btn-primary"
                disabled={isHealing}
                onClick={handleAutoHeal}
                title="一键修复 FTS5 索引、回填 128D 向量、合并重复记忆对并消解非冻结矛盾"
              >
                <ZapIcon size={13} />
                <span>{isHealing ? '自愈修复中…' : '⚡ 一键智能自愈 (Auto-Heal)'}</span>
              </GlassButton>
              <GlassButton
                type="button"
                variant={variant}
                className="dshm-btn dshm-btn-secondary"
                onClick={loadEvolution}
              >
                <RefreshIcon size={13} />
                <span>重新体检</span>
              </GlassButton>
            </div>
          </div>

          <div className="dshm-strat-kpis" style={{ marginBottom: 12 }}>
            <div className="dshm-strat-kpi">
              <span>活跃 / 冻结记忆</span>
              <strong>
                {health.counts.active} / {health.counts.frozen}
              </strong>
            </div>
            <div className="dshm-strat-kpi">
              <span>近重复 / 槽位冲突</span>
              <strong>{health.duplicatePairs.length} 对</strong>
            </div>
            <div className="dshm-strat-kpi">
              <span>活跃矛盾 (contradicts)</span>
              <strong>{health.contradictions.length} 组</strong>
            </div>
            <div className="dshm-strat-kpi">
              <span>低效用陈旧记忆</span>
              <strong>{health.staleMemories.length} 条</strong>
            </div>
          </div>

          {health.recommendations.length > 0 && (
            <div className="dshm-proposal-reason" style={{ marginBottom: 10 }}>
              <strong>诊断建议：</strong> {health.recommendations.join(' ')}
            </div>
          )}

          {health.duplicatePairs.length > 0 && (
            <div className="dshm-proposal-list">
              {health.duplicatePairs.slice(0, 6).map((pair) => (
                <GlassCard
                  key={`${pair.sourceId}_${pair.targetId}`}
                  variant={variant}
                  className="dshm-proposal-card"
                >
                  <div className="dshm-proposal-top">
                    <div className="dshm-proposal-badges">
                      <span className="dshm-tag dshm-tag-procedure">
                        {pair.reason === 'same_slot_key'
                          ? '同槽位冲突'
                          : pair.reason === 'high_semantic_overlap'
                          ? '128D 语义冗余'
                          : '高重合冗余'}
                      </span>
                      <span className="dshm-tag dshm-tag-slot">
                        相似度 {(pair.similarity * 100).toFixed(0)}%
                      </span>
                      {pair.slotKey && (
                        <span className="dshm-tag dshm-tag-scope">slot: {pair.slotKey}</span>
                      )}
                    </div>
                    <div className="dshm-proposal-actions">
                      <GlassButton
                        type="button"
                        variant={variant}
                        intent="primary"
                        size="sm"
                        onClick={() => handleMergeDuplicatePair(pair.sourceId, pair.targetId)}
                      >
                        <GitMergeIcon size={12} />
                        <span>一键合并去重</span>
                      </GlassButton>
                    </div>
                  </div>
                  <div className="dshm-proposal-diff">
                    <div
                      className="dshm-diff-box is-old"
                      style={{ cursor: 'pointer' }}
                      onClick={() => onInspect(pair.sourceId)}
                    >
                      <span className="dshm-diff-label">待合并冗余项 ({pair.sourceId.slice(0, 10)})</span>
                      <div>{pair.sourceSummary}</div>
                    </div>
                    <div
                      className="dshm-diff-box is-new"
                      style={{ cursor: 'pointer' }}
                      onClick={() => onInspect(pair.targetId)}
                    >
                      <span className="dshm-diff-label">保留权威项 ({pair.targetId.slice(0, 10)})</span>
                      <div>{pair.targetSummary}</div>
                    </div>
                  </div>
                </GlassCard>
              ))}
            </div>
          )}
        </GlassCard>
      )}

      {/* 1. RIME 记忆冲突与修复提案审批台 */}
      <GlassCard as="section" variant={variant} interactive={false} className="dshm-evo-panel">
        <div className="dshm-evo-panel-header">
          <div className="dshm-evo-title-group">
            <div className="dshm-stat-icon-wrapper dshm-icon-amber">
              <SparklesIcon size={16} />
            </div>
            <div>
              <div className="dshm-evo-title-row">
                <h3>RIME 记忆冲突与修复提案审批台</h3>
                <span
                  className={`dshm-tab-badge ${
                    pendingProposals.length > 0 ? 'is-warm' : ''
                  }`}
                >
                  {pendingProposals.length} 条待审批
                </span>
              </div>
              <p className="dshm-evo-subtitle">
                当活跃记忆展开后触发用户负向反馈 (r ≤ −0.6) 时，慢环结合原始会话证据生成修订、拆分或失效提案，经确认后原子替换。
              </p>
            </div>
          </div>
          <GlassButton
            type="button"
            variant={variant}
            className="dshm-btn dshm-btn-secondary"
            onClick={loadEvolution}
          >
            <RefreshIcon size={13} />
            <span>刷新状态</span>
          </GlassButton>
        </div>

        {proposals.length === 0 ? (
          <div className="dshm-evo-empty">
            <span>✓ 当前记忆库健康无冲突，暂无待处理的 RIME 修复提案。</span>
          </div>
        ) : (
          <div className="dshm-proposal-list">
            {proposals.map((p) => {
              const actMeta = REPAIR_ACTION_LABELS[p.action] || {
                label: p.action.toUpperCase(),
                colorClass: 'is-blue',
              };
              const isPending = p.status === 'candidate';

              return (
                <GlassCard
                  key={p.id}
                  variant={variant}
                  className={`dshm-proposal-card ${isPending ? 'is-pending' : ''}`}
                >
                  <div className="dshm-proposal-top">
                    <div className="dshm-proposal-badges">
                      <span className="dshm-badge-version">Proposal #{p.id}</span>
                      <span className={`dshm-tag ${actMeta.colorClass}`}>
                        {actMeta.label}
                      </span>
                      <span
                        className="dshm-tag dshm-tag-slot"
                        style={{ cursor: 'pointer' }}
                        onClick={() => onInspect(p.memoryId)}
                        title="点击查看目标原记忆"
                      >
                        目标: {p.memoryId} (rev {p.contentRev})
                      </span>
                      <span className="dshm-tag dshm-tag-scope">
                        状态: {p.status === 'candidate' ? '待审批' : p.status === 'approved' ? '已批准' : '已拒绝'}
                      </span>
                    </div>

                    {isPending && (
                      <div className="dshm-proposal-actions">
                        <GlassButton
                          type="button"
                          variant={variant}
                          intent="success"
                          size="sm"
                          className="dshm-action-btn-approve"
                          onClick={() => handleApproveRepair(p.id)}
                        >
                          <CheckIcon size={12} />
                          <span>批准修复</span>
                        </GlassButton>
                        <GlassButton
                          type="button"
                          variant={variant}
                          size="sm"
                          className="dshm-btn dshm-btn-secondary"
                          onClick={() => handleRejectRepair(p.id)}
                        >
                          <CloseIcon size={12} />
                          <span>拒绝</span>
                        </GlassButton>
                      </div>
                    )}
                  </div>

                  <div className="dshm-proposal-reason">
                    <strong>诊断依据：</strong>
                    {p.reason}
                  </div>

                  {p.targetContent && (
                    <div className="dshm-proposal-diff">
                      <div className="dshm-diff-box is-old">
                        <span className="dshm-diff-label">原记忆正文</span>
                        <div>{p.targetContent}</div>
                      </div>
                      {p.candidates && p.candidates.length > 0 && (
                        <div className="dshm-diff-box is-new">
                          <span className="dshm-diff-label">
                            拟替换候选 ({p.candidates.length} 条)
                          </span>
                          {p.candidates.map((c) => (
                            <div key={c.id} className="dshm-diff-cand-item">
                              <code>[{c.type}]</code> {c.content}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </GlassCard>
              );
            })}
          </div>
        )}
      </GlassCard>

      {/* 2. Two-Column Grid: EvolveMem Strategy Lab & M4 Benchmark Eval */}
      <div className="dshm-evo-two-col">
        {/* Left: Strategy Lab */}
        <GlassCard as="section" variant={variant} interactive={false} className="dshm-evo-panel">
          <div className="dshm-evo-panel-header">
            <div className="dshm-evo-title-group">
              <div className="dshm-stat-icon-wrapper dshm-icon-indigo">
                <CpuIcon size={16} />
              </div>
              <div>
                <div className="dshm-evo-title-row">
                  <h3>EvolveMem 检索策略实验室</h3>
                  {activeStrat && (
                    <span className="dshm-badge-version">Active v{activeStrat.version}</span>
                  )}
                </div>
                <p className="dshm-evo-subtitle">
                  多路 RRF 融合权重与哨兵自动回滚保护 (纠正率恶化 &gt;5% 自动回退父版本)
                </p>
              </div>
            </div>

            <GlassButton
              type="button"
              variant={variant}
              intent="primary"
              className="dshm-btn dshm-btn-primary"
              disabled={isEvolving}
              onClick={handleEvolveStrategy}
              title="基于评测集与收获样本变异搜索更优策略参数"
            >
              <ZapIcon size={13} />
              <span>{isEvolving ? '变异探索中…' : '触发策略进化'}</span>
            </GlassButton>
          </div>

          {activeStrat && (
            <div className="dshm-strat-body">
              <div className="dshm-strat-kpis">
                <div className="dshm-strat-kpi">
                  <span>动态装箱上限</span>
                  <strong>{activeStrat.config.dynamicBudgetTokens} tok</strong>
                </div>
                <div className="dshm-strat-kpi">
                  <span>单轮最大条目</span>
                  <strong>{activeStrat.config.maxItems} 条</strong>
                </div>
                <div className="dshm-strat-kpi">
                  <span>RRF 平滑常数 K</span>
                  <strong>{activeStrat.config.rrfK}</strong>
                </div>
                <div className="dshm-strat-kpi">
                  <span>相关性硬门槛</span>
                  <strong>{activeStrat.config.minRelevance}</strong>
                </div>
              </div>

              <div className="dshm-strat-weights">
                <div className="dshm-strat-subhead">融合打分权重分布 (归一化 = 1.0)</div>
                {Object.entries(activeStrat.config.scoreWeights || {}).map(([k, val]) => {
                  const pct = Math.round((val || 0) * 100);
                  return (
                    <div key={k} className="dshm-weight-row">
                      <span className="dshm-weight-label">
                        {SCORE_WEIGHT_LABELS[k] || k}
                      </span>
                      <div className="dshm-weight-bar-track">
                        <div
                          className="dshm-weight-bar-fill"
                          style={{ width: `${Math.min(100, pct * 2)}%` }}
                        />
                      </div>
                      <strong className="dshm-weight-val">{pct}%</strong>
                    </div>
                  );
                })}
              </div>

              <div className="dshm-strat-channels">
                <div className="dshm-strat-subhead">多路召回通道增益 (Channel Weights)</div>
                <div className="dshm-channel-pills">
                  {Object.entries(activeStrat.config.channelWeights || {}).map(([ch, w]) => (
                    <span key={ch} className="dshm-metric-pill">
                      <span>{ch}</span>
                      <strong>×{Number(w).toFixed(2)}</strong>
                    </span>
                  ))}
                </div>
              </div>

              {strategies.length > 1 && (
                <div className="dshm-strat-history">
                  <div className="dshm-strat-subhead">策略版本谱系 ({strategies.length})</div>
                  <div className="dshm-strat-ver-list">
                    {strategies.slice(0, 5).map((s) => (
                      <div key={s.version} className="dshm-strat-ver-row">
                        <div>
                          <strong>v{s.version}</strong>
                          <span className={`dshm-tag is-status-${s.status}`} style={{ marginLeft: 6 }}>
                            {s.status}
                          </span>
                          {s.parent && (
                            <span className="dshm-text-muted" style={{ marginLeft: 6 }}>
                              ← parent v{s.parent}
                            </span>
                          )}
                        </div>
                        {s.status !== 'active' && (
                          <GlassButton
                            type="button"
                            variant={variant}
                            size="sm"
                            className="dshm-btn dshm-btn-ghost"
                            onClick={() => handleRollbackStrategy(s.version)}
                          >
                            <UndoIcon size={11} />
                            <span>切换至此版</span>
                          </GlassButton>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </GlassCard>

        {/* Right: M4 Recall Evaluation Suite */}
        <GlassCard as="section" variant={variant} interactive={false} className="dshm-evo-panel">
          <div className="dshm-evo-panel-header">
            <div className="dshm-evo-title-group">
              <div className="dshm-stat-icon-wrapper dshm-icon-emerald">
                <TargetIcon size={16} />
              </div>
              <div>
                <div className="dshm-evo-title-row">
                  <h3>M4 召回评测基准门禁</h3>
                  {evalReport && (
                    <span
                      className={`dshm-tag ${
                        evalReport.mvpPassed ? 'dshm-tag-fact' : 'dshm-tag-failure'
                      }`}
                    >
                      {evalReport.mvpPassed ? '✓ MVP 门禁达标' : '✗ 未达标'}
                    </span>
                  )}
                </div>
                <p className="dshm-evo-subtitle">
                  120 条隔离沙箱标准测试集 (Factual / Temporal / Procedural / Implicit)
                </p>
              </div>
            </div>

            <div className="dshm-eval-controls">
              <select
                className="dshm-sort-select"
                value={evalSuiteName}
                onChange={(e) => setEvalSuiteName(e.target.value)}
              >
                <option value="all">全部套件 (120 用例)</option>
                <option value="factual">Factual 事实 (30)</option>
                <option value="temporal">Temporal 时序 (30)</option>
                <option value="procedural">Procedural 流程 (30)</option>
                <option value="implicit">Implicit 偏好 (30)</option>
              </select>
              <GlassButton
                type="button"
                variant={variant}
                intent="primary"
                className="dshm-btn dshm-btn-primary"
                disabled={isRunningEval}
                onClick={handleRunEval}
              >
                <span>{isRunningEval ? '评测运行中…' : '▶ 运行评测'}</span>
              </GlassButton>
            </div>
          </div>

          {!evalReport ? (
            <div className="dshm-evo-empty is-tall">
              <p>点击上方“▶ 运行评测”在内存沙箱中执行 120 条回归测试并检验召回指标与延迟。</p>
            </div>
          ) : (
            <div className="dshm-eval-results">
              <div className="dshm-eval-grid">
                <div className="dshm-eval-metric-card">
                  <span>Recall @ Inject (门槛 ≥70%)</span>
                  <strong className="is-emerald">
                    {(evalReport.overall.recallAtInject * 100).toFixed(1)}%
                  </strong>
                  <small>
                    通过 {evalReport.overall.passedCases} / {evalReport.overall.totalCases} 用例
                  </small>
                </div>

                <div className="dshm-eval-metric-card">
                  <span>Critical 关键用例 (门槛 100%)</span>
                  <strong className="is-blue">
                    {evalReport.overall.criticalPassed} / {evalReport.overall.criticalTotal} (
                    {(evalReport.overall.criticalPassRate * 100).toFixed(0)}%)
                  </strong>
                  <small>核心记忆零漏召回</small>
                </div>

                <div className="dshm-eval-metric-card">
                  <span>Exclude 违规 (门槛 = 0)</span>
                  <strong
                    className={
                      evalReport.overall.excludeViolations === 0 ? 'is-emerald' : 'is-danger'
                    }
                  >
                    {evalReport.overall.excludeViolations} 次
                  </strong>
                  <small>
                    空门槛精度 {(evalReport.overall.emptyPrecision * 100).toFixed(0)}%
                  </small>
                </div>

                <div className="dshm-eval-metric-card">
                  <span>P95 检索延迟 (门槛 ≤50ms)</span>
                  <strong className="is-purple">
                    {evalReport.overall.p95LatencyMs.toFixed(2)} ms
                  </strong>
                  <small>平均注入 {evalReport.overall.avgInjectTokens} tokens</small>
                </div>
              </div>
            </div>
          )}
        </GlassCard>
      </div>

      {/* 3. Backfill, Maintenance & Recent Jobs */}
      <div className="dshm-evo-two-col">
        {/* Left: Backfill & Maintenance */}
        <GlassCard as="section" variant={variant} interactive={false} className="dshm-evo-panel">
          <div className="dshm-evo-panel-header">
            <div className="dshm-evo-title-group">
              <div className="dshm-stat-icon-wrapper dshm-icon-blue">
                <HistoryIcon size={16} />
              </div>
              <div>
                <h3>历史会话回填 (zstd) 与日常维护</h3>
                <p className="dshm-evo-subtitle">
                  多帧流式解压本地历史会话日志提炼规则记忆，或执行冷数据归档与 FTS5 索引修复
                </p>
              </div>
            </div>
          </div>

          <div className="dshm-maint-actions">
            <GlassButton
              type="button"
              variant={variant}
              className="dshm-btn dshm-btn-secondary"
              disabled={isBackfilling}
              onClick={() => handleBackfill(true)}
            >
              <span>🔍 回填预演 (Dry-Run)</span>
            </GlassButton>

            <GlassButton
              type="button"
              variant={variant}
              intent="primary"
              className="dshm-btn dshm-btn-primary"
              disabled={isBackfilling}
              onClick={() => handleBackfill(false)}
            >
              <span>{isBackfilling ? '正在扫描回填…' : '🚀 执行历史会话回填'}</span>
            </GlassButton>

            <GlassButton
              type="button"
              variant={variant}
              className="dshm-btn dshm-btn-secondary"
              disabled={isDistilling}
              onClick={handleDistillNow}
            >
              <span>{isDistilling ? '蒸馏中…' : '🧪 立即蒸馏会话'}</span>
            </GlassButton>

            <GlassButton
              type="button"
              variant={variant}
              className="dshm-btn dshm-btn-secondary"
              disabled={isConsolidating}
              onClick={handleConsolidateNow}
              title="将多次验证成功的相似情景/避坑记忆聚类巩固为程序性规则"
            >
              <span>{isConsolidating ? '聚类中…' : '🧩 立即聚类巩固'}</span>
            </GlassButton>

            <GlassButton
              type="button"
              variant={variant}
              className="dshm-btn dshm-btn-secondary"
              disabled={isMaintaining}
              onClick={handleMaintain}
            >
              <SparklesIcon size={13} />
              <span>{isMaintaining ? '维护中…' : '执行离线清理与维护'}</span>
            </GlassButton>
          </div>

          {taskFeedback && (
            <div
              className={`dshm-test-badge ${
                taskFeedback.tone === 'err'
                  ? 'dshm-test-badge-err'
                  : 'dshm-test-badge-ok'
              }`}
              style={{ marginTop: 8 }}
            >
              <span>{taskFeedback.text}</span>
            </div>
          )}

          {backfillResult && (
            <div className="dshm-backfill-report">
              <div className="dshm-strat-subhead">
                {backfillResult.dryRun ? '回填预演结果 (未写库)' : '正式回填执行结果'}
              </div>
              <div className="dshm-channel-pills">
                <span className="dshm-metric-pill">
                  <span>扫描文件</span>
                  <strong>{backfillResult.stats.processedFiles}</strong>
                </span>
                <span className="dshm-metric-pill">
                  <span>原始事件</span>
                  <strong>{backfillResult.stats.rawEvents}</strong>
                </span>
                <span className="dshm-metric-pill">
                  <span>可写事件</span>
                  <strong>{backfillResult.stats.writableEvents}</strong>
                </span>
                <span className="dshm-metric-pill">
                  <span>隐私拦截</span>
                  <strong>{backfillResult.stats.privacyRejected}</strong>
                </span>
                <span className="dshm-metric-pill">
                  <span>提炼记忆</span>
                  <strong className="dshm-text-emerald">
                    +{backfillResult.stats.memoriesCreated}
                  </strong>
                </span>
              </div>
            </div>
          )}
        </GlassCard>

        {/* Right: Background Jobs Monitor */}
        <GlassCard as="section" variant={variant} interactive={false} className="dshm-evo-panel">
          <div className="dshm-evo-panel-header">
            <div className="dshm-evo-title-group">
              <div className="dshm-stat-icon-wrapper dshm-icon-amber">
                <ActivityIcon size={16} />
              </div>
              <div>
                <h3>慢环异步任务队列监控</h3>
                <p className="dshm-evo-subtitle">
                  后台互斥调度器任务流水 (distill 蒸馏 / reflect 反思 / consolidate 巩固 / repair 修复 / evolve 进化)
                </p>
              </div>
            </div>
          </div>

          {recentJobs.length === 0 ? (
            <div className="dshm-evo-empty">
              <span>暂无后台异步任务记录。</span>
            </div>
          ) : (
            <div className="dshm-jobs-list">
              {recentJobs.slice(0, 6).map((j) => (
                <div key={j.id} className="dshm-job-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div className="dshm-job-left">
                      <span className="dshm-tag dshm-tag-slot">{j.kind}</span>
                      <span className="dshm-job-key" title={j.key}>
                        {j.key.length > 34 ? j.key.slice(0, 32) + '…' : j.key}
                      </span>
                    </div>
                    <div className="dshm-job-right">
                      <span className={`dshm-job-status is-${j.status}`}>{j.status}</span>
                      <span className="dshm-job-time">
                        {new Date(j.created_at).toLocaleTimeString()}
                      </span>
                    </div>
                  </div>
                  {j.last_error && (
                    <div className="dshm-text-danger" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                      ⚠ 异常原因: {j.last_error}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </GlassCard>
      </div>
    </div>
  );
};
