import * as React from 'react';
import { getMemoryTypeMeta, type MemoryRecordUI, type ListDensityMode } from '../types.js';
import { GlassCard } from './GlassUI.js';
import {
  PinIcon,
  SnowflakeIcon,
  TrashIcon,
  EyeIcon,
  CheckIcon,
  GlobeIcon,
  FolderIcon,
  CopyIcon,
  UndoIcon,
  StarIcon,
} from './Icons.js';

interface MemoryCardProps {
  memory: MemoryRecordUI;
  density?: ListDensityMode;
  selected?: boolean;
  onSelectToggle?: (id: string) => void;
  onPinToggle: (id: string, currentPinned: boolean) => void;
  onFreezeToggle: (id: string, currentFrozen: boolean) => void;
  onForget: (id: string) => void;
  onRestore?: (id: string) => void;
  onConfirm?: (id: string) => void;
  onApprove: (id: string) => void;
  onInspect: (id: string) => void;
  onToast?: (msg: string) => void;
}

export function formatRelativeTime(ts: number): string {
  if (!ts) return '未知时间';
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  const days = Math.floor(diff / 86400000);
  if (days < 30) return `${days} 天前`;
  return new Date(ts).toLocaleDateString();
}

export const MemoryCard: React.FC<MemoryCardProps> = ({
  memory,
  density = 'card',
  selected = false,
  onSelectToggle,
  onPinToggle,
  onFreezeToggle,
  onForget,
  onRestore,
  onConfirm,
  onApprove,
  onInspect,
  onToast,
}) => {
  const isPinned = !!memory.pinned;
  const isFrozen = memory.status === 'frozen';
  const isCandidate = memory.status === 'candidate';
  const isArchived = memory.status === 'archived';
  const isSuperseded = memory.status === 'superseded';

  const typeMeta = getMemoryTypeMeta(memory.type);
  const importance = memory.importance ?? 5;
  const confPct = Math.round(memory.confidence * 100);
  const utilPct = Math.round(memory.utility * 100);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard
      .writeText(memory.content)
      .then(() => onToast?.('记忆正文已复制至剪贴板'))
      .catch(() => onToast?.('复制失败'));
  };

  if (density === 'compact') {
    return (
      <GlassCard
        as="article"
        active={selected}
        pinned={isPinned}
        candidate={isCandidate}
        className="dshm-compact-row"
        onClick={() => onInspect(memory.id)}
      >
        <div className="dshm-compact-left" onClick={(e) => e.stopPropagation()}>
          {onSelectToggle && (
            <label className="dshm-checkbox-label">
              <input
                type="checkbox"
                checked={selected}
                onChange={() => onSelectToggle(memory.id)}
                className="dshm-checkbox"
              />
            </label>
          )}
          <span className={`dshm-tag ${typeMeta.tagClass}`}>{typeMeta.label}</span>
          {isPinned && (
            <span className="dshm-tag dshm-badge-pinned" title="已固化置顶">
              <PinIcon size={10} />
            </span>
          )}
          {isFrozen && (
            <span className="dshm-tag dshm-badge-frozen" title="已冻结保护">
              <SnowflakeIcon size={10} />
            </span>
          )}
          {isCandidate && <span className="dshm-tag dshm-badge-candidate">待审</span>}
        </div>

        <div className="dshm-compact-body">
          <span className="dshm-compact-text">{memory.content}</span>
          {memory.slot_key && (
            <span className="dshm-tag dshm-tag-slot">{memory.slot_key}</span>
          )}
        </div>

        <div className="dshm-compact-right" onClick={(e) => e.stopPropagation()}>
          <span className="dshm-compact-meta" title="置信度 / 实用度">
            {confPct}% · 引用 {memory.use_count}
          </span>
          <span className="dshm-compact-time">{formatRelativeTime(memory.updated_at)}</span>
          <div className="dshm-card-actions">
            {isCandidate ? (
              <button
                type="button"
                className="dshm-action-btn-approve"
                onClick={() => onApprove(memory.id)}
              >
                <CheckIcon size={11} />
                <span>批准</span>
              </button>
            ) : (
              <button
                type="button"
                className={`dshm-action-btn ${isPinned ? 'is-active' : ''}`}
                onClick={() => onPinToggle(memory.id, isPinned)}
                title={isPinned ? '取消置顶' : '置顶固化'}
              >
                <PinIcon size={12} />
              </button>
            )}
            <button
              type="button"
              className="dshm-action-btn"
              onClick={() => onInspect(memory.id)}
              title="查看详情与编辑"
            >
              <EyeIcon size={13} />
            </button>
          </div>
        </div>
      </GlassCard>
    );
  }

  return (
    <GlassCard
      as="article"
      active={selected}
      pinned={isPinned}
      candidate={isCandidate}
      className={`dshm-card ${isFrozen ? 'is-frozen' : ''}`}
    >
      <div className="dshm-card-header">
        <div className="dshm-card-badges">
          {/* Checkbox for batch selection */}
          {onSelectToggle && (
            <label className="dshm-checkbox-label" onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={selected}
                onChange={() => onSelectToggle(memory.id)}
                className="dshm-checkbox"
              />
            </label>
          )}

          <span className={`dshm-tag ${typeMeta.tagClass}`}>{typeMeta.label}</span>

          <span className="dshm-tag dshm-tag-scope">
            {memory.scope === 'global' || memory.scope === 'user' ? (
              <>
                <GlobeIcon size={11} />
                <span>{memory.scope === 'user' ? '用户级' : '全局'}</span>
              </>
            ) : (
              <>
                <FolderIcon size={11} />
                <span>工作区</span>
              </>
            )}
          </span>

          {isPinned && (
            <span className="dshm-tag dshm-badge-pinned" title="已固化至 System Prompt 稳定层">
              <PinIcon size={11} />
              <span>已置顶</span>
            </span>
          )}

          {isFrozen && (
            <span className="dshm-tag dshm-badge-frozen" title="已冻结，免受离线演化覆盖">
              <SnowflakeIcon size={11} />
              <span>已冻结</span>
            </span>
          )}

          {isCandidate && (
            <span className="dshm-tag dshm-badge-candidate" title="待用户确认入库">
              待审核
            </span>
          )}

          {isArchived && <span className="dshm-tag dshm-badge-archived">已归档</span>}

          {isSuperseded && <span className="dshm-tag dshm-badge-superseded">已迭代替换</span>}

          {memory.slot_key && (
            <span className="dshm-tag dshm-tag-slot" title="唯一知识槽位键">
              #{memory.slot_key}
            </span>
          )}

          {importance >= 7 && (
            <span className="dshm-tag dshm-badge-importance" title={`重要度评分: ${importance}/10`}>
              <StarIcon size={10} />
              <span>P{importance}</span>
            </span>
          )}

          <span className="dshm-card-id" title={`完整 ID: ${memory.id}`}>
            {memory.id.length > 14 ? `${memory.id.slice(0, 12)}…` : memory.id}
          </span>
        </div>

        <div className="dshm-card-actions">
          <button
            type="button"
            className="dshm-action-btn"
            onClick={handleCopy}
            title="一键复制记忆正文"
          >
            <CopyIcon size={13} />
          </button>

          {isCandidate ? (
            <>
              <button
                type="button"
                className="dshm-action-btn-approve"
                onClick={() => onApprove(memory.id)}
                title="批准并激活入库"
              >
                <CheckIcon size={12} />
                <span>批准入库</span>
              </button>
              <button
                type="button"
                className="dshm-action-btn"
                onClick={() => onInspect(memory.id)}
                title="查看来源与详情"
              >
                <EyeIcon size={14} />
              </button>
              <button
                type="button"
                className="dshm-action-btn is-danger"
                onClick={() => onForget(memory.id)}
                title="拒绝并归档"
              >
                <TrashIcon size={14} />
              </button>
            </>
          ) : isArchived || isSuperseded ? (
            <>
              {onRestore && (
                <button
                  type="button"
                  className="dshm-action-btn-restore"
                  onClick={() => onRestore(memory.id)}
                  title="恢复为活跃记忆"
                >
                  <UndoIcon size={12} />
                  <span>恢复活跃</span>
                </button>
              )}
              <button
                type="button"
                className="dshm-action-btn"
                onClick={() => onInspect(memory.id)}
                title="查看版本快照与审计链"
              >
                <EyeIcon size={14} />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={`dshm-action-btn ${isPinned ? 'is-active' : ''}`}
                onClick={() => onPinToggle(memory.id, isPinned)}
                title={isPinned ? '取消置顶' : '置顶并固化到系统提示词'}
              >
                <PinIcon size={14} />
              </button>

              <button
                type="button"
                className={`dshm-action-btn ${isFrozen ? 'is-active-cyan' : ''}`}
                onClick={() => onFreezeToggle(memory.id, isFrozen)}
                title={isFrozen ? '解除冻结保护' : '冻结保护（禁止慢环自演化修改）'}
              >
                <SnowflakeIcon size={14} />
              </button>

              {onConfirm && (
                <button
                  type="button"
                  className="dshm-action-btn"
                  onClick={() => onConfirm(memory.id)}
                  title="用户强化确认 (+0.1 实用度评分)"
                >
                  <CheckIcon size={13} />
                </button>
              )}

              <button
                type="button"
                className="dshm-action-btn"
                onClick={() => onInspect(memory.id)}
                title="查看详情、编辑与版本因果快照"
              >
                <EyeIcon size={14} />
              </button>

              <button
                type="button"
                className="dshm-action-btn is-danger"
                onClick={() => onForget(memory.id)}
                title="遗忘归档此条记忆"
              >
                <TrashIcon size={14} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Memory Content */}
      <div className="dshm-card-content" onClick={() => onInspect(memory.id)}>
        {memory.content}
      </div>

      {memory.summary && memory.summary !== memory.content && (
        <div className="dshm-card-summary" onClick={() => onInspect(memory.id)}>
          <span className="dshm-summary-prefix">摘要</span>
          <span>{memory.summary}</span>
        </div>
      )}

      {/* Card Footer Metadata */}
      <div className="dshm-card-footer">
        <div className="dshm-card-footer-left">
          <span className="dshm-metric-pill" title="检索打分置信度 (Confidence)">
            <span>置信度</span>
            <span className="dshm-mini-bar">
              <span className="dshm-mini-bar-fill is-blue" style={{ width: `${confPct}%` }} />
            </span>
            <strong>{confPct}%</strong>
          </span>

          <span className="dshm-metric-pill" title="历史反馈实用度 (Utility)">
            <span>实用度</span>
            <span className="dshm-mini-bar">
              <span className="dshm-mini-bar-fill is-emerald" style={{ width: `${utilPct}%` }} />
            </span>
            <strong>{utilPct}%</strong>
          </span>

          <span
            className="dshm-metric-pill"
            title={`总召回 ${memory.use_count} 次 · 正向反馈 ${memory.success_count} 次 · 负向纠正 ${memory.fail_count} 次`}
          >
            <span>命中</span>
            <strong>{memory.use_count} 次</strong>
          </span>

          {memory.version > 1 && (
            <button
              type="button"
              className="dshm-metric-pill is-clickable-metric"
              title={`经历过 ${memory.version - 1} 次版本迭代演化，点击查看快照`}
              onClick={() => onInspect(memory.id)}
            >
              <span>版本</span>
              <strong className="dshm-text-purple">v{memory.version}</strong>
            </button>
          )}
        </div>

        <div className="dshm-card-footer-right">
          {memory.source_kind && (
            <span className="dshm-source-badge" title="记忆提取来源">
              来源: {memory.source_kind}
            </span>
          )}
          <span>更新于 {formatRelativeTime(memory.updated_at)}</span>
        </div>
      </div>
    </GlassCard>
  );
};
