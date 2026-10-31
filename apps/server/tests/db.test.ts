import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, transaction } from '../src/storage/db.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('sqlite', () => {
  it('enables WAL and commits a 20-row transaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oij-db-'));
    dirs.push(dir);
    const db = openDatabase(join(dir, 'test.db'));
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO t(v) VALUES (?)');

    transaction(db, () => {
      for (let i = 0; i < 20; i++) insert.run(`v${i}`);
    });

    const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(mode.journal_mode).toBe('wal');
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n,
    ).toBe(20);
    db.close();
  });

  it('rolls back a failed transaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oij-db-'));
    dirs.push(dir);
    const db = openDatabase(join(dir, 'test.db'));
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
    expect(() =>
      transaction(db, () => {
        db.prepare('INSERT INTO t(v) VALUES (?)').run('a');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n,
    ).toBe(0);
    db.close();
  });
});
