# Phase 3B 题目包导出/导入结果

日期：2026-11-01
分支：`main`

## 后端

- `GET /api/admin/problems/:id/export`
  - 生成 zip：`problem.json`、`data/*.in|out`、`assets/<kind>/*`（7 类资产源码）
  - manifest 保留标题/类型/难度/时限/内存/IO/题面/samples/visibility/checker/objective/测试点分值/子任务
  - 文件名冲突自动加测试点 id 前缀；路径穿越不导出
- `POST /api/admin/problems/import-zip`（raw zip，≤100MB）
  - 解压到临时目录，自动识别根目录或单层子目录的 `problem.json`
  - 复用 `importProblemDirectory`；支持数据、checker、assets 回填（std/validator/generator/brute/judger 等）
  - 返回 201 `{id}`，失败 400 BAD_ZIP/NO_MANIFEST
- `importProblemDirectory` 新增 manifest `assets` 支持：按 kind 复制并写入 `problem_assets`，checker 自动回填 `checker_path/mode`

## 前端

- 管理端题目列表新增“导入题包”（zip 文件选择、上传、跳转新题）。
- 题目详情页新增“导出题包”（fetch 带 cookie、Blob 下载 `problem-<id>.zip`）。

## 验证

- 新增 `problem-package.test.ts`：导出 → 导入 → 标题/数据/测试点保留（158ms）。
- 全量：**24 个测试文件、84 个用例全部通过**（约 47s）。
- `npm run build` 通过；管理端 chunk 仍懒加载。

## 遗留

1. 未实现 Lemon/Cena/CSP 原生格式互转；当前是 OI Judge 自定义 zip 包（含标准 problem.json）。
2. 导出不含编译产物，导入后需按需重编译；资产语言按扩展名推断。
3. 导入时 `problem.json` 若在多层嵌套目录（>1 层）不会被自动发现。
4. 未做题目包版本号/校验和签名。
