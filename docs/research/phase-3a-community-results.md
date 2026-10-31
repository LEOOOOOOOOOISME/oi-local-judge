# Phase 3A 社区/答疑/私信/通知结果

日期：2026-11-01
分支：`main`
范围：讨论区、题解审核、公告、比赛答疑、私信、通知、社区管理

## 后端

| 能力 | API |
|---|---|
| 帖子列表/详情 | `GET /api/posts?category=&problemId=&contestId=`、`GET /api/posts/:id`（服务端 markdown-it 渲染，`html:false`） |
| 发帖 | `POST /api/posts`；题解由 contestant 提交为 `pending`，staff 直接发布；公告仅 admin/setter/contestmanager |
| 评论 | `POST /api/posts/:id/comments`；锁定题 403；通知作者 |
| 审核 | `GET /api/admin/posts?status=`、`POST /api/admin/posts/:id/flags`（发布/隐藏/置顶/锁定） |
| 比赛答疑 | `GET/POST /api/contests/:id/clarifications`、`POST /api/admin/contests/:id/clarifications/:cid/answer` |
| 私信 | `GET /api/messages/conversations`、`GET/POST /api/messages/:userId` |
| 通知 | `GET /api/notifications`、`POST /api/notifications/read` |
| 限流 | 发帖 5/min、评论 20/min、私信 20/min、答疑 10/min（内存桶，429） |

- 表：posts/comments/clarifications/messages/notifications。
- 通知在评论、答疑回答、私信时写入；私信读取会标记已读。
- 帖子正文存储 Markdown 原文，读取时渲染；脚本标签被转义，未执行。

## 前端

- 导航新增“讨论”“消息”，登录后通知铃铛（未读数、点击标已读、面板跳转）。
- `/discuss`：讨论/题解/公告 Tab；发帖 Modal（分类/标题/Markdown/可选题目或比赛）；选手题解提示待审核。
- `/discuss/:id`：正文/评论/回复；staff 置顶/锁定/隐藏；私信作者。
- `/admin/posts`：待审核/公开/隐藏列表，通过/隐藏、置顶/锁定，原始 Markdown 查看。
- `/messages`：会话列表/未读/线程/发送，按 `?userId=` 直达。
- 比赛页新增页面级 Tabs“比赛信息 / 答疑”：选手提问、staff 回答并选择公开。
- 所有新页面懒加载；CommunityAdminRoute 权限。

## 验证

- 后端：`community.test.ts` 4 例（发帖/安全 Markdown/评论通知、题解审核、答疑通知、私信会话）。
- 全量：**23 个测试文件、83 个用例全部通过**（约 49s）。
- Edge headless 三上下文（admin/Alice/Bob）23 项检查 PASS：
  - 发帖→评论→通知未读→标已读跳转；
  - 置顶/锁定；锁定后禁止评论；
  - 题解 pending→审核通过→公开；
  - 私信会话/线程；
  - 比赛答疑提问→公开回答→可见；
  - XSS `<script>` 被转义，0 pageerror/console.error，1366×768 无横向溢出。
- 截图：`.devdata/tmp/screens-3a/01…08*.png`。

## 遗留

1. 通知打开铃铛统一全部已读，未做逐条已读。
2. 私信无用户搜索选择器（可用“私信作者”或用户 ID 直达）。
3. 公告分类 UI 仅 staff 可见，E2E 未发公告。
4. 审核隐藏动作、私信/答疑通知逐条点击未单独 E2E。
5. 帖子无分页/搜索/附件/举报；题解无点赞/采纳。
6. 社区限流为进程内存桶，重启清零；未做持久化审计日志。
