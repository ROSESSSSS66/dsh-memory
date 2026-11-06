import * as React from 'react';
import {
  getMemoryTypeMeta,
  type SandboxResponseUI,
} from '../types.js';
import { fetchSandboxData } from '../api.js';
import {
  SearchIcon,
  SparklesIcon,
  RefreshIcon,
  CopyIcon,
  EyeIcon,
  CodeIcon,
  ActivityIcon,
  TargetIcon,
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
  fts: { label: 'BM25 全文', cls: 'is-blue' },
  vec: { label: 'Vector 语义', cls: 'is-purple' },
  entity: { label: 'Entity 实体', cls: 'is-emerald' },
  slot: { label: 'Slot 槽位', cls: 'is-amber' },
  graph: { label: 'Graph 拓扑', cls: 'is-cyan' },
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
              <strong>动态召回层 (5-Channel RRF):</strong> {dynamicTokens} / {dynamicBudget} tok ({sim?.items.length ?? 0} 条)
            </span>
            <span className="dshm-ctx-legend-item">
              <i className="dshm-ctx-dot is-free" />
              <strong>剩余可用预算:</strong> {Math.max(0, totalBudget - totalUsed)} tok
            </span>
          </div>
        </div>
      </GlassCard>

      {/* 2. Interactive 5-Channel Recall Playground + Prompt Preview */}
      <div className="dshm-sandbox-grid">
        {/* Left: Query Simulator & 5-Channel Recall Hits */}
        <GlassCard variant={variant} interactive={false} className="dshm-evo-panel">
          <div className="dshm-evo-panel-header">
            <div className="dshm-evo-panel-title-group">
              <div className="dshm-stat-icon-wrapper dshm-icon-blue">
                <TargetIcon size={16} />
              </div>
              <div>
                <h3 className="dshm-evo-panel-title">5 路融合召回调试沙盒 (Recall Playground)</h3>
                <span className="dshm-evo-panel-subtitle">
                  输入模拟用户提问，透视分词意图解析、5 路通道命中（BM25 / Vector / Entity / Slot / Graph）与 RRF 融合排序
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
              点击上方快速测试问题或输入自定义提问，即可查看 5 路召回命中明细与各通道得分。
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
