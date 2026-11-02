# OiJudge 帮助中心

> 这是应用内 `/help` 的内容源，也是出题人的第一入口。
> 目标：让不熟悉命令行的老师，在页面内完成“建题 → 生成数据 → 校验 → 办赛”。

---

## 1. 从这里开始

| 我想… | 看这里 |
|---|---|
| 第一次安装/启动 | `getting-started/install.md`（待写） |
| 1 小时办一场校内赛 | `getting-started/contest-checklist.md`（待写） |
| 建一道题、生成数据 | [std / generator 契约](authoring/std-generator-contract.md) |
| 配置子任务/测试点/分值 | [数据计划](authoring/data-plan.md) |
| 让 AI 帮我写 std/generator | [AI 提示词库](authoring/ai-prompts.md) |
| 看评测状态码 | `judging/verdicts.md`（待写） |
| 建赛/封榜/大屏 | `contest/operations.md`（待写） |
| 批量导入/订正/Hack | `contest/batch-correction-hack.md`（待写） |
| 备份/恢复/诊断 | `system/backup-diagnostics.md`（待写） |
| 团队/共享/权限 | `team/sharing.md`（待写） |

---

## 2. 出题最小路径（推荐）

```text
题面 + 限制
  → std.cpp
  → generator.cpp
  → 数据计划（模板）
  → 一键生成 + 校验
  → 预览
  → 发布
```

强烈建议再提供 `validator.cpp`；**CF-like 赛制或接受 Hack 的题目必须提供**。其他题目没有 validator 时，系统只能做格式/边界检查并标记风险；组卷人/比赛管理员可在比赛题目上补充/覆盖 validator，Hack 优先使用比赛覆盖。

详细步骤：

1. [std / generator 契约](authoring/std-generator-contract.md)
2. [数据计划](authoring/data-plan.md)
3. [AI 提示词库](authoring/ai-prompts.md)

---

## 3. 帮助中心结构

```text
help/
├── README.md
├── getting-started/
│   ├── install.md
│   ├── contest-checklist.md
│   └── roles.md
├── authoring/
│   ├── std-generator-contract.md
│   ├── data-plan.md
│   ├── ai-prompts.md
│   ├── validator-checker.md
│   ├── interactive.md
│   └── failures.md
├── contest/
│   ├── operations.md
│   ├── screen.md
│   ├── batch-correction-hack.md
│   └── announcements.md
├── judging/
│   ├── verdicts.md
│   ├── limits.md
│   └── sandbox.md
├── team/
│   └── sharing.md
├── system/
│   ├── settings.md
│   ├── backup-diagnostics.md
│   ├── https.md
│   └── install-package.md
└── faq/
    └── errors.md
```

每篇文档使用统一 frontmatter：

```yaml
---
title: 数据计划
slug: authoring/data-plan
category: 出题
order: 30
roles: [setter, admin]
routes: [/admin/problems/:id]
tags: [generator, 数据, 子任务]
updated: 2026-11-02
version: 1.1
related: [authoring/std-generator-contract, authoring/ai-prompts]
---
```

---

## 4. 页面内帮助

计划在以下位置提供 `?` / “查看帮助”：

- 新建题目：题型、时限/内存建议
- 上传 std：契约、常见 CE
- 上传 generator：契约、seed、testlib 模板
- 数据计划：模板、子任务、分值
- 生成失败：原因、重跑、重复数据
- 比赛控制台：开始/封榜/结束/补时
- 批量导入：目录层级、answers.json
- 大屏：滚榜/倒计时
- 系统设置：端口/编译器/备份/HTTPS
- 错误码：对应文档锚点

交互：

- `HelpTip`：悬浮/点击显示 2~5 行
- `HelpDrawer`：右侧抽屉看全文，不离开页面
- `HelpLink`：错误信息直接跳转
- `HelpChecklist`：出题/开赛前可勾选

---

## 5. 写作约定

1. 一篇文档只解决一个任务。
2. 开头写“你将完成什么 / 前置条件 / 预计时间”。
3. 步骤可复制；命令/代码块必须完整。
4. 错误信息必须能对应到文档锚点。
5. 截图必须跟版本；过期截图要更新或删除。
6. 不复制 GPL/AGPL 项目内容；引用只放链接。
7. 中文优先；专有名词保留英文（std、generator、validator、SPJ）。

---

## 6. 相关

- [v0.3 需求与出题体验设计](../superpowers/specs/2026-11-02-oi-judge-v0.3-requirements.md)
- [排名与赛制](../ranking.md)
- [比赛批量导入](../batch-import.md)
