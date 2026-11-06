# 项目进度

> 每轮结束时更新本文件，并先提交代码。提交说明写清“做了什么、为什么、边界”。

## 2026-11-06 / Round 138（统计仪表盘设计）

### 本轮产出

- 新增 `docs/superpowers/specs/2026-11-06-statistics-dashboard-design.md`。
- 实测 `statistics.html`：136 KB、9 个表格、442 行；该文件本身不是 1505 行明细。
- 确认卡顿主要来源是应用内 `ContestRankingPage` 的 `pagination={false}` 全量表格。
- 方案：服务端聚合 + ECharts 按需加载 + 1505 虚拟滚动 / 5000 服务端分页 + 浏览器打印 PDF。
- 不再把 `statistics.html` 作为最终交付；旧文件保留作参考。
- 自动分析进入 PDF；不显示样本量提示，样本不足时指标置空。

### 待确认

1. ACM/CF 首版是否只做通过题数/罚时，不做分数分布。
2. 公开统计是否严格使用封榜口径。
3. PDF 表格只打印 Top 50 是否可接受。
4. 样本不足时指标置空（不显示提示）是否接受。

### 下一步

- 确认后先做 S1：比赛统计聚合接口 + 仪表盘 + 虚拟表格。
- S2：浏览器打印 PDF。
- S3：班级/训练复用。

## 2026-11-06 / Round 137

### 本轮提交

- `816e7c0 fix: harden large batch uploads and admin source limits`
- `f31c43c docs: add large batch and numbering design`

### 已完成

1. **确认 4000 人批量 500 的现场原因**
   - 用户数据目录 `D:\Desktop\LEO\c++\code\gen\2\3\Sdata-self\A\source`：
     - 1,505 个学生目录
     - 10,876 个文件
     - 470.19 MB
     - 5,438 个有效“学生/题目”组合
   - `A.zip` 250.9 MB，超过前端 80 MB 限制。
   - `SH-S01313/migrate.cpp` 216.8 MB，超过后端 64 MB 管理员源码限制。
   - 批量循环没有逐文件 catch，一条异常导致整批 500。
   - `unzipSync` 整包解压、逐行 INSERT、逐学生 scrypt、`getBatchJob` 一次返回全部 items 是后续风险。

2. **保留并修复用户未提交的批量上传修改**
   - 全局 body parser 10 GB。
   - 批量/题目上传 10 GB。
   - 管理员源码上限从 64 MB 提升到 512 MiB。
   - 批量支持 `.c` -> `c11`。
   - 空 ZIP 条目跳过。
   - 修复回退分支中未定义的 `db`（改为 `options.db`）。
   - 修复被破坏的注释字符。
   - 说明：10 GB body 仍是“整包读入 Buffer”，P1 必须改为流式。

3. **设计规格**
   - 新增 `docs/superpowers/specs/2026-11-06-batch-scale-numbering-design.md`。
   - 覆盖：异步批量、流式 ZIP、题目映射工作区、多核并发、CSV/Excel/HTML、标准/文件 IO、P1001 题号、题目附件。

### 验证

- `npx tsc -p apps/server/tsconfig.json --noEmit`：通过。
- `npx vitest run apps/server/tests/admin-batch.test.ts apps/server/tests/submissions.test.ts`：2 文件 / 4 用例通过。
- 工作树：干净（不含临时 `.bak`）。

### 已确认决策

| 项目 | 决策 |
|---|---|
| 批量规模 | 5000 学生 × 4 题 = 20,000 提交 |
| 时限 | 不设硬时限 |
| 在线 | 1000 注册、低峰值提交；只配置多核 |
| 批量方式 | 后台异步任务 |
| 管理员源码 | 512 MiB，可配置 |
| 学生源码 | 256 KiB |
| ZIP 上限 | 5 GB，流式 |
| 题号 | 分类前缀 + 独立序号；旧题迁 P，从 P1001 |
| 旧题顺序 | 内部 id 升序 |
| 文件 IO | 每题配置 stdio/file |
| 导出 | CSV 长表 + Excel + HTML，含矩阵 |
| 附件 | 题目可见即可下载；PDF/图片/ZIP；50 MB |
| 映射 | 按选中题目顺序批量绑定 + 手动改 |
| 无效学生 | 丢弃并列出，不阻塞整批 |

### 下一步

**P0 止血**

- 逐文件 catch，一条失败不影响整批。
- 超大源码标记 skipped。
- 无效学生文件夹丢弃并列出。
- 前端 80 MB 限制改掉，上传流式化。
- 具体错误码，不再统一“服务器内部错误”。
- 修复 `getBatchJob` 一次返回全部 items。

**P1 异步批量 + 映射**

- 流式上传/解压。
- 后台分批导入（500/事务）。
- 合成学生只哈希一次密码。
- batch 优先级低于在线提交。
- 分页进度/取消/重试。
- 文件结构预览。
- 个人/团队/公共题目搜索。
- 顺序绑定 + 手动映射。
- 服务端 CSV/Excel/HTML + 学生×题目矩阵。

**P2/P3/P4**

- P2：`judgeConcurrency` 配置、默认核数、上限/警告。
- P3：P1001 分类题号、管理员手动改号、题目附件。
- P4：LemonLime 对齐（全部/未测试/选中、重测失败、Subtask Skip、统计分布、HTML 成绩单）。

### 已知限制

- 10 GB body 仍是 Buffer，P1 改流式。
- 5000×4 在 4C8G 上可能数小时；已接受不设硬时限。
- 1000 人同时提交不保证；只保证 1000 注册、低峰值。
- 216.8 MB 源码即使允许，也可能编译慢/失败；必须逐条隔离。
- 当前 Release 仍为 `v1.1.0-rc.6`。
