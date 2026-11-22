import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import type { Db, MemoryRecord } from '../../src/types.js';
import {
  upsertCandidate,
  approveCandidate,
  editContent,
  editMemory,
  rollback,
  forget,
  freeze,
  unfreeze,
  pin,
  unpin,
  applyUtility,
  confirmMemory,
  mergeMemories,
  restoreMemory,
  truncateToTokens,
} from '../../src/core/writer.js';
import { getCachedRuntimeEmbedding } from '../../src/core/vector.js';
import { workspaceId } from '../../src/core/scope.js';
import { estimateTokens } from '../../src/core/tokens.js';

describe('M1-T3: writer.ts Pipeline Tests (12 Required Checks)', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  // 1. 插入一条记录 → memories、memory_fts、memory_entities、memory_sources 四张表中都有对应数据
  it('1. should insert record into memories, memory_fts, memory_entities, and memory_sources', () => {
    const res = upsertCandidate(db, {
      type: 'semantic',
      content: '项目数据库使用 PostgreSQL 16，监听在 5432 端口',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 'sess_01', seq: 10, kind: 'user_msg' }],
      actor: 'user',
    });

    expect(res.action).toBe('inserted');
    const memId = (res as any).id;

    // memories 表
    const mem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [memId]);
    expect(mem).toBeDefined();
    expect(mem?.status).toBe('active');

    // memory_fts 表
    const fts = db.get('SELECT * FROM memory_fts WHERE rowid = ?', [mem?.rowid_]);
    expect(fts).toBeDefined();

    // memory_entities 表
    const entities = db.all('SELECT * FROM memory_entities WHERE memory_id = ?', [memId]);
    expect(entities.length).toBeGreaterThan(0);

    // memory_sources 表
    const sources = db.all('SELECT * FROM memory_sources WHERE memory_id = ?', [memId]);
    expect(sources).toHaveLength(1);
    expect(sources[0].session_id).toBe('sess_01');
  });

  // 2. 两个独立来源插入同内容 → merged、证据幂等追加；未批准来源不会晋升。同一证据再次重放，confidence/use_count 不变
  it('2. should merge same content idempotently from separate sources without unapproved promotion', () => {
    const input1 = {
      type: 'semantic' as const,
      content: 'Redis 运行在 6379 端口',
      source_kind: 'assistant' as const,
      confidence: 0.6,
      origin_kinds: ['assistant' as const],
      sources: [{ session_id: 'sess_A', seq: 1, kind: 'assistant_msg' }],
      actor: 'llm' as const,
    };

    const res1 = upsertCandidate(db, input1);
    expect(res1.action).toBe('inserted');
    const id = (res1 as any).id;

    const mem1 = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id]);
    expect(mem1?.status).toBe('candidate');

    // 独立来源 2（同为非用户来源）
    const res2 = upsertCandidate(db, {
      ...input1,
      sources: [{ session_id: 'sess_B', seq: 5, kind: 'assistant_msg' }],
    });
    expect(res2.action).toBe('merged');

    const sources2 = db.all('SELECT * FROM memory_sources WHERE memory_id = ?', [id]);
    expect(sources2).toHaveLength(2);

    const mem2 = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id]);
    expect(mem2?.status).toBe('candidate'); // 未批准来源不晋升

    // 重放来源 2
    const res3 = upsertCandidate(db, {
      ...input1,
      sources: [{ session_id: 'sess_B', seq: 5, kind: 'assistant_msg' }],
    });
    expect(res3.action).toBe('merged');
    const sources3 = db.all('SELECT * FROM memory_sources WHERE memory_id = ?', [id]);
    expect(sources3).toHaveLength(2); // 幂等，不重复增加
    const mem3 = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id]);
    expect(mem3?.confidence).toBe(mem2?.confidence);
    expect(mem3?.use_count).toBe(0);
  });

  // 3. 两次显式用户确认先 MySQL 后 PostgreSQL，同 scopeKey/slot → superseded 链、valid_to/快照正确
  it('3. should create superseded chain and snapshot on consecutive explicit user updates to same slot', () => {
    const t1 = 1000;
    const t2 = 2000;

    const res1 = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '项目数据库是 MySQL 8',
        slot_key: 'project.database',
        source_kind: 'user',
        confidence: 1.0,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
        actor: 'user',
      },
      t1
    );
    expect(res1.action).toBe('inserted');
    const id1 = (res1 as any).id;

    const res2 = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '项目数据库已迁移到 PostgreSQL 16',
        slot_key: 'project.database',
        source_kind: 'user',
        confidence: 1.0,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 10, kind: 'user_msg' }],
        actor: 'user',
      },
      t2
    );
    expect(res2.action).toBe('superseded');
    const id2 = (res2 as any).id;
    expect((res2 as any).oldId).toBe(id1);

    // 验证旧记录状态和 valid_to
    const oldMem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id1]);
    expect(oldMem?.status).toBe('superseded');
    expect(oldMem?.valid_to).toBe(t2);

    // 验证新记录状态
    const newMem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id2]);
    expect(newMem?.status).toBe('active');

    // 验证快照
    const snapshot = db.get<{ snapshot: string }>(
      'SELECT snapshot FROM memory_versions WHERE memory_id = ? AND reason = ?',
      [id1, 'supersede']
    );
    expect(snapshot).toBeDefined();
    expect(snapshot?.snapshot).toContain('MySQL 8');

    // 验证关系
    const rel = db.get(
      'SELECT * FROM memory_relations WHERE from_id = ? AND to_id = ? AND rel = ?',
      [id2, id1, 'supersedes']
    );
    expect(rel).toBeDefined();
  });

  // 4. 旧记录是 frozen → 结果为 conflict_pending
  it('4. should return conflict_pending when updating a frozen slot', () => {
    const res1 = upsertCandidate(db, {
      type: 'semantic',
      content: '主分支名称是 main',
      slot_key: 'project.branch.main',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
      actor: 'user',
    });
    const id1 = (res1 as any).id;
    freeze(db, id1);

    const res2 = upsertCandidate(db, {
      type: 'semantic',
      content: '主分支名称修改为 master',
      slot_key: 'project.branch.main',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 5, kind: 'user_msg' }],
      actor: 'user',
    });

    expect(res2.action).toBe('conflict_pending');
    expect((res2 as any).withId).toBe(id1);

    const oldMem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id1]);
    expect(oldMem?.status).toBe('frozen'); // 依然 frozen，未被修改
  });

  // 5. source_kind='web' → status='candidate'，confidence ≤ 0.5
  it('5. should enforce status=candidate and confidence <= 0.5 for web sources', () => {
    const res = upsertCandidate(db, {
      type: 'semantic',
      content: '来自某个网页的技术文档内容',
      source_kind: 'web',
      confidence: 0.95,
      origin_kinds: ['web'],
      sources: [{ session_id: 's1', seq: 2, kind: 'web' }],
      actor: 'llm',
    });

    expect(res.action).toBe('inserted');
    const id = (res as any).id;

    const mem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id]);
    expect(mem?.status).toBe('candidate');
    expect(mem?.confidence).toBeLessThanOrEqual(0.5);
  });

  // 6. rollback(id, 1) 之后，content 恢复为版本 1 的内容，version 递增
  it('6. should restore version 1 content on rollback(id, 1) and increment version', () => {
    const res = upsertCandidate(db, {
      type: 'semantic',
      content: '初始正文 V1',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
      actor: 'user',
    });
    const id = (res as any).id;

    editContent(db, id, '修改后的正文 V2');
    const memV2 = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id]);
    expect(memV2?.version).toBe(2);
    expect(memV2?.content).toBe('修改后的正文 V2');

    rollback(db, id, 1);
    const memRolled = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id]);
    expect(memRolled?.version).toBe(3);
    expect(memRolled?.content).toBe('初始正文 V1');
  });

  // 7. forget 之后，记录仍然存在，status='archived'
  it('7. should keep record in db with status=archived upon forget', () => {
    const res = upsertCandidate(db, {
      type: 'semantic',
      content: '需要遗忘的过时配置',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
      actor: 'user',
    });
    const id = (res as any).id;

    const forgot = forget(db, id);
    expect(forgot).toBe(true);

    const mem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id]);
    expect(mem).toBeDefined();
    expect(mem?.status).toBe('archived');
  });

  // 8. 同一 web 内容跨两个 session → 仍 candidate、confidence≤0.5；memory_note 和 rule 包装的工具内容同样不晋升
  it('8. should remain candidate with confidence <= 0.5 across sessions for web / tool content', () => {
    const webContent = '公共网页上的某种架构说明';
    const res1 = upsertCandidate(db, {
      type: 'semantic',
      content: webContent,
      source_kind: 'web',
      confidence: 0.9,
      origin_kinds: ['web'],
      sources: [{ session_id: 'session_web_1', seq: 1, kind: 'web' }],
      actor: 'llm',
    });
    const id = (res1 as any).id;

    const res2 = upsertCandidate(db, {
      type: 'semantic',
      content: webContent,
      source_kind: 'web',
      confidence: 0.9,
      origin_kinds: ['web'],
      sources: [{ session_id: 'session_web_2', seq: 1, kind: 'web' }],
      actor: 'llm',
    });
    expect(res2.action).toBe('merged');

    const mem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id]);
    expect(mem?.status).toBe('candidate');
    expect(mem?.confidence).toBeLessThanOrEqual(0.5);
  });

  // 9. 同槽位 candidate 新值 → 已批准 active 完全不变；approve 时才按差异确认替换，frozen 拒绝
  it('9. should leave active record untouched on candidate slot update, and handle approval/freeze rules', () => {
    const resActive = upsertCandidate(db, {
      type: 'semantic',
      content: '当前活跃配置: Port=8080',
      slot_key: 'app.port',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
      actor: 'user',
    });
    const activeId = (resActive as any).id;

    // 助手或离线任务生成相同 slot_key 的 candidate 新值
    const resCand = upsertCandidate(db, {
      type: 'semantic',
      content: '提议的新配置: Port=9090',
      slot_key: 'app.port',
      source_kind: 'assistant',
      confidence: 0.7,
      origin_kinds: ['assistant'],
      sources: [{ session_id: 's1', seq: 5, kind: 'assistant_msg' }],
      actor: 'llm',
    });
    expect(resCand.action).toBe('conflict_pending');
    const candId = (resCand as any).id;

    // 原活跃记录未受丝毫影响
    const activeMem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [activeId]);
    expect(activeMem?.status).toBe('active');
    expect(activeMem?.content).toBe('当前活跃配置: Port=8080');

    // 批准候选
    const appRes = approveCandidate(db, candId, 'user');
    expect(appRes.action).toBe('superseded');
    expect((appRes as any).oldId).toBe(activeId);

    const oldMem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [activeId]);
    expect(oldMem?.status).toBe('superseded');
    const approvedMem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [candId]);
    expect(approvedMem?.status).toBe('active');

    // 若现在将新记录 frozen，再次提议候选并批准应被拒绝
    freeze(db, candId);
    const resCand2 = upsertCandidate(db, {
      type: 'semantic',
      content: '再次提议: Port=7070',
      slot_key: 'app.port',
      source_kind: 'assistant',
      confidence: 0.7,
      origin_kinds: ['assistant'],
      sources: [{ session_id: 's1', seq: 8, kind: 'assistant_msg' }],
      actor: 'llm',
    });
    const candId2 = (resCand2 as any).id;
    const appRes2 = approveCandidate(db, candId2, 'user');
    expect(appRes2.action).toBe('rejected');
    expect((appRes2 as any).reason).toBe('slot_is_frozen');
  });

  // 10. 长句只改端口 5432→6432、版本或否定词，即使 jaccard≥0.8，仍保留不同事实；不同 slot/scopeKey 不能错误 merge
  it('10. should keep separate facts when hash differs even if jaccard >= 0.8', () => {
    const textA = 'PostgreSQL 主数据库集群服务监听在 5432 端口并启用 SSL 传输加密';
    const textB = 'PostgreSQL 主数据库集群服务监听在 6432 端口并启用 SSL 传输加密';

    const resA = upsertCandidate(db, {
      type: 'semantic',
      content: textA,
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
      actor: 'user',
    });

    const resB = upsertCandidate(db, {
      type: 'semantic',
      content: textB,
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 2, kind: 'user_msg' }],
      actor: 'user',
    });

    expect(resA.action).toBe('inserted');
    expect(resB.action).toBe('inserted');

    const idA = (resA as any).id;
    const idB = (resB as any).id;
    expect(idA).not.toBe(idB);

    // 验证建立了 related 关系
    const rel = db.get(
      'SELECT * FROM memory_relations WHERE from_id = ? AND to_id = ? AND rel = ?',
      [idB, idA, 'related']
    );
    expect(rel).toBeDefined();
  });

  // 11. 唯一索引禁止同 scopeKey/slot 两个 active/frozen；跨 workspace/session 同名槽位不互相覆盖
  it('11. should enforce live slot uniqueness per scopeKey but allow same slot across different workspaces', () => {
    const resWs1 = upsertCandidate(db, {
      type: 'semantic',
      content: '工作区 1 的数据库配置',
      slot_key: 'common.db',
      scope: 'workspace',
      workspaceId: 'C:/ws1',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
      actor: 'user',
    });
    expect(resWs1.action).toBe('inserted');

    const resWs2 = upsertCandidate(db, {
      type: 'semantic',
      content: '工作区 2 的数据库配置',
      slot_key: 'common.db',
      scope: 'workspace',
      workspaceId: 'C:/ws2',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
      actor: 'user',
    });
    expect(resWs2.action).toBe('inserted');

    // 两者并存且都为 active
    const id1 = (resWs1 as any).id;
    const id2 = (resWs2 as any).id;
    expect(db.get<MemoryRecord>('SELECT status FROM memories WHERE id = ?', [id1])?.status).toBe('active');
    expect(db.get<MemoryRecord>('SELECT status FROM memories WHERE id = ?', [id2])?.status).toBe('active');
  });

  // 12. edit/rollback 更新 content_rev 与 FTS/entities，旧 embedding 清空；只有统计/证据变化不递增正文版本。敏感 content/excerpt 拒绝且不出现在快照/日志
  it('12. should manage content_rev, FTS, entities, clear embeddings, and reject sensitive credentials', () => {
    const res = upsertCandidate(db, {
      type: 'semantic',
      content: '初始部署脚本 deploy.sh 使用 npm run build',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
      actor: 'user',
    });
    const id = (res as any).id;

    // 模拟设置 embedding
    db.run('UPDATE memories SET embedding = ? WHERE id = ?', [Buffer.from([1, 2, 3]), id]);
    expect(db.get<MemoryRecord>('SELECT embedding FROM memories WHERE id = ?', [id])?.embedding).toBeDefined();

    // 仅统计变化 (applyUtility)
    applyUtility(db, id, 0.8, 1, 0);
    const memStat = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id]);
    expect(memStat?.content_rev).toBe(1); // 不递增 content_rev
    expect(memStat?.version).toBe(1);

    // 编辑正文
    const editRes = editContent(db, id, '更新部署脚本 deploy.sh 使用 pnpm build');
    expect(editRes.content_rev).toBe(2);
    expect(editRes.version).toBe(2);

    const memEdited = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id]);
    // v0.7.0: 旧伪造 3-byte embedding 被即时重算覆盖为最新 128D Float32 BLOB (512 bytes)
    expect(memEdited?.embedding).toBeDefined();
    expect(memEdited?.embedding?.byteLength).toBe(512);

    // FTS 更新
    const fts = db.get<{ fts_text: string }>('SELECT fts_text FROM memory_fts WHERE rowid = ?', [memEdited?.rowid_]);
    expect(fts?.fts_text).toContain('pnpm');

    // 敏感内容输入拒绝
    const sensitiveRes = upsertCandidate(db, {
      type: 'semantic',
      content: '数据库连接串 postgres://admin:superSecret123@db.internal:5432/prod',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 10, kind: 'user_msg' }],
      actor: 'user',
    });
    expect(sensitiveRes.action).toBe('rejected');
    expect((sensitiveRes as any).reason).toBe('sensitive_content_detected');
  });

  // 13. 非用户新证据命中已归档/置顶记录时必须递增 content_rev 并清空 pinned/approved/invalidated_at
  it('13. should isolate sources and clear pinned/approval state on non-user resurrection of inactive memory', () => {
    const inserted = upsertCandidate(db, {
      type: 'semantic',
      content: '归档前已置顶的项目规范',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
      actor: 'user',
    });
    const id = (inserted as any).id;
    db.run('UPDATE memories SET pinned = 1 WHERE id = ?', [id]);
    expect(forget(db, id)).toBe(true);

    // 非显式用户的新证据再次命中同一正文
    const resurrected = upsertCandidate(db, {
      type: 'semantic',
      content: '归档前已置顶的项目规范',
      source_kind: 'assistant',
      confidence: 0.7,
      origin_kinds: ['assistant'],
      sources: [{ session_id: 's2', seq: 4, kind: 'assistant_msg' }],
      actor: 'llm',
    });
    expect(resurrected).toEqual({ action: 'merged', id });

    const memAfter = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id])!;
    expect(memAfter.status).toBe('candidate');
    expect(memAfter.content_rev).toBe(2);
    expect(memAfter.pinned).toBe(0);
    expect(memAfter.approved_at).toBeNull();
    expect(memAfter.approved_by).toBeNull();
    expect(memAfter.valid_to).toBeNull();
    expect(memAfter.invalidated_at).toBeNull();

    // 旧 rev=1 的 user source 留存，新 rev=2 只有 assistant_msg source（禁止自治自动晋升）
    const rev2Sources = db.all<{ kind: string }>(
      'SELECT kind FROM memory_sources WHERE memory_id = ? AND content_rev = ?',
      [id, 2]
    );
    expect(rev2Sources.map((s) => s.kind)).toEqual(['assistant_msg']);
    expect(approveCandidate(db, id, 'autonomous').action).toBe('rejected');

    // 若用户先 archive 后再由用户显式重新写入同文本，invalidated_at 与 valid_to 同步清空
    forget(db, id);
    const reactivated = upsertCandidate(db, {
      type: 'semantic',
      content: '归档前已置顶的项目规范',
      source_kind: 'user',
      confidence: 0.95,
      origin_kinds: ['user'],
      sources: [{ session_id: 's3', seq: 1, kind: 'user_msg' }],
      actor: 'user',
    });
    expect(reactivated).toEqual({ action: 'merged', id });
    const memReactivated = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id])!;
    expect(memReactivated.status).toBe('active');
    expect(memReactivated.valid_to).toBeNull();
    expect(memReactivated.invalidated_at).toBeNull();
  });

  it('14. P0 taint fix: web/tool taint clears isExplicitUser and approved_by even for user actor', () => {
    const res = upsertCandidate(db, {
      type: 'semantic',
      content: '从网页复制的配置：端口 9999',
      source_kind: 'user',
      confidence: 1.0,
      status: 'active',
      origin_kinds: ['user', 'web'],
      sources: [{ session_id: 's_taint', seq: 1, kind: 'web' }],
      actor: 'user',
    });
    expect(res.action).toBe('inserted');
    const id = (res as any).id;
    const mem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id])!;
    expect(mem.status).toBe('candidate');
    expect(mem.confidence).toBeLessThanOrEqual(0.5);
    expect(mem.approved_at).toBeNull();
    expect(mem.approved_by).toBeNull();

    // Re-upserting tainted input on existing candidate must NOT promote it to active
    const mergeRes = upsertCandidate(db, {
      type: 'semantic',
      content: '从网页复制的配置：端口 9999',
      source_kind: 'user',
      confidence: 1.0,
      status: 'active',
      origin_kinds: ['user'],
      sources: [{ session_id: 's_taint', seq: 2, kind: 'tool_result' }],
      actor: 'user',
    });
    expect(mergeRes).toEqual({ action: 'merged', id });
    const afterMerge = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id])!;
    expect(afterMerge.status).toBe('candidate');
    expect(afterMerge.confidence).toBeLessThanOrEqual(0.5);
    expect(afterMerge.approved_by).toBeNull();
    expect(JSON.parse(afterMerge.origin_kinds as unknown as string)).toEqual(
      expect.arrayContaining(['user', 'web', 'tool'])
    );
  });

  it('15. deduplicates repeated slot conflict_pending candidates idempotently', () => {
    const activeRes = upsertCandidate(db, {
      type: 'semantic',
      content: '当前框架使用 Vite 5',
      slot_key: 'project.bundler',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
      actor: 'user',
    });
    const activeId = (activeRes as any).id;

    const cand1 = upsertCandidate(db, {
      type: 'semantic',
      content: '提议切换到 Turbopack',
      slot_key: 'project.bundler',
      source_kind: 'assistant',
      confidence: 0.4,
      origin_kinds: ['assistant'],
      sources: [{ session_id: 's1', seq: 2, kind: 'assistant_msg' }],
      actor: 'llm',
    });
    const cand2 = upsertCandidate(db, {
      type: 'semantic',
      content: '提议切换到 Turbopack',
      slot_key: 'project.bundler',
      source_kind: 'assistant',
      confidence: 0.4,
      origin_kinds: ['assistant'],
      sources: [{ session_id: 's2', seq: 3, kind: 'assistant_msg' }],
      actor: 'llm',
    });

    expect(cand1.action).toBe('conflict_pending');
    expect(cand2.action).toBe('conflict_pending');
    expect((cand2 as any).id).toBe((cand1 as any).id);
    expect((cand2 as any).withId).toBe(activeId);

    const candidateRows = db.all("SELECT id FROM memories WHERE slot_key = 'project.bundler' AND status = 'candidate'");
    expect(candidateRows).toHaveLength(1);
    const srcs = db.all('SELECT * FROM memory_sources WHERE memory_id = ?', [(cand1 as any).id]);
    expect(srcs).toHaveLength(2);
  });

  it('16. Step 3 merge preserves web/tool taint across assistant merges and records system approver + snapshots', () => {
    // A: web candidate followed by assistant mention -> stays <= 0.5 and unions origin_kinds
    const webRes = upsertCandidate(db, {
      type: 'semantic',
      content: '实验性特性开关默认关闭',
      source_kind: 'web',
      confidence: 0.5,
      origin_kinds: ['web'],
      sources: [{ session_id: 's1', seq: 1, kind: 'web' }],
      actor: 'llm',
    });
    const webId = (webRes as any).id;
    upsertCandidate(db, {
      type: 'semantic',
      content: '实验性特性开关默认关闭',
      source_kind: 'assistant',
      confidence: 0.8,
      origin_kinds: ['assistant'],
      sources: [{ session_id: 's2', seq: 1, kind: 'assistant_msg' }],
      actor: 'llm',
    });
    const webMem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [webId])!;
    expect(webMem.confidence).toBeLessThanOrEqual(0.5);
    expect(JSON.parse(webMem.origin_kinds as unknown as string)).toEqual(
      expect.arrayContaining(['web', 'assistant'])
    );

    // B: clean assistant candidate promoted by system actor -> approved_by='system', version=2, snapshot saved
    const cleanRes = upsertCandidate(db, {
      type: 'semantic',
      content: '系统初始化约定的日志格式为 JSON',
      source_kind: 'assistant',
      confidence: 0.6,
      origin_kinds: ['assistant'],
      sources: [{ session_id: 's1', seq: 10, kind: 'assistant_msg' }],
      actor: 'llm',
    });
    const cleanId = (cleanRes as any).id;
    upsertCandidate(db, {
      type: 'semantic',
      content: '系统初始化约定的日志格式为 JSON',
      source_kind: 'system',
      status: 'active',
      confidence: 0.9,
      origin_kinds: ['system'],
      sources: [{ session_id: 's1', seq: 11, kind: 'system' }],
      actor: 'system',
    });
    const promoted = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [cleanId])!;
    expect(promoted.status).toBe('active');
    expect(promoted.approved_by).toBe('system');
    expect(promoted.version).toBe(2);
    const snap = db.get('SELECT * FROM memory_versions WHERE memory_id = ? AND reason = ?', [cleanId, 'approve']);
    expect(snap).toBeDefined();
  });

  it('17. enforces lifecycle guards across confirmMemory, freeze, restoreMemory, forget, pin/unpin, mergeMemories, applyUtility', () => {
    const t0 = 10_000;
    const activeRes = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '核心构建工具固定使用 pnpm',
        slot_key: 'build.tool',
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
        actor: 'user',
      },
      t0
    );
    const activeId = (activeRes as any).id;

    // applyUtility must NOT increment use_count or touch updated_at, and must clamp/validate
    applyUtility(db, activeId, 1.5, 1, 0, t0 + 5000);
    const afterUtil = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [activeId])!;
    expect(afterUtil.utility).toBe(1.0);
    expect(afterUtil.use_count).toBe(0);
    expect(afterUtil.updated_at).toBe(t0);
    expect(afterUtil.last_used_at).toBe(t0 + 5000);
    expect(() => applyUtility(db, activeId, Number.NaN)).toThrow('invalid_utility');
    expect(() => applyUtility(db, activeId, 0.5, 1.5, 0)).toThrow('invalid_delta_success');

    // pin / unpin record snapshots & bump version, and pin rejects candidate/archived
    expect(pin(db, activeId, 'user', t0 + 100)).toBe(true);
    expect(db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [activeId])?.version).toBe(2);
    expect(unpin(db, activeId, 'user', t0 + 200)).toBe(true);
    expect(db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [activeId])?.version).toBe(3);

    // freeze active -> frozen; forget & confirmMemory & restoreMemory must reject frozen
    expect(freeze(db, activeId, 'user', t0 + 300)).toBe(true);
    expect(forget(db, activeId, 'user', t0 + 400)).toBe(false);
    expect(confirmMemory(db, activeId, 'user', t0 + 400).success).toBe(false);
    expect(restoreMemory(db, activeId, 'user', t0 + 400).success).toBe(false);

    // Candidate on frozen slot: confirmMemory must fail WITHOUT creating an orphan snapshot
    const candRes = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '尝试改用 yarn 作为构建工具',
        slot_key: 'build.tool',
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 2, kind: 'user_msg' }],
        actor: 'user',
      },
      t0 + 500
    );
    expect(candRes.action).toBe('conflict_pending');
    const candId = (candRes as any).id;

    // pin & freeze & restoreMemory must reject candidate
    expect(pin(db, candId)).toBe(false);
    expect(freeze(db, candId)).toBe(false);
    expect(restoreMemory(db, candId).success).toBe(false);

    const confirmFrozenRes = confirmMemory(db, candId, 'user', t0 + 600);
    expect(confirmFrozenRes.success).toBe(false);
    expect(db.all('SELECT * FROM memory_versions WHERE memory_id = ?', [candId])).toHaveLength(0);

    // approveCandidate pending repair_proposals check uses json_each (exact element match)
    db.run(
      `INSERT INTO repair_proposals (job_id, memory_id, content_rev, action, candidate_ids, reason, status, created_at, expires_at)
       VALUES (99, ?, 1, 'revise', ?, 'test repair', 'candidate', ?, ?)`,
      [activeId, JSON.stringify([candId]), t0, t0 + 86400_000]
    );
    expect(approveCandidate(db, candId, 'user', t0 + 700)).toEqual({
      action: 'rejected',
      reason: 'pending_repair_proposals',
    });
    expect(confirmMemory(db, candId, 'user', t0 + 700).success).toBe(false);
    expect(db.all('SELECT * FROM memory_versions WHERE memory_id = ?', [candId])).toHaveLength(0);

    // unfreeze -> forget sets valid_to and invalidated_at -> restoreMemory succeeds
    expect(unfreeze(db, activeId, 'user', t0 + 800)).toBe(true);
    expect(forget(db, activeId, 'user', t0 + 900)).toBe(true);
    const archived = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [activeId])!;
    expect(archived.status).toBe('archived');
    expect(archived.valid_to).toBe(t0 + 900);
    expect(archived.invalidated_at).toBe(t0 + 900);
    expect(restoreMemory(db, activeId, 'user', t0 + 1000).success).toBe(true);
    expect(db.get<MemoryRecord>('SELECT status FROM memories WHERE id = ?', [activeId])?.status).toBe('active');
  });

  it('18. mergeMemories preserves taint in origin_kinds and gates utility/confidence boosts on trustedActor', () => {
    const targetRes = upsertCandidate(db, {
      type: 'semantic',
      content: '部署服务使用 Docker Compose 编排',
      source_kind: 'user',
      confidence: 0.7,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
      actor: 'user',
    });
    const sourceRes = upsertCandidate(db, {
      type: 'semantic',
      content: '外部文档提到服务通过 docker-compose 启动',
      source_kind: 'web',
      confidence: 0.5,
      origin_kinds: ['web'],
      sources: [{ session_id: 's1', seq: 2, kind: 'web' }],
      actor: 'llm',
    });
    const targetId = (targetRes as any).id;
    const sourceId = (sourceRes as any).id;

    const mRes = mergeMemories(db, sourceId, targetId, 'llm_dedup', 'llm', 5000);
    expect(mRes.success).toBe(true);

    const target = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [targetId])!;
    expect(target.utility).toBe(0.5); // llm does NOT boost utility
    expect(target.success_count).toBe(0); // llm does NOT boost success_count
    expect(target.confidence).toBeLessThanOrEqual(0.85);
    expect(JSON.parse(target.origin_kinds as unknown as string)).toEqual(
      expect.arrayContaining(['user', 'web'])
    );
  });

  it('19. editContent validates empty content & emoji truncation; editMemory enforces guards & atomic updates', () => {
    const wsA = workspaceId('C:/ws-edit-a');
    const wsB = workspaceId('C:/ws-edit-b');

    const r1 = upsertCandidate(db, {
      type: 'semantic',
      content: '初始内容指向端口 3000',
      slot_key: 'svc.port',
      scope: 'workspace',
      workspaceId: wsA,
      source_kind: 'user',
      confidence: 0.9,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
      actor: 'user',
    });
    const id1 = (r1 as any).id;

    // editContent rejects empty/whitespace content
    expect(() => editContent(db, id1, '   \n\t  ')).toThrow('empty_content');

    // truncateToTokens is code-point safe on emoji / surrogate pairs
    const emojiSummary = '🚀🔥'.repeat(120);
    const truncated = truncateToTokens(emojiSummary, 20);
    expect(estimateTokens(truncated)).toBeLessThanOrEqual(20);
    expect(() => encodeURIComponent(truncated)).not.toThrow(); // no lone surrogates

    // editMemory rejects assigning core:* slot_key on non-core memory
    expect(() =>
      editMemory(db, id1, { slot_key: 'core:project' }, 'user')
    ).toThrow('cannot_assign_core_slot_key');

    // Create occupant on wsB slot 'svc.port', then move id1 into wsB -> supersedes occupant
    const r2 = upsertCandidate(db, {
      type: 'semantic',
      content: '工作区 B 原有端口 4000',
      slot_key: 'svc.port',
      scope: 'workspace',
      workspaceId: wsB,
      source_kind: 'user',
      confidence: 0.9,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 2, kind: 'user_msg' }],
      actor: 'user',
    });
    const id2 = (r2 as any).id;

    const editRes = editMemory(
      db,
      id1,
      {
        content: '迁移到工作区 B 的新端口 5000',
        type: 'procedural',
        scope: 'workspace',
        workspaceId: wsB,
        importance: 9,
      },
      'user',
      9000
    );
    expect(editRes.ok).toBe(true);
    expect(editRes.supersededId).toBe(id2);
    expect(editRes.memory.workspace_id).toBe(wsB);
    expect(editRes.memory.type).toBe('procedural');
    expect(editRes.memory.importance).toBe(9);
    expect(Array.isArray(editRes.memory.origin_kinds)).toBe(true);
    expect(db.get<MemoryRecord>('SELECT status, invalidated_at FROM memories WHERE id = ?', [id2])).toMatchObject({
      status: 'superseded',
      invalidated_at: 9000,
    });
    expect(
      db.get('SELECT 1 FROM memory_relations WHERE from_id = ? AND to_id = ? AND rel = ?', [id1, id2, 'supersedes'])
    ).toBeDefined();

    // Frozen memory cannot be edited via editMemory
    freeze(db, id1);
    expect(() => editMemory(db, id1, { content: '尝试修改冻结记忆' })).toThrow('memory_is_frozen');
  });

  it('20. truncates source excerpts to 300 code points, scans secrets before truncation, and keeps cache rollback-safe', () => {
    const longExcerpt = '🎉'.repeat(350);
    const res = upsertCandidate(db, {
      type: 'semantic',
      content: '带有超长表情摘录的正常事实',
      source_kind: 'user',
      confidence: 0.9,
      origin_kinds: ['user'],
      sources: [{ session_id: 's_exc', seq: 1, kind: 'user_msg', excerpt: longExcerpt }],
      actor: 'user',
    });
    expect(res.action).toBe('inserted');
    const savedSrc = db.get<{ excerpt: string }>('SELECT excerpt FROM memory_sources WHERE memory_id = ?', [
      (res as any).id,
    ])!;
    expect(Array.from(savedSrc.excerpt).length).toBe(300);
    expect(() => encodeURIComponent(savedSrc.excerpt)).not.toThrow();

    // Secret placed AFTER char 300 in excerpt must still be rejected
    const tailSecretExcerpt = `${'a'.repeat(320)} sk-ant-api03-secretvalue1234567890abcdef`;
    const secretRes = upsertCandidate(db, {
      type: 'semantic',
      content: '尾部藏有密钥摘录的记忆',
      source_kind: 'user',
      confidence: 0.9,
      origin_kinds: ['user'],
      sources: [{ session_id: 's_exc', seq: 2, kind: 'user_msg', excerpt: tailSecretExcerpt }],
      actor: 'user',
    });
    expect(secretRes).toEqual({ action: 'rejected', reason: 'sensitive_content_detected' });

    // Rolled-back outer transaction must NOT prime runtime vector cache
    let rolledBackId = '';
    let rolledBackHash = '';
    expect(() =>
      db.transaction(() => {
        const tmpRes = upsertCandidate(db, {
          type: 'semantic',
          content: '即将被外层事务回滚的记忆条目',
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: 's_rb', seq: 1, kind: 'user_msg' }],
          actor: 'user',
        });
        rolledBackId = (tmpRes as any).id;
        rolledBackHash = db.get<{ hash: string }>('SELECT hash FROM memories WHERE id = ?', [rolledBackId])!.hash;
        throw new Error('force_outer_rollback');
      })
    ).toThrow('force_outer_rollback');

    expect(db.get('SELECT 1 FROM memories WHERE id = ?', [rolledBackId])).toBeUndefined();
    expect(getCachedRuntimeEmbedding(rolledBackId, rolledBackHash, db)).toBeNull();
  });

  it('21. rollback recomputes embedding with nextSlotKey and records supersedes relation on slot conflict', () => {
    const t1 = 1000;
    const t2 = 2000;
    const t3 = 3000;

    const r1 = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '缓存层使用 Redis 7 单节点',
        slot_key: 'cache.engine',
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_rb', seq: 1, kind: 'user_msg' }],
        actor: 'user',
      },
      t1
    );
    const id1 = (r1 as any).id;

    // Move id1 off slot_key='cache.engine' so another memory can claim that slot
    editMemory(db, id1, { content: '缓存层暂不绑定槽位', slot_key: null }, 'user', t2);
    const r2 = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '缓存层改用 Memcached',
        slot_key: 'cache.engine',
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_rb', seq: 2, kind: 'user_msg' }],
        actor: 'user',
      },
      t2 + 100
    );
    const id2 = (r2 as any).id;

    // Rollback id1 to v1 (slot_key='cache.engine') -> must supersede id2 with supersedes relation & invalidated_at
    const rbRes = rollback(db, id1, 1, 'user', t3);
    expect(rbRes.ok).toBe(true);
    const afterId1 = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id1])!;
    const afterId2 = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id2])!;
    expect(afterId1.slot_key).toBe('cache.engine');
    expect(afterId2.status).toBe('superseded');
    expect(afterId2.valid_to).toBe(t3);
    expect(afterId2.invalidated_at).toBe(t3);
    expect(
      db.get('SELECT 1 FROM memory_relations WHERE from_id = ? AND to_id = ? AND rel = ?', [id1, id2, 'supersedes'])
    ).toBeDefined();
  });
});
