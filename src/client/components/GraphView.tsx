import * as React from 'react';
import {
  getMemoryTypeMeta,
  type GraphDataUI,
  type GraphNodeUI,
} from '../types.js';
import { fetchGraphData } from '../api.js';
import { RefreshIcon, SearchIcon, CloseIcon, EyeIcon, CopyIcon } from './Icons.js';

interface GraphViewProps {
  workspaceId?: string;
  onInspect: (id: string) => void;
  onToast?: (msg: string) => void;
}

interface LayoutNode extends GraphNodeUI {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  effectiveType: string;
  typeLabel: string;
  shortChar: string;
}

const ENTITY_COLOR = '#f59e0b';

const REL_LABELS: Record<string, string> = {
  supersedes: '迭代替换',
  derived_from: '衍生提炼',
  contradicts: '矛盾冲突',
  related: '语义关联',
  mentions: '提及实体',
};

function resolveNodeMeta(n: GraphNodeUI) {
  if (n.type === 'entity') {
    return {
      effectiveType: 'entity',
      typeLabel: '实体标签',
      shortChar: '@',
      color: ENTITY_COLOR,
    };
  }
  const rawType = n.memoryType || n.type;
  const meta = getMemoryTypeMeta(rawType);
  return {
    effectiveType: meta.key,
    typeLabel: meta.label,
    shortChar: meta.shortLabel,
    color: meta.color,
  };
}

