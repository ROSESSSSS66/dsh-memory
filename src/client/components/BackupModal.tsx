import * as React from 'react';
import { DownloadIcon, UploadIcon, CopyIcon } from './Icons.js';
import { exportMemories, importMemories } from '../api.js';
import { GlassModal, GlassButton, GlassCard } from './GlassUI.js';

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
      const parsed = JSON.parse(importText.trim());
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
    <GlassModal
      isOpen={isOpen}
      onClose={onClose}
      title="记忆库备份与导入导出"
      subHeader={
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
      }
    >
      {error && <div className="dshm-alert-error">{error}</div>}

      {tab === 'export' ? (
        <div className="dshm-backup-stack">
          <p className="dshm-backup-desc">
            您可以将当前的完整长期记忆库导出为离线文件，便于跨工作区迁移、本地备份或同步至知识管理软件（如 Obsidian / Logseq）。
          </p>

          <div className="dshm-export-grid">
            <GlassCard
              className="dshm-export-card"
              onClick={() => handleDownload('json')}
            >
              <div className="dshm-export-card-icon dshm-icon-blue">
                <DownloadIcon size={20} />
              </div>
              <div className="dshm-export-card-info">
                <h4>导出 JSON 备份</h4>
                <p>包含完整元数据、置信度、版本快照与因果关系图</p>
              </div>
            </GlassCard>

            <GlassCard
              className="dshm-export-card"
              onClick={() => handleDownload('markdown')}
            >
              <div className="dshm-export-card-icon dshm-icon-emerald">
                <DownloadIcon size={20} />
              </div>
              <div className="dshm-export-card-info">
                <h4>导出 Markdown 知识库</h4>
                <p>带 YAML Frontmatter，兼容 Obsidian 与 Memory Bank 格式</p>
              </div>
            </GlassCard>
          </div>

          <div className="dshm-backup-footer-right">
            <GlassButton onClick={handleCopyJson} disabled={isExporting}>
              <CopyIcon size={13} />
              <span>复制 JSON 到剪贴板</span>
            </GlassButton>
          </div>
        </div>
      ) : (
        <div className="dshm-backup-stack">
          <p className="dshm-backup-desc">
            上传先前导出的 JSON 文件，或直接将 JSON 格式记忆列表粘贴至下方文本框进行合并导入。
          </p>

          <div className="dshm-backup-file-row">
            <label className="dshm-btn dshm-btn-secondary glass-base glass-light glass-light-hover">
              <UploadIcon size={13} />
              <span>选择本地 JSON 文件</span>
              <input
                type="file"
                accept=".json"
                className="dshm-hidden-input"
                onChange={handleFileChange}
              />
            </label>
            {importText && (
              <span className="dshm-form-hint">
                已加载 {importText.length} 字符
              </span>
            )}
          </div>

          <div className="dshm-form-group">
            <label className="dshm-form-label">粘贴 JSON 数组或对象</label>
            <textarea
              className="dshm-form-textarea is-mono"
              rows={6}
              placeholder='[ { "content": "记忆内容...", "type": "preference" } ]'
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
          </div>

          <div className="dshm-backup-footer-right">
            <GlassButton onClick={onClose}>取消</GlassButton>
            <GlassButton
              intent="primary"
              onClick={handleImport}
              disabled={isImporting || !importText.trim()}
            >
              <UploadIcon size={13} />
              <span>{isImporting ? '正在解析导入…' : '确认导入入库'}</span>
            </GlassButton>
          </div>
        </div>
      )}
    </GlassModal>
  );
};
