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

export type ObjectiveQuestionKind = 'single' | 'multiple' | 'judge' | 'fill';

export interface ObjectiveOption {
  key: string;
  text: string;
}

export interface ObjectiveQuestion {
  id: number;
  kind: ObjectiveQuestionKind;
  stem: string;
  options?: ObjectiveOption[];
  answers?: string[];
  points: number;
  partial?: boolean;
  ignoreCase?: boolean;
  ignoreWhitespace?: boolean;
}

export interface ObjectiveConfig {
  questions: ObjectiveQuestion[];
}

export interface AnswerFile {
  id: number;
  ordinal: number;
  points: number;
  inputUrl: string;
}

export type ObjectiveAnswerValue = string | string[];

export interface ObjectiveAnswer {
  questionId: number;
  value: ObjectiveAnswerValue;
}

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
  objective?: ObjectiveConfig;
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
  objective?: ObjectiveConfig;
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

/** Phase 1G：generator 造数据与 std/brute 对拍。 */
export interface GeneratedTestcase {
  seed: number;
  input: string;
  output: string;
}

export interface GenerateResult {
  generated: GeneratedTestcase[];
  total: number;
}

export interface StressMismatch {
  seed: number;
  input: string;
  stdOutput: string;
  bruteOutput: string;
  path: string;
}

export interface StressResult {
  passed: number;
  total: number;
  mismatch: StressMismatch | null;
}

/** Phase 1H：批量评测。 */
export interface BatchUploadResult {
  uploadId: string;
  files: string[];
}

export interface BatchRunItem {
  student: string;
  submissionId: number;
  problemId?: number;
  problemTitle?: string | null;
}

export interface BatchRunResult {
  id: number;
  count: number;
  items: BatchRunItem[];
  multiProblem?: boolean;
}

export interface BatchResultItem {
  student: string;
  problemId: number;
  problemTitle: string | null;
  sourcePath: string;
  submissionId: number | null;
  status: SubmissionStatus | 'missing';
  verdict: Verdict | null;
  score: number;
  timeMs: number;
  memoryKb: number;
}

export interface BatchJob {
  id: number;
  problemId: number;
  multiProblem?: boolean;
  status: 'running' | 'finished';
  studentLevel: number;
  items: BatchResultItem[];
}

/** Phase 2A：比赛/用户/班级管理。 */
export interface AdminUser {
  id: number;
  username: string;
  realName: string | null;
  className: string | null;
  role: Role;
  status: string;
  createdAt: number;
}

export interface UpdateUserRequest {
  realName?: string | null;
  className?: string | null;
  role?: Role;
  status?: 'active' | 'disabled' | string;
}

export interface ImportUsersResult {
  created: string[];
  skipped: string[];
  errors: Array<{ line: number; message: string }>;
}

export interface ContestParticipant {
  user_id: number;
  username: string;
  real_name: string | null;
  class_name: string | null;
  status: string;
  extra_time: number;
}

export interface ClassStatRow {
  className: string;
  participants: number;
  totalScore: number;
  averageScore: number;
  acParticipants: number;
  bestRank: number;
}

export interface CreateContestRequest {
  name: string;
  mode?: string;
  startAt?: number;
  endAt?: number;
  freezeAt?: number;
  problemIds?: number[];
  participantIds?: number[];
}

export interface UpdateContestRequest {
  name?: string;
  mode?: string;
  startAt?: number | null;
  endAt?: number | null;
  freezeAt?: number | null;
  unfreezeAt?: number | null;
  problems?: Array<{ problemId: number; points: number }>;
}

export interface CreateUserRequest {
  username: string;
  password: string;
  realName?: string;
  className?: string;
  role?: Role;
}

