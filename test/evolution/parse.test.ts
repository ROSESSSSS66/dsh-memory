import { describe, it, expect } from 'vitest';
import { cleanJsonText, matchesWithWorkspaceGaps, parseOutput } from '../../src/evolution/parse.js';
import { openDb } from '../../src/core/db.js';
import { upsertCandidate } from '../../src/core/writer.js';
import type { EvidenceLedger, EvidenceLedgerEntry } from '../../src/evolution/types.js';
import type { MemoryRecord } from '../../src/types.js';

describe('Evolution Output Parsing (M3-T1)', () => {
  const ledger: EvidenceLedger = new Map<number, EvidenceLedgerEntry>([
    [
      1,
      {
        seq: 1,
        session_id: 's1',
        original_seq: 10,
        kind: 'user_msg',
        redacted_text: 'Please remember to run pnpm build before test in /Users/alice/my-project today',
        rendered_line: '[U#1] Please remember to run pnpm build before test in /Users/alice/my-project today',
        origin_kinds: ['user'],
        time: 1000,
      },
    ],
    [
      2,
      {
        seq: 2,
        session_id: 's2',
        original_seq: 11,
        kind: 'tool_result',
        redacted_text: 'Error: Cannot find module dist/index.js',
        rendered_line: '[T#2] tool=bash ERROR: Error: Cannot find module dist/index.js',
        origin_kinds: ['tool'],
        time: 1100,
      },
    ],
    [
      3,
      {
        seq: 3,
        session_id: 's3',
        original_seq: 12,
        kind: 'user_msg',
        redacted_text: 'Running pnpm build fixed the missing dist/index.js module error',
        rendered_line: '[E#3] (s3#12) Running pnpm build fixed the missing dist/index.js module error',
        origin_kinds: ['user'],
        time: 1200,
      },
    ],
  ]);

  it('accepts naked JSON', () => {
    const raw = '{"items": []}';
    const res: any = parseOutput(raw, {
      taskKind: 'distill',
      evidenceLedger: ledger,
      workspaceId: 'ws1',
    });

    expect(res.success).toBe(true);
    expect(res.items).toEqual([]);
  });

  it('accepts JSON wrapped in multiline or single-line code fence, BOM, <think> blocks, and extracts balanced JSON', () => {
    const multilineFence = '```json\n{"items": []}\n```';
    expect(
      parseOutput(multilineFence, { taskKind: 'distill', evidenceLedger: ledger, workspaceId: 'ws1' }).success
    ).toBe(true);

    const singleLineFence = '```json {"items": []} ```';
    expect(
      parseOutput(singleLineFence, { taskKind: 'distill', evidenceLedger: ledger, workspaceId: 'ws1' }).success
    ).toBe(true);

    const withBomAndThink = '\uFEFF<think>Internal reasoning about {braces}...</think>\n{"items": []}';
    expect(
      parseOutput(withBomAndThink, { taskKind: 'distill', evidenceLedger: ledger, workspaceId: 'ws1' }).success
    ).toBe(true);

    const withProseAndEscapedBraces =
      'Here is the result:\n{"items": [], "note": "escaped \\"quote\\" and } brace"}\nHope this helps!';
    expect(
      parseOutput(withProseAndEscapedBraces, { taskKind: 'distill', evidenceLedger: ledger, workspaceId: 'ws1' })
        .success
    ).toBe(true);

    // Non-JSON garbage still fails cleanly
    const garbage = 'No JSON object here at all';
    const failRes = parseOutput(garbage, { taskKind: 'distill', evidenceLedger: ledger, workspaceId: 'ws1' });
    expect(failRes.success).toBe(false);
    if (!failRes.success) {
      expect(failRes.error).toBe('json_parse_failed');
    }
    expect(cleanJsonText('\uFEFF<think>x</think>{"a":1}')).toBe('{"a":1}');
  });

  it('treats valid empty items as a success no-op', () => {
    const raw = '{"items": []}';
    const res: any = parseOutput(raw, {
      taskKind: 'distill',
      evidenceLedger: ledger,
      workspaceId: 'ws1',
    });

    expect(res.success).toBe(true);
    expect(res.items).toHaveLength(0);
  });

  it('parses valid MemoryItem without double 0.8 confidence discount (single 0.8 applied in writer)', () => {
    const raw = JSON.stringify({
      items: [
        {
          type: 'procedural',
          text: '在本项目中运行测试之前必须先执行 pnpm build。',
          slot_key: 'build-before-test',
          confidence: 0.9,
          scope: 'workspace',
          evidence: [{ seq: 1, quote: 'run pnpm build before test' }],
        },
      ],
    });

    const res: any = parseOutput(raw, {
      taskKind: 'distill',
      evidenceLedger: ledger,
      workspaceId: 'ws1',
      sessionId: 's1',
    });

    expect(res.success).toBe(true);
    expect(res.items).toHaveLength(1);

    const candidate = res.items[0];
    expect(candidate.type).toBe('procedural');
    expect(candidate.content).toBe('在本项目中运行测试之前必须先执行 pnpm build。');
    expect(candidate.slot_key).toBe('build-before-test');
    // parse.ts preserves raw 0.9; writer.ts applies the single * 0.8 LLM discount -> 0.72 stored
    expect(candidate.confidence).toBeCloseTo(0.9);
    expect(candidate.scope).toBe('workspace');
    expect(candidate.actor).toBe('llm');
    expect(candidate.status).toBe('candidate');
    expect(candidate.source_kind).toBe('llm_extract');
    expect(candidate.origin_kinds).toEqual(['user']);

    const db = openDb(':memory:');
    try {
      const up = upsertCandidate(db, candidate);
      expect(up.action).toBe('inserted');
      const stored = db.get<MemoryRecord>('SELECT confidence FROM memories WHERE id = ?', [(up as any).id]);
      expect(stored?.confidence).toBeCloseTo(0.72);
    } finally {
      db.close();
    }
  });

  it('demotes both global and user scopes to workspace and rejects meta memory type', () => {
    const raw = JSON.stringify({
      items: [
        {
          type: 'semantic',
          text: '全局通用配置应该放在系统环境变量中。',
          confidence: 0.8,
          scope: 'global',
          evidence: [{ seq: 1, quote: 'run pnpm build' }],
        },
        {
          type: 'preference',
          text: '用户偏好在运行测试之前先构建产物。',
          confidence: 0.8,
          scope: 'user',
          evidence: [{ seq: 1, quote: 'run pnpm build' }],
        },
        {
          type: 'meta',
          text: '不允许模型输出 meta 类型记录。',
          confidence: 0.8,
          scope: 'workspace',
          evidence: [{ seq: 1, quote: 'run pnpm build' }],
        },
      ],
    });

    const res: any = parseOutput(raw, {
      taskKind: 'distill',
      evidenceLedger: ledger,
      workspaceId: 'ws1',
    });

    expect(res.success).toBe(true);
    expect(res.items).toHaveLength(2);
    expect(res.items[0].scope).toBe('workspace');
    expect(res.items[1].scope).toBe('workspace');
    expect(res.droppedNotes?.some((n: string) => n.includes('invalid_type: meta'))).toBe(true);
  });

  it('blocks <workspace> placeholder gap bypass while allowing valid workspace-anonymized quotes', () => {
    expect(matchesWithWorkspaceGaps('anything at all', '<workspace>')).toBe(false);
    expect(matchesWithWorkspaceGaps('anything at all', 'a<workspace>')).toBe(false);
    expect(matchesWithWorkspaceGaps('anything at all', 'ab<workspace>cd')).toBe(false);
    expect(
      matchesWithWorkspaceGaps(
        'Please remember to run pnpm build before test in /Users/alice/my-project today',
        'before test in <workspace> today'
      )
    ).toBe(true);

    const bypassRaw = JSON.stringify({
      items: [
        {
          type: 'semantic',
          text: '试图使用裸占位符绕过证据引号校验。',
          confidence: 0.9,
          scope: 'workspace',
          evidence: [{ seq: 1, quote: '<workspace>' }],
        },
      ],
    });
    const bypassRes = parseOutput(bypassRaw, {
      taskKind: 'distill',
      evidenceLedger: ledger,
      workspaceId: 'ws1',
    });
    expect(bypassRes.success).toBe(false);
  });

  it('accepts quotes matching rendered [T#seq] / [E#seq] line prefix', () => {
    const raw = JSON.stringify({
      items: [
        {
          type: 'failure',
          text: 'bash 执行报错提示缺少 dist/index.js 模块。',
          confidence: 0.8,
          scope: 'workspace',
          evidence: [{ seq: 2, quote: 'tool=bash ERROR: Error: Cannot find module' }],
        },
      ],
    });

    const res: any = parseOutput(raw, {
      taskKind: 'distill',
      evidenceLedger: ledger,
      workspaceId: 'ws1',
    });
    expect(res.success).toBe(true);
    expect(res.items).toHaveLength(1);
  });

  it('slices excess distill items instead of failing the whole batch', () => {
    const raw = JSON.stringify({
      items: Array.from({ length: 7 }, (_, i) => ({
        type: 'semantic',
        text: `第 ${i + 1} 条有效项目工程规范描述内容。`,
        confidence: 0.8,
        scope: 'workspace',
        evidence: [{ seq: 1, quote: 'run pnpm build before test' }],
      })),
    });

    const res: any = parseOutput(raw, {
      taskKind: 'distill',
      evidenceLedger: ledger,
      workspaceId: 'ws1',
    });
    expect(res.success).toBe(true);
    expect(res.items).toHaveLength(5);
    expect(res.droppedNotes?.some((n: string) => n.includes('sliced'))).toBe(true);
  });

  it('allows reflect items in any order (<=1 failure|procedural and <=1 belief)', () => {
    const raw = JSON.stringify({
      items: [
        {
          type: 'belief',
          text: '缺少预构建步骤往往会在 CI 测试阶段触发模块缺失错误。',
          confidence: 0.75,
          scope: 'workspace',
          evidence: [{ seq: 1, quote: 'run pnpm build before test' }],
        },
        {
          type: 'failure',
          text: '遇到 Cannot find module dist/index.js 时应先运行 pnpm build。',
          confidence: 0.85,
          scope: 'workspace',
          evidence: [{ seq: 2, quote: 'Cannot find module dist/index.js' }],
        },
      ],
    });

    const res: any = parseOutput(raw, {
      taskKind: 'reflect',
      evidenceLedger: ledger,
      workspaceId: 'ws1',
    });
    expect(res.success).toBe(true);
    expect(res.items).toHaveLength(2);
    expect(res.items[0].type).toBe('belief');
    expect(res.items[1].type).toBe('failure');
  });

  it('enforces >= 3 distinct session_ids on consolidate items', () => {
    const twoSessionsRaw = JSON.stringify({
      items: [
        {
          type: 'procedural',
          text: '执行测试前先运行 pnpm build 生成构建产物并验证测试通过。',
          confidence: 0.85,
          scope: 'workspace',
          evidence: [
            { seq: 1, quote: 'run pnpm build before test' },
            { seq: 2, quote: 'Cannot find module dist/index.js' },
          ],
        },
      ],
    });
    const resFail = parseOutput(twoSessionsRaw, {
      taskKind: 'consolidate',
      evidenceLedger: ledger,
      workspaceId: 'ws1',
    });
    expect(resFail.success).toBe(false);
    expect(resFail.droppedNotes?.[0]).toContain('consolidate_requires_at_least_3_distinct_sessions');

    const threeSessionsRaw = JSON.stringify({
      items: [
        {
          type: 'procedural',
          text: '执行测试前先运行 pnpm build 生成构建产物并验证测试通过。',
          confidence: 0.85,
          scope: 'workspace',
          evidence: [
            { seq: 1, quote: 'run pnpm build before test' },
            { seq: 2, quote: 'Cannot find module dist/index.js' },
            { seq: 3, quote: 'Running pnpm build fixed' },
          ],
        },
      ],
    });
    const resOk = parseOutput(threeSessionsRaw, {
      taskKind: 'consolidate',
      evidenceLedger: ledger,
      workspaceId: 'ws1',
    });
    expect(resOk.success).toBe(true);
    if (resOk.success) {
      expect(resOk.items).toHaveLength(1);
    }
  });

  it('rejects malformed curate JSON missing both discard_ids and updates and populates droppedNotes', () => {
    const badCurate = parseOutput('{"hello":"world"}', {
      taskKind: 'curate',
      evidenceLedger: new Map(),
      workspaceId: 'ws1',
    });
    expect(badCurate.success).toBe(false);
    if (!badCurate.success) {
      expect(badCurate.error).toBe('curate_missing_discard_ids_and_updates');
    }

    const partialCurate: any = parseOutput(
      JSON.stringify({
        discard_ids: ['m_valid1234', 'bad_id'],
        updates: [{ target_id: 'bad', text: 'short' }],
      }),
      {
        taskKind: 'curate',
        evidenceLedger: new Map(),
        workspaceId: 'ws1',
      }
    );
    expect(partialCurate.success).toBe(true);
    expect(partialCurate.curateResult.discard_ids).toEqual(['m_valid1234']);
    expect(partialCurate.droppedNotes?.length).toBeGreaterThanOrEqual(2);
  });

  it('drops items with invalid quotes and fails if all items are invalid', () => {
    const raw = JSON.stringify({
      items: [
        {
          type: 'procedural',
          text: 'This should fail because quote is not in evidence.',
          confidence: 0.8,
          scope: 'workspace',
          evidence: [{ seq: 1, quote: 'non existent phrase here' }],
        },
        {
          type: 'procedural',
          text: 'This should fail because quote has case mismatch.',
          confidence: 0.8,
          scope: 'workspace',
          evidence: [{ seq: 1, quote: 'RUN PNPM BUILD' }],
        },
        {
          type: 'procedural',
          text: 'This should fail because seq does not exist in ledger.',
          confidence: 0.8,
          scope: 'workspace',
          evidence: [{ seq: 999, quote: 'some valid length quote' }],
        },
      ],
    });

    const res: any = parseOutput(raw, {
      taskKind: 'distill',
      evidenceLedger: ledger,
      workspaceId: 'ws1',
    });

    expect(res.success).toBe(false);
    expect(res.error).toBe('all_items_invalid');
    expect(res.droppedNotes).toHaveLength(3);
  });

  it('drops items whose text contains sensitive data', () => {
    const raw = JSON.stringify({
      items: [
        {
          type: 'semantic',
          text: '项目的 API 密钥是 api_key="sk-abcdef12345678901234"。',
          confidence: 0.8,
          scope: 'workspace',
          evidence: [{ seq: 1, quote: 'run pnpm build' }],
        },
      ],
    });

    const res: any = parseOutput(raw, {
      taskKind: 'distill',
      evidenceLedger: ledger,
      workspaceId: 'ws1',
    });

    expect(res.success).toBe(false);
    expect(res.error).toBe('all_items_invalid');
    expect(res.droppedNotes?.[0]).toContain('text_contains_sensitive_data');
  });

  describe('Repair (B-4) parsing', () => {
    it('accepts keep with 0 items', () => {
      const raw = JSON.stringify({
        action: 'keep',
        reason: '无需修改，记忆仍然准确有效。',
        items: [],
      });
      const res: any = parseOutput(raw, {
        taskKind: 'repair',
        evidenceLedger: ledger,
        workspaceId: 'ws1',
      });
      expect(res.success).toBe(true);
      expect(res.action).toBe('keep');
      expect(res.items).toHaveLength(0);
    });

    it('accepts revise with 1 valid item (0.7 in parse, 0.8 in writer -> final 0.504)', () => {
      const raw = JSON.stringify({
        action: 'revise',
        reason: '需要更正构建顺序描述。',
        items: [
          {
            type: 'procedural',
            text: '在本项目中运行测试之前必须先执行 pnpm build。',
            confidence: 0.9,
            scope: 'workspace',
            evidence: [{ seq: 1, quote: 'run pnpm build before test' }],
          },
        ],
      });
      const res: any = parseOutput(raw, {
        taskKind: 'repair',
        evidenceLedger: ledger,
        workspaceId: 'ws1',
      });
      expect(res.success).toBe(true);
      expect(res.action).toBe('revise');
      expect(res.items).toHaveLength(1);
      // Pre-writer confidence: 0.9 * 0.7 = 0.63
      expect(res.items[0].confidence).toBeCloseTo(0.63);

      // Final persisted confidence via writer (actor='llm' applies * 0.8): 0.9 * 0.7 * 0.8 = 0.504
      const db = openDb(':memory:');
      try {
        const up = upsertCandidate(db, res.items[0]);
        expect(up.action).toBe('inserted');
        const stored = db.get<MemoryRecord>('SELECT confidence FROM memories WHERE id = ?', [(up as any).id]);
        expect(stored?.confidence).toBeCloseTo(0.504);
      } finally {
        db.close();
      }
    });

    it('rejects revise with 2 items', () => {
      const raw = JSON.stringify({
        action: 'revise',
        reason: '错误条数',
        items: [
          {
            type: 'procedural',
            text: '条目 1 内容必须超过八个字符。',
            confidence: 0.8,
            scope: 'workspace',
            evidence: [{ seq: 1, quote: 'run pnpm build' }],
          },
          {
            type: 'procedural',
            text: '条目 2 内容必须超过八个字符。',
            confidence: 0.8,
            scope: 'workspace',
            evidence: [{ seq: 1, quote: 'run pnpm build' }],
          },
        ],
      });
      const res: any = parseOutput(raw, {
        taskKind: 'repair',
        evidenceLedger: ledger,
        workspaceId: 'ws1',
      });
      expect(res.success).toBe(false);
      expect(res.error).toBe('action_revise_requires_exactly_1_item');
    });
  });

  describe('Judge (B-5) parsing', () => {
    it('accepts valid judge output', () => {
      const raw = JSON.stringify({
        items: [
          {
            id: 'm_1234567890abcdef',
            relevant: 2,
            correct: 'supported',
            harmful: 0,
          },
        ],
        verdict: 'potentially_useful',
        score: 0.85,
        reason: '上下文高度相关且证据支持。',
      });

      const res: any = parseOutput(raw, {
        taskKind: 'judge',
        evidenceLedger: ledger,
        workspaceId: 'ws1',
      });

      expect(res.success).toBe(true);
      expect(res.judgeResult?.verdict).toBe('potentially_useful');
      expect(res.judgeResult?.score).toBe(0.85);
      expect(res.judgeResult?.items).toHaveLength(1);
    });
  });
});
