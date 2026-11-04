import type { JobScheduler } from '../jobs/scheduler.js';

export function registerTurnStopping(ctx: any, scheduler: JobScheduler): () => void {
  if (typeof ctx.on !== 'function') {
    return () => {};
  }

  return ctx.on('agent/turn-stopping', (_payload: any) => {
    try {
      scheduler.scheduleTurnStopping();
    } catch {}
  });
}
