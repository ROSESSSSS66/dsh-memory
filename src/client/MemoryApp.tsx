import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { MEMORY_STYLES } from './styles.js';
import { MemoryHeader } from './components/MemoryHeader.js';
import { LLMConfigModal, type LLMConfigData } from './components/LLMConfigModal.js';
import type {
  OverviewStatsData,
  MemoryItem,
  CoreMemoryBlock,
  JobLogItem,
  MemoryHealthReportData,
} from './types.js';

const API_PREFIX = '/api/dsh-memory';

const CORE_LABELS: Record<string, string> = {
  human: 'Human · 用户画像',
  persona: 'Persona · 协作准则',
  project: 'Project · 工程规范',
};

const TYPE_SHORT: Record<string, string> = {
  semantic: '事实',
  preference: '偏好',
  procedural: '流程',
  episodic: '情景',
  failure: '教训',
  belief: '推断',
  goal: '目标',
  meta: '元认知',
};

const SCOPE_LABELS: Record<string, string> = {
  global: '全局',
  user: '用户',
  workspace: '工作区',
  session: '会话',
};

function formatRelativeTime(ts?: number | null): string {
  if (!ts) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return '刚刚';
  if (sec < 3600) return `${Math.floor(sec / 60)}m 前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h 前`;
  const d = Math.floor(sec / 86400);
  if (d < 30) return `${d}d 前`;
  return new Date(ts).toLocaleDateString();
}

