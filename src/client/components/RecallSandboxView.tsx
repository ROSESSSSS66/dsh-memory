import React, { useState, useEffect, useCallback } from 'react';
import { GlassCard, GlassBadge, GlassInput } from './GlassUI.js';
import type { MemoryItem } from './MemoryCard.js';

export interface RecallSimulationData {
  query: string;
  latencyMs: number;
  dynamicTokens: number;
  block: string;
  plan: {
    tokens: string[];
    contentTokens: string[];
    entities: string[];
    intents: Record<string, boolean>;
    temporalBrowse: boolean;
    preferenceBrowse: boolean;
  };
  items: Array<{
    memory: MemoryItem;
    form: 'full' | 'summary';
    score: number;
    tokens: number;
    matchedChannels: string[];
  }>;
}

export interface InjectionAuditItem {
  id: number;
  session_id: string;
  turn: number;
  memory_id: string;
  layer: string;
  rank: number;
  tokens: number;
  form: string;
  strategy_v: number;
  outcome: number | null;
  created_at: number;
  memory_type: string | null;
  memory_content: string | null;
  memory_summary: string | null;
  slot_key: string | null;
}

export interface RecallSandboxViewProps {
  apiPrefix: string;
  onSelectMemory?: (memory: MemoryItem) => void;
  onDataMutated?: () => void;
}

const CHANNEL_BADGE: Record<
  string,
  { label: string; variant: 'cyan' | 'purple' | 'emerald' | 'amber' | 'accent' | 'rose' }
> = {
  lexical: { label: 'BM25 词法', variant: 'cyan' },
  entity: { label: '代码实体', variant: 'accent' },
  tag: { label: 'Slot/标签', variant: 'amber' },
  vector: { label: '128D 向量', variant: 'purple' },
  graph: { label: '关系图谱', variant: 'emerald' },
  time: { label: '时间衰减', variant: 'rose' },
};

