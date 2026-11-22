import { hydrateMemoryRow, type Db, type RawEvent, type MemoryRow } from '../types.js';
import type { PluginConfig } from '../config.js';
import { tokenSet, jaccard, extractEntities } from '../core/text.js';
import { applyUtility } from '../core/writer.js';
import { isWorkspaceExcluded, memoryPrivacyFilterSQL, redactSecrets } from '../core/privacy.js';
import { CORRECTION_REGEX, isCorrectionMessage } from '../ingest/rules.js';
import { enqueueJob } from '../jobs/scheduler.js';
import { harvestSample } from './lab.js';
import { getActiveStrategy } from './strategy.js';
import { enqueueRepairJobIfEligible } from './repair.js';

export { CORRECTION_REGEX };

export const CONFIRMATION_REGEX =
  /((?<!不|没)(?:好的|可以|完美|成功了|解决了|不错)|谢谢|(?<!not\s|nothing\s|never\s|hardly\s)\b(?:works|thanks|great|perfect|lgtm)\b)/i;

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
 * 查找指定 turn 对应的真实用户提问（支持 DSH 中 user/message.turn IS NULL 的回退查找）
 */
function findTurnUserEvent(
  db: Db,
  sessionId: string,
  turn: number
): { text: string; workspace_id: string } | undefined {
  const direct = db.get<{ text: string; workspace_id: string }>(
    `SELECT text, workspace_id FROM raw_events
     WHERE session_id = ? AND turn = ? AND role = 'user' AND origin_kind = 'user'
     ORDER BY seq ASC LIMIT 1`,
    [sessionId, turn]
  );
  if (direct?.text) return direct;

  // 回退：DSH 常见 user/message.turn IS NULL，在上一 turn 末尾与本 turn 末尾之间寻找最近的用户消息
  const curRange = db.get<{ min_seq: number | null; max_seq: number | null }>(
    `SELECT MIN(seq) as min_seq, MAX(seq) as max_seq FROM raw_events WHERE session_id = ? AND turn = ?`,
    [sessionId, turn]
  );
  const prevMax = db.get<{ max_seq: number | null }>(
    `SELECT MAX(seq) as max_seq FROM raw_events WHERE session_id = ? AND turn IS NOT NULL AND turn < ?`,
    [sessionId, turn]
  );
  const lowerBound = prevMax?.max_seq ?? 0;
  const upperBound = curRange?.max_seq ?? Number.MAX_SAFE_INTEGER;

  return db.get<{ text: string; workspace_id: string }>(
    `SELECT text, workspace_id FROM raw_events
     WHERE session_id = ?
       AND turn IS NULL
       AND role = 'user'
       AND origin_kind = 'user'
       AND seq > ?
       AND seq <= ?
     ORDER BY seq DESC LIMIT 1`,
    [sessionId, lowerBound, upperBound]
  );
}

/**
 * 判断 turn 结果并执行效用归因更新 (§5.9)
 * 严格幂等：仅对 injections.outcome IS NULL 的记录归因，避免重复评估双重更新 utility/count；
 * 无论是否存在注入，均使用该 turn 对应的 strategy_v 更新 turn_metrics。
 */
