import type { Verdict } from './protocol.js';

export type Role = 'admin' | 'setter' | 'contestmanager' | 'contestant';

export interface UserDto {
  id: number;
  username: string;
  realName: string | null;
  className: string | null;
  role: Role;
}

export type ProblemType = 'standard' | 'file-io' | 'interactive' | 'output-only' | 'objective';

export interface ProblemSummaryDto {
  id: number;
  title: string;
  type: ProblemType;
  difficulty: number | null;
  tags: string[];
  timeMs: number;
  memoryMb: number;
}

export interface ProblemDetailDto extends ProblemSummaryDto {
  ioMode: 'stdio' | 'file';
  inputFile: string | null;
  outputFile: string | null;
  statementHtml: string;
  samples: Array<{ input: string; output: string; explanation?: string }>;
}

export interface TestResultDto {
  testcaseId: number;
  verdict: Verdict;
  timeMs: number;
  memoryKb: number;
  score: number;
  message: string;
}

export interface SubmissionDto {
  id: number;
  problemId: number;
  contestId: number | null;
  userId: number;
  language: string;
  status: 'queued' | 'compiling' | 'running' | 'finished' | 'failed' | 'canceled';
  verdict: Verdict | null;
  score: number;
  timeMs: number;
  memoryKb: number;
  createdAt: string;
  judgedAt: string | null;
  code?: string;
  results?: TestResultDto[];
}

export interface RankingSubmission {
  userId: number;
  problemId: number;
  verdict: Verdict;
  score: number;
  createdAt: number;
}

export interface RankingRow {
  rank: number;
  userId: number;
  totalScore: number;
  solved: number;
  lastAcAt: number | null;
  problems: Array<{ problemId: number; score: number; verdict: Verdict | null; lastAcAt: number | null }>;
}
