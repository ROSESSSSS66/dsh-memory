import * as React from 'react';
import type { OverviewResponse } from '../types.js';
import { BrainIcon, PinIcon, ZapIcon, ShieldIcon } from './Icons.js';

interface StatCardsProps {
  overview: OverviewResponse | null;
  onFilterSelect?: (status: string, type?: string) => void;
}

export const StatCards: React.FC<StatCardsProps> = ({ overview, onFilterSelect }) => {
  const stats = overview?.stats;
  const total = stats?.total ?? 0;
  const active = stats?.byStatus['active'] ?? 0;
  const candidate = stats?.byStatus['candidate'] ?? 0;
  const archived = stats?.byStatus['archived'] ?? 0;
  const frozen = stats?.byStatus['frozen'] ?? 0;

  const dynamicBudget = overview?.dynamicBudgetTokens ?? 1600;
  const callsToday = overview?.ledger?.callsToday ?? 0;
  const maxCalls = overview?.ledger?.maxDailyCalls ?? 40;
  const tokensToday = overview?.ledger?.tokensToday ?? 0;
  const maxTokens = overview?.ledger?.maxDailyTokens ?? 200000;

  const quotaPercent = Math.min(100, Math.round((callsToday / maxCalls) * 100));

  return (
    <div className="dshm-stats-grid">
      {/* 1. 总量统计 */}
      <div
        className="dshm-stat-card is-clickable"
        onClick={() => onFilterSelect?.('all', 'all')}
        title="点击查看全部记忆"
      >
        <div className="dshm-stat-top">
          <span className="dshm-stat-label">记忆规模</span>
          <div className="dshm-stat-icon-wrapper dshm-icon-indigo">
            <BrainIcon size={16} />
          </div>
        </div>
        <div className="dshm-stat-value">{total}</div>
        <div className="dshm-stat-desc">
          <span
            className="dshm-stat-link"
            onClick={(e) => {
              e.stopPropagation();
              onFilterSelect?.('active');
            }}
          >
            活跃 {active}
          </span>
          <span>·</span>
          <span
            className="dshm-stat-link"
            style={{ color: candidate > 0 ? '#f59e0b' : undefined }}
            onClick={(e) => {
              e.stopPropagation();
              onFilterSelect?.('candidate');
            }}
          >
            待审 {candidate}
          </span>
          <span>·</span>
          <span
            className="dshm-stat-link"
            onClick={(e) => {
              e.stopPropagation();
              onFilterSelect?.('archived');
            }}
          >
            归档 {archived}
          </span>
        </div>
      </div>

      {/* 2. 核心状态分布 */}
      <div
        className="dshm-stat-card is-clickable"
        onClick={() => onFilterSelect?.('pinned')}
        title="点击筛选已固化置顶项"
      >
        <div className="dshm-stat-top">
          <span className="dshm-stat-label">知识固化 & 保护</span>
          <div className="dshm-stat-icon-wrapper dshm-icon-amber">
            <PinIcon size={15} />
          </div>
        </div>
        <div className="dshm-stat-value">
          {active} <span className="dshm-stat-unit">条活跃</span>
        </div>
        <div className="dshm-stat-desc">
          <span>{frozen > 0 ? `冻结保护 ${frozen} 条` : '稳定固化 System Prompt'}</span>
        </div>
      </div>

      {/* 3. 动态检索装箱限额 */}
      <div className="dshm-stat-card">
        <div className="dshm-stat-top">
          <span className="dshm-stat-label">动态限额 (Governor)</span>
          <div className="dshm-stat-icon-wrapper dshm-icon-blue">
            <ZapIcon size={15} />
          </div>
        </div>
        <div className="dshm-stat-value">
          {dynamicBudget} <span className="dshm-stat-unit">tokens</span>
        </div>
        <div className="dshm-stat-desc">
          <span>动态装箱 · 0.6ms 本地检索</span>
        </div>
      </div>

      {/* 4. 离线慢环风控账本 */}
      <div className="dshm-stat-card">
        <div className="dshm-stat-top">
          <span className="dshm-stat-label">离线调用账本</span>
          <div className="dshm-stat-icon-wrapper dshm-icon-emerald">
            <ShieldIcon size={15} />
          </div>
        </div>
        <div className="dshm-stat-value">
          {callsToday} <span className="dshm-stat-unit">/ {maxCalls} 次</span>
        </div>
        <div className="dshm-stat-progress">
          <div
            className="dshm-stat-progress-bar"
            style={{
              width: `${quotaPercent}%`,
              backgroundColor: quotaPercent > 80 ? '#f43f5e' : '#10b981',
            }}
          />
        </div>
        <div className="dshm-stat-desc">
          <span>已用 {(tokensToday / 1000).toFixed(1)}k / {(maxTokens / 1000).toFixed(0)}k tokens</span>
        </div>
      </div>
    </div>
  );
};
