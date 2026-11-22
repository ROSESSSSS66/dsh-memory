import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/core/db.js';
import { validateConfig, type PluginConfig } from '../../src/config.js';
import { workspaceId, rememberWorkspacePath } from '../../src/core/scope.js';
import { upsertCandidate, freeze, addRelation } from '../../src/core/writer.js';
import { get } from '../../src/core/store.js';
import type { Db, MemoryRecord } from '../../src/types.js';
import {
  WorkspaceExcludedError,
  resolveScopedContext,
  assertWorkspaceAllowed,
  listActiveWorkspaces,
  VALID_MEMORY_TYPES,
  normalizeMemoryType,
  editMemoryRecord,
  forgetWithTrash,
  getMemoryDetail,
  importJsonMemories,
  queryInjectionTelemetry7d,
  stripMemoryForApi,
  runUnifiedMaintenance,
  probeOfflineLLM,
  resetLlmProbeRateLimit,
} from '../../src/service/index.js';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-mem-svc-${prefix}-`));
}

function insertActiveMemory(
  db: Db,
  opts: {
    content: string;
    summary?: string;
    type?: MemoryRecord['type'];
    scope?: MemoryRecord['scope'];
    workspaceId?: string;
    sessionId?: string;
    slotKey?: string | null;
    now?: number;
    confidence?: number;
    entities?: string[];
  }
): string {
  const res = upsertCandidate(
    db,
    {
      type: opts.type ?? 'semantic',
      content: opts.content,
      summary: opts.summary,
      slot_key: opts.slotKey ?? null,
      scope: opts.scope ?? 'workspace',
      workspaceId: opts.workspaceId,
      sessionId: opts.sessionId,
      source_kind: 'user',
      origin_kinds: ['user'],
      confidence: opts.confidence ?? 0.9,
      status: 'active',
      actor: 'user',
      entities: opts.entities,
      sources: [
        {
          session_id: opts.sessionId || 'sess_seed',
          seq: Math.floor(Math.random() * 100000) + 1,
          kind: 'user',
        },
      ],
    },
    opts.now ?? Date.now()
  );
  if (!('id' in res)) {
    throw new Error(`Failed to seed memory: ${res.reason}`);
  }
  return res.id;
}

describe('Application Service Facade (src/service/)', () => {
  let db: Db;
  const tempDirs: string[] = [];

  beforeEach(() => {
    db = openDb(':memory:');
    resetLlmProbeRateLimit();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    resetLlmProbeRateLimit();
  });

  // -------------------------------------------------------------------------
  // 1. scope-guard.ts
  // -------------------------------------------------------------------------
  describe('scope-guard', () => {
    it('does not silently fall back to process.cwd() unless fallbackCwd is explicitly enabled', () => {
      const cfg = validateConfig({});
      const omitted = resolveScopedContext(undefined, '  sess_1  ', cfg);
      expect(omitted.rawWorkspace).toBeUndefined();
      expect(omitted.workspaceId).toBe('');
      expect(omitted.sessionId).toBe('sess_1');
      expect(omitted.excluded).toBe(false);

      const withFallback = resolveScopedContext(undefined, undefined, cfg, { fallbackCwd: true });
      expect(withFallback.rawWorkspace).toBe(process.cwd());
      expect(withFallback.workspaceId).toBe(workspaceId(process.cwd()));
      expect(withFallback.excluded).toBe(false);
    });

    it('detects exclusion by raw path, subdirectory prefix, 16-hex hash, and meta ws_path mapping', () => {
      const secretParent = makeTempDir('secret-parent');
      const secretChild = path.join(secretParent, 'sub-repo');
      fs.mkdirSync(secretChild, { recursive: true });
      tempDirs.push(secretParent);

      const childHash = rememberWorkspacePath(db, secretChild);
      const cfg = validateConfig({ excludeWorkspaces: [secretParent] });

      expect(resolveScopedContext(secretParent, undefined, cfg).excluded).toBe(true);
      expect(resolveScopedContext(secretChild, undefined, cfg).excluded).toBe(true);
      // Direct 16-hex hash with db resolves ws_path:* and detects parent directory exclusion
      expect(resolveScopedContext(childHash, undefined, cfg, { db }).excluded).toBe(true);

      const hashCfg = validateConfig({ excludeWorkspaces: [childHash] });
      expect(resolveScopedContext(secretChild, undefined, hashCfg).excluded).toBe(true);
      expect(resolveScopedContext(childHash, undefined, hashCfg).excluded).toBe(true);

      expect(() => assertWorkspaceAllowed(secretChild, cfg)).toThrow(WorkspaceExcludedError);
      try {
        assertWorkspaceAllowed(secretChild, cfg);
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceExcludedError);
        expect((err as WorkspaceExcludedError).code).toBe('WORKSPACE_EXCLUDED');
        expect((err as WorkspaceExcludedError).workspaceId).toBe(childHash);
      }
    });

    it('listActiveWorkspaces enumerates non-excluded workspaces from memories + ws_path:*', () => {
      const wsDirA = makeTempDir('ws-a');
      const wsDirB = makeTempDir('ws-b');
      const secretDir = makeTempDir('ws-secret');
      const secretSub = path.join(secretDir, 'nested');
      fs.mkdirSync(secretSub, { recursive: true });
      tempDirs.push(wsDirA, wsDirB, secretDir);

      const wsA = rememberWorkspacePath(db, wsDirA);
      const wsB = rememberWorkspacePath(db, wsDirB);
      const wsSecret = rememberWorkspacePath(db, secretSub);

      insertActiveMemory(db, { content: 'Workspace A rule 1', workspaceId: wsA });
      insertActiveMemory(db, { content: 'Workspace A rule 2', workspaceId: wsA });
      insertActiveMemory(db, { content: 'Secret workspace rule', workspaceId: wsSecret });

      // An unregistered workspace with only an archived memory should be omitted
      const archivedOnlyWs = workspaceId('/tmp/archived-only-workspace');
      const archivedId = insertActiveMemory(db, {
        content: 'Old archived memory',
        workspaceId: archivedOnlyWs,
      });
      db.run(`UPDATE memories SET status = 'archived' WHERE id = ?`, [archivedId]);

      const cfg = validateConfig({ excludeWorkspaces: [secretDir] });
      const list = listActiveWorkspaces(db, cfg);

      expect(list.map((w) => w.workspaceId)).toEqual([wsA, wsB]);
      expect(list[0]).toEqual({
        workspaceId: wsA,
        path: path.resolve(wsDirA),
        activeMemories: 2,
      });
      expect(list[1]).toEqual({
        workspaceId: wsB,
        path: path.resolve(wsDirB),
        activeMemories: 0,
      });
    });
  });

  // -------------------------------------------------------------------------
  // 2. memory-service.ts
  // -------------------------------------------------------------------------
  describe('memory-service', () => {
    it('normalizeMemoryType handles canonical types, aliases, and fallback', () => {
      expect(VALID_MEMORY_TYPES.size).toBe(8);
      expect(normalizeMemoryType('fact')).toBe('semantic');
      expect(normalizeMemoryType('PROCEDURE')).toBe('procedural');
      expect(normalizeMemoryType('pref')).toBe('preference');
      expect(normalizeMemoryType('skill')).toBe('procedural');
      expect(normalizeMemoryType('failure')).toBe('failure');
      expect(normalizeMemoryType('unknown_kind')).toBe('semantic');
      expect(normalizeMemoryType(null, 'episodic')).toBe('episodic');
    });

    it('editMemoryRecord enforces scope ownership, frozen guard, and core:* guard', () => {
      const wsA = workspaceId('/repo/alpha');
      const wsB = workspaceId('/repo/beta');

      const memA = insertActiveMemory(db, {
        content: 'Project Alpha uses Vitest for unit tests.',
        workspaceId: wsA,
      });
      const memB = insertActiveMemory(db, {
        content: 'Project Beta uses Jest for unit tests.',
        workspaceId: wsB,
      });

      // Cross-workspace edit blocked
      expect(() =>
        editMemoryRecord(db, memB, { content: 'Tampered Beta content' }, {
          actor: 'user',
          scopeCtx: { workspaceId: wsA },
        })
      ).toThrow('memory_not_found');

      // core:* assignment blocked (both lowercase and mixed case)
      expect(() =>
        editMemoryRecord(db, memA, { slot_key: 'core:project' }, {
          actor: 'user',
          scopeCtx: { workspaceId: wsA },
        })
      ).toThrow('cannot_assign_core_slot_key');

      expect(() =>
        editMemoryRecord(db, memA, { slot_key: 'CORE:human' }, {
          actor: 'user',
          scopeCtx: { workspaceId: wsA },
        })
      ).toThrow('cannot_assign_core_slot_key');

      // Valid edit succeeds
      const editRes = editMemoryRecord(
        db,
        memA,
        { content: 'Project Alpha uses Vitest 4 with NodeNext ESM.', importance: 9 },
        { actor: 'user', scopeCtx: { workspaceId: wsA } }
      );
      expect(editRes.ok).toBe(true);
      expect(editRes.version).toBe(2);
      expect(editRes.memory.importance).toBe(9);

      // Frozen guard blocks edit
      expect(freeze(db, memA, 'user')).toBe(true);
      expect(() =>
        editMemoryRecord(db, memA, { content: 'Should fail on frozen memory' }, {
          actor: 'user',
          scopeCtx: { workspaceId: wsA },
        })
      ).toThrow('memory_is_frozen');
    });

    it('forgetWithTrash refuses frozen, writes trash on success, and cleans up trash on failure', () => {
      const trashDir = makeTempDir('trash');
      tempDirs.push(trashDir);
      const wsA = workspaceId('/repo/alpha');
      const wsB = workspaceId('/repo/beta');

      const frozenId = insertActiveMemory(db, {
        content: 'Frozen architecture invariant for Alpha.',
        workspaceId: wsA,
      });
      freeze(db, frozenId, 'user');

      // Refuses frozen without writing .trash
      const frozenRes = forgetWithTrash(db, frozenId, {
        actor: 'user',
        scopeCtx: { workspaceId: wsA },
        trashDir,
      });
      expect(frozenRes.ok).toBe(false);
      expect(frozenRes.error).toBe('memory_is_frozen');
      expect(fs.readdirSync(trashDir)).toHaveLength(0);

      // Cross-workspace forget refused
      const betaId = insertActiveMemory(db, {
        content: 'Beta private workspace note.',
        workspaceId: wsB,
      });
      const crossRes = forgetWithTrash(db, betaId, {
        actor: 'user',
        scopeCtx: { workspaceId: wsA },
        trashDir,
      });
      expect(crossRes.ok).toBe(false);
      expect(crossRes.error).toBe('memory_not_found');

      // Happy path writes .trash and archives memory
      const activeId = insertActiveMemory(db, {
        content: 'Temporary Alpha build workaround.',
        workspaceId: wsA,
      });
      const okRes = forgetWithTrash(db, activeId, {
        actor: 'user',
        scopeCtx: { workspaceId: wsA },
        trashDir,
      });
      expect(okRes.ok).toBe(true);
      expect(okRes.id).toBe(activeId);
      expect(okRes.trashedPath).toBeTruthy();
      expect(fs.existsSync(okRes.trashedPath!)).toBe(true);
      expect(get(db, activeId)?.status).toBe('archived');

      // Cleanup on forget() failure: install a SQLite trigger that aborts archiving a specific row
      const failId = insertActiveMemory(db, {
        content: 'Protected row whose archive update fails via trigger.',
        workspaceId: wsA,
      });
      db.exec(`
        CREATE TRIGGER block_archive_fail_test
        BEFORE UPDATE OF status ON memories
        WHEN OLD.id = '${failId}' AND NEW.status = 'archived'
        BEGIN
          SELECT RAISE(ABORT, 'simulated_forget_failure');
        END;
      `);

      const failRes = forgetWithTrash(db, failId, {
        actor: 'user',
        scopeCtx: { workspaceId: wsA },
        trashDir,
      });
      expect(failRes.ok).toBe(false);
      expect(failRes.error).toContain('simulated_forget_failure');
      const orphanTrashPath = path.join(trashDir, `${failId}.md`);
      expect(fs.existsSync(orphanTrashPath)).toBe(false);
      expect(get(db, failId)?.status).toBe('active');
    });

    it('getMemoryDetail applies scopeFilterSQL and excludeWorkspaces to memory, relations, and hindsightTrace', () => {
      const wsA = workspaceId('/repo/alpha');
      const wsB = workspaceId('/repo/beta');
      const now = Date.now();

      const memA1 = insertActiveMemory(db, {
        content: 'Alpha database uses SQLite WAL mode.',
        workspaceId: wsA,
        entities: ['sqlite'],
        now,
      });
      const memA2 = insertActiveMemory(db, {
        content: 'Alpha sets busy_timeout=5000 before WAL.',
        workspaceId: wsA,
        now: now + 10,
      });
      const memB = insertActiveMemory(db, {
        content: 'Beta secret credentials policy.',
        workspaceId: wsB,
        now: now + 20,
      });
      const sessOther = insertActiveMemory(db, {
        content: 'Private session S2 scratch note in Alpha.',
        scope: 'session',
        workspaceId: wsA,
        sessionId: 'sess_2',
        now: now + 30,
      });

      // Add cross-workspace & cross-session relations to memA1
      addRelation(db, memA1, memA2, 'related', now);
      addRelation(db, memA1, memB, 'derived_from', now);
      addRelation(db, memA1, sessOther, 'contradicts', now);

      const detail = getMemoryDetail(db, memA1, {
        scopeCtx: { workspaceId: wsA, sessionId: 'sess_1' },
        excludeWorkspaces: [wsB],
      });

      expect(detail).not.toBeNull();
      expect(detail!.memory.id).toBe(memA1);
      expect(detail!.memory.embedding).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(detail!.memory, 'embedding')).toBe(false);
      expect(detail!.vikingUri).toContain('viking://workspace/memories/entities/sqlite/');
      expect(detail!.hindsightNetwork).toBe('world');

      // Only memA2 should be visible in relations; memB and sessOther must be filtered out!
      const relOtherIds = detail!.relations.map((r) => r.other_id);
      expect(relOtherIds).toEqual([memA2]);

      // Hindsight trace must also hide memB (derivedSources) and sessOther (contradictions)!
      expect(detail!.hindsightTrace.derivedSources).toHaveLength(0);
      expect(detail!.hindsightTrace.contradictions).toHaveLength(0);

      // Excluded workspace memory returns null
      expect(
        getMemoryDetail(db, memB, {
          scopeCtx: { workspaceId: wsB },
          excludeWorkspaces: [wsB],
        })
      ).toBeNull();
    });

    it('importJsonMemories preserves candidates, guards frozen/core:*, enforces containment, validates IDs, and rejects secrets', () => {
      const wsA = workspaceId('/repo/alpha');
      const wsB = workspaceId('/repo/beta');
      const wsExcluded = workspaceId('/repo/secret');
      const cfg = validateConfig({ excludeWorkspaces: [wsExcluded] });
      const now = 1_750_000_000_000;

      const rawItems = [
        // 1. Candidate must remain candidate (NOT auto-promoted to active!)
        {
          id: 'm_cand0001',
          type: 'semantic',
          status: 'candidate',
          scope: 'workspace',
          content: 'Candidate architectural hypothesis awaiting review.',
          confidence: 0.65,
        },
        // 2. Frozen item without trusted=true must NOT become frozen
        {
          id: 'm_froz0001',
          type: 'semantic',
          status: 'frozen',
          scope: 'workspace',
          content: 'Untrusted frozen claim should not freeze.',
          pinned: 1,
        },
        // 3. core:* slot blocked when !trusted
        {
          id: 'm_core0001',
          type: 'semantic',
          status: 'active',
          slot_key: 'core:persona',
          content: 'Untrusted attempt to hijack persona core memory.',
        },
        // 4. Cross-workspace item blocked when !allowCrossWorkspace
        {
          id: 'm_cross001',
          type: 'semantic',
          status: 'active',
          scope: 'workspace',
          workspace_id: wsB,
          content: 'Cross-workspace injection targeting Beta.',
        },
        // 5. Invalid ID path traversal rejected
        {
          id: '../../etc/passwd',
          type: 'semantic',
          status: 'active',
          content: 'Malformed ID item should be rejected.',
        },
        // 6. Plaintext secret rejected (NOT redacted and stored!)
        {
          id: 'm_sec00001',
          type: 'semantic',
          status: 'active',
          content: 'Production token is sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
        },
        // 7. Pre-redacted placeholder rejected
        {
          id: 'm_sec00002',
          type: 'semantic',
          status: 'active',
          content: 'Password was [REDACTED:SECRET]',
        },
        // 8. Archived record skipped cleanly
        {
          id: 'm_arch0001',
          type: 'semantic',
          status: 'archived',
          content: 'Already archived memory should stay skipped.',
        },
        // 9. Untrusted global scope clamped to target workspace
        {
          id: 'm_glob0001',
          type: 'preference',
          status: 'active',
          scope: 'global',
          content: 'Prefer strict TypeScript without any.',
        },
      ];

      const res = importJsonMemories(db, rawItems, {
        workspaceId: wsA,
        trusted: false,
        allowCrossWorkspace: false,
        cfg,
        now,
      });

      expect(res.imported).toBe(3); // candidate + untrusted frozen(as active) + clamped global
      expect(res.merged).toBe(0);
      expect(res.skipped).toBe(6);
      expect(res.errors.some((e) => e.includes('core_slot_requires_trusted_import'))).toBe(true);
      expect(res.errors.some((e) => e.includes('cross_workspace_forbidden'))).toBe(true);
      expect(res.errors.some((e) => e.includes('invalid_id_format'))).toBe(true);
      expect(res.errors.filter((e) => e.includes('sensitive_content_detected'))).toHaveLength(2);

      const allRows = db.all<MemoryRecord>('SELECT * FROM memories');
      expect(allRows).toHaveLength(3);

      const candRow = allRows.find((r) => r.content.includes('Candidate architectural hypothesis'));
      expect(candRow?.status).toBe('candidate');

      const untrustedFrozRow = allRows.find((r) => r.content.includes('Untrusted frozen claim'));
      expect(untrustedFrozRow?.status).toBe('active');
      expect(untrustedFrozRow?.pinned).toBe(0);

      const clampedGlobalRow = allRows.find((r) => r.content.includes('Prefer strict TypeScript'));
      expect(clampedGlobalRow?.scope).toBe('workspace');
      expect(clampedGlobalRow?.workspace_id).toBe(wsA);

      // Re-importing the exact same candidate must merge and STILL preserve status='candidate'!
      const reimportRes = importJsonMemories(db, [rawItems[0]], {
        workspaceId: wsA,
        trusted: false,
        cfg,
        now: now + 1000,
      });
      expect(reimportRes.merged).toBe(1);
      expect(get(db, candRow!.id)?.status).toBe('candidate');

      // Trusted import preserves frozen, pinned, and allows core:*
      const trustedRes = importJsonMemories(
        db,
        [
          {
            type: 'semantic',
            status: 'frozen',
            scope: 'workspace',
            slot_key: 'core:project',
            pinned: 1,
            content: 'Trusted frozen core project specification.',
          },
          {
            type: 'semantic',
            status: 'active',
            scope: 'workspace',
            workspace_id: wsExcluded,
            content: 'Even trusted cross-workspace must block excluded workspace.',
          },
        ],
        {
          workspaceId: wsA,
          trusted: true,
          allowCrossWorkspace: true,
          cfg,
          now: now + 2000,
        }
      );

      expect(trustedRes.imported).toBe(1);
      expect(trustedRes.skipped).toBe(1);
      expect(trustedRes.errors.some((e) => e.includes('workspace_excluded'))).toBe(true);

      const coreRow = db.get<MemoryRecord>(
        `SELECT * FROM memories WHERE slot_key = 'core:project'`
      );
      expect(coreRow?.status).toBe('frozen');
      expect(coreRow?.pinned).toBe(1);
    });

    it('queryInjectionTelemetry7d scopes by workspace via session_workspace_owners and respects excludeWorkspaces', () => {
      const wsA = workspaceId('/repo/alpha');
      const wsB = workspaceId('/repo/beta');
      const secretDir = makeTempDir('tel-secret');
      tempDirs.push(secretDir);
      const wsSecret = rememberWorkspacePath(db, secretDir);
      const now = 1_750_000_000_000;

      db.run('INSERT INTO session_workspace_owners (session_id, workspace_id) VALUES (?, ?)', [
        'sess_a',
        wsA,
      ]);
      db.run('INSERT INTO session_workspace_owners (session_id, workspace_id) VALUES (?, ?)', [
        'sess_b',
        wsB,
      ]);
      db.run('INSERT INTO session_workspace_owners (session_id, workspace_id) VALUES (?, ?)', [
        'sess_secret',
        wsSecret,
      ]);

      // Workspace A: 2 dynamic turns within 7d (turn 1: 2 memories = 120 tokens, positive, used=1; turn 2: 80 tokens, negative, used=0)
      // Plus 1 old turn (> 7d ago) and 1 stable layer row (excluded from dynamic count)
      const insertInj = (
        sid: string,
        turn: number,
        memId: string,
        layer: string,
        tokens: number,
        outcome: number | null,
        used: number | null,
        createdAt: number
      ) => {
        db.run(
          `INSERT INTO injections (
            session_id, turn, memory_id, content_rev, layer, rank, tokens, form, strategy_v, outcome, used, created_at
          ) VALUES (?, ?, ?, 1, ?, 1, ?, 'summary', 1, ?, ?, ?)`,
          [sid, turn, memId, layer, tokens, outcome, used, createdAt]
        );
      };

      insertInj('sess_a', 1, 'm_1', 'dynamic', 50, 1.0, 1, now - 1000);
      insertInj('sess_a', 1, 'm_2', 'dynamic', 70, 0.8, 1, now - 1000);
      insertInj('sess_a', 2, 'm_3', 'dynamic', 80, -1.0, 0, now - 500);
      insertInj('sess_a', 2, 'm_4', 'stable', 300, null, null, now - 500);
      insertInj('sess_a', 0, 'm_old', 'dynamic', 999, -1.0, 0, now - 10 * 86_400_000);

      // Workspace B: 1 dynamic turn (300 tokens, positive)
      insertInj('sess_b', 1, 'm_b1', 'dynamic', 300, 1.0, 1, now - 500);

      // Secret workspace: 1 dynamic turn (500 tokens, negative)
      insertInj('sess_secret', 1, 'm_s1', 'dynamic', 500, -1.0, 0, now - 500);

      const telA = queryInjectionTelemetry7d(db, {
        workspaceId: wsA,
        excludeWorkspaces: [secretDir],
        now,
      });
      expect(telA.totalInjections).toBe(2);
      expect(telA.totalTokens).toBe(200);
      expect(telA.avgTokens).toBe(100);
      expect(telA.hitRate).toBe(50);
      expect(telA.positiveRate).toBe(50);
      expect(telA.negativeRate).toBe(50);
      expect(telA.totalTurns).toBe(2);
      expect(telA.correctionRate).toBe(50);

      // Global view with excludeWorkspaces excludes secretDir's session
      const telGlobal = queryInjectionTelemetry7d(db, {
        excludeWorkspaces: [secretDir],
        now,
      });
      expect(telGlobal.totalInjections).toBe(3); // 2 from A + 1 from B
      expect(telGlobal.totalTokens).toBe(500); // 200 + 300

      // Querying excluded workspace directly yields empty zeros
      const telExcluded = queryInjectionTelemetry7d(db, {
        workspaceId: wsSecret,
        excludeWorkspaces: [secretDir],
        now,
      });
      expect(telExcluded.totalInjections).toBe(0);
      expect(telExcluded.totalTokens).toBe(0);
    });

    it('stripMemoryForApi strips embedding blobs and batch-resolves deterministic vikingUri + hindsightNetwork', () => {
      const wsA = workspaceId('/repo/alpha');
      const id1 = insertActiveMemory(db, {
        type: 'procedural',
        content: 'Run pnpm build before publishing.',
        workspaceId: wsA,
        entities: ['zeta', 'alpha'],
      });
      const id2 = insertActiveMemory(db, {
        type: 'failure',
        content: 'SQLite SQLITE_BUSY occurred when busy_timeout was omitted.',
        workspaceId: wsA,
        entities: ['sqlite'],
      });

      const rawRows = db.all<MemoryRecord>('SELECT * FROM memories WHERE id IN (?, ?)', [id1, id2]);
      expect(rawRows.every((r) => r.embedding instanceof Uint8Array)).toBe(true);

      const stripped = stripMemoryForApi(db, rawRows);
      expect(stripped).toHaveLength(2);
      for (const item of stripped) {
        expect(Object.prototype.hasOwnProperty.call(item, 'embedding')).toBe(false);
      }

      const item1 = stripped.find((x) => x.id === id1)!;
      const item2 = stripped.find((x) => x.id === id2)!;
      // Sorted entity ASC => 'alpha' comes before 'zeta'
      expect(item1.vikingUri).toContain('viking://workspace/memories/skills/alpha/');
      expect(item1.hindsightNetwork).toBe('observation');
      expect(item2.vikingUri).toContain('viking://workspace/memories/cases/sqlite/');
      expect(item2.hindsightNetwork).toBe('experience');
    });
  });

  // -------------------------------------------------------------------------
  // 3. maintenance-service.ts
  // -------------------------------------------------------------------------
  describe('maintenance-service (runUnifiedMaintenance)', () => {
    it('runs a single coordinated pass, repairs FTS/embeddings, skips LLM curate cleanly without consent, and enforces workspacePath match for Viking sync', async () => {
      const dbDir = makeTempDir('maint-db');
      const wsDirA = makeTempDir('maint-ws-a');
      const wsDirB = makeTempDir('maint-ws-b');
      tempDirs.push(dbDir, wsDirA, wsDirB);

      const fileDbPath = path.join(dbDir, 'memory.db');
      const fileDb = openDb(fileDbPath);

      try {
        const wsA = rememberWorkspacePath(fileDb, wsDirA);
        const now = 1_750_000_000_000;
        const cfg = validateConfig({
          coldDays: 30,
          privacy: { offlineConsent: false, allowedOfflineEndpoints: [] },
        });

        // Create Viking directory ONLY inside wsDirB (mismatched path!) and wsDirA
        fs.mkdirSync(path.join(wsDirB, '.dsh', 'viking-context'), { recursive: true });

        // Seed active memory, cold memory, expired candidate, and missing embedding + broken FTS
        const activeId = insertActiveMemory(fileDb, {
          type: 'preference',
          content: 'Always use strict TypeScript with NodeNext.',
          workspaceId: wsA,
          confidence: 0.9,
          now,
        });
        fileDb.run(`UPDATE memories SET utility = 0.8, embedding = NULL WHERE id = ?`, [activeId]);

        const coldId = insertActiveMemory(fileDb, {
          content: 'Old unused cold note from last quarter.',
          workspaceId: wsA,
          now: now - 45 * 86_400_000,
        });
        fileDb.run(`UPDATE memories SET utility = 0.2 WHERE id = ?`, [coldId]);

        // Seed an expired candidate (> 30d old)
        const candRes = upsertCandidate(
          fileDb,
          {
            type: 'semantic',
            content: 'Expired unreviewed candidate memory.',
            scope: 'workspace',
            workspaceId: wsA,
            source_kind: 'system',
            origin_kinds: ['system'],
            confidence: 0.5,
            status: 'candidate',
            actor: 'maintenance',
            sources: [{ session_id: 'old_sess', seq: 1, kind: 'system' }],
          },
          now - 40 * 86_400_000
        );
        expect('id' in candRes).toBe(true);

        // Corrupt FTS table so checkAndRepairFts has to repair it
        fileDb.run('DELETE FROM memory_fts');

        // Pass MISMATCHED workspacePath (wsDirB) for workspaceId wsA -> Viking sync MUST NOT run!
        const res = await runUnifiedMaintenance(fileDb, {
          workspaceId: wsA,
          workspacePath: wsDirB,
          cfg,
          now,
          runLlmCurate: true,
          runBackup: true,
          runSentinel: true,
        });

        expect(res.errors).toEqual([]);
        expect(res.archivedCold).toBe(1);
        expect(res.expiredCandidates).toBe(1);
        expect(res.ftsRepaired).toBe(1);
        expect(res.localEmbeddingsBackfilled).toBeGreaterThanOrEqual(1);
        expect(res.autoPinned).toBe(1);
        expect(res.curated).toEqual({
          ran: false,
          skippedReason: 'privacy_offline_consent_required',
        });
        // Mismatched workspacePath MUST NOT sync wsA memories into wsDirB!
        expect(res.vikingSynced).toBe(false);
        expect(fs.existsSync(path.join(wsDirB, '.dsh', 'viking-context', '.abstract.md'))).toBe(
          false
        );
        expect(res.backupPath).toBeTruthy();
        expect(fs.existsSync(res.backupPath!)).toBe(true);

        // Now create .dsh/viking-context inside matching wsDirA and verify Viking sync succeeds
        fs.mkdirSync(path.join(wsDirA, '.dsh', 'viking-context'), { recursive: true });
        const res2 = await runUnifiedMaintenance(fileDb, {
          workspaceId: wsA,
          workspacePath: wsDirA,
          cfg,
          now: now + 1000,
        });
        expect(res2.vikingSynced).toBe(true);
        expect(fs.existsSync(path.join(wsDirA, '.dsh', 'viking-context', '.abstract.md'))).toBe(
          true
        );
      } finally {
        fileDb.close();
      }
    });

    it('honors AbortSignal immediately and skips VACUUM INTO backup when aborted', async () => {
      const dbDir = makeTempDir('maint-abort');
      tempDirs.push(dbDir);
      const fileDbPath = path.join(dbDir, 'memory.db');
      const fileDb = openDb(fileDbPath);

      try {
        const wsA = workspaceId('/repo/abort-test');
        const now = 1_750_000_000_000;
        const coldId = insertActiveMemory(fileDb, {
          content: 'Cold memory that must remain untouched when pre-aborted.',
          workspaceId: wsA,
          now: now - 90 * 86_400_000,
        });
        fileDb.run(`UPDATE memories SET utility = 0.1 WHERE id = ?`, [coldId]);

        const ac = new AbortController();
        ac.abort();

        const res = await runUnifiedMaintenance(fileDb, {
          workspaceId: wsA,
          cfg: validateConfig({ coldDays: 30 }),
          now,
          signal: ac.signal,
          runBackup: true,
        });

        expect(res.archivedCold).toBe(0);
        expect(res.backupPath).toBeUndefined();
        expect(res.curated.skippedReason).toBe('aborted');
        expect(get(fileDb, coldId)?.status).toBe('active');
        expect(fs.existsSync(path.join(dbDir, 'backups'))).toBe(false);

        // Mid-pipeline abort during async LLM curate stops before subsequent stages & VACUUM INTO backup
        const midAc = new AbortController();
        const cfgWithConsent = validateConfig({
          coldDays: 30,
          offlineLLM: {
            useDshLlm: false,
            baseURL: 'https://api.example.com/v1',
            model: 'test-model',
            apiKey: 'sk-proj-testkey1234567890abcdef1234',
            apiKeyEnv: '',
            protocol: 'chat/completions',
          },
          privacy: {
            offlineConsent: true,
            allowedOfflineEndpoints: ['https://api.example.com'],
          },
        });
        insertActiveMemory(fileDb, {
          content: 'Active memory sent to curate before abort triggers.',
          workspaceId: wsA,
          now,
        });
        const abortingFetch = vi.fn(async () => {
          midAc.abort();
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        });
        const midRes = await runUnifiedMaintenance(fileDb, {
          workspaceId: wsA,
          cfg: cfgWithConsent,
          now,
          signal: midAc.signal,
          runLlmCurate: true,
          runBackup: true,
          fetchFn: abortingFetch as unknown as typeof fetch,
        });
        expect(midRes.archivedCold).toBe(1);
        expect(midRes.backupPath).toBeUndefined();
        expect(fs.existsSync(path.join(dbDir, 'backups'))).toBe(false);
      } finally {
        fileDb.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 4. llm-probe.ts
  // -------------------------------------------------------------------------
  describe('llm-probe (probeOfflineLLM)', () => {
    function makeConsentedCfg(allowed: string[]): PluginConfig {
      return validateConfig({
        offlineLLM: {
          useDshLlm: false,
          baseURL: allowed[0] || 'https://api.example.com/v1',
          model: 'test-model',
          apiKey: 'sk-proj-secretconfiguredkey1234567890abcdef',
          apiKeyEnv: '',
          protocol: 'chat/completions',
        },
        privacy: {
          offlineConsent: true,
          allowedOfflineEndpoints: allowed,
        },
      });
    }

    it('enforces offlineConsent and allowedOfflineEndpoints before making any network call', async () => {
      const fetchSpy = vi.fn();

      // 1. Consent disabled -> blocked immediately
      const noConsentCfg = validateConfig({
        privacy: { offlineConsent: false, allowedOfflineEndpoints: ['https://api.example.com'] },
      });
      const r1 = await probeOfflineLLM(
        { baseURL: 'https://api.example.com/v1', model: 'gpt-4o-mini' },
        noConsentCfg,
        { fetchFn: fetchSpy as unknown as typeof fetch, bypassRateLimit: true }
      );
      expect(r1.ok).toBe(false);
      expect(r1.code).toBe('privacy_offline_consent_required');
      expect(fetchSpy).not.toHaveBeenCalled();

      // 2. Consent enabled but endpoint not in allowlist -> blocked
      const cfg = makeConsentedCfg(['https://allowed.example.com/v1']);
      const r2 = await probeOfflineLLM(
        { baseURL: 'https://other.example.com/v1', model: 'test-model' },
        cfg,
        { fetchFn: fetchSpy as unknown as typeof fetch, bypassRateLimit: true }
      );
      expect(r2.ok).toBe(false);
      expect(r2.code).toBe('endpoint_not_allowed');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('blocks SSRF metadata IPs, link-local DNS resolutions, userinfo, and #/? path bypasses', async () => {
      const fetchSpy = vi.fn();
      const cfg = makeConsentedCfg([
        'http://169.254.169.254',
        'http://100.100.100.200',
        'http://metadata.google.internal',
        'https://rebind.example.com',
        'https://api.example.com',
      ]);

      // Cloud metadata IP literal
      const rAws = await probeOfflineLLM(
        { baseURL: 'http://169.254.169.254/latest/meta-data' },
        cfg,
        { fetchFn: fetchSpy as unknown as typeof fetch, bypassRateLimit: true }
      );
      expect(rAws.ok).toBe(false);
      expect(rAws.code).toBe('blocked_ip_range');

      // Alibaba metadata IP literal
      const rAli = await probeOfflineLLM(
        { baseURL: 'http://100.100.100.200/latest' },
        cfg,
        { fetchFn: fetchSpy as unknown as typeof fetch, bypassRateLimit: true }
      );
      expect(rAli.ok).toBe(false);
      expect(rAli.code).toBe('blocked_ip_range');

      // GCP metadata hostname
      const rGcp = await probeOfflineLLM(
        { baseURL: 'http://metadata.google.internal/computeMetadata/v1' },
        cfg,
        { fetchFn: fetchSpy as unknown as typeof fetch, bypassRateLimit: true }
      );
      expect(rGcp.ok).toBe(false);
      expect(rGcp.code).toBe('blocked_metadata_host');

      // DNS rebinding to link-local IP
      const rDns = await probeOfflineLLM(
        { baseURL: 'https://rebind.example.com/v1' },
        cfg,
        {
          fetchFn: fetchSpy as unknown as typeof fetch,
          lookupFn: async () => [{ address: '169.254.169.254' }],
          bypassRateLimit: true,
        }
      );
      expect(rDns.ok).toBe(false);
      expect(rDns.code).toBe('blocked_resolved_ip');

      // '#' bare trailing fragment and non-empty fragment path bypass attempts
      const rHashBare = await probeOfflineLLM(
        { baseURL: 'https://api.example.com/admin#' },
        cfg,
        { fetchFn: fetchSpy as unknown as typeof fetch, bypassRateLimit: true }
      );
      expect(rHashBare.ok).toBe(false);
      expect(rHashBare.code).toBe('url_query_or_hash_forbidden');

      const rHashFrag = await probeOfflineLLM(
        { baseURL: 'https://api.example.com/admin#ignored' },
        cfg,
        { fetchFn: fetchSpy as unknown as typeof fetch, bypassRateLimit: true }
      );
      expect(rHashFrag.ok).toBe(false);
      expect(rHashFrag.code).toBe('url_query_or_hash_forbidden');

      // '?' bare and non-empty query path bypass attempts
      const rQuery = await probeOfflineLLM(
        { baseURL: 'https://api.example.com/admin?x=1' },
        cfg,
        { fetchFn: fetchSpy as unknown as typeof fetch, bypassRateLimit: true }
      );
      expect(rQuery.ok).toBe(false);
      expect(rQuery.code).toBe('url_query_or_hash_forbidden');

      const rQueryBare = await probeOfflineLLM(
        { baseURL: 'https://api.example.com/admin?' },
        cfg,
        { fetchFn: fetchSpy as unknown as typeof fetch, bypassRateLimit: true }
      );
      expect(rQueryBare.ok).toBe(false);
      expect(rQueryBare.code).toBe('url_query_or_hash_forbidden');

      // userinfo credential URL rejected
      const rUserInfo = await probeOfflineLLM(
        { baseURL: 'https://admin:secret@api.example.com/v1' },
        cfg,
        { fetchFn: fetchSpy as unknown as typeof fetch, bypassRateLimit: true }
      );
      expect(rUserInfo.ok).toBe(false);
      expect(rUserInfo.code).toBe('url_credentials_forbidden');

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('enforces single-flight concurrency lock and 10 probes/min sliding window rate limit', async () => {
      const cfg = makeConsentedCfg(['https://api.example.com/v1']);
      let nowMs = 1_750_000_000_000;
      const clock = () => nowMs;

      // Single-flight test: hold first probe open while firing a second concurrent probe
      let releaseFirst!: () => void;
      const blockingFetch = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            releaseFirst = () => resolve(new Response('{"ok":true}', { status: 200 }));
          })
      );

      const firstPromise = probeOfflineLLM(
        { baseURL: 'https://api.example.com/v1' },
        cfg,
        { fetchFn: blockingFetch as unknown as typeof fetch, now: clock }
      );

      // Give microtask tick for first probe to enter flight
      await Promise.resolve();

      const concurrentRes = await probeOfflineLLM(
        { baseURL: 'https://api.example.com/v1' },
        cfg,
        { fetchFn: blockingFetch as unknown as typeof fetch, now: clock }
      );
      expect(concurrentRes.ok).toBe(false);
      expect(concurrentRes.code).toBe('probe_in_flight');

      releaseFirst();
      const firstRes = await firstPromise;
      expect(firstRes.ok).toBe(true);

      // Sliding window: 1 already used; next 9 succeed, 11th hits rate_limited
      const okFetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
      for (let i = 0; i < 9; i++) {
        nowMs += 100;
        const r = await probeOfflineLLM(
          { baseURL: 'https://api.example.com/v1' },
          cfg,
          { fetchFn: okFetch as unknown as typeof fetch, now: clock }
        );
        expect(r.ok).toBe(true);
      }

      const limited = await probeOfflineLLM(
        { baseURL: 'https://api.example.com/v1' },
        cfg,
        { fetchFn: okFetch as unknown as typeof fetch, now: clock }
      );
      expect(limited.ok).toBe(false);
      expect(limited.code).toBe('rate_limited');

      // Advancing past 60s window re-allows probe
      nowMs += 60_001;
      const recovered = await probeOfflineLLM(
        { baseURL: 'https://api.example.com/v1' },
        cfg,
        { fetchFn: okFetch as unknown as typeof fetch, now: clock }
      );
      expect(recovered.ok).toBe(true);
    });

    it('cancels 2xx response body, blocks 3xx redirects, caps error reads to 4 KiB, and redacts secrets', async () => {
      const cfg = makeConsentedCfg(['https://api.example.com/v1']);

      // 1. 2xx cancels response.body without draining full stream
      const cancelSpy = vi.fn(async () => {});
      const okFetch = vi.fn(async (_url: string, init?: RequestInit) => {
        expect(init?.redirect).toBe('manual');
        return {
          ok: true,
          status: 200,
          body: { cancel: cancelSpy },
        } as unknown as Response;
      });
      const rOk = await probeOfflineLLM(
        { baseURL: 'https://api.example.com/v1', model: 'deepseek-chat' },
        cfg,
        { fetchFn: okFetch as unknown as typeof fetch, bypassRateLimit: true }
      );
      expect(rOk.ok).toBe(true);
      expect(rOk.status).toBe(200);
      expect(cancelSpy).toHaveBeenCalledTimes(1);

      // 2. 3xx redirect blocked
      const redirFetch = vi.fn(async () => new Response('', { status: 302 }));
      const rRedir = await probeOfflineLLM(
        { baseURL: 'https://api.example.com/v1' },
        cfg,
        { fetchFn: redirFetch as unknown as typeof fetch, bypassRateLimit: true }
      );
      expect(rRedir.ok).toBe(false);
      expect(rRedir.code).toBe('redirect_not_allowed');

      // 3. Large streaming 401 error (> 4 KiB) is capped, reader cancelled, and secrets redacted
      let chunksPulled = 0;
      let streamCancelled = false;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            chunksPulled++;
            if (chunksPulled === 1) {
              const payload =
                `Invalid API key sk-proj-leakedkeyvalue1234567890abcdef ` + 'X'.repeat(3000);
              controller.enqueue(new TextEncoder().encode(payload));
            } else {
              controller.enqueue(new TextEncoder().encode('Y'.repeat(4096)));
            }
          },
          cancel() {
            streamCancelled = true;
          },
        },
        { highWaterMark: 0 }
      );

      const errFetch = vi.fn(async () => new Response(stream, { status: 401 }));
      const rErr = await probeOfflineLLM(
        { baseURL: 'https://api.example.com/v1' },
        cfg,
        { fetchFn: errFetch as unknown as typeof fetch, bypassRateLimit: true }
      );
      expect(rErr.ok).toBe(false);
      expect(rErr.status).toBe(401);
      expect(rErr.code).toBe('http_401');
      expect(streamCancelled).toBe(true);
      expect(chunksPulled).toBe(2);
      expect(rErr.error).not.toContain('sk-proj-leakedkeyvalue');
      expect(rErr.error).toContain('[REDACTED:API_KEY]');

      // 4. Configured API key must NEVER be sent to a different origin
      const multiCfg = makeConsentedCfg([
        'https://primary.example.com/v1',
        'https://secondary.example.com/v1',
      ]);
      const headerCaptureFetch = vi.fn(async (_url: string, init?: RequestInit) => {
        const hdrs = (init?.headers || {}) as Record<string, string>;
        expect(hdrs['Authorization']).toBeUndefined();
        return new Response('{"ok":true}', { status: 200 });
      });
      const rCrossOrigin = await probeOfflineLLM(
        { baseURL: 'https://secondary.example.com/v1' },
        multiCfg,
        { fetchFn: headerCaptureFetch as unknown as typeof fetch, bypassRateLimit: true }
      );
      expect(rCrossOrigin.ok).toBe(true);
      expect(headerCaptureFetch).toHaveBeenCalledTimes(1);
    });
  });
});
