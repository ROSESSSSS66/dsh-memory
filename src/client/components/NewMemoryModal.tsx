import * as React from 'react';
import { CloseIcon, PlusIcon } from './Icons.js';

interface NewMemoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: {
    content: string;
    type: string;
    scope: string;
    pinned: boolean;
  }) => Promise<void>;
}

export const NewMemoryModal: React.FC<NewMemoryModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
}) => {
  const [content, setContent] = React.useState('');
  const [type, setType] = React.useState('preference');
  const [scope, setScope] = React.useState('global');
  const [pinned, setPinned] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (!isOpen) {
      setContent('');
      setType('preference');
      setScope('global');
      setPinned(false);
      setError('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim() || content.trim().length < 4) {
      setError('记忆内容至少需要 4 个字符');
      return;
    }
    setError('');
    setIsSubmitting(true);
    try {
      await onSubmit({
        content: content.trim(),
        type,
        scope,
        pinned,
      });
      onClose();
    } catch (err: any) {
      setError(err?.message || '保存失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="dshm-modal-backdrop" onClick={onClose}>
      <div className="dshm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="dshm-modal-header">
          <h2 className="dshm-modal-title">添加新记忆</h2>
          <button
            type="button"
            className="dshm-action-btn"
            onClick={onClose}
            title="关闭"
          >
            <CloseIcon size={14} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="dshm-modal-body">
            {error && (
              <div
                style={{
                  padding: '8px 12px',
                  borderRadius: 6,
                  background: 'rgba(239, 68, 68, 0.15)',
                  color: '#f87171',
                  fontSize: 13,
                }}
              >
                {error}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="dshm-form-group">
                <label className="dshm-form-label">记忆类型</label>
                <select
                  className="dshm-form-select"
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                >
                  <option value="preference">偏好 (开发风格、个人习惯)</option>
                  <option value="fact">事实 (项目架构、技术选型)</option>
                  <option value="procedure">步骤/流程 (构建命令、测试规范)</option>
                </select>
              </div>

              <div className="dshm-form-group">
                <label className="dshm-form-label">生效作用域</label>
                <select
                  className="dshm-form-select"
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                >
                  <option value="global">🌐 全局 (跨所有会话与项目)</option>
                  <option value="workspace">📁 当前工作区 (仅当前项目生效)</option>
                </select>
              </div>
            </div>

            <div className="dshm-form-group">
              <label className="dshm-form-label">
                记忆内容
                <span style={{ fontSize: 12, fontWeight: 'normal', color: 'var(--dsw-alias-label-tertiary)', marginLeft: 8 }}>
                  (密码、Token与API Key将自动脱敏)
                </span>
              </label>
              <textarea
                className="dshm-form-textarea"
                placeholder="例如：在本项目中，执行单元测试前必须先运行 npm run build，因为 vitest 依赖 dist/ 目录编译产物。"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                required
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <input
                type="checkbox"
                id="dshm-pin-check"
                checked={pinned}
                onChange={(e) => setPinned(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <label htmlFor="dshm-pin-check" style={{ fontSize: 13, color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' }}>
                📌 直接置顶固化至系统提示词 (System Prompt 稳定层保障)
              </label>
            </div>
          </div>

          <div className="dshm-modal-footer">
            <button
              type="button"
              className="dshm-btn dshm-btn-secondary"
              onClick={onClose}
              disabled={isSubmitting}
            >
              取消
            </button>
            <button
              type="submit"
              className="dshm-btn dshm-btn-primary"
              disabled={isSubmitting}
            >
              <PlusIcon size={14} />
              <span>{isSubmitting ? '正在入库…' : '立即保存'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