export const GraphView: React.FC<GraphViewProps> = ({
  workspaceId,
  onInspect,
  onToast,
}) => {
  const [data, setData] = React.useState<GraphDataUI | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [filterType, setFilterType] = React.useState<string>('all');
  const [search, setSearch] = React.useState('');
  const [hoveredNodeId, setHoveredNodeId] = React.useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null);

  // Canvas Pan & Zoom
  const [zoom, setZoom] = React.useState(1);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = React.useState(false);
  const panStartRef = React.useRef({ x: 0, y: 0 });

  // Single Node Dragging
  const [draggingNodeId, setDraggingNodeId] = React.useState<string | null>(null);
  const nodeDragMovedRef = React.useRef(false);

  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const [layoutNodes, setLayoutNodes] = React.useState<LayoutNode[]>([]);

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

    const width = 960;
    const height = 580;
    const centerX = width / 2;
    const centerY = height / 2;

    const rawNodes = data.nodes;
    const rawLinks = data.links;

    const count = rawNodes.length;
    const nodes: LayoutNode[] = rawNodes.map((n, i) => {
      const angle = (i / Math.max(1, count)) * 2 * Math.PI;
      const ringRadius = n.pinned ? 80 + (i % 3) * 30 : 150 + (i % 5) * 32;
      const meta = resolveNodeMeta(n);
      const isEntity = meta.effectiveType === 'entity';
      const connBonus = Math.min(6, (n.connections || 0) * 1.2);
      const radius = isEntity ? 13 : (n.pinned ? 18 : 14) + connBonus * 0.5;

      return {
        ...n,
        x: centerX + Math.cos(angle) * ringRadius,
        y: centerY + Math.sin(angle) * ringRadius,
        vx: 0,
        vy: 0,
        radius,
        color: meta.color,
        effectiveType: meta.effectiveType,
        typeLabel: meta.typeLabel,
        shortChar: meta.shortChar,
      };
    });

    const nodeMap = new Map<string, LayoutNode>();
    for (const n of nodes) nodeMap.set(n.id, n);

    const iterations = 90;
    const kRepel = 3600;
    const kAttract = 0.045;
    const kGravity = 0.025;

    for (let iter = 0; iter < iterations; iter++) {
      const alpha = 1 - iter / iterations;

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
          if (dist > 360) continue;
          const force = (kRepel / distSq) * alpha;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          n1.vx += fx;
          n1.vy += fy;
          n2.vx -= fx;
          n2.vy -= fy;
        }
      }

      for (const link of rawLinks) {
        const source = nodeMap.get(link.source);
        const target = nodeMap.get(link.target);
        if (!source || !target) continue;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const desiredDist = 96;
        const force = (dist - desiredDist) * kAttract * alpha;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        source.vx += fx;
        source.vy += fy;
        target.vx -= fx;
        target.vy -= fy;
      }

      for (const n of nodes) {
        n.vx += (centerX - n.x) * kGravity * alpha;
        n.vy += (centerY - n.y) * kGravity * alpha;

        n.x += Math.max(-20, Math.min(20, n.vx * 0.4));
        n.y += Math.max(-20, Math.min(20, n.vy * 0.4));
        n.vx *= 0.5;
        n.vy *= 0.5;

        n.x = Math.max(48, Math.min(width - 48, n.x));
        n.y = Math.max(48, Math.min(height - 48, n.y));
      }
    }

    setLayoutNodes(nodes);
  }, [data]);

  // Pan & Node Drag Handlers
  const handleViewportMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsPanning(true);
    panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };

  const handleViewportMouseMove = (e: React.MouseEvent) => {
    if (draggingNodeId && svgRef.current) {
      nodeDragMovedRef.current = true;
      const rect = svgRef.current.getBoundingClientRect();
      const scaleX = 960 / Math.max(1, rect.width);
      const scaleY = 580 / Math.max(1, rect.height);
      const svgX = ((e.clientX - rect.left) * scaleX - pan.x) / zoom;
      const svgY = ((e.clientY - rect.top) * scaleY - pan.y) / zoom;

      setLayoutNodes((prev) =>
        prev.map((n) =>
          n.id === draggingNodeId
            ? {
                ...n,
                x: Math.max(30, Math.min(930, svgX)),
                y: Math.max(30, Math.min(550, svgY)),
              }
            : n
        )
      );
      return;
    }

    if (isPanning) {
      setPan({
        x: e.clientX - panStartRef.current.x,
        y: e.clientY - panStartRef.current.y,
      });
    }
  };

  const handleViewportMouseUp = () => {
    setIsPanning(false);
    setDraggingNodeId(null);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.12 : 0.9;
    setZoom((z) => Math.max(0.35, Math.min(2.8, z * zoomFactor)));
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setSelectedNodeId(null);
  };

  // Filtered nodes
  const filteredNodes = React.useMemo(() => {
    return layoutNodes.filter((n) => {
      if (filterType !== 'all') {
        if (filterType === 'experience') {
          if (!['episodic', 'failure', 'belief', 'goal'].includes(n.effectiveType)) {
            return false;
          }
        } else if (n.effectiveType !== filterType) {
          return false;
        }
      }
      if (search) {
        return (
          n.label.toLowerCase().includes(search.toLowerCase()) ||
          n.id.toLowerCase().includes(search.toLowerCase())
        );
      }
      return true;
    });
  }, [layoutNodes, filterType, search]);

  const filteredNodeIds = React.useMemo(
    () => new Set(filteredNodes.map((n) => n.id)),
    [filteredNodes]
  );

  const activeNode = React.useMemo(() => {
    const targetId = hoveredNodeId || selectedNodeId;
    return layoutNodes.find((n) => n.id === targetId) || null;
  }, [layoutNodes, hoveredNodeId, selectedNodeId]);

  const selectedNode = React.useMemo(
    () => layoutNodes.find((n) => n.id === selectedNodeId) || null,
    [layoutNodes, selectedNodeId]
  );

  // Connected neighbors of activeNode
  const activeNeighbors = React.useMemo(() => {
    if (!activeNode || !data) return new Set<string>();
    const set = new Set<string>([activeNode.id]);
    for (const l of data.links) {
      if (l.source === activeNode.id) set.add(l.target);
      if (l.target === activeNode.id) set.add(l.source);
    }
    return set;
  }, [activeNode, data]);

  const nodeMap = React.useMemo(() => {
    const map = new Map<string, LayoutNode>();
    for (const n of layoutNodes) map.set(n.id, n);
    return map;
  }, [layoutNodes]);

  // Type counts for legend and pills
  const typeCounts = React.useMemo(() => {
    const counts = {
      all: layoutNodes.length,
      preference: 0,
      semantic: 0,
      procedural: 0,
      experience: 0,
      entity: 0,
    };
    for (const n of layoutNodes) {
      if (n.effectiveType === 'preference') counts.preference++;
      else if (n.effectiveType === 'semantic') counts.semantic++;
      else if (n.effectiveType === 'procedural') counts.procedural++;
      else if (n.effectiveType === 'entity') counts.entity++;
      else counts.experience++;
    }
    return counts;
  }, [layoutNodes]);

  const handleCopyMermaid = () => {
    if (!data || data.nodes.length === 0) return;
    const lines = ['flowchart TD'];
    for (const n of layoutNodes.slice(0, 30)) {
      const safeId = n.id.replace(/[^a-zA-Z0-9_]/g, '_');
      const cleanLabel = n.label.replace(/["()[\]{}<>]/g, ' ').trim();
      lines.push(`  ${safeId}["${cleanLabel}"]`);
    }
    for (const l of data.links.slice(0, 45)) {
      const s = l.source.replace(/[^a-zA-Z0-9_]/g, '_');
      const t = l.target.replace(/[^a-zA-Z0-9_]/g, '_');
      lines.push(`  ${s} -->|${l.rel}| ${t}`);
    }
    const md = '```mermaid\n' + lines.join('\n') + '\n```';
    navigator.clipboard
      .writeText(md)
      .then(() => onToast?.('已复制 Mermaid 拓扑图代码至剪贴板！'));
  };

  // Connected links for selected node inspector
  const selectedNodeLinks = React.useMemo(() => {
    if (!selectedNode || !data) return [];
    return data.links
      .filter((l) => l.source === selectedNode.id || l.target === selectedNode.id)
      .map((l) => {
        const otherId = l.source === selectedNode.id ? l.target : l.source;
        const otherNode = nodeMap.get(otherId);
        return {
          rel: l.rel,
          direction: l.source === selectedNode.id ? 'out' : 'in',
          otherId,
          otherNode,
        };
      });
  }, [selectedNode, data, nodeMap]);

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
            <span>全部节点</span>
            <span className="dshm-tab-badge">{typeCounts.all}</span>
          </button>
          <button
            type="button"
            className={`dshm-graph-pill ${filterType === 'preference' ? 'is-active' : ''}`}
            onClick={() => setFilterType('preference')}
          >
            <span className="dshm-pill-dot" style={{ background: '#a855f7' }} />
            <span>偏好 ({typeCounts.preference})</span>
          </button>
          <button
            type="button"
            className={`dshm-graph-pill ${filterType === 'semantic' ? 'is-active' : ''}`}
            onClick={() => setFilterType('semantic')}
          >
            <span className="dshm-pill-dot" style={{ background: '#10b981' }} />
            <span>事实 ({typeCounts.semantic})</span>
          </button>
          <button
            type="button"
            className={`dshm-graph-pill ${filterType === 'procedural' ? 'is-active' : ''}`}
            onClick={() => setFilterType('procedural')}
          >
            <span className="dshm-pill-dot" style={{ background: '#38bdf8' }} />
            <span>流程 ({typeCounts.procedural})</span>
          </button>
          {typeCounts.experience > 0 && (
            <button
              type="button"
              className={`dshm-graph-pill ${filterType === 'experience' ? 'is-active' : ''}`}
              onClick={() => setFilterType('experience')}
            >
              <span className="dshm-pill-dot" style={{ background: '#f43f5e' }} />
              <span>情景/反思 ({typeCounts.experience})</span>
            </button>
          )}
          <button
            type="button"
            className={`dshm-graph-pill ${filterType === 'entity' ? 'is-active' : ''}`}
            onClick={() => setFilterType('entity')}
          >
            <span className="dshm-pill-dot" style={{ background: ENTITY_COLOR }} />
            <span>实体标签 ({typeCounts.entity})</span>
          </button>
        </div>

        <div className="dshm-graph-right-controls">
          {/* Search inside Graph */}
          <div className="dshm-graph-search">
            <SearchIcon size={12} />
            <input
              type="text"
              placeholder="过滤图谱节点…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button type="button" onClick={() => setSearch('')}>
                <CloseIcon size={11} />
              </button>
            )}
          </div>

          {/* Zoom & Export Controls */}
          <div className="dshm-graph-actions">
            <button
              type="button"
              className="dshm-graph-btn"
              onClick={() => setZoom((z) => Math.min(2.8, z * 1.2))}
              title="放大视图"
            >
              +
            </button>
            <button
              type="button"
              className="dshm-graph-btn"
              onClick={() => setZoom((z) => Math.max(0.35, z / 1.2))}
              title="缩小视图"
            >
              −
            </button>
            <button
              type="button"
              className="dshm-graph-btn is-wide"
              onClick={resetView}
              title="重置缩放与居中"
            >
              居中
            </button>
            <button
              type="button"
              className="dshm-graph-btn is-wide"
              onClick={handleCopyMermaid}
              title="复制 Mermaid 拓扑流程图代码"
            >
              <CopyIcon size={11} />
              <span>Mermaid</span>
            </button>
            <button
              type="button"
              className="dshm-graph-btn"
              onClick={loadGraph}
              title="重新计算引力布局"
            >
              <RefreshIcon size={12} />
            </button>
          </div>
        </div>
      </div>

      {/* Main Graph Viewport */}
      <div
        className="dshm-graph-viewport"
        onMouseDown={handleViewportMouseDown}
        onMouseMove={handleViewportMouseMove}
        onMouseUp={handleViewportMouseUp}
        onMouseLeave={handleViewportMouseUp}
        onWheel={handleWheel}
        onClick={() => {
          if (!nodeDragMovedRef.current) {
            setSelectedNodeId(null);
          }
        }}
        style={{
          cursor: draggingNodeId ? 'grabbing' : isPanning ? 'grabbing' : 'grab',
        }}
      >
        {loading && (
          <div className="dshm-graph-status">
            <div className="dshm-spin" style={{ display: 'inline-block', marginBottom: 8 }}>
              <RefreshIcon size={24} />
            </div>
            <div>正在构建知识拓扑与多体引力场…</div>
          </div>
        )}

        {error && <div className="dshm-graph-status is-error">{error}</div>}

        {!loading && !error && data && data.nodes.length === 0 && (
          <div className="dshm-graph-status">
            暂无知识图谱节点，记录记忆或提炼实体后将自动生成关联网络。
          </div>
        )}

        {!loading && !error && data && data.nodes.length > 0 && (
          <svg
            ref={svgRef}
            className="dshm-graph-svg"
            viewBox="0 0 960 580"
            width="100%"
            height="100%"
          >
            <defs>
              <filter id="node-shadow" x="-30%" y="-30%" width="160%" height="160%">
                <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#000000" floodOpacity="0.35" />
              </filter>
              <marker
                id="arrow-rel"
                viewBox="0 0 10 10"
                refX="22"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--dshm-brand, #4d6bfe)" fillOpacity="0.85" />
              </marker>
            </defs>

            <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
              {/* 1. Links Layer */}
              <g className="dshm-graph-links">
                {data.links.map((link, idx) => {
                  const s = nodeMap.get(link.source);
                  const t = nodeMap.get(link.target);
                  if (!s || !t) return null;

                  const isLinkedToActive =
                    activeNode &&
                    (link.source === activeNode.id || link.target === activeNode.id);
                  const isDimmed = activeNode && !isLinkedToActive;
                  const midX = (s.x + t.x) / 2;
                  const midY = (s.y + t.y) / 2;

                  return (
                    <g key={idx}>
                      <line
                        x1={s.x}
                        y1={s.y}
                        x2={t.x}
                        y2={t.y}
                        stroke={
                          isLinkedToActive
                            ? link.rel === 'contradicts'
                              ? 'var(--dshm-danger, #ef4444)'
                              : 'var(--dshm-brand, #4d6bfe)'
                            : 'var(--dshm-border-strong, rgba(148, 163, 184, 0.35))'
                        }
                        strokeWidth={isLinkedToActive ? 2 : 1.1}
                        strokeOpacity={isDimmed ? 0.1 : isLinkedToActive ? 0.92 : 0.45}
                        strokeDasharray={link.rel === 'mentions' ? '3 3' : undefined}
                      />
                      {isLinkedToActive && link.rel !== 'mentions' && (
                        <text
                          x={midX}
                          y={midY - 4}
                          textAnchor="middle"
                          fill="var(--dshm-brand-text, #748dff)"
                          fontSize={8.5}
                          fontWeight={500}
                          style={{ pointerEvents: 'none' }}
                        >
                          {REL_LABELS[link.rel] || link.rel}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>

              {/* 2. Nodes Layer */}
              <g className="dshm-graph-nodes">
                {layoutNodes.map((n) => {
                  const isVisible = filteredNodeIds.has(n.id);
                  const isActive = activeNeighbors.has(n.id);
                  const isSelected = selectedNodeId === n.id;
                  const isDimmed = activeNode && !isActive;
                  const isEntity = n.effectiveType === 'entity';
                  const cleanText = n.label.replace(/^\[[A-Z]+\]\s*/, '');

                  return (
                    <g
                      key={n.id}
                      className={`dshm-node-group ${isDimmed ? 'is-dimmed' : ''}`}
                      transform={`translate(${n.x}, ${n.y})`}
                      style={{
                        opacity: !isVisible ? 0.12 : isDimmed ? 0.2 : 1,
                        cursor: 'pointer',
                        transition: draggingNodeId === n.id ? 'none' : 'opacity 0.2s ease',
                      }}
                      onMouseEnter={() => setHoveredNodeId(n.id)}
                      onMouseLeave={() => setHoveredNodeId(null)}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        nodeDragMovedRef.current = false;
                        setDraggingNodeId(n.id);
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedNodeId(n.id);
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        if (!isEntity) {
                          onInspect(n.id);
                        }
                      }}
                    >
                      {/* Aura / Halo on pinned / selected / hovered */}
                      {(n.pinned || isSelected || activeNode?.id === n.id) && (
                        <circle
                          r={n.radius + 6}
                          fill="none"
                          stroke={n.color}
                          strokeWidth={isSelected ? 2 : 1.4}
                          strokeOpacity={isSelected ? 0.85 : 0.55}
                          strokeDasharray={isSelected ? undefined : '4 2'}
                        />
                      )}

                      {/* Main Node Shape (Supermemory Hexagon for Entities vs Circle for Memories) */}
                      {isEntity ? (
                        <polygon
                          points="0,-16 14,-8 14,8 0,16 -14,8 -14,-8"
                          fill="var(--dshm-bg-layer-2, #202127)"
                          stroke={n.color}
                          strokeWidth={isSelected ? 2.4 : 1.6}
                          filter="url(#node-shadow)"
                        />
                      ) : (
                        <circle
                          r={n.radius}
                          fill="var(--dshm-bg-layer-2, #202127)"
                          stroke={n.color}
                          strokeWidth={isSelected ? 2.8 : n.pinned ? 2.4 : 1.8}
                          filter="url(#node-shadow)"
                        />
                      )}

                      {/* Node Label Text */}
                      {isEntity ? (
                        <>
                          <text
                            y={3.5}
                            textAnchor="middle"
                            fill="var(--dshm-warning, #f59e0b)"
                            fontSize={9.5}
                            fontWeight={700}
                            style={{ pointerEvents: 'none' }}
                          >
                            #
                          </text>
                          <text
                            y={27}
                            textAnchor="middle"
                            fill="var(--dshm-text-primary, #eceef2)"
                            fontSize={10}
                            fontWeight={600}
                            style={{ pointerEvents: 'none' }}
                          >
                            {cleanText.length > 12 ? cleanText.slice(0, 11) + '…' : cleanText}
                          </text>
                        </>
                      ) : (
                        <>
                          <text
                            y={3.8}
                            textAnchor="middle"
                            fill={n.color}
                            fontSize={10.5}
                            fontWeight={700}
                            style={{ pointerEvents: 'none' }}
                          >
                            {n.shortChar}
                          </text>
                          <text
                            y={n.radius + 13}
                            textAnchor="middle"
                            fill="var(--dshm-text-secondary, #9499a3)"
                            fontSize={10}
                            style={{ pointerEvents: 'none' }}
                          >
                            {cleanText.length > 14 ? cleanText.slice(0, 13) + '…' : cleanText}
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

        {/* Interactive Node Inspector Drawer */}
        {(selectedNode || activeNode) && (
          <div
            className="dshm-graph-tooltip"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {(() => {
              const target = selectedNode || activeNode!;
              const cleanText = target.label.replace(/^\[[A-Z]+\]\s*/, '');
              return (
                <>
                  <div className="dshm-tooltip-header">
                    <span
                      className="dshm-tag"
                      style={{
                        background: `${target.color}22`,
                        color: target.color,
                        border: `0.5px solid ${target.color}55`,
                      }}
                    >
                      {target.typeLabel}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className="dshm-tooltip-conn">
                        关联 {target.connections || 0}
                      </span>
                      {selectedNode && (
                        <button
                          type="button"
                          className="dshm-search-clear"
                          onClick={() => setSelectedNodeId(null)}
                          title="关闭节点面板"
                        >
                          <CloseIcon size={11} />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="dshm-tooltip-body">{cleanText}</div>

                  {target.confidence !== undefined && (
                    <div className="dshm-tooltip-metrics">
                      <span>置信度 {Math.round(target.confidence * 100)}%</span>
                      <span>·</span>
                      <span>实用度 {Math.round((target.utility ?? 0.5) * 100)}%</span>
                      {target.pinned ? <span>· 📌 已置顶</span> : null}
                    </div>
                  )}

                  {selectedNode && selectedNodeLinks.length > 0 && (
                    <div className="dshm-tooltip-neighbors">
                      <div className="dshm-tooltip-neighbors-title">
                        邻接拓扑节点 ({selectedNodeLinks.length})
                      </div>
                      <div className="dshm-tooltip-neighbors-list">
                        {selectedNodeLinks.slice(0, 5).map((item, idx) => (
                          <button
                            key={idx}
                            type="button"
                            className="dshm-neighbor-chip"
                            onClick={() => setSelectedNodeId(item.otherId)}
                          >
                            <span className="dshm-neighbor-rel">
                              {REL_LABELS[item.rel] || item.rel}
                            </span>
                            <span className="dshm-neighbor-label">
                              {item.otherNode?.label
                                .replace(/^\[[A-Z]+\]\s*/, '')
                                .slice(0, 16) || item.otherId}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {target.effectiveType !== 'entity' && (
                    <button
                      type="button"
                      className="dshm-btn dshm-btn-primary"
                      style={{ width: '100%', marginTop: 4 }}
                      onClick={() => onInspect(target.id)}
                    >
                      <EyeIcon size={13} />
                      <span>打开详情与因果版本审计</span>
                    </button>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* Footer Stats Legend */}
        {data && (
          <div className="dshm-graph-legend">
            <div className="dshm-legend-item">
              <span className="dshm-legend-dot" style={{ background: '#a855f7' }} />
              <span>偏好 ({typeCounts.preference})</span>
            </div>
            <div className="dshm-legend-item">
              <span className="dshm-legend-dot" style={{ background: '#10b981' }} />
              <span>事实 ({typeCounts.semantic})</span>
            </div>
            <div className="dshm-legend-item">
              <span className="dshm-legend-dot" style={{ background: '#38bdf8' }} />
              <span>流程 ({typeCounts.procedural})</span>
            </div>
            <div className="dshm-legend-item">
              <span className="dshm-legend-dot" style={{ background: ENTITY_COLOR }} />
              <span>实体 ({typeCounts.entity})</span>
            </div>
            <span className="dshm-legend-divider">|</span>
            <span>
              支持拖拽单个节点调优布局 · 双击节点直达详情 · 共 {data.stats.totalNodes} 节点 /{' '}
              {data.stats.totalLinks} 边
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
