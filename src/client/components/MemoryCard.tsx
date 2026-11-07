import React from 'react';
import { GlassCard, GlassBadge } from './GlassUI.js';

export interface MemoryItem {
  id: string;
  type: string;
  status: string;
  content: string;
  summary: string;
  slot_key?: string | null;
  scope: string;
  workspace_id?: string | null;
  source_kind: string;
  confidence: number;
  utility: number;
  importance?: number;
  use_count: number;
  token_cost: number;
  version: number;
  content_rev: number;
  pinned: number;
  created_at: number;
  updated_at: number;
  last_used_at?: number | null;
}

export interface MemoryCardProps {
  memory: MemoryItem;
  onSelect: (memory: MemoryItem) => void;
}

const TYPE_META: Record<
  string,
  { label: string; variant: 'accent' | 'purple' | 'cyan' | 'emerald' | 'amber' | 'rose' | 'neutral' }
> = {
  semantic: { label: '事实 Semantic', variant: 'cyan' },
  preference: { label: '偏好 Preference', variant: 'purple' },
  procedural: { label: '流程 Procedural', variant: 'emerald' },
  episodic: { label: '事件 Episodic', variant: 'accent' },
  failure: { label: '教训 Failure', variant: 'rose' },
  belief: { label: '推断 Belief', variant: 'amber' },
  goal: { label: '目标 Goal', variant: 'emerald' },
  meta: { label: '元认知 Meta', variant: 'neutral' },
};

const STATUS_META: Record<
  string,
  { label: string; variant: 'emerald' | 'amber' | 'neutral' | 'rose' | 'cyan' }
> = {
  active: { label: '● 已生效', variant: 'emerald' },
  candidate: { label: '◌ 自动观察中', variant: 'amber' },
  frozen: { label: '❄ 冻结保护', variant: 'cyan' },
  superseded: { label: '↺ 已演进取代', variant: 'neutral' },
  archived: { label: '▫ 已归档', variant: 'neutral' },
};

function formatRelativeTime(ts?: number | null): string {
  if (!ts) return '未知时间';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  const days = Math.floor(diffSec / 86400);
  if (days < 30) return `${days} 天前`;
  return new Date(ts).toLocaleDateString();
}

export function MemoryCard({ memory, onSelect }: MemoryCardProps) {
  const typeInfo = TYPE_META[memory.type] || { label: memory.type, variant: 'neutral' };
  const statusInfo = STATUS_META[memory.status] || { label: memory.status, variant: 'neutral' };
  const shortId = memory.id.length > 10 ? `m_${memory.id.slice(-6)}` : memory.id;
  const utilityPct = Math.round((memory.utility ?? 0.5) * 100);
  const confPct = Math.round((memory.confidence ?? 0.8) * 100);

  return (
    <GlassCard
      interactive
      pinned={memory.pinned === 1}
      className="dshm-memory-card"
      onClick={() => onSelect(memory)}
    >
      <div>
        {/* Top Row: Type, Status, Pinned, ID */}
        <div className="dshm-memory-card-top">
          <div className="dshm-memory-card-badges">
            <GlassBadge variant={typeInfo.variant}>{typeInfo.label}</GlassBadge>
            <GlassBadge variant={statusInfo.variant}>{statusInfo.label}</GlassBadge>
            {memory.pinned === 1 && <GlassBadge variant="amber">★ 自动加精</GlassBadge>}
            <GlassBadge variant="neutral">
              {memory.scope === 'global' ? '全局' : '工作区'}
            </GlassBadge>
          </div>
          <span className="dshm-memory-id" title={memory.id}>
            {shortId} · v{memory.version}
          </span>
        </div>

        {/* Summary & Content */}
        <div style={{ marginTop: 11 }}>
          <h3 className="dshm-memory-summary">{memory.summary || memory.content}</h3>
          {memory.summary && memory.content !== memory.summary && (
            <p className="dshm-memory-content">{memory.content}</p>
          )}
          {memory.slot_key && (
            <div className="dshm-slot-tag" title="结构化状态槽位 (Slot Key)">
              <span>Slot</span>
              <span>{memory.slot_key}</span>
            </div>
          )}
        </div>
      </div>

      <div>
        {/* Telemetry Metrics */}
        <div className="dshm-memory-metrics" style={{ marginBottom: 10 }}>
          <div className="dshm-metric-item">
            <span className="dshm-metric-label">效用分 (Utility)</span>
            <span
              className="dshm-metric-val"
              style={{
                color:
                  utilityPct >= 65
                    ? 'var(--dshm-emerald)'
                    : utilityPct <= 35
                      ? 'var(--dshm-amber)'
                      : 'var(--dshm-text-primary)',
              }}
            >
              {utilityPct}%
            </span>
          </div>
          <div className="dshm-metric-item">
            <span className="dshm-metric-label">置信度 (Conf)</span>
            <span className="dshm-metric-val">{confPct}%</span>
          </div>
          <div className="dshm-metric-item">
            <span className="dshm-metric-label">召回 / 开销</span>
            <span className="dshm-metric-val">
              {memory.use_count}次 · {memory.token_cost}t
            </span>
          </div>
        </div>

        {/* Footer: Read-only Autonomous Status & Timestamp */}
        <div className="dshm-memory-footer">
          <span className="dshm-memory-time">
            更新于 {formatRelativeTime(memory.updated_at)}
          </span>
          <span
            style={{
              fontSize: 11,
              color: 'var(--dshm-text-muted)',
              fontFamily: 'var(--dsh-claude-font-code)',
            }}
          >
            点击审阅溯源 →
          </span>
        </div>
      </div>
    </GlassCard>
  );
}
