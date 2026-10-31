/** 与后端 API 对齐的类型定义（只覆盖 Phase 1B 用到的字段）。 */

export type Role = 'admin' | 'setter' | 'contestmanager' | 'contestant';

export interface User {
  id: number;
  username: string;
  realName: string | null;
  className: string | null;
  role: Role;
}

export interface MeResult {
  user: User;
  permissions: string[];
}

export interface LoginResult {
  user: User;
}

export type Verdict =
  | 'AC'
  | 'WA'
  | 'TLE'
  | 'MLE'
  | 'RE'
  | 'CE'
  | 'OLE'
  | 'PE'
  | 'PC'
  | 'SK'
  | 'SE'
  | 'UKE';

export type SubmissionStatus =
  | 'queued'
  | 'compiling'
  | 'running'
  | 'finished'
  | 'failed'
  | 'canceled';

export interface Sample {
  input: string;
  output: string;
  explanation?: string;
}

export type ProblemType = 'standard' | 'file-io' | 'interactive' | 'output-only' | 'objective';

export interface ProblemSummary {
  id: number;
  title: string;
  type: ProblemType;
  difficulty: number | null;
  tags: string[];
  timeMs: number;
  memoryMb: number;
}

export interface ProblemDetail extends ProblemSummary {
  ioMode: 'stdio' | 'file';
  inputFile: string | null;
  outputFile: string | null;
  checkerMode: 'builtin' | 'testlib' | 'lemon';
  compareMode: string;
  visibility: 'public' | 'hidden';
  statementHtml: string;
  samples: Sample[];
}

/** Phase 1F 管理端列表项（包含隐藏题与可见性）。 */
export interface AdminProblemSummary extends ProblemSummary {
  visibility: 'public' | 'hidden';
}

/** Phase 1E 管理端：题目基础信息更新（所有字段可选）。 */
export interface UpdateProblemRequest {
  title?: string;
  type?: string;
  difficulty?: number | null;
  tags?: string[];
  timeMs?: number;
  memoryMb?: number;
  ioMode?: 'stdio' | 'file';
  inputFile?: string | null;
  outputFile?: string | null;
  statementHtml?: string;
  visibility?: 'public' | 'hidden';
  checkerMode?: 'builtin' | 'testlib' | 'lemon';
  compareMode?: string;
}

export interface ValidateTestcaseResult {
  testcaseId: number;
  ok: boolean;
  message: string;
}

export interface ValidateResult {
  passed: number;
  total: number;
  results: ValidateTestcaseResult[];
}

/** Phase 1F：std 自测结果。 */
export interface SelfTestTestcaseResult {
  testcaseId: number;
  verdict: Verdict;
  timeMs: number;
  memoryKb: number;
  score: number;
  message: string;
}

export interface SelfTestResult {
  score: number;
  results: SelfTestTestcaseResult[];
}

export interface TestResult {
  testcaseId: number;
  verdict: Verdict;
  timeMs: number;
  memoryKb: number;
  score: number;
  message: string;
}

export interface Submission {
  id: number;
  problemId: number;
  contestId: number | null;
  userId: number;
  language: string;
  status: SubmissionStatus;
  verdict: Verdict | null;
  score: number;
  timeMs: number;
  memoryKb: number;
  message?: string;
  createdAt: string;
  judgedAt: string | null;
  code?: string;
  results?: TestResult[];
}

/** GET /api/contests 直接返回数据库行（snake_case）。 */
export interface Contest {
  id: number;
  name: string;
  mode: string;
  start_at: number | null;
  end_at: number | null;
  freeze_at: number | null;
  unfreeze_at: number | null;
  status: string;
  rules_json: string;
}

/** GET /api/contests/:id 返回的比赛题目（含每题分值）。 */
export interface ContestDetailProblem {
  problemId: number;
  ordinal: number;
  points: number;
  title: string;
  type: ProblemType;
  difficulty: number | null;
  timeMs: number;
  memoryMb: number;
}

export interface ContestDetail {
  contest: Contest;
  problems: ContestDetailProblem[];
  participantCount: number;
}

/** Phase 1D 管理端：程序资产。 */
export type AssetKind =
  | 'std'
  | 'checker'
  | 'validator'
  | 'generator'
  | 'interactor'
  | 'judger'
  | 'brute';

export interface ProblemAsset {
  id: number;
  problem_id: number;
  kind: AssetKind;
  name: string;
  path: string;
  language: string | null;
  sha256: string;
  size: number;
  updated_at: number;
}

export interface ProblemAssetSource extends ProblemAsset {
  source: string;
}

export interface CompileAssetResult {
  compiled: boolean;
  exe?: string;
  cached?: boolean;
  message: string;
}

export interface AdminTestcase {
  id: number;
  problem_id: number;
  ordinal: number;
  input_path: string;
  output_path: string;
  points: number;
  subtask_id: number | null;
  depends_on: string | null;
  enabled: number;
}

export interface AdminDataImportResult {
  testcases: Array<{ stem: string; input: string; output: string }>;
}

export interface CreateProblemRequest {
  title: string;
  type: string;
  timeMs: number;
  memoryMb: number;
  difficulty?: number | null;
  tags?: string[];
  ioMode?: 'stdio' | 'file';
  inputFile?: string | null;
  outputFile?: string | null;
  statement?: string;
}

export interface CreateProblemResult {
  id: number;
}

export interface RankingCell {
  problemId: number;
  score: number;
  verdict: Verdict | null;
  lastAcAt: number | null;
}

export interface RankingRow {
  rank: number;
  userId: number;
  totalScore: number;
  solved: number;
  lastAcAt: number | null;
  problems: RankingCell[];
  username: string;
  realName: string | null;
  className: string | null;
}

export interface WsMessage {
  v?: number;
  type: string;
  data?: unknown;
}

export interface SubmissionUpdatedPayload {
  submissionId: number;
  status?: SubmissionStatus;
  verdict?: Verdict | null;
  score?: number;
  timeMs?: number;
  memoryKb?: number;
  message?: string;
}

export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}
