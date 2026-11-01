import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { submitSource } from '../src/services/submissions.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { upsertAsset } from '../src/storage/repos/assets.js';
import { createContest } from '../src/storage/repos/contests.js';
import { getOfficialRanking } from '../src/services/official-ranking.js';
import { upsertOfficialScore, getOfficialScore } from '../src/storage/repos/official-scores.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createSubmission, getSubmission } from '../src/storage/repos/submissions.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'hack-'));
const db = openDatabase(join(root, 'test.db'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;
let contestId = 0;
let problemId = 0;
let targetSubmissionId = 0;
let hackerId = 0;
let targetId = 0;
let hackerCookie = '';
let targetCookie = '';

const stdCode = '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}\n';
const targetCode =
  '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b+1<<"\\n";}\n';

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  mkdirSync(join(root, 'p'), { recursive: true });
  writeFileSync(join(root, 'p', '1.in'), '1 2\n');
  writeFileSync(join(root, 'p', '1.out'), '3\n');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'assets', 'std.cpp'), stdCode);
  mkdirSync(join(root, 'subs'), { recursive: true });
  writeFileSync(join(root, 'subs', 'target.cpp'), targetCode);
  hackerId = createUser(db, { username: 'hacker', passwordHash: 'x' });
  targetId = createUser(db, { username: 'target', passwordHash: 'x' });
  problemId = createProblem(db, {
    title: 'Hack Target',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 64,
    testcases: [{ inputPath: 'p/1.in', outputPath: 'p/1.out', points: 100 }],
  });
  upsertAsset(db, {
    problemId,
    kind: 'std',
    name: 'std.cpp',
    path: 'assets/std.cpp',
    language: 'cpp17',
    sha256: 'std',
    size: stdCode.length,
  });
  contestId = createContest(db, { name: 'Hack Contest', mode: 'oi', problemIds: [problemId] });
  for (const userId of [hackerId, targetId]) {
    db.prepare(
      "INSERT INTO contest_participants(contest_id, user_id, status) VALUES (?, ?, 'accepted')",
    ).run(contestId, userId);
  }
  targetSubmissionId = createSubmission(db, {
    contestId,
    problemId,
    userId: targetId,
    language: 'cpp17',
    sourcePath: 'subs/target.cpp',
    sourceHash: 'target',
  });
  db.prepare(
    "UPDATE submissions SET status='finished', verdict='AC', score=100 WHERE id=?",
  ).run(targetSubmissionId);
  upsertOfficialScore(db, {
    contestId,
    userId: targetId,
    problemId,
    score: 100,
    verdict: 'AC',
    source: 'online',
    submissionId: targetSubmissionId,
  });
  hackerCookie = `oij.sid=${signSession({ userId: hackerId, version: 0 }, config.sessionSecret, 3600)}`;
  targetCookie = `oij.sid=${signSession({ userId: targetId, version: 0 }, config.sessionSecret, 3600)}`;
  app = await buildApp({ db, config });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('contest hack', () => {
  it('rejects locks after the configured hack window', async () => {
    const endedContest = createContest(db, {
      name: 'Closed Hack Window',
      mode: 'oi',
      problemIds: [problemId],
      startAt: Date.now() - 60_000,
      endAt: Date.now() - 1_000,
    });
    db.prepare(
      "INSERT INTO contest_participants(contest_id, user_id, status) VALUES (?, ?, 'accepted')",
    ).run(endedContest, hackerId);
    db.prepare('UPDATE contests SET ranking_rule_json = ? WHERE id = ?').run(
      JSON.stringify({ hackWindowMinutes: 0 }),
      endedContest,
    );
    const response = await app.inject({
      method: 'POST',
      url: `/api/contests/${endedContest}/problems/${problemId}/lock`,
      headers: { cookie: hackerCookie },
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('HACK_WINDOW_CLOSED');
  });

  it('requires a lock, reveals source, and marks a failed target as HACKED', async () => {
    const beforeLock = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/problems/${problemId}/submissions/${targetSubmissionId}/source`,
      headers: { cookie: hackerCookie },
    });
    expect(beforeLock.statusCode).toBe(403);

    const locked = await app.inject({
      method: 'POST',
      url: `/api/contests/${contestId}/problems/${problemId}/lock`,
      headers: { cookie: hackerCookie },
    });
    expect(locked.statusCode, locked.body).toBe(200);

    const source = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/problems/${problemId}/submissions/${targetSubmissionId}/source`,
      headers: { cookie: hackerCookie },
    });
    expect(source.statusCode).toBe(200);
    expect((source.json() as { data: { code: string } }).data.code).toContain('a+b+1');

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/submissions',
      headers: { cookie: hackerCookie },
      payload: { problemId, language: 'cpp17', code: 'int main(){}', contestId },
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.body).toContain('locked');

    const created = await app.inject({
      method: 'POST',
      url: `/api/contests/${contestId}/problems/${problemId}/hacks`,
      headers: { cookie: hackerCookie },
      payload: { targetSubmissionId, input: '2 2\n' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const hackId = (created.json() as { data: { id: number } }).data.id;
    let hack: { status: string; verdict: string | null } | null = null;
    for (let i = 0; i < 100; i++) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/contests/${contestId}/hacks/${hackId}`,
        headers: { cookie: hackerCookie },
      });
      hack = (response.json() as { data: { status: string; verdict: string | null } }).data;
      if (hack.status !== 'queued' && hack.status !== 'judging') break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(hack?.status, JSON.stringify(hack)).toBe('success');
    expect(hack?.verdict).toBe('WA');
    const hacked = getSubmission(db, targetSubmissionId)!;
    expect(hacked.hacked_at).not.toBeNull();
    expect(hacked.hacked_by).toBe(hackerId);
    expect(getOfficialScore(db, contestId, targetId, problemId)?.score).toBe(0);
    const ranking = await getOfficialRanking(db, contestId, root);
    expect(ranking?.rows.find((row) => row.userId === targetId)?.hackedCount).toBe(1);
    expect(ranking?.rows.find((row) => row.userId === hackerId)?.successfulHacks).toBe(1);
  }, 30_000);

  it('rejects invalid hack input before touching the target', async () => {
    const validatorCode = 'int main(){return 1;}\n';
    writeFileSync(join(root, 'assets', 'validator.cpp'), validatorCode);
    upsertAsset(db, {
      problemId,
      kind: 'validator',
      name: 'validator.cpp',
      path: 'assets/validator.cpp',
      language: 'cpp17',
      sha256: 'validator',
      size: validatorCode.length,
    });
    const secondTarget = createSubmission(db, {
      contestId,
      problemId,
      userId: targetId,
      language: 'cpp17',
      sourcePath: 'subs/target.cpp',
      sourceHash: 'target2',
    });
    db.prepare("UPDATE submissions SET status='finished', verdict='AC', score=100 WHERE id=?").run(
      secondTarget,
    );
    const created = await app.inject({
      method: 'POST',
      url: `/api/contests/${contestId}/problems/${problemId}/hacks`,
      headers: { cookie: hackerCookie },
      payload: { targetSubmissionId: secondTarget, input: 'not a valid input\n' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const hackId = (created.json() as { data: { id: number } }).data.id;
    let status = '';
    for (let i = 0; i < 100; i++) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/contests/${contestId}/hacks/${hackId}`,
        headers: { cookie: hackerCookie },
      });
      status = (response.json() as { data: { status: string } }).data.status;
      if (status !== 'queued' && status !== 'judging') break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(status).toBe('invalid');
    expect(getSubmission(db, secondTarget)!.hacked_at).toBeNull();
  }, 30_000);
});
