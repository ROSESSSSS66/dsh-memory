import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { GlassCard, GlassBadge } from './GlassUI.js';

export interface GraphNodeItem {
  id: string;
  kind: 'memory' | 'entity';
  label: string;
  type?: string;
  status?: string;
  utility?: number;
  confidence?: number;
  pinned?: boolean;
  degree: number;
}

export interface GraphLinkItem {
  source: string;
  target: string;
  rel: 'supersedes' | 'contradicts' | 'derived_from' | 'related' | 'mentions';
}

export interface GraphDataPayload {
  nodes: GraphNodeItem[];
  links: GraphLinkItem[];
  stats: {
    totalNodes: number;
    memoryNodes: number;
    entityNodes: number;
    totalLinks: number;
  };
}

export interface GraphViewProps {
  apiPrefix: string;
  onSelectMemoryId?: (id: string) => void;
}

interface PositionedNode extends GraphNodeItem {
  x: number;
  y: number;
}

const NODE_COLORS: Record<string, string> = {
  semantic: '#3b6ecf',
  preference: '#9b87d5',
  procedural: '#8cbf96',
  episodic: '#d97757',
  failure: '#e06c75',
  belief: '#e2a45f',
  goal: '#8cbf96',
  entity: '#e2a45f',
};

const LINK_COLORS: Record<string, string> = {
  supersedes: '#d97757',
  contradicts: '#e06c75',
  derived_from: '#8cbf96',
  related: '#9b87d5',
  mentions: 'rgba(190, 182, 184, 0.28)',
};

function computeLayout(
  nodes: GraphNodeItem[],
  links: GraphLinkItem[],
  width: number,
  height: number
): PositionedNode[] {
  if (nodes.length === 0) return [];
  const cx = width / 2;
  const cy = height / 2;

  const pos: PositionedNode[] = nodes.map((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length;
    const radius = n.kind === 'entity' ? Math.min(width, height) * 0.24 : Math.min(width, height) * 0.36;
    return {
      ...n,
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    };
  });

  const idxMap = new Map<string, number>();
  pos.forEach((p, idx) => idxMap.set(p.id, idx));

  const iterations = 65;
  const k = Math.sqrt((width * height) / Math.max(1, pos.length)) * 0.65;

  for (let iter = 0; iter < iterations; iter++) {
    const disp = pos.map(() => ({ dx: 0, dy: 0 }));

    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        let vx = pos[i].x - pos[j].x;
        let vy = pos[i].y - pos[j].y;
        const distSq = vx * vx + vy * vy + 0.01;
        const dist = Math.sqrt(distSq);
        const force = (k * k) / dist;
        const fx = (vx / dist) * force * 0.14;
        const fy = (vy / dist) * force * 0.14;
        disp[i].dx += fx;
        disp[i].dy += fy;
        disp[j].dx -= fx;
        disp[j].dy -= fy;
      }
    }

    for (const l of links) {
      const si = idxMap.get(l.source);
      const ti = idxMap.get(l.target);
      if (si === undefined || ti === undefined) continue;
      const vx = pos[si].x - pos[ti].x;
      const vy = pos[si].y - pos[ti].y;
      const dist = Math.sqrt(vx * vx + vy * vy + 0.01);
      const force = (dist * dist) / k;
      const fx = (vx / dist) * force * 0.08;
      const fy = (vy / dist) * force * 0.08;
      disp[si].dx -= fx;
      disp[si].dy -= fy;
      disp[ti].dx += fx;
      disp[ti].dy += fy;
    }

    for (let i = 0; i < pos.length; i++) {
      disp[i].dx += (cx - pos[i].x) * 0.03;
      disp[i].dy += (cy - pos[i].y) * 0.03;

      const maxStep = 14 * (1 - iter / iterations);
      const stepLen = Math.sqrt(disp[i].dx * disp[i].dx + disp[i].dy * disp[i].dy + 0.01);
      const scale = Math.min(maxStep, stepLen) / stepLen;

      pos[i].x = Math.max(48, Math.min(width - 48, pos[i].x + disp[i].dx * scale));
      pos[i].y = Math.max(36, Math.min(height - 36, pos[i].y + disp[i].dy * scale));
    }
  }

  return pos;
}

