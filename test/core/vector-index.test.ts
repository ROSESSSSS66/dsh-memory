import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { openDb } from '../../src/core/db.js';
import { validateConfig, type PluginConfig } from '../../src/config.js';
import type { Db, Scope } from '../../src/types.js';
import {
  computeLocalEmbedding,
  encodeEmbeddingBlob,
  decodeEmbeddingBlob,
  primeRuntimeVectorCache,
  removeCachedRuntimeEmbedding,
  backfillRemoteEmbeddingsAsync,
  DEFAULT_LOCAL_VECTOR_DIM,
} from '../../src/core/vector.js';
import {
  searchWorkspaceVectors,
  upsertVectorIndexEntry,
  removeVectorIndexEntry,
  invalidateVectorIndex,
  getVectorIndexStats,
} from '../../src/core/vector-index.js';
import {
  getActiveEmbeddingMeta,
  isRemoteEmbeddingEnabled,
  fetchRemoteEmbeddings,
  embedQueryWithFallback,
  resolveEmbeddingsEndpointUrl,
} from '../../src/core/embedding-client.js';
import { workspaceId } from '../../src/core/scope.js';

function insertRawMemory(
  db: Db,
  opts: {
    id: string;
    type?: string;
    status?: string;
    scope?: Scope;
    workspace_id?: string | null;
    session_id?: string | null;
    content?: string;
    summary?: string;
    utility?: number;
    pinned?: number;
    updated_at?: number;
    embedding?: Uint8Array | null;
  }
): void {
  const scope = opts.scope ?? 'workspace';
  const ws = scope === 'user' || scope === 'global' ? null : opts.workspace_id ?? 'ws_default';
  const sid = scope === 'session' ? opts.session_id ?? 'sess_default' : null;
  const content = opts.content ?? `memory content ${opts.id}`;
  const summary = opts.summary ?? `summary ${opts.id}`;
  const now = opts.updated_at ?? Date.now();
  db.run(
    `INSERT INTO memories (
      id, type, status, content, summary, slot_key, scope, workspace_id, session_id,
      origin_kinds, source_kind, confidence, utility, use_count, success_count, fail_count,
      token_cost, summary_cost, hash, version, content_rev, pinned, created_at, updated_at,
      importance, embedding
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, '["user"]', 'user', 0.9, ?, 0, 0, 0, 10, 5, ?, 1, 1, ?, ?, ?, 5, ?)`,
    [
      opts.id,
      opts.type ?? 'semantic',
      opts.status ?? 'active',
      content,
      summary,
      scope,
      ws,
      sid,
      opts.utility ?? 0.5,
      `hash_${opts.id}`,
      opts.pinned ?? 0,
      now,
      now,
      opts.embedding === undefined ? null : opts.embedding,
    ]
  );
}

function makeUnitBasisVec(dim: number, index: number, secondaryIndex?: number): Float32Array {
  const v = new Float32Array(dim);
  v[index % dim] = 1.0;
  if (secondaryIndex !== undefined && secondaryIndex % dim !== index % dim) {
    v[index % dim] = Math.SQRT1_2;
    v[secondaryIndex % dim] = Math.SQRT1_2;
  }
  return v;
}

