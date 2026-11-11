import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import { workspaceId } from '../../src/core/scope.js';
import { MemoryTools } from '../../src/dsh/tools.js';
import { MemoryCommands } from '../../src/dsh/commands.js';
import { upsertCandidate, approveCandidate } from '../../src/core/writer.js';
import { SessionListener } from '../../src/dsh/session-listener.js';
import { IngestQueue } from '../../src/ingest/queue.js';

describe('Ecosystem Features Merged into DSH Memory', () => {
  let db: Db;
  let tools: MemoryTools;
  let commands: MemoryCommands;
  let tmpDir: string;
  const ws1 = workspaceId('test-ws-ecosystem');
  const sess1 = 'sess_eco_001';
  const now = Date.now();

  beforeEach(() => {
    db = openDb(':memory:');
    tools = new MemoryTools({ db });
    commands = new MemoryCommands(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-eco-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Confirmation & Merging Tools (tr1v3r/dsh-ltm)', () => {
    it('memory_confirm should promote candidate and boost utility/confidence', () => {
      const res = upsertCandidate(
        db,
        {
          type: 'semantic',
          content: '前端代码格式化工具使用 prettier 与 eslint',
          summary: '代码格式化工具',
          scope: 'workspace',
          workspaceId: ws1,
          source_kind: 'tool',
          confidence: 0.5,
          status: 'candidate',
          origin_kinds: ['tool'],
          sources: [{ session_id: sess1, seq: 1, kind: 'tool' }],
          actor: 'rule',
        },
        now
      );
      const id = (res as any).id;

      const confirmRes = tools.confirm({ id }, { workspaceId: ws1 });
      expect(confirmRes).toContain('confirmed');

      // 安全策略：模型无法将纯工具来源（不可信）的候选直接激活，只提升置信度并等待用户审批
      const updated = db.get('SELECT * FROM memories WHERE id = ?', [id]);
      expect(updated.status).toBe('candidate');
      expect(updated.confidence).toBeGreaterThan(0.4);
      expect(updated.confidence).toBeLessThanOrEqual(0.7);
      expect(updated.utility).toBeGreaterThan(0.5);

      // 带有用户证据的候选可以被模型确认激活
      const userRes = upsertCandidate(
        db,
        {
          type: 'semantic',
          content: '团队约定所有接口返回统一的错误码结构',
          scope: 'workspace',
          workspaceId: ws1,
          source_kind: 'llm_extract',
          confidence: 0.6,
          status: 'candidate',
          origin_kinds: ['user'],
          sources: [{ session_id: sess1, seq: 2, kind: 'user' }],
          actor: 'llm',
        },
        now
      );
      const userCandId = (userRes as any).id;
      expect(tools.confirm({ id: userCandId }, { workspaceId: ws1 })).toContain('confirmed');
      const promoted = db.get('SELECT * FROM memories WHERE id = ?', [userCandId]);
      expect(promoted.status).toBe('active');
      expect(promoted.confidence).toBeGreaterThan(0.5);
    });

    it('memory_merge should combine two memories and supersede source', () => {
      const resA = upsertCandidate(
        db,
        {
          type: 'semantic',
          content: 'Redis 端口为 6379',
          summary: 'Redis 端口',
          scope: 'workspace',
          workspaceId: ws1,
          source_kind: 'user',
          confidence: 0.8,
          origin_kinds: ['user'],
          sources: [{ session_id: sess1, seq: 1, kind: 'user' }],
          actor: 'user',
        },
        now
      );
      const resB = upsertCandidate(
        db,
        {
          type: 'semantic',
          content: 'Redis 端口为 6379，且开启密码鉴权与 TLS 加密',
          summary: 'Redis 配置完备版',
          scope: 'workspace',
          workspaceId: ws1,
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: sess1, seq: 2, kind: 'user' }],
          actor: 'user',
        },
        now + 500
      );

      const idA = (resA as any).id;
      const idB = (resB as any).id;

      const mergeRes = tools.merge({ sourceId: idA, targetId: idB, reason: 'enrich_details' }, { workspaceId: ws1 });
      expect(mergeRes).toContain('Successfully merged');

      const rowA = db.get('SELECT * FROM memories WHERE id = ?', [idA]);
      const rowB = db.get('SELECT * FROM memories WHERE id = ?', [idB]);
      expect(rowA.status).toBe('superseded');
      expect(rowB.status).toBe('active');
      expect(rowB.utility).toBeGreaterThan(0.5);
    });
  });

  describe('Unified Memory Tool (LZMW/dsh-memory)', () => {
    it('should route unified actions (search, note, confirm, merge) seamlessly', () => {
      // 1. note
      const noteRes = tools.unified(
        { action: 'note', content: '测试团队使用 Vitest 进行单元测试', kind: 'procedure' },
        { workspaceId: ws1, sessionId: sess1, turn: 1 }
      );
      expect(noteRes).toContain('saved as candidate m_');
      const noteId = noteRes.split(' ').pop()!;

      // 2. confirm
      const confirmRes = tools.unified(
        { action: 'confirm', id: noteId },
        { workspaceId: ws1, sessionId: sess1 }
      );
      expect(confirmRes).toContain('confirmed');
      // 模型无法自我批准自己写入的 note，仍需用户审批
      expect(confirmRes).toContain('pending user approval');
      expect(db.get('SELECT status FROM memories WHERE id = ?', [noteId]).status).toBe('candidate');
      approveCandidate(db, noteId, 'user', Date.now());

      // 3. search
      const searchRes = tools.unified(
        { action: 'search', query: 'Vitest 单元测试' },
        { workspaceId: ws1, sessionId: sess1, turn: 2 }
      );
      expect(searchRes).toContain('[PROC m_');
      expect(searchRes).toContain('测试团队使用 Vitest 进行单元测试');
    });
  });

  describe('Commands: /memory confirm, merge, graph, export-md, import-md', () => {
    it('should handle /memory confirm and /memory merge', () => {
      const resA = upsertCandidate(
        db,
        {
          type: 'semantic',
          content: 'Node.js 版本要求 24+',
          summary: 'Node 版本要求',
          scope: 'workspace',
          workspaceId: ws1,
          source_kind: 'user',
          confidence: 0.7,
          origin_kinds: ['user'],
          sources: [{ session_id: sess1, seq: 1, kind: 'user' }],
          actor: 'user',
        },
        now
      );
      const resB = upsertCandidate(
        db,
        {
          type: 'semantic',
          content: 'Node.js 最低版本必须是 24.18.0+',
          summary: 'Node 具体小版本要求',
          scope: 'workspace',
          workspaceId: ws1,
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: sess1, seq: 2, kind: 'user' }],
          actor: 'user',
        },
        now + 100
      );

      const idA = (resA as any).id;
      const idB = (resB as any).id;

      // /memory confirm
      const cmdConfirm = commands.handleCommand(`confirm ${idA}`, { workspaceId: ws1, sessionId: sess1 });
      expect(cmdConfirm.kind).toBe('success');
      expect(cmdConfirm.text).toContain('confirmed');

      // /memory merge
      const cmdMerge = commands.handleCommand(`merge ${idA} ${idB}`, { workspaceId: ws1, sessionId: sess1 });
      expect(cmdMerge.kind).toBe('success');
      expect(cmdMerge.text).toContain('Successfully merged');
    });

    it('should handle /memory graph and render Mermaid diagram', () => {
      upsertCandidate(
        db,
        {
          type: 'preference',
          content: '所有 PR 均需要通过 CI 检查才允许合入',
          summary: 'CI 门禁规范',
          scope: 'workspace',
          workspaceId: ws1,
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: sess1, seq: 1, kind: 'user' }],
          actor: 'user',
        },
        now
      );

      const graphCmd = commands.handleCommand('graph 10', { workspaceId: ws1, sessionId: sess1 });
      expect(graphCmd.kind).toBe('success');
      expect(graphCmd.text).toContain('知识拓扑图谱概览');
      expect(graphCmd.text).toContain('flowchart TD');
    });

    it('should handle /memory export-md and import-md', () => {
      upsertCandidate(
        db,
        {
          type: 'semantic',
          content: '微服务网关默认监听 8080 端口',
          summary: '网关端口',
          scope: 'workspace',
          workspaceId: ws1,
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: sess1, seq: 1, kind: 'user' }],
          actor: 'user',
        },
        now
      );

      const mdDir = path.join(tmpDir, 'exported_md');
      const expCmd = commands.handleCommand(`export-md ${mdDir}`, { workspaceId: ws1, sessionId: sess1 });
      expect(expCmd.kind).toBe('success');
      expect(expCmd.text).toContain('Successfully exported');

      const impCmd = commands.handleCommand(`import-md ${mdDir}`, { workspaceId: ws1, sessionId: sess1 });
      expect(impCmd.kind).toBe('success');
      expect(impCmd.text).toContain('Import completed');
    });
  });

  describe('Context Pressure Monitor (creativedswork/dsh-expmem)', () => {
    it('should emit context pressure event when turn count or events cross threshold', () => {
      const queue = new IngestQueue(db);
      let pressureEvent: any = null;

      const mockCtx: any = {
        emit: (name: string, payload: any) => {
          if (name === 'memory/context-pressure') {
            pressureEvent = payload;
          }
        },
      };

      const listener = new SessionListener(queue, undefined, mockCtx);

      // 模拟多轮高压对话
      for (let i = 1; i <= 16; i++) {
        listener.handleEvent(
          { id: 'sess_pressure_test', cwd: ws1 },
          { type: 'user/message', seq: i, data: { turn: i, content: [{ type: 'text', text: `用户在第 ${i} 轮提问` }] } }
        );
      }

      expect(pressureEvent).not.toBeNull();
      expect(pressureEvent.sessionId).toBe('sess_pressure_test');
      expect(pressureEvent.turn).toBeGreaterThanOrEqual(15);
    });
  });

  describe('GitHub Top-Star Merged Capabilities (Mem0, Letta, Cline)', () => {
    it('tools.coreSet, coreRead, coreAppend and /memory core command', () => {
      // 1. Tool: coreSet
      const setRes = tools.coreSet({ block: 'persona', content: '保持极致严谨' }, { workspaceId: ws1 });
      expect(setRes).toContain('pending user approval');
      const proposedId = db.get<{ id: string }>("SELECT id FROM memories WHERE slot_key = 'core:persona'")!.id;
      commands.handleCommand(`approve ${proposedId}`, { workspaceId: ws1, sessionId: sess1 });

      // 2. Tool: coreAppend
      const appRes = tools.coreAppend({ block: 'persona', text: '遵循规范代码模式' }, { workspaceId: ws1 });
      expect(appRes).toContain('pending user approval');
      const appendedId = db.get<{ id: string }>("SELECT id FROM memories WHERE slot_key = 'core:persona' AND status = 'candidate'")!.id;
      commands.handleCommand(`approve ${appendedId}`, { workspaceId: ws1, sessionId: sess1 });

      // 3. Tool: coreRead
      const readRes = tools.coreRead({ block: 'persona' }, { workspaceId: ws1 });
      expect(readRes).toContain('[CORE MEMORY: PERSONA]');
      expect(readRes).toContain('保持极致严谨');
      expect(readRes).toContain('遵循规范代码模式');

      // 4. Command: /memory core
      const cmdList = commands.handleCommand('core', { workspaceId: ws1, sessionId: sess1 });
      expect(cmdList.kind).toBe('success');
      expect(cmdList.text).toContain('### 🧠 Core Memory (Letta/MemGPT Scratchpad)');

      const cmdSet = commands.handleCommand('core human 偏好中文回复', { workspaceId: ws1, sessionId: sess1 });
      expect(cmdSet.kind).toBe('success');
      expect(cmdSet.text).toContain("Core memory block 'human'");
    });

    it('unified tool supporting core_read, core_set, core_append, reconcile', () => {
      const setRes = tools.unified(
        { action: 'core_set', block: 'project', content: '严格遵循 Node 24 规范' },
        { workspaceId: ws1, sessionId: sess1 }
      );
      expect(setRes).toContain("Core memory block 'project'");
      expect(setRes).toContain('pending user approval');
      const proposedId = db.get<{ id: string }>("SELECT id FROM memories WHERE slot_key = 'core:project'")!.id;
      commands.handleCommand(`approve ${proposedId}`, { workspaceId: ws1, sessionId: sess1 });

      const readRes = tools.unified(
        { action: 'core_read', block: 'project' },
        { workspaceId: ws1, sessionId: sess1 }
      );
      expect(readRes).toContain('严格遵循 Node 24 规范');

      const recRes = tools.unified(
        { action: 'reconcile', content: '采用 Vitest 作为测试框架' },
        { workspaceId: ws1, sessionId: sess1 }
      );
      expect(recRes).toContain('Reconciled: action=ADD');
    });

    it('commands: /memory export-bank and import-bank', () => {
      // 写入一条记忆
      upsertCandidate(
        db,
        {
          type: 'semantic',
          content: '项目采用 Vite 进行前端构建',
          summary: '前端构建选型',
          scope: 'workspace',
          workspaceId: ws1,
          source_kind: 'user',
          confidence: 0.9,
          importance: 8,
          status: 'active',
          origin_kinds: ['user'],
          sources: [{ session_id: sess1, seq: 1, kind: 'user' }],
          actor: 'user',
        },
        now
      );

      const bankDir = path.join(tmpDir, 'memory_bank');
      const expCmd = commands.handleCommand(`export-bank ${bankDir}`, { workspaceId: ws1, sessionId: sess1 });
      expect(expCmd.kind).toBe('success');
      expect(expCmd.text).toContain('Successfully exported');
      expect(fs.existsSync(path.join(bankDir, 'systemPatterns.md'))).toBe(true);

      const impCmd = commands.handleCommand(`import-bank ${bankDir}`, { workspaceId: ws1, sessionId: sess1 });
      expect(impCmd.kind).toBe('success');
      expect(impCmd.text).toContain('Successfully processed');
    });

    it('commands: /memory reconcile', () => {
      const recCmd = commands.handleCommand('reconcile 使用 SQLite FTS5 全文索引', { workspaceId: ws1, sessionId: sess1 });
      expect(recCmd.kind).toBe('success');
      expect(recCmd.text).toContain('Reconciliation finished: action=ADD');
    });
  });
});
