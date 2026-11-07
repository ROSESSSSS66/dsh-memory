import React, { useState, useEffect, useCallback } from 'react';
import { GlassCard, GlassBadge } from './GlassUI.js';

export interface RepairProposalItem {
  id: number;
  jobId: number | null;
  memoryId: string;
  contentRev: number;
  action: 'revise' | 'split' | 'invalidate';
  candidateIds: string[];
  reason: string;
  status: string;
  createdAt: number;
  expiresAt: number;
  targetSummary: string;
  targetContent: string;
  targetStatus: string;
  candidates: Array<{
    id: string;
    type: string;
    content: string;
    summary: string;
    slot_key: string | null;
  }>;
}

export interface StrategyVersionItem {
  version: number;
  status: 'active' | 'candidate' | 'archived' | 'rolled_back';
  parentVersion: number | null;
  config: {
    weights: {
      lexical: number;
      entity: number;
      tag: number;
      vector: number;
      graph: number;
      time: number;
    };
    utilityBoost: number;
    useBoost: number;
    typeBonus: Record<string, number>;
    mmrLambda: number;
    minScoreThreshold: number;
  };
  evalSummary: {
    recallAtInject?: number;
    emptyPrecision?: number;
    avgInjectTokens?: number;
    p95LatencyMs?: number;
  } | null;
  createdAt: number;
}

export interface JobLogItem {
  id: number;
  kind: string;
  key: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number | null;
}

export interface MemoryHealthReportData {
  score: number;
  grade: 'A+' | 'A' | 'B' | 'C' | 'D';
  counts: {
    total: number;
    active: number;
    candidate: number;
    frozen: number;
    superseded: number;
    archived: number;
    pinned: number;
  };
  ftsConsistent: boolean;
  ftsCount: number;
  missingEmbeddingsCount?: number;
  embeddingsReadyCount?: number;
  orphanMemoriesCount?: number;
  duplicatePairs: Array<{
    sourceId: string;
    targetId: string;
    sourceSummary: string;
    targetSummary: string;
    similarity: number;
    slotKey: string | null;
    reason: 'same_slot_key' | 'high_lexical_overlap' | 'high_semantic_overlap';
  }>;
  contradictions: Array<{
    fromId: string;
    toId: string;
    fromSummary: string;
    toSummary: string;
  }>;
  staleMemories: Array<{
    id: string;
    type: string;
    summary: string;
    utility: number;
    daysUnused: number;
  }>;
  recommendations: string[];
  checkedAt: number;
}

export interface EvolutionViewProps {
  apiPrefix: string;
  onNotify?: (msg: string) => void;
  onDataMutated?: () => void;
}

const ACTION_BADGE: Record<
  string,
  { label: string; variant: 'amber' | 'purple' | 'rose' }
> = {
  revise: { label: 'REVISE · 自动修订', variant: 'amber' },
  split: { label: 'SPLIT · 自动拆分', variant: 'purple' },
  invalidate: { label: 'INVALIDATE · 自动淘汰', variant: 'rose' },
};

