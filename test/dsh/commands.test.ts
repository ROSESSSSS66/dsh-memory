import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import { workspaceId } from '../../src/core/scope.js';
import { MemoryCommands, tokenizeCommandArgs } from '../../src/dsh/commands.js';
import { upsertCandidate } from '../../src/core/writer.js';
import { DEFAULTS } from '../../src/config.js';

describe('User Commands (commands.ts)', () => {
  let db: Db;
  let commands: MemoryCommands;
  const ws1 = workspaceId('test-ws-commands');
  const sess1 = 'sess_cmd_001';
  const fixedNow = new Date('2026-11-04T12:00:00Z').getTime();

  beforeEach(() => {
    db = openDb(':memory:');
    commands = new MemoryCommands(db);
  });

  afterEach(() => {
    db.close();
  });

  it('/memory stats 和 /memory inspect <id> 的输出正确，并且包含来源 session (验收项 3)', () => {
    const insertRes = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '项目数据库是 PostgreSQL 16',
        summary: '数据库版本配置',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 'sess_source_alpha123', seq: 7, kind: 'user', excerpt: '我的数据库是 PostgreSQL 16' }],
        actor: 'user',
      },
      fixedNow
    );
    expect(insertRes.action).toBe('inserted');
    const memId = (insertRes as any).id;

    const statsOutput = commands.stats({ workspaceId: ws1, sessionId: sess1 });
    expect(statsOutput).toContain('记忆总数 1');
    expect(statsOutput).toContain('active 1');
    expect(statsOutput).toContain('类型分布 semantic 1');

    const inspectOutput = commands.inspect(memId, { workspaceId: ws1, sessionId: sess1 });
    expect(inspectOutput).toContain(`ID: ${memId}`);
    expect(inspectOutput).toContain('Type: semantic');
    expect(inspectOutput).toContain('Status: active');
    expect(inspectOutput).toContain('Content:\n项目数据库是 PostgreSQL 16');
    expect(inspectOutput).toContain('sess_source_alpha123');
    expect(inspectOutput).toContain('seq: 7');
    expect(inspectOutput).toContain('我的数据库是 PostgreSQL 16');
  });

  it('/memory list, forget, pin, freeze, unpin, unfreeze', () => {
    const insertRes = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '临时配置项',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: sess1, seq: 1, kind: 'user' }],
        actor: 'user',
      },
      fixedNow
    );
    const memId = (insertRes as any).id;

    const listOut = commands.list({}, { workspaceId: ws1, sessionId: sess1 });
    expect(listOut).toContain(memId);

    const pinRes = commands.setPin(memId, true, { workspaceId: ws1 });
    expect(pinRes).toContain('pinned');
    let mem = db.get<{ pinned: number }>('SELECT pinned FROM memories WHERE id = ?', [memId]);
    expect(mem?.pinned).toBe(1);

    commands.setPin(memId, false, { workspaceId: ws1 });
    mem = db.get<{ pinned: number }>('SELECT pinned FROM memories WHERE id = ?', [memId]);
    expect(mem?.pinned).toBe(0);

    commands.setFreeze(memId, true, { workspaceId: ws1 });
    let memStatus = db.get<{ status: string }>('SELECT status FROM memories WHERE id = ?', [memId]);
    expect(memStatus?.status).toBe('frozen');

    // Frozen memory cannot be forgotten via forgetWithTrash
    const frozenForget = commands.handleCommand(`forget ${memId}`, { workspaceId: ws1 });
    expect(frozenForget.kind).toBe('error');
    expect(frozenForget.text).toContain('frozen');

    commands.setFreeze(memId, false, { workspaceId: ws1 });
    memStatus = db.get<{ status: string }>('SELECT status FROM memories WHERE id = ?', [memId]);
    expect(memStatus?.status).toBe('active');

    commands.forget(memId, { workspaceId: ws1 });
    memStatus = db.get<{ status: string }>('SELECT status FROM memories WHERE id = ?', [memId]);
    expect(memStatus?.status).toBe('archived');
  });

  it('/memory pending displays slot_key and scope prominently and /memory approve activates candidate', () => {
    const insertRes = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '工具自动提取的待复核内容',
        slot_key: 'deploy.branch',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'rule',
        confidence: 0.45,
        status: 'candidate',
        origin_kinds: ['tool'],
        sources: [{ session_id: sess1, seq: 1, kind: 'tool' }],
        actor: 'rule',
      },
      fixedNow
    );
    const candId = (insertRes as any).id;

    const pendingOut = commands.pending({ workspaceId: ws1 });
    expect(pendingOut).toContain(candId);
    expect(pendingOut).toContain('scope=workspace');
    expect(pendingOut).toContain('slot=deploy.branch');

    const approveOut = commands.approve(candId, { workspaceId: ws1 });
    expect(approveOut).toContain('approved');

    const memStatus = db.get<{ status: string; approved_by: string }>(
      'SELECT status, approved_by FROM memories WHERE id = ?',
      [candId]
    );
    expect(memStatus?.status).toBe('active');
    expect(memStatus?.approved_by).toBe('user');
  });

  it('/memory export and import (with overwrite protection and quoted paths with spaces)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh mem export '));
    const tmpExportPath = path.join(tmpDir, 'my export.json');
    const tmpDbPath = path.join(tmpDir, 'my export.db');

    try {
      upsertCandidate(
        db,
        {
          type: 'preference',
          content: '导出测试偏好',
          scope: 'workspace',
          workspaceId: ws1,
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: sess1, seq: 1, kind: 'user' }],
          actor: 'user',
        },
        fixedNow
      );

      // Quote-aware tokenizer handles paths with spaces
      const expRes = commands.handleCommand(`export "${tmpExportPath}"`, { workspaceId: ws1 });
      expect(expRes.kind).toBe('success');
      expect(expRes.text).toContain('Exported 1 memories');
      expect(fs.existsSync(tmpExportPath)).toBe(true);

      // Refuses overwriting existing JSON file without --force
      const overwriteBlocked = commands.handleCommand(`export "${tmpExportPath}"`, { workspaceId: ws1 });
      expect(overwriteBlocked.kind).toBe('error');
      expect(overwriteBlocked.text).toContain('already exists');

      // Overwrites with --force
      const overwriteAllowed = commands.handleCommand(`export "${tmpExportPath}" --force`, { workspaceId: ws1 });
      expect(overwriteAllowed.kind).toBe('success');

      db.run('DELETE FROM memories');
      expect(db.all('SELECT * FROM memories').length).toBe(0);

      const impRes = commands.handleCommand(`import "${tmpExportPath}"`, { workspaceId: ws1 });
      expect(impRes.kind).toBe('success');
      expect(impRes.text).toContain('Imported 1 records');
      expect(db.all('SELECT * FROM memories').length).toBe(1);

      const exportDbRes = commands.handleCommand(`export "${tmpDbPath}"`, { workspaceId: ws1 });
      expect(exportDbRes.kind).toBe('success');
      expect(exportDbRes.text).toContain('Successfully exported database');
      expect(fs.existsSync(tmpDbPath)).toBe(true);

      const importDbRes = commands.handleCommand(`import "${tmpDbPath}"`, { workspaceId: ws1 });
      expect(importDbRes.kind).toBe('success');
      expect(importDbRes.text).toContain('Successfully imported');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('handleCommand dispatches declarative commands, enforces excludeWorkspaces, and validates arguments', () => {
    const helpRes = commands.handleCommand('', { workspaceId: ws1 });
    expect(helpRes.kind).toBe('success');
    expect(helpRes.text).toContain('Available commands');
    for (const cmd of ['find', 'diff', 'core', 'export-bank', 'import-bank', 'reconcile']) {
      expect(helpRes.text).toContain(cmd);
    }

    const unknownRes = commands.handleCommand('nonexistent_cmd', { workspaceId: ws1 });
    expect(unknownRes.kind).toBe('error');
    expect(unknownRes.text).toContain('Unknown memory command');

    // Missing required arguments return kind='error'
    expect(commands.handleCommand('inspect', { workspaceId: ws1 }).kind).toBe('error');
    expect(commands.handleCommand('restore', { workspaceId: ws1 }).kind).toBe('error');
    expect(commands.handleCommand('migrate', { workspaceId: ws1 }).kind).toBe('error');
    expect(commands.handleCommand('rollback', { workspaceId: ws1 }).kind).toBe('error');
    expect(commands.handleCommand('list 2abc', { workspaceId: ws1 }).kind).toBe('error');
    expect(commands.handleCommand('export "unclosed quote', { workspaceId: ws1 }).kind).toBe('error');

    // Strict list page clamping accepts valid numeric page
    expect(commands.handleCommand('list 99999', { workspaceId: ws1 }).kind).toBe('success');

    const statsRes = commands.handleCommand('stats', { workspaceId: ws1 });
    expect(statsRes.kind).toBe('success');
    expect(statsRes.text).toContain('记忆总数');

    const budgetRes = commands.handleCommand('budget', { workspaceId: ws1 });
    expect(budgetRes.kind).toBe('success');
    expect(budgetRes.text).toContain('今日离线 LLM 用量');

    const stratRes = commands.handleCommand('strategy list', { workspaceId: ws1 });
    expect(stratRes.kind).toBe('success');
    expect(stratRes.text).toContain('v1 [active]');

    const evalRes = commands.handleCommand('eval factual', { workspaceId: ws1 });
    expect(evalRes.kind).toBe('success');
    expect(evalRes.text).toContain('评测集 factual');

    const doctorRes = commands.handleCommand('doctor', { workspaceId: ws1 });
    expect(doctorRes.kind).toBe('success');
    expect(doctorRes.text).toContain('记忆库健康度体检报告');

    // Excluded workspace blocked for normal commands, allowed for help & budget
    const excludedPath = '/private/secret-workspace';
    const guarded = new MemoryCommands(db, {
      ...DEFAULTS,
      excludeWorkspaces: [excludedPath],
    });
    expect(guarded.handleCommand('stats', { workspaceId: excludedPath }).kind).toBe('error');
    expect(guarded.handleCommand('list', { workspaceId: excludedPath }).kind).toBe('error');
    expect(guarded.handleCommand('help', { workspaceId: excludedPath }).kind).toBe('success');
    expect(guarded.handleCommand('budget', { workspaceId: excludedPath }).kind).toBe('success');

    // Tokenizer preserves Windows paths with spaces inside double quotes
    const tok = tokenizeCommandArgs('export "C:\\Users\\My Name\\mem.json" --force');
    expect(tok).toEqual({ ok: true, tokens: ['export', 'C:\\Users\\My Name\\mem.json', '--force'] });
  });

  it('defaults import-viking to untrusted unless --trust is explicitly passed', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-viking-cmd-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'entities'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'entities', 'fact1.md'),
        [
          '---',
          'type: semantic',
          'scope: global',
          'slot_key: "core:human"',
          'confidence: 0.99',
          'summary: "Imported test entry"',
          '---',
          '',
          'Imported untrusted OpenViking entry content.',
        ].join('\n'),
        'utf8'
      );

      const res = commands.handleCommand(`import-viking "${tmpDir}"`, { workspaceId: ws1 });
      expect(res.kind).toBe('success');
      expect(res.text).toContain('trusted=false');

      const row = db.get<{ status: string; slot_key: string | null; scope: string }>(
        "SELECT status, slot_key, scope FROM memories WHERE content LIKE '%Imported untrusted OpenViking%'"
      );
      expect(row).toEqual({ status: 'candidate', slot_key: null, scope: 'workspace' });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('scopes pending, approve-repair, reject-repair to current workspace and returns error on ambiguous history IDs', () => {
    const wsForeign = workspaceId('test-ws-foreign');
    const foreignMem = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: 'Foreign workspace secret config',
        scope: 'workspace',
        workspaceId: wsForeign,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_for', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      fixedNow
    );
    const foreignId = (foreignMem as any).id;
    const foreignCand = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: 'Foreign workspace revised config',
        scope: 'workspace',
        workspaceId: wsForeign,
        source_kind: 'llm_extract',
        status: 'candidate',
        confidence: 0.8,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_for', seq: 2, kind: 'llm_repair' }],
        actor: 'llm',
      },
      fixedNow + 1
    );
    const foreignCandId = (foreignCand as any).id;
    db.run(
      `INSERT INTO repair_proposals (job_id, memory_id, content_rev, action, candidate_ids, reason, status, created_at, expires_at)
       VALUES (1, ?, 1, 'revise', ?, 'foreign reason', 'candidate', ?, ?)`,
      [foreignId, JSON.stringify([foreignCandId]), fixedNow, fixedNow + 86400_000]
    );
    const propId = db.get<{ id: number }>('SELECT id FROM repair_proposals')!.id;

    expect(commands.pending({ workspaceId: ws1 })).toBe('No pending candidates or repair proposals.');
    const appForeign = commands.handleCommand(`approve-repair ${propId}`, { workspaceId: ws1 });
    expect(appForeign.kind).toBe('error');
    expect(appForeign.text).toContain('not found in current scope');
    const rejForeign = commands.handleCommand(`reject-repair ${propId}`, { workspaceId: ws1 });
    expect(rejForeign.kind).toBe('error');
    expect(rejForeign.text).toContain('not found in current scope');
    expect(db.get<{ status: string }>('SELECT status FROM repair_proposals WHERE id = ?', [propId])?.status).toBe('candidate');

    expect(commands.pending({ workspaceId: wsForeign })).toContain(`Proposal #${propId}`);

    db.run(
      `INSERT INTO memories (
        id, type, status, content, summary, scope, workspace_id, origin_kinds, source_kind,
        confidence, utility, use_count, success_count, fail_count, token_cost,
        summary_cost, hash, version, content_rev, pinned, created_at, updated_at
      ) VALUES
      ('m_hist011111111111', 'semantic', 'active', 'Hist one.', 'H1', 'workspace', ?, '["user"]', 'user', 0.9, 0.5, 0, 0, 0, 5, 2, 'hh1', 1, 1, 0, 1, 1),
      ('m_hist022222222222', 'semantic', 'active', 'Hist two.', 'H2', 'workspace', ?, '["user"]', 'user', 0.9, 0.5, 0, 0, 0, 5, 2, 'hh2', 1, 1, 0, 1, 1)`,
      [ws1, ws1]
    );
    const histRes = commands.handleCommand('history m_hist0', { workspaceId: ws1 });
    expect(histRes.kind).toBe('error');
    expect(histRes.text).toContain('Ambiguous short id');
  });
});