export function RecallSandboxView({
  apiPrefix,
  onSelectMemory,
}: RecallSandboxViewProps) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [stableLayer, setStableLayer] = useState<{
    text: string;
    stableTokens: number;
    stableBudgetTokens: number;
    visibleCount: number;
  } | null>(null);
  const [dynamicBudget, setDynamicBudget] = useState(1600);
  const [hardBudget, setHardBudget] = useState(3200);
  const [strategyVersion, setStrategyVersion] = useState(1);
  const [simulation, setSimulation] = useState<RecallSimulationData | null>(null);
  const [injections, setInjections] = useState<InjectionAuditItem[]>([]);

  const fetchSandbox = useCallback(
    async (simQuery?: string, silent = false) => {
      if (!silent) setLoading(true);
      try {
        const res = await fetch(`${apiPrefix}/sandbox`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: simQuery ?? '' }),
        });
        const json = await res.json();
        if (json.ok) {
          setStableLayer(json.stableLayer || null);
          setDynamicBudget(json.dynamicBudgetTokens || 1600);
          setHardBudget(json.hardBudgetTokens || 3200);
          setStrategyVersion(json.strategyVersion || 1);
          setSimulation(json.recallSimulation || null);
          setInjections(json.recentInjections || []);
        }
      } catch {
        // ignore network errors
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [apiPrefix]
  );

  // Debounced live recall simulation on input change
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchSandbox(query.trim(), false);
    }, 240);
    return () => clearTimeout(timer);
  }, [query, fetchSandbox]);

  // Automatic background telemetry refresh
  useEffect(() => {
    const interval = setInterval(() => {
      fetchSandbox(query.trim(), true);
    }, 8000);
    return () => clearInterval(interval);
  }, [query, fetchSandbox]);

  const stableTok = stableLayer?.stableTokens ?? 0;
  const stableMax = stableLayer?.stableBudgetTokens ?? 600;
  const dynTok = simulation?.dynamicTokens ?? 0;
  const totalTok = stableTok + dynTok;

  const stablePct = Math.min(100, Math.round((stableTok / Math.max(1, hardBudget)) * 100));
  const dynPct = Math.min(100, Math.round((dynTok / Math.max(1, hardBudget)) * 100));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Context Window Watermark Inspector */}
      <GlassCard style={{ padding: '18px 20px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
            marginBottom: 12,
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h3
                style={{
                  margin: 0,
                  fontFamily: 'var(--dsh-claude-font-serif)',
                  fontSize: 15.5,
                  fontWeight: 600,
                }}
              >
                上下文窗口预算水位仪 & 实时召回检视器 (Context Budget & Live Recall Inspector)
              </h3>
              <GlassBadge variant="accent">Strategy v{strategyVersion}</GlassBadge>
              {simulation && (
                <GlassBadge variant="emerald">
                  热路径耗时 {simulation.latencyMs.toFixed(1)} ms
                </GlassBadge>
              )}
            </div>
            <p
              style={{
                margin: '4px 0 0',
                fontSize: 12,
                color: 'var(--dshm-text-secondary)',
              }}
            >
              严格执行双层硬预算装箱（稳定层 ≤ {stableMax} tok，动态层 ≤ {dynamicBudget}{' '}
              tok，总硬顶 ≤ {hardBudget} tok），输入任意问题即可实时透视六路召回与 XML 注入块。
            </p>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: 'var(--dshm-text-muted)' }}>
              当前总注入 Token
            </div>
            <div
              style={{
                fontSize: 15,
                fontWeight: 600,
                fontFamily: 'var(--dsh-claude-font-code)',
                fontVariantNumeric: 'tabular-nums',
                color: totalTok > hardBudget ? 'var(--dshm-rose)' : 'var(--dshm-text-primary)',
              }}
            >
              {totalTok} / {hardBudget} tok
            </div>
          </div>
        </div>

        {/* Stacked Progress Bar */}
        <div
          className="dshm-progress-track"
          style={{
            height: 8,
            display: 'flex',
            background: 'var(--dsh-claude-inset)',
            border: '1px solid var(--dshm-glass-border)',
          }}
        >
          <div
            style={{
              width: `${stablePct}%`,
              background: 'var(--dshm-accent)',
              transition: 'width 0.3s ease',
            }}
            title={`Stable Layer: ${stableTok} tokens`}
          />
          <div
            style={{
              width: `${dynPct}%`,
              background: 'var(--dshm-cyan)',
              transition: 'width 0.3s ease',
            }}
            title={`Dynamic Layer: ${dynTok} tokens`}
          />
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 11,
            color: 'var(--dshm-text-muted)',
            marginTop: 6,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <span>
            <strong style={{ color: 'var(--dshm-accent)' }}>■ 稳定层 (Stable):</strong>{' '}
            {stableTok} / {stableMax} tok ({stableLayer?.visibleCount ?? 0} 条常驻)
          </span>
          <span>
            <strong style={{ color: 'var(--dshm-cyan)' }}>■ 动态层 (Dynamic):</strong>{' '}
            {dynTok} / {dynamicBudget} tok ({simulation?.items.length ?? 0} 条装入)
          </span>
          <span>剩余裕量: {Math.max(0, hardBudget - totalTok)} tok</span>
        </div>

        {/* Instant Live Query Input (No Manual Submit Button Needed) */}
        <div style={{ marginTop: 14, position: 'relative' }}>
          <GlassInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入任意测试问题实时检视六路召回（例如：项目数据库是什么版本？ / 为什么连接池超时？ / 代码规范偏好）..."
          />
          {loading && (
            <span
              style={{
                position: 'absolute',
                right: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                fontSize: 11,
                color: 'var(--dshm-text-muted)',
              }}
            >
              计算中...
            </span>
          )}
        </div>
      </GlassCard>

      {/* Simulation Output */}
      {simulation && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))',
            gap: 14,
          }}
        >
          {/* Left: Query Plan & Ranked Candidates */}
          <GlassCard style={{ padding: '18px 20px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 10,
              }}
            >
              <h4 className="dshm-section-title" style={{ margin: 0 }}>
                六路融合与效用装箱结果 ({simulation.items.length} 条命中)
              </h4>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {simulation.plan.entities.map((ent, idx) => (
                  <GlassBadge key={idx} variant="accent">
                    实体: {ent}
                  </GlassBadge>
                ))}
                {simulation.plan.preferenceBrowse && (
                  <GlassBadge variant="purple">偏好泛化意图</GlassBadge>
                )}
                {simulation.plan.temporalBrowse && (
                  <GlassBadge variant="amber">时间回溯意图</GlassBadge>
                )}
              </div>
            </div>

            {simulation.items.length === 0 ? (
              <div
                className="dshm-hint"
                style={{ padding: '24px 0', textAlign: 'center' }}
              >
                未命中满足准入阈值的动态记忆（或已被稳定层去重覆盖），触发静默跳过保护。
              </div>
            ) : (
              <div className="dshm-timeline">
                {simulation.items.map((item, idx) => (
                  <div
                    key={item.memory.id}
                    className="dshm-timeline-item"
                    style={{
                      cursor: onSelectMemory ? 'pointer' : 'default',
                      gap: 6,
                    }}
                    onClick={() => onSelectMemory?.(item.memory)}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        flexWrap: 'wrap',
                        gap: 6,
                      }}
                    >
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                      >
                        <GlassBadge variant="accent">#{idx + 1}</GlassBadge>
                        <GlassBadge variant="cyan">{item.memory.type}</GlassBadge>
                        <GlassBadge
                          variant={item.form === 'full' ? 'emerald' : 'neutral'}
                        >
                          {item.form === 'full' ? '全文装入' : '摘要装入'} ({item.tokens}t)
                        </GlassBadge>
                      </div>
                      <span
                        style={{
                          fontFamily: 'var(--dsh-claude-font-code)',
                          fontSize: 12,
                          fontWeight: 600,
                          color: 'var(--dshm-emerald)',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        Score: {item.score.toFixed(3)}
                      </span>
                    </div>

                    <div
                      style={{
                        fontSize: 12.5,
                        color: 'var(--dshm-text-primary)',
                        lineHeight: 1.5,
                      }}
                    >
                      {item.form === 'full'
                        ? item.memory.content
                        : item.memory.summary || item.memory.content}
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        flexWrap: 'wrap',
                        gap: 6,
                      }}
                    >
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {item.matchedChannels.map((ch) => {
                          const cb = CHANNEL_BADGE[ch] || {
                            label: ch,
                            variant: 'cyan' as const,
                          };
                          return (
                            <GlassBadge key={ch} variant={cb.variant}>
                              {cb.label}
                            </GlassBadge>
                          );
                        })}
                      </div>
                      <span
                        style={{
                          fontSize: 11,
                          color: 'var(--dshm-text-muted)',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        Utility {(item.memory.utility * 100).toFixed(0)}% · Conf{' '}
                        {(item.memory.confidence * 100).toFixed(0)}%
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </GlassCard>

          {/* Right: Exact XML Injection Preview */}
          <GlassCard style={{ padding: '18px 20px' }}>
            <h4 className="dshm-section-title">
              动态层 XML 注入块预览 (&lt;memory_context&gt; · {simulation.dynamicTokens} tokens)
            </h4>
            <div
              className="dshm-code-box"
              style={{
                maxHeight: 340,
                overflowY: 'auto',
                fontSize: 11.5,
              }}
            >
              {simulation.block ||
                '<!-- 空块：无动态记忆需要注入，在线热路径零额外 Token 开销 -->'}
            </div>
          </GlassCard>
        </div>
      )}

      {/* Stable Layer & Recent Online Injections Audit */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))',
          gap: 14,
        }}
      >
        <GlassCard style={{ padding: '18px 20px' }}>
          <h4 className="dshm-section-title">
            常驻稳定层渲染块预览 (System Prompt Stable Section · {stableTok} tokens)
          </h4>
          <div
            className="dshm-code-box"
            style={{
              maxHeight: 300,
              overflowY: 'auto',
              fontSize: 11.5,
            }}
          >
            {stableLayer?.text || '（当前工作区暂无常驻稳定层内容）'}
          </div>
        </GlassCard>

        <GlassCard style={{ padding: '18px 20px' }}>
          <h4 className="dshm-section-title">
            在线对话注入与归因审计流水 (Recent Turn Injections · {injections.length})
          </h4>
          {injections.length === 0 ? (
            <div
              className="dshm-hint"
              style={{ padding: '24px 0', textAlign: 'center' }}
            >
              暂无历史对话轮次的记忆注入审计流水。
            </div>
          ) : (
            <div
              className="dshm-timeline"
              style={{ maxHeight: 300, overflowY: 'auto' }}
            >
              {injections.map((inj) => (
                <div key={inj.id} className="dshm-timeline-item">
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 6,
                    }}
                  >
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                      <GlassBadge
                        variant={inj.layer === 'stable' ? 'accent' : 'cyan'}
                      >
                        {inj.layer} #{inj.rank}
                      </GlassBadge>
                      <span
                        style={{
                          fontSize: 11,
                          fontFamily: 'var(--dsh-claude-font-code)',
                          color: 'var(--dshm-text-muted)',
                        }}
                      >
                        Turn #{inj.turn} · {inj.tokens}t ({inj.form})
                      </span>
                    </div>
                    {inj.outcome !== null ? (
                      <GlassBadge
                        variant={
                          inj.outcome > 0
                            ? 'emerald'
                            : inj.outcome < 0
                              ? 'rose'
                              : 'neutral'
                        }
                      >
                        Outcome: {inj.outcome > 0 ? `+${inj.outcome}` : inj.outcome}
                      </GlassBadge>
                    ) : (
                      <GlassBadge variant="neutral">待归因</GlassBadge>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--dshm-text-secondary)',
                      marginTop: 2,
                    }}
                  >
                    {inj.memory_summary || inj.memory_content || inj.memory_id}
                  </div>
                </div>
              ))}
            </div>
          )}
        </GlassCard>
      </div>
    </div>
  );
}
