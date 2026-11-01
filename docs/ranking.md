# 排名与赛制

本文件是应用内 `/help` 的内容源之一，也是 Phase A 排名引擎的规则说明。

## 预设

| preset | 排序 | 默认并列 |
|---|---|---|
| `oi` | 每题最高分求和，降序 | 总分相同同名次 |
| `ioi` | 子任务/总分求和，降序 | 总分相同同名次 |
| `acm` | 过题数降序 → 罚时升序 → 最后 AC 升序 | 三项相同同名次 |
| `cf-like` | 分数降序 → 罚时升序 → 最后 AC 升序 | 三项相同同名次 |

`cf-like` 不是 Codeforces 的精确复刻：它使用可配置时间衰减和罚时，不含 hack 分。

## 罚时

- ACM：首次 AC 的相对分钟数 + 该题首次 AC 前错误提交数 × 20。
- CF-like：同 ACM。

## 封榜

- 比赛状态为 `frozen` 时，榜单隐藏题目得分/总分（按配置）。
- 封榜期间提交正常评测，但不计入正式榜；批量导入不能发布。
- 解封时回填冻结期的 OI 正式分。

## 归档

- 比赛结束不等于冻结；管理员点“归档”才冻结正式榜。
- 归档后禁止批量发布、名单变更、在线正式分更新，正式榜只读。

## Hack 与 CF-like

- 锁题后才能查看同题他人源码、发起 Hack；锁题后本题不能再提交。
- Hack 输入先过 validator（如有），再用 std 生成期望输出，最后用题目 checker 判定目标代码。
- 目标 AC → Hack 失败；WA/TLE/RE 等 → Hack 成功，目标提交标记 HACKED。
- HACKED 提交从正式分剔除，并按剩余提交重算；没有剩余提交时回退已发布批量分。
- CF-like 成功 Hack `+100` 分、失败 Hack `-50` 分，可用 `cfLike.hackPoints / cfLike.failedHackPenalty` 配置。
- 锁题/Hack 窗口 = 比赛结束时间 + `hackWindowMinutes`；超时拒绝。
- 管理员可对 failed/queued Hack 强制晋升。

## 自定义插件

- 排名配置 `preset` 可写 `plugin:<name>`。
- 插件是已编译 `.mjs`，由管理员上传，重启服务生效。
- 插件模块必须导出：
  ```js
  export const apiVersion = 1;
  export function compute(input) {
    // 返回 [{ rank, userId, totalScore, solved, penalty, lastAcAt, cells }]
  }
  ```
- 插件是可信代码，等同服务器权限；不要上传不可信来源。
- 插件缺失/禁用时回退 OI 并在响应中带 `pluginError`。

## 正式分

- OI 正式分保存在 `contest_official_scores`：在线赛中提交 + 已发布批量导入。
- 在线提交只升不降；批量导入按模式：覆盖/合并/仅补缺。
- 批量草稿不影响正式榜。
