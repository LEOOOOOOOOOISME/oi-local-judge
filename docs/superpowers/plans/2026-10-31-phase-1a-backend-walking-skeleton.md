# Phase 1A 后端评测闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可在 CLI 下跑通的后端闭环：登录 → 题库 → 提交 → 评测（编译/沙箱/比较/SPJ/子任务）→ 结果/榜单。

**Architecture:** Fastify 单体服务（`apps/server`），node:sqlite 持久化，复用 Phase 0 的 `ojrunner.exe` 与 checker；`packages/shared` 放 DTO 与 OI 榜单纯函数；WS 推送评测事件。

**Tech Stack:** Node 24、TypeScript、Fastify 5、node:sqlite、Vitest、C++17 runner（已就绪）。

**Spec:** `docs/superpowers/specs/2026-10-31-oi-judge-design.md`

## Global Constraints

- 4 核/8G 性能预算；评测并发默认 2。
- 所有 SQL 参数化、索引覆盖；列表 keyset 分页。
- 不引入 GPL/AGPL 代码；testlib.h 保留 MIT 声明。
- 密码 scrypt；会话 HMAC；写操作 CSRF（Phase 1 可先留接口）。
- 每个任务 TDD，测试通过后提交；不改 Phase 0 已通过的 runner/checker 行为。

---

### Task 1: 共享 DTO 与 OI 榜单（已完成）

**Files:** `packages/shared/src/domain.ts`、`ranking.ts`、`ranking.test.ts`、`index.ts`

**Interfaces:**
- `UserDto`、`ProblemSummaryDto`、`ProblemDetailDto`、`SubmissionDto`、`TestResultDto`
- `computeOiRanking({problemIds,userIds,submissions,freezeAt?}): RankingRow[]`

- [x] 已实现并通过 3 个单测。

---

### Task 2: 配置、迁移与仓储

**Files:**
- Create: `apps/server/src/config.ts`
- Create: `apps/server/src/storage/migrate.ts`
- Create: `apps/server/src/storage/repos/users.ts`、`problems.ts`、`submissions.ts`、`contests.ts`、`judge.ts`
- Test: `apps/server/tests/migrate.test.ts`

**Interfaces:**
- `loadConfig(env?): Config`，字段：`port`、`host`、`dataDir`、`judgeConcurrency`、`gxx`、`adminPassword`、`sessionSecret`
- `migrate(db: DatabaseSync): void`：幂等建表 + `schema_migrations`
- 仓储函数（全部同步，接收 `DatabaseSync`）：
  - `createUser/getUserByUsername/getUserById`
  - `createProblem/getProblem/listProblems`
  - `createSubmission/getSubmission/listSubmissions`
  - `createJudgeTask/claimNextTask/finishJudgeTask`
  - `createContest/getContest/listContests`

**Schema（migration 0001，节选必须精确）**

```sql
CREATE TABLE users(
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  real_name TEXT, class_name TEXT, role TEXT NOT NULL DEFAULT 'contestant',
  status TEXT NOT NULL DEFAULT 'active', session_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE problems(
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL,
  difficulty INTEGER, tags_json TEXT NOT NULL DEFAULT '[]', time_ms INTEGER NOT NULL,
  memory_mb INTEGER NOT NULL, io_mode TEXT NOT NULL DEFAULT 'stdio',
  input_file TEXT, output_file TEXT, statement_html TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public', version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE problem_testcases(
  id INTEGER PRIMARY KEY, problem_id INTEGER NOT NULL, ordinal INTEGER NOT NULL,
  input_path TEXT NOT NULL, output_path TEXT NOT NULL, points INTEGER NOT NULL,
  subtask_id INTEGER, depends_on TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(problem_id) REFERENCES problems(id) ON DELETE CASCADE
);
CREATE TABLE problem_subtasks(
  id INTEGER PRIMARY KEY, problem_id INTEGER NOT NULL, name TEXT NOT NULL,
  points INTEGER NOT NULL, aggregation TEXT NOT NULL DEFAULT 'min',
  FOREIGN KEY(problem_id) REFERENCES problems(id) ON DELETE CASCADE
);
CREATE TABLE submissions(
  id INTEGER PRIMARY KEY, contest_id INTEGER, problem_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL, language TEXT NOT NULL, source_path TEXT NOT NULL,
  source_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
  verdict TEXT, score INTEGER NOT NULL DEFAULT 0, time_ms INTEGER NOT NULL DEFAULT 0,
  memory_kb INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, judged_at INTEGER
);
CREATE INDEX idx_submissions_user ON submissions(user_id, created_at DESC);
CREATE INDEX idx_submissions_contest ON submissions(contest_id, user_id, created_at DESC);
CREATE TABLE test_results(
  submission_id INTEGER NOT NULL, testcase_id INTEGER NOT NULL, verdict TEXT NOT NULL,
  time_ms INTEGER NOT NULL, memory_kb INTEGER NOT NULL, score INTEGER NOT NULL,
  message TEXT NOT NULL DEFAULT '', PRIMARY KEY(submission_id, testcase_id)
);
CREATE TABLE judge_tasks(
  id INTEGER PRIMARY KEY, submission_id INTEGER NOT NULL UNIQUE,
  priority INTEGER NOT NULL DEFAULT 50, status TEXT NOT NULL DEFAULT 'queued',
  worker TEXT, attempts INTEGER NOT NULL DEFAULT 0, heartbeat_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_judge_tasks_claim ON judge_tasks(status, priority DESC, id);
CREATE TABLE contests(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'oi',
  start_at INTEGER, end_at INTEGER, freeze_at INTEGER, unfreeze_at INTEGER,
  status TEXT NOT NULL DEFAULT 'draft', rules_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE contest_problems(
  contest_id INTEGER NOT NULL, problem_id INTEGER NOT NULL, ordinal INTEGER NOT NULL,
  points INTEGER NOT NULL, PRIMARY KEY(contest_id, problem_id)
);
```

