import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'admin-problem-picker-'));
const db = openDatabase(join(root, 'test.db'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;
const cookies = new Map<string, string>();
let publicProblemId = 0;
let teamProblemId = 0;
let personalProblemId = 0;

function cookieFor(userId: number): string {
  return `oij.sid=${signSession({ userId, version: 0 }, config.sessionSecret, 3600)}`;
}

interface PickerItem {
  id: number;
  displayId: string;
  title: string;
  type: string;
  tags: string[];
  ownerType: string;
  ownerId: number | null;
  owner: { type: string; id: number | null };
  kind: string;
  scope: string;
}

async function pick(query: string, as = 'admin'): Promise<{
  statusCode: number;
  body: string;
  items: PickerItem[];
}> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/admin/problems/picker${query}`,
    headers: { cookie: cookies.get(as) ?? '' },
  });
  let items: PickerItem[] = [];
  try {
    items = (response.json() as { data?: PickerItem[] }).data ?? [];
  } catch {
    items = [];
  }
  return { statusCode: response.statusCode, body: response.body, items };
}

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  const users: Array<[string, string, string]> = [
    ['admin', 'admin', 'admin123'],
    ['setter', 'setter', 'setter123'],
    ['manager', 'contestmanager', 'manager123'],
    ['student', 'contestant', 'student123'],
  ];
  for (const [username, role, password] of users) {
    const userId = createUser(db, {
      username,
      passwordHash: hashPassword(password),
      role: role as 'admin' | 'setter' | 'contestmanager' | 'contestant',
    });
    cookies.set(username, cookieFor(userId));
  }
  publicProblemId = createProblem(db, {
    title: 'Alpha Search',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 64,
    displayId: 'P2001',
    tags: ['dp', 'graph'],
    ownerType: 'system',
    testcases: [],
  });
  teamProblemId = createProblem(db, {
    title: 'Beta Team',
    type: 'objective',
    timeMs: 2000,
    memoryMb: 128,
    displayId: 'P2002',
    tags: ['math'],
    ownerType: 'team',
    ownerId: 42,
    testcases: [],
  });
  personalProblemId = createProblem(db, {
    title: 'Gamma Personal',
    type: 'standard',
    timeMs: 3000,
    memoryMb: 256,
    displayId: 'P2003',
    tags: ['dp', 'string'],
    ownerType: 'user',
    ownerId: 7,
    testcases: [],
  });
  app = await buildApp({ db, config });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('problem picker auth', () => {
  it('allows admin, setter and contestmanager', async () => {
    for (const role of ['admin', 'setter', 'manager']) {
      const result = await pick('?scope=all', role);
      expect(result.statusCode, `${role}: ${result.body}`).toBe(200);
      expect(result.items.length).toBe(3);
    }
  });

  it('rejects contestants and unauthenticated requests', async () => {
    const contestant = await pick('?scope=all', 'student');
    expect(contestant.statusCode).toBe(403);
    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/admin/problems/picker?scope=all',
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('problem picker scope and search', () => {
  it('filters by owner scope', async () => {
    expect((await pick('?scope=personal')).items.map((item) => item.id)).toEqual([
      personalProblemId,
    ]);
    expect((await pick('?scope=team')).items.map((item) => item.id)).toEqual([teamProblemId]);
    expect((await pick('?scope=public')).items.map((item) => item.id)).toEqual([publicProblemId]);
    expect((await pick('?scope=all')).items.map((item) => item.id)).toHaveLength(3);
  });

  it('searches display id, title, tags and numeric id', async () => {
    expect((await pick('?query=p2002')).items.map((item) => item.id)).toEqual([teamProblemId]);
    expect((await pick('?query=GAMMA')).items.map((item) => item.id)).toEqual([
      personalProblemId,
    ]);
    expect((await pick('?query=math')).items.map((item) => item.id)).toEqual([teamProblemId]);
    expect((await pick('?query=dp')).items.map((item) => item.id).sort()).toEqual(
      [publicProblemId, personalProblemId].sort(),
    );
    expect((await pick(`?query=${personalProblemId}`)).items.map((item) => item.id)).toEqual([
      personalProblemId,
    ]);
    expect((await pick('?query=missing')).items).toEqual([]);
  });

  it('combines scope and query and applies the limit', async () => {
    const scoped = await pick('?scope=personal&query=string');
    expect(scoped.items.map((item) => item.id)).toEqual([personalProblemId]);
    const limited = await pick('?scope=all&limit=2');
    expect(limited.items).toHaveLength(2);
    expect(limited.items.map((item) => item.id)).toEqual([personalProblemId, teamProblemId]);
    const invalidLimit = await pick('?scope=all&limit=0');
    expect(invalidLimit.statusCode).toBe(200);
    expect(invalidLimit.items).toHaveLength(3);
  });

  it('rejects an unknown scope', async () => {
    const result = await pick('?scope=other');
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('INVALID_SCOPE');
  });

  it('returns the picker fields the batch UI needs', async () => {
    const result = await pick('?scope=team');
    const item = result.items[0]!;
    expect(item.id).toBe(teamProblemId);
    expect(item.displayId).toBe('P2002');
    expect(item.title).toBe('Beta Team');
    expect(item.owner).toEqual({ type: 'team', id: 42 });
    expect(item.ownerType).toBe('team');
    expect(item.ownerId).toBe(42);
    expect(item.kind).toBe('objective');
    expect(item.type).toBe('objective');
    expect(item.scope).toBe('team');
    expect(item.tags).toEqual(['math']);
  });
});
