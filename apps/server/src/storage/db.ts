import { DatabaseSync } from 'node:sqlite';

export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA cache_size = -65536');
  db.exec('PRAGMA mmap_size = 134217728');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA wal_autocheckpoint = 1000');
  return db;
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