- [ ] **Step 1: 写失败测试**：临时库 `migrate` 两次，断言表存在、二次不报错、索引存在。
- [ ] **Step 2: 跑测试失败**。
- [ ] **Step 3: 实现 `migrate` + `loadConfig` + 仓储最小函数**。
- [ ] **Step 4: 跑测试通过**。
- [ ] **Step 5: 提交** `feat: add config, migrations and repositories`。

---

### Task 3: 认证与权限（可并行）

**Files:**
- Create: `apps/server/src/security/password.ts`、`session.ts`、`auth.ts`
- Create: `apps/server/src/services/auth.ts`
- Create: `apps/server/src/http/auth.ts`
- Test: `apps/server/tests/auth.test.ts`

**Interfaces:**
- `hashPassword(password): string`（scrypt，格式 `scrypt$N$r$p$salt$hash`）
- `verifyPassword(password, stored): boolean`
- `signSession({userId,version}, secret, ttlSec): string`、`verifySession(token, secret): {userId,version} | null`
- `POST /api/auth/login` body `{username,password}` → `{ok,data:{user}}` + `Set-Cookie: oij.sid`
- `GET /api/me` → `{ok,data:{user,permissions}}`
- `POST /api/auth/logout` → 清 Cookie、version+1
- `requireAuth`/`requireRole(role)` Fastify preHandler

- [ ] **Step 1: 测试**：hash 不等于明文且 verify 通过；错误密码 false；签名 token 可验证、篡改/过期失败；login（种子用户）返回 Cookie；未登录 `/api/me` 401。
- [ ] **Step 2-5**：实现、测试、提交。

---

### Task 4: 题库导入与读取 API

**Files:**
- Create: `apps/server/src/services/problems.ts`
- Create: `apps/server/src/http/problems.ts`
- Create: `apps/server/tests/problems.test.ts`
- Create: `tools/seed/sample-problem/`（`problem.json`、`data/1.in`、`data/1.out` 等）

**problem.json 结构**

```json
{
  "title": "A+B Problem", "type": "standard", "difficulty": 1, "tags": ["入门"],
  "timeMs": 1000, "memoryMb": 64, "ioMode": "stdio",
  "statement": "# A+B\n输入两个整数，输出和。",
  "testcases": [
    {"input": "data/1.in", "output": "data/1.out", "points": 50},
    {"input": "data/2.in", "output": "data/2.out", "points": 50}
  ]
}
```

**API**
- `GET /api/problems` → 列表（id/title/type/difficulty/tags/limits）
- `GET /api/problems/:id` → 详情（含服务端渲染的题面 HTML、样例、测试点数量，不暴露数据路径）
- `POST /api/admin/problems/import`（multipart 目录 zip 或服务端路径）→ 导入、复制数据到 `dataDir/problems/<id>/`
- `POST /api/admin/problems/:id/publish`

- [ ] **Step 1: 测试**：导入 sample 目录后列表有 1 题、详情含题面；选手接口不返回 `data/` 路径；导入两次产生两个题目 ID（或按标题去重需显式参数）。
- [ ] **Step 2-5**：实现、测试、提交。

---

### Task 5: 评测流水线（可并行）

**Files:**
- Create: `apps/server/src/judge/scheduler.ts`、`compiler.ts`、`pipeline.ts`、`subtask.ts`
- Modify: `apps/server/src/storage/repos/judge.ts`、`submissions.ts`
- Test: `apps/server/tests/judge.test.ts`

**Interfaces:**
- `startScheduler({db, config, hub}): {stop(): Promise<void>}`
- `judgeSubmission({db, config, submissionId, hub}): Promise<void>`
- `compileSource({gxx, sourcePath, outExe, workdir, language}): {ok, message}`
- `aggregateSubtask(results: TestResultDto[], subtasks: SubtaskRow[]): number`

