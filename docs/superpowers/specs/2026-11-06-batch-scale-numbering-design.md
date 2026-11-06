# 大规模批量评测、题目映射与洛谷式题号设计

日期：2026-11-06  
状态：待评审  
范围：批量评测（5000 人 × 4 题）、多核并发策略、成绩导出、题目映射界面、文件/标准 IO、题号分类、题目附件

## 1. 背景

现有系统已支持单题/多题批量导入和异步评测，但面向 4000–5000 人的批量上传存在确定性问题。

### 1.1 现场证据

用户提供的数据目录：

```text
D:\Desktop\LEO\c++\code\gen\2\3\Sdata-self\A\source
```

实测：

```text
学生目录：1,505
文件总数：10,876
.cpp：10,868
.py：8
源目录总大小：470.19 MB
有效嵌套“学生/题目”组合：5,438
```

题目文件夹：

```text
crystal
hub
migrate
subway
```

不是 `S-1/S-2/S-3/S-4`，需要手动映射到 CSP-S2026 顺序。

对应 ZIP：

```text
A.zip = 263,075,481 字节 ≈ 250.9 MB
```

最大单文件：

```text
SH-S01313/migrate.cpp
227,326,588 字节 ≈ 216.8 MB
```

### 1.2 已确认的 500 原因

1. 前端 `MAX_UPLOAD_BYTES = 80 MB`，`A.zip` 250.9 MB，上传被前端拒绝。
2. 后端管理员源码上限 64 MB，216.8 MB 文件触发 `source is too large`。
3. `admin-batch.ts` 的导入循环没有逐文件错误隔离，一条异常导致整个请求 500。
4. 用户已在工作区做未提交修改：全局 body parser 10 GB、批量/题目上传 10 GB、管理员源码 64 MB、回退用户逻辑。这些修改保留，但需要改为流式与逐条隔离。
5. `unzipSync` 一次性解压整个 ZIP，250 MB 包存在内存峰值。
6. 每个新学生 `scryptSync`，1505 次会阻塞事件循环。
7. 用户/提交/batch_item 逐行 INSERT，无大事务；评测 worker 同时写 SQLite。

### 1.3 当前 IO 能力

现有 `problems.io_mode` 已支持：

```text
stdio -> 使用 stdin/stdout
file  -> 复制输入到 input_file，读取 output_file
```

因此 `cin/cout` 和 `freopen` 都能支持，但必须按题目配置，不能自动识别源码。

## 2. 目标与非目标

### 目标

- 5000 学生 × 4 题 = 20,000 份提交可导入、可恢复、可分页、可导出。
- 单条异常（超大源码、坏文件夹、编译失败）不影响整批。
- 管理员可配置多核评测并发。
- 服务端导出 CSV / Excel / HTML，含长表和学生×题目矩阵。
- 保留现有“学生层级/题目层级”检索机制，增加可视化映射工作区。
- 题目按分类前缀独立编号，旧题迁入 P，从 P1001 开始。
- 题目支持附件。

### 非目标

- 不承诺 1000 人“同时提交”在 4C8G 上完成；按 1000 注册、低峰值提交设计。
- 不做分布式多机评测。
- 不做 LemonLime 的桌面端完整复刻。
- 不做自动识别源码 `freopen`。
- 不自动下载/安装更新。

## 3. 已确认决策

| 项目 | 决策 |
|---|---|
| 批量规模 | 5000 学生 × 4 题，20,000 提交 |
| 时限 | 不设硬时限；4C8G 可接受较长时间 |
| 在线规模 | 1000 注册，低峰值提交；只配置多核策略 |
| 批量方式 | 后台异步任务 |
| 管理员单文件源码上限 | 512 MiB，可配置 |
| 学生单文件源码上限 | 256 KiB |
| 管理员 ZIP 上限 | 5 GB，流式 |
| 题号 | 分类前缀 + 独立序号；旧题迁入 P，从 P1001 |
| 旧题顺序 | 按内部 id 升序 |
| 管理员题号 | 可新增分类/前缀，可手动改题号 |
| 文件 IO | 每道题配置 stdio/file |
| 导出 | CSV 长表 + Excel + HTML，含矩阵 |
| 附件 | 题目可见即可下载；PDF/图片/ZIP；单文件 50 MB |
| 映射 | 按选中题目顺序批量绑定 + 手动改 |
| 无效学生 | 丢弃并列出，不阻塞整批 |

## 4. 架构

### 4.1 批量上传与解析

新增 `batch_uploads`：

```text
batch_uploads
  id, upload_id, original_name, zip_path, size_bytes,
  entry_count, total_uncompressed_bytes,
  created_by, created_at, expires_at
```

流程：

