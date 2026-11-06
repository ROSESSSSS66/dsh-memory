import * as React from 'react';
import { PlusIcon } from './Icons.js';
import { GlassModal, GlassButton, GlassInput } from './GlassUI.js';

interface NewMemoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: {
    content: string;
    summary?: string;
    slot_key?: string;
    importance?: number;
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
  const [summary, setSummary] = React.useState('');
  const [slotKey, setSlotKey] = React.useState('');
  const [importance, setImportance] = React.useState(6);
  const [type, setType] = React.useState('preference');
  const [scope, setScope] = React.useState('global');
  const [pinned, setPinned] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (!isOpen) {
      setContent('');
      setSummary('');
      setSlotKey('');
      setImportance(6);
      setType('preference');
      setScope('global');
      setPinned(false);
      setError('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!content.trim() || content.trim().length < 4) {
      setError('记忆内容至少需要 4 个字符');
      return;
    }
    setError('');
    setIsSubmitting(true);
    try {
      await onSubmit({
        content: content.trim(),
        summary: summary.trim() || undefined,
        slot_key: slotKey.trim() || undefined,
        importance: Number(importance) || 5,
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
    <GlassModal
      isOpen={isOpen}
      onClose={onClose}
      title="记录新长期记忆"
      footer={
        <>
          <GlassButton onClick={onClose} disabled={isSubmitting}>
            取消
          </GlassButton>
          <GlassButton
            intent="primary"
            onClick={() => handleSubmit()}
            disabled={isSubmitting}
          >
            <PlusIcon size={14} />
            <span>{isSubmitting ? '正在入库…' : '立即保存入库'}</span>
          </GlassButton>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="dshm-detail-stack">
        {error && <div className="dshm-alert-error">{error}</div>}

        <div className="dshm-form-row">
          <div className="dshm-form-group dshm-col-third">
            <label className="dshm-form-label">记忆分类</label>
            <select
              className="dshm-form-select"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              <option value="preference">偏好习惯 (开发风格 / 个人偏好)</option>
              <option value="semantic">事实知识 (项目架构 / 技术选型)</option>
              <option value="procedural">流程规范 (构建命令 / 测试工作流)</option>
              <option value="episodic">情景事件 (里程碑 / 关键决策)</option>
              <option value="failure">避坑反思 (排障教训 / 禁忌事项)</option>
              <option value="goal">目标规划 (待办演进 / 长期目标)</option>
            </select>
          </div>

          <div className="dshm-form-group dshm-col-third">
            <label className="dshm-form-label">生效作用域</label>
            <select
              className="dshm-form-select"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="global">🌐 全局通用 (跨项目生效)</option>
              <option value="workspace">📁 当前工作区 (仅本项目)</option>
              <option value="user">👤 用户画像级 (User Scope)</option>
            </select>
          </div>

          <div className="dshm-form-group dshm-col-third">
            <label className="dshm-form-label">重要度权重 (1-10)</label>
            <GlassInput
              type="number"
              min={1}
              max={10}
              value={importance}
              onChange={(e) => setImportance(parseInt(e.target.value, 10) || 5)}
            />
          </div>
        </div>

        <div className="dshm-form-group">
          <label className="dshm-form-label">
            记忆正文 <span className="dshm-required">*</span>
            <span className="dshm-form-hint-inline">
              (内置隐私哨兵自动遮罩 PEM、JWT 与 API Key)
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

        <div className="dshm-form-row">
          <div className="dshm-form-group dshm-col-half">
            <label className="dshm-form-label">唯一槽位键 (slot_key，可选)</label>
            <GlassInput
              type="text"
              placeholder="例如 test-runner 或 package-manager"
              value={slotKey}
              onChange={(e) => setSlotKey(e.target.value)}
            />
            <span className="dshm-form-hint">
              同槽位的新记忆将自动覆盖并归档旧记忆
            </span>
          </div>

          <div className="dshm-form-group dshm-col-half">
            <label className="dshm-form-label">单行精简摘要 (Summary，可选)</label>
            <GlassInput
              type="text"
              placeholder="留空则由系统自动提取摘要"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
            <span className="dshm-form-hint">
              当 Token 预算紧张时优先降级渲染摘要
            </span>
          </div>
        </div>

        <div className="dshm-consent-card">
          <div className="dshm-consent-content">
            <span className="dshm-consent-title">
              📌 直接置顶固化至系统提示词 (System Prompt 稳定层)
            </span>
            <p className="dshm-consent-desc">
              开启后该记忆无需检索即可每轮常驻注入（受 600 tokens 稳定层预算保护）。
            </p>
          </div>
          <label className="dshm-switch">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => setPinned(e.target.checked)}
            />
            <span className="dshm-slider" />
          </label>
        </div>
      </form>
    </GlassModal>
  );
};
