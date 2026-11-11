import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import { workspaceId } from '../../src/core/scope.js';
import { MemoryCommands } from '../../src/dsh/commands.js';
import { upsertCandidate } from '../../src/core/writer.js';

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

  it('/memory stats 和 /memory inspect <id> 的输出正确，并且包含来源 session (验收项 3)', () => {
    // 写入一条数据库记忆并关联来源 session
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

    // 1. 测试 /memory stats
    const statsOutput = commands.stats({ workspaceId: ws1, sessionId: sess1 });
    expect(statsOutput).toContain('记忆总数 1');
    expect(statsOutput).toContain('active 1');
    expect(statsOutput).toContain('类型分布 semantic 1');

    // 2. 测试 /memory inspect <id>
    const inspectOutput = commands.inspect(memId, { workspaceId: ws1, sessionId: sess1 });
    expect(inspectOutput).toContain(`ID: ${memId}`);
    expect(inspectOutput).toContain('Type: semantic');
    expect(inspectOutput).toContain('Status: active');
    expect(inspectOutput).toContain('Content:\n项目数据库是 PostgreSQL 16');
    // 必须包含来源 session
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

    // list
    const listOut = commands.list({}, { workspaceId: ws1, sessionId: sess1 });
    expect(listOut).toContain(memId);

    // pin
    const pinRes = commands.setPin(memId, true, { workspaceId: ws1 });
    expect(pinRes).toContain('pinned');
    let mem = db.get<{ pinned: number }>('SELECT pinned FROM memories WHERE id = ?', [memId]);
    expect(mem?.pinned).toBe(1);

    // unpin
    commands.setPin(memId, false, { workspaceId: ws1 });
    mem = db.get<{ pinned: number }>('SELECT pinned FROM memories WHERE id = ?', [memId]);
    expect(mem?.pinned).toBe(0);

    // freeze
    commands.setFreeze(memId, true, { workspaceId: ws1 });
    let memStatus = db.get<{ status: string }>('SELECT status FROM memories WHERE id = ?', [memId]);
    expect(memStatus?.status).toBe('frozen');

    // unfreeze
    commands.setFreeze(memId, false, { workspaceId: ws1 });
    memStatus = db.get<{ status: string }>('SELECT status FROM memories WHERE id = ?', [memId]);
    expect(memStatus?.status).toBe('active');

    // forget -> status archived
    commands.forget(memId, { workspaceId: ws1 });
    memStatus = db.get<{ status: string }>('SELECT status FROM memories WHERE id = ?', [memId]);
    expect(memStatus?.status).toBe('archived');
  });

  it('/memory pending and approve', () => {
    // 插入一条待审批 candidate
    const insertRes = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '工具自动提取的待复核内容',
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

    // pending 应该能查到
    const pendingOut = commands.pending({ workspaceId: ws1 });
    expect(pendingOut).toContain(candId);

    // approve 批准
    const approveOut = commands.approve(candId, { workspaceId: ws1 });
    expect(approveOut).toContain('approved');

    const memStatus = db.get<{ status: string; approved_by: string }>(
      'SELECT status, approved_by FROM memories WHERE id = ?',
      [candId]
    );
    expect(memStatus?.status).toBe('active');
    expect(memStatus?.approved_by).toBe('user');
  });

  it('/memory export and import', () => {
    const tmpExportPath = path.join(os.tmpdir(), `dsh-memory-export-${Date.now()}.json`);

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

    // 导出
    const expRes = commands.exportToJson(tmpExportPath, { workspaceId: ws1 });
    expect(expRes).toContain('Exported 1 memories');
    expect(fs.existsSync(tmpExportPath)).toBe(true);

    // 清空 memories
    db.run('DELETE FROM memories');
    expect(db.all('SELECT * FROM memories').length).toBe(0);

    // 导入
    const impRes = commands.importFromJson(tmpExportPath, { workspaceId: ws1 });
    expect(impRes).toContain('Imported 1 records');
    expect(db.all('SELECT * FROM memories').length).toBe(1);

    // 清理临时文件
    try {
      fs.unlinkSync(tmpExportPath);
    } catch {}

    // 针对 .db 文件的 export 与 import 命令分发测试 (§10)
    const tmpDbPath = path.join(os.tmpdir(), `dsh-memory-export-${Date.now()}.db`);
    const exportDbRes = commands.handleCommand(`export ${tmpDbPath}`, { workspaceId: ws1 });
    expect(exportDbRes.kind).toBe('success');
    expect(exportDbRes.text).toContain('Successfully exported database');
    expect(fs.existsSync(tmpDbPath)).toBe(true);

    const importDbRes = commands.handleCommand(`import ${tmpDbPath}`, { workspaceId: ws1 });
    expect(importDbRes.kind).toBe('success');
    expect(importDbRes.text).toContain('Successfully imported');

    try {
      fs.unlinkSync(tmpDbPath);
    } catch {}
  });

  it('handleCommand should dispatch string commands correctly', () => {
    const helpRes = commands.handleCommand('', { workspaceId: ws1 });
    expect(helpRes.kind).toBe('success');
    expect(helpRes.text).toContain('Available commands');

    const unknownRes = commands.handleCommand('nonexistent_cmd', { workspaceId: ws1 });
    expect(unknownRes.kind).toBe('error');
    expect(unknownRes.text).toContain('Unknown memory command');

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
  });

  it('scopes pending, approve-repair, reject-repair to current workspace and handles ambiguous history IDs', () => {
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
    expect(commands.handleCommand(`approve-repair ${propId}`, { workspaceId: ws1 }).text).toContain('not found in current scope');
    expect(commands.handleCommand(`reject-repair ${propId}`, { workspaceId: ws1 }).text).toContain('not found in current scope');
    expect(db.get<{ status: string }>('SELECT status FROM repair_proposals WHERE id = ?', [propId])?.status).toBe('candidate');

    // Foreign workspace itself can still inspect and reject/approve it.
    expect(commands.pending({ workspaceId: wsForeign })).toContain(`Proposal #${propId}`);

    // Ambiguous short code in history should return friendly output without throwing.
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
    expect(histRes.kind).toBe('success');
    expect(histRes.text).toContain('Ambiguous short id');
  });
});