```text
POST /api/admin/batch/uploads
  Content-Type: application/zip
  流式写入 data/uploads/batch/<uploadId>.zip
  Content-Length 预检
  磁盘剩余空间预检
  计算 sha256

解析（后台或预览时）
  使用 fflate Unzip 流式解压
  只落盘到临时目录，不整包读入内存
  路径安全校验：拒绝绝对路径、..、符号链接
  条目上限、总解压大小上限、单文件上限
  返回文件清单/树/统计
```

限制：

```text
maxBatchZipBytes = 5 GB
maxBatchFiles = 200,000
maxBatchUncompressedBytes = 10 GB
maxBatchFileBytes = 512 MiB
```

超过限制的条目标记为 `skipped`，不终止整包。

### 4.2 预览与题目映射

保留现有 `studentLevel` / `problemLevel`，新增预览接口：

```text
GET /api/admin/batch/uploads/:id/preview?studentLevel=1&problemLevel=2
```

返回：

```text
treeSample: 前 N 层路径样例
students: 去重后的学生名
problemFolders: 题目文件夹
invalidStudents: 缺源码/命名异常/空目录
duplicates: 重复学生-题目
maxDepth
validCount
```

映射工作区：

```text
文件夹        题目
crystal  ->  [搜索题目] S-1
hub      ->  [搜索题目] S-2
migrate  ->  [搜索题目] S-3
subway   ->  [搜索题目] S-4
```

能力：

- 按选中题目顺序批量绑定
- 手动单条修改
- 题目来源：个人 / 团队 / 公共
- 搜索：题号 / 标题 / 标签
- 未映射不允许开始
- 显示无效学生和跳过原因
- 预览“学生 × 题目 = 提交数”
- 文件结构图按当前层级动态展示

新增题目选择接口：

```text
GET /api/admin/problems/picker?scope=personal|team|public&query=&limit=
```

### 4.3 异步导入与评测

```text
POST /api/admin/batch/uploads/:id/run
  202 { jobId }
```

请求：

```json
{
  "studentLevel": 1,
  "problemLevel": 2,
  "problemMap": { "crystal": 101, "hub": 102, "migrate": 103, "subway": 104 }
}
```

后台任务状态：

```text
uploaded -> importing -> queued -> judging -> finished
                                    -> failed
                                    -> canceled
```

导入规则：

- 先解析并校验全部学生/题目映射，再入库。
- 每 500 条一个事务：
  - 复用/创建合成学生 `batch_<student>`
  - 合成学生密码只哈希一次，禁止每个学生 scrypt
  - 创建 submission
  - 创建 judge_task，优先级 batch=10
  - 创建 batch_item
- 单条失败：
  - 记录 `error_code` / `error_message`
  - 继续下一条
  - 不抛整批 500
- `batch_items` 增加：

```text
status: pending|imported|skipped|error
error_code, error_message
```

- 进度分页：

```text
GET /api/admin/batch/:id?offset=&limit=&status=
```

不再一次返回 20,000 items。

### 4.4 多核并发

```text
judgeConcurrency
  默认 min(8, 逻辑核数)
  最小 1
  最大 逻辑核数
  超过核数：UI 警告，不静默超卖
  批量优先级 10，低于在线 50/100
```

这是多个 g++/ojrunner 子进程并发，不是 Node worker_threads。

1000 在线按“1000 注册、低峰值提交”验收；同时提交仍会排队。

### 4.5 成绩导出

```text
GET /api/admin/batch/:id/export?format=csv
GET /api/admin/batch/:id/export?format=xlsx
GET /api/admin/batch/:id/export?format=html
```

- CSV：流式写长表
- XLSX：`exceljs` WorkbookWriter
- HTML：流式模板，可打印
- 长表列：

```text
学生, 题号, 题目, 状态, Verdict, 得分,
用时, 内存, 通过测试点, 总测试点
```

- Excel：
  - Sheet1 长表
  - Sheet2 学生×题目矩阵
  - Sheet3 题目统计
- 20,000 行不整体加载到浏览器。

### 4.6 文件 IO / 标准 IO

题目字段：

```text
io_mode: stdio | file
input_file: string | null
output_file: string | null
```

规则：

- `stdio`：stdin 输入，stdout 比较
- `file`：复制输入到 `input_file`，读取 `output_file`
- 批量提交不改变题目配置
- 题目编辑页明确显示两种模式
- 测试覆盖：
  - `cin/cout`
  - `freopen("xxx.in", "r", stdin)`
  - `freopen("xxx.out", "w", stdout)`
  - 文件缺失 -> WA/FAIL，不整批失败

不自动检测源码 `freopen`；同一题混用两种写法时按题目配置执行。

### 4.7 洛谷式题号

```text
problem_categories
  id, code, name, next_seq, seq_start, created_at

problems
  id（内部主键不变）
  category_id
  seq
  display_id
  UNIQUE(category_id, seq)
  UNIQUE(display_id)
```

规则：

