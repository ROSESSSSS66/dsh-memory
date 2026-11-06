import * as React from 'react';
import type { LLMConfigUI } from '../types.js';
import {
  BrainIcon,
  PlusIcon,
  RefreshIcon,
  SparklesIcon,
  SettingsIcon,
  ListIcon,
  GraphIcon,
  DownloadIcon,
} from './Icons.js';

interface MemoryHeaderProps {
  onRefresh: () => void;
  onNewMemory: () => void;
  onMaintain: () => void;
  onOpenConfig: () => void;
  onOpenBackup: () => void;
  viewMode: 'list' | 'graph';
  onViewModeChange: (mode: 'list' | 'graph') => void;
  llmConfig: LLMConfigUI | null;
  isRefreshing: boolean;
  isMaintaining: boolean;
}

export const MemoryHeader: React.FC<MemoryHeaderProps> = ({
  onRefresh,
  onNewMemory,
  onMaintain,
  onOpenConfig,
  onOpenBackup,
  viewMode,
  onViewModeChange,
  llmConfig,
  isRefreshing,
  isMaintaining,
}) => {
  const isLLMConfigured = !!llmConfig?.offlineLLM.baseURL;
  const isConsentEnabled = !!llmConfig?.privacy.offlineConsent;
  const activeModel = llmConfig?.offlineLLM.model || '未指定模型';

  return (
    <header className="dshm-header">
      <div className="dshm-header-left">
        <div className="dshm-brand-icon">
          <BrainIcon size={22} />
        </div>
        <div className="dshm-header-titles">
          <div className="dshm-title-row">
            <h1 className="dshm-title">长期记忆</h1>
            <span className="dshm-badge-version">v0.1.0 · 自进化</span>

            {/* Interactive LLM Status Pill */}
            {isLLMConfigured ? (
              <button
                type="button"
                className={`dshm-llm-pill ${
                  isConsentEnabled ? 'dshm-llm-pill-active' : 'dshm-llm-pill-warning'
                }`}
                onClick={onOpenConfig}
                title={
                  isConsentEnabled
                    ? `离线自主进化已启用: ${activeModel}`
                    : `已配置 ${activeModel}，但未开启外发许可，离线蒸馏暂停。点击配置。`
                }
              >
                <span
                  className={`dshm-pill-dot ${
                    isConsentEnabled ? 'dshm-pill-dot-green' : 'dshm-pill-dot-yellow'
                  }`}
                />
                <span className="dshm-pill-text">
                  {activeModel} {isConsentEnabled ? '· 学习中' : '· 进化暂停'}
                </span>
              </button>
            ) : (
              <button
                type="button"
                className="dshm-llm-pill dshm-llm-pill-neutral"
                onClick={onOpenConfig}
                title="尚未配置离线大模型，点击开启后台自主蒸馏"
              >
                <span className="dshm-pill-dot dshm-pill-dot-gray" />
                <span className="dshm-pill-text">配置大模型</span>
              </button>
            )}
          </div>
          <p className="dshm-subtitle">
            <span className="dshm-dot-online" />
            在线快环 0ms 纯本地检索 · 离线慢环自主蒸馏与哨兵风控
          </p>
        </div>
      </div>

      <div className="dshm-header-actions">
        {/* View Mode Switcher (List vs Graph) */}
        <div className="dshm-segmented-control dshm-segmented-view">
          <button
            type="button"
            className={`dshm-segment-btn ${viewMode === 'list' ? 'is-active' : ''}`}
            onClick={() => onViewModeChange('list')}
            title="卡片列表视图"
          >
            <ListIcon size={13} />
            <span>卡片</span>
          </button>
          <button
            type="button"
            className={`dshm-segment-btn ${viewMode === 'graph' ? 'is-active' : ''}`}
            onClick={() => onViewModeChange('graph')}
            title="知识拓扑图谱视图 (Obsidian 风格)"
          >
            <GraphIcon size={13} />
            <span>图谱</span>
          </button>
        </div>

        {/* Backup / Export button */}
        <button
          type="button"
          className="dshm-btn dshm-btn-secondary"
          onClick={onOpenBackup}
          title="导出备份或导入记忆"
        >
          <DownloadIcon size={13} />
          <span>备份/导出</span>
        </button>

        <button
          type="button"
          className="dshm-btn dshm-btn-secondary"
          onClick={onOpenConfig}
          title="配置离线大模型连接与配额参数"
        >
          <SettingsIcon size={14} />
          <span>模型配置</span>
        </button>

        <button
          type="button"
          className="dshm-btn dshm-btn-secondary"
          onClick={onMaintain}
          disabled={isMaintaining}
          title="执行离线清理、候选过期与冷记忆归档"
        >
          <SparklesIcon size={14} />
          <span>{isMaintaining ? '维护中…' : '执行维护'}</span>
        </button>

        <button
          type="button"
          className={`dshm-btn dshm-btn-secondary dshm-btn-icon-only ${isRefreshing ? 'dshm-spin' : ''}`}
          onClick={onRefresh}
          disabled={isRefreshing}
          title="刷新数据"
        >
          <RefreshIcon size={14} />
        </button>

        <button
          type="button"
          className="dshm-btn dshm-btn-primary"
          onClick={onNewMemory}
        >
          <PlusIcon size={14} />
          <span>记录记忆</span>
        </button>
      </div>
    </header>
  );
};
