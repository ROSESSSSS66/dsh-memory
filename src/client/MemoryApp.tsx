import * as React from 'react';
import type { OverviewResponse, MemoryRecordUI, LLMConfigUI } from './types.js';
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
import { BatchBar } from './components/BatchBar.js';
import { RefreshIcon } from './components/Icons.js';

export const MemoryApp: React.FC = () => {
  // Ensure styles are mounted
  React.useEffect(() => {
    ensureMemoryStyle();
  }, []);

  const [overview, setOverview] = React.useState<OverviewResponse | null>(null);
  const [memories, setMemories] = React.useState<MemoryRecordUI[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [maintaining, setMaintaining] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);

  // View Mode: 'list' | 'graph'
  const [viewMode, setViewMode] = React.useState<'list' | 'graph'>('list');

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

  const loadData = React.useCallback(async (isRefresh = false) => {
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
          limit: 120,
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
  }, [searchQuery, selectedType, selectedStatus, selectedScope]);

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
    type: string;
    scope: string;
    pinned: boolean;
  }) => {
    await performAction('create', data);
    showToast('新记忆已保存并成功入库！');
    loadData(true);
  };

  const handleMaintain = async () => {
    setMaintaining(true);
    try {
      await performAction('maintain');
      showToast('离线维护完成：冷记忆归档与候选清理已就绪');
      loadData(true);
    } catch (err: any) {
      showToast(err?.message || '维护失败');
    } finally {
      setMaintaining(false);
    }
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
    subAction: 'pin' | 'unpin' | 'freeze' | 'unfreeze' | 'forget' | 'restore'
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
    fact: st?.byType['fact'] ?? 0,
    procedure: st?.byType['procedure'] ?? 0,
    candidate: st?.byStatus['candidate'] ?? 0,
    archived: st?.byStatus['archived'] ?? 0,
  };

  return (
    <div className="dshm-root">
      <div className="dshm-container">
        {/* Toast notification */}
        {toast && (
          <div className="dshm-toast">
            <span className="dshm-toast-icon">✨</span>
            <span className="dshm-toast-text">{toast}</span>
          </div>
        )}

        {/* 1. Header with View Mode & Backup */}
        <MemoryHeader
          onRefresh={() => loadData(true)}
          onNewMemory={() => setIsNewModalOpen(true)}
          onMaintain={handleMaintain}
          onOpenConfig={() => setIsConfigModalOpen(true)}
          onOpenBackup={() => setIsBackupModalOpen(true)}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          llmConfig={llmConfig}
          isRefreshing={refreshing}
          isMaintaining={maintaining}
        />

        {/* 2. Top Stats Tiles */}
        <StatCards
          overview={overview}
          onFilterSelect={(status, type) => {
            if (status) setSelectedStatus(status);
            if (type) setSelectedType(type);
          }}
        />

        {/* 3. Main Content: Graph View vs List View */}
        {viewMode === 'graph' ? (
          <GraphView
            onInspect={(id) => setInspectingId(id)}
          />
        ) : (
          <>
            {/* 3.1. Filter Toolbar */}
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
              counts={counts}
              totalLoaded={memories.length}
              isAllSelected={
                memories.length > 0 && selectedIds.size === memories.length
              }
              onToggleSelectAll={handleToggleSelectAll}
            />

            {/* 3.2. Memory Cards List */}
            {loading ? (
              <div
                style={{
                  textAlign: 'center',
                  padding: '60px 0',
                  color: 'var(--dsw-alias-label-secondary)',
                }}
              >
                <div
                  className="dshm-spin"
                  style={{ display: 'inline-block', marginBottom: 12 }}
                >
                  <RefreshIcon size={24} />
                </div>
                <div>正在加载长期记忆库…</div>
              </div>
            ) : sortedMemories.length === 0 ? (
              <div className="dshm-empty-state">
                <div className="dshm-empty-icon">📂</div>
                <h3 className="dshm-empty-title">暂无匹配的长期记忆</h3>
                <p className="dshm-empty-desc">
                  {searchQuery
                    ? `未找到与 “${searchQuery}” 相关的记忆，请尝试更换关键词。`
                    : '当前分类下暂无记忆条目。您可以点击上方“记录记忆”手动录入，或在日常会话中让系统自动提炼。'}
                </p>
                <button
                  type="button"
                  className="dshm-btn dshm-btn-primary"
                  style={{ marginTop: 8 }}
                  onClick={() => setIsNewModalOpen(true)}
                >
                  + 记录第一条记忆
                </button>
              </div>
            ) : (
              <div className="dshm-card-list">
                {sortedMemories.map((mem) => (
                  <MemoryCard
                    key={mem.id}
                    memory={mem}
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

        {/* 4. Floating Batch Action Bar */}
        <BatchBar
          selectedCount={selectedIds.size}
          onClear={() => setSelectedIds(new Set())}
          onBatchPin={() => handleBatchAction('pin')}
          onBatchUnpin={() => handleBatchAction('unpin')}
          onBatchFreeze={() => handleBatchAction('freeze')}
          onBatchForget={() => handleBatchAction('forget')}
          onBatchRestore={() => handleBatchAction('restore')}
          onBatchExport={handleBatchExport}
        />

        {/* 5. Modals */}
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
  );
};
