import React from 'react';
import { GlassModal, GlassBadge } from './GlassUI.js';
import type { MemoryItem } from './MemoryCard.js';

export interface MemoryDetailData {
  memory: MemoryItem;
  sources: Array<{
    session_id: string;
    seq: number;
    kind: string;
    excerpt?: string | null;
  }>;
  versions: Array<{
    version: number;
    content: string;
    reason?: string | null;
    actor?: string | null;
    created_at: number;
  }>;
  relations: Array<{
    from_id: string;
    to_id: string;
    rel: string;
    created_at: number;
  }>;
}

export interface MemoryDetailModalProps {
  open: boolean;
  detail: MemoryDetailData | null;
  loading: boolean;
  onClose: () => void;
}

export function MemoryDetailModal({
  open,
  detail,
  loading,
  onClose,
}: MemoryDetailModalProps) {
  const mem = detail?.memory;

  return (
    <GlassModal
      open={open}
      onClose={onClose}
      size="lg"
      title={
        <>
          <span>记忆全息溯源审阅</span>
          {mem && (
            <GlassBadge variant="accent">
              {mem.id.slice(-8)} · v{mem.version}
            </GlassBadge>
          )}
        </>
      }
    >
      {loading || !mem ? (
        <div className="dshm-empty" style={{ padding: '32px 0' }}>
          <div style={{ color: 'var(--dshm-text-secondary)', fontSize: 13 }}>
            正在加载记忆拓扑与证据链...
          </div>
        </div>
      ) : (
        <>
          {/* Meta Badges Row */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <GlassBadge variant="cyan">类型: {mem.type}</GlassBadge>
            <GlassBadge
              variant={
                mem.status === 'active'
                  ? 'emerald'
                  : mem.status === 'candidate'
                    ? 'amber'
                    : mem.status === 'frozen'
                      ? 'cyan'
                      : 'neutral'
              }
            >
              状态: {mem.status}
            </GlassBadge>
            <GlassBadge variant="neutral">
              作用域: {mem.scope === 'global' ? 'Global 全局' : 'Workspace 工作区'}
            </GlassBadge>
            <GlassBadge variant="purple">来源: {mem.source_kind}</GlassBadge>
            {mem.pinned === 1 && <GlassBadge variant="amber">★ 自动加精常驻</GlassBadge>}
            {mem.slot_key && <GlassBadge variant="accent">Slot: {mem.slot_key}</GlassBadge>}
          </div>

          {/* Content Section */}
          <div>
            <h4 className="dshm-section-title">完整记忆内容 (Content)</h4>
            <div className="dshm-code-box">{mem.content}</div>
          </div>

          {/* Summary if distinct */}
          {mem.summary && mem.summary !== mem.content && (
            <div>
              <h4 className="dshm-section-title">紧凑摘要 (Compact Summary · {mem.token_cost} tokens)</h4>
              <div
                className="dshm-code-box"
                style={{ fontSize: 12, color: 'var(--dshm-text-secondary)' }}
              >
                {mem.summary}
              </div>
            </div>
          )}

          {/* Core Telemetry Grid */}
          <div>
            <h4 className="dshm-section-title">全自动质量与归因指标 (Telemetry)</h4>
            <div className="dshm-memory-metrics" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
              <div className="dshm-metric-item">
                <span className="dshm-metric-label">效用评分 (Utility)</span>
                <span className="dshm-metric-val">{(mem.utility * 100).toFixed(1)}%</span>
              </div>
              <div className="dshm-metric-item">
                <span className="dshm-metric-label">置信度 (Confidence)</span>
                <span className="dshm-metric-val">{(mem.confidence * 100).toFixed(1)}%</span>
              </div>
              <div className="dshm-metric-item">
                <span className="dshm-metric-label">累计召回次数</span>
                <span className="dshm-metric-val">{mem.use_count} 次</span>
              </div>
              <div className="dshm-metric-item">
                <span className="dshm-metric-label">预估 Token 开销</span>
                <span className="dshm-metric-val">{mem.token_cost} tok</span>
              </div>
            </div>
          </div>

          {/* Sources Provenance */}
          <div>
            <h4 className="dshm-section-title">
              证据溯源链 (Provenance Sources · {detail.sources.length})
            </h4>
            {detail.sources.length === 0 ? (
              <div className="dshm-hint">无关联会话摘录</div>
            ) : (
              <div className="dshm-timeline">
                {detail.sources.map((src, idx) => (
                  <div key={idx} className="dshm-timeline-item">
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: 11.5,
                        color: 'var(--dshm-text-muted)',
                      }}
                    >
                      <span>
                        Session:{' '}
                        <code style={{ color: 'var(--dshm-accent)' }}>{src.session_id}</code> · Seq
                        #{src.seq}
                      </span>
                      <GlassBadge variant="neutral">{src.kind}</GlassBadge>
                    </div>
                    {src.excerpt && (
                      <div
                        style={{
                          fontSize: 12.5,
                          color: 'var(--dshm-text-secondary)',
                          marginTop: 4,
                        }}
                      >
                        “{src.excerpt}”
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Relations (Supersedes / Contradicts / Derived) */}
          {detail.relations.length > 0 && (
            <div>
              <h4 className="dshm-section-title">
                拓扑演化关系 (Causal & Zettelkasten Relations · {detail.relations.length})
              </h4>
              <div className="dshm-timeline">
                {detail.relations.map((rel, idx) => (
                  <div
                    key={idx}
                    className="dshm-timeline-item"
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        fontFamily: 'var(--dsh-claude-font-code)',
                      }}
                    >
                      {rel.from_id.slice(-8)} →{' '}
                      <strong style={{ color: 'var(--dshm-accent)' }}>{rel.rel}</strong> →{' '}
                      {rel.to_id.slice(-8)}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--dshm-text-muted)' }}>
                      {new Date(rel.created_at).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Version Snapshots */}
          {detail.versions.length > 0 && (
            <div>
              <h4 className="dshm-section-title">
                历史修订快照 (Version History · {detail.versions.length})
              </h4>
              <div className="dshm-timeline">
                {detail.versions.map((ver, idx) => (
                  <div key={idx} className="dshm-timeline-item">
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: 11.5,
                        color: 'var(--dshm-text-muted)',
                      }}
                    >
                      <span>
                        v{ver.version} · {ver.reason || 'auto_revision'} ({ver.actor || 'system'})
                      </span>
                      <span>{new Date(ver.created_at).toLocaleString()}</span>
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--dshm-text-secondary)',
                        marginTop: 4,
                      }}
                    >
                      {ver.content}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </GlassModal>
  );
}
