export interface JobRecord {
  id: number;
  kind: string;
  key: string;
  payload: string | null;
  status: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
  attempts: number;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  next_eligible_at: number;
}

export type JobHandlerResult =
  | { action: 'done' }
  | { action: 'skipped'; reason: string; nextEligibleAt?: number }
  | { action: 'retry'; error: string }
  | { action: 'failed'; error: string; nonRetryable?: boolean };

export type JobHandler = (job: JobRecord, signal: AbortSignal) => Promise<JobHandlerResult>;

/** Preserve budget deferral and retry only errors that can recover without new input. */
export function jobFailure(error: string): JobHandlerResult {
  if (/^daily_(?:tokens|calls|limit)_exceeded$/.test(error)) {
    return { action: 'skipped', reason: error };
  }
  if (/^(?:network_error|timeout|http_429|http_5\d\d)$/.test(error) ||
      /^transaction_failed:/.test(error)) {
    return { action: 'retry', error };
  }
  return { action: 'failed', error, nonRetryable: true };
}
