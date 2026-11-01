# Phase A：可配置排名引擎 + 比赛批量正式导入 设计

- 日期：2026-11-01
- 状态：待评审
- 对应需求：`requirement.txt`（赛制/榜单/批量/封榜/审计）
- 前置调研：`docs/research/phase-3i-multi-batch-results.md`
- 本阶段范围：正式榜排名引擎、比赛批量正式导入、参赛名单、正式榜页面
- 明确不在本阶段：赛后订正、完整 CF hack、客观题/提交答案题批量、CF 精确公式

---

## 1. 目标与边界

### 1.1 目标

让老师能够：

1. 创建一场 OI 比赛并组卷；
2. 收集选手本地代码目录，按“学生/题目/源码”层级批量上传；
3. 自动匹配学生与题目，先预览、再发布；
4. 正式榜同时反映赛中网页提交与老师批量导入的成绩；
5. 在比赛页查看正式榜，支持 OI/IOI/ACM/CF-like 排名与并列规则；
6. 任意时间追加参赛名单、隐藏参赛者、归档后冻结正式榜。

### 1.2 非目标

- 不做赛后订正页与订正提交（Phase B）
- 不做 CF hack（Phase C）
- 不做客观题/提交答案题的 `answers.json` 批量（Phase B）
- 不做 Codeforces 精确计分复刻（先做 CF-like 可配置策略）
- 不允许 ACM/CF 比赛使用批量导入或订正
- 不做 WebSocket 榜单重构；复用现有轮询/推送能力

---

## 2. 已确认规则

| 主题 | 规则 |
|---|---|
| 正式榜来源 | 批量导入 + 赛中网页提交 |
| 批量格子更新 | `overwrite` 只更新批次出现的格子；`merge` 逐格取 max；`fill` 只填空格 |
| 批量流程 | 草稿落库 → 预览 → 发布/丢弃；发布前不影响正式榜 |
| 批量未知用户 | 跳过并报告 |
| 参赛名单 | 任意时间追加；未知用户跳过并报告；只认已注册用户 |
| 移除参赛者 | 从正式榜隐藏，成绩保留；重新加入恢复 |
| 批量用户 | 已知用户自动补报名；不建号 |
| 批量题目类型 | Phase A 仅代码题：传统/文件 IO/交互 |
| 批量赛制 | 仅 OI |
| 正式榜冻结 | 比赛结束不冻结；管理员“归档”才冻结 |
| 发布后在线提交 | 新赛时在线提交仍可提高正式分，除非比赛已归档 |
| 并列默认 | OI/IOI 同分同名；ACM 过题数→罚时→最后 AC；CF-like 分数→罚时→最后 AC |
| 自定义插件 | 编译为 JS；管理员上传；重启生效；不热加载 |
| 帮助文档 | 应用内 `/help` + 仓库 docs |
| 归档 | 归档后批量发布、名单变更、在线正式分更新全部停止 |

---

## 3. 数据模型

### 3.1 新增/修改表

```sql
-- 正式分格子（OI 正式榜）
CREATE TABLE contest_official_scores (
  id INTEGER PRIMARY KEY,
  contest_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  problem_id INTEGER NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  verdict TEXT NOT NULL DEFAULT 'WA',
  source TEXT NOT NULL,              -- 'online' | 'batch'
  batch_id INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(contest_id, user_id, problem_id)
);

-- 批量批次（status/problem_id/student_level 已存在）
ALTER TABLE batch_jobs ADD COLUMN contest_id INTEGER;
ALTER TABLE batch_jobs ADD COLUMN mode TEXT;               -- overwrite/merge/fill
ALTER TABLE batch_jobs ADD COLUMN problem_level INTEGER;
ALTER TABLE batch_jobs ADD COLUMN problem_map_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE batch_jobs ADD COLUMN created_by INTEGER;

-- 批次条目
ALTER TABLE batch_items ADD COLUMN score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE batch_items ADD COLUMN verdict TEXT;
ALTER TABLE batch_items ADD COLUMN time_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE batch_items ADD COLUMN memory_kb INTEGER NOT NULL DEFAULT 0;

-- 提交阶段
ALTER TABLE submissions ADD COLUMN phase TEXT NOT NULL DEFAULT 'contest';
ALTER TABLE submissions ADD COLUMN batch_id INTEGER;

-- 参赛者隐藏
ALTER TABLE contest_participants ADD COLUMN hidden_at INTEGER;

-- 排名配置
ALTER TABLE contests ADD COLUMN ranking_rule_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE contests ADD COLUMN archived_at INTEGER;

-- 自定义插件
CREATE TABLE ranking_plugins (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  js_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL
);
```

