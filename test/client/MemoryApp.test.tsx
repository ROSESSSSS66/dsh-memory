// @vitest-environment happy-dom
import type React from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryApp } from '../../src/client/MemoryApp.js';
import { MemoryErrorBoundary } from '../../src/client/components/MemoryErrorBoundary.js';
import type {
  LLMConfigData,
  MemoryItem,
  StudioSnapshotResponse,
} from '../../src/client/types.js';

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

function createMemoryItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  const now = Date.now() - 120_000;
  return {
    id: 'm_abcd12349999xyz',
    type: 'failure',
    status: 'active',
    content: 'Always run database migrations with lock timeout enabled.',
    summary: 'Enable lock timeout on migrations',
    slot_key: 'db.migration.lock_timeout',
    scope: 'workspace',
    workspace_id: 'ws-alpha',
    source_kind: 'distill',
    confidence: 0.92,
    utility: 0.88,
    importance: 8,
    use_count: 9,
    success_count: 6,
    fail_count: 3,
    token_cost: 38,
    version: 2,
    content_rev: 2,
    pinned: 1,
    created_at: now - 300_000,
    updated_at: now,
    last_used_at: now,
    hindsightNetwork: 'experience',
    vikingUri: 'viking://memories/cases/pg-lock-timeout',
    ...overrides,
  };
}

function createSnapshot(
  overrides: Partial<StudioSnapshotResponse> = {}
): StudioSnapshotResponse {
  const now = Date.now() - 60_000;
  return {
    ok: true,
    etag: '"snap-v1"',
    workspaceId: 'ws-alpha',
    workspaces: [
      {
        workspaceId: 'ws-alpha',
        path: '/repos/alpha-service',
        activeMemories: 16,
      },
    ],
    stats: {
      stats: {
        total: 25,
        active: 14,
        frozen: 2,
        candidate: 3,
        superseded: 4,
        archived: 2,
        byType: { semantic: 8, preference: 5, failure: 3 },
      },
      dynamicBudgetTokens: 1600,
      stableBudgetTokens: 600,
      stableLayerTokens: 310,
      hardBudgetTokens: 3200,
      pendingRepairsCount: 2,
      activeStrategyVersion: 3,
      coreMemoryCount: 5,
      ledger: {
        callsToday: 7,
        tokensToday: 12400,
        maxDailyCalls: 40,
        maxDailyTokens: 200000,
      },
      recentTelemetry: {
        injectionCount: 18,
        avgTokens: 420,
        correctionRate: 4.5,
      },
    },
    health: {
      score: 94,
      grade: 'A',
      counts: {
        total: 25,
        active: 14,
        candidate: 3,
        frozen: 2,
        superseded: 4,
        archived: 2,
        pinned: 2,
      },
      ftsConsistent: true,
      ftsCount: 16,
      embeddingsReadyCount: 15,
      missingEmbeddingsCount: 1,
      duplicatePairs: [],
      contradictions: [],
      staleMemories: [],
      recommendations: ['Index 1 newly captured memory vector in background'],
      checkedAt: now,
    },
    coreMemory: {
      blocks: [
        {
          block: 'human',
          id: 'core_human',
          content: 'Senior TypeScript and SQLite systems engineer.',
          version: 2,
          tokens: 45,
          updated_at: now,
        },
        {
          block: 'persona',
          id: 'core_persona',
          content: 'Concise, verification-first engineering partner.',
          version: 1,
          tokens: 38,
          updated_at: now,
        },
        {
          block: 'project',
          id: 'core_project',
          content: 'NodeNext ESM workspace using Vitest.',
          version: 3,
          tokens: 42,
          updated_at: now,
        },
        {
          block: 'architecture',
          id: 'core_arch',
          content: 'SQLite WAL with 7-channel hybrid retrieval.',
          version: 1,
          tokens: 44,
          updated_at: now,
        },
        {
          block: 'runbook',
          id: 'core_runbook',
          content: 'Run typecheck and targeted tests before merge.',
          version: 1,
          tokens: 41,
          updated_at: now,
        },
      ],
      totalTokens: 210,
      stableBudgetTokens: 600,
      stableLayerTokens: 310,
    },
    memories: {
      total: 1,
      limit: 60,
      offset: 0,
      items: [createMemoryItem()],
    },
    evolution: {
      activeStrategyVersion: 3,
      recentJobs: [
        {
          id: 101,
          kind: 'distill',
          key: 'sess-42:turn-9',
          status: 'failed',
          attempts: 3,
          last_error: 'Upstream HTTP 429 rate limited',
          created_at: now,
          updated_at: now,
        },
        {
          id: 100,
          kind: 'reflect',
          key: 'ws-alpha:daily',
          status: 'done',
          attempts: 1,
          last_error: null,
          created_at: now - 600_000,
          updated_at: now - 590_000,
        },
      ],
    },
    hindsight: {
      networkCounts: {
        world: 6,
        experience: 5,
        observation: 3,
        opinion: 2,
      },
      mentalModels: [
        {
          id: 'mm_01',
          slot_key: 'model.db.safety',
          summary: 'Prefer transactional DDL with explicit lock timeouts.',
          confidence: 0.91,
          network: 'observation',
          updated_at: now,
          vikingUri: 'viking://memories/models/db-safety',
        },
      ],
    },
    viking: {
      rootUri: 'viking://memories',
      totalMemories: 16,
      categories: [
        {
          category: 'cases',
          uri: 'viking://memories/cases',
          count: 4,
          sampleAbstracts: ['Migration lock timeout mitigation'],
        },
      ],
    },
    ...overrides,
  };
}

