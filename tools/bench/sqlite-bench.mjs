import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(join(tmpdir(), 'oij-bench-db-'));
const file = join(dir, 'bench.db');
const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL, n INTEGER)');

const insert = db.prepare('INSERT INTO t(v, n) VALUES (?, ?)');
const rounds = 200;
const samples = [];
for (let r = 0; r < rounds; r++) {
  const start = process.hrtime.bigint();
  db.exec('BEGIN IMMEDIATE');
  for (let i = 0; i < 20; i++) insert.run(`value-${r}-${i}`, i);
  db.exec('COMMIT');
  samples.push(Number(process.hrtime.bigint() - start) / 1e6);
}
samples.sort((a, b) => a - b);

const readStart = process.hrtime.bigint();
const count = db.prepare('SELECT COUNT(*) AS n FROM t').get().n;
const readMs = Number(process.hrtime.bigint() - readStart) / 1e6;

const result = {
  insert20Ms: Number(samples[Math.floor(samples.length / 2)].toFixed(3)),
  insert20MinMs: Number(samples[0].toFixed(3)),
  insert20MaxMs: Number(samples[samples.length - 1].toFixed(3)),
  rows: count,
  readMs: Number(readMs.toFixed(3)),
  dbBytes: statSync(file).size,
};
console.log(JSON.stringify(result));

db.close();
rmSync(dir, { recursive: true, force: true });
