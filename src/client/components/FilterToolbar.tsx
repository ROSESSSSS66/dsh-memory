import React from 'react';
import { GlassCard, GlassInput, GlassSelect, GlassBadge } from './GlassUI.js';

export type MemoryStatusFilter =
  | 'all'
  | 'active'
  | 'candidate'
  | 'frozen'
  | 'superseded'
  | 'archived';

export type MemoryTypeFilter =
  | 'all'
  | 'semantic'
  | 'preference'
  | 'procedural'
  | 'experience';

export type MemoryScopeFilter = 'all' | 'workspace' | 'global';

export interface FilterToolbarProps {
  searchQuery: string;
  onSearchChange: (val: string) => void;
  statusFilter: MemoryStatusFilter;
  onStatusChange: (val: MemoryStatusFilter) => void;
  typeFilter: MemoryTypeFilter;
  onTypeChange: (val: MemoryTypeFilter) => void;
  scopeFilter: MemoryScopeFilter;
  onScopeChange: (val: MemoryScopeFilter) => void;
  totalCount: number;
}

const STATUS_TABS: Array<{ key: MemoryStatusFilter; label: string }> = [
  { key: 'all', label: '全部状态' },
  { key: 'active', label: '● 已生效' },
  { key: 'candidate', label: '◌ 自动观察池' },
  { key: 'frozen', label: '❄ 冻结保护' },
  { key: 'superseded', label: '↺ 历史演进' },
  { key: 'archived', label: '▫ 已归档' },
];

const TYPE_TABS: Array<{ key: MemoryTypeFilter; label: string }> = [
  { key: 'all', label: '全部类型' },
  { key: 'semantic', label: '事实 (Semantic)' },
  { key: 'preference', label: '偏好 (Preference)' },
  { key: 'procedural', label: '流程 (Procedural)' },
  { key: 'experience', label: '事件与反思 (Episodic/Failure)' },
];

export function FilterToolbar({
  searchQuery,
  onSearchChange,
  statusFilter,
  onStatusChange,
  typeFilter,
  onTypeChange,
  scopeFilter,
  onScopeChange,
  totalCount,
}: FilterToolbarProps) {
  return (
    <GlassCard className="dshm-toolbar">
      <div className="dshm-toolbar-top">
        {/* Search Input */}
        <div className="dshm-search-box">
          <span className="dshm-search-icon" aria-hidden="true">
            🔍
          </span>
          <GlassInput
            className="dshm-input--search"
            placeholder="全文检索记忆内容、摘要、槽位 (slot_key) 或短码 ID..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>

        {/* Scope Selector */}
        <div style={{ width: 170 }}>
          <GlassSelect
            value={scopeFilter}
            onChange={(e) => onScopeChange(e.target.value as MemoryScopeFilter)}
            aria-label="记忆作用域筛选"
          >
            <option value="all">全部作用域 (All)</option>
            <option value="workspace">当前工作区 (Workspace)</option>
            <option value="global">全局跨项目 (Global)</option>
          </GlassSelect>
        </div>

        {/* Result Count Badge */}
        <GlassBadge variant="neutral">匹配 {totalCount} 条记忆</GlassBadge>
      </div>

      {/* Bottom Row: Segmented Status & Type Filters */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <div className="dshm-segmented" role="tablist" aria-label="记忆状态筛选">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={statusFilter === tab.key}
              className={`dshm-segment-btn ${
                statusFilter === tab.key ? 'dshm-segment-btn--active' : ''
              }`}
              onClick={() => onStatusChange(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="dshm-segmented" role="tablist" aria-label="记忆类型筛选">
          {TYPE_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={typeFilter === tab.key}
              className={`dshm-segment-btn ${
                typeFilter === tab.key ? 'dshm-segment-btn--active' : ''
              }`}
              onClick={() => onTypeChange(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
    </GlassCard>
  );
}
