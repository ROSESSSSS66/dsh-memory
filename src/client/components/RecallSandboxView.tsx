import * as React from 'react';
import {
  getMemoryTypeMeta,
  type SandboxResponseUI,
  type ReconcileResponseUI,
} from '../types.js';
import { fetchSandboxData, runReconcile } from '../api.js';
import {
  SearchIcon,
  SparklesIcon,
  RefreshIcon,
  CopyIcon,
  EyeIcon,
  CodeIcon,
  ActivityIcon,
  TargetIcon,
  CheckIcon,
} from './Icons.js';
import { GlassCard, GlassButton, GlassInput, useGlassVariant } from './GlassUI.js';

interface RecallSandboxViewProps {
  onToast: (msg: string) => void;
  onInspect: (id: string) => void;
}

const PRESET_QUERIES = [
  '我的代码风格与偏好习惯有哪些？',
  '项目构建与运行测试的标准流程是什么？',
  '之前遇到报错或异常是怎么排查修复的？',
  '最近在架构演进上做了哪些关键决策？',
];

const CHANNEL_LABELS: Record<string, { label: string; cls: string }> = {
  lexical: { label: 'BM25 全文', cls: 'is-blue' },
  fts: { label: 'BM25 全文', cls: 'is-blue' },
  entity: { label: 'Entity 实体', cls: 'is-emerald' },
  typed: { label: 'Typed 类型', cls: 'is-amber' },
  slot: { label: 'Slot 槽位', cls: 'is-amber' },
  temporal: { label: 'Temporal 时间', cls: 'is-cyan' },
  graph: { label: 'Graph 拓扑', cls: 'is-cyan' },
  preference: { label: 'Preference 偏好', cls: 'is-purple' },
  vector: { label: 'Vector 向量', cls: 'is-purple' },
  vec: { label: 'Vector 向量', cls: 'is-purple' },
};

