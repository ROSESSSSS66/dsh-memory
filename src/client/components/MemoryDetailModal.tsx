import * as React from 'react';
import { getMemoryTypeMeta, type MemoryDetailResponse } from '../types.js';
import { GlassModal, GlassButton, GlassInput } from './GlassUI.js';
import {
  RefreshIcon,
  EditIcon,
  CheckIcon,
  UndoIcon,
  CopyIcon,
  PinIcon,
  SnowflakeIcon,
  GitMergeIcon,
} from './Icons.js';
import { fetchMemoryDetail, performAction } from '../api.js';

interface MemoryDetailModalProps {
  memoryId: string | null;
  onClose: () => void;
  onToast?: (msg: string) => void;
  onMemoryUpdated?: () => void;
}

export const MemoryDetailModal: React.FC<MemoryDetailModalProps> = ({
  memoryId,
  onClose,
  onToast,
  onMemoryUpdated,
}) => {
  const [detail, setDetail] = React.useState<MemoryDetailResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');

  // Editing state
  const [isEditing, setIsEditing] = React.useState(false);
  const [editContentText, setEditContentText] = React.useState('');
  const [editSummaryText, setEditSummaryText] = React.useState('');
  const [editType, setEditType] = React.useState('semantic');
  const [editScope, setEditScope] = React.useState('global');
  const [editSlotKey, setEditSlotKey] = React.useState('');
  const [editImportance, setEditImportance] = React.useState(5);
  const [editReason, setEditReason] = React.useState('手动修订内容与属性');
  const [isSaving, setIsSaving] = React.useState(false);

  // Merge state
  const [isMerging, setIsMerging] = React.useState(false);
  const [mergeTargetId, setMergeTargetId] = React.useState('');

  const loadDetail = React.useCallback(async (id: string) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetchMemoryDetail(id);
      setDetail(res);
      if (res.memory) {
        setEditContentText(res.memory.content || '');
        setEditSummaryText(res.memory.summary || '');
        setEditType(res.memory.type || 'semantic');
        setEditScope(res.memory.scope || 'global');
        setEditSlotKey(res.memory.slot_key || '');
        setEditImportance(res.memory.importance ?? 5);
      }
    } catch (err: any) {
      setError(err?.message || '获取详情失败');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!memoryId) {
      setDetail(null);
      setError('');
      setIsEditing(false);
      setIsMerging(false);
      return;
    }
    loadDetail(memoryId);
  }, [memoryId, loadDetail]);

  if (!memoryId) return null;

  const mem = detail?.memory;
  const typeMeta = getMemoryTypeMeta(mem?.type);

  const handleSaveEdit = async () => {
    if (!mem) return;
    if (!editContentText.trim() || editContentText.trim().length < 4) {
      setError('记忆内容至少需要 4 个字符');
      return;
    }
    setIsSaving(true);
    setError('');
    try {
      await performAction('edit', {
        id: mem.id,
        content: editContentText.trim(),
        summary: editSummaryText.trim() || undefined,
        type: editType,
        scope: editScope,
        slot_key: editSlotKey.trim(),
        importance: Number(editImportance) || 5,
        reason: editReason || '手动编辑更新',
      });
      onToast?.('记忆已成功修订，并生成版本演化快照！');
      setIsEditing(false);
      await loadDetail(mem.id);
      onMemoryUpdated?.();
    } catch (err: any) {
      setError(err?.message || '修改保存失败');
    } finally {
      setIsSaving(false);
    }
  };

  const handleMerge = async () => {
    if (!mem || !mergeTargetId.trim()) return;
    setIsSaving(true);
    setError('');
    try {
      await performAction('merge', {
        sourceId: mem.id,
        targetId: mergeTargetId.trim(),
        reason: 'UI 手动合并记忆',
      });
      onToast?.(`已将当前记忆合并至 ${mergeTargetId.trim()}！`);
      setIsMerging(false);
      await loadDetail(mem.id);
      onMemoryUpdated?.();
    } catch (err: any) {
      setError(err?.message || '合并记忆失败');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRollback = async (targetVer: number) => {
    if (!mem) return;
    if (!window.confirm(`确认将记忆回滚至版本 v${targetVer}？当前状态将保存为新快照。`)) return;
    try {
      await performAction('rollback', {
        id: mem.id,
        targetVersion: targetVer,
      });
      onToast?.(`已成功回滚至版本 v${targetVer}！`);
      await loadDetail(mem.id);
      onMemoryUpdated?.();
    } catch (err: any) {
      setError(err?.message || '回滚失败');
    }
  };

  const handleConfirm = async () => {
    if (!mem) return;
    try {
      await performAction('confirm', { id: mem.id });
      onToast?.('已强化记忆置信度与实用度评分！');
      await loadDetail(mem.id);
      onMemoryUpdated?.();
    } catch (err: any) {
      setError(err?.message || '操作失败');
    }
  };

  const handleTogglePin = async () => {
    if (!mem) return;
    try {
      await performAction(mem.pinned ? 'unpin' : 'pin', { id: mem.id });
      onToast?.(mem.pinned ? '已取消置顶' : '已置顶固化至 System Prompt');
      await loadDetail(mem.id);
      onMemoryUpdated?.();
    } catch (err: any) {
      setError(err?.message || '操作失败');
    }
  };

  const handleToggleFreeze = async () => {
    if (!mem) return;
    const isFrozen = mem.status === 'frozen';
    try {
      await performAction(isFrozen ? 'unfreeze' : 'freeze', { id: mem.id });
      onToast?.(isFrozen ? '已解除冻结保护' : '已开启冻结保护');
      await loadDetail(mem.id);
      onMemoryUpdated?.();
    } catch (err: any) {
      setError(err?.message || '操作失败');
    }
  };

  const handleRestore = async () => {
    if (!mem) return;
    try {
      await performAction('restore', { id: mem.id });
      onToast?.('已成功恢复记忆为活跃状态！');
      await loadDetail(mem.id);
      onMemoryUpdated?.();
    } catch (err: any) {
      setError(err?.message || '恢复失败');
    }
  };

  const handleCopy = async () => {
    if (!mem) return;
    try {
      await navigator.clipboard.writeText(mem.content);
      onToast?.('已复制记忆正文至剪贴板！');
    } catch {
      onToast?.('复制失败，请手动选取');
    }
  };

  return (
    <GlassModal
      isOpen={!!memoryId}
      onClose={onClose}
      size="xl"
      footerClassName="dshm-modal-footer-split"
      headerLeft={
        <div className="dshm-detail-header-left">
          <h2 className="dshm-modal-title">记忆详情与因果审计</h2>
          {mem && (
            <>
              <span className={`dshm-tag ${typeMeta.tagClass}`}>{typeMeta.label}</span>
              <span className="dshm-badge-version">
                v{mem.version} · rev {mem.content_rev}
              </span>
            </>
          )}
        </div>
      }
      footer={
        <>
          <div className="dshm-detail-footer-left">
            {mem?.status === 'archived' || mem?.status === 'superseded' ? (
              <GlassButton intent="primary" onClick={handleRestore}>
                <UndoIcon size={13} />
                <span>恢复为活跃记忆</span>
              </GlassButton>
            ) : (
              mem && (
                <>
                  <GlassButton
                    intent={mem.pinned ? 'warning' : 'default'}
                    onClick={handleTogglePin}
                  >
                    <PinIcon size={13} />
                    <span>{mem.pinned ? '取消置顶' : '置顶固化'}</span>
                  </GlassButton>

                  <GlassButton
                    className={mem.status === 'frozen' ? 'is-active-cyan' : ''}
                    onClick={handleToggleFreeze}
                  >
                    <SnowflakeIcon size={13} />
                    <span>{mem.status === 'frozen' ? '解除冻结' : '冻结保护'}</span>
                  </GlassButton>

                  <GlassButton
                    onClick={handleConfirm}
                    title="强化有效性与置信度 (+0.1 utility)"
                  >
                    <CheckIcon size={13} />
                    <span>强化确认</span>
                  </GlassButton>

                  <GlassButton
                    onClick={() => setIsMerging(!isMerging)}
                    title="将此记忆合并到另一条记忆"
                  >
                    <GitMergeIcon size={13} />
                    <span>合并记忆</span>
                  </GlassButton>
                </>
              )
            )}
          </div>

          <GlassButton onClick={onClose}>关闭</GlassButton>
        </>
      }
    >
      {loading && (
        <div className="dshm-loading-state">
          <div className="dshm-spin">
            <RefreshIcon size={20} />
          </div>
          <span>正在读取存储引擎与因果版本链…</span>
        </div>
      )}

      {error && <div className="dshm-alert-error">{error}</div>}

      {mem && !loading && (
        <div className="dshm-detail-stack">
          {/* Basic Meta Bento Grid */}
          <div className="dshm-detail-meta-grid">
            <div className="dshm-meta-cell">
              <span className="dshm-meta-key">记忆 ID</span>
              <code className="dshm-meta-val is-mono">{mem.id}</code>
            </div>
            <div className="dshm-meta-cell">
              <span className="dshm-meta-key">当前状态</span>
              <span className={`dshm-meta-val is-status-${mem.status}`}>
                {mem.status} {mem.pinned ? '(📌 已置顶)' : ''}
              </span>
            </div>
            <div className="dshm-meta-cell">
              <span className="dshm-meta-key">生效作用域</span>
              <span className="dshm-meta-val">
                {mem.scope === 'global'
                  ? '🌐 全局 (Global)'
                  : mem.scope === 'user'
                  ? '👤 用户级 (User)'
                  : `📁 工作区 (${mem.workspace_id || 'Workspace'})`}
              </span>
            </div>
            <div className="dshm-meta-cell">
              <span className="dshm-meta-key">槽位键 (slot_key)</span>
              <code className="dshm-meta-val is-mono">{mem.slot_key || '未绑定'}</code>
            </div>
            <div className="dshm-meta-cell">
              <span className="dshm-meta-key">置信度 / 实用度</span>
              <span className="dshm-meta-val">
                {Math.round(mem.confidence * 100)}% / {Math.round(mem.utility * 100)}%
              </span>
            </div>
            <div className="dshm-meta-cell">
              <span className="dshm-meta-key">重要度评分</span>
              <span className="dshm-meta-val">P{mem.importance ?? 5} / 10</span>
            </div>
            <div className="dshm-meta-cell">
              <span className="dshm-meta-key">召回反馈统计</span>
              <span className="dshm-meta-val">
                命中 {mem.use_count} · 正向 {mem.success_count} · 纠正 {mem.fail_count}
              </span>
            </div>
            <div className="dshm-meta-cell">
              <span className="dshm-meta-key">最后更新</span>
              <span className="dshm-meta-val">
                {new Date(mem.updated_at).toLocaleString()}
              </span>
            </div>
          </div>

          {/* Memory Content & Attribute Editor */}
          <div className="dshm-detail-section">
            <div className="dshm-detail-section-header">
              <h4>记忆正文与属性</h4>
              <div className="dshm-detail-actions">
                <GlassButton size="sm" onClick={handleCopy}>
                  <CopyIcon size={12} />
                  <span>复制正文</span>
                </GlassButton>
                {!isEditing && mem.status !== 'frozen' && (
                  <GlassButton size="sm" onClick={() => setIsEditing(true)}>
                    <EditIcon size={12} />
                    <span>编辑记忆</span>
                  </GlassButton>
                )}
              </div>
            </div>

            {isEditing ? (
              <div className="dshm-edit-panel">
                <div className="dshm-form-row">
                  <div className="dshm-form-group dshm-col-third">
                    <label className="dshm-form-label">记忆类型</label>
                    <select
                      className="dshm-form-select"
                      value={editType}
                      onChange={(e) => setEditType(e.target.value)}
                    >
                      <option value="preference">偏好习惯 (preference)</option>
                      <option value="semantic">事实知识 (semantic)</option>
                      <option value="procedural">流程规范 (procedural)</option>
                      <option value="episodic">情景事件 (episodic)</option>
                      <option value="failure">避坑反思 (failure)</option>
                      <option value="belief">核心信念 (belief)</option>
                      <option value="goal">目标规划 (goal)</option>
                    </select>
                  </div>

                  <div className="dshm-form-group dshm-col-third">
                    <label className="dshm-form-label">作用域</label>
                    <select
                      className="dshm-form-select"
                      value={editScope}
                      onChange={(e) => setEditScope(e.target.value)}
                    >
                      <option value="global">🌐 全局 (global)</option>
                      <option value="workspace">📁 工作区 (workspace)</option>
                      <option value="user">👤 用户级 (user)</option>
                    </select>
                  </div>

                  <div className="dshm-form-group dshm-col-third">
                    <label className="dshm-form-label">重要度 (1-10)</label>
                    <GlassInput
                      type="number"
                      min={1}
                      max={10}
                      value={editImportance}
                      onChange={(e) => setEditImportance(parseInt(e.target.value, 10) || 5)}
                    />
                  </div>
                </div>

                <div className="dshm-form-row">
                  <div className="dshm-form-group dshm-col-half">
                    <label className="dshm-form-label">槽位键 (slot_key)</label>
                    <GlassInput
                      type="text"
                      placeholder="例如 pkg-manager 或 build-cmd"
                      value={editSlotKey}
                      onChange={(e) => setEditSlotKey(e.target.value)}
                    />
                  </div>

                  <div className="dshm-form-group dshm-col-half">
                    <label className="dshm-form-label">精简摘要 (Summary)</label>
                    <GlassInput
                      type="text"
                      placeholder="预算紧凑时降级注入的单行摘要"
                      value={editSummaryText}
                      onChange={(e) => setEditSummaryText(e.target.value)}
                    />
                  </div>
                </div>

                <div className="dshm-form-group">
                  <label className="dshm-form-label">记忆正文</label>
                  <textarea
                    className="dshm-form-textarea"
                    rows={5}
                    value={editContentText}
                    onChange={(e) => setEditContentText(e.target.value)}
                    placeholder="修改记忆内容…"
                  />
                </div>

                <div className="dshm-edit-footer">
                  <GlassInput
                    type="text"
                    placeholder="修订原因 (记录入版本审计链)"
                    value={editReason}
                    onChange={(e) => setEditReason(e.target.value)}
                  />
                  <GlassButton
                    onClick={() => setIsEditing(false)}
                    disabled={isSaving}
                  >
                    取消
                  </GlassButton>
                  <GlassButton
                    intent="primary"
                    onClick={handleSaveEdit}
                    disabled={isSaving}
                  >
                    <CheckIcon size={13} />
                    <span>{isSaving ? '保存中…' : '保存修订'}</span>
                  </GlassButton>
                </div>
              </div>
            ) : (
              <div className="dshm-detail-content-box">{mem.content}</div>
            )}
          </div>

          {/* Merge Memory Panel */}
          {isMerging && (
            <div className="dshm-edit-panel">
              <div className="dshm-form-label">
                将当前记忆 ({mem.id}) 合并至目标记忆 ID（当前记忆将标记为 superseded）：
              </div>
              <div className="dshm-edit-footer">
                <GlassInput
                  type="text"
                  placeholder="输入目标记忆完整 ID 或短码 (如 m_xxxx)"
                  value={mergeTargetId}
                  onChange={(e) => setMergeTargetId(e.target.value)}
                />
                <GlassButton onClick={() => setIsMerging(false)}>取消</GlassButton>
                <GlassButton
                  intent="primary"
                  disabled={!mergeTargetId.trim() || isSaving}
                  onClick={handleMerge}
                >
                  <GitMergeIcon size={13} />
                  <span>确认合并</span>
                </GlassButton>
              </div>
            </div>
          )}

          {/* Relations / Connected Graph Nodes */}
          {detail.relations && detail.relations.length > 0 && (
            <div className="dshm-detail-section">
              <h4>因果与拓扑关联 ({detail.relations.length} 条)</h4>
              <div className="dshm-relation-pills">
                {detail.relations.map((rel, i) => (
                  <button
                    key={i}
                    type="button"
                    className="dshm-relation-chip"
                    onClick={() => loadDetail(rel.to_id)}
                    title="点击跳转查看目标记忆详情"
                  >
                    <span className="dshm-relation-type">{rel.rel}</span>
                    <code>{rel.to_id}</code>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Version History with Rollback */}
          {detail.history && detail.history.length > 0 && (
            <div className="dshm-detail-section">
              <h4>版本演化快照 ({detail.history.length} 次修订)</h4>
              <div className="dshm-version-list">
                {detail.history.map((ver) => (
                  <div key={ver.version} className="dshm-version-card">
                    <div className="dshm-version-header">
                      <div className="dshm-version-meta">
                        <strong>v{ver.version}</strong>
                        <span>by {ver.actor}</span>
                        <span className="dshm-text-muted">
                          {new Date(ver.created_at).toLocaleString()}
                        </span>
                      </div>
                      {ver.version !== mem.version && mem.status !== 'frozen' && (
                        <GlassButton
                          size="sm"
                          intent="warning"
                          onClick={() => handleRollback(ver.version)}
                          title="将记忆正文恢复为此历史快照"
                        >
                          <UndoIcon size={11} />
                          <span>回滚至此版</span>
                        </GlassButton>
                      )}
                    </div>
                    <div className="dshm-version-reason">原因：{ver.reason}</div>
                    <pre className="dshm-version-snapshot">{ver.snapshot?.content}</pre>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Citations / Sources */}
          {detail.sources && detail.sources.length > 0 && (
            <div className="dshm-detail-section">
              <h4>关联会话来源证据 ({detail.sources.length} 个锚点)</h4>
              <div className="dshm-source-list">
                {detail.sources.map((src, i) => (
                  <div key={i} className="dshm-source-card">
                    <div className="dshm-source-header">
                      <code>
                        {src.session_id} #seq {src.seq}
                      </code>
                      <span className="dshm-tag dshm-tag-scope">{src.kind}</span>
                    </div>
                    {src.excerpt && (
                      <blockquote className="dshm-source-excerpt">
                        “{src.excerpt}”
                      </blockquote>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </GlassModal>
  );
};