**行为**
- 取任务：`judge_tasks` 中 `status='queued'` 按 `priority DESC, id`；claim 置 `running`；最多 `judgeConcurrency` 个。
- 编译：`g++ -O2 -std=c++17 -static -o prog.exe main.cpp`（可配置）；失败写入 CE，`verdict='CE'`，结束。
- 逐测试点：临时目录 → `runSandboxed`（timeMs/memoryMb）→ 判定 verdict：
  - timedOut → TLE；oom/peak 超限 → MLE；非 0 → RE；否则比较/SPJ。
  - 内置精确比较（stdout 文件 vs answer）；忽略行尾空白。
  - SPJ：`runChecker({mode, checker, input, output, answer, fullScore: points})`；score 映射。
- 子任务：按 subtask 聚合（min 或 sum），总分为各测试点/子任务之和；依赖未通过则 SK。
- 落库：单事务写 `test_results` + 更新 `submissions(status='finished',verdict,score,time_ms,memory_kb,judged_at)`；失败 `failed` + SE。
- 事件：每完成一个提交，`hub.publish({type:'submission.updated', ...})`。

- [ ] **Step 1: 测试**：用 seed A+B 题与内置比较；提交 AC 代码 → AC 100；错误代码 → WA 0；死循环 → TLE；CE 代码 → CE；进程/临时目录清理。
- [ ] **Step 2-5**：实现、测试、提交。

---

### Task 6: 提交 API + 记录 + WS

**Files:**
- Create: `apps/server/src/http/submissions.ts`
- Create: `apps/server/src/realtime/hub.ts`
- Modify: `apps/server/src/app.ts`、`cli.ts`
- Test: `apps/server/tests/submissions.test.ts`

**接口**
- `POST /api/submissions` body `{problemId, language, code, contestId?}`；校验大小（≤256KB）、语言、题目可见性；落源码文件；返回 `{id, status:'queued'}`。
- `GET /api/submissions/:id`：本人或管理员；含测试点结果（按可见性）。
- `GET /api/submissions?userId=me|:id&problemId=&page=&limit=`：keyset 分页。
- `POST /api/submissions/:id/rejudge`（权限）：重置任务。
- WS `/ws` 登录后订阅 `user:<id>` 与 `admin`；事件 `submission.updated`。

- [ ] **Step 1: 测试**：登录后提交 → 202/200；轮询/WS 收到 finished；未登录 401；他人提交 403；超长代码 413。
- [ ] **Step 2-5**：实现、测试、提交。

---

### Task 7: 比赛与榜单 API

**Files:**
- Create: `apps/server/src/services/contests.ts`、`ranking.ts`
- Create: `apps/server/src/http/contests.ts`
- Test: `apps/server/tests/contests.test.ts`

**接口**
- `POST /api/admin/contests` 创建（name/mode/startAt/endAt/freezeAt/problemIds）
- `POST /api/admin/contests/:id/start|freeze|end`
- `GET /api/contests`、`GET /api/contests/:id`
- `GET /api/contests/:id/ranking`：读取参赛者与提交，调用 `computeOiRanking`；封榜按 `freezeAt`；返回 `RankingRow[]` + 用户名/班级拼接。

- [ ] **Step 1: 测试**：建赛 + 2 人提交 → 榜单顺序正确；封榜后隐藏封榜后提交；解封恢复；非参赛者不出现。
- [ ] **Step 2-5**：实现、测试、提交。

---

### Task 8: Seed + E2E + 性能冒烟

**Files:**
- Create: `tools/seed/seed.ts`（或 `.mjs`）
- Create: `tests/e2e/backend-flow.test.ts`
- Modify: `package.json` scripts

**行为**
- `npm run seed`：创建 admin（用户名/密码来自 env，默认 admin/admin123 并打印警告）、导入 sample problem、创建示例比赛。
- E2E：启动 `buildApp`（临时数据目录）→ 登录 → 拉题 → 提交 AC 代码 → 轮询至 finished → 断言 AC/100 → 拉榜单。
- 性能冒烟：50 次提交排队，断言无丢失、最终全部 finished（可标记 slow，默认跳过）。

- [ ] **Step 1: 测试/E2E**。
- [ ] **Step 2-4: 实现、跑通、提交**。

---

## Self-Review

- 覆盖：需求 M01（认证）、M02（题库）、M03（评测）、M04（比赛/榜单）、M05（后端 API）、M14（持久化）；前端与 Electron 在 Phase 1B。
- 不包含：客观题、交互题、社区、查重、大屏、PDF（后续计划）。
- 类型一致性：`Verdict`/`SubmissionDto`/`RankingRow` 来自 `@oij/shared`；仓储返回 DTO。
- 风险：judge 并发与 SQLite 写入需在 Task 8 压测；SPJ 路径复用 Phase 0 结论。
