import { describe, it, expect } from 'vitest';
import { parseOutput } from '../../src/evolution/parse.js';
import type { EvidenceLedger, EvidenceLedgerEntry } from '../../src/evolution/types.js';

describe('Evolution Output Parsing (M3-T1)', () => {
  const ledger: EvidenceLedger = new Map<number, EvidenceLedgerEntry>([
    [
      1,
      {
        seq: 1,
        session_id: 's1',
        original_seq: 10,
        kind: 'user_msg',
        redacted_text: 'Please remember to run pnpm build before test in this project',
        origin_kinds: ['user'],
        time: 1000,
      },
    ],
    [
      2,
      {
        seq: 2,
        session_id: 's1',
        original_seq: 11,
        kind: 'tool_result',
        redacted_text: 'Error: Cannot find module dist/index.js',
        origin_kinds: ['tool'],
        time: 1100,
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

  it('accepts JSON wrapped in a single code fence', () => {
    const raw = '```json\n{"items": []}\n```';
    const res: any = parseOutput(raw, {
      taskKind: 'distill',
      evidenceLedger: ledger,
      workspaceId: 'ws1',
    });

    expect(res.success).toBe(true);
    expect(res.items).toEqual([]);
  });

  it('rejects JSON with prose before or after code fence (只接受裸JSON/整个代码围栏，不接受前后杂文)', () => {
    const withProseBefore = 'Here is the result:\n```json\n{"items": []}\n```';
    const res1: any = parseOutput(withProseBefore, {
      taskKind: 'distill',
      evidenceLedger: ledger,
      workspaceId: 'ws1',
    });
    expect(res1.success).toBe(false);
    expect(res1.error).toBe('json_parse_failed');

    const withProseAfter = '```json\n{"items": []}\n```\nHope this helps!';
    const res2: any = parseOutput(withProseAfter, {
      taskKind: 'distill',
      evidenceLedger: ledger,
      workspaceId: 'ws1',
    });
    expect(res2.success).toBe(false);
    expect(res2.error).toBe('json_parse_failed');
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

  it('parses valid MemoryItem and maps to CandidateInput correctly', () => {
    const raw = JSON.stringify({
      items: [
        {
          type: 'procedural',
          text: '在本项目中运行测试之前必须先执行 pnpm build。',
          slot_key: 'build-before-test',
          confidence: 0.9,
          scope: 'workspace',
          evidence: [
            {
              seq: 1,
              quote: 'run pnpm build before test',
            },
          ],
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
    // confidence: 0.9 * 0.8 = 0.72
    expect(candidate.confidence).toBeCloseTo(0.72);
    expect(candidate.scope).toBe('workspace');
    expect(candidate.actor).toBe('llm');
    expect(candidate.status).toBe('candidate');
    expect(candidate.source_kind).toBe('llm_extract');
    expect(candidate.origin_kinds).toEqual(['user']);

    expect(candidate.sources).toHaveLength(1);
    expect(candidate.sources[0]).toEqual({
      session_id: 's1',
      seq: 10,
      kind: 'user_msg',
      excerpt: 'run pnpm build before test',
    });
  });

  it('disallows escalation of scope to global or user', () => {
    const raw = JSON.stringify({
      items: [
        {
          type: 'semantic',
          text: '全局通用配置应该放在系统环境变量中。',
          confidence: 0.8,
          scope: 'global', // LLM attempts global
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
    expect(res.items[0].scope).toBe('workspace'); // Downgraded to workspace
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

    it('accepts revise with exactly 1 valid item (discount 0.8 * 0.7 = 0.56)', () => {
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
      // confidence: 0.9 * 0.8 * 0.7 = 0.504
      expect(res.items[0].confidence).toBeCloseTo(0.504);
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
