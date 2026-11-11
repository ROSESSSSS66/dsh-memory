import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/core/db.js';
import { backupDatabase, exportDatabaseFile, importDatabaseFile } from '../../src/evolution/maintenance.js';
import type { Db } from '../../src/types.js';

describe('Consistent database snapshots', () => {
  let directory: string;
  let target: string;
  let source: string;
  let db: Db;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-snapshot-'));
    target = path.join(directory, 'current.db');
    source = path.join(directory, 'source.db');
    const sourceDb = openDb(source);
    sourceDb.close();
    db = openDb(target);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.run("INSERT INTO meta(key, value) VALUES ('committed_only_in_wal', 'must-survive')");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('unsafe temp path');
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each(['import', 'backup', 'export'] as const)('includes committed WAL data in %s snapshots', (operation) => {
    let snapshot: string;
    if (operation === 'import') {
      expect(importDatabaseFile(db, target, source).success).toBe(true);
      snapshot = `${target}.bak`;
    } else if (operation === 'backup') {
      snapshot = backupDatabase(db, target, directory);
    } else {
      snapshot = path.join(directory, 'export.db');
      expect(exportDatabaseFile(db, target, snapshot).success).toBe(true);
    }
    const saved = openDb(snapshot, { readOnly: true });
    try {
      expect(saved.get("SELECT value FROM meta WHERE key = 'committed_only_in_wal'")?.value).toBe('must-survive');
      expect(saved.get('PRAGMA integrity_check')?.integrity_check).toBe('ok');
    } finally {
      saved.close();
    }
  });

  it('stops import and preserves the previous backup if snapshot creation fails', () => {
    expect(importDatabaseFile(db, target, source).success).toBe(true);
    const previous = fs.readFileSync(`${target}.bak`);
    vi.spyOn(db, 'exec').mockImplementation(() => { throw new Error('snapshot unavailable'); });
    const result = importDatabaseFile(db, target, source);
    expect(result).toMatchObject({ success: false, importedRecords: 0 });
    expect(result.error).toContain('snapshot unavailable');
    expect(fs.readFileSync(`${target}.bak`)).toEqual(previous);
    expect(fs.readdirSync(directory).filter(n => n.startsWith('.tmp-snapshot'))).toEqual([]);
  });

  it('does not silently fall back to an incomplete main-file copy', () => {
    vi.spyOn(db, 'exec').mockImplementation(() => { throw new Error('snapshot unavailable'); });
    expect(() => backupDatabase(db, target, directory)).toThrow('snapshot unavailable');
    const output = path.join(directory, 'export.db');
    expect(exportDatabaseFile(db, target, output).success).toBe(false);
    expect(fs.existsSync(output)).toBe(false);
  });

  it('preserves source ownership on database import after raw events expire', () => {
    const sourceDb = openDb(source);
    sourceDb.run(`INSERT INTO raw_events (session_id, seq, workspace_id, type, time, origin_kind)
      VALUES ('private-source', 1, 'private-workspace', 'user/message', 1, 'user')`);
    sourceDb.run('DELETE FROM raw_events');
    sourceDb.close();
    expect(importDatabaseFile(db, target, source).success).toBe(true);
    expect(db.all('SELECT * FROM session_workspace_owners')).toEqual([
      { session_id: 'private-source', workspace_id: 'private-workspace' },
    ]);
  });
});
