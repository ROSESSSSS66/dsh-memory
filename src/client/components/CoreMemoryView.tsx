import React, { useState, useEffect, useCallback } from 'react';
import { GlassCard, GlassBadge } from './GlassUI.js';

export interface CoreMemoryBlock {
  block: string;
  id: string;
  content: string;
  updatedAt: number;
  version: number;
  tokens: number;
}

export interface CoreMemoryViewProps {
  apiPrefix: string;
  onNotify?: (msg: string) => void;
}

const BLOCK_META: Record<
  string,
  {
    title: string;
    subtitle: string;
    badge: 'accent' | 'purple' | 'emerald' | 'cyan';
    icon: string;
  }
> = {
  human: {
    title: 'Human · 用户画像与开发习惯',
    subtitle: '由智能体在会话中自动提炼并实时同步的开发者身份、技术栈偏好与沟通风格',
    badge: 'cyan',
    icon: '◉',
  },
  persona: {
    title: 'Persona · 智能体行为准则',
    subtitle: '常驻系统提示词的协作规范、回复语气、安全红线与工程纪律',
    badge: 'purple',
    icon: '✦',
  },
  project: {
    title: 'Project · 架构规范与核心上下文',
    subtitle: '自动从仓库元数据与对话历史提炼的技术栈、目录约定与强制约束',
    badge: 'emerald',
    icon: '◈',
  },
};

export function CoreMemoryView({ apiPrefix }: CoreMemoryViewProps) {
  const [blocks, setBlocks] = useState<CoreMemoryBlock[]>([]);
  const [totalTokens, setTotalTokens] = useState(0);
  const [stableBudget, setStableBudget] = useState(600);
  const [loading, setLoading] = useState(false);

  const fetchCore = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`${apiPrefix}/core`);
      const json = await res.json();
      if (json.ok) {
        setBlocks(json.blocks || []);
        setTotalTokens(json.totalTokens || 0);
        setStableBudget(json.stableBudgetTokens || 600);
      }
    } catch {
      // ignore network error
    } finally {
      if (!silent) setLoading(false);
    }
  }, [apiPrefix]);

  useEffect(() => {
    fetchCore(false);
    const timer = setInterval(() => {
      fetchCore(true);
    }, 8000);
    return () => clearInterval(timer);
  }, [fetchCore]);

  const budgetPct = Math.min(100, Math.round((totalTokens / Math.max(1, stableBudget)) * 100));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Top Banner */}
      <GlassCard style={{ padding: '16px 20px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h3
                style={{
                  margin: 0,
                  fontFamily: 'var(--dsh-claude-font-serif)',
                  fontSize: 15.5,
                  fontWeight: 600,
                }}
              >
                Core Memory 常驻核心工作区 (Letta Autonomous Self-Sync)
              </h3>
              <GlassBadge variant="accent">System Prompt Stable Layer</GlassBadge>
              <GlassBadge variant="emerald">Agent 自动维护</GlassBadge>
            </div>
            <p
              style={{
                margin: '5px 0 0',
                fontSize: 12,
                color: 'var(--dshm-text-secondary)',
              }}
            >
              此区域的记忆块拥有最高优先级，常驻注入每一轮对话的稳定层，无需检索即可被模型感知，并由智能体在对话过程中通过{' '}
              <code style={{ color: 'var(--dshm-accent)' }}>memory_core</code> 自动演进更新。
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 11, color: 'var(--dshm-text-muted)' }}>
                稳定层预算水位 (Stable Budget)
              </div>
              <div
                style={{
                  fontSize: 13.5,
                  fontWeight: 600,
                  fontFamily: 'var(--dsh-claude-font-code)',
                  fontVariantNumeric: 'tabular-nums',
                  color: budgetPct > 85 ? 'var(--dshm-amber)' : 'var(--dshm-emerald)',
                }}
              >
                {totalTokens} / {stableBudget} tok ({budgetPct}%)
              </div>
            </div>
          </div>
        </div>
      </GlassCard>

      {loading && blocks.length === 0 ? (
        <GlassCard className="dshm-empty">
          <div style={{ color: 'var(--dshm-text-secondary)', fontSize: 13 }}>
            正在同步 Core Memory 常驻块...
          </div>
        </GlassCard>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
            gap: 12,
          }}
        >
          {blocks.map((item) => {
            const meta = BLOCK_META[item.block] || {
              title: `Core Block · ${item.block}`,
              subtitle: '自定义常驻核心记忆块',
              badge: 'accent' as const,
              icon: '◈',
            };

            return (
              <GlassCard
                key={item.block}
                style={{
                  padding: '16px 18px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        style={{
                          fontSize: 15,
                          color: 'var(--dshm-accent)',
                        }}
                      >
                        {meta.icon}
                      </span>
                      <span style={{ fontSize: 13.5, fontWeight: 600 }}>{meta.title}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <GlassBadge variant={meta.badge}>{item.tokens} tok</GlassBadge>
                      {item.version > 0 && (
                        <GlassBadge variant="neutral">v{item.version}</GlassBadge>
                      )}
                    </div>
                  </div>
                  <p
                    style={{
                      margin: '5px 0 10px',
                      fontSize: 11.5,
                      color: 'var(--dshm-text-muted)',
                      lineHeight: 1.45,
                    }}
                  >
                    {meta.subtitle}
                  </p>

                  <div
                    className="dshm-code-box"
                    style={{
                      minHeight: 108,
                      fontSize: 12.5,
                      color: item.content
                        ? 'var(--dshm-text-primary)'
                        : 'var(--dshm-text-muted)',
                    }}
                  >
                    {item.content || '（尚未捕获，智能体将在对话与自动冷启动中自动提炼填充）'}
                  </div>
                </div>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    paddingTop: 8,
                    borderTop: '0.5px solid var(--dsh-claude-divider)',
                  }}
                >
                  <span style={{ fontSize: 11, color: 'var(--dshm-text-muted)' }}>
                    {item.updatedAt
                      ? `自动同步于 ${new Date(item.updatedAt).toLocaleString()}`
                      : '等待智能体首次同步'}
                  </span>
                  <GlassBadge variant="emerald">● 常驻生效</GlassBadge>
                </div>
              </GlassCard>
            );
          })}
        </div>
      )}
    </div>
  );
}