说明：

- `batch_jobs.problem_id` 对多题批次写 `0`，兼容现有表结构。
- `batch_items.problem_id` 已有；Phase A 补齐 score/verdict。
- `submissions.phase='batch_draft'` 的批量草稿提交不进入任何公共列表与正式榜；发布时改为 `contest`，丢弃时保持草稿并标记批次 discarded。
- 正式分只存“格子”，不存每题的多次尝试；尝试明细仍在 submissions/test_results。

### 3.2 索引

- `contest_official_scores(contest_id, user_id)`
- `contest_official_scores(contest_id, problem_id)`
- `batch_jobs(contest_id, status)`
- `submissions(contest_id, phase, created_at)`

---

## 4. 正式分更新

### 4.1 OI 正式分初始化

- 比赛为 OI 且正式榜首次被读取/首次发布批量时：
  - 扫描该比赛 `phase='contest'` 的在线提交；
  - 按题目取最高分；同分取更好的 verdict；
  - 写入 `contest_official_scores`（source='online'）。
- 非 OI 比赛不建正式分表，正式榜直接由提交与排名策略计算。

### 4.2 在线提交更新

- 比赛状态为 running/frozen，且提交是赛时提交：
  - OI：`official = max(existing, new)`；更新 source='online'。
  - 封榜期间：保持现有封榜行为，不把冻结窗口内的提交计入正式分；解封后补算。
  - 归档后：不再更新。
- 非 OI：不写正式分表，排名策略直接消费 submissions。

> Phase A 采用简单封榜策略：封榜期间 **禁止批量发布**（后端 409），避免“批量无时间戳”和“封榜时间窗”叠加产生不可解释的分数。管理员可先解封再发布。

### 4.3 批量发布

在一个 SQLite 事务内：

1. 校验批次状态为 `ready`、比赛为 OI、比赛未归档、未处于 frozen。
2. 对每个 `batch_items`：
   - 用户不存在 → 跳过并报告（草稿阶段已标记）；
   - 用户存在但未报名 → 自动加入 `contest_participants`；
   - `overwrite`：直接写格子；
   - `merge`：`max(existing, batch)`；
   - `fill`：仅当格子不存在时写入。
3. 将对应 submissions 从 `batch_draft` 改为 `contest`。
4. 批次状态改为 `published`，写审计 `batch.publish`。
5. 返回发布摘要与最终正式榜链接。

### 4.4 草稿与丢弃

- 上传后创建 batch_jobs(status='draft') 与 batch_items；逐项生成 `batch_draft` 提交并评测。
- 全部评测结束 → status='ready'。
- 预览只读：展示每个格子的 `current -> after` 与未知用户、未映射题目、重复源文件。
- 丢弃：status='discarded'；草稿提交保留审计，但不进入公共列表；不删除文件。
- 草稿不会更新 `contest_official_scores`。

---

## 5. 排名引擎

### 5.1 接口

```ts
export interface RankingStrategyInput {
  contest: ContestRow;
  problems: ContestProblemRow[];
  participants: UserRow[];
  submissions: SubmissionRow[];       // 已按可见性过滤
  officialScores: OfficialScoreRow[]; // OI 使用
  config: RankingConfig;
  now: number;
}

export interface RankingStrategy {
  name: string;
  compute(input: RankingStrategyInput): RankingResult;
}
```

`RankingResult`：