describe('Per-Workspace Lazy In-Memory Vector Matrix (src/core/vector-index.ts)', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('scans 10,000 × 128D vectors in <5ms and finds vector #9,500 missed by Top-400', () => {
    const ws = workspaceId('/bench/ws-10k');
    const dim = DEFAULT_LOCAL_VECTOR_DIM;

    // Target query vector lives exclusively in dimensions 120..127
    const targetVec = new Float32Array(dim);
    for (let k = 120; k < 128; k++) targetVec[k] = 1 / Math.sqrt(8);

    // Background noise vectors live exclusively in dimensions 0..119 (orthogonal to targetVec!)
    const noiseVecs: Uint8Array[] = [];
    for (let b = 0; b < 60; b++) {
      const nv = new Float32Array(dim);
      nv[b * 2] = Math.SQRT1_2;
      nv[b * 2 + 1] = Math.SQRT1_2;
      noiseVecs.push(encodeEmbeddingBlob(nv));
    }

    const targetBlob = encodeEmbeddingBlob(targetVec);

    db.transaction(() => {
      const stmt = db.prepare(
        `INSERT INTO memories (
          id, type, status, content, summary, slot_key, scope, workspace_id, session_id,
          origin_kinds, source_kind, confidence, utility, use_count, success_count, fail_count,
          token_cost, summary_cost, hash, version, content_rev, pinned, created_at, updated_at,
          importance, embedding
        ) VALUES (?, 'semantic', 'active', ?, ?, NULL, 'workspace', ?, NULL,
          '["user"]', 'user', 0.8, ?, 0, 0, 0, 10, 5, ?, 1, 1, ?, ?, ?, 5, ?)`
      );

      for (let i = 0; i < 10_000; i++) {
        const id = `m_${String(i).padStart(5, '0')}`;
        const isTarget = i === 9500;
        // Put high utility/recent timestamp on first 9,499 rows and very low utility/old timestamp on #9,500
        // so any Top-400 SQL prefilter (ORDER BY pinned DESC, utility DESC, updated_at DESC) would completely miss #9,500!
        const utility = isTarget ? 0.01 : 0.9 - (i % 100) * 0.001;
        const pinned = !isTarget && i < 500 ? 1 : 0;
        const ts = isTarget ? 1_000_000 : 2_000_000 + i;
        stmt.run(
          id,
          `doc ${id}`,
          `sum ${id}`,
          ws,
          utility,
          `h_${id}`,
          pinned,
          ts,
          ts,
          isTarget ? targetBlob : noiseVecs[i % noiseVecs.length]
        );
      }
    });

    // Cold search: lazily loads all 10,000 vectors in ws partition and finds #9,500 at rank #1
    const coldHits = searchWorkspaceVectors(db, { workspaceId: ws }, targetVec, {
      limit: 10,
      minScore: 0.9,
    });
    expect(coldHits.length).toBe(1);
    expect(coldHits[0].id).toBe('m_09500');
    expect(coldHits[0].score).toBeCloseTo(1.0, 5);

    const stats = getVectorIndexStats(db);
    expect(stats.totalVectors).toBe(10_000);
    expect(stats.dims[128]).toBe(10_000);

    // Warm scan benchmark: average over 10 scans must be well under 5ms
    const runs = 10;
    const t0 = performance.now();
    let lastHits: Array<{ id: string; score: number }> = [];
    for (let r = 0; r < runs; r++) {
      lastHits = searchWorkspaceVectors(db, { workspaceId: ws }, targetVec, {
        limit: 20,
        minScore: 0.5,
      });
    }
    const avgMs = (performance.now() - t0) / runs;
    expect(lastHits[0]?.id).toBe('m_09500');
    expect(avgMs).toBeLessThan(5);
  });

  it('enforces lazy partition loading, scope isolation, status/type/exclude filters, and NULL embedding fallback', () => {
    const wsA = workspaceId('/test/ws-a');
    const wsB = workspaceId('/test/ws-b');

    const vShared = makeUnitBasisVec(128, 1);
    const vWsA = makeUnitBasisVec(128, 1);
    const vWsB = makeUnitBasisVec(128, 1);
    const vSess1 = makeUnitBasisVec(128, 1);
    const vSess2 = makeUnitBasisVec(128, 1);

    insertRawMemory(db, { id: 'm_user', scope: 'user', embedding: encodeEmbeddingBlob(vShared), type: 'preference' });
    insertRawMemory(db, { id: 'm_global', scope: 'global', embedding: encodeEmbeddingBlob(vShared), type: 'semantic' });
    insertRawMemory(db, { id: 'm_wsA_active', scope: 'workspace', workspace_id: wsA, embedding: encodeEmbeddingBlob(vWsA), type: 'procedural' });
    insertRawMemory(db, { id: 'm_wsA_frozen', scope: 'workspace', workspace_id: wsA, status: 'frozen', embedding: encodeEmbeddingBlob(vWsA), type: 'semantic' });
    insertRawMemory(db, { id: 'm_wsA_archived', scope: 'workspace', workspace_id: wsA, status: 'archived', embedding: encodeEmbeddingBlob(vWsA) });
    insertRawMemory(db, { id: 'm_wsA_meta', scope: 'workspace', workspace_id: wsA, type: 'meta', embedding: encodeEmbeddingBlob(vWsA) });
    insertRawMemory(db, { id: 'm_wsB', scope: 'workspace', workspace_id: wsB, embedding: encodeEmbeddingBlob(vWsB) });
    insertRawMemory(db, { id: 'm_sess1', scope: 'session', workspace_id: wsA, session_id: 's1', embedding: encodeEmbeddingBlob(vSess1) });
    insertRawMemory(db, { id: 'm_sess2', scope: 'session', workspace_id: wsA, session_id: 's2', embedding: encodeEmbeddingBlob(vSess2) });
    insertRawMemory(db, {
      id: 'm_wsA_null',
      scope: 'workspace',
      workspace_id: wsA,
      content: 'Rust async tokio runtime configuration',
      summary: 'Tokio runtime config',
      embedding: null,
    });

    // Search wsA without sessionId -> must NOT load wsB or any session partition
    const hitsNoSess = searchWorkspaceVectors(db, { workspaceId: wsA }, vWsA, {
      limit: 20,
      minScore: 0.9,
    });
    const idsNoSess = new Set(hitsNoSess.map((h) => h.id));
    expect(idsNoSess).toEqual(new Set(['m_user', 'm_global', 'm_wsA_active', 'm_wsA_frozen']));
    expect(getVectorIndexStats(db).loadedPartitions).not.toContain(`ws:${wsB}`);

    // Search wsA with sessionId='s1' -> includes s1, excludes s2 and wsB
    const hitsS1 = searchWorkspaceVectors(db, { workspaceId: wsA, sessionId: 's1' }, vWsA, {
      limit: 20,
      minScore: 0.9,
    });
    expect(new Set(hitsS1.map((h) => h.id))).toEqual(
      new Set(['m_user', 'm_global', 'm_wsA_active', 'm_wsA_frozen', 'm_sess1'])
    );

    // allowedTypes and excludeIds filters
    const filteredHits = searchWorkspaceVectors(db, { workspaceId: wsA, sessionId: 's1' }, vWsA, {
      limit: 20,
      minScore: 0.9,
      allowedTypes: new Set(['procedural', 'preference']),
      excludeIds: new Set(['m_user']),
    });
    expect(filteredHits.map((h) => h.id)).toEqual(['m_wsA_active']);

    // NULL embedding row computed on-the-fly during lazy load
    const nullQuery = computeLocalEmbedding('Rust async tokio runtime configuration');
    const nullHits = searchWorkspaceVectors(db, { workspaceId: wsA }, nullQuery, {
      limit: 5,
      minScore: 0.65,
    });
    expect(nullHits[0]?.id).toBe('m_wsA_null');
  });

  it('supports O(1) incremental upsert, swap-with-last removal, cache sync hooks, and mixed dimensions', () => {
    const ws = workspaceId('/test/ws-sync');
    const v0 = makeUnitBasisVec(128, 0);
    const v1 = makeUnitBasisVec(128, 1);
    const v2 = makeUnitBasisVec(128, 2);

    insertRawMemory(db, { id: 'm_0', scope: 'workspace', workspace_id: ws, embedding: encodeEmbeddingBlob(v0) });
    insertRawMemory(db, { id: 'm_1', scope: 'workspace', workspace_id: ws, embedding: encodeEmbeddingBlob(v1) });
    insertRawMemory(db, { id: 'm_2', scope: 'workspace', workspace_id: ws, embedding: encodeEmbeddingBlob(v2) });

    // Trigger initial lazy load
    expect(searchWorkspaceVectors(db, { workspaceId: ws }, v1, { minScore: 0.9 })[0]?.id).toBe('m_1');

    // O(1) swap-with-last removal of middle entry m_1; m_0 and m_2 must stay completely intact!
    removeVectorIndexEntry(db, 'm_1');
    expect(searchWorkspaceVectors(db, { workspaceId: ws }, v1, { minScore: 0.9 })).toEqual([]);
    expect(searchWorkspaceVectors(db, { workspaceId: ws }, v0, { minScore: 0.9 })[0]?.id).toBe('m_0');
    expect(searchWorkspaceVectors(db, { workspaceId: ws }, v2, { minScore: 0.9 })[0]?.id).toBe('m_2');

    // Incremental upsert of a new 64D vector (mixed dim in same partition!)
    const v64 = makeUnitBasisVec(64, 5);
    upsertVectorIndexEntry(
      db,
      { id: 'm_remote_64', scope: 'workspace', workspace_id: ws, status: 'active', type: 'semantic' },
      v64
    );
    expect(searchWorkspaceVectors(db, { workspaceId: ws }, v64, { minScore: 0.9 })[0]?.id).toBe('m_remote_64');
    // Strict providerDim mismatch returns []
    expect(searchWorkspaceVectors(db, { workspaceId: ws }, v64, { providerDim: 128 })).toEqual([]);
    // 128D vectors remain unaffected
    expect(searchWorkspaceVectors(db, { workspaceId: ws }, v2, { minScore: 0.9 })[0]?.id).toBe('m_2');

    // primeRuntimeVectorCache with db syncs into loaded matrix; removeCachedRuntimeEmbedding removes it
    const v3 = makeUnitBasisVec(128, 3);
    insertRawMemory(db, { id: 'm_3', scope: 'workspace', workspace_id: ws, embedding: encodeEmbeddingBlob(v3) });
    primeRuntimeVectorCache('m_3', 'hash_m_3', v3, db);
    expect(searchWorkspaceVectors(db, { workspaceId: ws }, v3, { minScore: 0.9 })[0]?.id).toBe('m_3');

    removeCachedRuntimeEmbedding('m_3', db);
    expect(searchWorkspaceVectors(db, { workspaceId: ws }, v3, { minScore: 0.9 })).toEqual([]);

    invalidateVectorIndex(db);
    expect(getVectorIndexStats(db).loadedPartitions).toEqual([]);
  });

  it('detects unhooked same-connection writes and cross-connection PRAGMA data_version writes', () => {
    const ws = workspaceId('/test/ws-external');
    const vA = makeUnitBasisVec(128, 10);
    const vB = makeUnitBasisVec(128, 11);

    // 1. Same-connection unhooked write detection
    insertRawMemory(db, { id: 'm_a', scope: 'workspace', workspace_id: ws, embedding: encodeEmbeddingBlob(vA) });
    expect(searchWorkspaceVectors(db, { workspaceId: ws }, vA, { minScore: 0.9 })[0]?.id).toBe('m_a');

    // Direct SQL insert bypassing hooks
    insertRawMemory(db, { id: 'm_b', scope: 'workspace', workspace_id: ws, embedding: encodeEmbeddingBlob(vB) });
    expect(searchWorkspaceVectors(db, { workspaceId: ws }, vB, { minScore: 0.9 })[0]?.id).toBe('m_b');

    // Direct SQL delete bypassing hooks
    db.run('DELETE FROM memories WHERE id = ?', ['m_a']);
    expect(searchWorkspaceVectors(db, { workspaceId: ws }, vA, { minScore: 0.9 })).toEqual([]);

    // 2. Real two-connection file-backed SQLite PRAGMA data_version sync
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vec-idx-'));
    const dbPath = path.join(tmpDir, 'shared.db');
    let db1: Db | undefined;
    let db2: Db | undefined;
    try {
      db1 = openDb(dbPath);
      db2 = openDb(dbPath);

      insertRawMemory(db1, { id: 'm_conn1', scope: 'workspace', workspace_id: ws, embedding: encodeEmbeddingBlob(vA) });
      expect(searchWorkspaceVectors(db1, { workspaceId: ws }, vA, { minScore: 0.9 })[0]?.id).toBe('m_conn1');

      // Second independent connection writes a new row
      insertRawMemory(db2, { id: 'm_conn2', scope: 'workspace', workspace_id: ws, embedding: encodeEmbeddingBlob(vB) });

      // db1 detects PRAGMA data_version change and reloads automatically!
      const hitsAfterExternal = searchWorkspaceVectors(db1, { workspaceId: ws }, vB, { minScore: 0.9 });
      expect(hitsAfterExternal[0]?.id).toBe('m_conn2');
    } finally {
      db1?.close();
      db2?.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('OpenAI-Compatible Remote Embedding Client & Async Backfill (Option A)', () => {
  const baseRemoteCfg = (overrides: Partial<PluginConfig> = {}): PluginConfig =>
    validateConfig({
      embedding: {
        provider: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        model: 'text-embedding-3-small',
        apiKeyEnv: '',
        apiKey: 'sk-test-embed-key',
        dim: 8,
        batchSize: 2,
        timeoutMs: 5000,
      },
      privacy: {
        offlineConsent: true,
        allowedOfflineEndpoints: ['https://api.example.com'],
      },
      ...overrides,
    });

  it('normalizes endpoint URLs and evaluates enablement & active provider metadata', () => {
    expect(resolveEmbeddingsEndpointUrl('https://api.openai.com')?.toString()).toBe(
      'https://api.openai.com/v1/embeddings'
    );
    expect(resolveEmbeddingsEndpointUrl('https://api.openai.com/v1/')?.toString()).toBe(
      'https://api.openai.com/v1/embeddings'
    );
    expect(resolveEmbeddingsEndpointUrl('https://api.openai.com/v1/embeddings')?.toString()).toBe(
      'https://api.openai.com/v1/embeddings'
    );

    const localCfg = validateConfig({});
    expect(isRemoteEmbeddingEnabled(localCfg)).toBe(false);
    expect(getActiveEmbeddingMeta(localCfg).provider).toBe('local');
    expect(getActiveEmbeddingMeta(localCfg).dim).toBe(DEFAULT_LOCAL_VECTOR_DIM);

    const unconsentedCfg = baseRemoteCfg({
      privacy: { offlineConsent: false, allowedOfflineEndpoints: ['https://api.example.com'] },
    });
    expect(isRemoteEmbeddingEnabled(unconsentedCfg)).toBe(false);
    expect(getActiveEmbeddingMeta(unconsentedCfg).provider).toBe('local');

    const enabledCfg = baseRemoteCfg();
    expect(isRemoteEmbeddingEnabled(enabledCfg)).toBe(true);
    const meta = getActiveEmbeddingMeta(enabledCfg);
    expect(meta.provider).toBe('openai-compatible');
    expect(meta.dim).toBe(8);
    expect(meta.signature).toContain('text-embedding-3-small');
  });

  it('fetches, redacts secrets, reorders by index, validates dims, and L2-normalizes remote embeddings', async () => {
    const cfg = baseRemoteCfg();
    let capturedUrl = '';
    let capturedAuth = '';
    let capturedBody: any = null;

    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      const headers = init?.headers as Record<string, string>;
      capturedAuth = headers?.Authorization || '';
      capturedBody = JSON.parse(String(init?.body || '{}'));
      // Return unnormalized vectors OUT OF ORDER (index 1 before index 0)
      return new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0, 3, 4, 0, 0, 0, 0, 0] },
            { index: 0, embedding: [2, 0, 0, 0, 0, 0, 0, 0] },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const res = await fetchRemoteEmbeddings(
      ['api key is sk-proj-1234567890abcdefghijklmnop', 'second query text'],
      cfg,
      { fetchFn: mockFetch }
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(capturedUrl).toBe('https://api.example.com/v1/embeddings');
    expect(capturedAuth).toBe('Bearer sk-test-embed-key');
    expect(capturedBody.model).toBe('text-embedding-3-small');
    expect(capturedBody.dimensions).toBe(8);
    // Secret must be redacted before leaving process!
    expect(capturedBody.input[0]).toContain('[REDACTED:API_KEY]');
    expect(capturedBody.input[0]).not.toContain('sk-proj-1234567890');

    expect(res.dim).toBe(8);
    expect(res.vectors).toHaveLength(2);
    // index 0: [2,0,...] -> L2 normalized to [1,0,...]
    expect(res.vectors[0][0]).toBeCloseTo(1.0, 5);
    // index 1: [0,3,4,...] -> L2 normalized to [0,0.6,0.8,...]
    expect(res.vectors[1][1]).toBeCloseTo(0.6, 5);
    expect(res.vectors[1][2]).toBeCloseTo(0.8, 5);
  });

  it('enforces SSRF, DNS rebinding, redirect, size cap, same-origin key fallback, and bad-vector checks', async () => {
    // 1. Metadata IP blocked even if allowlisted
    const imdsCfg = baseRemoteCfg({
      embedding: {
        provider: 'openai-compatible',
        baseURL: 'http://169.254.169.254/v1',
        model: 'm',
        apiKeyEnv: '',
        apiKey: 'k',
        dim: 8,
      },
      privacy: { offlineConsent: true, allowedOfflineEndpoints: ['http://169.254.169.254'] },
    });
    const imdsRes = await fetchRemoteEmbeddings(['hello'], imdsCfg, {
      fetchFn: async () => new Response('{}'),
    });
    expect(imdsRes.ok).toBe(false);

    // 2. DNS rebinding blocked when lookupFn resolves to link-local metadata IP
    const dnsRebindRes = await fetchRemoteEmbeddings(['hello'], baseRemoteCfg(), {
      fetchFn: async () => new Response('{}'),
      lookupFn: async () => [{ address: '169.254.169.254' }],
    });
    expect(dnsRebindRes).toEqual({ ok: false, reason: 'blocked_resolved_ip' });

    // 3. 3xx Redirect rejected
    const redirectRes = await fetchRemoteEmbeddings(['hello'], baseRemoteCfg(), {
      fetchFn: async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }),
    });
    expect(redirectRes).toEqual({ ok: false, reason: 'redirect_not_allowed' });

    // 4. Streaming 8 MB response cap enforced
    const oversizedRes = await fetchRemoteEmbeddings(['hello'], baseRemoteCfg(), {
      fetchFn: async () => {
        const chunk = new Uint8Array(1024 * 1024); // 1 MB chunk
        let sent = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= 9) {
              controller.close();
              return;
            }
            sent++;
            controller.enqueue(chunk);
          },
        });
        return new Response(stream, { status: 200 });
      },
    });
    expect(oversizedRes).toEqual({ ok: false, reason: 'response_too_large' });

    // 5. Dimension mismatch / non-finite vector rejected
    const badDimRes = await fetchRemoteEmbeddings(['hello'], baseRemoteCfg(), {
      fetchFn: async () =>
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }), { status: 200 }),
    });
    expect(badDimRes).toEqual({ ok: false, reason: 'invalid_embedding_vector' });

    // 6. Same-origin fallback to offlineLLM apiKey allowed, cross-origin blocked
    let seenAuth = '';
    const sameOriginCfg = baseRemoteCfg({
      embedding: {
        provider: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        model: 'text-embedding-3-small',
        apiKeyEnv: 'AWS_SECRET_ACCESS_KEY', // unsafe env name must be ignored!
        apiKey: '',
        dim: 4,
      },
      offlineLLM: {
        useDshLlm: false,
        baseURL: 'https://api.example.com/v1',
        model: 'gpt-4o-mini',
        apiKeyEnv: '',
        apiKey: 'same-origin-secret',
      },
    });
    await fetchRemoteEmbeddings(['hello'], sameOriginCfg, {
      fetchFn: async (_u, init) => {
        seenAuth = (init?.headers as Record<string, string>)?.Authorization || '';
        return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] }), { status: 200 });
      },
    });
    expect(seenAuth).toBe('Bearer same-origin-secret');

    let crossOriginAuth = '';
    const crossOriginCfg = baseRemoteCfg({
      embedding: {
        provider: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        model: 'text-embedding-3-small',
        apiKeyEnv: '',
        apiKey: '',
        dim: 4,
      },
      offlineLLM: {
        useDshLlm: false,
        baseURL: 'https://other-host.example.com/v1',
        model: 'gpt-4o-mini',
        apiKeyEnv: '',
        apiKey: 'do-not-leak-cross-origin',
      },
    });
    await fetchRemoteEmbeddings(['hello'], crossOriginCfg, {
      fetchFn: async (_u, init) => {
        crossOriginAuth = (init?.headers as Record<string, string>)?.Authorization || '';
        return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] }), { status: 200 });
      },
    });
    expect(crossOriginAuth).toBe('');
  });

  it('embedQueryWithFallback uses remote vector when healthy and seamlessly falls back to local 128D on errors', async () => {
    const cfg = baseRemoteCfg();

    const remoteHit = await embedQueryWithFallback('database connection pool', cfg, {
      fetchFn: async () =>
        new Response(
          JSON.stringify({ data: [{ index: 0, embedding: [0, 0, 0, 4, 0, 0, 0, 0] }] }),
          { status: 200 }
        ),
    });
    expect(remoteHit.source).toBe('remote');
    expect(remoteHit.dim).toBe(8);
    expect(remoteHit.vec[3]).toBeCloseTo(1.0, 5);

    // HTTP 500 -> graceful local 128D fallback
    const fallback500 = await embedQueryWithFallback('database connection pool', cfg, {
      fetchFn: async () => new Response('internal error', { status: 500 }),
    });
    expect(fallback500.source).toBe('local');
    expect(fallback500.dim).toBe(DEFAULT_LOCAL_VECTOR_DIM);
    expect(fallback500.vec.length).toBe(DEFAULT_LOCAL_VECTOR_DIM);

    // Network exception -> graceful local 128D fallback
    const fallbackErr = await embedQueryWithFallback('database connection pool', cfg, {
      fetchFn: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(fallbackErr.source).toBe('local');
    expect(fallbackErr.dim).toBe(DEFAULT_LOCAL_VECTOR_DIM);

    // allowRemote: false -> local without calling fetch
    let fetchCalled = false;
    const localForced = await embedQueryWithFallback('database connection pool', cfg, {
      allowRemote: false,
      fetchFn: async () => {
        fetchCalled = true;
        return new Response('{}');
      },
    });
    expect(fetchCalled).toBe(false);
    expect(localForced.source).toBe('local');
  });

  it('backfillRemoteEmbeddingsAsync migrates batches, enforces excludeWorkspaces, persists provider sig, and updates WorkspaceVectorIndex', async () => {
    const db = openDb(':memory:');
    try {
      const wsPub = workspaceId('/test/ws-public');
      const wsPriv = workspaceId('/test/ws-private');

      const localV = computeLocalEmbedding('public memory alpha');
      insertRawMemory(db, { id: 'm_pub_1', scope: 'workspace', workspace_id: wsPub, content: 'public memory alpha', embedding: encodeEmbeddingBlob(localV) });
      insertRawMemory(db, { id: 'm_pub_2', scope: 'workspace', workspace_id: wsPub, content: 'public memory beta', embedding: encodeEmbeddingBlob(localV) });
      insertRawMemory(db, { id: 'm_pub_3', scope: 'workspace', workspace_id: wsPub, content: 'public memory gamma', embedding: encodeEmbeddingBlob(localV) });
      insertRawMemory(db, { id: 'm_priv_1', scope: 'workspace', workspace_id: wsPriv, content: 'top secret private memory', embedding: encodeEmbeddingBlob(localV) });

      // 1. Disabled/unconsented skips gracefully without touching existing local blobs
      const disabledRes = await backfillRemoteEmbeddingsAsync(db, validateConfig({}));
      expect(disabledRes).toEqual({ updated: 0, skipped: true, reason: 'provider_disabled' });

      // Pre-load vector index with local 128D vectors so we verify live matrix update on commit!
      expect(searchWorkspaceVectors(db, { workspaceId: wsPub }, localV, { minScore: 0.9 }).length).toBe(3);

      const cfg = baseRemoteCfg({
        excludeWorkspaces: ['/test/ws-private'],
      });

      const sentTexts: string[] = [];
      let callCount = 0;
      const mockFetch: typeof fetch = async (_url, init) => {
        callCount++;
        const body = JSON.parse(String(init?.body || '{}'));
        const inputs: string[] = body.input;
        sentTexts.push(...inputs);
        const data = inputs.map((txt, idx) => {
          const vec = new Array(8).fill(0);
          if (txt.includes('alpha')) vec[0] = 5;
          else if (txt.includes('beta')) vec[1] = 5;
          else vec[2] = 5;
          return { index: idx, embedding: vec };
        });
        return new Response(JSON.stringify({ data }), { status: 200 });
      };

      // 2. Resumable migration with limit = 2 (should migrate 2 of 3 public rows)
      const res1 = await backfillRemoteEmbeddingsAsync(db, cfg, { limit: 2, fetchFn: mockFetch });
      expect(res1).toEqual({ updated: 2, skipped: false });
      expect(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'embedding_provider_sig'")).toBeUndefined();

      // 3. Finish migration (1 remaining public row); private workspace must NEVER be sent!
      const res2 = await backfillRemoteEmbeddingsAsync(db, cfg, { limit: 10, fetchFn: mockFetch });
      expect(res2).toEqual({ updated: 1, skipped: false });
      expect(sentTexts.some((t) => t.includes('top secret private'))).toBe(false);

      const sigRow = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'embedding_provider_sig'");
      expect(sigRow?.value).toBe(getActiveEmbeddingMeta(cfg).signature);

      // Private row keeps its original 128D local blob untouched
      const privBlob = db.get<{ embedding: Uint8Array }>('SELECT embedding FROM memories WHERE id = ?', ['m_priv_1'])?.embedding;
      expect(decodeEmbeddingBlob(privBlob)?.length).toBe(DEFAULT_LOCAL_VECTOR_DIM);

      // Public rows now have 8D L2-normalized remote blobs and are immediately searchable via WorkspaceVectorIndex!
      const betaQuery = new Float32Array([0, 1, 0, 0, 0, 0, 0, 0]);
      const remoteHits = searchWorkspaceVectors(db, { workspaceId: wsPub }, betaQuery, { minScore: 0.9 });
      expect(remoteHits.map((h) => h.id)).toEqual(['m_pub_2']);

      // 4. Subsequent steady-state run makes ZERO HTTP calls
      const prevCalls = callCount;
      const res3 = await backfillRemoteEmbeddingsAsync(db, cfg, { limit: 10, fetchFn: mockFetch });
      expect(res3).toEqual({ updated: 0, skipped: false });
      expect(callCount).toBe(prevCalls);

      // 5. Switching model triggers re-migration automatically; offline failure keeps existing blobs intact
      const cfgV2 = baseRemoteCfg({
        excludeWorkspaces: ['/test/ws-private'],
        embedding: {
          ...cfg.embedding,
          model: 'text-embedding-3-large',
        },
      });
      const offlineRes = await backfillRemoteEmbeddingsAsync(db, cfgV2, {
        fetchFn: async () => new Response('service unavailable', { status: 503 }),
      });
      expect(offlineRes).toEqual({ updated: 0, skipped: true, reason: 'http_503' });
      // Existing 8D remote embeddings remain intact on failure!
      expect(searchWorkspaceVectors(db, { workspaceId: wsPub }, betaQuery, { minScore: 0.9 })[0]?.id).toBe('m_pub_2');
    } finally {
      db.close();
    }
  });
});
