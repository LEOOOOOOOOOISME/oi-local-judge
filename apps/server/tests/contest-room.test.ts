import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WS_EVENTS } from '@oij/shared';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig, type Config } from '../src/config.js';
import { judgeSubmission } from '../src/judge/pipeline.js';
import { createHub, type Hub } from '../src/realtime/hub.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { createContest } from '../src/storage/repos/contests.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createSubmission } from '../src/storage/repos/submissions.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function fakeClient() {
  const sent: string[] = [];
  return {
    sent,
    client: {
      readyState: 1,
      send: (payload: string) => sent.push(payload),
    },
  };
}

async function connectSocket(port: number, token: string, query = ''): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, {
    headers: { Cookie: `oij.sid=${token}` },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for hello')), 3000);
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as { type?: string };
      if (message.type === 'hello') {
        clearTimeout(timer);
        resolve();
      }
    });
    socket.on('error', reject);
  });
  return socket;
}

async function setupApp() {
  const dataDir = mkdtempSync(join(tmpdir(), 'oij-contest-room-'));
  ensureDataDirs(dataDir);
  const db = openDatabase(':memory:');
  migrate(db);
  const config: Config = {
    ...loadConfig({
      ...process.env,
      OIJ_SESSION_SECRET: 'test-session-secret-0123456789-abcdef',
      OIJ_DATA_DIR: dataDir,
    }),
    dataDir,
  };
  const inner = createHub();
  const subscriptions: string[][] = [];
  const hub: Hub = {
    publish: (event) => inner.publish(event),
    subscribe: (client, rooms) => {
      subscriptions.push([...rooms]);
      inner.subscribe(client, rooms);
    },
    unsubscribe: (client) => inner.unsubscribe(client),
    roomsOf: (client) => inner.roomsOf(client),
  };
  const app = await buildApp({ db, config, hub });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  cleanups.push(async () => {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { app, db, config, hub, subscriptions, port: address.port };
}

function tokenFor(db: ReturnType<typeof openDatabase>, config: Config, username: string) {
  const userId = createUser(db, { username, passwordHash: hashPassword('secret') });
  const token = signSession({ userId, version: 0 }, config.sessionSecret, 3600);
  return { userId, token };
}

describe('contest websocket rooms', () => {
  it('keeps room isolation between user, contest and admin clients', () => {
    const hub = createHub();
    const user = fakeClient();
    const otherContest = fakeClient();
    const contest = fakeClient();
    const admin = fakeClient();
    hub.subscribe(user.client, ['user:1']);
    hub.subscribe(otherContest.client, ['user:2', 'contest:8']);
    hub.subscribe(contest.client, ['user:3', 'contest:7']);
    hub.subscribe(admin.client, ['user:4', 'admin']);

    hub.publish({
      type: WS_EVENTS.submissionUpdated,
      data: { submissionId: 42 },
      room: 'contest:7',
    });

    expect(contest.sent).toHaveLength(1);
    expect(admin.sent).toHaveLength(1);
    expect(user.sent).toHaveLength(0);
    expect(otherContest.sent).toHaveLength(0);
    expect(JSON.parse(contest.sent[0])).toEqual({
      v: 1,
      type: WS_EVENTS.submissionUpdated,
      data: { submissionId: 42 },
    });
  });

  it('subscribes /ws?contestId to the contest room and keeps user/admin rooms', async () => {
    const { db, config, subscriptions, port } = await setupApp();
    const alice = tokenFor(db, config, 'alice');
    const admin = createUser(db, { username: 'admin', passwordHash: 'x', role: 'admin' });
    const adminToken = signSession({ userId: admin, version: 0 }, config.sessionSecret, 3600);
    const contestId = createContest(db, { name: 'Room', problemIds: [] });

    const aliceSocket = await connectSocket(port, alice.token, `?contestId=${contestId}`);
    expect(subscriptions[subscriptions.length - 1]).toEqual([
      `user:${alice.userId}`,
      `contest:${contestId}`,
    ]);
    aliceSocket.close();

    const adminSocket = await connectSocket(port, adminToken, `?contestId=${contestId}`);
    expect(subscriptions[subscriptions.length - 1]).toEqual([
      `user:${admin}`,
      'admin',
      `contest:${contestId}`,
    ]);
    adminSocket.close();
  });

  it('ignores invalid contestId values', async () => {
    const { db, config, subscriptions, port } = await setupApp();
    const alice = tokenFor(db, config, 'alice');

    for (const query of ['?contestId=abc', '?contestId=', '?contestId=0', '?contestId=1.5']) {
      const socket = await connectSocket(port, alice.token, query);
      expect(subscriptions[subscriptions.length - 1]).toEqual([`user:${alice.userId}`]);
      socket.close();
    }
  });
});

describe('judge submission events', () => {
  async function setupJudge() {
    const dataDir = mkdtempSync(join(tmpdir(), 'oij-contest-room-judge-'));
    ensureDataDirs(dataDir);
    const db = openDatabase(':memory:');
    migrate(db);
    const config: Config = {
      ...loadConfig({
        ...process.env,
        OIJ_SESSION_SECRET: 'test-session-secret-0123456789-abcdef',
        OIJ_DATA_DIR: dataDir,
      }),
      dataDir,
    };
    cleanups.push(() => {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    });
    const userId = createUser(db, { username: 'alice', passwordHash: 'x' });
    const problemId = createProblem(db, {
      title: 'Objective',
      type: 'objective',
      timeMs: 1000,
      memoryMb: 64,
      objective: {
        questions: [
          {
            id: 1,
            kind: 'single',
            stem: '1+1=?',
            options: [
              { key: 'A', text: '1' },
              { key: 'B', text: '2' },
            ],
            answers: ['B'],
            points: 100,
          },
        ],
      },
      testcases: [],
    });
    const contestId = createContest(db, { name: 'Judge Room', problemIds: [problemId] });
    writeFileSync(
      join(dataDir, 'answers.json'),
      JSON.stringify({ answers: [{ questionId: 1, value: ['B'] }] }),
    );
    return { db, config, dataDir, userId, problemId, contestId };
  }

  it('adds the contest and submitter rooms to finished and failed submission events', async () => {
    const { db, config, userId, problemId, contestId } = await setupJudge();
    const events: Array<{ type: string; data: unknown; room?: string }> = [];

    const finishedId = createSubmission(db, {
      contestId,
      problemId,
      userId,
      language: 'objective',
      sourcePath: 'answers.json',
      sourceHash: 'h',
    });
    await judgeSubmission({
      db,
      config,
      submissionId: finishedId,
      events: { publish: (event) => events.push(event) },
    });

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.room)).toEqual([
      `contest:${contestId}`,
      `user:${userId}`,
    ]);
    for (const event of events) {
      expect(event.type).toBe(WS_EVENTS.submissionUpdated);
      expect(event.data).toMatchObject({ submissionId: finishedId, status: 'finished' });
    }

    const failedEvents: Array<{ type: string; data: unknown; room?: string }> = [];
    const failedId = createSubmission(db, {
      contestId,
      problemId: 999_999,
      userId,
      language: 'objective',
      sourcePath: 'answers.json',
      sourceHash: 'h',
    });
    await judgeSubmission({
      db,
      config,
      submissionId: failedId,
      events: { publish: (event) => failedEvents.push(event) },
    });
    expect(failedEvents).toHaveLength(2);
    expect(failedEvents.map((event) => event.room)).toEqual([
      `contest:${contestId}`,
      `user:${userId}`,
    ]);
    for (const event of failedEvents) {
      expect(event.type).toBe(WS_EVENTS.submissionUpdated);
      expect(event.data).toMatchObject({ submissionId: failedId, status: 'failed' });
    }
  });

  it('reaches the contest room and the submitter room, but not unrelated users', async () => {
    const { db, config, userId, problemId, contestId } = await setupJudge();
    const hub = createHub();
    const submitter = fakeClient();
    const otherUser = fakeClient();
    const contestClient = fakeClient();
    const admin = fakeClient();
    hub.subscribe(submitter.client, [`user:${userId}`]);
    hub.subscribe(otherUser.client, [`user:${userId + 1}`]);
    hub.subscribe(contestClient.client, [`contest:${contestId}`]);
    hub.subscribe(admin.client, ['admin']);

    const submissionId = createSubmission(db, {
      contestId,
      problemId,
      userId,
      language: 'objective',
      sourcePath: 'answers.json',
      sourceHash: 'h',
    });
    await judgeSubmission({ db, config, submissionId, events: hub });

    expect(contestClient.sent).toHaveLength(1);
    expect(submitter.sent).toHaveLength(1);
    expect(otherUser.sent).toHaveLength(0);
    // Admin bypasses room scoping and may observe both publishes.
    expect(admin.sent.length).toBeGreaterThan(0);
    for (const payload of [contestClient.sent[0], submitter.sent[0]]) {
      expect(JSON.parse(payload)).toMatchObject({
        v: 1,
        type: WS_EVENTS.submissionUpdated,
        data: { submissionId, status: 'finished' },
      });
    }
  });

  it('does not scope events for submissions outside a contest', async () => {
    const { db, config, userId, problemId } = await setupJudge();
    const events: Array<{ type: string; data: unknown; room?: string }> = [];
    const submissionId = createSubmission(db, {
      contestId: null,
      problemId,
      userId,
      language: 'objective',
      sourcePath: 'answers.json',
      sourceHash: 'h',
    });
    await judgeSubmission({
      db,
      config,
      submissionId,
      events: { publish: (event) => events.push(event) },
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(WS_EVENTS.submissionUpdated);
    expect(events[0].room).toBeUndefined();
  });
});
