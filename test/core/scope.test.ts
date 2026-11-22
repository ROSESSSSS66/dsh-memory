import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { workspaceId, normalizeWorkspacePath, scopeFilterSQL } from '../../src/core/scope.js';

describe('M1-T2: scope.ts tests', () => {
  it('workspaceId produces deterministic 16-hex hash for platform-neutral synthetic paths', () => {
    const base = path.resolve('/synthetic/workspaces/dsh-memory-demo');
    const withTrailingSlash = `${base}/`;
    const withForwardSlashes = base.replace(/\\/g, '/') + '/';
    const id1 = workspaceId(base);
    const id2 = workspaceId(withTrailingSlash);
    const id3 = workspaceId(withForwardSlashes);
    expect(id1).toMatch(/^[0-9a-f]{16}$/);
    expect(id1).toBe(id2);
    expect(id1).toBe(id3);
  });

  it('workspaceId passes through valid 16-hex workspace IDs in lowercase', () => {
    expect(workspaceId('a1b2c3d4e5f60789')).toBe('a1b2c3d4e5f60789');
    expect(workspaceId('A1B2C3D4E5F60789')).toBe('a1b2c3d4e5f60789');
    expect(workspaceId('  DeadBeef01234567  ')).toBe('deadbeef01234567');
  });

  it('normalizes Windows extended-length \\\\?\\ and //?/ prefixes deterministically', () => {
    const base = path.resolve('/synthetic/workspaces/long-path-project');
    const winPrefix = `\\\\?\\${base}`;
    const slashPrefix = `//?/${base}`;
    expect(normalizeWorkspacePath(winPrefix)).toBe(normalizeWorkspacePath(base));
    expect(normalizeWorkspacePath(slashPrefix)).toBe(normalizeWorkspacePath(base));
    expect(workspaceId(winPrefix)).toBe(workspaceId(base));
    expect(workspaceId(slashPrefix)).toBe(workspaceId(base));
  });

  it('workspaceId handles empty or root paths gracefully', () => {
    expect(workspaceId('')).toBe('');
    expect(workspaceId('   ')).toBe('');
    expect(workspaceId('/')).toHaveLength(16);
  });

  it('workspaceId differentiates distinct directories', () => {
    const idA = workspaceId('/synthetic/workspace/projectA');
    const idB = workspaceId('/synthetic/workspace/projectB');
    expect(idA).not.toBe(idB);
  });

  it('scopeFilterSQL includes session scope only when sessionId is provided', () => {
    const withSession = scopeFilterSQL({
      workspaceId: 'ws_abc',
      sessionId: 'session_123',
    });
    expect(withSession.sql).toContain("scope IN ('user','global')");
    expect(withSession.sql).toContain("scope='workspace' AND workspace_id=?");
    expect(withSession.sql).toContain("scope='session' AND workspace_id=? AND session_id=?");
    expect(withSession.params).toEqual(['ws_abc', 'ws_abc', 'session_123']);
  });

  it('scopeFilterSQL excludes scope="session" when sessionId is omitted or blank', () => {
    const withoutSession = scopeFilterSQL({ workspaceId: 'ws_abc' });
    expect(withoutSession.sql).toContain("scope IN ('user','global')");
    expect(withoutSession.sql).toContain("scope='workspace' AND workspace_id=?");
    expect(withoutSession.sql).not.toContain("scope='session'");
    expect(withoutSession.params).toEqual(['ws_abc']);

    const blankSession = scopeFilterSQL({ workspaceId: 'ws_abc', sessionId: '   ' }, 'm');
    expect(blankSession.sql).toContain("m.scope IN ('user','global')");
    expect(blankSession.sql).toContain("m.scope='workspace' AND m.workspace_id=?");
    expect(blankSession.sql).not.toContain("scope='session'");
    expect(blankSession.params).toEqual(['ws_abc']);
  });
});
