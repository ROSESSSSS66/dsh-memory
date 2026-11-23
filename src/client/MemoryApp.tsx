import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EpistemicInsights } from './components/EpistemicInsights.js';
import { LLMConfigModal } from './components/LLMConfigModal.js';
import { MemoryHeader } from './components/MemoryHeader.js';
import { formatRelativeTime, getMessages, resolveUiLocale } from './i18n.js';
import { MEMORY_STYLES } from './styles.js';
import type {
  ConfigSavePayload,
  CoreMemoryBlock,
  HindsightSummaryData,
  JobLogItem,
  LLMConfigData,
  LLMTestPayload,
  LLMTestResult,
  MemoryHealthReportData,
  MemoryHostAdapter,
  MemoryItem,
  OverviewStatsData,
  StudioSnapshotResponse,
  VikingSummaryData,
  WorkspaceOption,
} from './types.js';

const API_PREFIX = '/api/dsh-memory';
const PAGE_SIZE = 60;
const MAX_POLL_WINDOW = 200;
const POLL_INTERVAL_MS = 8000;
const SEARCH_DEBOUNCE_MS = 250;

function formatShortId(id: string): string {
  return id.startsWith('m_') ? id.slice(0, 10) : id.slice(0, 8);
}

function defaultFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, init);
}

