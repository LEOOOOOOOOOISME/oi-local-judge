# Phase 3G 比赛公告、加时与删除结果

日期：2026-11-01
分支：`main`

## 后端

- 比赛公告复用社区 posts：`POST /api/posts {category:'announcement',title,body,contestId}`（staff）；`GET /api/posts?contestId=&category=announcement`。
- 参赛者加时/状态：`PUT /api/admin/contests/:id/participants/:userId {extraTime,status}`（秒）。
- 删除比赛：`DELETE /api/admin/contests/:id`；有提交时 409 `HAS_SUBMISSIONS`；无提交时删除 contest_problems/participants/contest。
- 测试：admin-contests 新增加时/删除用例（4 例）。

## 前端

- 管理控制台：
  - “比赛公告”卡片：标题 + Markdown 正文发布；列表显示标题/时间/作者/正文。
  - 参赛者“加时(秒)”行内编辑保存。
  - “删除比赛”Popconfirm；成功后回列表，409 提示“已有提交，无法删除”。
- 选手比赛页“比赛信息”顶部展示公告（bodyHtml，安全渲染），无公告隐藏。
- 公告/加时/删除均懒加载在现有管理 chunk 内。

## 验证

- 全量：**28 个测试文件、90 个用例全部通过**（约 49s）。
- Edge headless（8790 直出 dist）13 项检查 PASS：
  - 管理员发 Markdown 公告 → 选手比赛页可见；
  - 加时 120 秒保存 → 列表/API 回显；
  - 无提交比赛删除成功并回列表；
  - 有提交比赛删除 409 并提示；
  - 0 pageerror/console.error，1366×768 无横向溢出。
- 截图：`.devdata/tmp/screens-3g/01…05*.png`。

## 遗留

1. 公告列表 + 逐篇详情为 N+1 请求（上限 50），本地可接受。
2. 公告无 Markdown 预览；选手端公告 staleTime 10s，需刷新/重进。
3. 加时逐人保存，无批量；删除不级联提交。
4. contestmanager 公告/删除权限未单独 E2E（后端 guard 已覆盖）。
