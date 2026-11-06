import * as React from 'react';
import type { LLMConfigUI, WorkspaceViewMode } from '../types.js';
import {
  GlassNavbar,
  GlassButton,
  useGlassVariant,
  GlassThemeContext,
} from './GlassUI.js';
import {
  BrainIcon,
  PlusIcon,
  RefreshIcon,
  SettingsIcon,
  ListIcon,
  GraphIcon,
  DownloadIcon,
  LayersIcon,
  CpuIcon,
  TargetIcon,
  SparklesIcon,
} from './Icons.js';

interface MemoryHeaderProps {
  onRefresh: () => void;
  onNewMemory: () => void;
  onOpenConfig: () => void;
  onOpenBackup: () => void;
  viewMode: WorkspaceViewMode;
  onViewModeChange: (mode: WorkspaceViewMode) => void;
  llmConfig: LLMConfigUI | null;
  isRefreshing: boolean;
  totalMemories?: number;
  coreMemoryCount?: number;
  pendingRepairsCount?: number;
}

export const MemoryHeader: React.FC<MemoryHeaderProps> = ({
  onRefresh,
  onNewMemory,
  onOpenConfig,
  onOpenBackup,
  viewMode,
  onViewModeChange,
  llmConfig,
  isRefreshing,
  totalMemories = 0,
  coreMemoryCount = 0,
  pendingRepairsCount = 0,
}) => {
  const isLLMConfigured = !!llmConfig?.offlineLLM.baseURL;
  const isConsentEnabled = !!llmConfig?.privacy.offlineConsent;
  const activeModel = llmConfig?.offlineLLM.model || '未指定模型';

  const variant = useGlassVariant();
  const { setVariant } = React.useContext(GlassThemeContext);

  return (
    <GlassNavbar
      variant={variant}
      brandIcon={<BrainIcon size={20} />}
      title="长期记忆中心"
      versionBadge={<span className="dshm-badge-version">v0.5.0 · HippoRAG 2 + SYNAPSE + MMR</span>}
      subtitle={
        <>
          <span className="dshm-dot-online" />
          <span>HippoRAG 2 多源汇聚 · SYNAPSE 扇出激活扩散 · LightMem 次模 MMR 装箱 · A-Mem 双链织网</span>
        </>
      }
      actions={
        <>
          <GlassButton
            variant={variant}
            onClick={() => setVariant(variant === 'light' ? 'dark' : 'light')}
            title="切换 Light Glass (白雾毛玻璃) / Dark Glass (黑曜毛玻璃) 变体"
          >
            <SparklesIcon size={13} />
            <span>{variant === 'light' ? 'Light Glass' : 'Dark Glass'}</span>
          </GlassButton>

          <GlassButton
            variant={variant}
            onClick={onOpenBackup}
            title="导出 JSON / Markdown 知识库或导入恢复"
          >
            <DownloadIcon size={13} />
            <span>备份迁移</span>
          </GlassButton>

          <GlassButton
            variant={variant}
            onClick={onOpenConfig}
            title={
              isLLMConfigured
                ? isConsentEnabled
                  ? `离线进化已启用 (${activeModel})，点击配置`
                  : `已配置 ${activeModel}（进化已暂停），点击配置`
                : '配置离线大模型连接、协议与每日风控配额'
            }
          >
            <span
              className={`dshm-pill-dot ${
                isLLMConfigured
                  ? isConsentEnabled
                    ? 'dshm-pill-dot-green'
                    : 'dshm-pill-dot-yellow'
                  : 'dshm-pill-dot-gray'
              }`}
            />
            <SettingsIcon size={14} />
            <span>模型配置</span>
          </GlassButton>

          <GlassButton
            variant={variant}
            size="icon"
            className={isRefreshing ? 'dshm-spin' : ''}
            onClick={onRefresh}
            disabled={isRefreshing}
            title="刷新全局记忆与遥测状态"
          >
            <RefreshIcon size={14} />
          </GlassButton>

          <GlassButton
            variant={variant}
            intent="primary"
            onClick={onNewMemory}
          >
            <PlusIcon size={14} />
            <span>记录记忆</span>
          </GlassButton>
        </>
      }
      items={[
        {
          key: 'memories',
          label: '记忆库浏览',
          icon: <ListIcon size={14} />,
          badge: totalMemories,
        },
        {
          key: 'core',
          label: '核心记忆块 (Scratchpad)',
          icon: <LayersIcon size={14} />,
          badge: coreMemoryCount > 0 ? coreMemoryCount : undefined,
        },
        {
          key: 'sandbox',
          label: '召回沙盒 & 透视',
          icon: <TargetIcon size={14} />,
        },
        {
          key: 'graph',
          label: '知识拓扑图谱',
          icon: <GraphIcon size={14} />,
        },
        {
          key: 'evolution',
          label: '进化实验室 & 评测',
          icon: <CpuIcon size={14} />,
          badge: pendingRepairsCount > 0 ? `${pendingRepairsCount} 待审` : undefined,
          badgeWarm: pendingRepairsCount > 0,
        },
      ]}
      activeKey={viewMode}
      onSelect={(k) => onViewModeChange(k as WorkspaceViewMode)}
    />
  );
};
