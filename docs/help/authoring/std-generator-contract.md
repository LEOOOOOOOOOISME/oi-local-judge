# std / generator 契约与最小工作流

> 适用版本：1.1+
> 目标：出题人只准备 **题面/限制 + std + generator**，系统完成数据生成、校验与配置。
> 前置阅读：[数据计划](data-plan.md)、[AI 提示词库](ai-prompts.md)

---

## 1. 最小输入是什么

一道传统/文件 IO 题，最少需要：

| 输入 | 是否必需 | 说明 |
|---|---|---|
| 题面 | 必需 | 输入/输出格式、数据范围、子任务、样例 |
| 时间/内存限制 | 必需 | 可以先用模板，后续调整 |
| `std.cpp` | 必需 | 标准程序，用来生成 `.out` 并验证数据 |
| `generator.cpp` | 必需 | 数据生成器，按 seed/子任务生成 `.in` |
| `validator.cpp` | 条件必需 | CF-like 赛制或接受 Hack 的题目必须提供；其他题目建议提供。校验输入是否满足约束；没有它，系统只能做格式检查 |
| `checker.cpp` | 可选 | 多解/SPJ 时需要 |
| `brute.cpp` | 可选 | 对拍/验证 std 时使用 |

> **CF-like 赛制或接受 Hack 的题目必须有 validator**；其他比赛可选。
> 组卷人/比赛管理员可以在比赛题目上补充/覆盖 validator，不必修改原题；Hack 判定优先使用比赛覆盖，缺失则用题目 validator。
> 没有 validator 时，系统只能做格式/边界检查，正式数据存在“语义未校验”风险。

---

## 2. 目录约定

```text
problem/
├── statement.md
├── std.cpp
├── generator.cpp
├── validator.cpp        # CF-like/Hack 必需；其他建议
├── checker.cpp          # 可选
├── brute.cpp            # 可选
└── data-plan.json       # 可由系统生成
```

系统内部保存时会记录：

- 每个文件的 sha256
- 编译器版本与编译参数
- 每个测试点的 seed、group、index、生成时间
- std 的用时/内存/输出大小
- validator 结果
- 数据计划版本

---

## 3. generator 契约

### 3.1 必须满足

- C++17，包含 `testlib.h`
- `registerGen(argc, argv, 1)`
- 支持参数：
  - `--seed=<int>`
  - `--group=<string>`
  - `--index=<int>`
- 只使用 `rnd`，禁止 `rand()`、`random_device`、`time()`、`chrono`
- 只写 stdout，不写文件、不联网、不调用系统命令
- 同一 seed 必须产生完全相同的输出
- 输出必须在题目限制内（大小、行数、数值范围）
- 单点生成时间默认 ≤ 2s；超时视为失败

### 3.2 推荐参数

```cpp
int n = opt<int>("n", 10);
int m = opt<int>("m", 10);
long long maxV = opt<long long>("max-v", 1000000000LL);
int group = opt<int>("group-id", 1);
```

`testlib` 的 `opt<T>` 可以解析 `--n=10` 形式；命令行参数由系统按 argv 传递，不做 shell 拼接。

### 3.3 最小模板

```cpp
#include "testlib.h"
#include <bits/stdc++.h>
using namespace std;

int main(int argc, char* argv[]) {
    registerGen(argc, argv, 1);

    int n = opt<int>("n", 10);
    int maxV = opt<int>("max-v", 1000000000);

    println(n);
    vector<int> a(n);
    for (int i = 0; i < n; ++i) {
        a[i] = rnd.next(1, maxV);
    }
    println(a);

    return 0;
}
```

### 3.4 子任务写法

```cpp
int group = opt<int>("group-id", 1);
if (group == 1) {
    n = rnd.next(1, 10);
} else if (group == 2) {
    n = rnd.next(11, 1000);
} else {
    n = 100000;
}
```

不要根据 `index` 以外的信息改变随机序列；不要把 seed 再叠加时间。