export function evaluateTurnOutcome(
  db: Db,
  params: EvaluateTurnParams,
  cfg: PluginConfig
): EvaluateTurnResult {
  const now = params.now ?? Date.now();
  const nextUserText = params.nextUserMessage?.trim() || '';

  // 1. 判断 turn 结果 r (-1..1)，复用共享纠正检测 isCorrectionMessage
  let r = 0;
  let isCorrection = false;

  if (nextUserText && isCorrectionMessage(nextUserText)) {
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
    const wsRow =
      db.get<{ workspace_id: string }>(
        "SELECT workspace_id FROM raw_events WHERE session_id = ? AND workspace_id != '' LIMIT 1",
        [params.sessionId]
      ) ||
      db.get<{ workspace_id: string }>(
        "SELECT workspace_id FROM session_workspace_owners WHERE session_id = ? AND workspace_id != '' LIMIT 1",
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

  // 3. 读取该 turn 尚未归因的注入记录 (outcome IS NULL，确保幂等)
  const injectionRows = db.all<{
    memory_id: string;
    content_rev: number;
    layer: string;
    strategy_v: number;
  }>(
    `SELECT DISTINCT memory_id, content_rev, layer, strategy_v
     FROM injections
     WHERE session_id = ? AND turn = ? AND outcome IS NULL`,
    [params.sessionId, params.turn]
  );

  // 优先采用该 turn 实际注入时记录的 strategy_v，其次查询该 turn 历史注入的 strategy_v，最后回退当前活跃策略
  const turnStrategyV =
    injectionRows[0]?.strategy_v ??
    db.get<{ strategy_v: number }>(
      `SELECT strategy_v FROM injections WHERE session_id = ? AND turn = ? LIMIT 1`,
      [params.sessionId, params.turn]
    )?.strategy_v ??
    getActiveStrategy(db, cfg).version;

  // 收集该 turn 所有 assistant 文本 + 工具调用参数（仅当存在待归因注入时需要）
  let turnFullText = '';
  let A = new Set<string>();
  let A_entities: string[] = [];
  if (injectionRows.length > 0) {
    const turnEvents = db.all<RawEvent>(
      `SELECT text FROM raw_events
       WHERE session_id = ? AND turn = ? AND role IN ('assistant', 'tool')`,
      [params.sessionId, params.turn]
    );
    turnFullText = turnEvents.map((e) => e.text || '').join(' ');
    A = tokenSet(turnFullText);
    A_entities = extractEntities(turnFullText);
  }

  const utilityLR = cfg.utilityLR ?? 0.1;
  const target = (r + 1) / 2;

  // 合并相同 memory_id（同一记忆在同一 turn 只更新一次效用）
  const processedMemories = new Set<string>();
  let updatedCount = 0;

  return db.transaction(() => {
    for (const inj of injectionRows) {
      if (processedMemories.has(inj.memory_id)) continue;
      processedMemories.add(inj.memory_id);

      const mem = hydrateMemoryRow(
        db.get<MemoryRow>('SELECT * FROM memories WHERE id = ?', [inj.memory_id])
      );
      if (!mem) continue;

      // 判断是否真正被使用
      const mTokens = tokenSet(mem.content);
      const j = jaccard(mTokens, A);
      const mEntities = extractEntities(mem.content);
      const hasEntityMatch = mEntities.some((ent) => A_entities.includes(ent));

      const used = j >= 0.08 || hasEntityMatch;
      const w = used ? 1.0 : 0.2;

      // 计算并更新 utility
      const newUtility = Math.max(
        0,
        Math.min(1, mem.utility + utilityLR * w * (target - mem.utility))
      );
      const deltaSuccess = r > 0.5 && used ? 1 : 0;
      const deltaFail = r < -0.5 && used ? 1 : 0;

      applyUtility(db, mem.id, newUtility, deltaSuccess, deltaFail, now);

      // 幂等回填 injections 表
      const updRes = db.run(
        `UPDATE injections
         SET outcome = ?, used = ?
         WHERE session_id = ? AND turn = ? AND memory_id = ? AND outcome IS NULL`,
        [r, used ? 1 : 0, params.sessionId, params.turn, mem.id]
      );
      if (Number(updRes.changes) > 0) {
        updatedCount++;
      }

      // §5.17: 当注入记忆被实际采用且本轮发生负面结果 (r <= -0.6) 时，自动触发 RIME 诊断修复入队
      if (r <= -0.6 && used) {
        try {
          enqueueRepairJobIfEligible(
            db,
            {
              memoryId: mem.id,
              sessionId: params.sessionId,
              query: nextUserText || turnFullText.slice(0, 200),
              turn: params.turn,
            },
            cfg,
            now
          );
        } catch {}
      }

      // §6.6 / M5-T3: 真实用户明确肯定 (r=1.0) 且该引用 used=1 时脱敏并采集为收获用例（附带同工作区干扰项）
      if (r === 1.0 && used) {
        const userEvent = findTurnUserEvent(db, params.sessionId, params.turn);
        const ownerWs = mem.workspace_id || userEvent?.workspace_id || params.cwd || '';
        const excluded =
          isWorkspaceExcluded(ownerWs, cfg.excludeWorkspaces) ||
          isWorkspaceExcluded(params.cwd || '', cfg.excludeWorkspaces);
        if (userEvent?.text && !excluded) {
          const cleanQuery = redactSecrets(userEvent.text).text.trim();
          const cleanMemContent = redactSecrets(mem.content).text.trim();
          if (cleanQuery && cleanMemContent) {
            const sampleId = `harvest_${params.sessionId}_${params.turn}_${mem.id.slice(0, 8)}`;
            const cleanEntities = extractEntities(cleanMemContent);
            const inc =
              cleanEntities.length > 0 ? [cleanEntities[0]] : [cleanMemContent.slice(0, 20)];

            // 采集同工作区的干扰记忆作为负样本背景，确保收获用例具备真实区分度
            const privacy = memoryPrivacyFilterSQL(cfg.excludeWorkspaces);
            const distractors = mem.workspace_id
              ? db.all<{ type: string; content: string }>(
                  `SELECT type, content FROM memories
                   WHERE id != ?
                     AND status = 'active'
                     AND type != 'meta'
                     AND COALESCE(slot_key, '') NOT LIKE 'core:%'
                     AND (workspace_id = ? OR scope IN ('user', 'global'))
                     AND ${privacy.sql}
                   ORDER BY updated_at DESC
                   LIMIT 3`,
                  [mem.id, mem.workspace_id, ...privacy.params]
                )
              : [];

            const setupItems: Array<{
              type: any;
              content: string;
              at: string;
              source_kind: 'user';
              status: 'active';
            }> = [
              {
                type: (mem.type as any) || 'semantic',
                content: cleanMemContent,
                at: new Date(now - 60000).toISOString(),
                source_kind: 'user',
                status: 'active',
              },
            ];

            for (const d of distractors) {
              const cleanDist = redactSecrets(d.content).text.trim();
              if (cleanDist && cleanDist !== cleanMemContent) {
                setupItems.push({
                  type: (d.type as any) || 'semantic',
                  content: cleanDist,
                  at: new Date(now - 120000).toISOString(),
                  source_kind: 'user',
                  status: 'active',
                });
              }
            }

            harvestSample(db, {
              id: sampleId,
              suite: 'harvested',
              critical: false,
              now: new Date(now).toISOString(),
              workspace: params.cwd || '/ws/harvested',
              setup: setupItems,
              query: cleanQuery,
              expect: {
                include: inc,
                exclude: [],
              },
            });
          }
        }
      }
    }

    // 无论本轮是否注入记忆，均记录/更新 turn_metrics（使用本轮真实 strategy_v，支撑 Sentinel 精准回滚）
    db.run(
      `INSERT INTO turn_metrics (
         session_id, turn, outcome, correction, strategy_v, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, turn) DO UPDATE SET
         outcome = COALESCE(turn_metrics.outcome, excluded.outcome),
         correction = MAX(turn_metrics.correction, excluded.correction)`,
      [params.sessionId, params.turn, r, isCorrection ? 1 : 0, turnStrategyV, now]
    );

    return {
      outcome: r,
      isCorrection,
      updatedInjections: updatedCount,
      reflectEnqueued,
    };
  });
}
