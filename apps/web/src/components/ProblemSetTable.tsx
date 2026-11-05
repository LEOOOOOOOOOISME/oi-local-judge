import type { ReactNode } from 'react';
import { Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import { Link } from 'react-router-dom';
import type { ProblemSetSummary } from '../api/types';
import { formatDateTime } from '../utils/format';
import { PROBLEM_SET_VISIBILITY_LABEL } from '../utils/problemSets';

/**
 * 题单列表（个人/团队/公开共用）。
 *
 * owner 名称无法由题单接口直接给出，团队名由调用方通过 teamNames 映射补齐；
 * 个人题单显示“我（个人）”或服务端返回的 ownerId。
 */
export function ProblemSetTable({
  sets,
  teamNames,
  currentUserId,
  showOwner = true,
  emptyText = '暂无题单',
}: {
  sets: ProblemSetSummary[];
  teamNames?: Map<number, string>;
  currentUserId?: number;
  showOwner?: boolean;
  emptyText?: ReactNode;
}) {
  const columns: TableColumnsType<ProblemSetSummary> = [
    {
      title: '题单',
      dataIndex: 'title',
      render: (value: string, row) => (
        <div className="problem-set-title-cell">
          <Link to={`/problem-sets/${row.id}`} className="problem-set-title-link">
            {value}
          </Link>
          {row.description ? (
            <div className="problem-set-desc muted">{row.description}</div>
          ) : null}
        </div>
      ),
    },
  ];

  if (showOwner) {
    columns.push({
      title: '归属',
      dataIndex: 'ownerType',
      width: 170,
      render: (_value, row) =>
        row.ownerType === 'team' ? (
          <span>
            团队
            <span className="muted">
              {' '}
              · {teamNames?.get(row.ownerId) ?? `#${row.ownerId}`}
            </span>
          </span>
        ) : row.ownerId === currentUserId ? (
          <span>我（个人）</span>
        ) : (
          <span>
            用户<span className="muted"> #{row.ownerId}</span>
          </span>
        ),
    });
  }

  columns.push(
    {
      title: '可见性',
      dataIndex: 'visibility',
      width: 96,
      render: (value: ProblemSetSummary['visibility']) => (
        <Tag color={value === 'public' ? 'green' : undefined}>
          {PROBLEM_SET_VISIBILITY_LABEL[value]}
        </Tag>
      ),
    },
    {
      title: '题目数',
      dataIndex: 'itemCount',
      width: 88,
      align: 'right',
      render: (value: number) => <span className="mono">{value}</span>,
    },
    {
      title: '我的权限',
      dataIndex: 'canEdit',
      width: 110,
      render: (_value, row) =>
        row.canManage ? (
          <Tag color="gold">可管理</Tag>
        ) : row.canEdit ? (
          <Tag color="blue">可编辑</Tag>
        ) : (
          <Tag>只读</Tag>
        ),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 170,
      render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
    },
    {
      title: '操作',
      width: 92,
      render: (_value, row) => (
        <Link to={`/problem-sets/${row.id}`}>
          <Tag color="processing">打开</Tag>
        </Link>
      ),
    },
  );

  return (
    <Table<ProblemSetSummary>
      className="oij-table"
      rowKey="id"
      size="small"
      columns={columns}
      dataSource={sets}
      pagination={false}
      locale={{ emptyText }}
    />
  );
}
