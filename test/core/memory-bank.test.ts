import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import { workspaceId } from '../../src/core/scope.js';
import { upsertCandidate } from '../../src/core/writer.js';
import { exportMemoryBank, importMemoryBank } from '../../src/core/markdown.js';

describe('Cline/Roo-Code Memory Bank (markdown.ts)', () => {
  let db: Db;
  let tempDir: string;
  const ws1 = workspaceId('test-ws-memory-bank');
  const now = 1000000;

  beforeEach(() => {
    db = openDb(':memory:');
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-bank-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should export memories into activeContext, systemPatterns, productContext, and progress files', () => {
    // 插入各分类记忆
    upsertCandidate(
      db,
      {
        type: 'goal',
        content: '完成 Phase 1 架构设计与接口审查',
        summary: '当前活跃目标',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.9,
        importance: 9,
        status: 'active',
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );

    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '系统采用 Node 24 原生 node:sqlite 与 FTS5 引擎',
        summary: '底层存储选型',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.95,
        importance: 8,
        status: 'active',
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 2, kind: 'user' }],
        actor: 'user',
      },
      now
    );

    upsertCandidate(
      db,
      {
        type: 'preference',
        content: '优先采用严格 TypeScript 模式与无 Any 约定',
        summary: '代码风格偏好',
        scope: 'user',
        source_kind: 'user',
        confidence: 0.9,
        importance: 7,
        status: 'active',
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 3, kind: 'user' }],
        actor: 'user',
      },
      now
    );

    upsertCandidate(
      db,
      {
        type: 'failure',
        content: '在 Windows 下直接使用 node-gyp 易触发 MSVC 编译缺失错误',
        summary: '原生扩展编译踩坑记录',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.85,
        importance: 8,
        status: 'active',
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 4, kind: 'user' }],
        actor: 'user',
      },
      now
    );

    const exportRes = exportMemoryBank(db, tempDir, { workspaceId: ws1 });
    expect(exportRes.totalMemories).toBe(4);
    expect(exportRes.filesWritten).toHaveLength(4);

    expect(fs.existsSync(path.join(tempDir, 'activeContext.md'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'systemPatterns.md'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'productContext.md'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'progress.md'))).toBe(true);

    const activeText = fs.readFileSync(path.join(tempDir, 'activeContext.md'), 'utf8');
    expect(activeText).toContain('Phase 1 架构设计');

    const patternsText = fs.readFileSync(path.join(tempDir, 'systemPatterns.md'), 'utf8');
    expect(patternsText).toContain('node:sqlite');

    const progressText = fs.readFileSync(path.join(tempDir, 'progress.md'), 'utf8');
    expect(progressText).toContain('node-gyp 易触发');
  });

  it('should import memories back from a Memory Bank directory', () => {
    // 写入一个测试用的 systemPatterns.md
    const patternContent = `# System Patterns
> 架构规范

### [SEMANTIC m_test001] 前端采用 React 19 并结合 Tailwind CSS
- **ID**: \`m_test001\` | **重要度**: \`9/10\` | **置信度**: \`0.95\`

前端技术选型确认采用 React 19 与 Tailwind CSS，杜绝引入额外重量级 UI 库。
---
`;
    fs.writeFileSync(path.join(tempDir, 'systemPatterns.md'), patternContent, 'utf8');

    const importRes = importMemoryBank(db, tempDir, { workspaceId: ws1 });
    expect(importRes.filesProcessed).toBe(1);
    expect(importRes.imported).toBe(1);

    const saved = db.all("SELECT * FROM memories WHERE content LIKE '%React 19%'");
    expect(saved).toHaveLength(1);
  });
});
