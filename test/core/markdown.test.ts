import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import { upsertCandidate } from '../../src/core/writer.js';
import { get } from '../../src/core/store.js';
import {
  serializeMemoryToMarkdown,
  parseMemoryMarkdown,
  exportToMarkdown,
  importFromMarkdown,
  trashMemory,
  restoreFromTrash,
} from '../../src/core/markdown.js';

describe('Markdown Sync & Frontmatter (汲取自 LZMW/dsh-memory)', () => {
  let db: Db;
  let tmpDir: string;

  beforeEach(() => {
    db = openDb(':memory:');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-md-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('should serialize and parse markdown with YAML frontmatter correctly', () => {
    const rawRecord: any = {
      id: 'm_test1234567890',
      type: 'semantic',
      scope: 'workspace',
      status: 'active',
      summary: 'TypeScript strict 模式配置',
      content: '所有模块都必须开启 strict: true 与 noImplicitAny',
      confidence: 0.95,
      utility: 0.85,
      pinned: 1,
      content_rev: 1,
      slot_key: 'ts_config',
      workspace_id: 'ws_abc',
      session_id: 'sess_1',
      created_at: 1700000000000,
      updated_at: 1700000050000,
    };

    const entities = ['typescript', 'tsconfig.json'];
    const md = serializeMemoryToMarkdown(rawRecord, entities);

    expect(md).toContain('---');
    expect(md).toContain('id: m_test1234567890');
    expect(md).toContain('type: semantic');
    expect(md).toContain('pinned: 1');
    expect(md).toContain('# TypeScript strict 模式配置');
    expect(md).toContain('所有模块都必须开启 strict: true 与 noImplicitAny');

    // 解析回来
    const parsed = parseMemoryMarkdown(md);
    expect(parsed.frontmatter.id).toBe('m_test1234567890');
    expect(parsed.frontmatter.type).toBe('semantic');
    expect(parsed.frontmatter.pinned).toBe(1);
    expect(parsed.summary).toBe('TypeScript strict 模式配置');
    expect(parsed.content).toContain('所有模块都必须开启 strict: true 与 noImplicitAny');
  });

  it('should export database memories to Markdown directory and import back cleanly', () => {
    // 写入两条测试数据
    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: 'PostgreSQL 生产端口为 5432，使用 SSL 连接',
        summary: 'PostgreSQL 数据库配置',
        scope: 'workspace',
        workspaceId: 'ws_db',
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      Date.now()
    );

    upsertCandidate(
      db,
      {
        type: 'preference',
        content: '前端全部采用 TailwindCSS 与 UnoCSS 原子样式',
        summary: 'CSS 样式方案偏好',
        scope: 'user',
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 's2', seq: 2, kind: 'user' }],
        actor: 'user',
      },
      Date.now()
    );

    // 1. 导出到 Markdown 目录
    const exportRes = exportToMarkdown(db, tmpDir);
    expect(exportRes.exportedCount).toBe(2);
    expect(exportRes.files.length).toBe(2);

    for (const f of exportRes.files) {
      expect(fs.existsSync(f)).toBe(true);
      const text = fs.readFileSync(f, 'utf8');
      expect(text).toContain('---');
    }

    // 2. 在一个全新的内存数据库中导入
    const newDb = openDb(':memory:');
    const importRes = importFromMarkdown(newDb, tmpDir, { workspaceId: 'ws_db' });
    expect(importRes.importedCount).toBe(2);
    expect(importRes.errors.length).toBe(0);

    const mems = newDb.all('SELECT * FROM memories');
    expect(mems.length).toBe(2);
  });

  it('should safely trash memories and restore from .trash/ directory', () => {
    const res = upsertCandidate(
      db,
      {
        type: 'procedural',
        content: '部署前务必执行 npm run lint 和 npm test',
        summary: '发布前质量门禁',
        scope: 'workspace',
        workspaceId: 'ws_gate',
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      Date.now()
    );
    const id = (res as any).id;

    const trashDir = path.join(tmpDir, '.trash');
    const trashRes = trashMemory(db, id, trashDir);
    expect(trashRes.trashed).toBe(true);
    expect(fs.existsSync(path.join(trashDir, `${id}.md`))).toBe(true);

    // 模拟删除记录
    db.run(`UPDATE memories SET status = 'archived' WHERE id = ?`, [id]);
    expect(db.get(`SELECT status FROM memories WHERE id = ?`, [id]).status).toBe('archived');

    // 从回收站恢复
    const restoreRes = restoreFromTrash(db, id, trashDir);
    expect(restoreRes.restored).toBe(true);
    expect(db.get(`SELECT status FROM memories WHERE id = ?`, [id]).status).toBe('active');

    // 当数据库中原记录已被物理删除时，从 .md 文件 fallback 恢复也应直接进入 active 状态
    db.run(`DELETE FROM memories WHERE id = ?`, [id]);
    const fallbackRes = restoreFromTrash(db, id, trashDir);
    expect(fallbackRes.restored).toBe(true);
    const restoredRow = db.get<{ status: string; approved_by: string; content: string }>(
      `SELECT status, approved_by, content FROM memories WHERE content LIKE '%部署前务必执行%'`
    );
    expect(restoredRow?.status).toBe('active');
    expect(restoredRow?.approved_by).toBe('user');
  });
});