- `rows: [{ rank, userId, totalScore, solved, penalty, lastAcAt, cells }]`
- `cells: [{ problemId, score, verdict, attempts, firstAcAt }]`
- `meta`: 策略名、是否封榜、隐藏列信息

### 5.2 内置策略

| 策略 | 排序 | 并列 |
|---|---|---|
| OI | 正式分总和 desc | 同分同名 |
| IOI | 子任务总分 desc | 同分同名 |
| ACM | 过题数 desc → 罚时 asc → 最后 AC asc | 三项相同同名次 |
| CF-like | 分数 desc → 罚时 asc → 最后 AC asc | 三项相同同名次 |

CF-like Phase A：

- 题分按 `maxPoints * (1 - decay * elapsed / contestDuration)` 计算，`decay` 可配（默认 0.5）；
- 不含 hack 分；hack 在 Phase C 接入。
- 不声称与 Codeforces 当前实现逐点一致。

### 5.3 配置

`contests.ranking_rule_json`：

```json
{
  "preset": "oi",
  "tie": "same-rank",
  "freeze": { "mode": "hide-scores", "applyToBatch": false },
  "cfLike": { "decay": 0.5 },
  "visibility": { "showPerProblem": true, "showAttempts": true }
}
```

- 预设：oi/ioi/acm/cf-like/plugin:<name>
- 并列：same-rank / none / custom
- 封榜：hide-scores / freeze-all
- 自定义插件：`plugin:my-strategy`；插件缺失时回退到 OI 并告警，不阻塞主流程。

### 5.4 插件

- 管理员上传**已编译** `.mjs`，不允许直接上传 TS。
- 服务端计算 sha256，写入 `runtime/plugins/` 与 `ranking_plugins`。
- 重启服务后加载；不热加载。
- 插件接口版本化（`apiVersion: 1`）；加载失败记录审计并禁用。
- 管理员上传即视为可信代码，文档明确风险。

### 5.5 封榜

- 沿用现有 `freeze_at/unfreeze_at` 与比赛状态。
- 封榜期间：
  - 在线提交正常评测；
  - 正式榜隐藏题目得分/总分（按配置）；
  - 禁止批量发布（Phase A 限制）。
- 解封后重算/显示。
- 归档后正式榜只读。

---

## 6. 批量导入流程

### 6.1 文件结构

```text
Alice/1/main.cpp
Alice/3/main.cpp
Bob/1/main.cpp
Bob/3/main.cpp
```

- 学生层级、题目层级由管理员选择。
- 题目文件夹自动匹配优先级：
  1. 数字且等于题目 ID；
  2. 归一化标题（去空格/大小写）；
  3. 比赛顺序字母 A/B/C/D；
  4. 仍未匹配 → 人工映射。
- 同一学生/题目多个源文件：取字典序第一个；其余在预览中提示忽略。
- 仅接受 `.cpp/.cc/.cxx`；`answers.json` 不属于 Phase A。
- 未知用户名：跳过并在预览/发布摘要中报告。
- 非比赛题目：拒绝并报告。

### 6.2 API

```text
POST   /api/admin/contests/:id/batches
       raw zip; query: studentLevel, problemLevel; body/query problemMap
       -> batchId, status=draft

GET    /api/admin/contests/:id/batches/:batchId
       -> 批次、条目、未知用户、未映射、评分状态

POST   /api/admin/contests/:id/batches/:batchId/preview
       {mode} -> 每格 current/after/diff、摘要

POST   /api/admin/contests/:id/batches/:batchId/publish
       {mode} -> 发布摘要

POST   /api/admin/contests/:id/batches/:batchId/discard
```

并行扩展：

```text
POST /api/admin/contests/:id/participants/import
     {csv} -> {added, skipped, errors}
PATCH /api/admin/contests/:id/participants/:userId
     {hidden:boolean}
GET /api/contests/:id/official-ranking
GET /api/admin/ranking-plugins
POST /api/admin/ranking-plugins
```

### 6.3 名单 CSV

- 第一列用户名；支持表头 `username`；忽略空行。
- 只追加；未知用户名跳过并返回清单。
- 已是参赛者：跳过。
- 不创建账号。
- 管理员/赛事管理员可操作；写审计。