export function EvolutionView({ apiPrefix }: EvolutionViewProps) {
  const [activeStrategy, setActiveStrategy] = useState<{
    version: number;
    config: StrategyVersionItem['config'];
  } | null>(null);
  const [strategies, setStrategies] = useState<StrategyVersionItem[]>([]);
  const [proposals, setProposals] = useState<RepairProposalItem[]>([]);
  const [recentJobs, setRecentJobs] = useState<JobLogItem[]>([]);
  const [health, setHealth] = useState<MemoryHealthReportData | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchEvolution = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const [resEvo, resHealth] = await Promise.all([
          fetch(`${apiPrefix}/evolution`),
          fetch(`${apiPrefix}/health`),
        ]);
        const json = await resEvo.json();
        if (json.ok) {
          setActiveStrategy(json.activeStrategy || null);
          setStrategies(json.strategies || []);
          setProposals(json.repairProposals || []);
          setRecentJobs(json.recentJobs || []);
        }
        const hJson = await resHealth.json();
        if (hJson.ok && hJson.health) {
          setHealth(hJson.health);
        }
      } catch {
        // ignore network errors
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [apiPrefix]
  );

  useEffect(() => {
    fetchEvolution(false);
    const timer = setInterval(() => {
      fetchEvolution(true);
    }, 8000);
    return () => clearInterval(timer);
  }, [fetchEvolution]);

  const weights = activeStrategy?.config?.weights;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Top Autonomous Status Banner */}
      <GlassCard style={{ padding: '16px 20px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
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
                全自动双环进化与自愈监控中心 (RIME + EvolveMem + A-Mem)
              </h3>
              <GlassBadge variant="accent">
                Active Strategy v{activeStrategy?.version ?? 1}
              </GlassBadge>
              <GlassBadge variant="emerald">● 全自动守护运行中</GlassBadge>
            </div>
            <p
              style={{
                margin: '5px 0 0',
                fontSize: 12,
                color: 'var(--dshm-text-secondary)',
              }}
            >
              系统在对话间隙 (`turn-stopping`) 与后台心跳周期自动执行会话蒸馏、失败反思、主题整合、RIME
              冲突修复、高置信候选晋升、A-Mem 双链织网与检索策略自进化，无需任何手动触发。
            </p>
          </div>
          {loading && (
            <GlassBadge variant="neutral">同步遥测中...</GlassBadge>
          )}
        </div>
      </GlassCard>

      {/* Section 0: Memory Health & Conflict Doctor */}
      {health && (
        <GlassCard style={{ padding: '18px 20px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 12,
              marginBottom: 14,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 10,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background:
                    health.score >= 85
                      ? 'var(--dshm-emerald-soft)'
                      : health.score >= 70
                        ? 'var(--dshm-amber-soft)'
                        : 'var(--dshm-rose-soft)',
                  border: '1px solid var(--dshm-glass-border)',
                }}
              >
                <span
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    fontFamily: 'var(--dsh-claude-font-code)',
                    color:
                      health.score >= 85
                        ? 'var(--dshm-emerald)'
                        : health.score >= 70
                          ? 'var(--dshm-amber)'
                          : 'var(--dshm-rose)',
                  }}
                >
                  {health.grade}
                </span>
                <span
                  style={{
                    fontSize: 9.5,
                    color: 'var(--dshm-text-muted)',
                    fontFamily: 'var(--dsh-claude-font-code)',
                  }}
                >
                  {health.score}/100
                </span>
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <h4
                    style={{
                      margin: 0,
                      fontSize: 14,
                      fontWeight: 600,
                    }}
                  >
                    记忆库健康度与全自动自愈医生 (Autonomous Memory Doctor)
                  </h4>
                  <GlassBadge variant={health.ftsConsistent ? 'emerald' : 'rose'}>
                    {health.ftsConsistent
                      ? `FTS5 索引同步 (${health.ftsCount})`
                      : 'FTS5 自动重建排队中'}
                  </GlassBadge>
                  <GlassBadge
                    variant={
                      (health.missingEmbeddingsCount ?? 0) === 0 ? 'cyan' : 'amber'
                    }
                  >
                    128D 语义向量: {health.embeddingsReadyCount ?? 0} 就绪
                  </GlassBadge>
                  <GlassBadge
                    variant={
                      (health.orphanMemoriesCount ?? 0) < 3 ? 'purple' : 'amber'
                    }
                  >
                    A-Mem 孤岛节点: {health.orphanMemoriesCount ?? 0}
                  </GlassBadge>
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--dshm-text-secondary)',
                    marginTop: 4,
                  }}
                >
                  {health.recommendations[0]}
                </div>
              </div>
            </div>
          </div>

          {(health.duplicatePairs.length > 0 || health.contradictions.length > 0) && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
                gap: 10,
              }}
            >
              {health.duplicatePairs.slice(0, 4).map((pair, idx) => (
                <div
                  key={`${pair.sourceId}_${pair.targetId}_${idx}`}
                  className="dshm-timeline-item"
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <GlassBadge variant="amber">
                        {pair.reason === 'same_slot_key'
                          ? `同槽位冲突: ${pair.slotKey}`
                          : pair.reason === 'high_semantic_overlap'
                            ? `128D 语义重合 ${Math.round(pair.similarity * 100)}%`
                            : `高相似 ${Math.round(pair.similarity * 100)}%`}
                      </GlassBadge>
                      <span
                        style={{
                          fontSize: 11,
                          fontFamily: 'var(--dsh-claude-font-code)',
                          color: 'var(--dshm-text-muted)',
                        }}
                      >
                        #{pair.sourceId.slice(-6)} → #{pair.targetId.slice(-6)}
                      </span>
                    </div>
                    <GlassBadge variant="neutral">待下一自愈周期自动合并</GlassBadge>
                  </div>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: 'var(--dshm-text-secondary)',
                      marginTop: 4,
                    }}
                  >
                    <div>• 旧/次记录: {pair.sourceSummary}</div>
                    <div>• 权威保留: {pair.targetSummary}</div>
                  </div>
                </div>
              ))}

              {health.contradictions.slice(0, 4).map((c, idx) => (
                <div key={`contra_${idx}`} className="dshm-timeline-item">
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <GlassBadge variant="rose">显式矛盾关系 (Contradicts)</GlassBadge>
                    <span
                      style={{
                        fontSize: 11,
                        fontFamily: 'var(--dsh-claude-font-code)',
                        color: 'var(--dshm-text-muted)',
                      }}
                    >
                      #{c.fromId.slice(-6)} ⚡ #{c.toId.slice(-6)}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: 'var(--dshm-text-secondary)',
                      marginTop: 4,
                    }}
                  >
                    <div>• {c.fromSummary}</div>
                    <div>• {c.toSummary}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </GlassCard>
      )}

      {/* Section 1: RIME Autonomous Repair Stream */}
      <GlassCard style={{ padding: '18px 20px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h4 className="dshm-section-title" style={{ margin: 0 }}>
              RIME 在线纠错与自动修复流 (Autonomous Memory Repairs)
            </h4>
            <GlassBadge variant={proposals.length > 0 ? 'amber' : 'emerald'}>
              {proposals.length > 0
                ? `${proposals.length} 项修复提案排队自愈中`
                : '0 待处理 · 全部已自动收敛'}
            </GlassBadge>
          </div>
          <span style={{ fontSize: 11.5, color: 'var(--dshm-text-muted)' }}>
            无需人工审批 · 自愈引擎自动校验证据并推进版本链
          </span>
        </div>

        {proposals.length === 0 ? (
          <div
            style={{
              padding: '18px',
              textAlign: 'center',
              color: 'var(--dshm-text-muted)',
              fontSize: 12.5,
              background: 'var(--dsh-claude-inset)',
              borderRadius: 'var(--dshm-radius-md)',
              border: '1px solid var(--dshm-glass-border)',
            }}
          >
            当前所有记忆均与对话反馈保持一致，无待处理的冲突修复项。
          </div>
        ) : (
          <div className="dshm-timeline">
            {proposals.map((prop) => {
              const badge = ACTION_BADGE[prop.action] || {
                label: prop.action,
                variant: 'amber' as const,
              };
              return (
                <div
                  key={prop.id}
                  className="dshm-timeline-item"
                  style={{ gap: 8, padding: '12px 14px' }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                      gap: 8,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <GlassBadge variant={badge.variant}>{badge.label}</GlassBadge>
                      <span
                        style={{
                          fontSize: 11.5,
                          fontFamily: 'var(--dsh-claude-font-code)',
                          color: 'var(--dshm-text-muted)',
                        }}
                      >
                        Proposal #{prop.id} · Target: {prop.memoryId.slice(-8)} (rev{' '}
                        {prop.contentRev})
                      </span>
                    </div>
                    <GlassBadge
                      variant={prop.status === 'approved' ? 'emerald' : 'amber'}
                    >
                      {prop.status === 'approved' ? '● 已自动应用' : '◌ 自愈队列中'}
                    </GlassBadge>
                  </div>

                  <div style={{ fontSize: 12, color: 'var(--dshm-text-secondary)' }}>
                    <strong>诊断依据：</strong> {prop.reason}
                  </div>

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns:
                        prop.candidates.length > 0 ? '1fr 1fr' : '1fr',
                      gap: 10,
                    }}
                  >
                    <div
                      className="dshm-code-box"
                      style={{
                        fontSize: 12,
                        borderColor: 'rgba(224, 108, 117, 0.28)',
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10.5,
                          color: 'var(--dshm-rose)',
                          marginBottom: 4,
                        }}
                      >
                        原记忆内容 ({prop.targetStatus}):
                      </div>
                      {prop.targetContent || prop.targetSummary || prop.memoryId}
                    </div>

                    {prop.candidates.length > 0 && (
                      <div
                        className="dshm-code-box"
                        style={{
                          fontSize: 12,
                          borderColor: 'rgba(140, 191, 150, 0.28)',
                        }}
                      >
                        <div
                          style={{
                            fontSize: 10.5,
                            color: 'var(--dshm-emerald)',
                            marginBottom: 4,
                          }}
                        >
                          新修订/拆分内容 ({prop.candidates.length} 条):
                        </div>
                        {prop.candidates.map((c, idx) => (
                          <div
                            key={c.id}
                            style={{ marginTop: idx > 0 ? 6 : 0 }}
                          >
                            • [{c.type}] {c.content}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </GlassCard>

      {/* Section 2: EvolveMem Strategy Weights & Slow-Loop Queue */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
          gap: 14,
        }}
      >
        {/* Left: Active Retrieval Strategy & Version Lineage */}
        <GlassCard style={{ padding: '18px 20px' }}>
          <h4 className="dshm-section-title">
            多路召回融合权重 (Strategy v{activeStrategy?.version ?? 1} · 六路 RRF + MMR)
          </h4>

          {weights ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 9,
                marginTop: 10,
              }}
            >
              {(
                [
                  ['lexical', 'BM25 词法通道 (Lexical FTS5)', weights.lexical, 'var(--dshm-cyan)'],
                  ['entity', '代码实体精确通道 (Entity)', weights.entity, 'var(--dshm-accent)'],
                  ['vector', '128D 语义向量通道 (Vector)', weights.vector, 'var(--dshm-purple)'],
                  ['graph', '关系图谱一跳扩展 (Graph)', weights.graph, 'var(--dshm-emerald)'],
                  ['tag', '结构化槽位与标签 (Slot/Tag)', weights.tag, 'var(--dshm-amber)'],
                  ['time', '艾宾浩斯时间衰减 (Time Decay)', weights.time, 'var(--dshm-rose)'],
                ] as const
              ).map(([key, label, val, color]) => {
                const pct = Math.min(100, Math.round((val || 0) * 100));
                return (
                  <div key={key}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: 12,
                        marginBottom: 4,
                      }}
                    >
                      <span style={{ color: 'var(--dshm-text-secondary)' }}>
                        {label}
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--dsh-claude-font-code)',
                          fontWeight: 600,
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {(val || 0).toFixed(2)} ({pct}%)
                      </span>
                    </div>
                    <div className="dshm-progress-track">
                      <div
                        className="dshm-progress-fill"
                        style={{ width: `${pct}%`, background: color }}
                      />
                    </div>
                  </div>
                );
              })}

              <div
                className="dshm-memory-metrics"
                style={{
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  marginTop: 8,
                }}
              >
                <div className="dshm-metric-item">
                  <span className="dshm-metric-label">MMR 多样性 λ</span>
                  <span className="dshm-metric-val">
                    {activeStrategy?.config.mmrLambda ?? 0.7}
                  </span>
                </div>
                <div className="dshm-metric-item">
                  <span className="dshm-metric-label">Utility 增益</span>
                  <span className="dshm-metric-val">
                    {activeStrategy?.config.utilityBoost ?? 0.3}
                  </span>
                </div>
                <div className="dshm-metric-item">
                  <span className="dshm-metric-label">最低准入阈值</span>
                  <span className="dshm-metric-val">
                    {activeStrategy?.config.minScoreThreshold ?? 0.15}
                  </span>
                </div>
              </div>
            </div>
          ) : null}

          {strategies.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <h5
                style={{
                  margin: '0 0 8px',
                  fontSize: 11.5,
                  color: 'var(--dshm-text-muted)',
                }}
              >
                策略版本演进历史 ({strategies.length})
              </h5>
              <div
                className="dshm-timeline"
                style={{ maxHeight: 170, overflowY: 'auto' }}
              >
                {strategies.map((st) => (
                  <div
                    key={st.version}
                    className="dshm-timeline-item"
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div>
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                      >
                        <strong
                          style={{
                            fontSize: 12.5,
                            fontFamily: 'var(--dsh-claude-font-code)',
                          }}
                        >
                          Strategy v{st.version}
                        </strong>
                        <GlassBadge
                          variant={
                            st.status === 'active'
                              ? 'emerald'
                              : st.status === 'rolled_back'
                                ? 'rose'
                                : 'neutral'
                          }
                        >
                          {st.status}
                        </GlassBadge>
                      </div>
                      {st.evalSummary?.recallAtInject !== undefined && (
                        <div
                          style={{
                            fontSize: 11,
                            color: 'var(--dshm-text-muted)',
                            marginTop: 2,
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          Recall@Inject:{' '}
                          {(st.evalSummary.recallAtInject * 100).toFixed(1)}% · Avg
                          Tokens: {Math.round(st.evalSummary.avgInjectTokens || 0)}
                        </div>
                      )}
                    </div>
                    <span
                      style={{
                        fontSize: 11,
                        color: 'var(--dshm-text-muted)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {new Date(st.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </GlassCard>

        {/* Right: Recent Background Jobs */}
        <GlassCard style={{ padding: '18px 20px' }}>
          <h4 className="dshm-section-title">
            后台慢环任务队列流水 (Autonomous Slow-Loop Jobs · 最近 {recentJobs.length} 条)
          </h4>
          {recentJobs.length === 0 ? (
            <div
              className="dshm-hint"
              style={{ padding: '24px 0', textAlign: 'center' }}
            >
              暂无后台慢环任务记录，将在每轮对话结束 (`turn-stopping`) 时自动调度。
            </div>
          ) : (
            <div
              className="dshm-timeline"
              style={{ maxHeight: 360, overflowY: 'auto', marginTop: 10 }}
            >
              {recentJobs.map((job) => (
                <div key={job.id} className="dshm-timeline-item">
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <GlassBadge variant="cyan">{job.kind}</GlassBadge>
                      <span
                        style={{
                          fontSize: 11.5,
                          fontFamily: 'var(--dsh-claude-font-code)',
                          color: 'var(--dshm-text-secondary)',
                        }}
                      >
                        {job.key.length > 28
                          ? `${job.key.slice(0, 28)}...`
                          : job.key}
                      </span>
                    </div>
                    <GlassBadge
                      variant={
                        job.status === 'done'
                          ? 'emerald'
                          : job.status === 'failed'
                            ? 'rose'
                            : 'amber'
                      }
                    >
                      {job.status}
                    </GlassBadge>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 11,
                      color: 'var(--dshm-text-muted)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    <span>
                      Job #{job.id} · Attempts: {job.attempts}
                    </span>
                    <span>{new Date(job.created_at).toLocaleString()}</span>
                  </div>
                  {job.last_error && (
                    <div style={{ fontSize: 11, color: 'var(--dshm-rose)' }}>
                      Error: {job.last_error}
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
}
