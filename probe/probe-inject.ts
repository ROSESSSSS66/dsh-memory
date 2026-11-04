import type { Context } from '../src/types.js';

/**
 * M0-T2 注入路径探测插件
 * 用于验证 agent/pre-step 改写返回值在 DSH 中的行为
 */
export const name = 'probe-inject';
export const inject = ['agents', 'systemPrompt'];

export function apply(ctx: any) {
  console.log('[probe-inject] plugin loaded');

  ctx.on('agent/pre-step', async (payload: any, next: () => Promise<any>) => {
    console.log(`[probe-inject] pre-step invoked: turn=${payload.turn}, step=${payload.step}`);
    
    const decision = await next();
    console.log('[probe-inject] downstream decision keys:', Object.keys(decision));
    console.log('[probe-inject] startsRequestSeries:', decision.startsRequestSeries);

    if (decision.kind !== 'enter') {
      console.log(`[probe-inject] decision is not enter: ${decision.kind}`);
      return decision;
    }

    const incomingSources = decision.messages.map((m: any) => m?.source?.kind || 'unknown');
    console.log('[probe-inject] incoming decision.messages sources:', incomingSources);

    // 构造 probe 消息
    const probeMsg = {
      id: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: '<memory_context v="1" layer="dynamic">\n[FACT m_probe01] PROBE INJECTION TEST\n</memory_context>' }],
      source: {
        kind: 'plugin',
        plugin: 'dsh-memory',
        memoryRefs: [{ id: 'm_probe01', contentRev: 1 }]
      }
    };

    const updatedMessages = [...decision.messages, probeMsg];
    const finalDecision = {
      ...decision,
      messages: updatedMessages
    };

    console.log('[probe-inject] returned decision.messages count:', finalDecision.messages.length);
    return finalDecision;
  }, { prepend: true });
}
