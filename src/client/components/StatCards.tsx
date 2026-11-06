import * as React from 'react';
import type { OverviewResponse, WorkspaceViewMode } from '../types.js';
import { GlassCard } from './GlassUI.js';
import { BrainIcon, PinIcon, ZapIcon, ShieldIcon } from './Icons.js';

interface StatCardsProps {
  overview: OverviewResponse | null;
  onFilterSelect?: (status: string, type?: string) => void;
  onNavigateView?: (mode: WorkspaceViewMode) => void;
}

export const StatCards: React.FC<StatCardsProps> = ({
  overview,
  onFilterSelect,
  onNavigateView,
}) => {
  const stats = overview?.stats;
  const total = stats?.total ?? 0;
  const active = stats?.byStatus['active'] ?? 0;
  const candidate = stats?.byStatus['candidate'] ?? 0;
  const archived = stats?.byStatus['archived'] ?? 0;
  const frozen = stats?.byStatus['frozen'] ?? 0;
  const pinnedCount = stats?.pinnedCount ?? 0;
  const coreCount = overview?.coreMemoryCount ?? 0;

  const avgConf = Math.round((stats?.avgConfidence ?? 0) * 100);
  const avgUtil = Math.round((stats?.avgUtility ?? 0) * 100);

  const dynamicBudget = overview?.dynamicBudgetTokens ?? 1600;
  const stableBudget = overview?.stableBudgetTokens ?? 600;
  const activeStratVer = overview?.activeStrategyVersion ?? 1;

  const injCount = overview?.recentTelemetry?.injectionCount ?? 0;
  const avgTokens = overview?.recentTelemetry?.avgTokens ?? 0;
  const corrRate = overview?.recentTelemetry?.correctionRate ?? 0;

  const callsToday = overview?.ledger?.callsToday ?? 0;
  const maxCalls = overview?.ledger?.maxDailyCalls ?? 40;
  const tokensToday = overview?.ledger?.tokensToday ?? 0;
  const maxTokens = overview?.ledger?.maxDailyTokens ?? 200000;

  const quotaPercent = Math.min(100, Math.round((callsToday / Math.max(1, maxCalls)) * 100));

  return (
    <div className="dshm-stats-grid">
      {/* 1. 记忆规模与状态分布 */}
      <GlassCard
        className="dshm-stat-card is-clickable"
        onClick={() => onFilterSelect?.('all', 'all')}
        title="点击查看全部记忆"
      >
        <div className="dshm-stat-top">
          <span className="dshm-stat-label">记忆库总规模</span>
          <div className="dshm-stat-icon-wrapper dshm-icon-indigo">
            <BrainIcon size={16} />
          </div>
        </div>
        <div className="dshm-stat-value-row">
          <div className="dshm-stat-value">
            {total} <span className="dshm-stat-unit">条</span>
          </div>
          {total > 0 && (
            <span className="dshm-stat-subpill" title="平均置信度与实用度">
              置信 {avgConf}% · 效用 {avgUtil}%
            </span>
          )}
        </div>
        <div className="dshm-stat-desc">
          <span
            className="dshm-stat-link"
            onClick={(e) => {
              e.stopPropagation();
              onFilterSelect?.('active', 'all');
            }}
          >
            活跃 {active}
          </span>
          <span>·</span>
          <span
            className={`dshm-stat-link ${candidate > 0 ? 'is-highlight-amber' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onFilterSelect?.('candidate', 'all');
            }}
          >
            待审 {candidate}
          </span>
          <span>·</span>
          <span
            className="dshm-stat-link"
            onClick={(e) => {
              e.stopPropagation();
              onFilterSelect?.('archived', 'all');
            }}
          >
            归档 {archived}
          </span>
        </div>
      </GlassCard>

      {/* 2. 稳定层固化与冻结保护 */}
      <GlassCard
        className="dshm-stat-card is-clickable"
        onClick={() => onFilterSelect?.('pinned', 'all')}
        title="点击筛选已置顶固化的记忆"
      >
        <div className="dshm-stat-top">
          <span className="dshm-stat-label">稳定固化 & 保护层</span>
          <div className="dshm-stat-icon-wrapper dshm-icon-amber">
            <PinIcon size={15} />
          </div>
        </div>
        <div className="dshm-stat-value-row">
          <div className="dshm-stat-value">
            {pinnedCount} <span className="dshm-stat-unit">置顶固化</span>
          </div>
          <span
            className="dshm-stat-subpill is-clickable-pill"
            onClick={(e) => {
              e.stopPropagation();
              onNavigateView?.('core');
            }}
            title="点击管理 Core Memory 核心块"
          >
            Core 块 {coreCount}
          </span>
        </div>
        <div className="dshm-stat-desc">
          <span
            className="dshm-stat-link"
            onClick={(e) => {
              e.stopPropagation();
              onFilterSelect?.('frozen', 'all');
            }}
          >
            ❄️ 冻结保护 {frozen} 条
          </span>
          <span>·</span>
          <span>预算 ≤ {stableBudget} tok</span>
        </div>
      </GlassCard>

      {/* 3. 在线快环检索与 7 日遥测 */}
      <GlassCard
        className="dshm-stat-card is-clickable"
        onClick={() => onNavigateView?.('evolution')}
        title="点击查看策略实验室与召回评测"
      >
        <div className="dshm-stat-top">
          <span className="dshm-stat-label">在线召回 (Governor v{activeStratVer})</span>
          <div className="dshm-stat-icon-wrapper dshm-icon-blue">
            <ZapIcon size={15} />
          </div>
        </div>
        <div className="dshm-stat-value-row">
          <div className="dshm-stat-value">
            {dynamicBudget} <span className="dshm-stat-unit">tokens</span>
          </div>
          <span className="dshm-stat-subpill">
            纠正率 {corrRate}%
          </span>
        </div>
        <div className="dshm-stat-desc">
          <span>7日注入 {injCount} 次</span>
          <span>·</span>
          <span>均值 {avgTokens} tok/轮</span>
        </div>
      </GlassCard>

      {/* 4. 离线慢环风控账本 */}
      <GlassCard
        className="dshm-stat-card is-clickable"
        onClick={() => onNavigateView?.('evolution')}
        title="点击查看离线任务账本与风控详情"
      >
        <div className="dshm-stat-top">
          <span className="dshm-stat-label">今日慢环风控账本</span>
          <div className="dshm-stat-icon-wrapper dshm-icon-emerald">
            <ShieldIcon size={15} />
          </div>
        </div>
        <div className="dshm-stat-value-row">
          <div className="dshm-stat-value">
            {callsToday} <span className="dshm-stat-unit">/ {maxCalls} 次</span>
          </div>
          <span className="dshm-stat-subpill">
            {quotaPercent}% 配额
          </span>
        </div>
        <div className="dshm-stat-progress">
          <div
            className={`dshm-stat-progress-bar ${quotaPercent > 80 ? 'is-danger' : 'is-safe'}`}
            style={{ width: `${quotaPercent}%` }}
          />
        </div>
        <div className="dshm-stat-desc">
          <span>
            Token 消耗 {(tokensToday / 1000).toFixed(1)}k / {(maxTokens / 1000).toFixed(0)}k
          </span>
        </div>
      </GlassCard>
    </div>
  );
};
