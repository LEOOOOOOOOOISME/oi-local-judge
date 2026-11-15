/**
 * README 截图演示数据（只用于本机临时 dataDir，不接触真实数据）。
 *
 * 由 tools/capture-readme-screenshots.mjs 调用：
 *   - 读取 OIJ_DATA_DIR / OIJ_ADMIN_USERNAME / OIJ_ADMIN_PASSWORD；
 *   - 建库、建管理员（若尚无）、导入演示题目、建比赛与提交、班级与训练计划、
 *     一个 "评测中" 的批量任务（含进度与失败明细）；
 *   - 把生成的 id 写到 <dataDir>/seed.json，截图脚本据此跳转页面。
 *
 * 所有账号、姓名、提交均为演示数据；学生账号使用一次性随机散列，不用于登录。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ensureDataDirs } from '../../apps/server/src/config.js';
import { ensureAdmin } from '../../apps/server/src/services/bootstrap.js';
import {
  importProblemDirectory,
  repairLegacyTestcasePaths,
} from '../../apps/server/src/services/problems.js';
import { openDatabase } from '../../apps/server/src/storage/db.js';
import { migrate } from '../../apps/server/src/storage/migrate.js';
import { hashPassword } from '../../apps/server/src/security/password.js';
import { createUser, getUserByUsername } from '../../apps/server/src/storage/repos/users.js';
import {
  addParticipant,
  createContest,
  setContestStatus,
} from '../../apps/server/src/storage/repos/contests.js';
import {
  createSubmission,
  finishSubmission,
} from '../../apps/server/src/storage/repos/submissions.js';
import {
  addBatchItem,
  createBatchJob,
} from '../../apps/server/src/storage/repos/batches.js';
import {
  insertTeamMember,
} from '../../apps/server/src/storage/repos/teams.js';
import { createClass } from '../../apps/server/src/services/teams.js';
import {
  createTrainingPlan,
} from '../../apps/server/src/services/training-plans.js';
import { createHack, updateHack } from '../../apps/server/src/storage/repos/hacks.js';
import { recordAudit } from '../../apps/server/src/storage/repos/audit.js';

interface DemoProblem {
  title: string;
  type?: string;
  difficulty: number;
  tags: string[];
  statement: string;
  samples: Array<{ input: string; output: string; explanation?: string }>;
  testcases: Array<{ input: string; output: string; points: number }>;
}

const config = loadConfig();
ensureDataDirs(config.dataDir);
const dbPath = join(config.dataDir, 'db', 'oijudge.db');
const db = openDatabase(dbPath);
migrate(db);
repairLegacyTestcasePaths(db, config.dataDir);

// 只允许在全新的临时数据目录上运行，避免误伤已有数据。
const existingUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
if (Number(existingUsers.n) > 0) {
  throw new Error(
    `demo seed expects an empty data directory, found ${existingUsers.n} user(s) in ${config.dataDir}`,
  );
}

ensureAdmin(db, config);
const adminRow = getUserByUsername(db, config.adminUsername);
if (!adminRow) throw new Error('failed to create the demo administrator');
const adminId = adminRow.id;

// ---------------------------------------------------------------------------
// 题目：Markdown + LaTeX 题面（与帮助中心/题面渲染一致）。
// ---------------------------------------------------------------------------
const problems: DemoProblem[] = [
  {
    title: '区间求和',
    difficulty: 1,
    tags: ['前缀和', '入门'],
    statement: String.raw`# 区间求和

给定一个长度为 $n$ 的整数序列 $a_1, a_2, \dots, a_n$，需要回答 $q$ 次询问：区间 $[l, r]$ 内所有元素之和。

## 输入格式

第一行两个整数 $n, q$（$1 \le n, q \le 2 \times 10^5$）。

第二行 $n$ 个整数 $a_i$（$|a_i| \le 10^9$）。

接下来 $q$ 行，每行两个整数 $l, r$（$1 \le l \le r \le n$）。

## 输出格式

对于每个询问输出一行一个整数，表示区间和。

## 数据范围

| 子任务 | 分值 | 限制 |
| --- | --- | --- |
| 1 | 30 | $n, q \le 1000$ |
| 2 | 70 | 无特殊限制 |

## 提示

令 $S_i = \sum_{j=1}^{i} a_j$，答案即为 $S_r - S_{l-1}$，单次询问复杂度 $\mathcal{O}(1)$。`,
    samples: [
      { input: '5 3\n1 2 3 4 5\n1 3\n2 5\n4 4\n', output: '6\n14\n4\n', explanation: '三个询问的区间和依次为 6、14、4。' },
    ],
    testcases: [
      { input: 'data/1.in', output: 'data/1.out', points: 50 },
      { input: 'data/2.in', output: 'data/2.out', points: 50 },
    ],
  },
  {
    title: '最短路计数',
    difficulty: 2,
    tags: ['图论', 'BFS'],
    statement: String.raw`# 最短路计数

给定一张 $n$ 个点、$m$ 条边的无向无权图，保证无自环、无重边。求从 $1$ 号点到每个点的最短路条数。

由于答案可能很大，请对 $10^9 + 7$ 取模。

## 输入格式

第一行两个整数 $n, m$（$2 \le n \le 2 \times 10^5$，$1 \le m \le 2 \times 10^5$）。

接下来 $m$ 行，每行两个整数 $u, v$，表示一条无向边。

## 输出格式

输出一行 $n$ 个整数，第 $i$ 个整数表示 $1$ 到 $i$ 的最短路条数；若不可达输出 $0$。

## 提示

在 BFS 中同时维护距离与计数：当 $dis_v = dis_u + 1$ 时累加方案数，当发现更短路径时重置计数。`,
    samples: [
      { input: '4 4\n1 2\n2 3\n1 3\n3 4\n', output: '1 1 2 2\n', explanation: '到 3 有两条最短路：1-3 与 1-2-3。' },
    ],
    testcases: [
      { input: 'data/1.in', output: 'data/1.out', points: 50 },
      { input: 'data/2.in', output: 'data/2.out', points: 50 },
    ],
  },
  {
    title: '树上最近公共祖先',
    difficulty: 3,
    tags: ['树', '倍增'],
    statement: String.raw`# 树上最近公共祖先

给定一棵以 $1$ 为根的有根树，回答 $q$ 次询问：点 $u$ 与点 $v$ 的最近公共祖先（LCA）。

## 输入格式

第一行三个整数 $n, q, root$，其中 $root = 1$。

接下来 $n - 1$ 行，每行两个整数 $u, v$，表示一条树边。

接下来 $q$ 行，每行两个整数 $u, v$，表示一次询问。

## 输出格式

对于每次询问输出一行一个整数，表示 $u, v$ 的最近公共祖先。

## 数据范围

$1 \le n, q \le 2 \times 10^5$。

## 提示

用倍增预处理 $f_{i,j}$ 表示 $i$ 的 $2^j$ 级祖先，回答询问时先把较深的点跳到同一深度，再从大到小同时上跳。预处理与单次询问复杂度均为 $\mathcal{O}(\log n)$。`,
    samples: [
      { input: '5 3\n1 2\n1 3\n2 4\n2 5\n4 5\n4 3\n2 5\n', output: '2\n1\n2\n' },
    ],
    testcases: [
      { input: 'data/1.in', output: 'data/1.out', points: 50 },
      { input: 'data/2.in', output: 'data/2.out', points: 50 },
    ],
  },
  {
    title: '区间众数',
    difficulty: 4,
    tags: ['分块', '莫队'],
    statement: String.raw`# 区间众数

给定长度为 $n$ 的序列 $a$，回答 $q$ 次询问：区间 $[l, r]$ 中出现次数最多的数。若有多个数出现次数相同，输出其中最小的一个。

## 输入格式

第一行两个整数 $n, q$（$1 \le n, q \le 10^5$）。

第二行 $n$ 个整数 $a_i$（$1 \le a_i \le 10^9$）。

接下来 $q$ 行，每行两个整数 $l, r$。

## 输出格式

对于每次询问输出一行一个整数，表示答案。

## 提示

将询问离线后使用莫队算法，维护每个值的出现次数与当前众数；块大小取 $\sqrt{n}$ 时总复杂度约为 $\mathcal{O}(n\sqrt{n})$。`,
    samples: [
      { input: '6 2\n1 2 2 3 3 2\n1 5\n2 6\n', output: '2\n2\n' },
    ],
    testcases: [
      { input: 'data/1.in', output: 'data/1.out', points: 50 },
      { input: 'data/2.in', output: 'data/2.out', points: 50 },
    ],
  },
  {
    title: '括号序列',
    difficulty: 2,
    tags: ['动态规划', '栈'],
    statement: String.raw`# 括号序列

给定一个长度为 $n$ 的括号串 $s$（只包含小写字符 $\texttt{(}$ 和 $\texttt{)}$），求其最长合法括号子序列的长度。

合法括号序列定义如下：

- 空串是合法括号序列；
- 若 $A$、$B$ 是合法括号序列，则 $AB$ 与 $(A)$ 也是合法括号序列。

## 输入格式

一行一个长度为 $n$ 的括号串（$1 \le n \le 10^6$）。

## 输出格式

输出一个整数，表示最长合法括号子序列的长度。

## 提示

用栈匹配括号时，每次成功匹配都会让答案增加 $2$；剩余未匹配的括号无法组成合法子序列。`,
    samples: [
      { input: ')(()))(\n', output: '4\n', explanation: '可取子序列 "()()"，长度为 4。' },
    ],
    testcases: [
      { input: 'data/1.in', output: 'data/1.out', points: 50 },
      { input: 'data/2.in', output: 'data/2.out', points: 50 },
    ],
  },
];

const seedRoot = join(config.dataDir, 'tmp', 'readme-seed-problems');
rmSync(seedRoot, { recursive: true, force: true });
mkdirSync(seedRoot, { recursive: true });

const problemIds: number[] = [];
problems.forEach((problem, index) => {
  const sourceDir = join(seedRoot, `p${index + 1}`);
  mkdirSync(join(sourceDir, 'data'), { recursive: true });
  writeFileSync(
    join(sourceDir, 'problem.json'),
    JSON.stringify(
      {
        title: problem.title,
        type: 'standard',
        difficulty: problem.difficulty,
        tags: problem.tags,
        timeMs: 1000,
        memoryMb: 256,
        ioMode: 'stdio',
        statement: problem.statement,
        samples: problem.samples,
        testcases: problem.testcases,
      },
      null,
      2,
    ),
    'utf8',
  );
  for (const testcase of problem.testcases) {
    writeFileSync(join(sourceDir, testcase.input), 'demo input\n', 'utf8');
    writeFileSync(join(sourceDir, testcase.output), 'demo output\n', 'utf8');
  }
  problemIds.push(
    importProblemDirectory({ db, config, sourceDir }),
  );
});

// ---------------------------------------------------------------------------
// 用户：1 名管理员 + 24 名学生（姓名、班级均为演示数据）。
// ---------------------------------------------------------------------------
const studentNames = [
  ['王小明', '2026 级竞赛 A 班'],
  ['李思远', '2026 级竞赛 A 班'],
  ['张子涵', '2026 级竞赛 A 班'],
  ['陈雨桐', '2026 级竞赛 A 班'],
  ['刘博文', '2026 级竞赛 A 班'],
  ['赵一鸣', '2026 级竞赛 A 班'],
  ['孙嘉禾', '2026 级竞赛 A 班'],
  ['周星辰', '2026 级竞赛 A 班'],
  ['吴桐', '2026 级竞赛 A 班'],
  ['郑可欣', '2026 级竞赛 A 班'],
  ['冯亦舟', '2026 级竞赛 A 班'],
  ['何若溪', '2026 级竞赛 A 班'],
  ['许嘉言', '2026 级竞赛 B 班'],
  ['邓子航', '2026 级竞赛 B 班'],
  ['曹雨菲', '2026 级竞赛 B 班'],
  ['彭一诺', '2026 级竞赛 B 班'],
  ['曾乐天', '2026 级竞赛 B 班'],
  ['萧梓萱', '2026 级竞赛 B 班'],
  ['田润泽', '2026 级竞赛 B 班'],
  ['董欣然', '2026 级竞赛 B 班'],
  ['袁书航', '2026 级竞赛 B 班'],
  ['潘若岚', '2026 级竞赛 B 班'],
  ['蔡明轩', '2026 级竞赛 B 班'],
  ['蒋语晨', '2026 级竞赛 B 班'],
] as const;

// 学生账号不用于登录；共享一个随机散列即可（运行时生成，仓库里没有密码）。
const studentPasswordHash = hashPassword(`demo-${Math.random().toString(36)}-disabled`);
const students: Array<{ id: number; username: string; realName: string; className: string }> = [];
studentNames.forEach(([realName, className], index) => {
  const username = `demo${String(index + 1).padStart(2, '0')}`;
  const id = createUser(db, {
    username,
    passwordHash: studentPasswordHash,
    realName,
    className,
    role: 'contestant',
  });
  students.push({ id, username, realName, className });
});

// ---------------------------------------------------------------------------
// 比赛：已结束的 OI 比赛（正式榜、统计、订正榜）+ 进行中的比赛（列表页）。
// ---------------------------------------------------------------------------
const now = Date.now();
const contestStart = now - 5 * 24 * 3600_000;
const contestEnd = now - 4 * 24 * 3600_000;
const contestId = createContest(db, {
  name: '2026 秋季新手赛',
  mode: 'oi',
  startAt: contestStart,
  endAt: contestEnd,
  problemIds,
});
setContestStatus(db, contestId, 'ended');
for (const student of students) addParticipant(db, contestId, student.id, contestStart);

const runningContestId = createContest(db, {
  name: '2026 秋季提高组模拟赛',
  mode: 'oi',
  startAt: now - 2 * 3600_000,
  endAt: now + 2 * 3600_000,
  problemIds: problemIds.slice(0, 3),
});
setContestStatus(db, runningContestId, 'running');
for (const student of students.slice(0, 8)) {
  addParticipant(db, runningContestId, student.id, now - 2 * 3600_000);
}

// 确定性伪随机，保证每次生成的榜单/统计一致。
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(20261115);

interface CreatedSubmission {
  id: number;
  userId: number;
  problemId: number;
  verdict: string | null;
  score: number;
}
const contestSubmissions: CreatedSubmission[] = [];
const verdictForScore = (score: number, roll: number): string => {
  if (score >= 100) return 'AC';
  if (roll < 0.2) return 'TLE';
  if (roll < 0.4) return 'RE';
  if (roll < 0.55) return 'MLE';
  return 'WA';
};

students.forEach((student, userIndex) => {
  const strength = userIndex < 6 ? 0.86 : userIndex < 14 ? 0.58 : 0.3;
  problemIds.forEach((problemId, problemIndex) => {
    const roll = random();
    const chance = strength - problemIndex * 0.07;
    let score = 0;
    if (roll < chance * 0.75) score = 100;
    else if (roll < chance + 0.2) score = 60;
    else if (roll < chance + 0.33) score = 30;
    const verdict = verdictForScore(score, roll);
    const attemptAt = contestStart + ((userIndex * 37 + problemIndex * 53) % 3000) * 60_000;
    const submissionId = createSubmission(db, {
      contestId,
      problemId,
      userId: student.id,
      language: 'cpp17',
      sourcePath: `submissions/demo/${student.username}-${problemIndex + 1}.cpp`,
      sourceHash: `demo-${student.id}-${problemId}-${problemIndex}`,
      phase: 'contest',
      createdAt: attemptAt,
    });
    finishSubmission(db, submissionId, {
      status: 'finished',
      verdict,
      score,
      timeMs: 20 + Math.floor(random() * 400),
      memoryKb: 1024 + Math.floor(random() * 8192),
      message: '',
    });
    contestSubmissions.push({ id: submissionId, userId: student.id, problemId, verdict, score });

    // 强队选手在最后一段时间再刷一次，制造“最后 AC”和时间分布。
    if (userIndex < 6 && score === 100 && random() < 0.6) {
      const finalId = createSubmission(db, {
        contestId,
        problemId,
        userId: student.id,
        language: 'cpp17',
        sourcePath: `submissions/demo/${student.username}-${problemIndex + 1}-final.cpp`,
        sourceHash: `demo-final-${student.id}-${problemId}-${problemIndex}`,
        phase: 'contest',
        createdAt: attemptAt + 15 * 60_000,
      });
      finishSubmission(db, finalId, {
        status: 'finished',
        verdict: 'AC',
        score: 100,
        timeMs: 18 + Math.floor(random() * 200),
        memoryKb: 1024 + Math.floor(random() * 4096),
        message: '',
      });
      contestSubmissions.push({
        id: finalId,
        userId: student.id,
        problemId,
        verdict: 'AC',
        score: 100,
      });
    }
  });
});

// 赛后订正：4 名选手在 2 道题上补出满分，让订正榜与正式榜产生差异。
const correctionUsers = students.slice(14, 18);
correctionUsers.forEach((student, index) => {
  const problemId = problemIds[index % 2];
  const submissionId = createSubmission(db, {
    contestId,
    problemId,
    userId: student.id,
    language: 'cpp17',
    sourcePath: `submissions/demo/${student.username}-correction-${index + 1}.cpp`,
    sourceHash: `demo-correction-${student.id}-${problemId}`,
    phase: 'correction',
    createdAt: contestEnd + 24 * 3600_000 + index * 60_000,
  });
  finishSubmission(db, submissionId, {
    status: 'finished',
    verdict: 'AC',
    score: 100,
    timeMs: 30 + index * 10,
    memoryKb: 2048 + index * 256,
    message: '',
  });
});

// Hack：一名选手成功 Hack 掉另一名选手的 AC 提交（正式榜显示被 Hack 标记）。
const hackable = contestSubmissions.find(
  (submission) =>
    submission.verdict === 'AC' && submission.userId !== students[0].id,
);
let hackId: number | null = null;
if (hackable) {
  hackId = createHack(db, {
    contestId,
    problemId: hackable.problemId,
    hackerId: students[0].id,
    targetSubmissionId: hackable.id,
    inputPath: 'hacks/readme-demo/1.in',
  });
  updateHack(db, hackId, {
    status: 'success',
    verdict: 'WA',
    message: '演示数据：Hack 成功，目标提交在补充数据上输出错误。',
  });
  db.prepare(
    'UPDATE submissions SET hacked_at = ?, hacked_by = ?, hack_id = ? WHERE id = ?',
  ).run(now - 3 * 24 * 3600_000, students[0].id, hackId, hackable.id);
}

// ---------------------------------------------------------------------------
// 班级与训练计划（班级 = 团队的一种）。
// ---------------------------------------------------------------------------
const classId = createClass(db, {
  name: '2026 级竞赛 A 班',
  ownerId: adminId,
  actorRole: 'admin',
  allowContest: true,
});
const classStudents = students.slice(0, 12);
for (const student of classStudents) {
  insertTeamMember(db, {
    teamId: classId,
    userId: student.id,
    role: 'member',
    joinedAt: now - 30 * 24 * 3600_000,
  });
}

const trainingPlanId = createTrainingPlan(db, {
  groupId: classId,
  title: '国庆集训 · 基础算法巩固',
  description:
    '面向 2026 级竞赛班的国庆专题训练：前缀和、最短路、最近公共祖先与区间众数。完成度按每题最高分与目标分计算。',
  startsAt: now - 6 * 24 * 3600_000,
  endsAt: now + 8 * 24 * 3600_000,
  items: [
    { problemId: problemIds[0], targetScore: 100, dueAt: now - 2 * 24 * 3600_000 },
    { problemId: problemIds[1], targetScore: 100, dueAt: now - 24 * 3600_000 },
    { problemId: problemIds[2], targetScore: 100, dueAt: now + 4 * 24 * 3600_000 },
    { problemId: problemIds[3], targetScore: 100, dueAt: now + 6 * 24 * 3600_000 },
  ],
  actorId: adminId,
  canManageAnyGroup: true,
});

// ---------------------------------------------------------------------------
// 批量评测任务：40 个条目、73% 进度，含失败与跳过明细。
// 只写数据库状态，不创建 judge_tasks，服务端因此不会真的去评测这些演示提交。
// ---------------------------------------------------------------------------
const batchJobId = createBatchJob(db, {
  problemId: problemIds[0],
  studentLevel: 1,
  mode: 'sync',
  status: 'running',
  phase: 'importing',
  createdBy: adminId,
  createdAt: now - 12 * 60_000,
  startedAt: now - 11 * 60_000,
  heartbeatAt: now - 5_000,
  etaSeconds: 90,
  meta: {
    originalName: '2026-10-01-batch-demo.zip',
    progress: { processed: 86, totalCandidates: 120 },
  },
});
const batchSourceSuffixes = ['a.cpp', 'main.cpp', 'solution.cpp'];
students.forEach((student, index) => {
  const suffix = batchSourceSuffixes[index % batchSourceSuffixes.length];
  const sourcePath = `demo/${student.username}/${suffix}`;
  if (index < 20) {
    const submissionId = createSubmission(db, {
      problemId: problemIds[0],
      userId: student.id,
      language: 'cpp17',
      sourcePath: `submissions/batch/${student.username}.cpp`,
      sourceHash: `batch-${student.id}`,
      phase: 'practice',
      batchId: batchJobId,
      createdAt: now - 10 * 60_000 + index * 1000,
    });
    const score = index % 5 === 0 ? 100 : index % 3 === 0 ? 60 : 30;
    finishSubmission(db, submissionId, {
      status: 'finished',
      verdict: score === 100 ? 'AC' : 'WA',
      score,
      timeMs: 15 + index * 3,
      memoryKb: 1024 + index * 64,
      message: '',
    });
    addBatchItem(db, {
      batchId: batchJobId,
      student: student.username,
      sourcePath,
      submissionId,
      problemId: problemIds[0],
      userId: student.id,
      status: 'imported',
    });
    return;
  }
  if (index < 28) {
    const submissionId = createSubmission(db, {
      problemId: problemIds[0],
      userId: student.id,
      language: 'cpp17',
      sourcePath: `submissions/batch/${student.username}.cpp`,
      sourceHash: `batch-queued-${student.id}`,
      phase: 'practice',
      batchId: batchJobId,
      createdAt: now - 10 * 60_000 + index * 1000,
    });
    addBatchItem(db, {
      batchId: batchJobId,
      student: student.username,
      sourcePath,
      submissionId,
      problemId: problemIds[0],
      userId: student.id,
      status: 'imported',
    });
    return;
  }
  if (index < 30) {
    const submissionId = createSubmission(db, {
      problemId: problemIds[0],
      userId: student.id,
      language: 'cpp17',
      sourcePath: `submissions/batch/${student.username}.cpp`,
      sourceHash: `batch-failed-${student.id}`,
      phase: 'practice',
      batchId: batchJobId,
      createdAt: now - 10 * 60_000 + index * 1000,
    });
    finishSubmission(db, submissionId, {
      status: 'failed',
      verdict: null,
      score: 0,
      timeMs: 0,
      memoryKb: 0,
      message: 'demo: judge failed',
    });
    addBatchItem(db, {
      batchId: batchJobId,
      student: student.username,
      sourcePath,
      submissionId,
      problemId: problemIds[0],
      userId: student.id,
      status: 'imported',
    });
    return;
  }
  if (index < 36) {
    addBatchItem(db, {
      batchId: batchJobId,
      student: student.username,
      sourcePath,
      problemId: problemIds[0],
      status: 'error',
      errorCode: index % 2 === 0 ? 'EMPTY_SOURCE' : 'UNSUPPORTED_SOURCE',
      errorMessage: '演示数据：源码为空或语言不受支持',
    });
    return;
  }
  addBatchItem(db, {
    batchId: batchJobId,
    student: student.username,
    sourcePath: 'demo/../escape/invalid.cpp',
    problemId: problemIds[0],
    status: 'skipped',
    errorCode: 'UNSAFE_PATH',
    errorMessage: '演示数据：压缩包路径不安全',
  });
});

// 审计日志：让管理端审计页有真实演示记录（不走 HTTP 也有记录）。
const auditSamples: Array<{ action: string; targetType: string; targetId: string | number }> = [
  { action: 'POST /api/admin/problems/import-zip', targetType: 'problem', targetId: problemIds[0] },
  { action: 'POST /api/admin/contests', targetType: 'contest', targetId: contestId },
  { action: 'POST /api/admin/contests/' + contestId + '/batches', targetType: 'contest', targetId: contestId },
  { action: 'POST /api/admin/batch/run', targetType: 'batch_job', targetId: batchJobId },
  { action: 'PATCH /api/admin/users/' + students[0].id, targetType: 'user', targetId: students[0].id },
];
auditSamples.forEach((sample, index) => {
  recordAudit(db, {
    actorId: adminId,
    action: sample.action,
    targetType: sample.targetType,
    targetId: sample.targetId,
    detail: { demo: true, step: index + 1 },
    ip: '127.0.0.1',
  });
});

const result = {
  dataDir: config.dataDir,
  adminId,
  adminUsername: config.adminUsername,
  problemIds,
  contestId,
  runningContestId,
  classId,
  trainingPlanId,
  batchJobId,
  hackId,
  students,
  generatedAt: now,
};
writeFileSync(join(config.dataDir, 'seed.json'), JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify(result, null, 2));
db.close();
