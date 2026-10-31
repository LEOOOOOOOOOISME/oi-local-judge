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
  statementHtml: string;
  samples: Sample[];
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