async function safeJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function MemoryApp(props: MemoryHostAdapter) {
  const apiFetch = props.fetchApi ?? defaultFetch;
  const locale = props.locale ?? resolveUiLocale();
  const t = getMessages(locale);

  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(props.initialWorkspaceId ?? '');

  const [statsData, setStatsData] = useState<OverviewStatsData | null>(null);
  const [healthData, setHealthData] = useState<MemoryHealthReportData | null>(null);
  const [coreBlocks, setCoreBlocks] = useState<CoreMemoryBlock[]>([]);
  const [coreTokens, setCoreTokens] = useState(0);
  const [stableLayerTokens, setStableLayerTokens] = useState(0);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [totalMemories, setTotalMemories] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const [filterQuery, setFilterQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [recentJobs, setRecentJobs] = useState<JobLogItem[]>([]);
  const [hindsightData, setHindsightData] = useState<HindsightSummaryData | null>(null);
  const [vikingData, setVikingData] = useState<VikingSummaryData | null>(null);

  const [llmConfig, setLlmConfig] = useState<LLMConfigData | null>(null);
  const [configOpen, setConfigOpen] = useState(false);

  const fetchingRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const mountedRef = useRef(true);
  const configOpenRef = useRef(false);
  const etagRef = useRef<string | null>(null);
  const snapshotUnsupportedRef = useRef(false);
  const loadedWindowRef = useRef(PAGE_SIZE);
  const pollAbortRef = useRef<AbortController | null>(null);
  const configAbortRef = useRef<AbortController | null>(null);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const configBtnRef = useRef<HTMLButtonElement | null>(null);
  const fetchAllRef = useRef<
    (options?: { force?: boolean; abortCurrent?: boolean }) => Promise<void>
  >(async () => {});

  useEffect(() => {
    configOpenRef.current = configOpen;
  }, [configOpen]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pollAbortRef.current?.abort();
      configAbortRef.current?.abort();
      loadMoreAbortRef.current?.abort();
    };
  }, []);

  // Debounce server-side search query (250ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(filterQuery.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filterQuery]);

  const fetchLegacy = useCallback(
    async (signal: AbortSignal): Promise<void> => {
      const limit = Math.min(MAX_POLL_WINDOW, Math.max(PAGE_SIZE, loadedWindowRef.current));
      const wsParam = selectedWorkspaceId
        ? `&workspaceId=${encodeURIComponent(selectedWorkspaceId)}`
        : '';
      const qParam = debouncedQuery ? `&q=${encodeURIComponent(debouncedQuery)}` : '';

      const results = await Promise.allSettled([
        apiFetch(
          `${API_PREFIX}/stats${selectedWorkspaceId ? `?workspaceId=${encodeURIComponent(selectedWorkspaceId)}` : ''}`,
          { signal }
        ),
        apiFetch(
          `${API_PREFIX}/health${selectedWorkspaceId ? `?workspaceId=${encodeURIComponent(selectedWorkspaceId)}` : ''}`,
          { signal }
        ),
        apiFetch(
          `${API_PREFIX}/core-memory${selectedWorkspaceId ? `?workspaceId=${encodeURIComponent(selectedWorkspaceId)}` : ''}`,
          { signal }
        ),
        apiFetch(
          `${API_PREFIX}/memories?status=live&excludeCore=1&limit=${limit}&offset=0${wsParam}${qParam}`,
          { signal }
        ),
        apiFetch(`${API_PREFIX}/evolution?lite=1`, { signal }),
      ]);

      if (signal.aborted || !mountedRef.current) return;

      let anyOk = false;
      let firstError: string | null = null;

      const [stRes, hlRes, crRes, memRes, evoRes] = results;

      if (stRes.status === 'fulfilled') {
        if (stRes.value.ok) {
          const j = await safeJson<OverviewStatsData & { ok?: boolean }>(stRes.value);
          if (j?.ok) {
            anyOk = true;
            setStatsData(j);
            if (typeof j.stableLayerTokens === 'number') {
              setStableLayerTokens(j.stableLayerTokens);
            }
          }
        } else {
          firstError ??= `HTTP ${stRes.value.status}`;
        }
      } else {
        firstError ??=
          stRes.reason instanceof Error ? stRes.reason.message : t.banners.networkError;
      }

      if (hlRes.status === 'fulfilled' && hlRes.value.ok) {
        const j = await safeJson<{
          ok?: boolean;
          health?: MemoryHealthReportData;
        }>(hlRes.value);
        if (j?.ok && j.health) {
          anyOk = true;
          setHealthData(j.health);
        }
      }

      if (crRes.status === 'fulfilled' && crRes.value.ok) {
        const j = await safeJson<{
          ok?: boolean;
          blocks?: CoreMemoryBlock[];
          totalTokens?: number;
          stableLayerTokens?: number;
        }>(crRes.value);
        if (j?.ok) {
          anyOk = true;
          setCoreBlocks(j.blocks ?? []);
          setCoreTokens(j.totalTokens ?? 0);
          if (typeof j.stableLayerTokens === 'number') {
            setStableLayerTokens(j.stableLayerTokens);
          }
        }
      }

      if (memRes.status === 'fulfilled' && memRes.value.ok) {
        const j = await safeJson<{
          ok?: boolean;
          items?: MemoryItem[];
          total?: number;
        }>(memRes.value);
        if (j?.ok) {
          anyOk = true;
          const items = j.items ?? [];
          setMemories(items);
          setTotalMemories(typeof j.total === 'number' ? j.total : items.length);
        }
      }

      if (evoRes.status === 'fulfilled' && evoRes.value.ok) {
        const j = await safeJson<{
          ok?: boolean;
          recentJobs?: JobLogItem[];
        }>(evoRes.value);
        if (j?.ok) {
          anyOk = true;
          setRecentJobs((j.recentJobs ?? []).slice(0, 8));
        }
      }

      if (signal.aborted || !mountedRef.current) return;
      if (anyOk) {
        setConnectionError(null);
      } else {
        setConnectionError(firstError || t.banners.serviceUnavailable);
      }
    },
    [
      apiFetch,
      selectedWorkspaceId,
      debouncedQuery,
      t.banners.networkError,
      t.banners.serviceUnavailable,
    ]
  );

  const fetchAll = useCallback(
    async (options?: { force?: boolean; abortCurrent?: boolean }): Promise<void> => {
      if (fetchingRef.current) {
        if (options?.abortCurrent && pollAbortRef.current) {
          pollAbortRef.current.abort();
        }
        pendingRefreshRef.current = true;
        return;
      }

      fetchingRef.current = true;
      const controller = new AbortController();
      pollAbortRef.current = controller;

      try {
        if (snapshotUnsupportedRef.current) {
          await fetchLegacy(controller.signal);
          return;
        }

        const params = new URLSearchParams();
        if (selectedWorkspaceId) params.set('workspaceId', selectedWorkspaceId);
        if (debouncedQuery) params.set('q', debouncedQuery);
        params.set(
          'limit',
          String(Math.min(MAX_POLL_WINDOW, Math.max(PAGE_SIZE, loadedWindowRef.current)))
        );
        params.set('offset', '0');

        const headers: Record<string, string> = {};
        if (!options?.force && etagRef.current) {
          headers['If-None-Match'] = etagRef.current;
        }

        const res = await apiFetch(`${API_PREFIX}/studio-snapshot?${params.toString()}`, {
          headers,
          signal: controller.signal,
        });

        if (controller.signal.aborted || !mountedRef.current) return;

        if (res.status === 304) {
          setConnectionError(null);
          return;
        }

        if (res.status === 404) {
          snapshotUnsupportedRef.current = true;
          await fetchLegacy(controller.signal);
          return;
        }

        if (!res.ok) {
          setConnectionError(`HTTP ${res.status}`);
          return;
        }

        const j = await safeJson<StudioSnapshotResponse | { ok?: false; error?: string }>(res);
        if (controller.signal.aborted || !mountedRef.current) return;

        if (!j || !j.ok) {
          setConnectionError((j && 'error' in j && j.error) || t.banners.invalidResponse);
          return;
        }

        const nextEtag = res.headers.get('etag') || j.etag || null;
        if (nextEtag) {
          etagRef.current = nextEtag;
        }

        setWorkspaces(Array.isArray(j.workspaces) ? j.workspaces : []);
        if (!selectedWorkspaceId && j.workspaceId) {
          setSelectedWorkspaceId(j.workspaceId);
        }
        setStatsData(j.stats ?? null);
        setHealthData(j.health ?? null);
        setCoreBlocks(j.coreMemory?.blocks ?? []);
        setCoreTokens(j.coreMemory?.totalTokens ?? 0);
        setStableLayerTokens(
          typeof j.coreMemory?.stableLayerTokens === 'number'
            ? j.coreMemory.stableLayerTokens
            : (j.stats?.stableLayerTokens ?? 0)
        );

        const nextItems = j.memories?.items ?? [];
        setMemories(nextItems);
        setTotalMemories(
          typeof j.memories?.total === 'number' ? j.memories.total : nextItems.length
        );
        setRecentJobs((j.evolution?.recentJobs ?? []).slice(0, 8));
        setHindsightData(j.hindsight ?? null);
        setVikingData(j.viking ?? null);
        setConnectionError(null);
      } catch (err: unknown) {
        if (
          controller.signal.aborted ||
          !mountedRef.current ||
          (err instanceof Error && err.name === 'AbortError')
        ) {
          return;
        }
        setConnectionError(
          err instanceof Error && err.message ? err.message : t.banners.networkError
        );
      } finally {
        if (pollAbortRef.current === controller) {
          pollAbortRef.current = null;
        }
        fetchingRef.current = false;
        if (mountedRef.current) {
          setLoading(false);
          if (pendingRefreshRef.current) {
            pendingRefreshRef.current = false;
            void fetchAllRef.current({ force: true });
          }
        }
      }
    },
    [
      apiFetch,
      debouncedQuery,
      fetchLegacy,
      selectedWorkspaceId,
      t.banners.invalidResponse,
      t.banners.networkError,
    ]
  );

  useEffect(() => {
    fetchAllRef.current = fetchAll;
  }, [fetchAll]);

  const fetchConfig = useCallback(async (): Promise<void> => {
    configAbortRef.current?.abort();
    const controller = new AbortController();
    configAbortRef.current = controller;

    try {
      const res = await apiFetch(`${API_PREFIX}/config`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || !mountedRef.current || !res.ok) return;
      const json = await safeJson<{ ok?: boolean; config?: LLMConfigData }>(res);
      if (controller.signal.aborted || !mountedRef.current) return;
      if (json?.ok && json.config) {
        setLlmConfig(json.config);
      }
    } catch {
      // Non-fatal: retried on modal open & visibility resume
    } finally {
      if (configAbortRef.current === controller) {
        configAbortRef.current = null;
      }
    }
  }, [apiFetch]);

  // Initial config load on mount
  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  // Refresh snapshot immediately on mount and whenever workspace or search query changes
  useEffect(() => {
    etagRef.current = null;
    loadedWindowRef.current = PAGE_SIZE;
    void fetchAll({ force: true, abortCurrent: true });
  }, [fetchAll]);

  // Background 8s polling & visibility resume (paused while modal open or tab hidden)
  useEffect(() => {
    const isHidden = () => typeof document !== 'undefined' && Boolean(document.hidden);

    const timer = setInterval(() => {
      if (!isHidden() && !configOpenRef.current) {
        void fetchAllRef.current();
      }
    }, POLL_INTERVAL_MS);

    const onVisibility = () => {
      if (!isHidden()) {
        void fetchConfig();
        if (!configOpenRef.current) {
          void fetchAllRef.current();
        }
      }
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
  }, [fetchConfig]);

  const handleLoadMore = useCallback(async () => {
    if (loadingMore || memories.length >= totalMemories) return;
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;
    setLoadingMore(true);

    try {
      const params = new URLSearchParams();
      params.set('status', 'live');
      params.set('excludeCore', '1');
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(memories.length));
      if (selectedWorkspaceId) params.set('workspaceId', selectedWorkspaceId);
      if (debouncedQuery) params.set('q', debouncedQuery);

      const res = await apiFetch(`${API_PREFIX}/memories?${params.toString()}`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || !mountedRef.current || !res.ok) return;

      const j = await safeJson<{
        ok?: boolean;
        items?: MemoryItem[];
        total?: number;
      }>(res);
      if (controller.signal.aborted || !mountedRef.current || !j?.ok) return;

      const incoming = j.items ?? [];
      setMemories((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        const merged = [...prev];
        for (const item of incoming) {
          if (!seen.has(item.id)) {
            seen.add(item.id);
            merged.push(item);
          }
        }
        loadedWindowRef.current = Math.min(MAX_POLL_WINDOW, merged.length);
        return merged;
      });
      if (typeof j.total === 'number') {
        setTotalMemories(j.total);
      }
    } catch {
      // ignore load-more errors silently; user can retry
    } finally {
      if (loadMoreAbortRef.current === controller) {
        loadMoreAbortRef.current = null;
      }
      if (mountedRef.current) {
        setLoadingMore(false);
      }
    }
  }, [apiFetch, debouncedQuery, loadingMore, memories.length, selectedWorkspaceId, totalMemories]);

  const handleOpenConfig = useCallback(() => {
    setConfigOpen(true);
    void fetchConfig();
  }, [fetchConfig]);

  const handleCloseConfig = useCallback(() => {
    setConfigOpen(false);
  }, []);

  const handleSelectWorkspace = useCallback((workspaceId: string) => {
    setSelectedWorkspaceId(workspaceId);
  }, []);

  const handleSaveConfig = useCallback(
    async (payload: ConfigSavePayload): Promise<void> => {
      const res = await apiFetch(`${API_PREFIX}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await safeJson<{
        ok?: boolean;
        config?: LLMConfigData;
        error?: string;
      }>(res);
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || `HTTP ${res.status}`);
      }
      if (json.config) {
        setLlmConfig(json.config);
      }
      etagRef.current = null;
      void fetchAllRef.current({ force: true });
    },
    [apiFetch]
  );

  const handleTestConnection = useCallback(
    async (payload: LLMTestPayload, signal?: AbortSignal): Promise<LLMTestResult> => {
      const res = await apiFetch(`${API_PREFIX}/llm/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
      const json = await safeJson<LLMTestResult>(res);
      if (json) return json;
      return {
        ok: false,
        status: res.status,
        error: `HTTP ${res.status}`,
      };
    },
    [apiFetch]
  );

  const handleRetrySync = useCallback(() => {
    etagRef.current = null;
    void fetchAllRef.current({ force: true, abortCurrent: true });
    void fetchConfig();
  }, [fetchConfig]);

  const isLlmConfigured = Boolean(
    llmConfig?.privacy?.offlineConsent &&
      (llmConfig?.offlineLLM?.useDshLlm ||
        llmConfig?.offlineLLM?.hasApiKey ||
        llmConfig?.offlineLLM?.baseURL)
  );

  // Instant client-side narrowing while 250ms server-side debounce catches up
  const filteredMemories = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q || q === debouncedQuery.toLowerCase()) return memories;
    return memories.filter((m) => {
      const typeLabel = t.memories.types[m.type] || m.type;
      return (
        m.summary?.toLowerCase().includes(q) ||
        m.content?.toLowerCase().includes(q) ||
        Boolean(m.slot_key && m.slot_key.toLowerCase().includes(q)) ||
        Boolean(m.vikingUri && m.vikingUri.toLowerCase().includes(q)) ||
        Boolean(m.hindsightNetwork && m.hindsightNetwork.toLowerCase().includes(q)) ||
        m.type.toLowerCase().includes(q) ||
        typeLabel.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q)
      );
    });
  }, [memories, filterQuery, debouncedQuery, t.memories.types]);

  const hasData = statsData !== null;
  const isInitialLoading = loading && !hasData && !connectionError;

  const activeCount =
    (statsData?.stats.active ?? statsData?.stats.byStatus?.active ?? 0) +
    (statsData?.stats.frozen ?? statsData?.stats.byStatus?.frozen ?? 0);
  const totalCount = statsData?.stats.total ?? 0;
  const candidateCount = statsData?.stats.candidate ?? statsData?.stats.byStatus?.candidate ?? 0;

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
  const pendingRepairsCount = statsData?.pendingRepairsCount ?? 0;

  const stableShare = hasData
    ? Math.min(100, (effectiveStableTokens / Math.max(1, hardBudget)) * 100)
    : 0;
  const dynamicShare = hasData
    ? Math.min(100 - stableShare, (avgTokens / Math.max(1, hardBudget)) * 100)
    : 0;

  const primaryRecommendation = healthData?.recommendations?.[0] || '';

  const healthSubText = useMemo(() => {
    if (!healthData) return t.overview.tiles.syncing;
    if (healthData.ftsConsistent === false) {
      return t.overview.tiles.healthSubHealing;
    }
    if (typeof healthData.embeddingsReadyCount === 'number') {
      const ready = healthData.embeddingsReadyCount;
      const missing = healthData.missingEmbeddingsCount ?? 0;
      const vecTotal = ready + missing;
      if (vecTotal > 0) {
        return t.overview.tiles.healthSubVector(ready, vecTotal);
      }
    }
    return t.overview.tiles.healthSubSynced;
  }, [healthData, t.overview.tiles]);

  const effectiveTotalMemories = Math.max(totalMemories, memories.length);
  const remainingMemories = Math.max(0, effectiveTotalMemories - memories.length);
  const showSearchInput =
    memories.length > 0 || effectiveTotalMemories > 0 || filterQuery.trim().length > 0;

  const displayModelName = llmConfig?.offlineLLM?.useDshLlm
    ? llmConfig.offlineLLM.model || t.header.dshHostLabel
    : llmConfig?.offlineLLM?.model;

  return (
    <div className="dshm-root">
      <style href="dsh-memory-studio" precedence="default">
        {MEMORY_STYLES}
      </style>

      <div className="dshm-studio">
        {/* 1. Studio Editorial Header (Single Primary Action: Model Settings) */}
        <MemoryHeader
          onOpenConfig={handleOpenConfig}
          configBtnRef={configBtnRef}
          llmConfigured={isLlmConfigured}
          llmModelName={displayModelName}
          healthGrade={healthData?.grade}
          healthScore={healthData?.score}
          strategyVersion={hasData ? (statsData?.activeStrategyVersion ?? 1) : undefined}
          locale={locale}
          loading={isInitialLoading}
          offline={Boolean(connectionError)}
          workspaces={workspaces}
          selectedWorkspaceId={selectedWorkspaceId}
          onSelectWorkspace={handleSelectWorkspace}
        />

        {/* Non-blocking Offline / Degraded Banner */}
        {connectionError ? (
          <div className="dshm-banner dshm-banner--offline" role="alert">
            <div className="dshm-banner-body">
              <span className="dshm-banner-title">{t.banners.offlineTitle}</span>
              <span className="dshm-banner-detail">{t.banners.offlineDetail(connectionError)}</span>
            </div>
            <button type="button" className="dshm-banner-retry" onClick={handleRetrySync}>
              {t.banners.retry}
            </button>
          </div>
        ) : null}

        {/* 2. Claude Studio 3x2 Telemetry Panel */}
        <section className="dshm-usage-panel" aria-label={t.overview.ariaLabel}>
          <div className="dshm-usage-head">
            <div className="dshm-usage-head-left">
              <span className="dshm-usage-head-title">{t.overview.title}</span>
              {pendingRepairsCount > 0 ? (
                <span className="dshm-repair-pill">
                  {t.banners.pendingRepairs(pendingRepairsCount)}
                </span>
              ) : null}
            </div>
            <span className="dshm-usage-head-caption">{t.overview.caption}</span>
          </div>

          <div className="dshm-stat-grid">
            <div className="dshm-stat-tile">
              <span className="dshm-stat-tile-label">{t.overview.tiles.activeLabel}</span>
              <div className="dshm-stat-tile-value-row">
                <span className="dshm-stat-tile-value">{hasData ? activeCount : '—'}</span>
                <span className="dshm-stat-tile-sub">
                  {hasData
                    ? t.overview.tiles.activeSub(totalCount, candidateCount)
                    : t.overview.tiles.syncing}
                </span>
              </div>
            </div>

            <div className="dshm-stat-tile">
              <span className="dshm-stat-tile-label">{t.overview.tiles.healthLabel}</span>
              <div className="dshm-stat-tile-value-row">
                <span className="dshm-stat-tile-value">
                  {healthData ? `${healthData.grade} · ${healthData.score}` : '—'}
                </span>
                <span className="dshm-stat-tile-sub">{healthSubText}</span>
              </div>
            </div>

            <div className="dshm-stat-tile">
              <span className="dshm-stat-tile-label">{t.overview.tiles.dynamicLabel}</span>
              <div className="dshm-stat-tile-value-row">
                <span className="dshm-stat-tile-value">
                  {hasData ? `${avgTokens} ${t.overview.tokUnit}` : '—'}
                </span>
                <span className="dshm-stat-tile-sub">
                  {hasData ? t.overview.tiles.dynamicSub(dynamicBudget) : t.overview.tiles.syncing}
                </span>
              </div>
            </div>

            <div className="dshm-stat-tile">
              <span className="dshm-stat-tile-label">{t.overview.tiles.stableLabel}</span>
              <div className="dshm-stat-tile-value-row">
                <span className="dshm-stat-tile-value">
                  {hasData ? `${effectiveStableTokens} ${t.overview.tokUnit}` : '—'}
                </span>
                <span className="dshm-stat-tile-sub">
                  {hasData ? t.overview.tiles.stableSub(stableBudget) : t.overview.tiles.syncing}
                </span>
              </div>
            </div>

            <div className="dshm-stat-tile">
              <span className="dshm-stat-tile-label">{t.overview.tiles.accuracyLabel}</span>
              <div className="dshm-stat-tile-value-row">
                <span className="dshm-stat-tile-value">{hasData ? `${signalAccuracy}%` : '—'}</span>
                <span className="dshm-stat-tile-sub">
                  {hasData
                    ? t.overview.tiles.accuracySub(injectionCount)
                    : t.overview.tiles.syncing}
                </span>
              </div>
            </div>

            <div className="dshm-stat-tile">
              <span className="dshm-stat-tile-label">{t.overview.tiles.quotaLabel}</span>
              <div className="dshm-stat-tile-value-row">
                <span className="dshm-stat-tile-value">
                  {hasData ? `${callsToday} / ${maxDailyCalls}` : '—'}
                </span>
                <span className="dshm-stat-tile-sub">
                  {hasData
                    ? t.overview.tiles.quotaSub((tokensToday / 1000).toFixed(1))
                    : t.overview.tiles.syncing}
                </span>
              </div>
            </div>
          </div>

          {/* Context Budget Yardstick */}
          <div className="dshm-yardstick">
            <div className="dshm-yardstick-bar" aria-hidden="true">
              <div className="dshm-yardstick-seg-stable" style={{ width: `${stableShare}%` }} />
              <div className="dshm-yardstick-seg-dynamic" style={{ width: `${dynamicShare}%` }} />
            </div>
            <div className="dshm-yardstick-legend">
              <span>
                {t.overview.yardstick.legend(effectiveStableTokens, coreTokens, avgTokens)}
              </span>
              <span>{t.overview.yardstick.hardCap(hardBudget)}</span>
            </div>
          </div>

          {primaryRecommendation ? (
            <div className="dshm-doctor-note">{primaryRecommendation}</div>
          ) : null}
        </section>

        {/* 3. Core Memory (All blocks rendered — custom blocks included) */}
        {coreBlocks.length > 0 ? (
          <section className="dshm-section" aria-label={t.coreMemory.ariaLabel}>
            <div className="dshm-section-head">
              <span className="dshm-section-label">{t.coreMemory.title}</span>
              <span className="dshm-section-sub">{t.coreMemory.sub}</span>
            </div>

            <div className="dshm-core-grid">
              {coreBlocks.map((b) => (
                <div key={b.id || b.block} className="dshm-core-card">
                  <div className="dshm-core-card-head">
                    <span className="dshm-core-card-title">
                      {t.coreMemory.blocks[b.block] || b.block}
                    </span>
                    <span className="dshm-core-card-tok">
                      {b.tokens} {t.overview.tokUnit}
                    </span>
                  </div>
                  <div className="dshm-core-card-body">{b.content || t.coreMemory.emptyBlock}</div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* 4. Read-Only Epistemic Insights (Hindsight 4-Network + OpenViking L0/L1/L2 Tree) */}
        <EpistemicInsights hindsight={hindsightData} viking={vikingData} locale={locale} />

        {/* 5. Active Memories (Process-Column Expandable List + Server Search/Pagination) */}
        <section className="dshm-section" aria-label={t.memories.ariaLabel}>
          <div className="dshm-section-head">
            <span className="dshm-section-label">{t.memories.title}</span>
            <div className="dshm-section-head-right">
              {showSearchInput ? (
                <input
                  type="search"
                  className="dshm-filter-input"
                  value={filterQuery}
                  onChange={(e) => setFilterQuery(e.target.value)}
                  placeholder={t.memories.searchPlaceholder}
                  aria-label={t.memories.searchAria}
                />
              ) : null}
              <span className="dshm-section-sub">
                {t.memories.countSummary(
                  filteredMemories.length,
                  effectiveTotalMemories,
                  Boolean(filterQuery.trim())
                )}{' '}
                · {t.memories.clickToExpand}
              </span>
            </div>
          </div>

          {isInitialLoading ? (
            <div className="dshm-empty-box">{t.memories.loadingState}</div>
          ) : filteredMemories.length === 0 ? (
            <div className="dshm-empty-box">
              {filterQuery.trim() ? t.memories.emptyFiltered : t.memories.emptyReady}
            </div>
          ) : (
            <div className="dshm-process-card">
              {filteredMemories.map((m) => (
                <details key={m.id} className="dshm-process-item">
                  <summary className="dshm-process-summary">
                    <div className="dshm-process-left">
                      <span className="dshm-process-kind" data-pinned={m.pinned ? '1' : '0'}>
                        {m.status === 'frozen' ? '❄ ' : m.pinned ? '★ ' : ''}
                        {t.memories.types[m.type] || m.type}
                      </span>
                      <span className="dshm-process-title">{m.summary || m.content}</span>
                    </div>

                    <div className="dshm-process-right">
                      {m.slot_key ? <span className="dshm-process-slot">{m.slot_key}</span> : null}
                      <span>{Math.round((m.utility ?? 0.5) * 100)}%</span>
                      <span>{formatRelativeTime(m.updated_at, locale)}</span>
                      <span className="dshm-process-chevron" aria-hidden="true">
                        ›
                      </span>
                    </div>
                  </summary>

                  <div className="dshm-process-details">
                    <div className="dshm-process-content">{m.content}</div>
                    <div className="dshm-process-meta-bar">
                      <span title={m.id}>
                        {t.memories.meta.id}: {formatShortId(m.id)}
                      </span>
                      {m.hindsightNetwork ? (
                        <span className="dshm-meta-chip">
                          {t.memories.meta.network}: {m.hindsightNetwork.toUpperCase()}
                        </span>
                      ) : null}
                      {m.vikingUri ? (
                        <span className="dshm-meta-chip">
                          {t.memories.meta.uri}: {m.vikingUri}
                        </span>
                      ) : null}
                      <span>
                        {t.memories.meta.version}: v{m.version}
                      </span>
                      <span>
                        {t.memories.meta.scope}: {t.memories.scopes[m.scope] || m.scope}
                      </span>
                      <span>
                        {t.memories.meta.confidence}: {Math.round((m.confidence ?? 0.8) * 100)}%
                      </span>
                      <span>
                        {t.memories.meta.importance}: {m.importance ?? 5}/10
                      </span>
                      <span>
                        {t.memories.meta.recall(
                          m.use_count ?? 0,
                          m.success_count ?? 0,
                          m.fail_count ?? 0
                        )}
                      </span>
                      <span>{t.memories.meta.cost(m.token_cost ?? 0)}</span>
                    </div>
                  </div>
                </details>
              ))}

              {remainingMemories > 0 ? (
                <div className="dshm-load-more-row">
                  <button
                    type="button"
                    className="dshm-load-more-btn"
                    disabled={loadingMore}
                    onClick={() => void handleLoadMore()}
                  >
                    {loadingMore ? t.memories.loadingMore : t.memories.loadMore(remainingMemories)}
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </section>

        {/* 6. Autonomous Slow-Loop Activity */}
        {recentJobs.length > 0 ? (
          <section className="dshm-section" aria-label={t.jobs.ariaLabel}>
            <div className="dshm-section-head">
              <span className="dshm-section-label">{t.jobs.title}</span>
              <span className="dshm-section-sub">{t.jobs.sub}</span>
            </div>

            <div className="dshm-process-card">
              {recentJobs.map((job) => (
                <div key={job.id} className="dshm-job-item">
                  <div className="dshm-job-row">
                    <div className="dshm-job-left">
                      <span className="dshm-job-kind">{job.kind}</span>
                      <span className="dshm-job-key" title={job.key}>
                        {job.key}
                      </span>
                    </div>

                    <div
                      className="dshm-job-right"
                      style={{
                        color:
                          job.status === 'done'
                            ? 'var(--dshm-valley-green)'
                            : job.status === 'failed'
                              ? 'var(--dshm-danger)'
                              : 'var(--dshm-ink-3)',
                      }}
                    >
                      <span>{t.jobs.status[job.status] || job.status}</span>
                      {job.attempts > 1 || job.status === 'failed' ? (
                        <span className="dshm-job-attempts">{t.jobs.attempts(job.attempts)}</span>
                      ) : null}
                      <span className="dshm-job-time">
                        {formatRelativeTime(job.created_at, locale)}
                      </span>
                    </div>
                  </div>
                  {job.last_error ? <div className="dshm-job-error">{job.last_error}</div> : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      {/* Single Action Sheet: Model Configuration */}
      <LLMConfigModal
        open={configOpen}
        config={llmConfig}
        locale={locale}
        returnFocusRef={configBtnRef}
        onClose={handleCloseConfig}
        onSave={handleSaveConfig}
        onTestConnection={handleTestConnection}
      />
    </div>
  );
}
