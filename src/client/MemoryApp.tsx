import * as React from 'react';
import type {
  OverviewResponse,
  MemoryRecordUI,
  LLMConfigUI,
  WorkspaceViewMode,
  ListDensityMode,
} from './types.js';
import { ensureMemoryStyle } from './styles.js';
import { fetchOverview, fetchMemories, performAction, fetchLLMConfig } from './api.js';
import { MemoryHeader } from './components/MemoryHeader.js';
import { StatCards } from './components/StatCards.js';
import { FilterToolbar } from './components/FilterToolbar.js';
import { MemoryCard } from './components/MemoryCard.js';
import { NewMemoryModal } from './components/NewMemoryModal.js';
import { MemoryDetailModal } from './components/MemoryDetailModal.js';
import { LLMConfigModal } from './components/LLMConfigModal.js';
import { BackupModal } from './components/BackupModal.js';
import { GraphView } from './components/GraphView.js';
import { CoreMemoryView } from './components/CoreMemoryView.js';
import { EvolutionView } from './components/EvolutionView.js';
import { RecallSandboxView } from './components/RecallSandboxView.js';
import { BatchBar } from './components/BatchBar.js';
import { RefreshIcon } from './components/Icons.js';
import {
  type GlassVariant,
  GlassThemeContext,
  GlassCard,
  GlassButton,
} from './components/GlassUI.js';

