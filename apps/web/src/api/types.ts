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
  /** 题目归属类型；旧后端可能不返回。 */
  ownerType?: ProblemOwnerType;
  /** 题目归属 id；system 题目为 null。旧后端可能不返回。 */
  ownerId?: number | null;
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

/** Problem ACL：题目归属类型（系统 / 个人 / 团队）。 */
export type ProblemOwnerType = 'system' | 'user' | 'team';

/** Problem ACL：分享目标类型。 */
export type ProblemGranteeType = 'user' | 'team';

/** Problem ACL：分享权限。 */
export type ProblemSharePermission = 'read' | 'edit';

/** GET /api/problems/:id/shares 返回的分享项。 */
export interface ProblemShare {
  granteeType: ProblemGranteeType;
  granteeId: number;
  permission: ProblemSharePermission;
  createdBy: number;
  createdAt: number;
}

export interface AddProblemShareRequest {
  granteeType: ProblemGranteeType;
  granteeId: number;
  permission: ProblemSharePermission;
}

/** 管理端题目详情：在 ProblemDetail 基础上返回归属信息。 */
export interface AdminProblemDetail extends ProblemDetail {
  ownerType: ProblemOwnerType;
  ownerId: number | null;
}

/** Phase 1F 管理端列表项（包含隐藏题、可见性与归属）。 */
export interface AdminProblemSummary extends ProblemSummary {
  visibility: 'public' | 'hidden';
  ownerType: ProblemOwnerType;
  ownerId: number | null;
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
  ownerType?: ProblemOwnerType;
  ownerId?: number | null;
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

/** 团队报名模式：个人 / 团队 / 个人与团队均可。默认 individual。 */
export type TeamMode = 'individual' | 'team' | 'both';

/** 个人报名方式：管理员导入 / 自由报名 / 报名审核。默认 manual。 */
export type RegistrationMode = 'manual' | 'open' | 'approval';

/** 报名审核状态。 */
export type RegistrationStatus = 'pending' | 'accepted' | 'rejected';

/** 单条报名/参赛记录；管理端报名表与“我的报名”共用。 */
export interface ContestRegistration {
  contestId: number;
  userId: number;
  username: string;
  realName: string | null;
  className: string | null;
  status: RegistrationStatus;
  registeredAt: number | null;
  checkedInAt: number | null;
  reviewedAt: number | null;
  reviewedBy: number | null;
  submissionCount: number;
  lastSubmissionAt: number | null;
}

/** GET /api/contests/:id/registration 返回的报名方式与我的报名。 */
export interface MyContestRegistration {
  mode: RegistrationMode;
  registration: ContestRegistration | null;
}

export interface CreateContestRequest {
  name: string;
  mode?: string;
  /** 团队报名模式，省略时后端默认 individual。 */
  teamMode?: TeamMode;
  /** 个人报名方式，省略时后端默认 manual（管理员导入）。 */
  registrationMode?: RegistrationMode;
  /** 报名开始时间（epoch ms）；null/省略表示不限制。 */
  registrationOpenAt?: number | null;
  /** 报名截止时间（epoch ms）；null/省略表示不限制。 */
  registrationCloseAt?: number | null;
  startAt?: number;
  endAt?: number;
  freezeAt?: number;
  problemIds?: number[];
  participantIds?: number[];
}

export interface UpdateContestRequest {
  name?: string;
  mode?: string;
  teamMode?: TeamMode;
  registrationMode?: RegistrationMode;
  /** 报名开始时间（epoch ms）；null 表示清除限制，省略表示不修改。 */
  registrationOpenAt?: number | null;
  /** 报名截止时间（epoch ms）；null 表示清除限制，省略表示不修改。 */
  registrationCloseAt?: number | null;
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
  hackedAt?: string | null;
  hackedBy?: number | null;
  hackId?: number | null;
  /** 队列位置（1-based）；仅排队中的提交有值，其余为 null。 */
  queuePosition?: number | null;
  code?: string;
  results?: TestResult[];
}

/** GET /api/contests 直接返回数据库行（snake_case）。 */
export interface Contest {
  id: number;
  name: string;
  mode: string;
  /** 团队报名模式；旧后端/旧比赛可能没有该字段，前端按 individual 处理。 */
  team_mode?: TeamMode;
  /** 兼容已映射为 camelCase 的接口返回。 */
  teamMode?: TeamMode;
  /** 个人报名方式；旧后端/旧比赛可能没有该字段，前端按 manual 处理。 */
  registration_mode?: RegistrationMode;
  /** 兼容已映射为 camelCase 的接口返回。 */
  registrationMode?: RegistrationMode;
  /** 报名开始时间（epoch ms）；null 表示不限制。 */
  registration_open_at?: number | null;
  /** 报名截止时间（epoch ms）；null 表示不限制。 */
  registration_close_at?: number | null;
  start_at: number | null;
  end_at: number | null;
  freeze_at: number | null;
  unfreeze_at: number | null;
  status: string;
  rules_json: string;
  archived_at?: number | null;
  official_frozen_until?: number | null;
}

/** GET /api/contests/:id/team-ranking 返回的比赛题目。 */
export interface TeamRankingProblem {
  id: number;
  ordinal: number;
  points: number;
  title: string;
}

/** 团队榜中单个团队在某题上的最佳成绩。 */
export interface TeamRankingCell {
  problemId: number;
  score: number;
  verdict: Verdict | null;
  attempts: number;
  firstAcAt: number | null;
}

/** GET /api/contests/:id/team-ranking 返回的行。 */
export interface TeamRankingRow {
  rank: number;
  teamId: number;
  teamName: string;
  memberCount: number;
  totalScore: number;
  /** CF-like：成功/失败 Hack 的分值（已计入 totalScore）。 */
  hackScore?: number;
  solved: number;
  /** ACM/CF-like 罚时（分钟）；OI/IOI 为 0。 */
  penalty: number;
  lastAcAt: number | null;
  cells: TeamRankingCell[];
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
  ownerType?: ProblemOwnerType;
  ownerId?: number | null;
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
  /** 后端快照版本；旧后端/旧接口回退时可能没有该字段。 */
  version?: number;
  pluginError?: string;
  officialFrozenUntil?: number | null;
}

/** 比赛成绩报告：参与者统计。 */
export interface ContestReportParticipantStats {
  total: number;
  accepted: number;
  pending: number;
  rejected: number;
  checkedIn: number;
}

/** 比赛成绩报告：提交统计。 */
export interface ContestReportSubmissionStats {
  total: number;
  /** 按 verdict 计数；无 verdict 的提交记为 none。 */
  byVerdict: Record<string, number>;
  byStatus: Record<string, number>;
}

/** 比赛成绩报告：每题统计。 */
export interface ContestReportProblemStats {
  problemId: number;
  ordinal: number;
  title: string;
  points: number;
  submissions: number;
  acSubmissions: number;
  /** 有至少一次 AC 的去重人数。 */
  acUsers: number;
  /** AC 提交率（0-100，保留一位小数）。 */
  acRate: number;
  averageScore: number;
  maxScore: number;
}

/** 比赛成绩报告：团队统计（仅团队赛）。 */
export interface ContestReportTeamStats {
  teamCount: number;
  rows: TeamRankingRow[];
}

/** GET /api/admin/contests/:id/report；个人榜已排除隐藏选手。 */
export interface ContestReport {
  generatedAt: number;
  contest: Contest;
  participants: ContestReportParticipantStats;
  submissions: ContestReportSubmissionStats;
  problems: ContestReportProblemStats[];
  ranking: OfficialRankingRow[];
  /** 应用 top 限制前的可见榜行数。 */
  rankingTotal: number;
  teamStats: ContestReportTeamStats | null;
}

/** WebSocket `ranking.delta` 载荷：只含变化行、全部名次与移除用户。 */
export interface RankingDelta {
  contestId: number;
  /** 生成该增量所基于的快照版本（大于客户端的旧快照版本）。 */
  version: number;
  changed: OfficialRankingRow[];
  ranks: Array<{ userId: number; rank: number }>;
  removed: number[];
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
  | 'promoted'
  | 'reverted';

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

export interface HackAuditItem {
  id: number;
  contest_id: number;
  problem_id: number;
  hacker_id: number;
  target_submission_id: number;
  status: HackStatus;
  verdict: Verdict | null;
  message: string;
  created_at: number;
  judged_at: number | null;
  hacker_username: string | null;
  target_username: string | null;
  target_real_name: string | null;
  problem_title: string;
  target_verdict: Verdict | null;
  target_score: number | null;
}

/** Phase A：排名规则配置与自定义插件。 */
export interface ContestRankingRuleConfig {
  preset?: string;
  tie?: 'same-rank' | 'none';
  hackWindowMinutes?: number;
  officialFreezeMinutesAfterHack?: number;
  cfLike?: {
    decay: number;
    hackPoints?: number;
    failedHackPenalty?: number;
  };
}

export interface ContestLockRecord {
  contest_id: number;
  user_id: number;
  problem_id: number;
  locked_at: number;
  username: string;
  real_name: string | null;
  problem_title: string;
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
  error?: { code?: string; message?: string; report?: QualityGateReport };
}

/** Phase Authoring：Data Plan 与生成任务。 */
export type DataPlanPointsMode = 'group' | 'per-test' | 'auto';

export interface DataPlanLimits {
  timeMs: number;
  memoryMb: number;
  outputMb: number;
}

export interface DataPlanGroup {
  id: string;
  name: string;
  points: number;
  count: number;
  seedStart: number;
  args: string[];
  dependsOn: string[];
}

export interface DataPlan {
  schema: 'oijudge.data-plan/1';
  limits: DataPlanLimits;
  groups: DataPlanGroup[];
  pointsMode: DataPlanPointsMode;
  naming: string;
}

export interface DataPlanIssue {
  path: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface DataPlanTotals {
  testCount: number;
  points: number;
  estimatedSeconds: number;
  estimatedBytes: number;
}

export interface DataPlanValidationResponse {
  valid: boolean;
  issues: DataPlanIssue[];
  totals: DataPlanTotals;
}

export type DataPlanTemplateId =
  | '10-30-60'
  | 'subtask-ladder'
  | 'extreme-random'
  | 'single-group';

export type GenerationJobStatus =
  | 'queued'
  | 'running'
  | 'finished'
  | 'published'
  | 'failed'
  | 'canceled';

export type GenerationCaseStatus =
  | 'pending'
  | 'running'
  | 'finished'
  | 'failed'
  | 'blocked'
  | 'canceled';

export interface GenerationJobCase {
  id: number;
  groupId: string;
  groupName: string;
  index: number;
  seed: number;
  status: GenerationCaseStatus;
  inputPath: string | null;
  outputPath: string | null;
  inputSha256: string | null;
  inputBytes: number;
  inputLines: number;
  inputUtf8: boolean;
  outputBytes: number;
  outputLines: number;
  stdExitCode: number | null;
  stdTimeMs: number;
  stdMemoryKb: number;
  validatorOk: boolean | null;
  validatorMessage: string;
  message: string;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface GenerationJobSummary {
  id: number;
  problemId: number;
  status: GenerationJobStatus;
  total: number;
  completed: number;
  failed: number;
  message: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface GenerationJobDetail extends GenerationJobSummary {
  planVersion: number;
  plan: DataPlan;
  stats: {
    totalCases?: number;
    maxTimeMs?: number;
    maxMemoryKb?: number;
    totalDiskBytes?: number;
    duplicateInputCount?: number;
    duplicateRate?: number;
  };
  cases: GenerationJobCase[];
}

export interface GenerationJobPreview {
  caseId: number;
  input: string;
  output: string;
  inputTruncated: boolean;
  outputTruncated: boolean;
  inputLines: number;
  outputLines: number;
  inputBytes: number;
  outputBytes: number;
}

/** Phase Authoring：发布质量门禁（与后端 quality-gates.ts 对齐）。 */
export type GateLevel = 'pass' | 'warn' | 'block';

export interface GateFinding {
  gate: string;
  level: GateLevel;
  message: string;
  detail?: Record<string, unknown>;
}

export interface QualityGateStats {
  totalCases: number;
  maxTimeMs: number;
  maxMemoryKb: number;
  duplicateInputCount: number;
  duplicateRate: number;
  totalDiskBytes: number;
}

export interface QualityGateReport {
  pass: boolean;
  findings: GateFinding[];
  stats: QualityGateStats;
}

/** POST /api/admin/problems/:id/generation-jobs/:jobId/publish 返回结构。 */
export interface PublishGenerationResult {
  testcases: number;
  subtasks: number;
  warnings: GateFinding[];
  report: QualityGateReport;
}

/** System Ops v1.1：系统诊断与备份。 */
export type DiagnosticStatus = 'pass' | 'warn' | 'fail';

export interface DiagnosticCheck {
  name: string;
  status: DiagnosticStatus;
  detail: string;
}

export interface DiagnosticsReport {
  ok: boolean;
  generatedAt: number;
  checks: DiagnosticCheck[];
  queue: { queued: number; running: number; failed: number };
}

export interface BackupEntry {
  id: string;
  path: string;
  createdAt: number;
  sizeBytes: number;
  manifest: Record<string, unknown>;
}

/** Settings Center v1.1：运行时设置（GET/PUT /api/admin/system/settings）。 */
export interface SystemSettingsEffective {
  host: string;
  port: number;
  judgeConcurrency: number;
  gxx: string;
  sessionTtlSec: number;
}

/** `settings.json` 中实际持久化的字段；未写入的字段为 undefined。 */
export interface SystemSettingsPersisted {
  host?: string;
  port?: number;
  judgeConcurrency?: number;
  gxx?: string;
  sessionTtlSec?: number;
}

export interface SystemSettings {
  effective: SystemSettingsEffective;
  persisted: SystemSettingsPersisted;
  /** 被环境变量覆盖的字段名（优先级高于 settings.json）。 */
  envOverrides: string[];
}

export type SystemSettingsPatch = Partial<SystemSettingsEffective>;

/** PUT /api/admin/system/settings 返回结构。 */
export interface SystemSettingsUpdateResult {
  settings: SystemSettings;
  restartRequired: true;
}

/** POST /api/admin/system/restore 返回结构（恢复仅在下次启动时应用）。 */
export interface RestoreRequestResult {
  backupId: string;
  requestedAt: number;
  restartRequired: true;
}

/** Teams v1.2：常驻团队。 */
export type TeamRole = 'captain' | 'member';

/** GET /api/teams 列表项。 */
export interface TeamSummary {
  id: number;
  name: string;
  ownerId: number;
  createdAt: number;
  memberCount: number;
  /** 当前用户在团队中的角色。 */
  role: TeamRole;
}

/** GET /api/admin/teams 全量团队搜索项（管理员/比赛管理员）。 */
export interface AdminTeamSummary {
  id: number;
  name: string;
  ownerId: number;
  memberCount: number;
  createdAt: number;
}

export interface TeamMember {
  userId: number;
  username: string;
  realName: string | null;
  className: string | null;
  role: TeamRole;
  joinedAt: number;
}

/** GET /api/teams/:id；members 仅团队成员与管理员可见。 */
export interface TeamDetail {
  id: number;
  name: string;
  ownerId: number;
  createdAt: number;
  /** 当前用户角色；非成员为 null。 */
  viewerRole: TeamRole | null;
  members?: TeamMember[];
}

export interface CreateTeamRequest {
  name: string;
}

export interface CreateTeamResult {
  id: number;
}

/** Classes：教学班级（后端 teams.kind='class'，与团队路由完全隔离）。 */
export type ClassRole = 'coach' | 'assistant' | 'member';

/** GET /api/classes 列表项；role 为当前用户在班级中的身份。 */
export interface ClassSummary {
  id: number;
  name: string;
  ownerId: number;
  kind: 'class';
  allowContest: boolean;
  createdAt: number;
  memberCount: number;
  role: ClassRole;
}

export interface ClassMember {
  userId: number;
  username: string;
  realName: string | null;
  className: string | null;
  role: ClassRole;
  joinedAt: number;
}

/** GET /api/classes/:id；members 仅班级成员与管理员可见。 */
export interface ClassDetail {
  id: number;
  name: string;
  ownerId: number;
  kind: 'class';
  allowContest: boolean;
  createdAt: number;
  /** 当前用户在班级中的身份；非成员为 null。 */
  viewerRole: ClassRole | null;
  members?: ClassMember[];
}

/** POST /api/admin/classes：仅管理员与比赛管理员可用。 */
export interface CreateClassRequest {
  name: string;
  allowContest?: boolean;
}

export interface CreateClassResult {
  id: number;
}

export interface AddClassMemberRequest {
  username: string;
  role?: ClassRole;
}

export interface AddClassCoachRequest {
  username: string;
}

/** Learning analytics：错题模式（与后端 learning-stats service 对齐）。 */
export type WrongProblemMode = 'never-ac' | 'latest-wrong';

/** 单个学生在某题上的聚合；bestVerdict 为最好一次提交的评测结果。 */
export interface StudentProblemStat {
  problemId: number;
  title: string;
  difficulty: number | null;
  tags: string[];
  attempts: number;
  wrongAttempts: number;
  bestScore: number;
  bestVerdict: Verdict | null;
  firstAcAt: number | null;
  lastSubmitAt: number;
}

/** 错题列表项：在题目聚合基础上附带最新一次提交的评测结果。 */
export interface StudentWrongProblem extends StudentProblemStat {
  lastVerdict: Verdict | null;
}

export interface StudentTagStat {
  tag: string;
  attempts: number;
  solved: number;
  totalProblems: number;
  lastAttemptAt: number;
}

export interface StudentDailyStat {
  date: string;
  submissions: number;
  acCount: number;
  points: number;
  /** 预留字段：当前后端没有活跃时长来源，固定为 0。 */
  activeSeconds: number;
}

/** GET /api/students/:id/stats 返回结构。 */
export interface StudentStats {
  userId: number;
  username: string;
  generatedAt: number;
  includeContest: boolean;
  summary: {
    attemptedProblems: number;
    solvedProblems: number;
    totalSubmissions: number;
    acSubmissions: number;
    wrongSubmissions: number;
    firstAcAt: number | null;
    lastActiveAt: number | null;
  };
  problems: StudentProblemStat[];
  tags: StudentTagStat[];
  daily: StudentDailyStat[];
}

/** GET /api/students/:id/wrong-problems 返回结构。 */
export interface StudentWrongProblems {
  userId: number;
  mode: WrongProblemMode;
  generatedAt: number;
  includeContest: boolean;
  problems: StudentWrongProblem[];
}

export interface ClassStudentSummary {
  userId: number;
  username: string;
  attemptedProblems: number;
  solvedProblems: number;
  totalSubmissions: number;
  lastActiveAt: number | null;
}

export interface ClassWeakTag {
  tag: string;
  attempts: number;
  solved: number;
  solveRate: number;
}

export interface ClassInactiveMember {
  userId: number;
  username: string;
  lastActiveAt: number | null;
}

export interface ClassWrongProblem {
  problemId: number;
  title: string;
  studentCount: number;
  attempts: number;
}

/** GET /api/classes/:id/learning-stats 返回结构；仅班级教练与管理员可读。 */
export interface ClassLearningStats {
  classId: number;
  className: string;
  generatedAt: number;
  includeContest: boolean;
  studentCount: number;
  activeStudentCount: number;
  completedProblems: number;
  attemptedProblems: number;
  totalSubmissions: number;
  students: ClassStudentSummary[];
  weakTags: ClassWeakTag[];
  inactiveMembers: ClassInactiveMember[];
  topWrongProblems: ClassWrongProblem[];
}

export interface AddTeamMemberRequest {
  username: string;
}

export interface TransferTeamCaptainRequest {
  userId: number;
}

/** 比赛团队报名：GET /api/contests/:id/teams 返回的成员。 */
export interface TeamRegistrationMember {
  userId: number;
  username: string;
  realName: string | null;
  className: string | null;
  role: TeamRole;
}

/** GET /api/contests/:id/teams 返回的已报名团队。 */
export interface TeamRegistration {
  teamId: number;
  name: string;
  ownerId: number;
  registeredBy: number | null;
  registeredAt: number;
  members: TeamRegistrationMember[];
}

/** Problem Sets：题单与分享（owner 可为个人或团队）。 */
export type ProblemSetOwnerType = 'user' | 'team';
export type ProblemSetVisibility = 'private' | 'public';
export type ProblemSetGranteeType = 'user' | 'team';
export type ProblemSetSharePermission = 'read' | 'edit';

/** GET /api/problem-sets 列表项；canEdit/canManage 由服务端按 ACL 计算。 */
export interface ProblemSetSummary {
  id: number;
  title: string;
  description: string;
  ownerType: ProblemSetOwnerType;
  ownerId: number;
  visibility: ProblemSetVisibility;
  createdBy: number;
  createdAt: number;
  updatedAt: number;
  itemCount: number;
  /** 可修改标题/描述/题目与顺序。 */
  canEdit: boolean;
  /** 可修改可见性、删除题单、管理分享。 */
  canManage: boolean;
}

export interface ProblemSetItem {
  problemId: number;
  ordinal: number;
  addedAt: number;
  title: string;
  type: ProblemType;
  difficulty: number | null;
  tags: string[];
  timeMs: number;
  memoryMb: number;
}

export interface ProblemSetShare {
  granteeType: ProblemSetGranteeType;
  granteeId: number;
  permission: ProblemSetSharePermission;
  createdBy: number;
  createdAt: number;
}

/** GET /api/problem-sets/:id；shares 仅 canManage 时返回。 */
export interface ProblemSetDetail extends ProblemSetSummary {
  items: ProblemSetItem[];
  shares: ProblemSetShare[];
}

export interface CreateProblemSetRequest {
  title: string;
  description?: string;
  ownerType: ProblemSetOwnerType;
  ownerId?: number;
  visibility: ProblemSetVisibility;
}

export interface CreateProblemSetResult {
  id: number;
}

export interface UpdateProblemSetRequest {
  title?: string;
  description?: string;
  visibility?: ProblemSetVisibility;
}

export interface AddProblemSetItemRequest {
  problemId: number;
}

export interface ReorderProblemSetItemsRequest {
  problemIds: number[];
}

export interface AddProblemSetShareRequest {
  granteeType: ProblemSetGranteeType;
  granteeId: number;
  permission: ProblemSetSharePermission;
}

/** Awards：比赛奖项与证书（GET /api/contests/:id/awards）。 */
export type AwardLevel = 'gold' | 'silver' | 'bronze' | 'participation';

/** 奖项口径：个人奖按正式榜，团队奖按团队榜。 */
export type AwardScope = 'individual' | 'team';

/** 金/银/铜奖人数百分比；三项之和不超过 100。 */
export interface AwardConfig {
  goldPercent: number;
  silverPercent: number;
  bronzePercent: number;
}

/** 正式榜中的一行奖项数据；未获奖的行 award 为 null（开启参赛证书后为 participation）。 */
export interface AwardRow {
  rank: number;
  userId: number;
  username: string;
  realName: string | null;
  className: string | null;
  totalScore: number;
  solved: number;
  award: AwardLevel | null;
  certificateNo: string;
}

/** 团队榜中的一行奖项数据；未获奖的行 award 为 null（开启参赛证书后为 participation）。 */
export interface TeamAwardRow {
  rank: number;
  teamId: number;
  teamName: string;
  memberCount: number;
  totalScore: number;
  solved: number;
  award: AwardLevel | null;
  certificateNo: string;
}

export interface AwardCounts {
  gold: number;
  silver: number;
  bronze: number;
  /** 参赛证书数量（仅在请求 participation 时为非零）。 */
  participation: number;
  /** 获奖总人数/队数（金 + 银 + 铜，不含参赛证书）。 */
  total: number;
}

/** GET /api/contests/:id/awards 与 GET /api/admin/contests/:id/awards 的返回结构。 */
export interface ContestAwards {
  contest: Contest;
  config: AwardConfig;
  rows: AwardRow[];
  counts: AwardCounts;
  scope: 'individual';
}

/** GET /api/contests/:id/awards?scope=team 的返回结构。 */
export interface TeamContestAwards {
  contest: Contest;
  config: AwardConfig;
  rows: TeamAwardRow[];
  counts: AwardCounts;
  scope: 'team';
}

/** Training Plans：训练计划（班级/团队共用的 group）。 */
export type TrainingPlanGroupKind = 'team' | 'class';

/** 单个训练题目的完成状态（由后端按提交与目标分计算）。 */
export type TrainingPlanItemStatus = 'completed' | 'pending' | 'overdue';

export interface TrainingPlanProgressSummary {
  itemCount: number;
  completedCount: number;
  lateCount: number;
  overdueCount: number;
  allCompleted: boolean;
}

/** GET /api/training-plans/:id 返回的题目。 */
export interface TrainingPlanItem {
  id: number;
  problemId: number;
  ordinal: number;
  targetScore: number;
  dueAt: number | null;
  createdAt: number;
  title: string;
  type: ProblemType;
  difficulty: number | null;
  tags: string[];
  timeMs: number;
  memoryMb: number;
}

/** 当前用户（或成员）在某道训练题上的进度。 */
export interface TrainingPlanItemProgress {
  itemId: number;
  problemId: number;
  ordinal: number;
  targetScore: number;
  dueAt: number | null;
  bestScore: number | null;
  accepted: boolean;
  completed: boolean;
  completedAt: number | null;
  late: boolean;
  status: TrainingPlanItemStatus;
}

/** GET /api/training-plans 列表项。 */
export interface TrainingPlanSummary {
  id: number;
  groupId: number;
  groupName: string;
  groupKind: TrainingPlanGroupKind;
  title: string;
  description: string;
  startsAt: number | null;
  endsAt: number | null;
  createdBy: number;
  createdAt: number;
  updatedAt: number;
  itemCount: number;
  canManage: boolean;
  myProgress: TrainingPlanProgressSummary;
}

/** 管理者可见的成员进度；items 与计划题目一一对应。 */
export interface TrainingPlanMemberProgress extends TrainingPlanProgressSummary {
  userId: number;
  username: string;
  realName: string | null;
  className: string | null;
  role: string;
  items: TrainingPlanItemProgress[];
}

/** GET /api/training-plans/:id；memberProgress 仅管理者可见。 */
export interface TrainingPlanDetail extends TrainingPlanSummary {
  items: TrainingPlanItem[];
  myItems: TrainingPlanItemProgress[];
  memberProgress?: TrainingPlanMemberProgress[];
}

/** GET /api/training-plans/:id/progress（管理者）。 */
export interface TrainingPlanProgress {
  planId: number;
  title: string;
  items: TrainingPlanItem[];
  members: TrainingPlanMemberProgress[];
}

export interface CreateTrainingPlanItemRequest {
  problemId: number;
  /** 省略时后端取题目满分。 */
  targetScore?: number;
  dueAt?: number | null;
}

export interface CreateTrainingPlanRequest {
  groupId: number;
  title: string;
  description?: string;
  startsAt?: number | null;
  endsAt?: number | null;
  items?: CreateTrainingPlanItemRequest[];
}

export interface CreateTrainingPlanResult {
  id: number;
}

export interface UpdateTrainingPlanRequest {
  title?: string;
  description?: string;
  startsAt?: number | null;
  endsAt?: number | null;
}

export interface AddTrainingPlanItemRequest {
  problemId: number;
  /** 省略时后端取题目满分。 */
  targetScore?: number;
  dueAt?: number | null;
}

export interface ReorderTrainingPlanItemsRequest {
  itemIds: number[];
}
