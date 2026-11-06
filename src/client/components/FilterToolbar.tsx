import * as React from 'react';
import {
  SearchIcon,
  CloseIcon,
  GlobeIcon,
  FolderIcon,
  PinIcon,
  SnowflakeIcon,
  ArrowUpDownIcon,
  CheckSquareIcon,
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
  counts: {
    all: number;
    preference: number;
    fact: number;
    procedure: number;
    candidate: number;
    archived: number;
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
  counts,
  totalLoaded = 0,
  isAllSelected = false,
  onToggleSelectAll,
}) => {
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);

  // Global '/' hotkey to focus search
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="dshm-toolbar">
      {/* Upper row: Search box, Scope selector, Sort selector */}
      <div className="dshm-toolbar-row">
        <div className="dshm-search-box">
          <span className="dshm-search-icon">
            <SearchIcon size={14} />
          </span>
          <input
            ref={searchInputRef}
            type="text"
            className="dshm-search-input"
            placeholder="搜索记忆正文、摘要、槽位… (快捷键 /)"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              className="dshm-search-clear"
              onClick={() => onSearchChange('')}
              title="清除搜索"
            >
              <CloseIcon size={12} />
            </button>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/* Scope Segmented Control */}
          <div className="dshm-segmented-group">
            <div className="dshm-segmented-control">
              <button
                type="button"
                className={`dshm-segment-btn ${selectedScope === 'all' ? 'is-active' : ''}`}
                onClick={() => onScopeChange('all')}
              >
                全部
              </button>
              <button
                type="button"
                className={`dshm-segment-btn ${selectedScope === 'global' ? 'is-active' : ''}`}
                onClick={() => onScopeChange('global')}
              >
                <GlobeIcon size={13} />
                <span>全局</span>
              </button>
              <button
                type="button"
                className={`dshm-segment-btn ${selectedScope === 'workspace' ? 'is-active' : ''}`}
                onClick={() => onScopeChange('workspace')}
              >
                <FolderIcon size={13} />
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
              <option value="use_count">引用次数最多</option>
              <option value="confidence">置信度最高</option>
              <option value="created">最新创建优先</option>
            </select>
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
            <span>偏好</span>
            <span className="dshm-tab-badge">{counts.preference}</span>
          </button>

          <button
            type="button"
            className={`dshm-tab-item ${selectedType === 'fact' ? 'is-active' : ''}`}
            onClick={() => {
              onTypeChange('fact');
              if (selectedStatus === 'candidate' || selectedStatus === 'archived')
                onStatusChange('all');
            }}
          >
            <span>事实</span>
            <span className="dshm-tab-badge">{counts.fact}</span>
          </button>

          <button
            type="button"
            className={`dshm-tab-item ${selectedType === 'procedure' ? 'is-active' : ''}`}
            onClick={() => {
              onTypeChange('procedure');
              if (selectedStatus === 'candidate' || selectedStatus === 'archived')
                onStatusChange('all');
            }}
          >
            <span>流程</span>
            <span className="dshm-tab-badge">{counts.procedure}</span>
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
            className={`dshm-chip-btn ${selectedStatus === 'pinned' ? 'is-active' : ''}`}
            onClick={() => onStatusChange(selectedStatus === 'pinned' ? 'all' : 'pinned')}
            title="仅显示固化置顶项"
          >
            <PinIcon size={12} />
            <span>置顶</span>
          </button>

          <button
            type="button"
            className={`dshm-chip-btn ${selectedStatus === 'frozen' ? 'is-active' : ''}`}
            onClick={() => onStatusChange(selectedStatus === 'frozen' ? 'all' : 'frozen')}
            title="仅显示冻结保护项"
          >
            <SnowflakeIcon size={12} />
            <span>冻结</span>
          </button>

          {onToggleSelectAll && totalLoaded > 0 && (
            <button
              type="button"
              className={`dshm-chip-btn ${isAllSelected ? 'is-active' : ''}`}
              onClick={onToggleSelectAll}
              title={isAllSelected ? '取消全选' : '选择当前展示的所有条目'}
            >
              <CheckSquareIcon size={12} />
              <span>{isAllSelected ? '取消全选' : '全选'}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