export const MemoryApp: React.FC = () => {
  // Ensure styles are mounted
  React.useEffect(() => {
    ensureMemoryStyle();
  }, []);

  const [glassVariant, setGlassVariant] = React.useState<GlassVariant>('light');
  const [overview, setOverview] = React.useState<OverviewResponse | null>(null);
  const [memories, setMemories] = React.useState<MemoryRecordUI[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);

  // Primary Workspace View Mode: 'memories' | 'core' | 'sandbox' | 'graph' | 'evolution'
  const [viewMode, setViewMode] = React.useState<WorkspaceViewMode>('memories');
  // List Density Mode: 'card' | 'compact'
  const [density, setDensity] = React.useState<ListDensityMode>('card');

  // Filters & Sorting
  const [searchQuery, setSearchQuery] = React.useState('');
  const [selectedType, setSelectedType] = React.useState('all');
  const [selectedStatus, setSelectedStatus] = React.useState('all');
  const [selectedScope, setSelectedScope] = React.useState('all');
  const [sortBy, setSortBy] = React.useState('updated');

  // Multi-Selection State
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());

  // Modals
  const [isNewModalOpen, setIsNewModalOpen] = React.useState(false);
  const [isConfigModalOpen, setIsConfigModalOpen] = React.useState(false);
  const [isBackupModalOpen, setIsBackupModalOpen] = React.useState(false);
  const [inspectingId, setInspectingId] = React.useState<string | null>(null);
  const [llmConfig, setLlmConfig] = React.useState<LLMConfigUI | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast((curr) => (curr === msg ? null : curr));
    }, 3200);
  };

  const loadData = React.useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);

      try {
        const [ovRes, listRes, cfgRes] = await Promise.all([
          fetchOverview(),
          fetchMemories({
            q: searchQuery,
            type: selectedType,
            status: selectedStatus,
            scope: selectedScope,
            limit: 150,
          }),
          fetchLLMConfig().catch(() => null),
        ]);
        setOverview(ovRes);
        setMemories(listRes.items);
        if (cfgRes?.config) {
          setLlmConfig(cfgRes.config);
        }
      } catch (err: any) {
        console.error('[dsh-memory UI error]', err);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [searchQuery, selectedType, selectedStatus, selectedScope]
  );

  // Load when filters change
  React.useEffect(() => {
    const timer = setTimeout(() => {
      loadData();
    }, 150);
    return () => clearTimeout(timer);
  }, [loadData]);

  // Handle individual actions
  const handlePinToggle = async (id: string, currentPinned: boolean) => {
    try {
      await performAction(currentPinned ? 'unpin' : 'pin', { id });
      showToast(currentPinned ? '已取消置顶' : '已置顶并固化至系统提示词');
      loadData(true);
    } catch (err: any) {
      showToast(err?.message || '操作失败');
    }
  };

  const handleFreezeToggle = async (id: string, currentFrozen: boolean) => {
    try {
      await performAction(currentFrozen ? 'unfreeze' : 'freeze', { id });
      showToast(currentFrozen ? '已解除冻结' : '已进入冻结保护状态');
      loadData(true);
    } catch (err: any) {
      showToast(err?.message || '操作失败');
    }
  };

  const handleForget = async (id: string) => {
    if (!window.confirm('确认归档遗忘该记忆？遗忘后将不再被在线召回。')) return;
    try {
      await performAction('forget', { id });
      showToast('记忆已遗忘并归档');
      loadData(true);
    } catch (err: any) {
      showToast(err?.message || '操作失败');
    }
  };

  const handleRestore = async (id: string) => {
    try {
      await performAction('restore', { id });
      showToast('记忆已成功恢复为活跃状态！');
      loadData(true);
    } catch (err: any) {
      showToast(err?.message || '恢复失败');
    }
  };

  const handleConfirm = async (id: string) => {
    try {
      await performAction('confirm', { id });
      showToast('已强化有效性与置信度评分！');
      loadData(true);
    } catch (err: any) {
      showToast(err?.message || '操作失败');
    }
  };

  const handleApprove = async (id: string) => {
    try {
      await performAction('approve', { id });
      showToast('候选记忆已审批入库并生效！');
      loadData(true);
    } catch (err: any) {
      showToast(err?.message || '审批失败');
    }
  };

  const handleCreateMemory = async (data: {
    content: string;
    summary?: string;
    slot_key?: string;
    importance?: number;
    type: string;
    scope: string;
    pinned: boolean;
  }) => {
    await performAction('create', data);
    showToast('新记忆已保存并成功入库！');
    loadData(true);
  };

  // Multi-Selection handlers
  const handleSelectToggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleToggleSelectAll = () => {
    if (selectedIds.size === memories.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(memories.map((m) => m.id)));
    }
  };

  const handleBatchAction = async (
    subAction: 'pin' | 'unpin' | 'freeze' | 'unfreeze' | 'forget' | 'restore' | 'approve' | 'confirm'
  ) => {
    if (selectedIds.size === 0) return;
    try {
      const res = await performAction('batch', {
        subAction,
        ids: Array.from(selectedIds),
      });
      showToast(`批量操作成功：已更新 ${res.affected} 条记忆`);
      setSelectedIds(new Set());
      loadData(true);
    } catch (err: any) {
      showToast(err?.message || '批量操作失败');
    }
  };

  const handleBatchExport = () => {
    const selectedList = memories.filter((m) => selectedIds.has(m.id));
    if (selectedList.length === 0) return;
    const jsonStr = JSON.stringify(
      { ok: true, total: selectedList.length, memories: selectedList },
      null,
      2
    );
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dsh-memories-selected-${selectedList.length}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`已导出 ${selectedList.length} 条选中的记忆`);
  };

  // Sorting
  const sortedMemories = React.useMemo(() => {
    const list = [...memories];
    if (sortBy === 'pinned') {
      list.sort(
        (a, b) =>
          (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated_at - a.updated_at
      );
    } else if (sortBy === 'importance') {
      list.sort(
        (a, b) =>
          (b.importance ?? 5) - (a.importance ?? 5) || b.updated_at - a.updated_at
      );
    } else if (sortBy === 'utility') {
      list.sort(
        (a, b) =>
          (b.utility ?? 0) - (a.utility ?? 0) || b.updated_at - a.updated_at
      );
    } else if (sortBy === 'use_count') {
      list.sort((a, b) => b.use_count - a.use_count || b.updated_at - a.updated_at);
    } else if (sortBy === 'confidence') {
      list.sort((a, b) => b.confidence - a.confidence || b.updated_at - a.updated_at);
    } else if (sortBy === 'created') {
      list.sort((a, b) => b.created_at - a.created_at);
    } else {
      // updated (pinned first)
      list.sort(
        (a, b) =>
          (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated_at - a.updated_at
      );
    }
    return list;
  }, [memories, sortBy]);

  // Compute category counts for tab badges
  const st = overview?.stats;
  const counts = {
    all: st?.total ?? 0,
    preference: st?.byType['preference'] ?? 0,
    semantic: (st?.byType['semantic'] ?? 0) + (st?.byType['fact'] ?? 0),
    procedural: (st?.byType['procedural'] ?? 0) + (st?.byType['procedure'] ?? 0),
    experience:
      (st?.byType['episodic'] ?? 0) +
      (st?.byType['failure'] ?? 0) +
      (st?.byType['belief'] ?? 0) +
      (st?.byType['goal'] ?? 0) +
      (st?.byType['meta'] ?? 0),
    candidate: st?.byStatus['candidate'] ?? 0,
    archived: st?.byStatus['archived'] ?? 0,
    pinned: st?.pinnedCount ?? 0,
  };

  return (
    <GlassThemeContext.Provider
      value={{ variant: glassVariant, setVariant: setGlassVariant }}
    >
      <div className="dshm-root" data-glass-variant={glassVariant}>
        {/* Ambient Mesh Glow Orbs for Glassmorphism */}
        <div className="dshm-ambient-orb is-orb-1" aria-hidden="true" />
        <div className="dshm-ambient-orb is-orb-2" aria-hidden="true" />
        <div className="dshm-ambient-orb is-orb-3" aria-hidden="true" />

        <div className="dshm-container">
          {/* Toast notification */}
          {toast && (
            <div
              className="dshm-toast glass-base glass-dark"
              style={{
                position: 'fixed',
                top: 'auto',
                left: 'auto',
                bottom: 24,
                right: 24,
                width: 'fit-content',
                maxWidth: 'min(520px, calc(100vw - 48px))',
                height: 'auto',
                minHeight: 0,
                transform: 'none',
                zIndex: 100000,
              }}
            >
              <span className="dshm-toast-icon">✨</span>
              <span className="dshm-toast-text">{toast}</span>
            </div>
          )}

          {/* 1. GlassNavbar Header with 5-Tab Workspace Navigation & Quick Actions */}
          <MemoryHeader
            onRefresh={() => loadData(true)}
            onNewMemory={() => setIsNewModalOpen(true)}
            onOpenConfig={() => setIsConfigModalOpen(true)}
            onOpenBackup={() => setIsBackupModalOpen(true)}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            llmConfig={llmConfig}
            isRefreshing={refreshing}
            totalMemories={counts.all}
            pendingRepairsCount={overview?.pendingRepairsCount || 0}
            coreMemoryCount={overview?.coreMemoryCount || 0}
          />

          {/* 2. Top Bento Stat Tiles (GlassCard) */}
          <StatCards
            overview={overview}
            onFilterSelect={(status, type) => {
              setViewMode('memories');
              if (status !== undefined) setSelectedStatus(status);
              if (type !== undefined) setSelectedType(type);
            }}
            onNavigateView={setViewMode}
          />

          {/* 3. Main Workspace Views */}
          {viewMode === 'core' ? (
            <CoreMemoryView
              onToast={showToast}
              onInspect={(id) => setInspectingId(id)}
              onUpdated={() => loadData(true)}
            />
          ) : viewMode === 'sandbox' ? (
            <RecallSandboxView
              onToast={showToast}
              onInspect={(id) => setInspectingId(id)}
            />
          ) : viewMode === 'graph' ? (
            <GraphView
              onInspect={(id) => setInspectingId(id)}
              onToast={showToast}
            />
          ) : viewMode === 'evolution' ? (
            <EvolutionView
              onToast={showToast}
              onInspect={(id) => setInspectingId(id)}
              onUpdated={() => loadData(true)}
            />
          ) : (
            <>
              {/* 3.1. Filter Toolbar (GlassCard + GlassInput) */}
              <FilterToolbar
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                selectedType={selectedType}
                onTypeChange={setSelectedType}
                selectedStatus={selectedStatus}
                onStatusChange={setSelectedStatus}
                selectedScope={selectedScope}
                onScopeChange={setSelectedScope}
                sortBy={sortBy}
                onSortChange={setSortBy}
                density={density}
                onDensityChange={setDensity}
                counts={counts}
                totalLoaded={memories.length}
                isAllSelected={
                  memories.length > 0 && selectedIds.size === memories.length
                }
                onToggleSelectAll={handleToggleSelectAll}
              />

              {/* 3.2. Memory Cards / Compact Table List */}
              {loading ? (
                <GlassCard variant={glassVariant} interactive={false} className="dshm-loading-state">
                  <div className="dshm-spin">
                    <RefreshIcon size={24} />
                  </div>
                  <div>正在加载长期记忆库…</div>
                </GlassCard>
              ) : sortedMemories.length === 0 ? (
                <GlassCard variant={glassVariant} interactive={false} className="dshm-empty-state">
                  <div className="dshm-empty-icon">📂</div>
                  <h3 className="dshm-empty-title">暂无匹配的长期记忆</h3>
                  <p className="dshm-empty-desc">
                    {searchQuery
                      ? `未找到与 “${searchQuery}” 相关的记忆，请尝试更换关键词。`
                      : '当前分类下暂无记忆条目。您可以点击上方“记录记忆”手动录入，或在日常会话中让系统自动提炼。'}
                  </p>
                  <GlassButton
                    type="button"
                    variant={glassVariant}
                    intent="primary"
                    className="dshm-btn dshm-btn-primary"
                    onClick={() => setIsNewModalOpen(true)}
                  >
                    + 记录第一条记忆
                  </GlassButton>
                </GlassCard>
              ) : (
                <div
                  className={
                    density === 'compact' ? 'dshm-compact-list' : 'dshm-card-list'
                  }
                >
                  {density === 'compact' && (
                    <div className="dshm-compact-thead glass-base glass-dark">
                      <span className="dshm-th-left">类别 / 槽位 / 状态</span>
                      <span className="dshm-th-body">记忆正文 (Memory Content)</span>
                      <span className="dshm-th-right">置信度 / 命中 / 更新时间 / 操作</span>
                    </div>
                  )}
                  {sortedMemories.map((mem) => (
                    <MemoryCard
                      key={mem.id}
                      memory={mem}
                      density={density}
                      selected={selectedIds.has(mem.id)}
                      onSelectToggle={handleSelectToggle}
                      onPinToggle={handlePinToggle}
                      onFreezeToggle={handleFreezeToggle}
                      onForget={handleForget}
                      onRestore={handleRestore}
                      onConfirm={handleConfirm}
                      onApprove={handleApprove}
                      onInspect={(id) => setInspectingId(id)}
                      onToast={showToast}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {/* 4. Floating Batch Action Bar (in memories view) */}
          {viewMode === 'memories' && (
            <BatchBar
              selectedCount={selectedIds.size}
              onClear={() => setSelectedIds(new Set())}
              onBatchPin={() => handleBatchAction('pin')}
              onBatchUnpin={() => handleBatchAction('unpin')}
              onBatchFreeze={() => handleBatchAction('freeze')}
              onBatchForget={() => handleBatchAction('forget')}
              onBatchRestore={() => handleBatchAction('restore')}
              onBatchApprove={() => handleBatchAction('approve')}
              onBatchConfirm={() => handleBatchAction('confirm')}
              onBatchExport={handleBatchExport}
            />
          )}

          {/* 5. GlassModal Modals */}
          <NewMemoryModal
            isOpen={isNewModalOpen}
            onClose={() => setIsNewModalOpen(false)}
            onSubmit={handleCreateMemory}
          />

          <MemoryDetailModal
            memoryId={inspectingId}
            onClose={() => setInspectingId(null)}
            onToast={showToast}
            onMemoryUpdated={() => loadData(true)}
          />

          <LLMConfigModal
            isOpen={isConfigModalOpen}
            onClose={() => setIsConfigModalOpen(false)}
            config={llmConfig}
            onSaved={(updated) => {
              setLlmConfig(updated);
              loadData(true);
            }}
            onToast={showToast}
          />

          <BackupModal
            isOpen={isBackupModalOpen}
            onClose={() => setIsBackupModalOpen(false)}
            onToast={showToast}
            onSuccess={() => loadData(true)}
          />
        </div>
      </div>
    </GlassThemeContext.Provider>
  );
};
