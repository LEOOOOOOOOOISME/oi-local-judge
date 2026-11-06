import type { DatabaseSync } from 'node:sqlite';
import type { Writable } from 'node:stream';
import ExcelJS from 'exceljs';
import {
  getBatchItemStats,
  getBatchJob,
  type BatchJobRow,
} from '../storage/repos/batches.js';

/**
 * Batch result export.
 *
 * The long table is read page by page (keyset pagination on `batch_items.id`)
 * and serialized one row per chunk, so a 5000-row batch never has to exist as a
 * single string in memory. CSV and HTML are async generators consumed by a
 * Readable; XLSX is written through exceljs' streaming WorkbookWriter.
 */

/** Rows fetched per keyset page while streaming the long table. */
export const BATCH_EXPORT_PAGE_SIZE = 500;

export const BATCH_EXPORT_COLUMNS = [
  '学生',
  '题号',
  '题目',
  '状态',
  'verdict',
  '得分',
  '用时(ms)',
  '内存(KB)',
  '通过测试点',
  '总测试点',
] as const;

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  compiling: '编译中',
  running: '评测中',
  finished: '已完成',
  failed: '评测失败',
  canceled: '已取消',
  missing: '缺失',
  skipped: '已跳过',
  error: '导入失败',
};

export function batchExportStatusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

export interface BatchExportRow {
  student: string;
  problemId: number | null;
  /** Display id (P1001) when numbered, otherwise `#<id>`, otherwise empty. */
  problemLabel: string;
  problemTitle: string;
  /** Resolved submission/missing/error/skipped status code. */
  status: string;
  verdict: string | null;
  score: number;
  timeMs: number;
  memoryKb: number;
  passedTests: number;
  totalTests: number;
  errorCode: string | null;
}

interface LongTableSqlRow {
  item_id: number;
  student: string;
  problem_id: number | null;
  problem_title: string | null;
  problem_display_id: string | null;
  import_status: string | null;
  submission_id: number | null;
  submission_status: string | null;
  verdict: string | null;
  score: number | null;
  time_ms: number | null;
  memory_kb: number | null;
  passed_tests: number | null;
  total_tests: number | null;
  error_code: string | null;
}

function problemLabel(problemId: number | null, displayId: string | null): string {
  if (displayId) return displayId;
  return problemId === null ? '' : `#${problemId}`;
}

function resolveRowStatus(row: {
  submission_id: number | null;
  submission_status: string | null;
  import_status: string | null;
}): string {
  if (row.submission_id !== null) return row.submission_status ?? 'missing';
  if (row.import_status === 'skipped') return 'skipped';
  if (row.import_status === 'error') return 'error';
  return 'missing';
}

function mapLongTableRow(row: LongTableSqlRow): BatchExportRow {
  return {
    student: row.student,
    problemId: row.problem_id,
    problemLabel: problemLabel(row.problem_id, row.problem_display_id),
    problemTitle: row.problem_title ?? '',
    status: resolveRowStatus({
      submission_id: row.submission_id,
      submission_status: row.submission_status,
      import_status: row.import_status,
    }),
    verdict: row.verdict,
    score: Number(row.score ?? 0),
    timeMs: Number(row.time_ms ?? 0),
    memoryKb: Number(row.memory_kb ?? 0),
    passedTests: Number(row.passed_tests ?? 0),
    totalTests: Number(row.total_tests ?? 0),
    errorCode: row.error_code,
  };
}

/**
 * Long-table rows in insertion order, fetched in bounded pages. The fallback
 * problem id covers legacy single-problem batches whose items have no
 * `problem_id`; multi-problem jobs store `problem_id = 0` and rely on the item.
 */
