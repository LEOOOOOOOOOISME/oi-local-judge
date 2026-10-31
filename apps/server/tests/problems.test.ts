import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { registerProblemRoutes } from '../src/http/problems.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may briefly lock SQLite/WAL files after close.
    }
  }
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'oij-problems-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  const config = { ...loadConfig({ OIJ_DATA_DIR: dir }), dataDir: dir };
  const app = Fastify();
  registerProblemRoutes(app, { db, config });
  return { dir, db, app };
}

describe('problem import and read API', () => {
  it('imports the sample problem and exposes it without data paths', async () => {
    const { app, db } = setup();
    const importRes = await app.inject({
      method: 'POST',
      url: '/api/admin/problems/import',
      payload: { path: join(process.cwd(), 'tools/seed/sample-problem') },
    });
    expect(importRes.statusCode).toBe(201);
    const imported = importRes.json() as { data: { id: number } };

    const list = await app.inject({ method: 'GET', url: '/api/problems' });
    expect(list.json().data).toHaveLength(1);

    const detail = await app.inject({ method: 'GET', url: `/api/problems/${imported.data.id}` });
    expect(detail.statusCode, detail.body).toBe(200);
    const body = detail.json() as {
      data: {
        title: string;
        statementHtml: string;
        samples: unknown[];
      };
    };
    expect(body.data.title).toBe('A+B Problem');
    expect(body.data.statementHtml).toContain('A+B Problem');
    expect(body.data.samples).toHaveLength(1);
    expect(JSON.stringify(body.data)).not.toContain('1.in');
    db.close();
    await app.close();
  });

  it('rejects a missing problem directory', async () => {
    const { app, db } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/problems/import',
      payload: { path: join(process.cwd(), 'tools/seed/does-not-exist') },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('IMPORT_FAILED');
    db.close();
    await app.close();
  });
});
