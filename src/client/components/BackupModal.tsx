import * as React from 'react';
import { CloseIcon, DownloadIcon, UploadIcon, CopyIcon, CheckIcon } from './Icons.js';
import { exportMemories, importMemories } from '../api.js';

interface BackupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onToast: (msg: string) => void;
  onSuccess: () => void;
}

export const BackupModal: React.FC<BackupModalProps> = ({
  isOpen,
  onClose,
  onToast,
  onSuccess,
}) => {
  const [tab, setTab] = React.useState<'export' | 'import'>('export');
  const [exportFormat, setExportFormat] = React.useState<'json' | 'markdown'>('json');
  const [isExporting, setIsExporting] = React.useState(false);
  const [importText, setImportText] = React.useState('');
  const [isImporting, setIsImporting] = React.useState(false);
  const [error, setError] = React.useState('');

  if (!isOpen) return null;

  const handleDownload = async (format: 'json' | 'markdown') => {
    setIsExporting(true);
    setError('');
    try {
      if (format === 'markdown') {
        const res = (await exportMemories('markdown')) as { text: string; filename: string };
        const blob = new Blob([res.text], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = res.filename || 'dsh-memories.md';
        a.click();
        URL.revokeObjectURL(url);
        onToast('已导出 Markdown 格式知识库文件！');
      } else {
        const res = await exportMemories('json');
        const jsonStr = JSON.stringify(res, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `dsh-memories-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        onToast('已导出 JSON 记忆备份！');
      }
    } catch (err: any) {
      setError(err?.message || '导出失败');
    } finally {
      setIsExporting(false);
    }
  };

  const handleCopyJson = async () => {
    setIsExporting(true);
    setError('');
    try {
      const res = await exportMemories('json');
      await navigator.clipboard.writeText(JSON.stringify(res, null, 2));
      onToast('已复制完整 JSON 数据至剪贴板！');
    } catch (err: any) {
      setError(err?.message || '复制失败');
    } finally {
      setIsExporting(false);
    }
  };

  const handleImport = async () => {
    if (!importText.trim()) {
      setError('请粘贴 JSON 数据');
      return;
    }
    setError('');
    setIsImporting(true);
    try {
      let parsed = JSON.parse(importText.trim());
      let items: any[] = [];
      if (Array.isArray(parsed)) {
        items = parsed;
      } else if (parsed && Array.isArray(parsed.memories)) {
        items = parsed.memories;
      } else if (parsed && typeof parsed.content === 'string') {
        items = [parsed];
      } else {
        throw new Error('未识别出有效的记忆列表结构，请确保为 JSON 数组或包含 memories 属性');
      }

      const res = await importMemories(items);
      onToast(`导入完成：成功入库 ${res.imported} 条记忆，跳过 ${res.skipped} 条`);
      setImportText('');
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err?.message || '导入解析失败，请检查 JSON 格式');
    } finally {
      setIsImporting(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) setImportText(content);
    };
    reader.readAsText(file);
  };

  return (
    <div className="dshm-modal-backdrop" onClick={onClose}>
      <div className="dshm-modal" style={{ maxWidth: 580 }} onClick={(e) => e.stopPropagation()}>
        <div className="dshm-modal-header">
          <h2 className="dshm-modal-title">记忆库备份与导入导出</h2>
          <button type="button" className="dshm-action-btn" onClick={onClose} title="关闭">
            <CloseIcon size={14} />
          </button>
        </div>

        {/* Tab switch */}
        <div className="dshm-modal-tabs">
          <button
            type="button"
            className={`dshm-modal-tab ${tab === 'export' ? 'is-active' : ''}`}
            onClick={() => {
              setTab('export');
              setError('');
            }}
          >
            <DownloadIcon size={13} />
            <span>导出备份</span>
          </button>
          <button
            type="button"
            className={`dshm-modal-tab ${tab === 'import' ? 'is-active' : ''}`}
            onClick={() => {
              setTab('import');
              setError('');
            }}
          >
            <UploadIcon size={13} />
            <span>导入恢复</span>
          </button>
        </div>

        <div className="dshm-modal-body">
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

          {tab === 'export' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 }}>
                您可以将当前的完整长期记忆库导出为离线文件，便于跨工作区迁移、本地备份或同步至知识管理软件（如 Obsidian / Logseq）。
              </p>

              <div className="dshm-export-grid">
                <div
                  className="dshm-export-card"
                  onClick={() => handleDownload('json')}
                  style={{ cursor: isExporting ? 'wait' : 'pointer' }}
                >
                  <div className="dshm-export-card-icon dshm-icon-blue">
                    <DownloadIcon size={20} />
                  </div>
                  <div className="dshm-export-card-info">
                    <h4>导出 JSON 备份</h4>
                    <p>包含完整元数据、置信度、版本快照与因果关系图</p>
                  </div>
                </div>

                <div
                  className="dshm-export-card"
                  onClick={() => handleDownload('markdown')}
                  style={{ cursor: isExporting ? 'wait' : 'pointer' }}
                >
                  <div className="dshm-export-card-icon dshm-icon-emerald">
                    <DownloadIcon size={20} />
                  </div>
                  <div className="dshm-export-card-info">
                    <h4>导出 Markdown 知识库</h4>
                    <p>带 YAML Frontmatter，兼容 Obsidian 与 Memory Bank 格式</p>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 6 }}>
                <button
                  type="button"
                  className="dshm-btn dshm-btn-secondary"
                  onClick={handleCopyJson}
                  disabled={isExporting}
                >
                  <CopyIcon size={13} />
                  <span>复制 JSON 到剪贴板</span>
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 }}>
                上传先前导出的 JSON 文件，或直接将 JSON 格式记忆列表粘贴至下方文本框进行合并导入。
              </p>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label className="dshm-btn dshm-btn-secondary" style={{ cursor: 'pointer' }}>
                  <UploadIcon size={13} />
                  <span>选择本地 JSON 文件</span>
                  <input
                    type="file"
                    accept=".json"
                    style={{ display: 'none' }}
                    onChange={handleFileChange}
                  />
                </label>
                {importText && (
                  <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
                    已加载 {importText.length} 字符
                  </span>
                )}
              </div>

              <div className="dshm-form-group">
                <label className="dshm-form-label">粘贴 JSON 数组或对象</label>
                <textarea
                  className="dshm-form-textarea"
                  rows={6}
                  placeholder='[ { "content": "记忆内容...", "type": "preference" } ]'
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  style={{ fontFamily: 'monospace', fontSize: 12 }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 6 }}>
                <button
                  type="button"
                  className="dshm-btn dshm-btn-secondary"
                  onClick={onClose}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="dshm-btn dshm-btn-primary"
                  onClick={handleImport}
                  disabled={isImporting || !importText.trim()}
                >
                  <UploadIcon size={13} />
                  <span>{isImporting ? '正在解析导入…' : '确认导入入库'}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
