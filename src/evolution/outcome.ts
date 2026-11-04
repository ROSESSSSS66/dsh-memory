import type { Db, RawEvent, MemoryRecord } from '../types.js';
import type { PluginConfig } from '../config.js';
import { tokenSet, jaccard, extractEntities } from '../core/text.js';
import { applyUtility } from '../core/writer.js';
import { enqueueJob } from '../jobs/scheduler.js';
import { harvestSample } from './lab.js';

export const CORRECTION_REGEX = /(不对|错了|不是这样|搞错|不行|没用|还是不行|重来|wrong|incorrect|doesn't work|not what)/i;
export const CONFIRMATION_REGEX = /(好的|可以|谢谢|完美|成功了|解决了|不错|works|thanks|great|perfect|lgtm)/i;

export interface EvaluateTurnParams {
  sessionId: string;
  turn: number;
  nextUserMessage?: string | null;
  cwd?: string;
  now?: number;
}

export interface EvaluateTurnResult {
  outcome: number;
  isCorrection: boolean;
  updatedInjections: number;
  reflectEnqueued: boolean;
}

/**
 * 判断 turn 结果并执行效用归因更新 (§5.9)
 */
export function evaluateTurnOutcome(
  db: Db,
  params: EvaluateTurnParams,
  cfg: PluginConfig
): EvaluateTurnResult {
  const now = params.now ?? Date.now();
  const nextUserText = params.nextUserMessage?.trim() || '';

  // 1. 判断 turn 结果 r (-1..1)
  let r = 0;
  let isCorrection = false;

  // 检查是否在下一个 turn 中由用户纠正
  if (nextUserText && CORRECTION_REGEX.test(nextUserText)) {
    r = -1.0;
    isCorrection = true;
  } else if (nextUserText && CONFIRMATION_REGEX.test(nextUserText)) {
    r = 1.0;
  } else {
    // 检查本 turn 工具调用结果：最后一个工具结果是否 is_error=1 且之后没有成功调用
    const toolEvents = db.all<RawEvent>(
      `SELECT * FROM raw_events
       WHERE session_id = ? AND turn = ? AND (role = 'tool' OR tool_name IS NOT NULL)
       ORDER BY seq ASC`,
      [params.sessionId, params.turn]
    );

    if (toolEvents.length > 0) {
      const lastTool = toolEvents[toolEvents.length - 1];
      if (lastTool.is_error === 1) {
        r = -0.6;
      }
    }

    if (r === 0) {
      if (nextUserText) {
        // 用户提出了新任务/正常继续
        r = 0.3;
      } else {
        // session 就此结束，没有后续消息，不更新
        return {
          outcome: 0,
          isCorrection: false,
          updatedInjections: 0,
          reflectEnqueued: false,
        };
      }
    }
  }

  let reflectEnqueued = false;

  // 2. 如果是纠正事件 (r = -1)，入队 reflect 任务（同一 turn 仅入队一次）
  if (r === -1.0) {
    const wsRow = db.get<{ workspace_id: string }>(
      'SELECT workspace_id FROM raw_events WHERE session_id = ? LIMIT 1',
      [params.sessionId]
    );
    const cwd = params.cwd || wsRow?.workspace_id || '';
    reflectEnqueued = enqueueJob(db, {
      kind: 'reflect',
      key: `reflect:${params.sessionId}:${params.turn}`,
      payload: {
        sessionId: params.sessionId,
        turn: params.turn,
        cwd,
        correctionMessage: nextUserText,
      },
      now,
    });
  }

  // 3. 归因与效用更新
  // 读取该 turn 注入的所有记忆记录
  const injectionRows = db.all<{
    memory_id: string;
    content_rev: number;
    layer: string;
  }>(
    `SELECT DISTINCT memory_id, content_rev, layer
     FROM injections
     WHERE session_id = ? AND turn = ?`,
    [params.sessionId, params.turn]
  );

  if (injectionRows.length === 0) {
    return {
      outcome: r,
      isCorrection,
      updatedInjections: 0,
      reflectEnqueued,
    };
  }

  // 收集该 turn 所有 assistant 文本 + 工具调用参数
  const turnEvents = db.all<RawEvent>(
    `SELECT text FROM raw_events
     WHERE session_id = ? AND turn = ? AND role IN ('assistant', 'tool')`,
    [params.sessionId, params.turn]
  );

  const turnFullText = turnEvents.map(e => e.text || '').join(' ');
  const A = tokenSet(turnFullText);
  const A_entities = extractEntities(turnFullText);

  const utilityLR = cfg.utilityLR ?? 0.1;
  const target = (r + 1) / 2;

  // 合并相同 memory_id（同一记忆在同一 turn 只更新一次效用）
  const processedMemories = new Set<string>();

  return db.transaction(() => {
    for (const inj of injectionRows) {
      if (processedMemories.has(inj.memory_id)) continue;
      processedMemories.add(inj.memory_id);

      const mem = db.get<MemoryRecord>(
        'SELECT id, content, utility FROM memories WHERE id = ?',
        [inj.memory_id]
      );
      if (!mem) continue;

      // 判断是否真正被使用
      const mTokens = tokenSet(mem.content);
      const j = jaccard(mTokens, A);
      const mEntities = extractEntities(mem.content);
      const hasEntityMatch = mEntities.some(ent => A_entities.includes(ent));

      const used = j >= 0.08 || hasEntityMatch;
      const w = used ? 1.0 : 0.2;

      // 计算并更新 utility
      const newUtility = Math.max(0, Math.min(1, mem.utility + utilityLR * w * (target - mem.utility)));
      const deltaSuccess = r > 0.5 && used ? 1 : 0;
      const deltaFail = r < -0.5 && used ? 1 : 0;

      applyUtility(db, mem.id, newUtility, deltaSuccess, deltaFail, now);

      // 回填 injections 表
      db.run(
        `UPDATE injections
         SET outcome = ?, used = ?
         WHERE session_id = ? AND turn = ? AND memory_id = ?`,
        [r, used ? 1 : 0, params.sessionId, params.turn, mem.id]
      );

      // §6.6 / M5-T3: 真实用户明确肯定 (r=1.0) 且该引用 used=1 时采集为收获用例
      if (r === 1.0 && used) {
        const userEvent = db.get<RawEvent>(
          `SELECT text FROM raw_events
           WHERE session_id = ? AND turn = ? AND role = 'user'
           ORDER BY seq ASC LIMIT 1`,
          [params.sessionId, params.turn]
        );
        if (userEvent?.text) {
          const sampleId = `harvest_${params.sessionId}_${params.turn}_${mem.id.slice(0, 8)}`;
          const inc = mEntities.length > 0 ? [mEntities[0]] : [mem.content.slice(0, 20)];
          harvestSample(db, {
            id: sampleId,
            suite: 'harvested',
            critical: false,
            now: new Date(now).toISOString(),
            workspace: params.cwd || '',
            setup: [],
            query: userEvent.text,
            expect: {
              include: inc,
              exclude: [],
            },
          });
        }
      }
    }

    // 更新或插入 turn_metrics
    db.run(
      `UPDATE turn_metrics
       SET outcome = ?, correction = ?
       WHERE session_id = ? AND turn = ?`,
      [r, isCorrection ? 1 : 0, params.sessionId, params.turn]
    );

    return {
      outcome: r,
      isCorrection,
      updatedInjections: injectionRows.length,
      reflectEnqueued,
    };
  });
}