export function MemoryApp() {
  const [statsData, setStatsData] = useState<OverviewStatsData | null>(null);
  const [healthData, setHealthData] = useState<MemoryHealthReportData | null>(null);
  const [coreBlocks, setCoreBlocks] = useState<CoreMemoryBlock[]>([]);
  const [coreTokens, setCoreTokens] = useState(0);
  const [stableLayerTokens, setStableLayerTokens] = useState(0);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [filterQuery, setFilterQuery] = useState('');
  const [recentJobs, setRecentJobs] = useState<JobLogItem[]>([]);
  const [llmConfig, setLlmConfig] = useState<LLMConfigData | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const fetchingRef = React.useRef(false);

  const fetchAll = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const [stRes, hlRes, crRes, memRes, evoRes] = await Promise.all([
        fetch(`${API_PREFIX}/stats`),
        fetch(`${API_PREFIX}/health`),
        fetch(`${API_PREFIX}/core-memory`),
        fetch(`${API_PREFIX}/memories?status=live&excludeCore=1&limit=60`),
        fetch(`${API_PREFIX}/evolution?lite=1`),
      ]);

      if (stRes.ok) {
        const j = await stRes.json();
        if (j.ok) {
          setStatsData(j);
          if (typeof j.stableLayerTokens === 'number') {
            setStableLayerTokens(j.stableLayerTokens);
          }
        }
      }
      if (hlRes.ok) {
        const j = await hlRes.json();
        if (j.ok && j.health) setHealthData(j.health);
      }
      if (crRes.ok) {
        const j = await crRes.json();
        if (j.ok) {
          setCoreBlocks(j.blocks || []);
          setCoreTokens(j.totalTokens || 0);
          if (typeof j.stableLayerTokens === 'number') {
            setStableLayerTokens(j.stableLayerTokens);
          }
        }
      }
      if (memRes.ok) {
        const j = await memRes.json();
        if (j.ok) setMemories(j.items || []);
      }
      if (evoRes.ok) {
        const j = await evoRes.json();
        if (j.ok) setRecentJobs((j.recentJobs || []).slice(0, 6));
      }
    } catch {
      // silent during startup or offline transitions
    } finally {
      fetchingRef.current = false;
    }
  }, []);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(`${API_PREFIX}/config`);
      if (!res.ok) return;
      const json = await res.json();
      if (json.ok && json.config) {
        setLlmConfig(json.config);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchAll();
    fetchConfig();
    // 面板不可见时暂停轮询（每轮 5 个请求，其中体检为 O(n²) 计算），重新可见时立即刷新
    const isHidden = () => typeof document !== 'undefined' && document.hidden;
    const timer = setInterval(() => {
      if (!isHidden()) fetchAll();
    }, 8000);
    const onVisibility = () => {
      if (!isHidden()) fetchAll();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
      clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [fetchAll, fetchConfig]);

  const handleSaveConfig = async (payload: any) => {
    const res = await fetch(`${API_PREFIX}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    // 先读响应体：服务端的 400 带有具体原因（地址不合法、环境变量名不允许等）
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);
    if (json.config) {
      setLlmConfig(json.config);
      fetchAll();
    }
  };

  const handleTestConnection = async (payload: {
    baseURL: string;
    model: string;
    apiKey?: string;
    apiKeyEnv: string;
    protocol: 'chat/completions' | 'responses' | 'messages';
  }) => {
    const res = await fetch(`${API_PREFIX}/llm/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await res.json();
  };

  const isLlmConfigured = Boolean(
    llmConfig?.privacy?.offlineConsent &&
      (llmConfig?.offlineLLM?.useDshLlm ||
        llmConfig?.offlineLLM?.hasApiKey ||
        llmConfig?.offlineLLM?.baseURL)
  );

  const filteredMemories = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return memories;
    return memories.filter((m) => {
      const typeLabel = TYPE_SHORT[m.type] || m.type;
      return (
        m.summary?.toLowerCase().includes(q) ||
        m.content?.toLowerCase().includes(q) ||
        (m.slot_key && m.slot_key.toLowerCase().includes(q)) ||
        m.type.toLowerCase().includes(q) ||
        typeLabel.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q)
      );
    });
  }, [memories, filterQuery]);

  const activeCount =
    (statsData?.stats.active ?? statsData?.stats.byStatus?.active ?? 0) +
    (statsData?.stats.frozen ?? statsData?.stats.byStatus?.frozen ?? 0);
  const totalCount = statsData?.stats.total ?? 0;
  const candidateCount =
    statsData?.stats.candidate ?? statsData?.stats.byStatus?.candidate ?? 0;

  const avgTokens = statsData?.recentTelemetry.avgTokens ?? 0;
  const dynamicBudget = statsData?.dynamicBudgetTokens ?? 1600;
  const stableBudget = statsData?.stableBudgetTokens ?? 600;
  const hardBudget = statsData?.hardBudgetTokens ?? 3200;
  const effectiveStableTokens = stableLayerTokens > 0 ? stableLayerTokens : coreTokens;

  const correctionRate = statsData?.recentTelemetry.correctionRate ?? 0;
  const signalAccuracy = Number(Math.max(0, 100 - correctionRate).toFixed(1));
  const injectionCount = statsData?.recentTelemetry.injectionCount ?? 0;

  const callsToday = statsData?.ledger.callsToday ?? 0;
  const maxDailyCalls = statsData?.ledger.maxDailyCalls ?? 40;
  const tokensToday = statsData?.ledger.tokensToday ?? 0;

  const stableShare = Math.min(100, (effectiveStableTokens / Math.max(1, hardBudget)) * 100);
  const dynamicShare = Math.min(
    100 - stableShare,
    (avgTokens / Math.max(1, hardBudget)) * 100
  );

  const primaryRecommendation = healthData?.recommendations?.[0] || '';

  return (
    <div className="dshm-root">
      <style>{MEMORY_STYLES}</style>

      <div className="dshm-studio">
        {/* 1. Studio Editorial Header (ONLY ONE BUTTON: 模型配置) */}
        <MemoryHeader
          onOpenConfig={() => setConfigOpen(true)}
          llmConfigured={isLlmConfigured}
          llmModelName={
            llmConfig?.offlineLLM?.useDshLlm
              ? 'DSH Host'
              : llmConfig?.offlineLLM?.model
          }
          healthGrade={healthData?.grade}
          healthScore={healthData?.score}
          strategyVersion={statsData?.activeStrategyVersion ?? 1}
        />

        {/* 2. Claude Studio 3x2 Telemetry Panel */}
        <section className="dshm-usage-panel" aria-label="系统概览">
          <div className="dshm-usage-head">
            <span className="dshm-usage-head-title">Overview</span>
            <span className="dshm-usage-head-caption">
              本地七路混合快环 &lt; 1ms · 128D 内联向量 · 每 8s 自动同步
            </span>
          </div>

          <div className="dshm-stat-grid">
            <div className="dshm-stat-tile">
              <span className="dshm-stat-tile-label">生效记忆</span>
              <div className="dshm-stat-tile-value-row">
                <span className="dshm-stat-tile-value">{activeCount}</span>
                <span className="dshm-stat-tile-sub">
                  共 {totalCount} · 观察 {candidateCount}
                </span>
              </div>
            </div>

            <div className="dshm-stat-tile">
              <span className="dshm-stat-tile-label">健康医生</span>
              <div className="dshm-stat-tile-value-row">
                <span className="dshm-stat-tile-value">
                  {healthData ? `${healthData.grade} · ${healthData.score}` : 'A+ · 100'}
                </span>
                <span className="dshm-stat-tile-sub">
                  {healthData?.ftsConsistent === false ? '自愈同步中' : 'FTS5 · 向量同步'}
                </span>
              </div>
            </div>

            <div className="dshm-stat-tile">
              <span className="dshm-stat-tile-label">单轮动态注入</span>
              <div className="dshm-stat-tile-value-row">
                <span className="dshm-stat-tile-value">{avgTokens} tok</span>
                <span className="dshm-stat-tile-sub">/ {dynamicBudget} 上限</span>
              </div>
            </div>

            <div className="dshm-stat-tile">
              <span className="dshm-stat-tile-label">常驻稳定层</span>
              <div className="dshm-stat-tile-value-row">
                <span className="dshm-stat-tile-value">{effectiveStableTokens} tok</span>
                <span className="dshm-stat-tile-sub">/ {stableBudget} 预算</span>
              </div>
            </div>

            <div className="dshm-stat-tile">
              <span className="dshm-stat-tile-label">归因信噪比</span>
              <div className="dshm-stat-tile-value-row">
                <span className="dshm-stat-tile-value">{signalAccuracy}%</span>
                <span className="dshm-stat-tile-sub">累计 {injectionCount} 轮</span>
              </div>
            </div>

            <div className="dshm-stat-tile">
              <span className="dshm-stat-tile-label">今日慢环配额</span>
              <div className="dshm-stat-tile-value-row">
                <span className="dshm-stat-tile-value">
                  {callsToday} / {maxDailyCalls}
                </span>
                <span className="dshm-stat-tile-sub">
                  {(tokensToday / 1000).toFixed(1)}k tok
                </span>
              </div>
            </div>
          </div>

          {/* Context Budget Yardstick */}
          <div className="dshm-yardstick">
            <div className="dshm-yardstick-bar">
              <div
                className="dshm-yardstick-seg-stable"
                style={{ width: `${stableShare}%` }}
              />
              <div
                className="dshm-yardstick-seg-dynamic"
                style={{ width: `${dynamicShare}%` }}
              />
            </div>
            <div className="dshm-yardstick-legend">
              <span>
                常驻稳定层 {effectiveStableTokens}t (Core {coreTokens}t) · 动态检索层 {avgTokens}t
              </span>
              <span>总上下文硬上限 {hardBudget} tok</span>
            </div>
          </div>

          {primaryRecommendation && (
            <div className="dshm-doctor-note">{primaryRecommendation}</div>
          )}
        </section>

        {/* 3. Core Memory (System Prompt Stable Layer) */}
        {coreBlocks.length > 0 && (
          <section className="dshm-section" aria-label="常驻核心记忆">
            <div className="dshm-section-head">
              <span className="dshm-section-label">常驻核心记忆 · Core Memory</span>
              <span className="dshm-section-sub">智能体对话与高效用规则自动演进同步</span>
            </div>

            <div className="dshm-core-grid">
              {coreBlocks.slice(0, 3).map((b) => (
                <div key={b.block} className="dshm-core-card">
                  <div className="dshm-core-card-head">
                    <span className="dshm-core-card-title">
                      {CORE_LABELS[b.block] || b.block}
                    </span>
                    <span className="dshm-core-card-tok">{b.tokens} tok</span>
                  </div>
                  <div className="dshm-core-card-body">
                    {b.content || '等待智能体自动提炼填充...'}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* 4. Active Memories (Claude Code Process-Column Style) */}
        <section className="dshm-section" aria-label="活跃记忆流">
          <div className="dshm-section-head">
            <span className="dshm-section-label">活跃记忆流 · Active Memories</span>
            <div className="dshm-section-head-right">
              {memories.length > 0 && (
                <input
                  type="search"
                  className="dshm-filter-input"
                  value={filterQuery}
                  onChange={(e) => setFilterQuery(e.target.value)}
                  placeholder="筛选槽位 / 内容 / 类型..."
                  aria-label="筛选记忆"
                />
              )}
              <span className="dshm-section-sub">
                {filterQuery.trim()
                  ? `${filteredMemories.length} / ${memories.length} 条`
                  : `${memories.length} 条生效中`}{' '}
                · 点击行展开
              </span>
            </div>
          </div>

          {filteredMemories.length === 0 ? (
            <div className="dshm-empty-box">
              {memories.length === 0
                ? '全自动记忆引擎已就绪。在对话过程中，系统将自动捕获事实、开发偏好与排错经验，并在后台完成冲突消解与沉淀。'
                : '未匹配到符合当前筛选词的记忆。清空搜索框即可查看全部生效记忆。'}
            </div>
          ) : (
            <div className="dshm-process-card">
              {filteredMemories.map((m) => (
                <details key={m.id} className="dshm-process-item">
                  <summary className="dshm-process-summary">
                    <div className="dshm-process-left">
                      <span
                        className="dshm-process-kind"
                        data-pinned={m.pinned ? '1' : '0'}
                      >
                        {m.status === 'frozen' ? '❄ ' : m.pinned ? '★ ' : ''}
                        {TYPE_SHORT[m.type] || m.type}
                      </span>
                      <span className="dshm-process-title">
                        {m.summary || m.content}
                      </span>
                    </div>

                    <div className="dshm-process-right">
                      {m.slot_key && (
                        <span className="dshm-process-slot">{m.slot_key}</span>
                      )}
                      <span>{Math.round((m.utility ?? 0.5) * 100)}%</span>
                      <span>{formatRelativeTime(m.updated_at)}</span>
                      <span className="dshm-process-chevron" aria-hidden="true">
                        ›
                      </span>
                    </div>
                  </summary>

                  <div className="dshm-process-details">
                    <div className="dshm-process-content">{m.content}</div>
                    <div className="dshm-process-meta-bar">
                      <span>ID: {m.id.slice(-8)}</span>
                      <span>版本: v{m.version}</span>
                      <span>
                        作用域: {SCOPE_LABELS[m.scope] || m.scope}
                      </span>
                      <span>置信度: {Math.round((m.confidence ?? 0.8) * 100)}%</span>
                      <span>重要度: {m.importance ?? 5}/10</span>
                      <span>
                        召回: {m.use_count} 次
                        {m.success_count ? ` (正反馈 ${m.success_count})` : ''}
                      </span>
                      <span>开销: {m.token_cost} tok</span>
                    </div>
                  </div>
                </details>
              ))}
            </div>
          )}
        </section>

        {/* 5. Autonomous Slow-Loop Activity */}
        {recentJobs.length > 0 && (
          <section className="dshm-section" aria-label="后台自治流水">
            <div className="dshm-section-head">
              <span className="dshm-section-label">后台自治流水 · Slow-Loop Jobs</span>
              <span className="dshm-section-sub">水位线无死锁闭环调度</span>
            </div>

            <div className="dshm-process-card">
              {recentJobs.map((job) => (
                <div key={job.id} className="dshm-job-row">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <span
                      style={{
                        fontFamily: 'var(--dshm-font-code)',
                        fontSize: 11,
                        color: 'var(--dshm-ink-3)',
                        width: 76,
                        flex: 'none',
                      }}
                    >
                      {job.kind}
                    </span>
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: 'var(--dshm-ink-2)',
                      }}
                    >
                      {job.key}
                    </span>
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      flex: 'none',
                      fontSize: 11.5,
                      color:
                        job.status === 'done'
                          ? 'var(--dshm-valley-green)'
                          : job.status === 'failed'
                            ? 'var(--dshm-danger)'
                            : 'var(--dshm-ink-3)',
                    }}
                  >
                    <span>{job.status}</span>
                    <span style={{ color: 'var(--dshm-ink-4)' }}>
                      {formatRelativeTime(job.created_at)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* Single Action Sheet: Model Configuration */}
      <LLMConfigModal
        open={configOpen}
        config={llmConfig}
        onClose={() => setConfigOpen(false)}
        onSave={handleSaveConfig}
        onTestConnection={handleTestConnection}
      />
    </div>
  );
}