### 6.4 隐藏参赛者

- PATCH hidden=true → `hidden_at=now`。
- 正式榜/订正榜（Phase B）都不显示。
- 成绩、提交、批量条目保留。
- hidden=false 恢复显示。
- 归档后禁止修改。

---

## 7. 前端

### 7.1 比赛控制台

- 新增“批量导入”入口，跳转 `/admin/contests/:id/batch`。
- 显示批次列表：draft/ready/published/discarded、模式、创建人、时间。
- 参赛名单：CSV 导入、隐藏/恢复。

### 7.2 批量导入页

- 选择比赛（预填）→ 自动带出全部题目。
- 上传 zip；学生层级/题目层级。
- 映射表：仅显示未自动匹配的文件夹，支持一次全局选择/批量指定。
- 预览：学生/题目/分数/当前→发布后/未知用户/未映射/重复文件。
- 模式选择：覆盖/合并/仅补缺。
- 发布/丢弃；发布后跳正式榜。

### 7.3 正式榜

- 路由：`/contest/:id/ranking` 改为调用 `official-ranking`；旧 `/ranking` API 保留兼容。
- 列：名次、选手、班级、总分、各题、罚时/AC 数（按策略）、封榜标识。
- 归档后显示“已归档/只读”。
- 大屏/CSV 复用正式榜数据与策略。

### 7.4 帮助

- `/help` 页面：赛制、并列、封榜、批量导入、名单、归档、插件。
- 内容源：`docs/ranking.md` 与 `docs/batch-import.md`，构建时静态注入。

---

## 8. 兼容与迁移

- 新表/列用 `ensureColumn` 增量迁移。
- 现有比赛：
  - `ranking_rule_json` 默认 `{preset:'oi',tie:'same-rank'}`；
  - 旧 `/api/contests/:id/ranking` 保留；
  - 新正式榜首次读取时初始化 OI 正式分。
- 现有批量评测（非比赛）保留原 API/页面；比赛批量使用新 contest 接口。
- 旧 `batch_jobs` 数据 `contest_id` 为 NULL，不参与正式榜。

---

## 9. 测试计划

1. 单元：
   - OI/IOI/ACM/CF-like 排序、并列、罚时；
   - 三种批量模式的逐格行为；
   - 正式分初始化和在线更新；
   - 名单追加、未知跳过、隐藏/恢复。
2. 集成：
   - 上传草稿不改变正式榜；
   - 预览 current→after；
   - 发布事务成功/失败回滚；
   - 批量 + 在线混合；
   - 未知用户跳过；
   - 封榜禁止发布；
   - 归档后只读。
3. 性能：
   - 300 学生 × 8 题批量：评测吞吐、预览查询、发布事务 ≤ 2s；
   - 500 行正式榜计算 ≤ 300ms。
4. 浏览器：
   - 1366×768；批量上传/预览/发布；正式榜；名单导入；归档。

---

## 10. 风险

1. 批量草稿复用 submissions 会污染公共列表，必须严格按 phase 过滤。
2. 正式分表与在线提交双写可能不一致；所有写入口必须走同一服务函数。
3. 冻结窗口与批量发布语义复杂，Phase A 直接禁止冻结期发布。
4. 插件是可信代码执行；上传必须仅 admin、审计、重启生效。
5. ACM/CF 与批量互斥需要在 API 与 UI 双重校验。
6. 300×8 批量评测会长时间占用评测槽；需要批次进度与取消机制（Phase A 至少支持丢弃未发布批次）。

---

## 11. 验收标准

- 老师上传多题 zip → 自动匹配 → 预览 → 发布 → 正式榜出现批量分。
- 赛中在线提交与批量分按模式合并，且可解释。
- 草稿/丢弃不影响正式榜。
- 名单追加、未知跳过、隐藏/恢复正确。
- OI/IOI/ACM/CF-like 榜单与并列规则可配置。
- 归档后正式榜只读。
- 全量测试/构建通过，1366×768 无横向溢出。
