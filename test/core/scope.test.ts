import { describe, it, expect } from 'vitest';
import { workspaceId, scopeFilterSQL } from '../../src/core/scope.js';

describe('M1-T2: scope.ts tests', () => {
  it('workspaceId produces deterministic 16-hex hash', () => {
    const id1 = workspaceId('C:\\Users\\Windows11\\Desktop\\dsh-memory-plan');
    const id2 = workspaceId('C:/Users/Windows11/Desktop/dsh-memory-plan/');
    expect(id1).toHaveLength(16);
    expect(id1).toBe(id2);
  });

  it('workspaceId handles empty or root paths gracefully', () => {
    expect(workspaceId('')).toBe('');
    expect(workspaceId('/')).toHaveLength(16);
  });

  it('workspaceId differentiates distinct directories', () => {
    const idA = workspaceId('/workspace/projectA');
    const idB = workspaceId('/workspace/projectB');
    expect(idA).not.toBe(idB);
  });

  it('scopeFilterSQL returns expected SQL structure and parameter ordering', () => {
    const filter = scopeFilterSQL({
      workspaceId: 'ws_abc',
      sessionId: 'session_123',
    });
    expect(filter.sql).toContain("scope IN ('user','global')");
    expect(filter.sql).toContain("scope='workspace' AND workspace_id=?");
    expect(filter.sql).toContain("scope='session' AND workspace_id=? AND session_id=?");
    expect(filter.params).toEqual(['ws_abc', 'ws_abc', 'session_123']);
  });
});
