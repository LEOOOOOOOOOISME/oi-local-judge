# 数据计划（Data Plan）

> 适用版本：1.1+
> 目标：不写脚本，也能配置“生成哪些数据、每个子任务多少点、每点多少分、用什么 seed/参数”。
> 前置阅读：[std / generator 契约](std-generator-contract.md)

---

## 1. 数据计划是什么

数据计划描述：

- 分几个子任务
- 每个子任务生成多少个测试点
- 每个测试点用什么 seed、什么 generator 参数
- 每个子任务/测试点多少分
- 子任务之间是否有依赖
- 时限、内存、输出限制

系统根据计划调用 generator 生成 `.in`，调用 std 生成 `.out`，再跑 validator 和门禁。

---

## 2. 三种配置方式

### 2.1 模板（推荐给新老师）

| 模板 | 适用 | 结构 |
|---|---|---|
| 10/30/60 | 常规题 | 10% 边界/样例，30% 小数据，60% 大数据 |
| 子任务阶梯 | 有部分分 | 每个子任务一组，范围逐级扩大 |
| 极限+随机 | 构造题 | 最小、最大、随机、特殊构造 |
| 只有一组 | 简单题/练习题 | 10~20 个点，均分 |

模板只生成初始计划，出题人可改。

### 2.2 可视化表单

每个子任务一行：

- 名称
- 测试点数
- 分值
- seed 起始值
- generator 参数（键值对）
- 依赖的前置子任务

系统实时显示：

- 总点数
- 总分
- 预计生成时间
- 预计磁盘占用
- 参数是否在题面约束内

### 2.3 JSON 高级模式

```json
{
  "schema": "oijudge.data-plan/1",
  "limits": { "timeMs": 1000, "memoryMb": 256, "outputMb": 64 },
  "groups": [
    {
      "id": "sub1",
      "name": "基础",
      "points": 30,
      "count": 5,
      "seedStart": 1,
      "args": ["--n=10", "--max-v=100"],
      "dependsOn": []
    },
    {
      "id": "sub2",
      "name": "大规模",
      "points": 70,
      "count": 10,
      "seedStart": 1001,
      "args": ["--n=100000", "--max-v=1000000000"],
      "dependsOn": ["sub1"]
    }
  ],
  "pointsMode": "group",
  "naming": "{group}-{index}"
}
```

字段：

| 字段 | 说明 |
|---|---|
| `schema` | 固定 `oijudge.data-plan/1` |
| `limits` | 题目的时间/内存/输出限制 |
| `groups[].id` | 子任务 ID，稳定不变 |
| `groups[].name` | 展示名 |
| `groups[].points` | 子任务分值 |
| `groups[].count` | 测试点数量 |
| `groups[].seedStart` | 起始 seed；第 i 个点用 `seedStart + i` |
| `groups[].args` | 传给 generator 的参数数组，禁止 shell 拼接 |
| `groups[].dependsOn` | 依赖的子任务 ID |
| `pointsMode` | `group` 按子任务给分；`per-test` 逐点给分；`auto` 自动均分 |
| `naming` | 数据文件命名模板 |

约束：

- 所有 `points` 之和 = 题目满分（默认 100）
- `dependsOn` 无环
- `count` 之和不超过预算
- `seedStart + count` 不溢出
- `args` 必须是字符串数组

---

## 3. 自动生成计划

系统根据题面约束和 generator 参数自动给出建议：

1. 从题面/限制中提取 `n`、`m`、值域、子任务
2. 为每个子任务分配 3~10 个点
3. 边界点：最小值、最大值、退化情况
4. 随机点：不同 seed、不同参数
5. 构造点：链、菊花、二分、全相同等（可模板）
6. 分值：子任务均分或按难度递增
7. 给出预计时间/磁盘

出题人必须确认，不能静默采用。

---

## 4. 子任务与依赖

示例：

```text
sub1 基础 (30 分)
  └── sub2 中等 (30 分) 依赖 sub1
        └── sub3 大型 (40 分) 依赖 sub2
```

规则：

- 未通过前置子任务时，后续子任务是否计分可配
- 子任务内的聚合方式：全部通过 / 最小分 / 总分
- 子任务分值之和 = 满分
- 依赖必须无环
- 删除子任务时，依赖它的子任务必须一起处理

---

## 5. 生成与校验流程

```text
for each group:
  for each index:
    seed = seedStart + index
    generator --seed=seed --group=group.id --index=index <args> > case.in
    std < case.in > case.out
    validator < case.in
    record time/memory/size/hash
```

失败时：

- 标红具体 group/index
- 保留日志
- 允许只重跑该点
- 不覆盖已通过的数据，直到新数据通过门禁

---

## 6. 预览与统计

单点：

- 输入/输出前 100 行
- 文件大小、行数、hash
- std 用时/内存
- 子任务、分值、依赖

子任务：

- 点数、总分
- std 最大用时/内存
- 时限/内存余量
- 重复输入数量
- 覆盖率（参数范围）

全局：

- 总点数、总分
- 预计/实际生成时间
- 磁盘占用
- 失败点数
- 门禁状态

---

## 7. 常见问题

### 7.1 生成太慢

- 减少大点数量
- 降低 generator 复杂度
- 把生成放到后台，不要阻塞页面
- 只重跑失败点

### 7.2 数据重复

- 增加 seed 间隔
- 在 generator 中加入 `index` 相关变化
- 检查是否忽略 `--seed`
- 检查是否用了固定随机序列

### 7.3 std 在某个点 TLE

- 看该点参数是否超出题面
- 看 std 复杂度是否达标
- 不要直接放宽时限掩盖 std 问题
- 必要时只重跑该点

### 7.4 没有 validator

- 系统做格式/边界检查
- 显示“语义未校验”警告
- **CF-like 或接受 Hack 的题目：发布/开赛前必须补 validator**
- 普通比赛/练习题：允许发布，但记录风险标记
- 组卷人/比赛管理员可在比赛题目上补充/覆盖 validator，不改原题
- Hack 判定优先使用比赛覆盖，缺失则用题目 validator
- 建议补一个 testlib validator

---

## 8. 相关

- [std / generator 契约](std-generator-contract.md)
- [AI 提示词库](ai-prompts.md)
- [帮助中心](../README.md)
