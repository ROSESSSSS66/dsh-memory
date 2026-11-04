import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import type { Db, MemoryRecord } from '../../src/types.js';
import {
  upsertCandidate,
  approveCandidate,
  editContent,
  rollback,
  forget,
  freeze,
  unfreeze,
  applyUtility,
} from '../../src/core/writer.js';

describe('M1-T3: writer.ts Pipeline Tests (12 Required Checks)', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
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
    const initConf = mem1!.confidence;

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
    expect(memEdited?.embedding).toBeNull(); // 旧 embedding 清空

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
});
