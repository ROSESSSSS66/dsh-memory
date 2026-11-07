import React from 'react';
import { GlassCard, GlassBadge } from './GlassUI.js';

export interface OverviewStatsData {
  stats: {
    total: number;
    active: number;
    candidate: number;
    superseded: number;
    archived: number;
    frozen?: number;
    byType: Record<string, number>;
  };
  dynamicBudgetTokens: number;
  stableBudgetTokens?: number;
  hardBudgetTokens?: number;
  pendingRepairsCount?: number;
  activeStrategyVersion?: number;
  coreMemoryCount?: number;
  ledger: {
    callsToday: number;
    tokensToday: number;
    maxDailyCalls: number;
    maxDailyTokens: number;
  };
  recentTelemetry: {
    injectionCount: number;
    avgTokens: number;
    correctionRate: number;
  };
}

export function StatCards({ data }: { data: OverviewStatsData | null }) {
  const activeCount = data?.stats.active ?? 0;
  const candidateCount = data?.stats.candidate ?? 0;
  const supersededCount = data?.stats.superseded ?? 0;
  const totalCount = data?.stats.total ?? 0;

  const avgTokens = data?.recentTelemetry.avgTokens ?? 0;
  const budgetTokens = data?.dynamicBudgetTokens ?? 1600;
  const budgetRatio = Math.min(100, Math.round((avgTokens / Math.max(1, budgetTokens)) * 100));

  const correctionRate = data?.recentTelemetry.correctionRate ?? 0;
  const injectionCount = data?.recentTelemetry.injectionCount ?? 0;

  const callsToday = data?.ledger.callsToday ?? 0;
  const maxDailyCalls = data?.ledger.maxDailyCalls ?? 40;
  const tokensToday = data?.ledger.tokensToday ?? 0;
  const callsRatio = Math.min(100, Math.round((callsToday / Math.max(1, maxDailyCalls)) * 100));

  return (
    <section className="dshm-stats-grid" aria-label="Memory Telemetry Overview">
      {/* Card 1: Active Memories */}
      <GlassCard className="dshm-stat-card">
        <div className="dshm-stat-header">
          <span className="dshm-stat-label">活跃记忆资产 (Active)</span>
          <span
            className="dshm-stat-icon"
            style={{
              color: 'var(--dshm-accent)',
            }}
          >
            ◈
          </span>
        </div>
        <div className="dshm-stat-value-row">
          <span className="dshm-stat-value">{activeCount}</span>
          <span className="dshm-stat-unit">/ 共 {totalCount} 条</span>
        </div>
        <div className="dshm-stat-footer">
          <span>自动观察池: {candidateCount}</span>
          <span>因果演进链: {supersededCount}</span>
        </div>
      </GlassCard>

      {/* Card 2: Online Budget */}
      <GlassCard className="dshm-stat-card">
        <div className="dshm-stat-header">
          <span className="dshm-stat-label">在线注入均值 (7d)</span>
          <span
            className="dshm-stat-icon"
            style={{
              color: 'var(--dshm-cyan)',
            }}
          >
            ⚡
          </span>
        </div>
        <div className="dshm-stat-value-row">
          <span className="dshm-stat-value">{avgTokens}</span>
          <span className="dshm-stat-unit">/ {budgetTokens} tok</span>
        </div>
        <div>
          <div className="dshm-progress-track" style={{ marginBottom: 7 }}>
            <div
              className="dshm-progress-fill"
              style={{
                width: `${budgetRatio}%`,
                background: 'var(--dshm-accent)',
              }}
            />
          </div>
          <div className="dshm-stat-footer" style={{ paddingTop: 4, borderTop: 'none' }}>
            <span>累计注入 {injectionCount} 轮</span>
            <span>预算占用 {budgetRatio}%</span>
          </div>
        </div>
      </GlassCard>

      {/* Card 3: Attribution & Correction Rate */}
      <GlassCard className="dshm-stat-card">
        <div className="dshm-stat-header">
          <span className="dshm-stat-label">在线归因纠错率</span>
          <span
            className="dshm-stat-icon"
            style={{
              color: correctionRate > 12 ? 'var(--dshm-amber)' : 'var(--dshm-emerald)',
            }}
          >
            ✦
          </span>
        </div>
        <div className="dshm-stat-value-row">
          <span className="dshm-stat-value">{correctionRate}%</span>
          <GlassBadge variant={correctionRate <= 10 ? 'emerald' : 'amber'}>
            {correctionRate <= 10 ? '高信噪比' : '自愈监控中'}
          </GlassBadge>
        </div>
        <div className="dshm-stat-footer">
          <span>策略版本: v{data?.activeStrategyVersion ?? 1}</span>
          <span>自动修复流: 实时</span>
        </div>
      </GlassCard>

      {/* Card 4: Offline Evolution Ledger */}
      <GlassCard className="dshm-stat-card">
        <div className="dshm-stat-header">
          <span className="dshm-stat-label">今日后台进化配额</span>
          <span
            className="dshm-stat-icon"
            style={{
              color: 'var(--dshm-purple)',
            }}
          >
            ⟳
          </span>
        </div>
        <div className="dshm-stat-value-row">
          <span className="dshm-stat-value">{callsToday}</span>
          <span className="dshm-stat-unit">/ {maxDailyCalls} 次</span>
        </div>
        <div>
          <div className="dshm-progress-track" style={{ marginBottom: 7 }}>
            <div
              className="dshm-progress-fill"
              style={{
                width: `${callsRatio}%`,
                background: 'var(--dshm-cyan)',
              }}
            />
          </div>
          <div className="dshm-stat-footer" style={{ paddingTop: 4, borderTop: 'none' }}>
            <span>已耗 {(tokensToday / 1000).toFixed(1)}k tok</span>
            <span>零热路径阻塞</span>
          </div>
        </div>
      </GlassCard>
    </section>
  );
}
