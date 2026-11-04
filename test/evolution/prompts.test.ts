import { describe, it, expect } from 'vitest';
import {
  PROMPT_DISTILL,
  PROMPT_REFLECT,
  PROMPT_CONSOLIDATE,
  PROMPT_REPAIR,
  PROMPT_JUDGE,
  renderTranscript,
} from '../../src/evolution/prompts.js';
import type { RawEvent } from '../../src/types.js';
import type { EvidenceLedger } from '../../src/evolution/types.js';

describe('Evolution Prompts (M3-T1)', () => {
  it('exports correct versions and max output tokens matching Appendix B', () => {
    expect(PROMPT_DISTILL.version).toBe('distill-v2');
    expect(PROMPT_DISTILL.maxOutputTokens).toBe(2000);

    expect(PROMPT_REFLECT.version).toBe('reflect-v2');
    expect(PROMPT_REFLECT.maxOutputTokens).toBe(1200);

    expect(PROMPT_CONSOLIDATE.version).toBe('consolidate-v2');
    expect(PROMPT_CONSOLIDATE.maxOutputTokens).toBe(3000);

    expect(PROMPT_REPAIR.version).toBe('repair-v2');
    expect(PROMPT_REPAIR.maxOutputTokens).toBe(2000);

    expect(PROMPT_JUDGE.version).toBe('judge-v2');
    expect(PROMPT_JUDGE.maxOutputTokens).toBe(600);
  });

  it('renders transcript with correct format and populates evidenceLedger', () => {
    const events: RawEvent[] = [
      {
        session_id: 's1',
        seq: 10,
        workspace_id: 'ws1',
        type: 'user/message',
        time: 1000,
        role: 'user',
        origin_kind: 'user',
        is_error: 0,
        text: 'Hello, my configuration is password="secret123456"',
        processed: 0,
      },
      {
        session_id: 's1',
        seq: 11,
        workspace_id: 'ws1',
        type: 'assistant/message',
        time: 1050,
        role: 'assistant',
        origin_kind: 'assistant',
        is_error: 0,
        text: 'I will run the test command for you.',
        processed: 0,
      },
      {
        session_id: 's1',
        seq: 12,
        workspace_id: 'ws1',
        type: 'tool/result',
        time: 1100,
        role: 'tool',
        origin_kind: 'tool',
        tool_name: 'bash',
        is_error: 1,
        text: 'Error: Cannot find module vitest',
        processed: 0,
      },
    ];

    const evidenceLedger: EvidenceLedger = new Map();
    const rendered = renderTranscript(events, evidenceLedger);

    expect(rendered).toContain('[U#1] Hello, my configuration is password="[REDACTED:SECRET]"');
    expect(rendered).toContain('[A#2] I will run the test command for you.');
    expect(rendered).toContain('[T#3] tool=bash ERROR: Error: Cannot find module vitest');

    // 检查 evidenceLedger
    expect(evidenceLedger.size).toBe(3);
    const entry1 = evidenceLedger.get(1)!;
    expect(entry1.seq).toBe(1);
    expect(entry1.session_id).toBe('s1');
    expect(entry1.original_seq).toBe(10);
    expect(entry1.kind).toBe('user_msg');
    expect(entry1.redacted_text).not.toContain('secret123456');
    expect(entry1.redacted_text).toContain('[REDACTED:SECRET]');

    const entry3 = evidenceLedger.get(3)!;
    expect(entry3.seq).toBe(3);
    expect(entry3.original_seq).toBe(12);
    expect(entry3.kind).toBe('tool_result');
    expect(entry3.redacted_text).toBe('Error: Cannot find module vitest');
  });

  it('truncates message types according to constraints', () => {
    const longUserText = 'U'.repeat(800);
    const longAssistantText = 'A'.repeat(500);
    const longToolText = 'T'.repeat(400);

    const events: RawEvent[] = [
      {
        session_id: 's2',
        seq: 1,
        workspace_id: 'ws1',
        type: 'user',
        time: 100,
        role: 'user',
        origin_kind: 'user',
        is_error: 0,
        text: longUserText,
        processed: 0,
      },
      {
        session_id: 's2',
        seq: 2,
        workspace_id: 'ws1',
        type: 'assistant',
        time: 200,
        role: 'assistant',
        origin_kind: 'assistant',
        is_error: 0,
        text: longAssistantText,
        processed: 0,
      },
      {
        session_id: 's2',
        seq: 3,
        workspace_id: 'ws1',
        type: 'tool',
        time: 300,
        role: 'tool',
        origin_kind: 'tool',
        tool_name: 'testTool',
        is_error: 0,
        text: longToolText,
        processed: 0,
      },
    ];

    const evidenceLedger: EvidenceLedger = new Map();
    const rendered = renderTranscript(events, evidenceLedger);

    const entry1 = evidenceLedger.get(1)!;
    expect(entry1.redacted_text.length).toBe(500);

    const entry2 = evidenceLedger.get(2)!;
    expect(entry2.redacted_text.length).toBe(300);

    const entry3 = evidenceLedger.get(3)!;
    expect(entry3.redacted_text.length).toBe(200);
  });
});
