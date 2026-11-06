import * as React from 'react';
import type { ListDensityMode } from '../types.js';
import { GlassCard, GlassInput } from './GlassUI.js';
import {
  SearchIcon,
  CloseIcon,
  GlobeIcon,
  FolderIcon,
  PinIcon,
  SnowflakeIcon,
  ArrowUpDownIcon,
  CheckSquareIcon,
  GridIcon,
  TableIcon,
} from './Icons.js';

interface FilterToolbarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  selectedType: string;
  onTypeChange: (type: string) => void;
  selectedStatus: string;
  onStatusChange: (status: string) => void;
  selectedScope: string;
  onScopeChange: (scope: string) => void;
  sortBy: string;
  onSortChange: (sort: string) => void;
  density: ListDensityMode;
  onDensityChange: (mode: ListDensityMode) => void;
  counts: {
    all: number;
    preference: number;
    semantic: number;
    procedural: number;
    experience: number;
    candidate: number;
    archived: number;
    pinned?: number;
  };
  totalLoaded?: number;
  isAllSelected?: boolean;
  onToggleSelectAll?: () => void;
}

export const FilterToolbar: React.FC<FilterToolbarProps> = ({
  searchQuery,
  onSearchChange,
  selectedType,
  onTypeChange,
  selectedStatus,
  onStatusChange,
  selectedScope,
  onScopeChange,
  sortBy,
  onSortChange,
  density,
  onDensityChange,
  counts,
  totalLoaded = 0,
  isAllSelected = false,
  onToggleSelectAll,
}) => {
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);

  // Global '/' hotkey to focus search
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === '/' &&
        document.activeElement?.tagName !== 'INPUT' &&
        document.activeElement?.tagName !== 'TEXTAREA' &&
        document.activeElement?.tagName !== 'SELECT'
      ) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const hasActiveFilters =
    searchQuery !== '' ||
    selectedType !== 'all' ||
    selectedStatus !== 'all' ||
    selectedScope !== 'all';

  return (
    <GlassCard interactive={false} className="dshm-toolbar">
      {/* Upper row: Search box, Scope selector, Sort selector, Density toggle */}
      <div className="dshm-toolbar-row">
        <GlassInput
          ref={searchInputRef}
          type="text"
          leftIcon={<SearchIcon size={14} />}
          rightSlot={
            !searchQuery ? (
              <kbd className="dshm-kbd-hint">/</kbd>
            ) : (
              <button
                type="button"
                className="dshm-search-clear"
                onClick={() => onSearchChange('')}
                title="清除搜索"
              >
                <CloseIcon size={12} />
              </button>
            )
          }
          placeholder="搜索记忆正文、摘要、槽位 (slot_key) 或 ID…"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />

        <div className="dshm-toolbar-controls">
          {/* Scope Segmented Control */}
          <div className="dshm-segmented-group">
            <div className="dshm-segmented-control">
              <button
                type="button"
                className={`dshm-segment-btn ${selectedScope === 'all' ? 'is-active' : ''}`}
                onClick={() => onScopeChange('all')}
              >
                全部域
              </button>
              <button
                type="button"
                className={`dshm-segment-btn ${selectedScope === 'global' ? 'is-active' : ''}`}
                onClick={() => onScopeChange('global')}
              >
                <GlobeIcon size={12} />
                <span>全局</span>
              </button>
              <button
                type="button"
                className={`dshm-segment-btn ${selectedScope === 'workspace' ? 'is-active' : ''}`}
                onClick={() => onScopeChange('workspace')}
              >
                <FolderIcon size={12} />
                <span>工作区</span>
              </button>
            </div>
          </div>

          {/* Sort Dropdown */}
          <div className="dshm-sort-wrapper">
            <span className="dshm-sort-icon">
              <ArrowUpDownIcon size={12} />
            </span>
            <select
              className="dshm-sort-select"
              value={sortBy}
              onChange={(e) => onSortChange(e.target.value)}
              title="排序方式"
            >
              <option value="updated">最新更新优先</option>
              <option value="pinned">置顶固化优先</option>
              <option value="importance">重要度最高</option>
              <option value="utility">实用度最高</option>
              <option value="use_count">引用次数最多</option>
              <option value="confidence">置信度最高</option>
              <option value="created">最新创建优先</option>
            </select>
          </div>

          {/* View Density Switcher */}
          <div className="dshm-segmented-control" title="切换列表展示密度">
            <button
              type="button"
              className={`dshm-segment-btn ${density === 'card' ? 'is-active' : ''}`}
              onClick={() => onDensityChange('card')}
              title="舒适卡片视图"
            >
              <GridIcon size={13} />
            </button>
            <button
              type="button"
              className={`dshm-segment-btn ${density === 'compact' ? 'is-active' : ''}`}
              onClick={() => onDensityChange('compact')}
              title="紧凑高密度列表"
            >
              <TableIcon size={13} />
            </button>
          </div>
        </div>
      </div>

      {/* Lower row: Category Tabs, Status chips & Select All */}
      <div className="dshm-toolbar-row">
        <div className="dshm-tabs-control">
          <button
            type="button"
            className={`dshm-tab-item ${
              selectedType === 'all' &&
              selectedStatus !== 'candidate' &&
              selectedStatus !== 'archived'
                ? 'is-active'
                : ''
            }`}
            onClick={() => {
              onTypeChange('all');
              if (selectedStatus === 'candidate' || selectedStatus === 'archived') {
                onStatusChange('all');
              }
            }}
          >
            <span>全部</span>
            <span className="dshm-tab-badge">{counts.all}</span>
          </button>

          <button
            type="button"
            className={`dshm-tab-item ${selectedType === 'preference' ? 'is-active' : ''}`}
            onClick={() => {
              onTypeChange('preference');
              if (selectedStatus === 'candidate' || selectedStatus === 'archived')
                onStatusChange('all');
            }}
          >
            <span className="dshm-type-dot is-preference" />
            <span>偏好习惯</span>
            <span className="dshm-tab-badge">{counts.preference}</span>
          </button>

          <button
            type="button"
            className={`dshm-tab-item ${selectedType === 'semantic' ? 'is-active' : ''}`}
            onClick={() => {
              onTypeChange('semantic');
              if (selectedStatus === 'candidate' || selectedStatus === 'archived')
                onStatusChange('all');
            }}
          >
            <span className="dshm-type-dot is-semantic" />
            <span>事实知识</span>
            <span className="dshm-tab-badge">{counts.semantic}</span>
          </button>

          <button
            type="button"
            className={`dshm-tab-item ${selectedType === 'procedural' ? 'is-active' : ''}`}
            onClick={() => {
              onTypeChange('procedural');
              if (selectedStatus === 'candidate' || selectedStatus === 'archived')
                onStatusChange('all');
            }}
          >
            <span className="dshm-type-dot is-procedural" />
            <span>流程规范</span>
            <span className="dshm-tab-badge">{counts.procedural}</span>
          </button>

          <button
            type="button"
            className={`dshm-tab-item ${selectedType === 'experience' ? 'is-active' : ''}`}
            onClick={() => {
              onTypeChange('experience');
              if (selectedStatus === 'candidate' || selectedStatus === 'archived')
                onStatusChange('all');
            }}
          >
            <span className="dshm-type-dot is-experience" />
            <span>情景/反思</span>
            <span className="dshm-tab-badge">{counts.experience}</span>
          </button>

          <button
            type="button"
            className={`dshm-tab-item ${selectedStatus === 'candidate' ? 'is-active' : ''}`}
            onClick={() => {
              onStatusChange(selectedStatus === 'candidate' ? 'all' : 'candidate');
              onTypeChange('all');
            }}
          >
            <span>待审候选</span>
            <span className={`dshm-tab-badge ${counts.candidate > 0 ? 'is-warm' : ''}`}>
              {counts.candidate}
            </span>
          </button>

          <button
            type="button"
            className={`dshm-tab-item ${selectedStatus === 'archived' ? 'is-active' : ''}`}
            onClick={() => {
              onStatusChange(selectedStatus === 'archived' ? 'all' : 'archived');
              onTypeChange('all');
            }}
          >
            <span>已归档</span>
            <span className="dshm-tab-badge">{counts.archived}</span>
          </button>
        </div>

        {/* Status flags filter & Batch Select Toggle */}
        <div className="dshm-filter-chips">
          <button
            type="button"
            className={`dshm-chip-btn ${selectedStatus === 'pinned' ? 'is-active-amber' : ''}`}
            onClick={() => onStatusChange(selectedStatus === 'pinned' ? 'all' : 'pinned')}
            title="仅显示已置顶固化到 System Prompt 的记忆"
          >
            <PinIcon size={12} />
            <span>置顶{counts.pinned ? ` (${counts.pinned})` : ''}</span>
          </button>

          <button
            type="button"
            className={`dshm-chip-btn ${selectedStatus === 'frozen' ? 'is-active-cyan' : ''}`}
            onClick={() => onStatusChange(selectedStatus === 'frozen' ? 'all' : 'frozen')}
            title="仅显示冻结保护项"
          >
            <SnowflakeIcon size={12} />
            <span>冻结</span>
          </button>

          {hasActiveFilters && (
            <button
              type="button"
              className="dshm-chip-btn is-reset"
              onClick={() => {
                onSearchChange('');
                onTypeChange('all');
                onStatusChange('all');
                onScopeChange('all');
              }}
              title="清除所有筛选条件"
            >
              <CloseIcon size={11} />
              <span>重置</span>
            </button>
          )}

          {onToggleSelectAll && totalLoaded > 0 && (
            <button
              type="button"
              className={`dshm-chip-btn ${isAllSelected ? 'is-active' : ''}`}
              onClick={onToggleSelectAll}
              title={isAllSelected ? '取消全选' : '选择当前列表中的所有记忆'}
            >
              <CheckSquareIcon size={12} />
              <span>{isAllSelected ? '取消全选' : '全选'}</span>
            </button>
          )}
        </div>
      </div>
    </GlassCard>
  );
};