export interface CreateUserResult {
  id: number;
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
  archived_at?: number | null;
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

/** Phase A：比赛批量导入、名单与归档。 */
export type ContestBatchMode = 'overwrite' | 'merge' | 'fill';

export type ContestBatchStatus =
  | 'draft'
  | 'ready'
  | 'failed'
  | 'published'
  | 'discarded';

export interface ContestBatchMeta {
  unknownUsers: string[];
  unresolvedProblems: string[];
  ignoredFiles: string[];
}

export interface ContestBatchItem {
  student: string;
  userId: number | null;
  sourcePath: string;
  problemId: number | null;
  problemTitle: string | null;
  submissionId?: number | null;
  status: SubmissionStatus | 'missing';
  verdict: Verdict | null;
  score: number;
  timeMs: number;
  memoryKb: number;
}

export interface ContestBatchUploadResult {
  id: number;
  count: number;
  items: Array<{ student: string; problemId: number; submissionId: number }>;
  unknownUsers: string[];
  unresolvedProblems: string[];
}

export interface ContestBatchDetail {
  id: number;
  contestId: number;
  status: ContestBatchStatus;
  mode: ContestBatchMode;
  studentLevel: number;
  problemLevel: number;
  problemMap: Record<string, number>;
  meta: ContestBatchMeta;
  items: ContestBatchItem[];
}

export interface ContestBatchPreviewRow {
  student: string;
  userId: number | null;
  problemId: number | null;
  problemTitle: string | null;
  currentScore: number;
  currentVerdict: string | null;
  batchScore: number;
  batchVerdict: string | null;
  afterScore: number;
}

export interface ContestBatchPreview {
  mode: ContestBatchMode;
  rows: ContestBatchPreviewRow[];
  changed: number;
}

export interface ContestBatchPublishResult {
  id: number;
  published: number;
  mode: ContestBatchMode;
}

export interface ContestParticipantImportResult {
  added: string[];
  skipped: string[];
  unknown: string[];
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
  objective?: ObjectiveConfig;
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

/** Phase A：正式榜 official-ranking。 */
export type RankingPreset = 'oi' | 'ioi' | 'acm' | 'cf-like';

export interface OfficialRankingProblem {
  id: number;
  ordinal: number;
  points: number;
  title: string;
}

export interface OfficialRankingCell {
  problemId: number;
  score: number;
  verdict: Verdict | null;
  attempts: number;
  firstAcAt: number | null;
}

export interface OfficialRankingRow {
  rank: number;
  userId: number;
  totalScore: number;
  hackScore?: number;
  solved: number;
  penalty: number;
  lastAcAt: number | null;
  cells: OfficialRankingCell[];
  username: string;
  realName: string | null;
  className: string | null;
  hackedCount: number;
  successfulHacks: number;
}

export interface OfficialRankingConfig {
  preset: string;
  tie: 'same-rank' | 'none';
  cfLike?: {
    decay: number;
    hackPoints?: number;
    failedHackPenalty?: number;
  };
  freezeAt?: number | null;
}

export interface OfficialRanking {
  contest: Contest;
  problems: OfficialRankingProblem[];
  rows: OfficialRankingRow[];
  config: OfficialRankingConfig;
  archived: boolean;
  preset: string;
  pluginError?: string;
}

/** Phase B：独立订正榜。 */
export interface CorrectionCell {
  problemId: number;
  officialScore: number;
  officialVerdict: Verdict | null;
  correctionScore: number;
  correctionVerdict: Verdict | null;
  correctedScore: number;
  correctedVerdict: Verdict | null;
}

export interface CorrectionRankingRow {
  rank: number;
  userId: number;
  username: string;
  realName: string | null;
  className: string | null;
  officialTotal: number;
  correctedTotal: number;
  officialSolved: number;
  correctedSolved: number;
  cells: CorrectionCell[];
}

export interface CorrectionRanking {
  contest: Contest;
  problems: OfficialRankingProblem[];
  rows: CorrectionRankingRow[];
  correctionsOpen: boolean;
  archived: boolean;
}

/** Phase C：比赛 Hack。 */
export type HackStatus =
  | 'queued'
  | 'judging'
  | 'success'
  | 'failed'
  | 'invalid'
  | 'unjudgeable'
  | 'promoted';

export interface HackTarget {
  id: number;
  userId: number;
  verdict: Verdict | null;
  score: number;
  createdAt: number;
}

export interface HackSource {
  submissionId: number;
  language: string;
  code: string;
}

export interface HackJob {
  id: number;
  contest_id: number;
  problem_id: number;
  hacker_id: number;
  target_submission_id: number;
  input_path: string;
  status: HackStatus;
  verdict: Verdict | null;
  message: string;
  created_at: number;
  judged_at: number | null;
}

export interface HackHistoryItem {
  id: number;
  hackerId: number;
  targetSubmissionId: number;
  status: HackStatus;
  verdict: Verdict | null;
  message: string;
  createdAt: number;
}

/** Phase A：排名规则配置与自定义插件。 */
export interface ContestRankingRuleConfig {
  preset?: string;
  tie?: 'same-rank' | 'none';
  hackWindowMinutes?: number;
  cfLike?: {
    decay: number;
    hackPoints?: number;
    failedHackPenalty?: number;
  };
}

export interface RankingPlugin {
  id: number;
  name: string;
  sha256: string;
  enabled: boolean;
  uploadedBy: number;
  uploadedAt: number;
}

export interface RankingPluginUploadResult {
  id: number;
  name: string;
  sha256: string;
  restartRequired: boolean;
}

// Phase 3A：讨论区 / 答疑 / 私信 / 通知。

export type PostCategory = 'discuss' | 'solution' | 'announcement';

export interface CommunityAuthor {
  id: number;
  username: string;
  realName: string | null;
  className: string | null;
}

export interface PostSummary {
  id: number;
  category: PostCategory;
  title: string;
  author: CommunityAuthor;
  problemId: number | null;
  contestId: number | null;
  pinned: boolean;
  locked: boolean;
  status?: string;
  createdAt: number;
}

export interface PostComment {
  id: number;
  bodyHtml: string;
  author: CommunityAuthor;
  createdAt: number;
}

export interface PostDetail {
  id: number;
  category: PostCategory;
  title: string;
  bodyHtml: string;
  author: CommunityAuthor;
  problemId: number | null;
  contestId: number | null;
  pinned: boolean;
  locked: boolean;
  createdAt: number;
  comments: PostComment[];
}

export interface CreatePostRequest {
  category: PostCategory;
  title: string;
  body: string;
  problemId?: number | null;
  contestId?: number | null;
}

export interface CreatePostResult {
  id: number;
  status: string;
}

/** 管理端审核列表直接返回数据库行。 */
export interface AdminPostRow {
  id: number;
  category: PostCategory;
  title: string;
  body_md: string;
  problem_id: number | null;
  contest_id: number | null;
  author_id: number;
  status: 'pending' | 'published' | 'hidden';
  pinned: number;
  locked: number;
  created_at: number;
  updated_at: number;
}

export interface Clarification {
  id: number;
  question: string;
  answer: string | null;
  isPublic: boolean;
  user: CommunityAuthor;
  createdAt: number;
  answeredAt: number | null;
}

export interface ConversationPartner {
  user: CommunityAuthor;
  lastMessage: string;
  lastAt: number;
  unread: number;
}

export interface DirectMessage {
  id: number;
  senderId: number;
  recipientId: number;
  body: string;
  createdAt: number;
  readAt: number | null;
}

export interface ConversationThread {
  user: CommunityAuthor;
  messages: DirectMessage[];
}

export interface NotificationItem {
  id: number;
  type: string;
  payload: unknown;
  readAt: number | null;
  createdAt: number;
}

/** Phase 3C：审计日志。 */
export interface AuditLog {
  id: number;
  actorId: number | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: unknown;
  ip: string | null;
  createdAt: number;
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
