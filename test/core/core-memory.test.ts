import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import type { Db, MemoryRecord } from '../../src/types.js';
import { workspaceId } from '../../src/core/scope.js';
import { approveCandidate } from '../../src/core/writer.js';
import { renderStableLayer } from '../../src/dsh/prompt-section.js';
import {
  getCoreMemory,
  getAllCoreMemories,
  setCoreMemory,
  appendCoreMemory,
  renderCoreMemoryMarkdown,
} from '../../src/core/core-memory.js';

describe('Letta/MemGPT-Inspired Core Memory (core-memory.ts)', () => {
  let db: Db;
  const ws1 = workspaceId('test-ws-core-mem');

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('should initialize and read core memory blocks (human, persona, project)', () => {
    // 初始为空
    expect(getCoreMemory(db, 'human', { workspaceId: ws1 })).toBeNull();

    // 设置 human 块
    const resHuman = setCoreMemory(
      db,
      'human',
      '开发者为资深 TypeScript 架构师，偏好函数式编程与极致性能。',
      { workspaceId: ws1 }
    );
    expect(resHuman.action).toBe('created');

    const entryHuman = getCoreMemory(db, 'human', { workspaceId: ws1 });
    expect(entryHuman).not.toBeNull();
    expect(entryHuman?.content).toContain('资深 TypeScript 架构师');
    expect(entryHuman?.version).toBe(1);

    // 设置 project 块
    setCoreMemory(db, 'project', '代码库严格遵循 ESM 规范，禁止使用 CommonJS。', { workspaceId: ws1 });

    const all = getAllCoreMemories(db, { workspaceId: ws1 });
    expect(all.length).toBe(2);

    const blocks = all.map((e) => e.block);
    expect(blocks).toContain('human');
    expect(blocks).toContain('project');
  });

  it('should update core memory content with versioning', () => {
    setCoreMemory(db, 'project', 'V1: 代码库必须全量通过测试。', { workspaceId: ws1 });
    const resUpdate = setCoreMemory(db, 'project', 'V2: 代码库测试覆盖率需达到 90% 以上。', { workspaceId: ws1 });
    expect(resUpdate.action).toBe('updated');

    const entry = getCoreMemory(db, 'project', { workspaceId: ws1 });
    expect(entry?.content).toContain('V2');
    expect(entry?.version).toBe(2);
  });

  it('should append content to core memory block (appendCoreMemory)', () => {
    setCoreMemory(db, 'persona', '基调严谨务实。', { workspaceId: ws1 });
    const appRes = appendCoreMemory(db, 'persona', '原则：零虚构，绝不臆造未经验证的库或参数。', { workspaceId: ws1 });
    expect(appRes.newContent).toContain('基调严谨务实。');
    expect(appRes.newContent).toContain('原则：零虚构');

    const entry = getCoreMemory(db, 'persona', { workspaceId: ws1 });
    expect(entry?.content).toBe(appRes.newContent);
  });

  it('should format core memories as structured markdown for system prompt', () => {
    setCoreMemory(db, 'human', '用户姓名 Alex', { workspaceId: ws1 });
    setCoreMemory(db, 'persona', '专业代码审查员', { workspaceId: ws1 });

    const all = getAllCoreMemories(db, { workspaceId: ws1 });
    const rendered = renderCoreMemoryMarkdown(all);

    expect(rendered).toContain('### 🧠 Core Memory (Letta/MemGPT Scratchpad)');
    expect(rendered).toContain('- **[HUMAN]**: 用户姓名 Alex');
    expect(rendered).toContain('- **[PERSONA]**: 专业代码审查员');
  });

  it('should keep unapproved model core proposals unpinned until explicit approval', () => {
    const proposal = setCoreMemory(db, 'project', 'Model-suggested build rule.', {
      workspaceId: ws1,
      actor: 'llm',
    });
    expect(proposal.action).toBe('proposed');

    const before = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [proposal.id])!;
    expect(before.status).toBe('candidate');
    expect(before.pinned).toBe(0);
    expect(renderStableLayer(db, { workspaceId: ws1 }).text).toBe('');

    expect(approveCandidate(db, proposal.id, 'user').action).toBe('approved');
    const after = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [proposal.id])!;
    expect(after.status).toBe('active');
    expect(after.pinned).toBe(1);
    expect(after.importance).toBe(10);
    expect(after.utility).toBe(1.0);
    expect(renderStableLayer(db, { workspaceId: ws1 }).text).toContain('Model-suggested build rule.');
  });
});