export function GraphView({ apiPrefix, onSelectMemoryId }: GraphViewProps) {
  const [graph, setGraph] = useState<GraphDataPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [filterKind, setFilterKind] = useState<'all' | 'memory' | 'entity'>('all');

  const fetchGraph = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const res = await fetch(`${apiPrefix}/graph?limit=75`);
        const json = await res.json();
        if (json.ok) {
          setGraph(json.graph || null);
        }
      } catch {
        // ignore
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [apiPrefix]
  );

  useEffect(() => {
    fetchGraph(false);
    const timer = setInterval(() => {
      fetchGraph(true);
    }, 10000);
    return () => clearInterval(timer);
  }, [fetchGraph]);

  const filteredData = useMemo(() => {
    if (!graph) return { nodes: [], links: [] };
    const nodes =
      filterKind === 'all'
        ? graph.nodes
        : graph.nodes.filter((n) => n.kind === filterKind);
    const nodeIds = new Set(nodes.map((n) => n.id));
    const links = graph.links.filter(
      (l) => nodeIds.has(l.source) && nodeIds.has(l.target)
    );
    return { nodes, links };
  }, [graph, filterKind]);

  const positioned = useMemo(
    () => computeLayout(filteredData.nodes, filteredData.links, 860, 480),
    [filteredData]
  );

  const posMap = useMemo(() => {
    const m = new Map<string, PositionedNode>();
    for (const p of positioned) m.set(p.id, p);
    return m;
  }, [positioned]);

  const activeFocusId = hoverNodeId || selectedNodeId;
  const neighborSet = useMemo(() => {
    const s = new Set<string>();
    if (!activeFocusId) return s;
    s.add(activeFocusId);
    for (const l of filteredData.links) {
      if (l.source === activeFocusId) s.add(l.target);
      if (l.target === activeFocusId) s.add(l.source);
    }
    return s;
  }, [activeFocusId, filteredData.links]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Top Header */}
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
                记忆-实体知识图谱拓扑 (A-Mem Zettelkasten & Causal Topology)
              </h3>
              <GlassBadge variant="accent">
                {graph?.stats.memoryNodes ?? 0} 记忆节点
              </GlassBadge>
              <GlassBadge variant="amber">
                {graph?.stats.entityNodes ?? 0} 实体枢纽
              </GlassBadge>
              <GlassBadge variant="purple">
                {graph?.stats.totalLinks ?? 0} 关系边
              </GlassBadge>
            </div>
            <p
              style={{
                margin: '4px 0 0',
                fontSize: 12,
                color: 'var(--dshm-text-secondary)',
              }}
            >
              后台 A-Mem 引擎自动织网，可视化展示记忆间的演化取代 (`supersedes`)、冲突
              (`contradicts`)、语义双链 (`related`) 以及代码实体 (`mentions`)。点击记忆节点可直达溯源详情。
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="dshm-segmented">
              {(
                [
                  ['all', '全部节点'],
                  ['memory', '仅记忆演化'],
                  ['entity', '仅实体枢纽'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  className={`dshm-segment-btn ${
                    filterKind === k ? 'dshm-segment-btn--active' : ''
                  }`}
                  onClick={() => setFilterKind(k)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </GlassCard>

      {/* Interactive SVG Canvas */}
      <GlassCard style={{ padding: '14px', position: 'relative', overflow: 'hidden' }}>
        {loading && !graph ? (
          <div className="dshm-empty" style={{ height: 420, justifyContent: 'center' }}>
            <div style={{ color: 'var(--dshm-text-secondary)', fontSize: 13 }}>
              正在构建力导向知识图谱拓扑...
            </div>
          </div>
        ) : positioned.length === 0 ? (
          <div className="dshm-empty" style={{ height: 360, justifyContent: 'center' }}>
            <div className="dshm-empty-icon">🕸️</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>暂无知识图谱节点</div>
            <div className="dshm-hint">
              在对话中全自动捕获记忆并关联实体后，这里将自动生成交互式拓扑图。
            </div>
          </div>
        ) : (
          <>
            <svg
              viewBox="0 0 860 480"
              onClick={() => setSelectedNodeId(null)}
              style={{
                width: '100%',
                height: 460,
                display: 'block',
                borderRadius: 10,
                background: 'var(--dsh-claude-inset)',
                border: '1px solid var(--dshm-glass-border)',
              }}
            >
              <defs>
                <marker
                  id="dshm-arrow"
                  viewBox="0 0 10 10"
                  refX="18"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(190, 182, 184, 0.45)" />
                </marker>
              </defs>

              {/* Edges */}
              {filteredData.links.map((link, idx) => {
                const s = posMap.get(link.source);
                const t = posMap.get(link.target);
                if (!s || !t) return null;
                const isHighlighted =
                  !activeFocusId ||
                  (neighborSet.has(link.source) && neighborSet.has(link.target));
                const stroke = LINK_COLORS[link.rel] || 'rgba(190, 182, 184, 0.25)';

                return (
                  <line
                    key={idx}
                    x1={s.x}
                    y1={s.y}
                    x2={t.x}
                    y2={t.y}
                    stroke={stroke}
                    strokeWidth={link.rel === 'mentions' ? 1.1 : 1.8}
                    strokeDasharray={link.rel === 'contradicts' ? '4 3' : undefined}
                    opacity={isHighlighted ? 0.85 : 0.14}
                    markerEnd={link.rel !== 'mentions' ? 'url(#dshm-arrow)' : undefined}
                  />
                );
              })}

              {/* Nodes */}
              {positioned.map((node) => {
                const isFocused = activeFocusId === node.id;
                const isNeighbor = !activeFocusId || neighborSet.has(node.id);
                const color =
                  node.kind === 'entity'
                    ? NODE_COLORS.entity
                    : NODE_COLORS[node.type || 'semantic'] || '#3b6ecf';
                const r =
                  node.kind === 'entity'
                    ? Math.min(14, 7 + node.degree * 1.2)
                    : Math.min(16, 8 + (node.utility ?? 0.5) * 6);

                return (
                  <g
                    key={node.id}
                    transform={`translate(${node.x}, ${node.y})`}
                    style={{
                      cursor: 'pointer',
                      opacity: isNeighbor ? 1 : 0.22,
                      transition: 'opacity 0.18s ease',
                    }}
                    onMouseEnter={() => setHoverNodeId(node.id)}
                    onMouseLeave={() => setHoverNodeId(null)}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
                      if (node.kind === 'memory' && onSelectMemoryId) {
                        onSelectMemoryId(node.id);
                      }
                    }}
                  >
                    {isFocused && (
                      <circle r={r + 6} fill="none" stroke={color} strokeWidth={1.6} opacity={0.6} />
                    )}
                    <circle
                      r={r}
                      fill={color}
                      stroke={node.pinned ? '#e2a45f' : 'rgba(255,255,255,0.75)'}
                      strokeWidth={node.pinned ? 2.2 : 1.2}
                    />
                    <text
                      y={r + 13}
                      textAnchor="middle"
                      fill="var(--dshm-text-primary)"
                      fontSize="10.5"
                      fontWeight={isFocused ? '600' : '500'}
                      style={{
                        pointerEvents: 'none',
                      }}
                    >
                      {node.label.length > 18 ? `${node.label.slice(0, 18)}…` : node.label}
                    </text>
                  </g>
                );
              })}
            </svg>

            {/* Legend Bar */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 10,
                marginTop: 12,
                padding: '4px 6px 0',
                fontSize: 11.5,
                color: 'var(--dshm-text-muted)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <span>
                  <strong style={{ color: '#3b6ecf' }}>●</strong> 事实 Semantic
                </span>
                <span>
                  <strong style={{ color: '#9b87d5' }}>●</strong> 偏好 Preference
                </span>
                <span>
                  <strong style={{ color: '#8cbf96' }}>●</strong> 流程 Procedural
                </span>
                <span>
                  <strong style={{ color: '#e06c75' }}>●</strong> 教训 Failure
                </span>
                <span>
                  <strong style={{ color: '#e2a45f' }}>◆</strong> 代码实体 Entity
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span>
                  <strong style={{ color: '#d97757' }}>──▶</strong> supersedes 取代
                </span>
                <span>
                  <strong style={{ color: '#8cbf96' }}>──▶</strong> derived 整合派生
                </span>
                <span>
                  <strong style={{ color: '#9b87d5' }}>──▶</strong> related A-Mem 双链
                </span>
                <span>
                  <strong style={{ color: '#e06c75' }}>- - ▶</strong> contradicts 冲突
                </span>
              </div>
            </div>
          </>
        )}
      </GlassCard>
    </div>
  );
}
