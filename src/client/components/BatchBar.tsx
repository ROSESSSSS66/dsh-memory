import * as React from 'react';
import { PinIcon, SnowflakeIcon, TrashIcon, UndoIcon, DownloadIcon, CloseIcon } from './Icons.js';

interface BatchBarProps {
  selectedCount: number;
  onClear: () => void;
  onBatchPin: () => void;
  onBatchUnpin: () => void;
  onBatchFreeze: () => void;
  onBatchForget: () => void;
  onBatchRestore: () => void;
  onBatchExport: () => void;
}

export const BatchBar: React.FC<BatchBarProps> = ({
  selectedCount,
  onClear,
  onBatchPin,
  onBatchUnpin,
  onBatchFreeze,
  onBatchForget,
  onBatchRestore,
  onBatchExport,
}) => {
  if (selectedCount === 0) return null;

  return (
    <div className="dshm-batch-bar">
      <div className="dshm-batch-info">
        <span className="dshm-batch-badge">{selectedCount}</span>
        <span>已选择 {selectedCount} 条记忆</span>
      </div>

      <div className="dshm-batch-actions">
        <button
          type="button"
          className="dshm-batch-btn"
          onClick={onBatchPin}
          title="将选中记忆置顶至系统提示词"
        >
          <PinIcon size={13} />
          <span>批量置顶</span>
        </button>

        <button
          type="button"
          className="dshm-batch-btn"
          onClick={onBatchUnpin}
          title="批量取消置顶"
        >
          <PinIcon size={13} />
          <span>取消置顶</span>
        </button>

        <button
          type="button"
          className="dshm-batch-btn"
          onClick={onBatchFreeze}
          title="将选中记忆设置为冻结保护"
        >
          <SnowflakeIcon size={13} />
          <span>批量冻结</span>
        </button>

        <button
          type="button"
          className="dshm-batch-btn"
          onClick={onBatchForget}
          title="归档遗忘选中记忆"
        >
          <TrashIcon size={13} />
          <span>批量归档</span>
        </button>

        <button
          type="button"
          className="dshm-batch-btn"
          onClick={onBatchRestore}
          title="恢复归档的记忆为活跃"
        >
          <UndoIcon size={13} />
          <span>批量恢复</span>
        </button>

        <button
          type="button"
          className="dshm-batch-btn dshm-batch-btn-primary"
          onClick={onBatchExport}
          title="导出选中的记忆"
        >
          <DownloadIcon size={13} />
          <span>导出选中</span>
        </button>

        <div className="dshm-batch-divider" />

        <button
          type="button"
          className="dshm-batch-btn dshm-batch-btn-ghost"
          onClick={onClear}
          title="清空当前所有选中"
        >
          <CloseIcon size={13} />
          <span>清空选择</span>
        </button>
      </div>
    </div>
  );
};