### 3.5 常见错误

| 错误 | 后果 | 修复 |
|---|---|---|
| 用 `rand()` | 同一 seed 输出不稳定 | 改 `rnd.next` |
| 用 `time(0)` | 无法复现 | 删掉，seed 由系统传 |
| 写文件 | 沙箱拒绝/数据错位 | 只写 stdout |
| 输出超限 | OLE/生成失败 | 控制 n、值域、行数 |
| 参数名不一致 | 系统传参无效 | 用 `opt<T>("name", default)` 并写文档 |
| 死循环 | 生成超时 | 加次数上限/构造保证 |

---

## 4. std 契约

### 4.1 必须满足

- C++17（C 题用 C11），标准输入/输出
- 不读写文件、不联网、不调用系统命令
- 不使用随机数、时间、未定义行为
- 使用 `long long`/`__int128` 防溢出
- 复杂度满足题面约束；递归深度可控
- 必须通过样例和所有生成数据
- 运行时间/内存建议 ≤ 限制的 50%

### 4.2 最小模板

```cpp
#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    int n;
    cin >> n;
    vector<long long> a(n);
    for (auto& x : a) cin >> x;

    long long sum = 0;
    for (auto x : a) sum += x;
    cout << sum << '\n';
    return 0;
}
```

### 4.3 常见错误

| 错误 | 后果 | 修复 |
|---|---|---|
| `int` 存 `1e18` | 溢出 WA | 改 `long long`/`__int128` |
| 文件 IO | 与题型不符 | 传统题用 stdin/stdout |
| 递归太深 | RE | 改迭代/加栈 |
| 复杂度过高 | TLE | 优化或改限制（需说明） |
| 输出多余空格/换行 | PE/WA | 按题面格式 |
| 使用 `system("pause")` | 沙箱拒绝/超时 | 删除 |

---

## 5. 推荐工作流

```text
1. 写题面与限制
2. 写 std、generator
3. 编译检查
4. 生成 3~5 个小数据，人工看
5. 写 validator（CF-like/Hack 必需；其他建议）
6. 配置 Data Plan
7. 一键生成 + 校验
8. 看失败点，修 generator/std/validator
9. 预览统计，确认时限/内存
10. 发布
```

### 5.1 先小后大

先让 generator 在 `n=1..10` 跑通，再开大数据。不要把“生成 30 个大点”作为第一次运行。

### 5.2 每次只改一个变量

- 改 generator：先重跑小数据
- 改 std：先跑样例
- 改 validator：先跑边界数据
- 改限制：先看 std 实际用时/内存

### 5.3 失败点重跑

系统应支持：

- 只重跑失败测试点
- 只重跑某个子任务
- 保留其他已通过数据

---

## 6. 质量门禁（发布前）

- [ ] std / generator / validator / checker 编译通过
- [ ] 同一 seed 生成两次 hash 相同
- [ ] 输入非空、UTF-8、行尾规范
- [ ] validator 全部通过（CF-like/Hack 必需；其他建议）
- [ ] std 全部 AC，exit 0
- [ ] std 最大用时 ≤ 时限 × 0.5（超过 0.8 阻断）
- [ ] std 峰值内存 ≤ 内存 × 0.5（超过 0.8 阻断）
- [ ] 输入无重复（重复率 > 10% 阻断）
- [ ] 子任务覆盖、分值、依赖合法
- [ ] 样例与题面一致
- [ ] 生成总时长/磁盘在预算内

---

## 7. 安全边界

- generator/std 都在沙箱中运行，不继承敏感环境变量
- 不自动把出题人代码发给外部 AI
- AI 生成代码必须人工审核
- 不自动发布 AI 生成的数据
- 题包导出保留来源 hash 与生成参数，便于追溯

---

## 8. 相关

- [数据计划](data-plan.md)
- [AI 提示词库](ai-prompts.md)
- [帮助中心](../README.md)