export async function* iterateBatchExportRows(
  db: DatabaseSync,
  batchId: number,
  pageSize = BATCH_EXPORT_PAGE_SIZE,
): AsyncGenerator<BatchExportRow> {
  const job = getBatchJob(db, batchId);
  if (!job) return;
  const fallbackProblemId = job.problem_id > 0 ? job.problem_id : 0;
  const limit = Math.max(1, Math.floor(pageSize));
  const page = db.prepare(
    `SELECT bi.id AS item_id,
            bi.student AS student,
            COALESCE(bi.problem_id, ?) AS problem_id,
            bi.status AS import_status,
            bi.submission_id AS submission_id,
            bi.error_code AS error_code,
            s.status AS submission_status,
            s.verdict AS verdict,
            s.score AS score,
            s.time_ms AS time_ms,
            s.memory_kb AS memory_kb,
            p.title AS problem_title,
            p.display_id AS problem_display_id,
            (SELECT COUNT(*) FROM test_results tr
              WHERE tr.submission_id = bi.submission_id) AS total_tests,
            (SELECT COUNT(*) FROM test_results tr
              WHERE tr.submission_id = bi.submission_id AND tr.verdict = 'AC') AS passed_tests
       FROM batch_items bi
       LEFT JOIN submissions s ON s.id = bi.submission_id
       LEFT JOIN problems p ON p.id = COALESCE(bi.problem_id, ?)
      WHERE bi.batch_id = ? AND bi.id > ?
      ORDER BY bi.id
      LIMIT ?`,
  );
  let lastId = 0;
  for (;;) {
    const rows = page.all(
      fallbackProblemId,
      fallbackProblemId,
      batchId,
      lastId,
      limit,
    ) as unknown as LongTableSqlRow[];
    if (rows.length === 0) return;
    for (const row of rows) {
      lastId = row.item_id;
      yield mapLongTableRow(row);
    }
    if (rows.length < limit) return;
    // Keep the event loop responsive while a long export is being consumed.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// Student × problem matrix
// ---------------------------------------------------------------------------

export interface BatchMatrixProblem {
  id: number;
  label: string;
  title: string;
}

export interface BatchMatrixCell {
  score: number;
  verdict: string | null;
  status: string;
}

export interface BatchMatrix {
  students: string[];
  problems: BatchMatrixProblem[];
  /** Keyed by `${student}\u0000${problemId}`; latest item wins. */
  cells: Map<string, BatchMatrixCell>;
}

function matrixKey(student: string, problemId: number): string {
  return `${student}\u0000${problemId}`;
}

export function buildBatchMatrix(db: DatabaseSync, batchId: number): BatchMatrix {
  const job = getBatchJob(db, batchId);
  if (!job) return { students: [], problems: [], cells: new Map() };
  const fallbackProblemId = job.problem_id > 0 ? job.problem_id : 0;
  const problems = db
    .prepare(
      `SELECT COALESCE(bi.problem_id, ?) AS problem_id,
              p.display_id AS display_id,
              p.title AS title
         FROM batch_items bi
         LEFT JOIN problems p ON p.id = COALESCE(bi.problem_id, ?)
        WHERE bi.batch_id = ? AND COALESCE(bi.problem_id, ?) > 0
        GROUP BY COALESCE(bi.problem_id, ?)
        ORDER BY COALESCE(bi.problem_id, ?)`,
    )
    .all(
      fallbackProblemId,
      fallbackProblemId,
      batchId,
      fallbackProblemId,
      fallbackProblemId,
      fallbackProblemId,
    ) as unknown as Array<{
    problem_id: number;
    display_id: string | null;
    title: string | null;
  }>;
  const rows = db
    .prepare(
      `SELECT bi.student AS student,
              COALESCE(bi.problem_id, ?) AS problem_id,
              bi.submission_id AS submission_id,
              bi.status AS import_status,
              s.status AS submission_status,
              s.verdict AS verdict,
              s.score AS score
         FROM batch_items bi
         LEFT JOIN submissions s ON s.id = bi.submission_id
        WHERE bi.batch_id = ? AND COALESCE(bi.problem_id, ?) > 0
        ORDER BY bi.student, COALESCE(bi.problem_id, ?), bi.id`,
    )
    .all(fallbackProblemId, batchId, fallbackProblemId, fallbackProblemId) as unknown as Array<{
    student: string;
    problem_id: number;
    submission_id: number | null;
    import_status: string | null;
    submission_status: string | null;
    verdict: string | null;
    score: number | null;
  }>;
  const studentSet = new Set<string>();
  const cells = new Map<string, BatchMatrixCell>();
  for (const row of rows) {
    studentSet.add(row.student);
    cells.set(matrixKey(row.student, row.problem_id), {
      score: Number(row.score ?? 0),
      verdict: row.verdict,
      status: resolveRowStatus({
        submission_id: row.submission_id,
        submission_status: row.submission_status,
        import_status: row.import_status,
      }),
    });
  }
  return {
    students: [...studentSet].sort((left, right) => left.localeCompare(right)),
    problems: problems.map((problem) => ({
      id: problem.problem_id,
      label: problemLabel(problem.problem_id, problem.display_id),
      title: problem.title ?? '',
    })),
    cells,
  };
}

// ---------------------------------------------------------------------------
// Analysis summary
// ---------------------------------------------------------------------------

export interface BatchProblemSummary extends BatchMatrixProblem {
  submissions: number;
  acCount: number;
  averageScore: number;
  maxScore: number;
  acRate: number;
}

export interface BatchExportSummary {
  generatedAt: number;
  total: number;
  imported: number;
  skipped: number;
  errors: number;
  judged: number;
  acCount: number;
  averageScore: number;
  maxScore: number;
  minScore: number;
  studentCount: number;
  problemCount: number;
  problems: BatchProblemSummary[];
  insights: string[];
}

function ratio(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

function roundScore(value: number): number {
  return Math.round(value * 10) / 10;
}

export function buildBatchExportSummary(
  db: DatabaseSync,
  batchId: number,
): BatchExportSummary {
  const job = getBatchJob(db, batchId);
  const stats = getBatchItemStats(db, batchId);
  const generatedAt = Date.now();
  if (!job) {
    return {
      generatedAt,
      total: 0,
      imported: 0,
      skipped: 0,
      errors: 0,
      judged: 0,
      acCount: 0,
      averageScore: 0,
      maxScore: 0,
      minScore: 0,
      studentCount: 0,
      problemCount: 0,
      problems: [],
      insights: ['批次不存在或已被删除。'],
    };
  }
  const fallbackProblemId = job.problem_id > 0 ? job.problem_id : 0;
  const problemRows = db
    .prepare(
      `SELECT COALESCE(bi.problem_id, ?) AS problem_id,
              p.display_id AS display_id,
              p.title AS title,
              COUNT(s.id) AS submissions,
              COALESCE(SUM(CASE WHEN s.verdict = 'AC' THEN 1 ELSE 0 END), 0) AS ac_count,
              COALESCE(AVG(s.score), 0) AS avg_score,
              COALESCE(MAX(s.score), 0) AS max_score
         FROM batch_items bi
         LEFT JOIN submissions s ON s.id = bi.submission_id
         LEFT JOIN problems p ON p.id = COALESCE(bi.problem_id, ?)
        WHERE bi.batch_id = ? AND COALESCE(bi.problem_id, ?) > 0
        GROUP BY COALESCE(bi.problem_id, ?)
        ORDER BY COALESCE(bi.problem_id, ?)`,
    )
    .all(
      fallbackProblemId,
      fallbackProblemId,
      batchId,
      fallbackProblemId,
      fallbackProblemId,
      fallbackProblemId,
    ) as unknown as Array<{
    problem_id: number;
    display_id: string | null;
    title: string | null;
    submissions: number;
    ac_count: number;
    avg_score: number;
    max_score: number;
  }>;
  const problems: BatchProblemSummary[] = problemRows.map((row) => ({
    id: row.problem_id,
    label: problemLabel(row.problem_id, row.display_id),
    title: row.title ?? '',
    submissions: Number(row.submissions),
    acCount: Number(row.ac_count),
    averageScore: roundScore(Number(row.avg_score)),
    maxScore: Number(row.max_score),
    acRate: ratio(Number(row.ac_count), Number(row.submissions)),
  }));
  const scoreRange = db
    .prepare(
      `SELECT COALESCE(MIN(s.score), 0) AS min_score,
              COALESCE(MAX(s.score), 0) AS max_score
         FROM batch_items bi
         JOIN submissions s ON s.id = bi.submission_id
        WHERE bi.batch_id = ?`,
    )
    .get(batchId) as unknown as { min_score: number; max_score: number };

  const averageScore =
    stats.imported > 0 ? roundScore(stats.scoreSum / stats.imported) : 0;
  const acRate = ratio(stats.acCount, stats.imported);
  const insights: string[] = [];
  if (stats.total === 0) {
    insights.push('本批次没有可导出的成绩记录。');
  } else {
    insights.push(
      `共 ${stats.distinctStudents} 名学生、${stats.distinctProblems} 道题、${stats.total} 条记录；` +
        `成功导入 ${stats.imported} 条，跳过 ${stats.skipped} 条，导入失败 ${stats.errors} 条。`,
    );
    if (stats.imported > 0) {
      insights.push(
        `已评测 ${stats.done} / ${stats.imported} 条，AC ${stats.acCount} 条，` +
          `AC 率 ${acRate}%，平均分 ${averageScore}，最高分 ${Number(scoreRange.max_score)}。`,
      );
    } else {
      insights.push('没有成功导入的提交，无法计算得分。');
    }
    const graded = problems.filter((problem) => problem.submissions > 0);
    if (graded.length > 0) {
      const weakest = [...graded].sort(
        (left, right) => left.acRate - right.acRate || left.id - right.id,
      )[0];
      insights.push(
        `AC 率最低的是 ${weakest.label}《${weakest.title}》` +
          `（${weakest.acRate}%，平均 ${weakest.averageScore} 分）。`,
      );
      const strongest = [...graded].sort(
        (left, right) => right.acRate - left.acRate || left.id - right.id,
      )[0];
      if (strongest.id !== weakest.id) {
        insights.push(
          `AC 率最高的是 ${strongest.label}《${strongest.title}》（${strongest.acRate}%）。`,
        );
      }
    }
    if (stats.done < stats.imported) {
      insights.push('部分提交尚未完成评测，以上结果为当前最新状态。');
    }
  }
  return {
    generatedAt,
    total: stats.total,
    imported: stats.imported,
    skipped: stats.skipped,
    errors: stats.errors,
    judged: stats.done,
    acCount: stats.acCount,
    averageScore,
    maxScore: Number(scoreRange.max_score),
    minScore: Number(scoreRange.min_score),
    studentCount: stats.distinctStudents,
    problemCount: problems.length,
    problems,
    insights,
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvLine(cells: readonly unknown[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

const CSV_BOM = '\uFEFF';

export interface BatchCsvOptions {
  /** Emit the student × problem matrix instead of the long table. */
  matrix?: boolean;
}

export async function* iterateBatchCsv(
  db: DatabaseSync,
  batchId: number,
  options: BatchCsvOptions = {},
): AsyncGenerator<string> {
  if (options.matrix) {
    yield* iterateBatchMatrixCsv(db, batchId);
    return;
  }
  yield `${CSV_BOM}${csvLine(BATCH_EXPORT_COLUMNS)}`;
  for await (const row of iterateBatchExportRows(db, batchId)) {
    yield csvLine([
      row.student,
      row.problemLabel,
      row.problemTitle,
      batchExportStatusLabel(row.status),
      row.verdict ?? '',
      row.score,
      row.timeMs,
      row.memoryKb,
      row.passedTests,
      row.totalTests,
    ]);
  }
}

function matrixHeader(matrix: BatchMatrix): Array<string | number> {
  return [
    '学生',
    ...matrix.problems.map((problem) =>
      problem.title ? `${problem.label} ${problem.title}` : problem.label,
    ),
    '总分',
    'AC 数',
  ];
}

function matrixTotal(cells: Iterable<BatchMatrixCell>): {
  total: number;
  acCount: number;
} {
  let total = 0;
  let acCount = 0;
  for (const cell of cells) {
    total += cell.score;
    if (cell.verdict === 'AC') acCount += 1;
  }
  return { total, acCount };
}

async function* iterateBatchMatrixCsv(
  db: DatabaseSync,
  batchId: number,
): AsyncGenerator<string> {
  const matrix = buildBatchMatrix(db, batchId);
  yield `${CSV_BOM}${csvLine(matrixHeader(matrix))}`;
  for (const student of matrix.students) {
    const cells: Array<string | number> = [student];
    for (const problem of matrix.problems) {
      const cell = matrix.cells.get(matrixKey(student, problem.id));
      cells.push(cell ? cell.score : '');
    }
    const { total, acCount } = matrixTotal(
      matrix.problems
        .map((problem) => matrix.cells.get(matrixKey(student, problem.id)))
        .filter((cell): cell is BatchMatrixCell => cell !== undefined),
    );
    cells.push(total, acCount);
    yield csvLine(cells);
  }
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function statusClass(status: string): string {
  if (status === 'finished') return 'status-finished';
  if (status === 'failed' || status === 'canceled' || status === 'error') return 'status-bad';
  if (status === 'skipped' || status === 'missing') return 'status-muted';
  return 'status-running';
}

function verdictClass(verdict: string | null): string {
  if (verdict === 'AC') return 'verdict-ac';
  if (verdict) return 'verdict-fail';
  return 'verdict-none';
}

function statCard(value: string | number, label: string, tone = ''): string {
  return `<div class="stat${tone ? ` ${tone}` : ''}"><span class="stat-value">${escapeHtml(
    String(value),
  )}</span><span class="stat-label">${escapeHtml(label)}</span></div>`;
}

function htmlHead(job: BatchJobRow | null, summary: BatchExportSummary): string {
  const title = `批量评测报告 #${job?.id ?? '-'}`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; font: 14px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; color: #1f2328; background: #fff; }
h1 { margin: 0 0 4px; font-size: 24px; }
h2 { margin: 28px 0 12px; font-size: 18px; border-left: 4px solid #1677ff; padding-left: 8px; }
.meta { color: #59636e; margin-bottom: 20px; }
.stats { display: flex; flex-wrap: wrap; gap: 12px; margin: 16px 0; }
.stat { min-width: 120px; padding: 12px 16px; border: 1px solid #d8dee4; border-radius: 8px; background: #f6f8fa; }
.stat-value { display: block; font-size: 22px; font-weight: 600; }
.stat-label { color: #59636e; font-size: 12px; }
.insights { border: 1px solid #d8dee4; border-radius: 8px; padding: 12px 16px 12px 32px; background: #f6f8fa; }
.insights li { margin: 4px 0; }
table { width: 100%; border-collapse: collapse; margin-bottom: 8px; font-size: 13px; }
th, td { border: 1px solid #d8dee4; padding: 6px 8px; text-align: left; vertical-align: top; }
th { background: #eef2f6; font-weight: 600; white-space: nowrap; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
tr:nth-child(even) td { background: #fafbfc; }
.matrix td.cell { text-align: center; font-variant-numeric: tabular-nums; }
.matrix td.zero { color: #9aa4af; }
.verdict-ac { color: #1a7f37; font-weight: 600; }
.verdict-fail { color: #cf222e; }
.verdict-none { color: #8b949e; }
.status-finished { color: #1a7f37; }
.status-bad { color: #cf222e; }
.status-muted { color: #8b949e; }
.status-running { color: #9a6700; }
.empty { padding: 16px; border: 1px dashed #d8dee4; border-radius: 8px; color: #59636e; }
footer { margin-top: 28px; color: #8b949e; font-size: 12px; }
@media print {
  body { padding: 0; font-size: 12px; }
  h2 { break-after: avoid; }
  table { break-inside: auto; }
  tr { break-inside: avoid; }
  .stats { break-inside: avoid; }
}
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="meta">生成时间：${escapeHtml(
    new Date(summary.generatedAt).toLocaleString('zh-CN', { hour12: false }),
  )} · 学生 ${summary.studentCount} 人 · 题目 ${summary.problemCount} 道 · 共 ${summary.total} 条记录</div>
`;
}

function htmlSummary(summary: BatchExportSummary): string {
  const cards = [
    statCard(summary.total, '总记录'),
    statCard(summary.imported, '成功导入'),
    statCard(summary.skipped, '跳过'),
    statCard(summary.errors, '导入失败'),
    statCard(summary.judged, '已评测'),
    statCard(summary.acCount, 'AC', 'stat-ac'),
    statCard(`${summary.averageScore}`, '平均分'),
    statCard(summary.maxScore, '最高分'),
    statCard(summary.minScore, '最低分'),
  ].join('');
  const insights = summary.insights
    .map((insight) => `<li>${escapeHtml(insight)}</li>`)
    .join('');
  const problemRows = summary.problems
    .map(
      (problem) => `<tr><td>${escapeHtml(problem.label)}</td><td>${escapeHtml(
        problem.title,
      )}</td><td class="num">${problem.submissions}</td><td class="num">${
        problem.acCount
      }</td><td class="num">${problem.acRate}%</td><td class="num">${
        problem.averageScore
      }</td><td class="num">${problem.maxScore}</td></tr>`,
    )
    .join('');
  const problemTable =
    summary.problems.length > 0
      ? `<table class="problem-summary">
<thead><tr><th>题号</th><th>题目</th><th>提交数</th><th>AC 数</th><th>AC 率</th><th>平均分</th><th>最高分</th></tr></thead>
<tbody>${problemRows}</tbody>
</table>`
      : '<div class="empty">没有题目统计。</div>';
  return `<section>
<h2>自动分析摘要</h2>
<div class="stats">${cards}</div>
<ul class="insights">${insights}</ul>
<h2>题目分析</h2>
${problemTable}
</section>
`;
}

function htmlLongTableStart(): string {
  return `<section>
<h2>成绩明细</h2>
<table class="detail">
<thead><tr>${BATCH_EXPORT_COLUMNS.map((column) => `<th>${escapeHtml(column)}</th>`).join(
    '',
  )}</tr></thead>
<tbody>
`;
}

function htmlLongTableRow(row: BatchExportRow): string {
  return `<tr><td>${escapeHtml(row.student)}</td><td>${escapeHtml(
    row.problemLabel,
  )}</td><td>${escapeHtml(row.problemTitle)}</td><td class="${statusClass(
    row.status,
  )}">${escapeHtml(batchExportStatusLabel(row.status))}</td><td class="${verdictClass(
    row.verdict,
  )}">${escapeHtml(row.verdict ?? '')}</td><td class="num">${row.score}</td><td class="num">${
    row.timeMs
  }</td><td class="num">${row.memoryKb}</td><td class="num">${
    row.passedTests
  }</td><td class="num">${row.totalTests}</td></tr>\n`;
}

function htmlMatrix(matrix: BatchMatrix): string {
  if (matrix.problems.length === 0) {
    return `<section><h2>学生 × 题目矩阵</h2><div class="empty">没有可展示的矩阵数据。</div></section>\n`;
  }
  const head = [
    '<th>学生</th>',
    ...matrix.problems.map(
      (problem) =>
        `<th>${escapeHtml(problem.label)}${
          problem.title ? `<br><span class="muted">${escapeHtml(problem.title)}</span>` : ''
        }</th>`,
    ),
    '<th>总分</th><th>AC 数</th>',
  ].join('');
  let body = '';
  for (const student of matrix.students) {
    const cells = matrix.problems
      .map((problem) => matrix.cells.get(matrixKey(student, problem.id)))
      .filter((cell): cell is BatchMatrixCell => cell !== undefined);
    const { total, acCount } = matrixTotal(cells);
    const tds = matrix.problems
      .map((problem) => {
        const cell = matrix.cells.get(matrixKey(student, problem.id));
        if (!cell) return '<td class="cell"></td>';
        const className = `cell ${verdictClass(cell.verdict)}${
          cell.score === 0 ? ' zero' : ''
        }`;
        return `<td class="${className}">${cell.score}</td>`;
      })
      .join('');
    body += `<tr><td>${escapeHtml(student)}</td>${tds}<td class="num">${total}</td><td class="num">${acCount}</td></tr>\n`;
  }
  return `<section>
<h2>学生 × 题目矩阵</h2>
<table class="matrix">
<thead><tr>${head}</tr></thead>
<tbody>
${body}</tbody>
</table>
</section>
`;
}

export async function* iterateBatchHtml(
  db: DatabaseSync,
  batchId: number,
): AsyncGenerator<string> {
  const job = getBatchJob(db, batchId);
  const summary = buildBatchExportSummary(db, batchId);
  const matrix = buildBatchMatrix(db, batchId);
  yield htmlHead(job, summary);
  yield htmlSummary(summary);
  yield htmlLongTableStart();
  let rows = 0;
  for await (const row of iterateBatchExportRows(db, batchId)) {
    rows += 1;
    yield htmlLongTableRow(row);
  }
  if (rows === 0) {
    yield `<tr><td colspan="${BATCH_EXPORT_COLUMNS.length}">没有可导出的成绩记录</td></tr>\n`;
  }
  yield '</tbody></table></section>\n';
  yield htmlMatrix(matrix);
  yield `<footer>由 OI 本地评测系统导出 · 批次 #${escapeHtml(
    String(batchId),
  )} · 生成于 ${escapeHtml(new Date(summary.generatedAt).toISOString())}</footer>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// XLSX (exceljs streaming writer)
// ---------------------------------------------------------------------------

/**
 * Writes the workbook to `out`: sheet 1 is the long table, sheet 2 is the
 * student × problem matrix. Rows are committed one at a time so exceljs keeps
 * the memory profile flat for large batches.
 */
export async function writeBatchXlsx(
  db: DatabaseSync,
  batchId: number,
  out: Writable,
): Promise<void> {
  const job = getBatchJob(db, batchId);
  if (!job) throw new Error(`batch ${batchId} not found`);
  const matrix = buildBatchMatrix(db, batchId);
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: out,
    useSharedStrings: false,
    useStyles: false,
  });
  const detail = workbook.addWorksheet('成绩明细');
  detail.columns = [
    { width: 20 },
    { width: 10 },
    { width: 28 },
    { width: 12 },
    { width: 8 },
    { width: 8 },
    { width: 10 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
  ];
  detail.addRow([...BATCH_EXPORT_COLUMNS]).commit();
  for await (const row of iterateBatchExportRows(db, batchId)) {
    detail
      .addRow([
        row.student,
        row.problemLabel,
        row.problemTitle,
        batchExportStatusLabel(row.status),
        row.verdict ?? '',
        row.score,
        row.timeMs,
        row.memoryKb,
        row.passedTests,
        row.totalTests,
      ])
      .commit();
  }
  detail.commit();

  const matrixSheet = workbook.addWorksheet('学生题目矩阵');
  matrixSheet.columns = [
    { width: 20 },
    ...matrix.problems.map(() => ({ width: 14 })),
    { width: 10 },
    { width: 8 },
  ];
  matrixSheet.addRow(matrixHeader(matrix)).commit();
  for (const student of matrix.students) {
    const cells = matrix.problems
      .map((problem) => matrix.cells.get(matrixKey(student, problem.id)))
      .filter((cell): cell is BatchMatrixCell => cell !== undefined);
    const { total, acCount } = matrixTotal(cells);
    matrixSheet
      .addRow([
        student,
        ...matrix.problems.map((problem) => {
          const cell = matrix.cells.get(matrixKey(student, problem.id));
          return cell ? cell.score : '';
        }),
        total,
        acCount,
      ])
      .commit();
  }
  matrixSheet.commit();
  await workbook.commit();
}
