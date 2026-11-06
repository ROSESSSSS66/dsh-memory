import * as React from 'react';
import type { GraphDataUI, GraphNodeUI, GraphLinkUI } from '../types.js';
import { fetchGraphData } from '../api.js';
import { RefreshIcon, SearchIcon, CloseIcon, EyeIcon } from './Icons.js';

interface GraphViewProps {
  workspaceId?: string;
  onInspect: (id: string) => void;
}

interface LayoutNode extends GraphNodeUI {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
}

const TYPE_COLORS: Record<string, string> = {
  preference: '#34c759', // Apple green
  procedure: '#af52de',  // Apple purple
  fact: '#0071e3',       // Apple blue
  semantic: '#0ea5e9',   // Light blue
  entity: '#f59e0b',     // Amber
  default: '#64748b',    // Slate
};

export const GraphView: React.FC<GraphViewProps> = ({ workspaceId, onInspect }) => {
  const [data, setData] = React.useState<GraphDataUI | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [filterType, setFilterType] = React.useState<string>('all');
  const [search, setSearch] = React.useState('');
  const [hoveredNodeId, setHoveredNodeId] = React.useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null);

  // Pan & Zoom
  const [zoom, setZoom] = React.useState(1);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = React.useState(false);
  const dragStartRef = React.useRef({ x: 0, y: 0 });
  const svgRef = React.useRef<SVGSVGElement | null>(null);

  const [layoutNodes, setLayoutNodes] = React.useState<LayoutNode[]>([]);

  // Load Graph Data
  const loadGraph = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetchGraphData(workspaceId, 100);
      setData(res.graph);
    } catch (err: any) {
      setError(err?.message || '加载知识拓扑失败');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  React.useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  // Compute Force-Directed Layout
  React.useEffect(() => {
    if (!data || data.nodes.length === 0) {
      setLayoutNodes([]);
      return;
    }

    const width = 940;
    const height = 580;
    const centerX = width / 2;
    const centerY = height / 2;

    const rawNodes = data.nodes;
    const rawLinks = data.links;

    // Initialize positions in a circle
    const count = rawNodes.length;
    const nodes: LayoutNode[] = rawNodes.map((n, i) => {
      const angle = (i / count) * 2 * Math.PI;
      const rInit = 140 + Math.random() * 80;
      const isEntity = n.type === 'entity';
      const radius = isEntity ? 12 : n.pinned ? 18 : 14;
      const color = isEntity ? TYPE_COLORS.entity : TYPE_COLORS[n.type] || TYPE_COLORS.default;

      return {
        ...n,
        x: centerX + Math.cos(angle) * rInit,
        y: centerY + Math.sin(angle) * rInit,
        vx: 0,
        vy: 0,
        radius,
        color,
      };
    });

    const nodeMap = new Map<string, LayoutNode>();
    for (const n of nodes) nodeMap.set(n.id, n);

    // Iterative physics relaxation
    const iterations = 80;
    const kRepel = 3200;
    const kAttract = 0.04;
    const kGravity = 0.025;

    for (let iter = 0; iter < iterations; iter++) {
      const alpha = 1 - iter / iterations;

      // 1. Repulsion between all node pairs
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const n1 = nodes[i];
          const n2 = nodes[j];
          let dx = n1.x - n2.x;
          let dy = n1.y - n2.y;
          let distSq = dx * dx + dy * dy;
          if (distSq < 1) {
            dx = (Math.random() - 0.5) * 2;
            dy = (Math.random() - 0.5) * 2;
            distSq = 2;
          }
          const dist = Math.sqrt(distSq);
          if (dist > 350) continue; // Cutoff for speed
          const force = (kRepel / distSq) * alpha;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          n1.vx += fx;
          n1.vy += fy;
          n2.vx -= fx;
          n2.vy -= fy;
        }
      }

      // 2. Attraction along links
      for (const link of rawLinks) {
        const source = nodeMap.get(link.source);
        const target = nodeMap.get(link.target);
        if (!source || !target) continue;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const desiredDist = 90;
        const force = (dist - desiredDist) * kAttract * alpha;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        source.vx += fx;
        source.vy += fy;
        target.vx -= fx;
        target.vy -= fy;
      }

      // 3. Center gravity & update positions
      for (const n of nodes) {
        n.vx += (centerX - n.x) * kGravity * alpha;
        n.vy += (centerY - n.y) * kGravity * alpha;

        // Apply velocities with damping
        n.x += Math.max(-20, Math.min(20, n.vx * 0.4));
        n.y += Math.max(-20, Math.min(20, n.vy * 0.4));
        n.vx *= 0.5;
        n.vy *= 0.5;

        // Boundaries
        n.x = Math.max(40, Math.min(width - 40, n.x));
        n.y = Math.max(40, Math.min(height - 40, n.y));
      }
    }

    setLayoutNodes(nodes);
  }, [data]);

  // Handle Pan & Zoom
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setPan({
      x: e.clientX - dragStartRef.current.x,
      y: e.clientY - dragStartRef.current.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    setZoom((z) => Math.max(0.4, Math.min(2.5, z * zoomFactor)));
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setSelectedNodeId(null);
  };

  // Filtered nodes and connected links
  const filteredNodes = React.useMemo(() => {
    return layoutNodes.filter((n) => {
      if (filterType !== 'all') {
        if (filterType === 'entity' && n.type !== 'entity') return false;
        if (filterType !== 'entity' && n.type !== filterType) return false;
      }
      if (search) {
        return n.label.toLowerCase().includes(search.toLowerCase());
      }
      return true;
    });
  }, [layoutNodes, filterType, search]);

  const filteredNodeIds = React.useMemo(
    () => new Set(filteredNodes.map((n) => n.id)),
    [filteredNodes]
  );

  const activeHoveredNode = React.useMemo(() => {
    const targetId = hoveredNodeId || selectedNodeId;
    return layoutNodes.find((n) => n.id === targetId) || null;
  }, [layoutNodes, hoveredNodeId, selectedNodeId]);

  // Neighbors of active node
  const activeNeighbors = React.useMemo(() => {
    if (!activeHoveredNode || !data) return new Set<string>();
    const set = new Set<string>();
    set.add(activeHoveredNode.id);
    for (const l of data.links) {
      if (l.source === activeHoveredNode.id) set.add(l.target);
      if (l.target === activeHoveredNode.id) set.add(l.source);
    }
    return set;
  }, [activeHoveredNode, data]);

  const nodeMap = React.useMemo(() => {
    const map = new Map<string, LayoutNode>();
    for (const n of layoutNodes) map.set(n.id, n);
    return map;
  }, [layoutNodes]);

  return (
    <div className="dshm-graph-container">
      {/* Top Controls Toolbar */}
      <div className="dshm-graph-toolbar">
        {/* Type Filter Pills */}
        <div className="dshm-graph-pills">
          <button
            type="button"
            className={`dshm-graph-pill ${filterType === 'all' ? 'is-active' : ''}`}
            onClick={() => setFilterType('all')}
          >
            全部节点
          </button>
          <button
            type="button"
            className={`dshm-graph-pill ${filterType === 'preference' ? 'is-active' : ''}`}
            onClick={() => setFilterType('preference')}
          >
            <span className="dshm-pill-dot" style={{ background: TYPE_COLORS.preference }} />
            偏好
          </button>
          <button
            type="button"
            className={`dshm-graph-pill ${filterType === 'fact' ? 'is-active' : ''}`}
            onClick={() => setFilterType('fact')}
          >
            <span className="dshm-pill-dot" style={{ background: TYPE_COLORS.fact }} />
            事实
          </button>
          <button
            type="button"
            className={`dshm-graph-pill ${filterType === 'procedure' ? 'is-active' : ''}`}
            onClick={() => setFilterType('procedure')}
          >
            <span className="dshm-pill-dot" style={{ background: TYPE_COLORS.procedure }} />
            流程
          </button>
          <button
            type="button"
            className={`dshm-graph-pill ${filterType === 'entity' ? 'is-active' : ''}`}
            onClick={() => setFilterType('entity')}
          >
            <span className="dshm-pill-dot" style={{ background: TYPE_COLORS.entity }} />
            实体标签
          </button>
        </div>

        {/* Search inside Graph */}
        <div className="dshm-graph-search">
          <SearchIcon size={12} />
          <input
            type="text"
            placeholder="在图谱中搜索节点…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button type="button" onClick={() => setSearch('')}>
              <CloseIcon size={11} />
            </button>
          )}
        </div>

        {/* Zoom & Reset Controls */}
        <div className="dshm-graph-actions">
          <button
            type="button"
            className="dshm-graph-btn"
            onClick={() => setZoom((z) => Math.min(2.5, z * 1.2))}
            title="放大"
          >
            +
          </button>
          <button
            type="button"
            className="dshm-graph-btn"
            onClick={() => setZoom((z) => Math.max(0.4, z / 1.2))}
            title="缩小"
          >
            -
          </button>
          <button
            type="button"
            className="dshm-graph-btn"
            onClick={resetView}
            title="居中重置"
          >
            重置
          </button>
          <button
            type="button"
            className="dshm-graph-btn"
            onClick={loadGraph}
            title="刷新图谱"
          >
            <RefreshIcon size={12} />
          </button>
        </div>
      </div>

      {/* Main Graph Viewport */}
      <div
        className="dshm-graph-viewport"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
      >
        {loading && (
          <div className="dshm-graph-status">
            <div className="dshm-spin" style={{ display: 'inline-block', marginBottom: 8 }}>
              <RefreshIcon size={24} />
            </div>
            <div>正在计算图谱拓扑与引力模拟…</div>
          </div>
        )}

        {error && (
          <div className="dshm-graph-status" style={{ color: '#f87171' }}>
            {error}
          </div>
        )}

        {!loading && !error && data && (
          <svg
            ref={svgRef}
            className="dshm-graph-svg"
            viewBox="0 0 940 580"
            width="100%"
            height="100%"
          >
            <defs>
              {/* Radial gradient for glowing memory nodes */}
              <radialGradient id="grad-glow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.8" />
                <stop offset="100%" stopColor="#1e3a8a" stopOpacity="0.1" />
              </radialGradient>
              <filter id="node-shadow" x="-30%" y="-30%" width="160%" height="160%">
                <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#000000" floodOpacity="0.4" />
              </filter>
            </defs>

            <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
              {/* 1. Links Layer */}
              <g className="dshm-graph-links">
                {data.links.map((link, idx) => {
                  const s = nodeMap.get(link.source);
                  const t = nodeMap.get(link.target);
                  if (!s || !t) return null;

                  const isLinkedToActive =
                    activeHoveredNode &&
                    (link.source === activeHoveredNode.id || link.target === activeHoveredNode.id);
                  const isDimmed = activeHoveredNode && !isLinkedToActive;

                  return (
                    <g key={idx}>
                      <line
                        x1={s.x}
                        y1={s.y}
                        x2={t.x}
                        y2={t.y}
                        stroke={isLinkedToActive ? '#38bdf8' : 'var(--dsw-alias-border, #334155)'}
                        strokeWidth={isLinkedToActive ? 2 : 1}
                        strokeOpacity={isDimmed ? 0.08 : isLinkedToActive ? 0.9 : 0.25}
                        strokeDasharray={link.rel === 'mentions' ? '3 3' : undefined}
                      />
                    </g>
                  );
                })}
              </g>

              {/* 2. Nodes Layer */}
              <g className="dshm-graph-nodes">
                {layoutNodes.map((n) => {
                  const isVisible = filteredNodeIds.has(n.id);
                  const isActive = activeNeighbors.has(n.id);
                  const isDimmed = activeHoveredNode && !isActive;
                  const isEntity = n.type === 'entity';

                  return (
                    <g
                      key={n.id}
                      className={`dshm-node-group ${isDimmed ? 'is-dimmed' : ''}`}
                      transform={`translate(${n.x}, ${n.y})`}
                      style={{
                        opacity: !isVisible ? 0.15 : isDimmed ? 0.2 : 1,
                        cursor: 'pointer',
                        transition: 'opacity 0.2s ease',
                      }}
                      onMouseEnter={() => setHoveredNodeId(n.id)}
                      onMouseLeave={() => setHoveredNodeId(null)}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedNodeId(n.id);
                        if (!isEntity) {
                          onInspect(n.id);
                        }
                      }}
                    >
                      {/* Aura / Halo on hovered/pinned */}
                      {(n.pinned || activeHoveredNode?.id === n.id) && (
                        <circle
                          r={n.radius + 6}
                          fill="none"
                          stroke={n.color}
                          strokeWidth={1.5}
                          strokeOpacity={0.6}
                          strokeDasharray="4 2"
                        />
                      )}

                      {/* Main Node Shape */}
                      {isEntity ? (
                        <rect
                          x={-28}
                          y={-10}
                          width={56}
                          height={20}
                          rx={10}
                          fill="#1e293b"
                          stroke={n.color}
                          strokeWidth={1.5}
                          filter="url(#node-shadow)"
                        />
                      ) : (
                        <circle
                          r={n.radius}
                          fill="#18181b"
                          stroke={n.color}
                          strokeWidth={n.pinned ? 2.5 : 1.8}
                          filter="url(#node-shadow)"
                        />
                      )}

                      {/* Node Label Text */}
                      {isEntity ? (
                        <text
                          y={3}
                          textAnchor="middle"
                          fill="#e2e8f0"
                          fontSize={9.5}
                          fontWeight={500}
                          style={{ pointerEvents: 'none' }}
                        >
                          {n.label.slice(0, 8)}
                        </text>
                      ) : (
                        <>
                          <text
                            y={3.5}
                            textAnchor="middle"
                            fill={n.color}
                            fontSize={10}
                            fontWeight={600}
                            style={{ pointerEvents: 'none' }}
                          >
                            {n.type === 'preference'
                              ? '偏'
                              : n.type === 'procedure'
                              ? '程'
                              : n.type === 'fact'
                              ? '实'
                              : '识'}
                          </text>
                          <text
                            y={n.radius + 12}
                            textAnchor="middle"
                            fill="var(--dsw-alias-label-secondary, #94a3b8)"
                            fontSize={10}
                            style={{ pointerEvents: 'none' }}
                          >
                            {n.label.length > 12 ? n.label.slice(0, 11) + '…' : n.label}
                          </text>
                        </>
                      )}
                    </g>
                  );
                })}
              </g>
            </g>
          </svg>
        )}

        {/* Floating Node Details Card */}
        {activeHoveredNode && (
          <div className="dshm-graph-tooltip">
            <div className="dshm-tooltip-header">
              <span
                className="dshm-tag"
                style={{
                  background: `${activeHoveredNode.color}22`,
                  color: activeHoveredNode.color,
                  border: `0.5px solid ${activeHoveredNode.color}44`,
                }}
              >
                {activeHoveredNode.type === 'entity'
                  ? '实体'
                  : activeHoveredNode.type === 'preference'
                  ? '偏好'
                  : activeHoveredNode.type === 'procedure'
                  ? '流程'
                  : '事实'}
              </span>
              <span className="dshm-tooltip-conn">
                关联度: {activeHoveredNode.connections || 0}
              </span>
            </div>
            <div className="dshm-tooltip-body">{activeHoveredNode.label}</div>
            {activeHoveredNode.type !== 'entity' && (
              <div
                className="dshm-tooltip-footer"
                onClick={() => onInspect(activeHoveredNode.id)}
              >
                <EyeIcon size={12} />
                <span>点击查看详情与因果审计</span>
              </div>
            )}
          </div>
        )}

        {/* Footer Stats Legend */}
        {data && (
          <div className="dshm-graph-legend">
            <div className="dshm-legend-item">
              <span className="dshm-legend-dot" style={{ background: TYPE_COLORS.preference }} />
              <span>偏好 ({data.nodes.filter((n) => n.type === 'preference').length})</span>
            </div>
            <div className="dshm-legend-item">
              <span className="dshm-legend-dot" style={{ background: TYPE_COLORS.fact }} />
              <span>事实 ({data.nodes.filter((n) => n.type === 'fact' || n.type === 'semantic').length})</span>
            </div>
            <div className="dshm-legend-item">
              <span className="dshm-legend-dot" style={{ background: TYPE_COLORS.procedure }} />
              <span>流程 ({data.nodes.filter((n) => n.type === 'procedure').length})</span>
            </div>
            <div className="dshm-legend-item">
              <span className="dshm-legend-dot" style={{ background: TYPE_COLORS.entity }} />
              <span>实体标签 ({data.stats.entityNodes})</span>
            </div>
            <span className="dshm-legend-divider">|</span>
            <span>共 {data.stats.totalNodes} 个节点 · {data.stats.totalLinks} 条关联</span>
          </div>
        )}
      </div>
    </div>
  );
};
