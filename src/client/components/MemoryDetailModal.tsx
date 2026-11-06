import * as React from 'react';
import type { MemoryDetailResponse } from '../types.js';
import {
  CloseIcon,
  RefreshIcon,
  EditIcon,
  CheckIcon,
  UndoIcon,
  CopyIcon,
  PinIcon,
  SnowflakeIcon,
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
  const [editReason, setEditReason] = React.useState('手动更新正文');
  const [isSaving, setIsSaving] = React.useState(false);

  const loadDetail = React.useCallback(async (id: string) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetchMemoryDetail(id);
      setDetail(res);
      setEditContentText(res.memory?.content || '');
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
      return;
    }
    loadDetail(memoryId);
  }, [memoryId, loadDetail]);

  if (!memoryId) return null;

  const mem = detail?.memory;

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
        reason: editReason || '手动编辑更新',
      });
      onToast?.('记忆已成功修改，并生成版本演化快照！');
      setIsEditing(false);
      await loadDetail(mem.id);
      onMemoryUpdated?.();
    } catch (err: any) {
      setError(err?.message || '修改保存失败');
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
    <div className="dshm-modal-backdrop" onClick={onClose}>
      <div className="dshm-modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="dshm-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2 className="dshm-modal-title">记忆详情与演化审计</h2>
            {mem && (
              <span className="dshm-badge-version">v{mem.version}</span>
            )}
          </div>
          <button
            type="button"
            className="dshm-action-btn"
            onClick={onClose}
            title="关闭"
          >
            <CloseIcon size={14} />
          </button>
        </div>

        <div className="dshm-modal-body">
          {loading && (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--dsw-alias-label-secondary)' }}>
              <div className="dshm-spin" style={{ display: 'inline-block', marginBottom: 8 }}>
                <RefreshIcon size={20} />
              </div>
              <div>正在读取存储引擎与因果版本链…</div>
            </div>
          )}

          {error && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 6,
                background: 'rgba(239, 68, 68, 0.15)',
                color: '#f87171',
                fontSize: 13,
                marginBottom: 12,
              }}
            >
              {error}
            </div>
          )}

          {mem && !loading && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Basic Meta Grid */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
                  gap: 10,
                  padding: 12,
                  borderRadius: 8,
                  background: 'var(--dsw-alias-bg-layer-1)',
                  fontSize: 12,
                }}
              >
                <div>
                  <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>ID: </span>
                  <span style={{ fontFamily: 'monospace', color: 'var(--dsw-alias-label-primary)' }}>{mem.id}</span>
                </div>
                <div>
                  <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>类型: </span>
                  <span style={{ color: 'var(--dsw-alias-label-primary)', fontWeight: 500 }}>{mem.type}</span>
                </div>
                <div>
                  <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>作用域: </span>
                  <span style={{ color: 'var(--dsw-alias-label-primary)' }}>
                    {mem.scope === 'global' ? '全局' : mem.workspace_id || '工作区'}
                  </span>
                </div>
                <div>
                  <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>状态: </span>
                  <span style={{ color: mem.status === 'active' ? '#34c759' : mem.status === 'frozen' ? '#60a5fa' : '#f59e0b' }}>
                    {mem.status}
                  </span>
                </div>
                <div>
                  <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>版本与修订: </span>
                  <span style={{ color: '#c084fc', fontWeight: 600 }}>v{mem.version} (rev {mem.content_rev})</span>
                </div>
                <div>
                  <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>实用度 / 置信度: </span>
                  <span style={{ color: 'var(--dsw-alias-label-primary)' }}>
                    {mem.utility.toFixed(2)} / {mem.confidence.toFixed(2)}
                  </span>
                </div>
                <div>
                  <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>调用统计: </span>
                  <span style={{ color: 'var(--dsw-alias-label-primary)' }}>
                    总 {mem.use_count} · 成功 {mem.success_count} · 失败 {mem.fail_count}
                  </span>
                </div>
                <div>
                  <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>最近更新: </span>
                  <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>
                    {new Date(mem.updated_at).toLocaleString()}
                  </span>
                </div>
              </div>

              {/* Memory Content Section */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <h4 style={{ margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' }}>
                    记忆正文
                  </h4>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="dshm-btn dshm-btn-ghost"
                      style={{ padding: '3px 8px', fontSize: 12 }}
                      onClick={handleCopy}
                      title="复制正文"
                    >
                      <CopyIcon size={12} />
                      <span>复制</span>
                    </button>
                    {!isEditing && mem.status !== 'frozen' && (
                      <button
                        type="button"
                        className="dshm-btn dshm-btn-secondary"
                        style={{ padding: '3px 10px', fontSize: 12 }}
                        onClick={() => {
                          setIsEditing(true);
                          setEditContentText(mem.content);
                        }}
                      >
                        <EditIcon size={12} />
                        <span>编辑正文</span>
                      </button>
                    )}
                  </div>
                </div>

                {isEditing ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <textarea
                      className="dshm-form-textarea"
                      rows={5}
                      value={editContentText}
                      onChange={(e) => setEditContentText(e.target.value)}
                      placeholder="修改记忆内容…"
                    />
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <input
                        type="text"
                        className="dshm-form-input"
                        placeholder="修改原因 (记录入版本审计链)"
                        value={editReason}
                        onChange={(e) => setEditReason(e.target.value)}
                        style={{ flex: 1, fontSize: 12 }}
                      />
                      <button
                        type="button"
                        className="dshm-btn dshm-btn-secondary"
                        onClick={() => setIsEditing(false)}
                        disabled={isSaving}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="dshm-btn dshm-btn-primary"
                        onClick={handleSaveEdit}
                        disabled={isSaving}
                      >
                        <CheckIcon size={13} />
                        <span>{isSaving ? '保存中…' : '保存修订'}</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    style={{
                      padding: 14,
                      borderRadius: 8,
                      background: 'var(--dsw-alias-bg-layer-1)',
                      fontSize: 14,
                      lineHeight: 1.6,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      borderLeft: '3px solid #3b82f6',
                    }}
                  >
                    {mem.content}
                  </div>
                )}
              </div>

              {/* Relations / Connected Graph Nodes */}
              {detail.relations && detail.relations.length > 0 && (
                <div>
                  <h4 style={{ margin: '0 0 6px 0', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' }}>
                    因果与拓扑关联 ({detail.relations.length} 条)
                  </h4>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {detail.relations.map((rel, i) => (
                      <span
                        key={i}
                        className="dshm-tag"
                        style={{
                          padding: '4px 10px',
                          cursor: 'pointer',
                          background: 'rgba(59, 130, 246, 0.1)',
                          border: '0.5px solid rgba(59, 130, 246, 0.3)',
                          color: '#60a5fa',
                        }}
                        onClick={() => loadDetail(rel.to_id)}
                        title="点击查看目标记忆详情"
                      >
                        <span style={{ opacity: 0.7 }}>[{rel.rel}]</span> {rel.to_id}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Version History with Rollback */}
              {detail.history && detail.history.length > 0 && (
                <div>
                  <h4 style={{ margin: '0 0 6px 0', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' }}>
                    版本演化快照 ({detail.history.length} 次修订)
                  </h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 220, overflowY: 'auto' }}>
                    {detail.history.map((ver) => (
                      <div
                        key={ver.version}
                        style={{
                          padding: '10px 12px',
                          borderRadius: 6,
                          background: 'var(--dsw-alias-bg-layer-1)',
                          fontSize: 12,
                          borderLeft: '3px solid #6366f1',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 4,
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div>
                            <strong style={{ color: '#818cf8' }}>v{ver.version}</strong>
                            <span style={{ color: 'var(--dsw-alias-label-secondary)', marginLeft: 8 }}>
                              by {ver.actor}
                            </span>
                            <span style={{ color: 'var(--dsw-alias-label-tertiary)', marginLeft: 8 }}>
                              ({new Date(ver.created_at).toLocaleString()})
                            </span>
                          </div>
                          {ver.version !== mem.version && mem.status !== 'frozen' && (
                            <button
                              type="button"
                              className="dshm-btn dshm-btn-ghost"
                              style={{ padding: '2px 8px', fontSize: 11, color: '#f59e0b' }}
                              onClick={() => handleRollback(ver.version)}
                              title="将记忆正文恢复为此快照"
                            >
                              <UndoIcon size={11} />
                              <span>回滚至此版本</span>
                            </button>
                          )}
                        </div>
                        <div style={{ color: 'var(--dsw-alias-label-secondary)' }}>
                          原因：{ver.reason}
                        </div>
                        <div
                          style={{
                            fontFamily: 'monospace',
                            color: 'var(--dsw-alias-label-primary)',
                            whiteSpace: 'pre-wrap',
                            background: 'rgba(0,0,0,0.2)',
                            padding: '6px 8px',
                            borderRadius: 4,
                          }}
                        >
                          {ver.snapshot?.content}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Citations / Sources */}
              {detail.sources && detail.sources.length > 0 && (
                <div>
                  <h4 style={{ margin: '0 0 6px 0', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' }}>
                    关联会话来源 ({detail.sources.length} 个锚点)
                  </h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 160, overflowY: 'auto' }}>
                    {detail.sources.map((src, i) => (
                      <div
                        key={i}
                        style={{
                          padding: '8px 12px',
                          borderRadius: 6,
                          background: 'var(--dsw-alias-bg-layer-1)',
                          fontSize: 12,
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ fontFamily: 'monospace', color: '#818cf8' }}>
                            {src.session_id} #seq {src.seq}
                          </span>
                          <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{src.kind}</span>
                        </div>
                        {src.excerpt && (
                          <div style={{ marginTop: 4, color: 'var(--dsw-alias-label-secondary)', fontStyle: 'italic' }}>
                            &ldquo;{src.excerpt}&rdquo;
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="dshm-modal-footer" style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {mem?.status === 'archived' && (
              <button
                type="button"
                className="dshm-btn dshm-btn-primary"
                onClick={handleRestore}
              >
                <UndoIcon size={13} />
                <span>恢复为活跃记忆</span>
              </button>
            )}
            {mem && mem.status !== 'archived' && (
              <button
                type="button"
                className="dshm-btn dshm-btn-secondary"
                onClick={handleConfirm}
                title="强化有效性与置信度"
              >
                <CheckIcon size={13} />
                <span>用户确认</span>
              </button>
            )}
          </div>

          <button
            type="button"
            className="dshm-btn dshm-btn-secondary"
            onClick={onClose}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
};