export const RecallSandboxView: React.FC<RecallSandboxViewProps> = ({
  onToast,
  onInspect,
}) => {
  const variant = useGlassVariant();
  const [data, setData] = React.useState<SandboxResponseUI | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [simulating, setSimulating] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [activePromptTab, setActivePromptTab] = React.useState<'dynamic' | 'stable'>('dynamic');

  // Mem0 Reconcile Playground state
  const [reconcileInput, setReconcileInput] = React.useState('');
  const [reconcileSlotKey, setReconcileSlotKey] = React.useState('');
  const [reconcileType, setReconcileType] = React.useState<'semantic' | 'preference' | 'procedural'>('semantic');
  const [reconcilePreview, setReconcilePreview] = React.useState<ReconcileResponseUI | null>(null);
  const [reconciling, setReconciling] = React.useState(false);

  const loadSandbox = React.useCallback(async (testQuery?: string) => {
    if (testQuery !== undefined) setSimulating(true);
    else setLoading(true);
    try {
      const res = await fetchSandboxData(testQuery);
      setData(res);
      if (testQuery && res.recallSimulation) {
        setActivePromptTab('dynamic');
      } else if (!testQuery) {
        setActivePromptTab('stable');
      }
    } catch (err: any) {
      onToast(err?.message || '加载召回沙盒失败');
    } finally {
      setLoading(false);
      setSimulating(false);
    }
  }, [onToast]);

  React.useEffect(() => {
    loadSandbox();
  }, [loadSandbox]);

  const handleRunQuery = (e?: React.FormEvent, overrideQuery?: string) => {
    if (e) e.preventDefault();
    const q = overrideQuery !== undefined ? overrideQuery : query;
    if (overrideQuery !== undefined) setQuery(overrideQuery);
    loadSandbox(q);
  };

  const handleCopyPrompt = (text: string, label: string) => {
    if (!text) return;
    navigator.clipboard?.writeText(text);
    onToast(`已复制 ${label} Prompt XML 到剪贴板`);
  };

  const handleReconcileTest = async (dryRun: boolean) => {
    if (!reconcileInput.trim() || reconcileInput.trim().length < 4) {
      onToast('请输入至少 4 个字符的陈述内容');
      return;
    }
    setReconciling(true);
    try {
      const res = await runReconcile({
        content: reconcileInput.trim(),
        type: reconcileType,
        slot_key: reconcileSlotKey.trim() || undefined,
        dryRun,
      });
      setReconcilePreview(res);
      if (!dryRun) {
        onToast(`已执行动态调和 [${res.decision.action}]：${res.decision.reason}`);
        loadSandbox(query || undefined);
      }
    } catch (err: any) {
      onToast(err?.message || '调和模拟失败');
    } finally {
      setReconciling(false);
    }
  };

  if (loading && !data) {
    return (
      <GlassCard variant={variant} interactive={false} className="dshm-loading-state">
        <div className="dshm-spin">
          <RefreshIcon size={22} />
        </div>
        <div>正在初始化召回沙盒与上下文透视器…</div>
      </GlassCard>
    );
  }

  const stableTokens = data?.stableLayer.stableTokens ?? 0;
  const stableBudget = data?.stableLayer.stableBudgetTokens ?? 600;
  const dynamicTokens = data?.recallSimulation?.dynamicTokens ?? 0;
  const dynamicBudget = data?.dynamicBudgetTokens ?? 1600;
  const totalBudget = stableBudget + dynamicBudget;
  const totalUsed = stableTokens + dynamicTokens;

  const stablePct = Math.min(100, Math.round((stableTokens / Math.max(1, totalBudget)) * 100));
  const dynamicPct = Math.min(
    100 - stablePct,
    Math.round((dynamicTokens / Math.max(1, totalBudget)) * 100)
  );

  const sim = data?.recallSimulation;
  const promptText =
    activePromptTab === 'dynamic'
      ? sim?.block || '<!-- 请在上方输入测试提问，触发动态召回后在此实时预览 <memory_context layer="dynamic"> 渲染结果 -->'
      : data?.stableLayer.text || '<!-- 当前尚无置顶记忆或 Core Memory 块，稳定层为空 -->';

  const renderOutcomeBadge = (outcome: number | null) => {
    if (outcome === null || outcome === undefined) {
      return <span className="dshm-audit-outcome is-neutral">待归因</span>;
    }
    if (outcome >= 0.8) {
      return <span className="dshm-audit-outcome is-positive">+{outcome.toFixed(1)} 确认有效</span>;
    }
    if (outcome > 0) {
      return <span className="dshm-audit-outcome is-ok">+{outcome.toFixed(1)} 正常推进</span>;
    }
    if (outcome <= -0.8) {
      return <span className="dshm-audit-outcome is-negative">{outcome.toFixed(1)} 用户纠正</span>;
    }
    return <span className="dshm-audit-outcome is-warn">{outcome.toFixed(1)} 工具异常</span>;
  };

  return (
    <div className="dshm-sandbox-container">
      {/* 1. Letta ADE Style: Context Window Budget Allocation Bar */}
      <GlassCard variant={variant} interactive={false} className="dshm-evo-panel">
        <div className="dshm-evo-panel-header">
          <div className="dshm-evo-panel-title-group">
            <div className="dshm-stat-icon-wrapper dshm-icon-indigo">
              <CodeIcon size={16} />
            </div>
            <div>
              <h3 className="dshm-evo-panel-title">
                Context Window 注入水位透视器 (Letta ADE Inspector)
              </h3>
              <span className="dshm-evo-panel-subtitle">
                实时监控常驻稳定层 (`layer=&quot;stable&quot;`) 与按需动态召回层 (`layer=&quot;dynamic&quot;`) 的 Token 占用比例与实际注入 XML
              </span>
            </div>
          </div>
          <div className="dshm-evo-panel-actions">
            <span className="dshm-tag dshm-tag-slot">
              Strategy v{data?.strategyVersion ?? 1}
            </span>
            <span className="dshm-tag dshm-tag-scope">
              总占用: {totalUsed} / {totalBudget} Tokens ({Math.round((totalUsed / Math.max(1, totalBudget)) * 100)}%)
            </span>
          </div>
        </div>

        {/* Stacked Multi-Segment Progress Bar */}
        <div className="dshm-ctx-meter">
          <div className="dshm-ctx-bar-track">
            <div
              className="dshm-ctx-bar-seg is-stable"
              style={{ width: `${stablePct}%` }}
              title={`常驻稳定层: ${stableTokens} / ${stableBudget} Tokens`}
            />
            <div
              className="dshm-ctx-bar-seg is-dynamic"
              style={{ width: `${dynamicPct}%` }}
              title={`动态召回层: ${dynamicTokens} / ${dynamicBudget} Tokens`}
            />
          </div>
          <div className="dshm-ctx-legend">
            <span className="dshm-ctx-legend-item">
              <i className="dshm-ctx-dot is-stable" />
              <strong>常驻稳定层 (Core + Pinned):</strong> {stableTokens} / {stableBudget} tok ({data?.stableLayer.visibleCount ?? 0} 条)
            </span>
            <span className="dshm-ctx-legend-item">
              <i className="dshm-ctx-dot is-dynamic" />
              <strong>动态召回层 (6-Channel RRF):</strong> {dynamicTokens} / {dynamicBudget} tok ({sim?.items.length ?? 0} 条)
            </span>
            <span className="dshm-ctx-legend-item">
              <i className="dshm-ctx-dot is-free" />
              <strong>剩余可用预算:</strong> {Math.max(0, totalBudget - totalUsed)} tok
            </span>
          </div>
        </div>
      </GlassCard>

      {/* 2. Interactive 6-Channel Recall Playground + Prompt Preview */}
      <div className="dshm-sandbox-grid">
        {/* Left: Query Simulator & Multi-Channel Recall Hits */}
        <GlassCard variant={variant} interactive={false} className="dshm-evo-panel">
          <div className="dshm-evo-panel-header">
            <div className="dshm-evo-panel-title-group">
              <div className="dshm-stat-icon-wrapper dshm-icon-blue">
                <TargetIcon size={16} />
              </div>
              <div>
                <h3 className="dshm-evo-panel-title">6 路融合召回调试沙盒 (Recall Playground)</h3>
                <span className="dshm-evo-panel-subtitle">
                  输入模拟用户提问，透视分词意图解析、6 路通道命中（BM25 / Entity / Typed / Temporal / Preference / Vector）与 RRF 融合排序
                </span>
              </div>
            </div>
          </div>

          <form className="dshm-sandbox-search-form" onSubmit={(e) => handleRunQuery(e)}>
            <GlassInput
              type="text"
              variant={variant}
              wrapperClassName="dshm-search-box"
              className="dshm-search-input"
              leftIcon={<SearchIcon size={14} />}
              placeholder="输入任意测试问题，检验哪些长期记忆会被检索召回…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <GlassButton
              type="submit"
              variant={variant}
              intent="primary"
              className="dshm-btn dshm-btn-primary"
              disabled={simulating || !query.trim()}
            >
              <SparklesIcon size={13} />
              <span>{simulating ? '检索中…' : '模拟召回'}</span>
            </GlassButton>
          </form>

          {/* Preset Quick Queries */}
          <div className="dshm-sandbox-presets">
            <span className="dshm-sandbox-preset-label">快速测试：</span>
            {PRESET_QUERIES.map((pq) => (
              <GlassButton
                key={pq}
                type="button"
                variant={variant}
                size="sm"
                className="dshm-chip-btn"
                onClick={() => handleRunQuery(undefined, pq)}
              >
                {pq}
              </GlassButton>
            ))}
          </div>

          {/* Query Plan Breakdown */}
          {sim && (
            <div className="dshm-plan-box">
              <div className="dshm-plan-row">
                <span className="dshm-plan-label">检索耗时:</span>
                <span className="dshm-tag dshm-tag-fact">{sim.latencyMs} ms</span>
                <span className="dshm-plan-label">识别意图:</span>
                {sim.plan.intents.preference && (
                  <span className="dshm-tag dshm-tag-preference">偏好意图 (Preference)</span>
                )}
                {sim.plan.intents.procedural && (
                  <span className="dshm-tag dshm-tag-procedure">流程排障 (Procedural)</span>
                )}
                {sim.plan.intents.temporal && (
                  <span className="dshm-tag dshm-tag-episodic">时间回溯 (Temporal)</span>
                )}
                {sim.plan.intents.causal && (
                  <span className="dshm-tag dshm-tag-failure">因果溯源 (Causal)</span>
                )}
                {!sim.plan.intents.preference &&
                  !sim.plan.intents.procedural &&
                  !sim.plan.intents.temporal &&
                  !sim.plan.intents.causal && (
                    <span className="dshm-tag dshm-tag-scope">通用语义检索</span>
                  )}
              </div>
              {sim.plan.contentTokens.length > 0 && (
                <div className="dshm-plan-row">
                  <span className="dshm-plan-label">核心分词:</span>
                  <div className="dshm-plan-tokens">
                    {sim.plan.contentTokens.slice(0, 12).map((tk) => (
                      <code key={tk} className="dshm-token-chip">
                        {tk}
                      </code>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Recalled Items List */}
          {!sim ? (
            <div className="dshm-evo-empty">
              点击上方快速测试问题或输入自定义提问，即可查看 6 路召回命中明细与各通道得分。
            </div>
          ) : sim.items.length === 0 ? (
            <div className="dshm-evo-empty">
              未召回任何动态记忆（可能记忆已常驻于稳定层被去重，或未达到绝对相关性防污染门槛）。
            </div>
          ) : (
            <div className="dshm-sandbox-hit-list">
              {sim.items.map((item, idx) => {
                const meta = getMemoryTypeMeta(item.memory.type);
                return (
                  <GlassCard
                    key={item.memory.id}
                    variant={variant}
                    className="dshm-sandbox-hit-card"
                    onClick={() => onInspect(item.memory.id)}
                  >
                    <div className="dshm-sandbox-hit-top">
                      <div className="dshm-card-badges">
                        <span className="dshm-hit-rank">#{idx + 1}</span>
                        <span className={`dshm-tag ${meta.tagClass}`}>{meta.label}</span>
                        <span className="dshm-tag dshm-tag-slot">
                          RRF: {item.score.toFixed(3)}
                        </span>
                        <span className="dshm-tag dshm-tag-scope">
                          {item.form === 'summary' ? '摘要注入' : '全文注入'} · {item.tokens} tok
                        </span>
                      </div>
                      <div className="dshm-hit-channels">
                        {item.matchedChannels.map((ch) => {
                          const chMeta = CHANNEL_LABELS[ch] || { label: ch, cls: 'is-blue' };
                          return (
                            <span
                              key={ch}
                              className={`dshm-channel-hit-pill ${chMeta.cls}`}
                            >
                              {chMeta.label}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                    <div className="dshm-sandbox-hit-content">
                      {item.form === 'summary' && item.memory.summary
                        ? item.memory.summary
                        : item.memory.content}
                    </div>
                  </GlassCard>
                );
              })}
            </div>
          )}
        </GlassCard>

        {/* Right: Live System Prompt XML Preview */}
        <GlassCard variant={variant} interactive={false} className="dshm-evo-panel">
          <div className="dshm-evo-panel-header">
            <div className="dshm-evo-panel-title-group">
              <div className="dshm-stat-icon-wrapper dshm-icon-emerald">
                <CodeIcon size={16} />
              </div>
              <div>
                <h3 className="dshm-evo-panel-title">系统提示词 XML 实时预览</h3>
                <span className="dshm-evo-panel-subtitle">
                  实际注入给大模型的 `&lt;memory_context&gt;` 结构化上下文块
                </span>
              </div>
            </div>
            <div className="dshm-evo-panel-actions">
              <div className="dshm-segmented-control">
                <button
                  type="button"
                  className={`dshm-segment-btn ${activePromptTab === 'dynamic' ? 'is-active' : ''}`}
                  onClick={() => setActivePromptTab('dynamic')}
                >
                  动态层 ({dynamicTokens}t)
                </button>
                <button
                  type="button"
                  className={`dshm-segment-btn ${activePromptTab === 'stable' ? 'is-active' : ''}`}
                  onClick={() => setActivePromptTab('stable')}
                >
                  稳定层 ({stableTokens}t)
                </button>
              </div>
              <GlassButton
                type="button"
                variant={variant}
                className="dshm-btn dshm-btn-secondary"
                onClick={() =>
                  handleCopyPrompt(
                    promptText,
                    activePromptTab === 'dynamic' ? '动态召回层' : '常驻稳定层'
                  )
                }
              >
                <CopyIcon size={13} />
                <span>复制 XML</span>
              </GlassButton>
            </div>
          </div>

          <pre className="dshm-prompt-preview-code">{promptText}</pre>
        </GlassCard>
      </div>

      {/* 2.5. Mem0 Dynamic Reconciliation Playground (ADD / UPDATE / DELETE / NOOP) */}
      <GlassCard variant={variant} interactive={false} className="dshm-evo-panel">
        <div className="dshm-evo-panel-header">
          <div className="dshm-evo-panel-title-group">
            <div className="dshm-stat-icon-wrapper dshm-icon-purple">
              <SparklesIcon size={16} />
            </div>
            <div>
              <h3 className="dshm-evo-panel-title">
                Mem0 动态冲突调和器沙盒 (Reconcile Decision Playground)
              </h3>
              <span className="dshm-evo-panel-subtitle">
                输入新事实或否定陈述，预览调和器如何自动判定 `ADD`（新增）、`UPDATE`（覆写旧槽位）、`DELETE`（否定归档）或 `NOOP`（幂等跳过）
              </span>
            </div>
          </div>
          <div className="dshm-evo-panel-actions">
            <select
              className="dshm-select"
              value={reconcileType}
              onChange={(e) => setReconcileType(e.target.value as any)}
            >
              <option value="semantic">事实知识 (Semantic)</option>
              <option value="preference">偏好习惯 (Preference)</option>
              <option value="procedural">流程规范 (Procedural)</option>
            </select>
          </div>
        </div>

        <div className="dshm-sandbox-search-form">
          <GlassInput
            type="text"
            variant={variant}
            wrapperClassName="dshm-search-box"
            className="dshm-search-input"
            placeholder="例如：不要再使用 Webpack 了，改用 Vite 构建（或输入任意待调和的新事实）…"
            value={reconcileInput}
            onChange={(e) => setReconcileInput(e.target.value)}
          />
          <GlassInput
            type="text"
            variant={variant}
            placeholder="可选槽位 (如 pkg_manager)"
            value={reconcileSlotKey}
            onChange={(e) => setReconcileSlotKey(e.target.value)}
          />
          <GlassButton
            type="button"
            variant={variant}
            className="dshm-btn dshm-btn-secondary"
            disabled={reconciling || !reconcileInput.trim()}
            onClick={() => handleReconcileTest(true)}
          >
            <EyeIcon size={13} />
            <span>预览决策 (Dry-Run)</span>
          </GlassButton>
          <GlassButton
            type="button"
            variant={variant}
            intent="primary"
            className="dshm-btn dshm-btn-primary"
            disabled={reconciling || !reconcileInput.trim()}
            onClick={() => handleReconcileTest(false)}
          >
            <CheckIcon size={13} />
            <span>应用调和入库</span>
          </GlassButton>
        </div>

        {reconcilePreview && (
          <div className="dshm-plan-box">
            <div className="dshm-plan-row">
              <span className="dshm-plan-label">调和判定动作:</span>
              <span
                className={`dshm-tag ${
                  reconcilePreview.decision.action === 'ADD'
                    ? 'dshm-tag-fact'
                    : reconcilePreview.decision.action === 'UPDATE'
                      ? 'dshm-tag-procedure'
                      : reconcilePreview.decision.action === 'DELETE'
                        ? 'dshm-tag-failure'
                        : 'dshm-tag-scope'
                }`}
              >
                {reconcilePreview.decision.action}
              </span>
              <span className="dshm-plan-label">判定置信度:</span>
              <span className="dshm-tag dshm-tag-slot">
                {(reconcilePreview.decision.confidence * 100).toFixed(0)}%
              </span>
              <span className="dshm-plan-label">原因说明:</span>
              <span>{reconcilePreview.decision.reason}</span>
              {reconcilePreview.decision.targetId && (
                <GlassButton
                  type="button"
                  variant={variant}
                  size="sm"
                  className="dshm-chip-btn"
                  onClick={() => onInspect(reconcilePreview.decision.targetId!)}
                >
                  目标记忆: {reconcilePreview.decision.targetId.slice(0, 12)}
                </GlassButton>
              )}
            </div>
          </div>
        )}
      </GlassCard>

      {/* 3. Mem0 OpenMemory Style: Live Injection & Attribution Audit Log */}
      <GlassCard variant={variant} interactive={false} className="dshm-evo-panel">
        <div className="dshm-evo-panel-header">
          <div className="dshm-evo-panel-title-group">
            <div className="dshm-stat-icon-wrapper dshm-icon-amber">
              <ActivityIcon size={16} />
            </div>
            <div>
              <h3 className="dshm-evo-panel-title">
                实时召回与归因审计流 (Mem0 OpenMemory Access Audit)
              </h3>
              <span className="dshm-evo-panel-subtitle">
                记录每次对话 Turn 实际注入的记忆条目、Token 开销以及下一轮用户反馈归因结果 (`outcome`)
              </span>
            </div>
          </div>
          <GlassButton
            type="button"
            variant={variant}
            className="dshm-btn dshm-btn-secondary"
            onClick={() => loadSandbox(query || undefined)}
          >
            <RefreshIcon size={13} />
            <span>刷新审计流</span>
          </GlassButton>
        </div>

        {!data?.recentInjections || data.recentInjections.length === 0 ? (
          <div className="dshm-evo-empty">
            暂无历史对话注入审计记录。当 Agent 在对话中自动召回长期记忆后，此表会实时记录每次命中与效用反馈。
          </div>
        ) : (
          <div className="dshm-table-container">
            <table className="dshm-data-table">
              <thead>
                <tr>
                  <th>时间 / 会话轮次</th>
                  <th>命中记忆内容</th>
                  <th>类型 / 槽位</th>
                  <th>注入层级 & 形态</th>
                  <th>Token 开销</th>
                  <th>反馈归因 (Outcome)</th>
                  <th className="is-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {data.recentInjections.map((row) => {
                  const meta = getMemoryTypeMeta(row.memory_type || 'semantic');
                  return (
                    <tr
                      key={row.id}
                      className="dshm-table-row"
                      onClick={() => onInspect(row.memory_id)}
                    >
                      <td className="dshm-td-mono">
                        <div>{new Date(row.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
                        <div className="dshm-td-sub">
                          {row.session_id.slice(0, 10)} · T{row.turn}
                        </div>
                      </td>
                      <td className="dshm-td-content">
                        <div className="dshm-td-clamp">
                          {row.memory_summary || row.memory_content || row.memory_id}
                        </div>
                      </td>
                      <td>
                        <span className={`dshm-tag ${meta.tagClass}`}>{meta.shortLabel} · {meta.label}</span>
                        {row.slot_key && (
                          <div className="dshm-td-sub dshm-td-mono">{row.slot_key}</div>
                        )}
                      </td>
                      <td>
                        <span className="dshm-tag dshm-tag-scope">
                          {row.layer} / {row.form} (#{row.rank})
                        </span>
                      </td>
                      <td className="dshm-td-mono">{row.tokens} tok</td>
                      <td>{renderOutcomeBadge(row.outcome)}</td>
                      <td className="is-right">
                        <GlassButton
                          type="button"
                          variant={variant}
                          size="icon"
                          className="dshm-action-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onInspect(row.memory_id);
                          }}
                          title="查看记忆详情"
                        >
                          <EyeIcon size={13} />
                        </GlassButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>
    </div>
  );
};
