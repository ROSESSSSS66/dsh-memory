import * as React from 'react';
import type { MemoryRecordUI } from '../types.js';
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
  EditIcon,
} from './Icons.js';

interface MemoryCardProps {
  memory: MemoryRecordUI;
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

function formatRelativeTime(ts: number): string {
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

  const typeClass =
    memory.type === 'preference'
      ? 'dshm-tag-preference'
      : memory.type === 'procedure'
      ? 'dshm-tag-procedure'
      : memory.type === 'fact'
      ? 'dshm-tag-fact'
      : 'dshm-tag-semantic';

  const typeLabel =
    memory.type === 'preference'
      ? '偏好'
      : memory.type === 'procedure'
      ? '流程'
      : memory.type === 'fact'
      ? '事实'
      : memory.type;

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard
      .writeText(memory.content)
      .then(() => onToast?.('记忆正文已复制至剪贴板'))
      .catch(() => onToast?.('复制失败'));
  };

  return (
    <article
      className={`dshm-card ${isPinned ? 'is-pinned' : ''} ${isCandidate ? 'is-candidate' : ''} ${
        selected ? 'is-selected' : ''
      }`}
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

          <span className={`dshm-tag ${typeClass}`}>{typeLabel}</span>

          <span className="dshm-tag dshm-tag-scope">
            {memory.scope === 'global' ? (
              <>
                <GlobeIcon size={11} />
                <span>全局</span>
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
            <span className="dshm-tag dshm-badge-frozen" title="已冻结，免受自演化覆盖">
              <SnowflakeIcon size={11} />
              <span>已冻结</span>
            </span>
          )}

          {isCandidate && (
            <span className="dshm-tag dshm-badge-candidate" title="待用户确认入库">
              待审核
            </span>
          )}

          {isArchived && (
            <span className="dshm-tag" style={{ background: 'rgba(148, 163, 184, 0.15)', color: '#94a3b8' }}>
              已归档
            </span>
          )}

          {memory.slot_key && (
            <span className="dshm-tag dshm-tag-slot">
              slot: {memory.slot_key}
            </span>
          )}

          <span className="dshm-card-id" title={memory.id}>
            {memory.id.length > 12 ? `${memory.id.slice(0, 10)}…` : memory.id}
          </span>
        </div>

        <div className="dshm-card-actions">
          {/* Copy action */}
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
                title="批准并入库激活"
              >
                <CheckIcon size={12} />
                <span>批准</span>
              </button>
              <button
                type="button"
                className="dshm-action-btn is-danger"
                onClick={() => onForget(memory.id)}
                title="忽略或删除"
              >
                <TrashIcon size={14} />
              </button>
            </>
          ) : isArchived ? (
            <>
              {onRestore && (
                <button
                  type="button"
                  className="dshm-action-btn is-active"
                  onClick={() => onRestore(memory.id)}
                  title="恢复为活跃记忆"
                >
                  <UndoIcon size={13} />
                  <span>恢复</span>
                </button>
              )}
              <button
                type="button"
                className="dshm-action-btn"
                onClick={() => onInspect(memory.id)}
                title="查看版本快照"
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
                className={`dshm-action-btn ${isFrozen ? 'is-active' : ''}`}
                onClick={() => onFreezeToggle(memory.id, isFrozen)}
                title={isFrozen ? '解除冻结' : '冻结保护（不可被演化覆盖）'}
              >
                <SnowflakeIcon size={14} />
              </button>

              {onConfirm && (
                <button
                  type="button"
                  className="dshm-action-btn"
                  onClick={() => onConfirm(memory.id)}
                  title="用户强化确认 (+0.1 utility)"
                >
                  <CheckIcon size={13} />
                </button>
              )}

              <button
                type="button"
                className="dshm-action-btn"
                onClick={() => onInspect(memory.id)}
                title="查看详情、修改与版本因果快照"
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
      <div className="dshm-card-content" onClick={() => onInspect(memory.id)} style={{ cursor: 'pointer' }}>
        {memory.content}
      </div>

      {memory.summary && memory.summary !== memory.content && (
        <div className="dshm-card-summary">摘要：{memory.summary}</div>
      )}

      {/* Card Footer Metadata */}
      <div className="dshm-card-footer">
        <div className="dshm-card-footer-left">
          <span className="dshm-metric-pill" title="检索打分置信度">
            <span>置信度</span>
            <strong style={{ color: 'var(--dsw-alias-label-primary)' }}>
              {Math.round(memory.confidence * 100)}%
            </strong>
          </span>

          <span className="dshm-metric-pill" title="在线调用与命中情况">
            <span>引用</span>
            <strong style={{ color: 'var(--dsw-alias-label-primary)' }}>
              {memory.use_count} 次
            </strong>
          </span>

          {memory.version > 1 && (
            <span
              className="dshm-metric-pill"
              title={`经历过 ${memory.version - 1} 次版本迭代演化`}
              style={{ cursor: 'pointer' }}
              onClick={() => onInspect(memory.id)}
            >
              <span>修订</span>
              <strong style={{ color: '#c084fc' }}>v{memory.version}</strong>
            </span>
          )}
        </div>

        <div className="dshm-card-footer-right">
          <span>更新于 {formatRelativeTime(memory.updated_at)}</span>
        </div>
      </div>
    </article>
  );
};
