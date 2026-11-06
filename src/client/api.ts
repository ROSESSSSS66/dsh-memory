import type {
  OverviewResponse,
  ListResponse,
  MemoryDetailResponse,
  LLMConfigUI,
  LLMTestResponse,
  GraphDataUI,
  ExportResponse,
  ImportResult,
  CoreMemoryResponse,
  EvolutionDataResponse,
  SandboxResponseUI,
  MemoryHealthReportUI,
  ReconcileResponseUI,
} from './types.js';

const API_BASE = '/api/dsh-memory';

export async function fetchOverview(workspaceId?: string): Promise<OverviewResponse> {
  const url = workspaceId
    ? `${API_BASE}/overview?workspaceId=${encodeURIComponent(workspaceId)}`
    : `${API_BASE}/overview`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchGraphData(
  workspaceId?: string,
  limit: number = 90
): Promise<{ ok: boolean; graph: GraphDataUI }> {
  const url = workspaceId
    ? `${API_BASE}/graph?workspaceId=${encodeURIComponent(workspaceId)}&limit=${limit}`
    : `${API_BASE}/graph?limit=${limit}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchMemoryHealth(
  workspaceId?: string
): Promise<{ ok: boolean; health: MemoryHealthReportUI }> {
  const url = workspaceId
    ? `${API_BASE}/health?workspaceId=${encodeURIComponent(workspaceId)}`
    : `${API_BASE}/health`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function runReconcile(params: {
  content: string;
  type?: string;
  slot_key?: string;
  scope?: 'global' | 'workspace';
  dryRun?: boolean;
}): Promise<ReconcileResponseUI> {
  const res = await fetch(`${API_BASE}/reconcile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || '调和判定失败');
  }
  return res.json();
}

export async function fetchMemories(params: {
  q?: string;
  type?: string;
  status?: string;
  scope?: string;
  workspaceId?: string;
  limit?: number;
  offset?: number;
}): Promise<ListResponse> {
  const sp = new URLSearchParams();
  if (params.q) sp.set('q', params.q);
  if (params.type && params.type !== 'all') sp.set('type', params.type);
  if (params.status && params.status !== 'all') sp.set('status', params.status);
  if (params.scope && params.scope !== 'all') sp.set('scope', params.scope);
  if (params.workspaceId) sp.set('workspaceId', params.workspaceId);
  sp.set('limit', String(params.limit || 80));
  sp.set('offset', String(params.offset || 0));

  const res = await fetch(`${API_BASE}/memories?${sp.toString()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchMemoryDetail(id: string): Promise<MemoryDetailResponse> {
  const res = await fetch(`${API_BASE}/memory?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchCoreMemory(workspaceId?: string): Promise<CoreMemoryResponse> {
  const url = workspaceId
    ? `${API_BASE}/core-memory?workspaceId=${encodeURIComponent(workspaceId)}`
    : `${API_BASE}/core-memory`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function saveCoreMemory(params: {
  block: string;
  content: string;
  mode?: 'set' | 'append';
  workspaceId?: string;
}): Promise<{ ok: boolean; blocks: any[] }> {
  const res = await fetch(`${API_BASE}/core-memory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || '保存核心记忆失败');
  }
  return res.json();
}

export async function fetchEvolutionData(): Promise<EvolutionDataResponse> {
  const res = await fetch(`${API_BASE}/evolution`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchSandboxData(query?: string): Promise<SandboxResponseUI> {
  if (query && query.trim()) {
    const res = await fetch(`${API_BASE}/sandbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query.trim() }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  const res = await fetch(`${API_BASE}/sandbox`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function performAction(
  action:
    | 'pin'
    | 'unpin'
    | 'freeze'
    | 'unfreeze'
    | 'forget'
    | 'approve'
    | 'create'
    | 'maintain'
    | 'distill'
    | 'confirm'
    | 'restore'
    | 'merge'
    | 'edit'
    | 'rollback'
    | 'batch'
    | 'approve-repair'
    | 'reject-repair'
    | 'evolve-strategy'
    | 'rollback-strategy'
    | 'backfill'
    | 'eval'
    | 'heal'
    | 'consolidate'
    | 'add-relation',
  payload?: any
): Promise<any> {
  const res = await fetch(`${API_BASE}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...(payload || {}) }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Action ${action} failed`);
  }
  return res.json();
}

export async function exportMemories(
  format: 'json' | 'markdown' = 'json',
  workspaceId?: string
): Promise<{ text: string; filename: string } | ExportResponse> {
  const sp = new URLSearchParams();
  sp.set('format', format);
  if (workspaceId) sp.set('workspaceId', workspaceId);

  const res = await fetch(`${API_BASE}/export?${sp.toString()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  if (format === 'markdown') {
    const text = await res.text();
    return { text, filename: 'dsh-memories.md' };
  }
  return res.json();
}

export async function importMemories(items: any[]): Promise<ImportResult> {
  const res = await fetch(`${API_BASE}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || '导入失败');
  }
  return res.json();
}

export async function fetchLLMConfig(): Promise<{ ok: boolean; config: LLMConfigUI }> {
  const res = await fetch(`${API_BASE}/config`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function saveLLMConfig(data: any): Promise<{ ok: boolean; config: LLMConfigUI }> {
  const res = await fetch(`${API_BASE}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || '保存配置失败');
  }
  return res.json();
}

export async function testLLMConnection(params: {
  baseURL?: string;
  model?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  protocol?: string;
}): Promise<LLMTestResponse> {
  const res = await fetch(`${API_BASE}/llm/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { ok: false, error: err.error || `HTTP ${res.status}` };
  }
  return res.json();
}
