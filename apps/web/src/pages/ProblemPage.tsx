import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiGet, apiPost } from '../api/client';
import type {
  AnswerFile,
  Contest,
  HackJob,
  HackHistoryItem,
  HackSource,
  HackTarget,
  ObjectiveAnswerValue,
  ProblemDetail,
  Submission,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { CodeBlock } from '../components/CodeBlock';
import { MetaList } from '../components/MetaList';
import { ObjectiveAnswerForm } from '../components/ObjectiveAnswerForm';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { ProblemSharePanel } from '../components/ProblemSharePanel';
import { StatementHtml } from '../components/StatementHtml';
import { SubmissionTable } from '../components/SubmissionTable';
import { formatDateTime, formatMemoryLimit, formatTimeLimit } from '../utils/format';
import { fetchOfficialRanking } from '../utils/officialRanking';
import {
  difficultyLabel,
  problemLetter,
  problemTypeLabel,
  verdictTitle,
} from '../utils/status';
import '../styles/objective.css';
import '../styles/output.css';

const DEFAULT_CODE = `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    // 在此编写你的代码

    return 0;
}
`;

function readDraft(problemKey: string): string | null {
  try {
    return window.localStorage.getItem(`oij:draft:${problemKey}`);
  } catch {
    return null;
  }
}

function writeDraft(problemKey: string, code: string): void {
  try {
    window.localStorage.setItem(`oij:draft:${problemKey}`, code);
  } catch {
    // 本地草稿不可用不影响提交。
  }
}

export function ProblemPage() {
  const params = useParams<{ contestId?: string; problemId: string }>();
  // The URL accepts both the internal numeric id (legacy links) and the
  // Luogu-style display id (P1001). The API resolves either form.
  const problemRef = (params.problemId ?? '').trim();
  const contestId = params.contestId ? Number(params.contestId) : null;
  const validProblem = problemRef.length > 0;
  const validContest = contestId === null || (Number.isInteger(contestId) && contestId > 0);

  const { user } = useAuth();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState('statement');
  const [objectiveAnswers, setObjectiveAnswers] = useState<
    Record<number, ObjectiveAnswerValue>
  >({});
  const [outputAnswers, setOutputAnswers] = useState<Record<number, string>>({});
  const [locking, setLocking] = useState(false);
  const [sourceTarget, setSourceTarget] = useState<HackTarget | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [source, setSource] = useState<HackSource | null>(null);
  const [hackTarget, setHackTarget] = useState<HackTarget | null>(null);
  const [hackInput, setHackInput] = useState('');
  const [hackSubmitting, setHackSubmitting] = useState(false);
  const [hackError, setHackError] = useState<string | null>(null);
  const [activeHackId, setActiveHackId] = useState<number | null>(null);
  const [hackResult, setHackResult] = useState<HackJob | null>(null);
  const [promotingHackId, setPromotingHackId] = useState<number | null>(null);
  const [revertingHackId, setRevertingHackId] = useState<number | null>(null);
  const [code, setCode] = useState<string>(
    () => (validProblem ? readDraft(problemRef) : null) ?? DEFAULT_CODE,
  );
  const lastProblemRef = useRef(problemRef);

  useEffect(() => {
    if (lastProblemRef.current === problemRef) return;
    lastProblemRef.current = problemRef;
    setCode(readDraft(problemRef) ?? DEFAULT_CODE);
    setObjectiveAnswers({});
    setOutputAnswers({});
  }, [problemRef]);

  const problemQuery = useQuery({
    queryKey: ['problem', problemRef],
    queryFn: () => apiGet<ProblemDetail>(`/api/problems/${encodeURIComponent(problemRef)}`),
    enabled: validProblem,
  });
  const problem = problemQuery.data;
  /** Internal id: every follow-up API (submissions, hacks, drafts) uses it. */
  const problemId = problem?.id ?? null;
  const draftKey = problemId !== null ? String(problemId) : problemRef;
  const lastDraftKey = useRef(draftKey);

  useEffect(() => {
    if (lastDraftKey.current === draftKey) return;
    lastDraftKey.current = draftKey;
    // Once the internal id is known, share the draft with legacy numeric URLs.
    if (problemId !== null) setCode(readDraft(draftKey) ?? DEFAULT_CODE);
  }, [draftKey, problemId]);

  useEffect(() => {
    if (validProblem) writeDraft(draftKey, code);
  }, [draftKey, code, validProblem]);
  const contestsQuery = useQuery({
    queryKey: ['contests'],
    queryFn: () => apiGet<Contest[]>('/api/contests'),
    enabled: contestId !== null,
    staleTime: 60_000,
  });
  const contest =
    contestId !== null ? (contestsQuery.data?.find((item) => item.id === contestId) ?? null) : null;
  const contestEnded =
    contest !== null &&
    (contest.status === 'ended' ||
      contest.status === 'archived' ||
      (contest.end_at !== null && Date.now() >= contest.end_at));
  // 题号来自正式榜的题目顺序（official-ranking 与比赛页/正式榜同源）。
  const rankingQuery = useQuery({
    queryKey: ['official-ranking', contestId],
    queryFn: () => fetchOfficialRanking(contestId as number),
    enabled: contestId !== null && validContest,
    staleTime: 5_000,
    retry: false,
  });
  const submissionsQuery = useQuery({
    queryKey: ['submissions', { scope: 'mine', problemId, contestId }],
    queryFn: () =>
      apiGet<Submission[]>(
        `/api/submissions?userId=me&limit=20&problemId=${problemId}${
          contestId === null ? '' : `&contestId=${contestId}`
        }`,
      ),
    enabled: problemId !== null && Boolean(user),
  });
  const answerFilesQuery = useQuery({
    queryKey: ['answer-files', problemId],
    queryFn: () => apiGet<AnswerFile[]>(`/api/problems/${problemId}/answer-files`),
    enabled: problemId !== null && problem?.type === 'output-only',
  });
  const hackTargetsQuery = useQuery({
    queryKey: ['hack-targets', contestId, problemId],
    queryFn: async (): Promise<{ locked: boolean; targets: HackTarget[] }> => {
      try {
        const targets = await apiGet<HackTarget[]>(
          `/api/contests/${contestId}/problems/${problemId}/targets`,
        );
        return { locked: true, targets };
      } catch (error) {
        if (error instanceof ApiError && error.code === 'LOCK_REQUIRED') {
          return { locked: false, targets: [] };
        }
        throw error;
      }
    },
    enabled:
      contestId !== null &&
      problemId !== null &&
      Boolean(user) &&
      !contestEnded,
    retry: false,
  });
  const hackStatusQuery = useQuery({
    queryKey: ['hack-status', contestId, activeHackId],
    queryFn: () => apiGet<HackJob>(`/api/contests/${contestId}/hacks/${activeHackId}`),
    enabled: contestId !== null && problemId !== null && activeHackId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'queued' || status === 'judging' ? 1_000 : false;
    },
  });
  const hackLocked = hackTargetsQuery.data?.locked ?? false;
  const canModerate = user?.role === 'admin' || user?.role === 'contestmanager';
  const hackHistoryQuery = useQuery({
    queryKey: ['hack-history', contestId, problemId],
    queryFn: () =>
      apiGet<HackHistoryItem[]>(`/api/contests/${contestId}/problems/${problemId}/hacks`),
    enabled:
      contestId !== null &&
      problemId !== null &&
      !contestEnded &&
      Boolean(user) &&
      (hackLocked || canModerate),
    retry: false,
    refetchInterval: (query) => {
      const rows = query.state.data;
      return rows?.some(
        (row) => row.status === 'queued' || row.status === 'judging',
      )
        ? 2_000
        : false;
    },
  });

  useEffect(() => {
    const status = hackStatusQuery.data?.status;
    if (
      status === 'success' ||
      status === 'failed' ||
      status === 'invalid' ||
      status === 'unjudgeable' ||
      status === 'promoted'
    ) {
      if (hackStatusQuery.data) setHackResult(hackStatusQuery.data);
      void queryClient.invalidateQueries({ queryKey: ['hack-targets', contestId, problemId] });
      void queryClient.invalidateQueries({ queryKey: ['hack-history', contestId, problemId] });
      void queryClient.invalidateQueries({ queryKey: ['official-ranking', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['correction-ranking', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['submissions'] });
    }
  }, [hackStatusQuery.data, queryClient, contestId, problemId]);

  useEffect(() => {
    if (
      (problemQuery.data?.type === 'objective' ||
        problemQuery.data?.type === 'output-only') &&
      activeTab === 'submit'
    ) {
      setActiveTab('statement');
    }
  }, [problemQuery.data?.type, activeTab]);

  const submitMutation = useMutation({
    mutationFn: (payload: { language: string; code: string }) => {
      if (problemId === null) return Promise.reject(new Error('题目尚未加载'));
      return apiPost<{ id: number; status: string }>('/api/submissions', {
        problemId,
        language: payload.language,
        code: payload.code,
        contestId,
      });
    },
    onSuccess: (data) => {
      message.success(`提交 #${data.id} 已提交`);
      void queryClient.invalidateQueries({ queryKey: ['submissions'] });
      navigate(`/submissions/${data.id}`);
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : '提交失败');
    },
  });

  const contestProblem = rankingQuery.data?.problems.find(
    (item) => item.id === problemId,
  );
  const letter =
    contestProblem !== undefined ? problemLetter(contestProblem.ordinal - 1) : null;

  const problemUrlRef = problem?.displayId || problemRef;
  const loginHref = `/login?next=${encodeURIComponent(
    contestId !== null
      ? `/contest/${contestId}/problem/${problemId ?? problemRef}`
      : `/problem/${problemUrlRef}`,
  )}`;

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const target = event.currentTarget;
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? start;
    const next = `${code.slice(0, start)}  ${code.slice(end)}`;
    setCode(next);
    window.requestAnimationFrame(() => {
      target.selectionStart = start + 2;
      target.selectionEnd = start + 2;
    });
  };

  if (!validProblem) {
    return <ErrorResult error={new Error('无效的题目编号')} />;
  }
  if (problemQuery.isPending) {
    return <PageLoading tip="正在加载题面…" />;
  }
  if (problemQuery.isError) {
    return (
      <ErrorResult error={problemQuery.error} onRetry={() => void problemQuery.refetch()} />
    );
  }
  if (!problem) {
    return <PageLoading tip="正在加载题面…" />;
  }
  const isObjective = problem.type === 'objective';
  const objectiveQuestions = problem.objective?.questions ?? [];
  const objectiveTotal = objectiveQuestions.reduce(
    (sum, question) => sum + Number(question.points || 0),
    0,
  );
  const answeredObjectiveCount = objectiveQuestions.filter((question) => {
    const value = objectiveAnswers[question.id];
    return Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim().length > 0;
  }).length;

  const submitObjective = () => {
    const answers = objectiveQuestions.flatMap((question) => {
      const value = objectiveAnswers[question.id];
      if (value === undefined) return [];
      if (typeof value === 'string') {
        if (value.trim().length === 0) return [];
      } else if (value.length === 0) {
        return [];
      }
      return [{ questionId: question.id, value }];
    });
    if (answers.length === 0) {
      message.warning('请至少作答一题');
      return;
    }
    submitMutation.mutate({
      language: 'objective',
      code: JSON.stringify({ answers }),
    });
  };

  const isOutputOnly = problem.type === 'output-only';
  const answerFiles = answerFilesQuery.data ?? [];
  const answerFilesTotal = answerFiles.reduce((sum, file) => sum + file.points, 0);
  const answeredOutputCount = answerFiles.filter(
    (file) => (outputAnswers[file.id] ?? '').trim().length > 0,
  ).length;

  const submitOutputOnly = () => {
    if (answerFiles.length === 0) {
      message.warning('本题还没有可作答的测试点');
      return;
    }
    const missing = answerFiles.filter(
      (file) => (outputAnswers[file.id] ?? '').trim().length === 0,
    );
    if (missing.length > 0) {
      message.warning(`请先填写所有测试点的答案（还差 ${missing.length} 个）`);
      return;
    }
    const answers = answerFiles.map((file) => ({
      testcaseId: file.id,
      value: outputAnswers[file.id] ?? '',
    }));
    submitMutation.mutate({
      language: 'answer',
      code: JSON.stringify({ answers }),
    });
  };

  const statementPanel = (
    <div className="stack">
      <Card className="oij-card statement-card">
        <StatementHtml html={problem.statementHtml} />
      </Card>
      {contestEnded ? (
        <Alert
          className="ranking-freeze"
          type="warning"
          showIcon
          message="赛后订正模式"
          description="提交只计入订正榜，不影响正式榜。"
        />
      ) : null}
      {problem.ioMode === 'file' ? (
        <Alert
          type="info"
          showIcon
          message={`本题使用文件 IO：输入文件 ${problem.inputFile ?? '—'}，输出文件 ${
            problem.outputFile ?? '—'
          }`}
        />
      ) : null}
      {problem.type === 'interactive' ? (
        <Alert
          type="info"
          showIcon
          message="交互题：你的程序通过 stdin/stdout 与交互器实时交互，请按题面协议读写并刷新输出。"
        />
      ) : null}
      {problem.samples.length > 0 ? (
        <Card className="oij-card" title="样例">
          <div className="stack">
            {problem.samples.map((sample, index) => (
              <div className="sample" key={index}>
                <div className="sample-title">样例 {index + 1}</div>
                <div className="sample-grid">
                  <div>
                    <div className="sample-label">输入</div>
                    <pre className="sample-pre">{sample.input}</pre>
                  </div>
                  <div>
                    <div className="sample-label">输出</div>
                    <pre className="sample-pre">{sample.output}</pre>
                  </div>
                </div>
                {sample.explanation ? (
                  <div className="sample-explanation">说明：{sample.explanation}</div>
                ) : null}
              </div>
            ))}
          </div>
        </Card>
      ) : null}
      {isObjective ? (
        !user ? (
          <Card className="oij-card">
            <Empty description="登录后即可作答">
              <Link to={loginHref}>
                <Button type="primary">去登录</Button>
              </Link>
            </Empty>
          </Card>
        ) : (
          <Card
            className="oij-card objective-answer-card"
            title="作答"
            extra={
              <span className="muted">
                已作答 {answeredObjectiveCount} / {objectiveQuestions.length} 题 · 总分{' '}
                {objectiveTotal} 分
              </span>
            }
          >
            <ObjectiveAnswerForm
              questions={objectiveQuestions}
              answers={objectiveAnswers}
              onChange={(questionId, value) =>
                setObjectiveAnswers((previous) => ({ ...previous, [questionId]: value }))
              }
              disabled={submitMutation.isPending}
            />
            <div className="objective-answer-footer">
              <span className="objective-answer-summary">
                单选/判断点击选项，多选可勾选多个；填空提交后由后端统一评分。
              </span>
              <Button
                type="primary"
                onClick={submitObjective}
                loading={submitMutation.isPending}
                disabled={answeredObjectiveCount === 0}
              >
                提交答案
              </Button>
            </div>
          </Card>
        )
      ) : null}
      {isOutputOnly ? (
        !user ? (
          <Card className="oij-card">
            <Empty description="登录后即可提交答案">
              <Link to={loginHref}>
                <Button type="primary">去登录</Button>
              </Link>
            </Empty>
          </Card>
        ) : (
          <Card
            className="oij-card"
            title="提交答案题"
            extra={
              <span className="muted">
                已填写 {answeredOutputCount} / {answerFiles.length} 个测试点 · 总分{' '}
                {answerFilesTotal} 分
              </span>
            }
          >
            <Alert
              className="answer-file-note"
              type="info"
              showIcon
              message="本题为提交答案题"
              description="无需编写程序。请下载每个测试点的输入文件，计算后在对应文本框填写输出；全部填写后提交。"
            />
            {answerFilesQuery.isPending ? (
              <div className="inline-loading">
                <Spin />
              </div>
            ) : answerFilesQuery.isError ? (
              <ErrorResult
                error={answerFilesQuery.error}
                onRetry={() => void answerFilesQuery.refetch()}
              />
            ) : answerFiles.length === 0 ? (
              <Empty description="本题还没有可作答的测试点" />
            ) : (
              <>
                <div className="answer-file-list">
                  {answerFiles.map((file) => (
                    <div className="answer-file-item" key={file.id}>
                      <div className="answer-file-head">
                        <span className="answer-file-index">
                          测试点 {file.ordinal}
                        </span>
                        <a
                          className="answer-download"
                          href={file.inputUrl}
                          download
                        >
                          下载输入
                        </a>
                        <span className="answer-file-points">{file.points} 分</span>
                      </div>
                      <Input.TextArea
                        className="answer-file-input"
                        value={outputAnswers[file.id] ?? ''}
                        onChange={(event) =>
                          setOutputAnswers((previous) => ({
                            ...previous,
                            [file.id]: event.target.value,
                          }))
                        }
                        placeholder="填写该测试点的输出"
                        autoSize={{ minRows: 3, maxRows: 10 }}
                        disabled={submitMutation.isPending}
                      />
                    </div>
                  ))}
                </div>
                <div className="answer-submit-footer">
                  <span className="answer-submit-summary">
                    输出比较遵循题目比较模式；未填写全部测试点不能提交。
                  </span>
                  <Button
                    type="primary"
                    onClick={submitOutputOnly}
                    loading={submitMutation.isPending}
                    disabled={
                      answerFiles.length === 0 ||
                      answeredOutputCount < answerFiles.length
                    }
                  >
                    提交答案
                  </Button>
                </div>
              </>
            )}
          </Card>
        )
      ) : null}
    </div>
  );

  const hackTargets = hackTargetsQuery.data?.targets ?? [];

  const lockProblem = async () => {
    if (contestId === null || problemId === null) return;
    setLocking(true);
    try {
      await apiPost<{ locked: boolean }>(
        `/api/contests/${contestId}/problems/${problemId}/lock`,
      );
      message.success('本题已锁定：不能继续提交，可查看他人源码与 Hack');
      void queryClient.invalidateQueries({
        queryKey: ['hack-targets', contestId, problemId],
      });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '锁定题目失败');
    } finally {
      setLocking(false);
    }
  };

  const openSource = async (target: HackTarget) => {
    if (contestId === null || problemId === null) return;
    setSourceTarget(target);
    setSource(null);
    setSourceLoading(true);
    try {
      const result = await apiGet<HackSource>(
        `/api/contests/${contestId}/problems/${problemId}/submissions/${target.id}/source`,
      );
      setSource(result);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载源码失败');
    } finally {
      setSourceLoading(false);
    }
  };

  const openHack = (target: HackTarget) => {
    setHackTarget(target);
    setHackInput('');
    setHackError(null);
    setActiveHackId(null);
    setHackResult(null);
  };

  const submitHack = async () => {
    if (contestId === null || problemId === null || !hackTarget) return;
    if (hackInput.length === 0) {
      setHackError('请输入 Hack 测试数据');
      return;
    }
    setHackSubmitting(true);
    setHackError(null);
    setHackResult(null);
    try {
      const result = await apiPost<{ id: number; status: string }>(
        `/api/contests/${contestId}/problems/${problemId}/hacks`,
        { targetSubmissionId: hackTarget.id, input: hackInput },
      );
      setActiveHackId(result.id);
      message.success(`Hack #${result.id} 已提交，正在评测`);
    } catch (error) {
      setHackError(error instanceof Error ? error.message : 'Hack 提交失败');
    } finally {
      setHackSubmitting(false);
    }
  };

  const hackStatusLabel: Record<string, string> = {
    queued: '排队中',
    judging: '评测中',
    success: 'Hack 成功',
    failed: 'Hack 失败',
    invalid: '输入无效',
    unjudgeable: '无法评测',
    promoted: 'HACKED',
    reverted: '已撤销',
  };
  const hackStatusColor: Record<string, string> = {
    queued: 'blue',
    judging: 'blue',
    success: 'green',
    failed: 'default',
    invalid: 'orange',
    unjudgeable: 'default',
    promoted: 'red',
    reverted: 'default',
  };

  const promoteHack = async (hackId: number) => {
    if (contestId === null) return;
    setPromotingHackId(hackId);
    try {
      await apiPost<{ id: number; status: string }>(
        `/api/admin/contests/${contestId}/hacks/${hackId}/promote`,
      );
      message.success('已强制晋升为 HACKED，正式分已重算');
      void queryClient.invalidateQueries({ queryKey: ['hack-history', contestId, problemId] });
      void queryClient.invalidateQueries({ queryKey: ['hack-targets', contestId, problemId] });
      void queryClient.invalidateQueries({ queryKey: ['official-ranking', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['correction-ranking', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['submissions'] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '强制晋升失败');
    } finally {
      setPromotingHackId(null);
    }
  };

  const revertHack = async (hackId: number) => {
    if (contestId === null) return;
    setRevertingHackId(hackId);
    try {
      await apiPost<{ id: number; status: string }>(
        `/api/admin/contests/${contestId}/hacks/${hackId}/revert`,
      );
      message.success('已撤销 HACKED，正式分已重算');
      void queryClient.invalidateQueries({ queryKey: ['hack-history', contestId, problemId] });
      void queryClient.invalidateQueries({ queryKey: ['hack-targets', contestId, problemId] });
      void queryClient.invalidateQueries({ queryKey: ['official-ranking', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['correction-ranking', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['submissions'] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '撤销 HACKED 失败');
    } finally {
      setRevertingHackId(null);
    }
  };

  const hackHistory = hackHistoryQuery.data ?? [];
  const hackHistoryColumns: TableColumnsType<HackHistoryItem> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
    },
    {
      title: 'Hacker',
      dataIndex: 'hackerId',
      width: 110,
      render: (value: number) => <span className="mono">用户 #{value}</span>,
    },
    {
      title: '目标提交',
      dataIndex: 'targetSubmissionId',
      width: 110,
      render: (value: number) => <span className="mono">#{value}</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 120,
      render: (value: HackHistoryItem['status']) =>
        value === 'success' || value === 'promoted' ? (
          <span className="hack-hacked-label">HACKED</span>
        ) : (
          <Tag color={hackStatusColor[value] ?? 'default'}>
            {hackStatusLabel[value] ?? value}
          </Tag>
        ),
    },
    {
      title: 'Verdict',
      dataIndex: 'verdict',
      width: 90,
      render: (value: HackHistoryItem['verdict']) =>
        value ? <Tag>{value}</Tag> : <span className="muted">—</span>,
    },
    {
      title: '信息',
      dataIndex: 'message',
      render: (value: string) =>
        value ? (
          <span className="test-message" title={value}>
            {value}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    ...(canModerate
      ? [
          {
            title: '',
            width: 120,
            render: (_value: unknown, row: HackHistoryItem) => {
              if (row.status === 'failed' || row.status === 'queued') {
                return (
                  <Popconfirm
                    title="强制晋升为 HACKED？"
                    description="会标记目标提交为 HACKED 并重算正式分。"
                    okText="晋升"
                    cancelText="取消"
                    onConfirm={() => void promoteHack(row.id)}
                  >
                    <Button size="small" danger loading={promotingHackId === row.id}>
                      强制晋升
                    </Button>
                  </Popconfirm>
                );
              }
              if (row.status === 'success' || row.status === 'promoted') {
                return (
                  <Popconfirm
                    title="撤销 HACKED？"
                    description="清除目标提交的 HACKED 状态并按剩余提交重算正式分。"
                    okText="撤销"
                    cancelText="取消"
                    onConfirm={() => void revertHack(row.id)}
                  >
                    <Button size="small" loading={revertingHackId === row.id}>
                      撤销
                    </Button>
                  </Popconfirm>
                );
              }
              return null;
            },
          },
        ]
      : []),
  ];

  const hackHistoryTable = (
    <div className="hack-history">
      <div className="batch-preview-head">
        <span>Hack 记录</span>
        <span className="muted">{hackHistory.length} 条</span>
      </div>
      {hackHistoryQuery.isPending ? (
        <div className="inline-loading">
          <Spin />
        </div>
      ) : hackHistoryQuery.isError ? (
        <Alert
          type="error"
          showIcon
          message="Hack 记录加载失败"
          description={
            hackHistoryQuery.error instanceof Error
              ? hackHistoryQuery.error.message
              : undefined
          }
        />
      ) : hackHistory.length === 0 ? (
        <Empty description="还没有 Hack 记录" />
      ) : (
        <Table<HackHistoryItem>
          className="oij-table hack-history-table"
          rowKey="id"
          size="small"
          columns={hackHistoryColumns}
          dataSource={hackHistory}
          pagination={false}
        />
      )}
    </div>
  );

  const hackTargetColumns: TableColumnsType<HackTarget> = [
    {
      title: '目标提交',
      dataIndex: 'id',
      width: 100,
      render: (value: number) => <span className="mono">#{value}</span>,
    },
    {
      title: '选手',
      dataIndex: 'userId',
      width: 110,
      render: (value: number) => <span className="mono">用户 #{value}</span>,
    },
    {
      title: 'Verdict',
      dataIndex: 'verdict',
      width: 100,
      render: (value: HackTarget['verdict']) =>
        value ? <Tag>{value}</Tag> : <span className="muted">—</span>,
    },
    {
      title: '得分',
      dataIndex: 'score',
      width: 80,
      align: 'right',
      render: (value: number) => <span className="score-value">{value}</span>,
    },
    {
      title: '提交时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
    },
    {
      title: '',
      width: 170,
      render: (_value, row) => (
        <Space size={6}>
          <Button size="small" onClick={() => void openSource(row)}>
            查看源码
          </Button>
          <Button size="small" type="primary" onClick={() => openHack(row)}>
            Hack
          </Button>
        </Space>
      ),
    },
  ];

  const hackPanel =
    contestId !== null &&
    !contestEnded &&
    problem.type !== 'objective' &&
    problem.type !== 'output-only' ? (
      !user ? (
        <Card className="oij-card">
          <Empty description="登录且报名比赛后可锁定本题并 Hack" />
        </Card>
      ) : hackTargetsQuery.isPending ? (
        <Card className="oij-card" title="Hack 模式">
          <div className="inline-loading">
            <Spin />
          </div>
        </Card>
      ) : hackTargetsQuery.isError ? (
        <Card className="oij-card" title="Hack 模式">
          <ErrorResult
            error={hackTargetsQuery.error}
            onRetry={() => void hackTargetsQuery.refetch()}
          />
        </Card>
      ) : !hackLocked ? (
        <Card className="oij-card" title="Hack 模式">
          <Alert
            type="info"
            showIcon
            message="锁定本题后才能查看他人源码并 Hack"
            description="锁题后本题不能再提交；锁定状态刷新后保持。请确认已提交自己的最终版本后再锁定。"
          />
          <div className="hack-lock-row">
            <Popconfirm
              title="锁定本题？"
              description="锁定后本题不能再提交，且刷新后仍保持锁定。"
              okText="锁定"
              cancelText="取消"
              onConfirm={() => void lockProblem()}
            >
              <Button type="primary" danger loading={locking}>
                锁定本题
              </Button>
            </Popconfirm>
          </div>
          {canModerate ? hackHistoryTable : null}
        </Card>
      ) : (
        <Card
          className="oij-card"
          title="Hack 模式"
          extra={<Tag color="red">已锁定 · 不可提交</Tag>}
        >
          <Alert
            type="warning"
            showIcon
            message="本题已锁定"
            description="不能再提交本题；可查看他人源码，提交 Hack 测试数据。"
          />
          {hackTargets.length === 0 ? (
            <Empty description="暂无可 Hack 的目标提交" />
          ) : (
            <Table<HackTarget>
              className="oij-table hack-targets-table"
              rowKey="id"
              size="small"
              columns={hackTargetColumns}
              dataSource={hackTargets}
              pagination={false}
            />
          )}
          {hackHistoryTable}
        </Card>
      )
    ) : null;

  const hackStatus = hackResult ?? hackStatusQuery.data;
  const hackBusy =
    activeHackId !== null &&
    (!hackStatus || hackStatus.status === 'queued' || hackStatus.status === 'judging');

  const submitPanel = !user ? (
    <Card className="oij-card">
      <Empty description="登录后即可提交代码">
        <Link to={loginHref}>
          <Button type="primary">去登录</Button>
        </Link>
      </Empty>
    </Card>
  ) : (
    <div className="stack">
      {hackPanel}
      <Card
        className="oij-card"
        title="提交 C++17 代码"
        extra={<span className="muted">{code.length} 字符 / 上限 256 KB</span>}
      >
        {hackLocked ? (
          <Alert
            className="ranking-freeze"
            type="warning"
            showIcon
            message="本题已锁定，不能继续提交"
            description="锁定后不可提交；可在上方 Hack 面板查看他人源码并提交 Hack。"
          />
        ) : null}
        {contestEnded ? (
          <Alert
            className="ranking-freeze"
            type="warning"
            showIcon
            message="赛后订正模式"
            description="提交只计入订正榜，不影响正式榜。"
          />
        ) : null}
        <div className="submit-toolbar">
          <Space size={8} align="center">
            <span className="muted">语言</span>
            <Select
              value="cpp17"
              options={[{ value: 'cpp17', label: 'C++17' }]}
              style={{ width: 120 }}
              disabled
            />
          </Space>
          <span className="muted">编译选项：g++ -O2 -std=c++17 -static</span>
        </div>
        <Input.TextArea
          className="code-editor"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          onKeyDown={handleEditorKeyDown}
          rows={18}
          spellCheck={false}
          style={{
            fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
            fontSize: 13,
            lineHeight: 1.6,
          }}
        />
        <div className="submit-footer">
          <Popconfirm
            title="清空当前代码？"
            description="会恢复为默认模板，本地草稿也会被覆盖。"
            okText="清空"
            cancelText="取消"
            onConfirm={() => setCode(DEFAULT_CODE)}
          >
            <Button>重置代码</Button>
          </Popconfirm>
          <Button
            type="primary"
            onClick={() => submitMutation.mutate({ language: 'cpp17', code })}
            loading={submitMutation.isPending}
            disabled={code.trim().length === 0 || hackLocked}
          >
            提交评测
          </Button>
        </div>
      </Card>
    </div>
  );

  const submissionsPanel = !user ? (
    <Card className="oij-card">
      <Empty description="登录后查看我的提交">
        <Link to={loginHref}>
          <Button type="primary">去登录</Button>
        </Link>
      </Empty>
    </Card>
  ) : submissionsQuery.isPending ? (
    <Card className="oij-card">
      <div className="inline-loading">
        <Spin />
      </div>
    </Card>
  ) : submissionsQuery.isError ? (
    <ErrorResult
      error={submissionsQuery.error}
      onRetry={() => void submissionsQuery.refetch()}
    />
  ) : (
    <Card
      className="oij-card"
      title="我的提交"
      extra={<Link to="/records">全部记录</Link>}
    >
      <SubmissionTable
        submissions={submissionsQuery.data ?? []}
        problemTitles={new Map<number, string>([[problem.id, problem.title]])}
        problemPath={(pid) =>
          contestId !== null ? `/contest/${contestId}/problem/${pid}` : `/problem/${pid}`
        }
        emptyText="还没有提交过本题"
      />
    </Card>
  );

  return (
    <div>
      <PageHead
        breadcrumb={
          contestId !== null
            ? [
                { label: '比赛', to: '/contests' },
                { label: contest?.name ?? `比赛 #${contestId}`, to: `/contest/${contestId}` },
                { label: letter ? `${letter}. ${problem.title}` : problem.title },
              ]
            : [
                { label: '题目', to: '/problems' },
                { label: `${problem.displayId || `#${problem.id}`} ${problem.title}` },
              ]
        }
        title={
          letter
            ? `${letter}. ${problem.title}`
            : `${problem.displayId || `#${problem.id}`} ${problem.title}`
        }
        tags={
          <>
            <Tag color="blue">{problemTypeLabel(problem.type)}</Tag>
            {letter ? <Tag>比赛题号 {letter}</Tag> : null}
          </>
        }
        subtitle={
          isObjective ? (
            <span>
              共 {objectiveQuestions.length} 题 · 总分 {objectiveTotal} 分
              {problem.tags.length > 0 ? ` · ${problem.tags.join(' / ')}` : ''}
            </span>
          ) : isOutputOnly ? (
            <span>
              共 {answerFiles.length} 个测试点 · 总分 {answerFilesTotal} 分
              {problem.tags.length > 0 ? ` · ${problem.tags.join(' / ')}` : ''}
            </span>
          ) : (
            <span>
              时间限制 {formatTimeLimit(problem.timeMs)} · 内存限制{' '}
              {formatMemoryLimit(problem.memoryMb)}
              {problem.tags.length > 0 ? ` · ${problem.tags.join(' / ')}` : ''}
            </span>
          )
        }
      />

      <div className="content-grid">
        <Tabs
          className="problem-tabs"
          activeKey={activeTab}
          onChange={setActiveTab}
          items={
            isObjective || isOutputOnly
              ? [
                  { key: 'statement', label: '题目描述', children: statementPanel },
                  {
                    key: 'submissions',
                    label: `我的提交${
                      user && submissionsQuery.data ? ` (${submissionsQuery.data.length})` : ''
                    }`,
                    children: submissionsPanel,
                  },
                ]
              : [
                  { key: 'statement', label: '题目描述', children: statementPanel },
                  { key: 'submit', label: '提交代码', children: submitPanel },
                  {
                    key: 'submissions',
                    label: `我的提交${
                      user && submissionsQuery.data ? ` (${submissionsQuery.data.length})` : ''
                    }`,
                    children: submissionsPanel,
                  },
                ]
          }
        />

        <div className="stack">
          <Card className="oij-card" size="small" title="题目信息">
            <MetaList
              items={
                isObjective
                  ? [
                      { label: '题目数量', value: `${objectiveQuestions.length} 题` },
                      { label: '总分', value: `${objectiveTotal} 分` },
                      { label: '题目类型', value: problemTypeLabel(problem.type) },
                      { label: '难度', value: difficultyLabel(problem.difficulty) },
                      {
                        label: '标签',
                        value:
                          problem.tags.length === 0 ? (
                            <span className="muted">—</span>
                          ) : (
                            <span className="tag-list">
                              {problem.tags.map((tag) => (
                                <Tag key={tag} bordered={false}>
                                  {tag}
                                </Tag>
                              ))}
                            </span>
                          ),
                      },
                    ]
                  : isOutputOnly
                    ? [
                        { label: '测试点数', value: `${answerFiles.length} 个` },
                        { label: '总分', value: `${answerFilesTotal} 分` },
                        { label: '题目类型', value: problemTypeLabel(problem.type) },
                        { label: '难度', value: difficultyLabel(problem.difficulty) },
                        {
                          label: '标签',
                          value:
                            problem.tags.length === 0 ? (
                              <span className="muted">—</span>
                            ) : (
                              <span className="tag-list">
                                {problem.tags.map((tag) => (
                                  <Tag key={tag} bordered={false}>
                                    {tag}
                                  </Tag>
                                ))}
                              </span>
                            ),
                        },
                      ]
                    : [
                        { label: '时间限制', value: formatTimeLimit(problem.timeMs) },
                        { label: '内存限制', value: formatMemoryLimit(problem.memoryMb) },
                        { label: '题目类型', value: problemTypeLabel(problem.type) },
                        {
                          label: 'IO 模式',
                          value:
                            problem.ioMode === 'file'
                              ? `${problem.inputFile ?? '—'} / ${problem.outputFile ?? '—'}`
                              : '标准输入输出',
                        },
                        { label: '难度', value: difficultyLabel(problem.difficulty) },
                        {
                          label: '标签',
                          value:
                            problem.tags.length === 0 ? (
                              <span className="muted">—</span>
                            ) : (
                              <span className="tag-list">
                                {problem.tags.map((tag) => (
                                  <Tag key={tag} bordered={false}>
                                    {tag}
                                  </Tag>
                                ))}
                              </span>
                            ),
                        },
                      ]
              }
            />
            <Button
              type="primary"
              block
              className="side-action"
              onClick={() =>
                setActiveTab(isObjective || isOutputOnly ? 'statement' : 'submit')
              }
            >
              {isObjective || isOutputOnly ? '去作答' : '提交代码'}
            </Button>
          </Card>

          {contestId === null && user ? (
            <ProblemSharePanel problemId={problem.id} />
          ) : null}

          {contestId !== null ? (
            <Card className="oij-card" size="small" title="所属比赛">
              <div className="side-contest-name">
                <Link to={`/contest/${contestId}`}>
                  {contest?.name ?? `比赛 #${contestId}`}
                </Link>
              </div>
              <div className="muted">{letter ? `题号 ${letter}` : '题目顺序未知'}</div>
              <Button
                block
                className="side-action"
                onClick={() => navigate(`/contest/${contestId}`)}
              >
                返回比赛主页
              </Button>
            </Card>
          ) : null}
        </div>
      </div>

      <Modal
        title={sourceTarget ? `提交 #${sourceTarget.id} 源码` : '查看源码'}
        open={sourceTarget !== null}
        onCancel={() => {
          setSourceTarget(null);
          setSource(null);
        }}
        footer={<Button onClick={() => setSourceTarget(null)}>关闭</Button>}
        width={920}
      >
        {sourceTarget ? (
          <div className="stack">
            <div className="muted">
              选手 用户 #{sourceTarget.userId} · {sourceTarget.verdict ?? '—'} ·{' '}
              {sourceTarget.score} 分 · {formatDateTime(sourceTarget.createdAt)}
            </div>
            {sourceLoading ? (
              <div className="inline-loading">
                <Spin />
              </div>
            ) : source ? (
              <CodeBlock
                code={source.code}
                maxHeight={560}
                title={`${source.language.toUpperCase()} · 提交 #${source.submissionId}`}
              />
            ) : (
              <Empty description="源码加载失败" />
            )}
          </div>
        ) : null}
      </Modal>

      <Modal
        title={hackTarget ? `Hack 提交 #${hackTarget.id}` : 'Hack'}
        open={hackTarget !== null}
        onCancel={() => {
          setHackTarget(null);
          setActiveHackId(null);
        }}
        footer={
          <>
            <Button
              onClick={() => {
                setHackTarget(null);
                setActiveHackId(null);
              }}
            >
              关闭
            </Button>
            <Button
              type="primary"
              loading={hackSubmitting}
              disabled={!hackInput.trim() || hackBusy}
              onClick={() => void submitHack()}
            >
              提交 Hack
            </Button>
          </>
        }
        width={720}
      >
        {hackTarget ? (
          <div className="stack">
            <div className="muted">
              目标：用户 #{hackTarget.userId} · {hackTarget.verdict ?? '—'} ·{' '}
              {hackTarget.score} 分
            </div>
            <Alert
              type="info"
              showIcon
              message="输入会作为目标程序的 stdin；目标输出与 std 不一致时 Hack 成功。"
            />
            <Input.TextArea
              rows={10}
              value={hackInput}
              onChange={(event) => setHackInput(event.target.value)}
              placeholder="输入 Hack 测试数据"
              disabled={hackBusy}
              style={{ fontFamily: 'Consolas, "Cascadia Mono", monospace' }}
            />
            {hackError ? <Alert type="error" showIcon message={hackError} /> : null}
            {activeHackId !== null ? (
              hackStatusQuery.isError ? (
                <Alert
                  type="error"
                  showIcon
                  message="Hack 状态查询失败"
                  description={
                    hackStatusQuery.error instanceof Error
                      ? hackStatusQuery.error.message
                      : undefined
                  }
                />
              ) : hackStatusQuery.isPending || !hackStatus ? (
                <div className="inline-loading">
                  <Spin />
                </div>
              ) : (
                <Alert
                  type={
                    hackStatus.status === 'success'
                      ? 'success'
                      : hackStatus.status === 'failed' || hackStatus.status === 'invalid'
                        ? 'error'
                        : 'info'
                  }
                  showIcon
                  message={
                    <Space>
                      <Tag color={hackStatusColor[hackStatus.status] ?? 'default'}>
                        {hackStatusLabel[hackStatus.status] ?? hackStatus.status}
                      </Tag>
                      {hackStatus.verdict ? (
                        <span className="mono">
                          {hackStatus.verdict} · {verdictTitle(hackStatus.verdict)}
                        </span>
                      ) : null}
                    </Space>
                  }
                  description={
                    hackStatus.message ||
                    (hackStatus.status === 'queued' || hackStatus.status === 'judging'
                      ? '正在评测 Hack…'
                      : undefined)
                  }
                />
              )
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
