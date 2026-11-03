import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Empty,
  Input,
  Result,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { ApiError, apiGet } from '../api/client';
import type {
  AwardConfig,
  AwardLevel,
  AwardRow,
  Contest,
  ContestAwards,
  ContestDetail,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { AwardCertificate } from '../components/AwardCertificate';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import {
  awardColor,
  awardLabel,
  buildAwardsCsv,
  downloadCsvFile,
  filterAwardRows,
  formatCertificateDate,
  sanitizeFileName,
  type AwardFilterValue,
} from '../utils/awards';
import '../styles/awards.css';

const AWARD_FILTER_OPTIONS: Array<{ value: AwardFilterValue; label: string }> = [
  { value: 'all', label: '全部奖项' },
  { value: 'gold', label: '金牌' },
  { value: 'silver', label: '银牌' },
  { value: 'bronze', label: '铜牌' },
  { value: 'none', label: '未获奖' },
];

/** 与后端 awards 接口的公开条件保持一致：已结束或已归档。 */
function contestReady(contest: Contest | null | undefined): boolean {
  if (!contest) return false;
  return (
    contest.status === 'ended' ||
    contest.status === 'archived' ||
    (contest.archived_at ?? null) !== null
  );
}

interface PrintRequest {
  row: AwardRow;
  /** 每次点击递增，保证连续打印同一行时仍能触发。 */
  nonce: number;
}

const EMPTY_CONFIG: AwardConfig = { goldPercent: 10, silverPercent: 20, bronzePercent: 30 };

export function ContestAwardsPage() {
  const { contestId: contestIdParam } = useParams<{ contestId: string }>();
  const contestId = Number(contestIdParam);
  const validId = Number.isInteger(contestId) && contestId > 0;
  const { user, status: authStatus } = useAuth();
  const { message } = App.useApp();

  const [keyword, setKeyword] = useState('');
  const [awardFilter, setAwardFilter] = useState<AwardFilterValue>('all');
  const [classFilter, setClassFilter] = useState('all');
  const [printRequest, setPrintRequest] = useState<PrintRequest | null>(null);

  const detailQuery = useQuery({
    queryKey: ['contest-detail', contestId],
    queryFn: () => apiGet<ContestDetail>(`/api/contests/${contestId}`),
    enabled: validId,
    staleTime: 30_000,
  });
  const awardsQuery = useQuery({
    queryKey: ['contest-awards', contestId],
    queryFn: () => apiGet<ContestAwards>(`/api/contests/${contestId}/awards`),
    enabled: validId && Boolean(user),
    staleTime: 30_000,
    retry: false,
  });

  const awards = awardsQuery.data ?? null;
  const contest = awards?.contest ?? detailQuery.data?.contest ?? null;
  const rows = awards?.rows ?? [];
  const counts = awards?.counts ?? { gold: 0, silver: 0, bronze: 0, total: 0 };
  const config = awards?.config ?? EMPTY_CONFIG;

  const classOptions = useMemo(() => {
    const names = new Set<string>();
    for (const row of rows) {
      if (row.className) names.add(row.className);
    }
    return [
      { value: 'all', label: '全部班级' },
      ...[...names].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((name) => ({
        value: name,
        label: name,
      })),
    ];
  }, [rows]);

  const filteredRows = useMemo(
    () =>
      filterAwardRows(rows, {
        keyword,
        award: awardFilter,
        className: classFilter === 'all' ? null : classFilter,
      }),
    [rows, keyword, awardFilter, classFilter],
  );

  // 打印：等证书 DOM 提交后再调用 window.print()，只在打印媒体中显示证书区域。
  useEffect(() => {
    if (!printRequest) return;
    const timer = window.setTimeout(() => window.print(), 80);
    return () => window.clearTimeout(timer);
  }, [printRequest]);

  useEffect(() => {
    const clear = () => setPrintRequest(null);
    window.addEventListener('afterprint', clear);
    return () => window.removeEventListener('afterprint', clear);
  }, []);

  const exportCsv = () => {
    if (filteredRows.length === 0) {
      message.warning('当前筛选结果为空，没有可导出的数据');
      return;
    }
    const csv = buildAwardsCsv(filteredRows);
    const base = sanitizeFileName(`awards-${contestId}-${contest?.name ?? 'contest'}`);
    downloadCsvFile(`${base}.csv`, csv);
    message.success(`已导出 ${filteredRows.length} 条奖项数据`);
  };

  const columns: TableColumnsType<AwardRow> = [
    { title: '名次', dataIndex: 'rank', key: 'rank', width: 76, sorter: (a, b) => a.rank - b.rank },
    {
      title: '用户',
      dataIndex: 'username',
      key: 'username',
      render: (value: string) => <span className="mono">{value}</span>,
    },
    {
      title: '姓名',
      dataIndex: 'realName',
      key: 'realName',
      render: (value: string | null) => value ?? '—',
    },
    {
      title: '班级',
      dataIndex: 'className',
      key: 'className',
      render: (value: string | null) => value ?? '—',
    },
    {
      title: '总分',
      dataIndex: 'totalScore',
      key: 'totalScore',
      width: 100,
      align: 'right',
      sorter: (a, b) => a.totalScore - b.totalScore,
      render: (value: number) => <span className="mono">{value}</span>,
    },
    {
      title: '奖项',
      dataIndex: 'award',
      key: 'award',
      width: 100,
      render: (value: AwardLevel | null) => (
        <Tag color={awardColor(value)}>{awardLabel(value)}</Tag>
      ),
    },
    {
      title: '证书编号',
      dataIndex: 'certificateNo',
      key: 'certificateNo',
      width: 150,
      render: (value: string) => <span className="mono">{value}</span>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 118,
      render: (_value, record) =>
        record.award === null ? (
          <Tooltip title="未获奖选手不生成证书">
            <Button size="small" disabled>
              打印证书
            </Button>
          </Tooltip>
        ) : (
          <Button
            size="small"
            type="primary"
            ghost
            onClick={() => setPrintRequest({ row: record, nonce: Date.now() })}
          >
            打印证书
          </Button>
        ),
    },
  ];

  const breadcrumb = [
    { label: '比赛', to: '/contests' },
    ...(contest ? [{ label: contest.name, to: `/contest/${contest.id}` }] : []),
    { label: '奖项与证书' },
  ];

  if (!validId) {
    return (
      <Result
        status="404"
        title="比赛不存在"
        subTitle={`没有找到 #${contestIdParam} 对应的比赛。`}
        extra={
          <Link to="/contests">
            <Button type="primary">返回比赛列表</Button>
          </Link>
        }
      />
    );
  }

  if (authStatus === 'loading') {
    return <PageLoading tip="正在确认登录状态…" />;
  }

  if (!user) {
    const next = encodeURIComponent(`/contest/${contestId}/awards`);
    return (
      <div>
        <PageHead breadcrumb={breadcrumb} title="奖项与证书" />
        <Result
          status="403"
          title="登录后查看奖项"
          subTitle="奖项与证书仅对已登录用户公开。"
          extra={
            <Space>
              <Link to={`/login?next=${next}`}>
                <Button type="primary">去登录</Button>
              </Link>
              <Link to={`/contest/${contestId}`}>
                <Button>返回比赛页</Button>
              </Link>
            </Space>
          }
        />
      </div>
    );
  }

  if (awardsQuery.isPending) {
    return <PageLoading tip="正在加载奖项…" />;
  }

  if (awardsQuery.isError) {
    const error = awardsQuery.error;
    const notReady = error instanceof ApiError && error.status === 403;
    if (notReady) {
      return (
        <div>
          <PageHead breadcrumb={breadcrumb} title="奖项与证书" />
          <Result
            status="403"
            title="奖项尚未公开"
            subTitle="比赛结束后才会公布奖项与证书；管理员可以提前预览。如果比赛已经结束，请等待管理员结束比赛或归档。"
            extra={
              <Space wrap>
                <Link to={`/contest/${contestId}`}>
                  <Button type="primary">返回比赛页</Button>
                </Link>
                <Link to={`/contest/${contestId}/ranking`}>
                  <Button>查看榜单</Button>
                </Link>
              </Space>
            }
          />
        </div>
      );
    }
    return (
      <ErrorResult
        error={error}
        onRetry={() => void awardsQuery.refetch()}
      />
    );
  }

  if (!awards || !contest) {
    return (
      <Empty
        className="award-empty"
        description="暂无奖项数据（正式榜可能还没有选手）"
      >
        <Link to={`/contest/${contestId}/ranking`}>
          <Button type="primary">查看榜单</Button>
        </Link>
      </Empty>
    );
  }

  const preview = !contestReady(contest);
  const certificateDate = formatCertificateDate(contest.end_at);
  const selectedClass = classFilter === 'all' ? null : classFilter;
  const hasFilters = keyword.trim() !== '' || awardFilter !== 'all' || selectedClass !== null;

  return (
    <div className="award-page">
      <PageHead
        breadcrumb={breadcrumb}
        title="奖项与证书"
        tags={
          <>
            <Tag color="blue">{contest.name}</Tag>
            <Tag>正式榜 {rows.length} 人</Tag>
            <Tag color="gold">获奖 {counts.total} 人</Tag>
            {preview ? <Tag color="orange">管理员预览</Tag> : null}
          </>
        }
        subtitle="金/银/铜奖按正式榜名次与管理员配置的比例生成；并列名次可能使实际人数略超比例。"
        extra={
          <Space wrap>
            <Link to={`/contest/${contestId}/ranking`}>
              <Button>完整榜单</Button>
            </Link>
            <Link to={`/contest/${contestId}`}>
              <Button>返回比赛页</Button>
            </Link>
          </Space>
        }
      />

      {preview ? (
        <Alert
          className="award-alert"
          type="warning"
          showIcon
          message="比赛尚未结束，当前为管理员预览"
          description="奖项与证书可能在比赛结束后随正式榜更新；非管理员需等待比赛结束才能查看。"
        />
      ) : null}

      <Row gutter={[12, 12]} className="award-stats">
        <Col flex="1 1 150px">
          <Card size="small" className="award-stat-card award-stat-gold">
            <Statistic title="金牌" value={counts.gold} suffix="人" />
            <span className="award-stat-hint">配置 {config.goldPercent}%</span>
          </Card>
        </Col>
        <Col flex="1 1 150px">
          <Card size="small" className="award-stat-card award-stat-silver">
            <Statistic title="银牌" value={counts.silver} suffix="人" />
            <span className="award-stat-hint">配置 {config.silverPercent}%</span>
          </Card>
        </Col>
        <Col flex="1 1 150px">
          <Card size="small" className="award-stat-card award-stat-bronze">
            <Statistic title="铜牌" value={counts.bronze} suffix="人" />
            <span className="award-stat-hint">配置 {config.bronzePercent}%</span>
          </Card>
        </Col>
        <Col flex="1 1 150px">
          <Card size="small" className="award-stat-card">
            <Statistic title="获奖总人数" value={counts.total} suffix="人" />
            <span className="award-stat-hint">
              占正式榜 {rows.length === 0 ? 0 : Math.round((counts.total / rows.length) * 100)}%
            </span>
          </Card>
        </Col>
        <Col flex="1 1 150px">
          <Card size="small" className="award-stat-card">
            <Statistic title="正式榜人数" value={rows.length} suffix="人" />
            <span className="award-stat-hint">隐藏选手不参与评奖</span>
          </Card>
        </Col>
      </Row>

      <Card
        className="oij-card"
        title="获奖名单"
        extra={
          <span className="muted">
            筛选出 {filteredRows.length} / {rows.length} 人
          </span>
        }
      >
        <div className="award-toolbar">
          <Input
            allowClear
            placeholder="搜索用户名 / 姓名 / 班级 / 证书编号"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            style={{ width: 280 }}
          />
          <Select<AwardFilterValue>
            value={awardFilter}
            options={AWARD_FILTER_OPTIONS}
            onChange={(value) => setAwardFilter(value)}
            style={{ width: 130 }}
          />
          <Select
            value={classFilter}
            options={classOptions}
            onChange={(value: string) => setClassFilter(value)}
            style={{ width: 170 }}
          />
          <Button
            disabled={!hasFilters}
            onClick={() => {
              setKeyword('');
              setAwardFilter('all');
              setClassFilter('all');
            }}
          >
            重置筛选
          </Button>
          <span className="award-toolbar-spacer" />
          <Button type="primary" disabled={filteredRows.length === 0} onClick={exportCsv}>
            导出 CSV
          </Button>
        </div>

        {rows.length === 0 ? (
          <Empty description="正式榜暂无选手，暂时无法生成奖项" />
        ) : (
          <Table<AwardRow>
            className="oij-table award-table"
            rowKey="userId"
            size="small"
            columns={columns}
            dataSource={filteredRows}
            pagination={
              filteredRows.length > 50
                ? { pageSize: 50, size: 'small', showSizeChanger: false }
                : false
            }
            scroll={{ x: 960 }}
            locale={{ emptyText: hasFilters ? '没有符合条件的选手' : '暂无奖项数据' }}
          />
        )}

        <div className="award-table-legend muted">
          奖项比例来自管理员“奖项配置”卡片；证书编号格式为 C比赛ID-用户ID，名次与分数以正式榜为准。
        </div>
      </Card>

      {printRequest
        ? createPortal(
            <div className="award-print-area">
              <AwardCertificate
                contestName={contest.name}
                row={printRequest.row}
                date={certificateDate}
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