- 旧题全部迁入 P，按 id 升序生成 P1001…
- 不建 L 分类
- 管理员可新增分类/前缀
- 管理员可手动指定某题 display_id
- 自动编号按分类独立递增
- 删除不复用号
- URL 同时接受内部 id 和 display_id
- 批量题目文件夹同时接受 `P1001` 和数字 id
- 旧 `/problems/:id` 永久兼容

API：

```text
GET  /api/admin/problem-categories
POST /api/admin/problem-categories
PATCH /api/admin/problem-categories/:id
POST /api/admin/problems/:id/display-id
GET  /api/problems/:idOrDisplayId
```

### 4.8 题目附件

```text
problem_attachments
  id, problem_id, filename, storage_path,
  size_bytes, mime, visibility, created_by, created_at
```

- 单文件 50 MB
- PDF / 图片 / ZIP
- 题目可见即可下载
- 不暴露真实路径
- 管理员/出题人上传、删除、替换
- 附件下载走鉴权 API，不静态暴露

## 5. 数据模型汇总

新增：

```text
batch_uploads
batch_items.status/error_code/error_message
problem_categories
problems.category_id/seq/display_id
problem_attachments
```

设置项：

```text
maxSourceKbContestant = 256
maxSourceKbSetter = 65536
maxSourceKbAdmin = 524288
maxBatchFileKb = 524288
maxBatchZipMb = 5120
judgeConcurrency = min(8, cores)
```

## 6. 错误处理

新增错误码：

```text
BATCH_ZIP_TOO_LARGE
BATCH_DISK_FULL
BATCH_ENTRY_LIMIT
BATCH_FILE_TOO_LARGE
INVALID_STUDENT_FOLDER
NO_SOURCE_FOR_STUDENT
UNMAPPED_PROBLEM
SOURCE_TOO_LARGE
BATCH_IMPORT_PARTIAL
BATCH_IMPORT_FAILED
BATCH_CANCELED
```

原则：

- 上传/解析失败：返回具体错误码
- 单条导入失败：记录 item error，继续
- 整批失败：job failed + 错误摘要
- 不再只返回“服务器内部错误”

## 7. 兼容与迁移

- 保留现有 `/api/admin/batch/upload` 作为兼容入口，内部转新流程。
- 现有题目/提交/比赛引用不动内部 id。
- 旧题迁移只新增 P 题号，不重写 URL。
- 现有 `io_mode` 默认 stdio，不改变已有题目行为。
- 现有手动 CSV 导出保留，新增服务端导出。
- 用户未提交的 10GB body / 64MB admin / 回退逻辑保留，重构为流式与逐条隔离。

## 8. 验收

### 真实数据

- `A.zip` 250.9 MB 可上传（流式，不整包内存）。
- 预览识别 1505 学生、5438 有效提交、4 个题目文件夹。
- 216.8 MB 文件：
  - 管理员上限 512 MB 时允许导入；
  - 编译慢/失败只影响该条；
  - 不导致整批 500。
- 无效学生文件夹：丢弃并列出。
- 5000×4 合成数据：20,000 提交，分页进度，不 OOM。
- 4C8G 上并发 4，可接受长时间完成；不设硬时限。

### 功能

- 个人/团队/公共题目搜索
- 按顺序批量绑定
- 手动改映射
- CSV/Excel/HTML 导出
- 长表 + 矩阵
- P1001 迁移
- 管理员新增分类/手动改号
- 附件上传/下载/权限
- `cin/cout` 和 `freopen` 两种 IO
- 1000 注册、低峰值提交

## 9. 实施阶段

### P0：止血

- 逐文件 catch
- 超大源码 skipped
- 无效文件夹丢弃
- 前端 80 MB 限制改掉
- 具体错误码
- 修复 `db` 未定义回退分支

### P1：异步批量 + 映射工作区

- 流式上传/解压
- 后台导入
- 批量事务
- 分页进度
- 可视化映射
- 个人/团队/公共搜索
- 顺序绑定
- CSV/Excel/HTML

### P2：多核配置

- judgeConcurrency
- 默认核数
- 上限/警告
- batch 优先级

### P3：题号 + 附件

- 分类表
- P1001 迁移
- 管理员手动改号
- 附件表/上传/下载

### P4：LemonLime 对齐

- 测试全部/未测试/选中
- 重测失败/编译错误
- Subtask Skip
- 统计分布/标准差/区分度
- HTML 成绩单

## 10. 风险

1. 5000×4 在 4C8G 上约数小时；不设硬时限。
2. 512 MB 源码可能编译超时/吃内存；逐条失败，不整批失败。
3. SQLite 单写者；批量导入必须分批事务，避免与评测写锁冲突。
4. 5 GB ZIP 需要磁盘配额和临时目录清理。
5. 1000 人同时提交不保证；只保证低峰值注册在线。
6. 旧题 P1001 迁移后，外部系统若使用旧数字 id 仍兼容。
