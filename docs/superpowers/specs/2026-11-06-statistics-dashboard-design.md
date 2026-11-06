# 比赛统计仪表盘与 PDF 报告设计

日期：2026-11-06  
状态：待评审  
范围：比赛统计优先，组件复用到班级/训练

## 1. 背景

用户希望：

- 优化 UI
- 降低大批量数据打开的卡顿
- 自带数据可视化分析

实测 `A/statistics.html`：

```text
大小：139,346 字节 ≈ 136 KB
表格：9 个
行数：442 行
```

它是聚合后的分数分布表，不是 1505 行明细。该文件本身不应造成明显卡顿。  
应用内真正的问题在：

```text
ContestRankingPage
  Table pagination={false}
  1505 行 × 多列
```

因此本设计同时做：

1. 应用内比赛统计仪表盘
2. 浏览器打印生成 PDF
3. 虚拟滚动/服务端分页
4. 服务端聚合，图表不再接收原始明细

## 2. 已确认决策

| 项目 | 决策 |
|---|---|
| 交付形态 | 应用内仪表盘 + PDF |
| HTML 导出 | 不再作为最终交付；旧 statistics.html 仅作参考 |
| PDF | 浏览器打印为 PDF，不引入服务端 PDF 库 |
| 图表 | ECharts，按路由懒加载 |
| 范围 | 比赛优先，组件复用到班级/训练 |
| 表格 | 1505 虚拟滚动；5000 服务端分页 |
| 自动分析 | 有，进入 PDF |
| 样本量提示 | 不显示文字提示 |
| ACM/CF | 通过题数/罚时；不做分数分布 |
| 封榜 | 严格封榜口径，解封后更新 |
| PDF 结构 | 两个 PDF：分析报告 + 完整个人成绩 |
| 个人成绩范围 | 全部可见参赛者；管理员可含隐藏 |
| 入口 | 比赛公开页 + 管理控制台 |
| 性能目标 | 1505 人首屏 <1s，滚动 60fps |

## 3. 数据接口

新增比赛统计聚合：

```text
GET /api/contests/:id/statistics
```

返回：

```ts
interface ContestStatistics {
  contest: { id; title; mode; preset; frozen: boolean; generatedAt };
  summary: {
    participants: number;
    submissions: number;
    avgScore: number;
    medianScore: number;
    stddev: number;
    maxScore: number;
    minScore: number;
    fullScoreCount: number;
    zeroScoreCount: number;
  };
  distribution: Array<{ from: number; to: number; count: number }>;
  cumulative: Array<{ score: number; count: number; ratio: number }>;
  problems: Array<{
    problemId: number;
    title: string;
    fullScore: number;
    avgScore: number;
    medianScore: number;
    stddev: number;
    acRate: number;
    fullRate: number;
    zeroRate: number;
    difficulty: number;
    discrimination: number;
    distribution: Array<{ from: number; to: number; count: number }>;
  }>;
  groups: Array<{
    name: string;
    participants: number;
    avgScore: number;
    fullRate: number;
  }>;
  insights: string[];
}
```

规则：

- 使用正式榜/封榜口径，与排名页一致。
- 隐藏选手不进入公开统计；管理员统计可传 `includeHidden=1`。
- 不返回 1505 行原始成绩给图表。
- 结果按比赛版本/封榜时间缓存，默认 1–5 秒。
- ACM/CF 模式使用通过题数/罚时；不硬套分数直方图。

## 4. 前端仪表盘

路由：

```text
/contests/:id/statistics
```

也可作为比赛详情/管理控制台的“统计”Tab 复用同一组件。

布局：

```text
Header：比赛名 / 冻结状态 / 刷新 / 导出 PDF

KPI 卡：
  参赛人数 / 提交数 / 平均分 / 中位数 / 标准差 / 满分人数 / 0 分人数

第一行：
  总分分布直方图 + 累计曲线
  分数段环形图（0–99 / 100–199 / 200–299 / 300–400）

第二行：
  每题得分分布（每题一个小图）

第三行：
  难度/区分度条形图
  班级/团队对比

第四行：
  成绩表（虚拟滚动 / 服务端分页）
```

### 图表

- ECharts core + Bar/Line/Pie/Scatter 按需 import
- 路由 lazy load，首屏不加载图表库
- `ResizeObserver` 自适应
- 空数据/小样本显示空状态，不画误导图
- tooltip 带人数/占比

### 成绩表

- <5000 行：`virtual` + 固定高度，保留搜索/筛选
- ≥5000 行：服务端分页，默认 100/页
- 固定列、稳定 rowKey、memo columns
- 搜索防抖
- 不把 20,000 行一次塞进 DOM

### 性能

- 服务端聚合
- 图表与表格分 chunk
- Skeleton，避免布局抖动
- `content-visibility: auto` / `contain` 可选
- 首屏 <1s（1505 人，目标机）
- 滚动 60fps

## 5. 自动分析

规则：

- 平均分、中位数、标准差
- 满分人数、0 分人数
- 每题材平均分/AC 率/满分率
- 难度 = 平均分 / 满分
- 区分度 = 前 27% 均分 − 后 27% 均分
- 最薄弱题、区分度最高/最低题
- 班级/团队对比

不显示“样本不足”提示文案。  
样本不足时直接不计算该指标，返回 `null`，图表和文案都不展示，避免误导。

## 6. PDF

浏览器打印，两个独立入口：

```text
分析报告：/contests/:id/statistics?print=analysis -> window.print()
个人成绩：/contests/:id/statistics?print=results -> window.print()
```

### 分析报告 PDF

- 隐藏导航、筛选、按钮
- 图表固定尺寸，等待 ECharts 渲染完成
- KPI + 图表 + 自动分析
- 班级/团队汇总
- 不包含完整 1505 行成绩表

### 个人成绩 PDF

- 全部可见参赛者
- 排名、选手、班级、总分、每题得分
- 管理员可选择包含隐藏选手
- 表头分页重复
- 不混入分析图表
- 人数很多时允许分页/按班级分册

不引入服务端 Chromium/PDF 库。

## 7. 复用

同一 `StatisticsDashboard` 组件：

- 比赛：分数/通过题数/罚时
- 班级：成员、完成度、薄弱标签
- 训练：计划完成率、逾期、得分分布

后端按资源分别聚合，前端只换 DTO 映射。

## 8. 实施阶段

### S1：比赛统计聚合 + 仪表盘

- 后端 `/api/contests/:id/statistics`
- KPI、分布、累计、每题、班级/团队
- ECharts 懒加载
- 虚拟表格

### S2：PDF 打印

- print 路由
- 打印样式
- 图表等待/分页
- Top 50 表格

### S3：班级/训练复用

- 班级统计聚合
- 训练完成度聚合
- 复用图表组件

### S4：性能与验收

- 1505 首屏 <1s
- 5000 分页
- Playwright 性能冒烟
- 关闭旧 statistics.html 导出（保留参考）

## 9. 已确认

1. ACM/CF 做通过题数/罚时，不做分数分布。
2. 公开统计严格使用封榜口径，解封后更新。
3. PDF 拆成两个：
   - 分析报告 PDF：KPI、图表、自动分析、班级/团队汇总。
   - 个人成绩 PDF：全部可见参赛者；管理员可含隐藏。
4. 自动分析不显示样本提示；样本不足时指标置空。
5. 入口同时放在比赛公开页和管理控制台。
6. 不再生成 statistics.html；旧文件仅作参考。
