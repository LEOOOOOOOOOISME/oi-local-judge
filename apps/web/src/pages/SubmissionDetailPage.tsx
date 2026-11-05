import { Alert, App, Button, Card, Empty, Space, Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiPost, apiGet } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { AnswerFile, Contest, ProblemDetail, Submission, TestResult } from '../api/types';
import { CodeBlock } from '../components/CodeBlock';
import { MetaList } from '../components/MetaList';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { SubmissionStatusBadge, VerdictBadge } from '../components/VerdictBadge';
import {
  formatDateTime,
  formatMemoryKb,
  formatRunTime,
} from '../utils/format';
import {
  SUBMISSION_STATUS_LABEL,
  isPendingStatus,
  languageLabel,
} from '../utils/status';

function prettyJson(code: string): string {
  try {
    return JSON.stringify(JSON.parse(code) as unknown, null, 2);
  } catch {
    return code;
  }
}

export function SubmissionDetailPage() {
  const { submissionId: submissionIdParam } = useParams();
  const submissionId = Number(submissionIdParam);
  const validId = Number.isInteger(submissionId) && submissionId > 0;
  const { user } = useAuth();
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();

  const submissionQuery = useQuery({
    queryKey: ['submission', submissionId],
    queryFn: () => apiGet<Submission>(`/api/submissions/${submissionId}`),
    enabled: validId,
    refetchInterval: (query) => {
      const current = query.state.data;
      return current && isPendingStatus(current.status) ? 1_500 : false;
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () =>
      apiPost<{ id: number; status: string; taskId: number | null }>(
        `/api/admin/submissions/${submissionId}/cancel`,
      ),
    onSuccess: () => {
      message.success('评测已取消');
      void queryClient.invalidateQueries({ queryKey: ['submission', submissionId] });
      void queryClient.invalidateQueries({ queryKey: ['submissions'] });
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : '取消评测失败');
    },
  });

  const submission = submissionQuery.data;
  const problemQuery = useQuery({
    queryKey: ['problem', submission?.problemId],
    queryFn: () => apiGet<ProblemDetail>(`/api/problems/${submission?.problemId}`),
    enabled: submission !== undefined,
  });
  const contestsQuery = useQuery({
    queryKey: ['contests'],
    queryFn: () => apiGet<Contest[]>('/api/contests'),
    enabled: submission?.contestId !== null && submission?.contestId !== undefined,
    staleTime: 60_000,
  });
  const answerFilesQuery = useQuery({
    queryKey: ['answer-files', submission?.problemId],
    queryFn: () => apiGet<AnswerFile[]>(`/api/problems/${submission?.problemId}/answer-files`),
    enabled: submission?.language === 'answer',
  });

  if (!validId) {
    return <ErrorResult error={new Error('无效的提交编号')} />;
  }
  if (submissionQuery.isPending) {
    return <PageLoading tip="正在加载提交…" />;
  }
  if (submissionQuery.isError) {
    return (
      <ErrorResult error={submissionQuery.error} onRetry={() => void submissionQuery.refetch()} />
    );
  }
  if (!submission) {
    return <PageLoading tip="正在加载提交…" />;
  }

  const pending = isPendingStatus(submission.status);
  const canCancel = pending && (user?.role === 'admin' || user?.role === 'contestmanager');
  const requestCancel = () => {
    modal.confirm({
      title: '取消评测',
      content: `确定要取消提交 #${submission.id} 的评测吗？取消后可以重新评测。`,
      okText: '取消评测',
      okButtonProps: { danger: true },
      cancelText: '返回',
      onOk: async () => {
        try {
          await cancelMutation.mutateAsync();
        } catch {
          // The mutation's onError already reported the failure.
        }
      },
    });
  };
  const contest =
    submission.contestId !== null
      ? (contestsQuery.data?.find((item) => item.id === submission.contestId) ?? null)
      : null;
  const problemTitle = problemQuery.data?.title ?? `#${submission.problemId}`;
  const backPath =
    submission.contestId !== null
      ? `/contest/${submission.contestId}/problem/${submission.problemId}`
      : `/problem/${submission.problemId}`;
  const results = submission.results ?? [];
  const isObjective = submission.language === 'objective';
  const isAnswer = submission.language === 'answer';
  const objectiveQuestions = problemQuery.data?.objective?.questions ?? [];
  const objectiveIndexByQuestionId = new Map(
    objectiveQuestions.map((question, index) => [question.id, index + 1]),
  );
  const objectiveStemByQuestionId = new Map(
    objectiveQuestions.map((question) => [question.id, question.stem]),
  );
  const answerOrdinalById = new Map(
    (answerFilesQuery.data ?? []).map((file) => [file.id, file.ordinal]),
  );

  const resultColumns: TableColumnsType<TestResult> = isObjective
    ? [
        {
          title: '题号',
          dataIndex: 'testcaseId',
          width: 92,
          render: (questionId: number) => {
            const index = objectiveIndexByQuestionId.get(questionId);
            return index ? (
              <span className="mono">第 {index} 题</span>
            ) : (
              <span className="mono">#{questionId}</span>
            );
          },
        },
        {
          title: '题目',
          dataIndex: 'testcaseId',
          render: (questionId: number) => {
            const stem = objectiveStemByQuestionId.get(questionId);
            return stem ? (
              <span className="test-message" title={stem}>
                {stem}
              </span>
            ) : (
              <span className="muted">—</span>
            );
          },
        },
        {
          title: '状态',
          dataIndex: 'verdict',
          width: 86,
          render: (verdict: TestResult['verdict']) => <VerdictBadge verdict={verdict} />,
        },
        {
          title: '得分',
          dataIndex: 'score',
          width: 72,
          align: 'right',
          render: (value: number) => <span className="score-value">{value}</span>,
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
      ]
    : isAnswer
      ? [
          {
            title: '题号',
            dataIndex: 'testcaseId',
            width: 100,
            render: (testcaseId: number) => {
              const ordinal = answerOrdinalById.get(testcaseId);
              return ordinal ? (
                <span className="mono">测试点 {ordinal}</span>
              ) : (
                <span className="mono">#{testcaseId}</span>
              );
            },
          },
          {
            title: '状态',
            dataIndex: 'verdict',
            width: 86,
            render: (verdict: TestResult['verdict']) => <VerdictBadge verdict={verdict} />,
          },
          {
            title: '得分',
            dataIndex: 'score',
            width: 72,
            align: 'right',
            render: (value: number) => <span className="score-value">{value}</span>,
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
        ]
      : [
        {
          title: '#',
          width: 52,
          align: 'center',
          render: (_value, _record, index) => <span className="muted">{index + 1}</span>,
        },
        {
          title: '测试点',
          dataIndex: 'testcaseId',
          width: 92,
          render: (testcaseId: number) => <span className="mono">#{testcaseId}</span>,
        },
        {
          title: '状态',
          dataIndex: 'verdict',
          width: 86,
          render: (verdict: TestResult['verdict']) => <VerdictBadge verdict={verdict} />,
        },
        {
          title: '用时',
          dataIndex: 'timeMs',
          width: 94,
          align: 'right',
          render: (value: number) => formatRunTime(value),
        },
        {
          title: '内存',
          dataIndex: 'memoryKb',
          width: 100,
          align: 'right',
          render: (value: number) => formatMemoryKb(value),
        },
        {
          title: '得分',
          dataIndex: 'score',
          width: 72,
          align: 'right',
          render: (value: number) => <span className="score-value">{value}</span>,
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
      ];

  return (
    <div>
      <PageHead
        breadcrumb={[
          { label: '比赛', to: '/contests' },
          ...(submission.contestId !== null
            ? [{ label: contest?.name ?? `比赛 #${submission.contestId}`, to: `/contest/${submission.contestId}` }]
            : []),
          { label: `提交 #${submission.id}` },
        ]}
        title={`提交 #${submission.id}`}
        tags={
          <>
            <SubmissionStatusBadge status={submission.status} verdict={submission.verdict} />
            {submission.hackedAt ? <Tag color="red">HACKED</Tag> : null}
            <Tag>{languageLabel(submission.language)}</Tag>
          </>
        }
        subtitle={
          <span>
            题目 <Link to={backPath}>{problemTitle}</Link> · 提交于{' '}
            {formatDateTime(submission.createdAt)}
          </span>
        }
        extra={
          <Space>
            {canCancel ? (
              <Button danger loading={cancelMutation.isPending} onClick={requestCancel}>
                取消评测
              </Button>
            ) : null}
            <Link to={backPath}>
              <Button>返回题目</Button>
            </Link>
          </Space>
        }
      />

      <div className="content-grid">
        <div className="stack">
          <Card className="oij-card" title="评测结果">
            {pending ? (
              <div className="pending-banner">
                <span className="pending-dot" />
                <div>
                  <div className="pending-title">
                    {SUBMISSION_STATUS_LABEL[submission.status]}…
                  </div>
                  <div className="muted">评测完成后页面会通过 WebSocket 自动刷新。</div>
                </div>
              </div>
            ) : (
              <div className="verdict-hero">
                <VerdictBadge verdict={submission.verdict} size="lg" />
                <div className="verdict-hero-score">
                  {submission.score}
                  <span className="verdict-hero-unit">分</span>
                </div>
              </div>
            )}
            {submission.message ? (
              <Alert
                className="submission-message"
                type={submission.status === 'failed' ? 'error' : 'warning'}
                showIcon
                message={submission.message}
              />
            ) : null}
            <MetaList
              items={[
                { label: '状态', value: SUBMISSION_STATUS_LABEL[submission.status] },
                { label: '用时', value: formatRunTime(submission.timeMs) },
                { label: '内存', value: formatMemoryKb(submission.memoryKb) },
                { label: '分数', value: `${submission.score}` },
                { label: '评测时间', value: formatDateTime(submission.judgedAt) },
              ]}
            />
          </Card>

          <Card
            className="oij-card"
            title={`${isObjective ? '题目结果' : isAnswer ? '测试点结果' : '测试点'}${
              results.length > 0 ? ` (${results.length})` : ''
            }`}
          >
            {results.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  pending
                    ? '评测完成后显示结果'
                    : '没有结果（可能是编译错误或系统错误）'
                }
              />
            ) : (
              <Table<TestResult>
                className="oij-table"
                rowKey="testcaseId"
                size="small"
                columns={resultColumns}
                dataSource={results}
                pagination={false}
              />
            )}
          </Card>

          {isObjective || isAnswer ? (
            <Card className="oij-card" title="提交的答案（只读 JSON）">
              <CodeBlock
                code={prettyJson(submission.code ?? '')}
                maxHeight={560}
                title="答案 JSON"
              />
            </Card>
          ) : (
            <Card className="oij-card" title="源代码">
              <CodeBlock code={submission.code ?? ''} maxHeight={560} />
            </Card>
          )}
        </div>

        <div className="stack">
          <Card className="oij-card" size="small" title="提交信息">
            <MetaList
              items={[
                { label: '提交号', value: `#${submission.id}` },
                { label: '题目', value: <Link to={backPath}>{problemTitle}</Link> },
                {
                  label: '比赛',
                  value:
                    submission.contestId === null ? (
                      <span className="muted">练习</span>
                    ) : (
                      <Link to={`/contest/${submission.contestId}`}>
                        {contest?.name ?? `比赛 #${submission.contestId}`}
                      </Link>
                    ),
                },
                { label: '用户', value: `#${submission.userId}` },
                { label: '语言', value: languageLabel(submission.language) },
                { label: '状态', value: SUBMISSION_STATUS_LABEL[submission.status] },
                { label: '提交时间', value: formatDateTime(submission.createdAt) },
                { label: '评测时间', value: formatDateTime(submission.judgedAt) },
                ...(submission.hackedAt
                  ? [
                      {
                        label: 'Hack 状态',
                        value: <Tag color="red">HACKED</Tag>,
                      },
                      {
                        label: 'Hack 时间',
                        value: formatDateTime(submission.hackedAt),
                      },
                      {
                        label: 'Hacked by',
                        value:
                          submission.hackedBy === null ||
                          submission.hackedBy === undefined
                            ? '—'
                            : `用户 #${submission.hackedBy}`,
                      },
                    ]
                  : []),
              ]}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}
