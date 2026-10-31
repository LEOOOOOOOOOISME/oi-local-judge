import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Input,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
} from 'antd';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../api/client';
import type {
  AnswerFile,
  Contest,
  ObjectiveAnswerValue,
  ProblemDetail,
  RankingRow,
  Submission,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { MetaList } from '../components/MetaList';
import { ObjectiveAnswerForm } from '../components/ObjectiveAnswerForm';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { StatementHtml } from '../components/StatementHtml';
import { SubmissionTable } from '../components/SubmissionTable';
import { formatMemoryLimit, formatTimeLimit } from '../utils/format';
import { difficultyLabel, problemLetter, problemTypeLabel } from '../utils/status';
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

function readDraft(problemId: number): string | null {
  try {
    return window.localStorage.getItem(`oij:draft:${problemId}`);
  } catch {
    return null;
  }
}

function writeDraft(problemId: number, code: string): void {
  try {
    window.localStorage.setItem(`oij:draft:${problemId}`, code);
  } catch {
    // 本地草稿不可用不影响提交。
  }
}

export function ProblemPage() {
  const params = useParams<{ contestId?: string; problemId: string }>();
  const problemId = Number(params.problemId);
  const contestId = params.contestId ? Number(params.contestId) : null;
  const validProblem = Number.isInteger(problemId) && problemId > 0;
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
  const [code, setCode] = useState<string>(
    () => (validProblem ? readDraft(problemId) : null) ?? DEFAULT_CODE,
  );
  const lastProblemRef = useRef(problemId);

  useEffect(() => {
    if (lastProblemRef.current === problemId) return;
    lastProblemRef.current = problemId;
    setCode(readDraft(problemId) ?? DEFAULT_CODE);
    setObjectiveAnswers({});
    setOutputAnswers({});
  }, [problemId]);

  useEffect(() => {
    if (validProblem) writeDraft(problemId, code);
  }, [problemId, code, validProblem]);

  const problemQuery = useQuery({
    queryKey: ['problem', problemId],
    queryFn: () => apiGet<ProblemDetail>(`/api/problems/${problemId}`),
    enabled: validProblem,
  });
  const contestsQuery = useQuery({
    queryKey: ['contests'],
    queryFn: () => apiGet<Contest[]>('/api/contests'),
    enabled: contestId !== null,
    staleTime: 60_000,
  });
  const rankingQuery = useQuery({
    queryKey: ['ranking', contestId],
    queryFn: () => apiGet<RankingRow[]>(`/api/contests/${contestId}/ranking`),
    enabled: contestId !== null && validContest,
    staleTime: 5_000,
  });
  const submissionsQuery = useQuery({
    queryKey: ['submissions', { scope: 'mine', problemId, contestId }],
    queryFn: () =>
      apiGet<Submission[]>(
        `/api/submissions?userId=me&limit=20&problemId=${problemId}${
          contestId === null ? '' : `&contestId=${contestId}`
        }`,
      ),
    enabled: validProblem && Boolean(user),
  });
  const answerFilesQuery = useQuery({
    queryKey: ['answer-files', problemId],
    queryFn: () => apiGet<AnswerFile[]>(`/api/problems/${problemId}/answer-files`),
    enabled: validProblem && problemQuery.data?.type === 'output-only',
  });

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
    mutationFn: (payload: { language: string; code: string }) =>
      apiPost<{ id: number; status: string }>('/api/submissions', {
        problemId,
        language: payload.language,
        code: payload.code,
        contestId,
      }),
    onSuccess: (data) => {
      message.success(`提交 #${data.id} 已提交`);
      void queryClient.invalidateQueries({ queryKey: ['submissions'] });
      navigate(`/submissions/${data.id}`);
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : '提交失败');
    },
  });

  const contest =
    contestId !== null ? (contestsQuery.data?.find((item) => item.id === contestId) ?? null) : null;
  const firstRankingRow = rankingQuery.data?.[0];
  const ordinalIndex = firstRankingRow
    ? firstRankingRow.problems.findIndex((cell) => cell.problemId === problemId)
    : -1;
  const letter = ordinalIndex >= 0 ? problemLetter(ordinalIndex) : null;

  const loginHref = `/login?next=${encodeURIComponent(
    contestId !== null ? `/contest/${contestId}/problem/${problemId}` : `/problem/${problemId}`,
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
  const problem = problemQuery.data;
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
      {problem.ioMode === 'file' ? (
        <Alert
          type="info"
          showIcon
          message={`本题使用文件 IO：输入文件 ${problem.inputFile ?? '—'}，输出文件 ${
            problem.outputFile ?? '—'
          }`}
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

  const submitPanel = !user ? (
    <Card className="oij-card">
      <Empty description="登录后即可提交代码">
        <Link to={loginHref}>
          <Button type="primary">去登录</Button>
        </Link>
      </Empty>
    </Card>
  ) : (
    <Card
      className="oij-card"
      title="提交 C++17 代码"
      extra={<span className="muted">{code.length} 字符 / 上限 256 KB</span>}
    >
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
          onClick={() =>
            submitMutation.mutate({ language: 'cpp17', code })
          }
          loading={submitMutation.isPending}
          disabled={code.trim().length === 0}
        >
          提交评测
        </Button>
      </div>
    </Card>
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
                { label: `#${problem.id} ${problem.title}` },
              ]
        }
        title={letter ? `${letter}. ${problem.title}` : `#${problem.id} ${problem.title}`}
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
    </div>
  );
}