function createLlmConfig(): LLMConfigData {
  return {
    offlineLLM: {
      useDshLlm: false,
      baseURL: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      apiKeyMasked: 'sk-***1234',
      hasApiKey: true,
      protocol: 'chat/completions',
    },
    privacy: {
      offlineConsent: true,
      allowedOfflineEndpoints: ['https://api.deepseek.com/v1'],
    },
    dailyLLMCalls: 40,
    dailyLLMTokens: 200000,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('MemoryApp', () => {
  it('consumes /studio-snapshot and renders overview, vector coverage, repairs badge, >3 core blocks, prefix short ID, epistemic chips, recall fail_count, and failed jobs', async () => {
    const snapshot = createSnapshot();
    const fetchApi = vi.fn(async (path: string): Promise<Response> => {
      if (path.startsWith('/api/dsh-memory/config')) {
        return jsonResponse({ ok: true, config: createLlmConfig() });
      }
      if (path.startsWith('/api/dsh-memory/studio-snapshot')) {
        return jsonResponse(snapshot, { headers: { ETag: snapshot.etag } });
      }
      return jsonResponse({ ok: false }, { status: 404 });
    });

    const { container } = render(
      <MemoryApp
        fetchApi={fetchApi}
        locale="en"
        initialWorkspaceId="ws-alpha"
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Autonomous loop active')).toBeTruthy();
    });

    // Overview stats, vector coverage, pending repairs badge
    expect(screen.getByText('16')).toBeTruthy();
    expect(screen.getByText('25 total · 3 pending')).toBeTruthy();
    expect(screen.getByText('A · 94')).toBeTruthy();
    expect(screen.getByText('FTS5 · Vectors 15/16')).toBeTruthy();
    expect(screen.getByText('2 pending repair proposals')).toBeTruthy();
    expect(screen.getByText('420 tok')).toBeTruthy();
    expect(screen.getByText('310 tok')).toBeTruthy();
    expect(screen.getByText('95.5%')).toBeTruthy();
    expect(screen.getByText('7 / 40')).toBeTruthy();
    expect(screen.getByText('12.4k tok')).toBeTruthy();
    expect(screen.getByText('Strategy v3')).toBeTruthy();

    // All 5 Core Memory blocks (>3 custom blocks included)
    const coreCards = container.querySelectorAll('.dshm-core-card');
    expect(coreCards.length).toBe(5);
    expect(screen.getByText('Human · Profile')).toBeTruthy();
    expect(screen.getByText('Persona · Collaboration')).toBeTruthy();
    expect(screen.getByText('Project · Engineering')).toBeTruthy();
    expect(screen.getByText('architecture')).toBeTruthy();
    expect(
      screen.getByText('SQLite WAL with 7-channel hybrid retrieval.')
    ).toBeTruthy();
    expect(screen.getByText('runbook')).toBeTruthy();
    expect(
      screen.getByText('Run typecheck and targeted tests before merge.')
    ).toBeTruthy();

    // Active memory metadata: prefix short ID (m_abcd1234, NOT suffix 9999xyz),
    // hindsightNetwork, vikingUri, and fail_count alongside success_count
    const idChip = screen.getByTitle('m_abcd12349999xyz');
    expect(idChip.textContent).toBe('ID: m_abcd1234');
    expect(idChip.textContent).not.toContain('9999xyz');
    expect(screen.getByText('Network: EXPERIENCE')).toBeTruthy();
    expect(
      screen.getByText('URI: viking://memories/cases/pg-lock-timeout')
    ).toBeTruthy();
    expect(screen.getByText('Recalls: 9 (+6 / -3)')).toBeTruthy();

    // Failed job shows last_error and attempts
    expect(screen.getByText('sess-42:turn-9')).toBeTruthy();
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByText('try #3')).toBeTruthy();
    expect(screen.getByText('Upstream HTTP 429 rate limited')).toBeTruthy();
  });

  it('handles 304 Not Modified on ETag polling without breaking rendered state', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    const snapshot = createSnapshot({ etag: '"etag-42"' });
    let snapshotCalls = 0;
    let sawIfNoneMatch: string | null = null;

    const fetchApi = vi.fn(
      async (path: string, init?: RequestInit): Promise<Response> => {
        if (path.startsWith('/api/dsh-memory/config')) {
          return jsonResponse({ ok: true, config: createLlmConfig() });
        }
        if (path.startsWith('/api/dsh-memory/studio-snapshot')) {
          snapshotCalls += 1;
          const headers = new Headers(init?.headers);
          if (snapshotCalls === 1) {
            return jsonResponse(snapshot, {
              headers: { ETag: '"etag-42"' },
            });
          }
          sawIfNoneMatch = headers.get('If-None-Match');
          return new Response(null, { status: 304 });
        }
        return jsonResponse({ ok: false }, { status: 404 });
      }
    );

    render(
      <MemoryApp
        fetchApi={fetchApi}
        locale="en"
        initialWorkspaceId="ws-alpha"
      />
    );

    await waitFor(() => {
      expect(
        screen.getByText('Enable lock timeout on migrations')
      ).toBeTruthy();
    });
    expect(snapshotCalls).toBe(1);

    // Advance the 8s polling interval to trigger conditional ETag request
    vi.advanceTimersByTime(8000);

    await waitFor(() => {
      expect(snapshotCalls).toBe(2);
    });

    expect(sawIfNoneMatch).toBe('"etag-42"');
    // Previously rendered state stays intact and no offline alert appears
    expect(screen.getByText('Enable lock timeout on migrations')).toBeTruthy();
    expect(screen.getByText('A · 94')).toBeTruthy();
    expect(screen.getByText('Autonomous loop active')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('automatically falls back to the 5 legacy routes when /studio-snapshot returns 404', async () => {
    const requestedPaths: string[] = [];
    const snapshot = createSnapshot();

    const fetchApi = vi.fn(async (path: string): Promise<Response> => {
      requestedPaths.push(path);
      if (path.startsWith('/api/dsh-memory/config')) {
        return jsonResponse({ ok: true, config: createLlmConfig() });
      }
      if (path.startsWith('/api/dsh-memory/studio-snapshot')) {
        return jsonResponse({ ok: false, error: 'Not Found' }, { status: 404 });
      }
      if (path.startsWith('/api/dsh-memory/stats')) {
        return jsonResponse({ ok: true, ...snapshot.stats });
      }
      if (path.startsWith('/api/dsh-memory/health')) {
        return jsonResponse({ ok: true, health: snapshot.health });
      }
      if (path.startsWith('/api/dsh-memory/core-memory')) {
        return jsonResponse({
          ok: true,
          blocks: snapshot.coreMemory.blocks,
          totalTokens: snapshot.coreMemory.totalTokens,
          stableLayerTokens: snapshot.coreMemory.stableLayerTokens,
        });
      }
      if (path.startsWith('/api/dsh-memory/memories')) {
        return jsonResponse({
          ok: true,
          items: snapshot.memories.items,
          total: snapshot.memories.total,
        });
      }
      if (path.startsWith('/api/dsh-memory/evolution?lite=1')) {
        return jsonResponse({
          ok: true,
          recentJobs: snapshot.evolution.recentJobs,
        });
      }
      return jsonResponse({ ok: false }, { status: 404 });
    });

    render(
      <MemoryApp
        fetchApi={fetchApi}
        locale="en"
        initialWorkspaceId="ws-alpha"
      />
    );

    await waitFor(() => {
      expect(
        screen.getByText('Enable lock timeout on migrations')
      ).toBeTruthy();
    });

    expect(
      requestedPaths.some((p) => p.startsWith('/api/dsh-memory/stats'))
    ).toBe(true);
    expect(
      requestedPaths.some((p) => p.startsWith('/api/dsh-memory/health'))
    ).toBe(true);
    expect(
      requestedPaths.some((p) => p.startsWith('/api/dsh-memory/core-memory'))
    ).toBe(true);
    expect(
      requestedPaths.some((p) => p.startsWith('/api/dsh-memory/memories?'))
    ).toBe(true);
    expect(
      requestedPaths.some((p) => p === '/api/dsh-memory/evolution?lite=1')
    ).toBe(true);

    expect(screen.getByText('A · 94')).toBeTruthy();
    expect(screen.getByText('Human · Profile')).toBeTruthy();
    expect(screen.getByText('sess-42:turn-9')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows offline banner on HTTP 500 and never displays fake A+ · 100 or running status', async () => {
    const fetchApi = vi.fn(async (path: string): Promise<Response> => {
      if (path.startsWith('/api/dsh-memory/studio-snapshot')) {
        return jsonResponse(
          { ok: false, error: 'Internal Server Error' },
          { status: 500 }
        );
      }
      return jsonResponse({ ok: false }, { status: 500 });
    });

    const { container } = render(
      <MemoryApp fetchApi={fetchApi} locale="en" />
    );

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Unable to reach memory service');
    expect(alert.textContent).toContain('HTTP 500');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByText('Memory service unreachable')).toBeTruthy();

    // Must never fabricate healthy running state or fake A+ · 100 score
    const bodyText = container.textContent ?? '';
    expect(bodyText).not.toContain('A+ · 100');
    expect(bodyText).not.toContain('Health A+');
    expect(bodyText).not.toContain('Autonomous loop active');
  });

  it('supports bilingual i18n: English renders zero hardcoded Chinese, Chinese renders Chinese labels', async () => {
    const snapshot = createSnapshot();
    const fetchApi = vi.fn(async (path: string): Promise<Response> => {
      if (path.startsWith('/api/dsh-memory/config')) {
        return jsonResponse({ ok: true, config: createLlmConfig() });
      }
      return jsonResponse(snapshot, { headers: { ETag: snapshot.etag } });
    });

    const enRender = render(
      <MemoryApp
        fetchApi={fetchApi}
        locale="en"
        initialWorkspaceId="ws-alpha"
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Long-Term Memory')).toBeTruthy();
    });

    expect(screen.getAllByText('Active Memories').length).toBe(2);
    expect(screen.getByText('Model Settings')).toBeTruthy();
    expect(screen.getByText('Slow-Loop Jobs')).toBeTruthy();
    expect(screen.getByText('Core Memory · Stable Layer')).toBeTruthy();
    // Verify zero hardcoded Chinese characters anywhere in English DOM
    expect(enRender.container.textContent ?? '').not.toMatch(/[\u4e00-\u9fff]/);

    enRender.unmount();

    render(
      <MemoryApp
        fetchApi={fetchApi}
        locale="zh"
        initialWorkspaceId="ws-alpha"
      />
    );

    await waitFor(() => {
      expect(screen.getByText('长期记忆')).toBeTruthy();
    });

    expect(screen.getByText('全自动闭环运行中')).toBeTruthy();
    expect(screen.getByText('模型配置')).toBeTruthy();
    expect(screen.getByText('生效记忆')).toBeTruthy();
    expect(screen.getByText('常驻核心记忆 · Core Memory')).toBeTruthy();
    expect(screen.getByText('活跃记忆流 · Active Memories')).toBeTruthy();
    expect(screen.getByText('后台自治流水 · Slow-Loop Jobs')).toBeTruthy();
  });

  it('switches workspaceId query parameter via multi-workspace selector when > 1 workspace is returned', async () => {
    const workspaces = [
      { workspaceId: 'ws-alpha', path: '/repos/alpha', activeMemories: 10 },
      { workspaceId: 'ws-beta', path: '/repos/beta', activeMemories: 4 },
    ];
    const snapshotUrls: string[] = [];

    const fetchApi = vi.fn(async (path: string): Promise<Response> => {
      if (path.startsWith('/api/dsh-memory/config')) {
        return jsonResponse({ ok: true, config: createLlmConfig() });
      }
      if (path.startsWith('/api/dsh-memory/studio-snapshot')) {
        snapshotUrls.push(path);
        const url = new URL(path, 'http://localhost');
        const ws = url.searchParams.get('workspaceId') || 'ws-alpha';
        const summary =
          ws === 'ws-beta' ? 'Beta workspace deployment note' : 'Alpha note';
        return jsonResponse(
          createSnapshot({
            workspaceId: ws,
            workspaces,
            memories: {
              total: 1,
              limit: 60,
              offset: 0,
              items: [createMemoryItem({ id: `m_${ws}_001`, summary })],
            },
          })
        );
      }
      return jsonResponse({ ok: false }, { status: 404 });
    });

    render(
      <MemoryApp
        fetchApi={fetchApi}
        locale="en"
        initialWorkspaceId="ws-alpha"
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Alpha note')).toBeTruthy();
    });

    const select = screen.getByLabelText(
      'Switch workspace'
    ) as HTMLSelectElement;
    expect(select.options.length).toBe(2);
    expect(select.value).toBe('ws-alpha');

    fireEvent.change(select, { target: { value: 'ws-beta' } });

    await waitFor(() => {
      expect(screen.getByText('Beta workspace deployment note')).toBeTruthy();
    });

    expect(
      snapshotUrls.some((url) => url.includes('workspaceId=ws-beta'))
    ).toBe(true);
  });

  it('debounces search query with ?q=... and loads pagination offset=60 when total > items.length', async () => {
    const firstPage: MemoryItem[] = Array.from({ length: 60 }, (_, idx) =>
      createMemoryItem({
        id: `m_page1_${String(idx).padStart(4, '0')}`,
        summary: `First page memory #${idx + 1}`,
        content: `Content for memory #${idx + 1}`,
      })
    );
    const secondPage: MemoryItem[] = Array.from({ length: 25 }, (_, idx) =>
      createMemoryItem({
        id: `m_page2_${String(idx).padStart(4, '0')}`,
        summary: `Second page memory #${idx + 61}`,
        content: `Loaded via pagination #${idx + 61}`,
      })
    );

    const requestedUrls: string[] = [];

    const fetchApi = vi.fn(async (path: string): Promise<Response> => {
      requestedUrls.push(path);
      if (path.startsWith('/api/dsh-memory/config')) {
        return jsonResponse({ ok: true, config: createLlmConfig() });
      }
      if (path.startsWith('/api/dsh-memory/studio-snapshot')) {
        const url = new URL(path, 'http://localhost');
        const q = url.searchParams.get('q');
        if (q) {
          return jsonResponse(
            createSnapshot({
              memories: {
                total: 1,
                limit: 60,
                offset: 0,
                items: [
                  createMemoryItem({
                    id: 'm_search_hit1',
                    summary: `Matched query: ${q}`,
                    content: `Detailed ${q} guidance`,
                  }),
                ],
              },
            })
          );
        }
        return jsonResponse(
          createSnapshot({
            memories: {
              total: 85,
              limit: 60,
              offset: 0,
              items: firstPage,
            },
          })
        );
      }
      if (path.startsWith('/api/dsh-memory/memories?')) {
        return jsonResponse({
          ok: true,
          items: secondPage,
          total: 85,
        });
      }
      return jsonResponse({ ok: false }, { status: 404 });
    });

    render(
      <MemoryApp
        fetchApi={fetchApi}
        locale="en"
        initialWorkspaceId="ws-alpha"
      />
    );

    // Wait for initial 60 items and load-more button for remaining 25
    const loadMoreBtn = await screen.findByRole('button', {
      name: 'Load more (25 remaining)',
    });
    fireEvent.click(loadMoreBtn);

    await waitFor(() => {
      expect(screen.getByText('Second page memory #61')).toBeTruthy();
    });

    const paginationUrl = requestedUrls.find((u) =>
      u.startsWith('/api/dsh-memory/memories?')
    );
    expect(paginationUrl).toBeDefined();
    expect(paginationUrl).toContain('offset=60');
    expect(paginationUrl).toContain('limit=60');
    expect(
      screen.queryByRole('button', { name: /Load more/ })
    ).toBeNull();

    // Debounced search query sends ?q=postgres after 250ms
    const searchInput = screen.getByLabelText('Search active memories');
    fireEvent.change(searchInput, { target: { value: 'postgres' } });

    // Immediately after typing, server request with q=postgres has not fired yet
    expect(
      requestedUrls.some((u) => u.includes('q=postgres'))
    ).toBe(false);

    await waitFor(
      () => {
        expect(
          requestedUrls.some(
            (u) =>
              u.startsWith('/api/dsh-memory/studio-snapshot') &&
              u.includes('q=postgres')
          )
        ).toBe(true);
      },
      { timeout: 1500 }
    );

    await waitFor(() => {
      expect(screen.getByText('Matched query: postgres')).toBeTruthy();
    });
  });

  it('aborts in-flight fetch via AbortSignal on unmount without state leaks', async () => {
    const signals: AbortSignal[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const fetchApi = vi.fn(
      (_path: string, init?: RequestInit): Promise<Response> => {
        if (init?.signal) {
          signals.push(init.signal);
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const abortErr = new Error('The operation was aborted.');
            abortErr.name = 'AbortError';
            reject(abortErr);
          });
        });
      }
    );

    const { unmount } = render(
      <MemoryApp
        fetchApi={fetchApi}
        locale="en"
        initialWorkspaceId="ws-alpha"
      />
    );

    await waitFor(() => {
      expect(signals.length).toBeGreaterThanOrEqual(2);
    });
    expect(signals.every((s) => !s.aborted)).toBe(true);

    unmount();

    expect(signals.every((s) => s.aborted)).toBe(true);
    // Allow microtasks from aborted promise rejections to flush
    await Promise.resolve();
    await Promise.resolve();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('MemoryErrorBoundary catches a render crash and shows localized fallback UI', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    let shouldThrow = true;
    function UnstablePanel(): React.ReactNode {
      if (shouldThrow) {
        throw new Error('Simulated studio crash');
      }
      return <div>Studio recovered</div>;
    }

    const { unmount } = render(
      <MemoryErrorBoundary locale="en">
        <UnstablePanel />
      </MemoryErrorBoundary>
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Memory Studio encountered an error');
    expect(alert.textContent).toContain('Simulated studio crash');

    // Clicking Reload Studio resets boundary when child stops crashing
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reload Studio' }));
    expect(screen.getByText('Studio recovered')).toBeTruthy();

    unmount();

    // Verify localized Chinese fallback
    shouldThrow = true;
    render(
      <MemoryErrorBoundary locale="zh">
        <UnstablePanel />
      </MemoryErrorBoundary>
    );

    const zhAlert = screen.getByRole('alert');
    expect(zhAlert.textContent).toContain('记忆面板渲染遇到异常');
    expect(
      screen.getByRole('button', { name: '重新加载面板' })
    ).toBeTruthy();
  });
});
