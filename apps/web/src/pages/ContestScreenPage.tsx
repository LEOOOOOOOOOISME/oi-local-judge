import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { OfficialRanking } from '../api/types';
import { useNow } from '../hooks/useNow';
import {
  CONTEST_PHASE_LABEL,
  contestCountdownText,
  contestPhase,
  verdictTitle,
} from '../utils/status';
import {
  fetchOfficialRanking,
  presetFromMode,
  presetLabel,
} from '../utils/officialRanking';
import { rankingProblemLetter } from '../utils/ranking';
import '../styles/screen.css';

function ScreenShell({
  children,
  dark,
}: {
  children: React.ReactNode;
  dark?: boolean;
}) {
  return <div className={`screen-page${dark ? ' screen-page-center' : ''}`}>{children}</div>;
}

function formatClock(ms: number): string {
  const date = new Date(ms);
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function ContestScreenPage() {
  const { contestId: contestIdParam } = useParams();
  const contestId = Number(contestIdParam);
  const validId = Number.isInteger(contestId) && contestId > 0;
  const now = useNow(1000);
  const [topLimit, setTopLimit] = useState<'20' | '50' | 'all'>('20');

  const rankingQuery = useQuery({
    queryKey: ['official-ranking', contestId],
    queryFn: () => fetchOfficialRanking(contestId),
    enabled: validId,
    refetchInterval: 5_000,
    retry: false,
  });

  const data: OfficialRanking | undefined = rankingQuery.data;
  const contest = data?.contest ?? null;
  const ranking = data?.rows ?? [];
  const problems = data?.problems ?? [];
  const preset = data?.preset ?? presetFromMode(contest?.mode);
  const isAcm = preset === 'acm' || preset === 'cf-like';
  const archived = data?.archived ?? false;
  const officialFrozenUntil = data?.officialFrozenUntil ?? null;
  const officialFrozen = officialFrozenUntil !== null && officialFrozenUntil > now;
  const officialFrozenText = officialFrozen
    ? new Date(officialFrozenUntil).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : null;
  const rows = useMemo(() => {
    if (topLimit === 'all') return ranking;
    return ranking.slice(0, Number(topLimit));
  }, [ranking, topLimit]);

  if (!validId) {
    return (
      <ScreenShell dark>
        <div className="screen-title">无效的比赛编号</div>
        <Link to="/contests" className="screen-link">
          返回比赛列表
        </Link>
      </ScreenShell>
    );
  }
  if (rankingQuery.isPending) {
    return (
      <ScreenShell dark>
        <div className="screen-loading">正在加载比赛大屏…</div>
      </ScreenShell>
    );
  }
  if (rankingQuery.isError || !contest) {
    return (
      <ScreenShell dark>
        <div className="screen-title">比赛不存在或加载失败</div>
        <Link to="/contests" className="screen-link">
          返回比赛列表
        </Link>
      </ScreenShell>
    );
  }

  const phase = contestPhase(contest, now);
  const frozen = phase === 'frozen' || (data?.config.freezeAt ?? null) !== null;
  const statusLabel =
    phase === 'upcoming'
      ? CONTEST_PHASE_LABEL.upcoming
      : phase === 'running'
        ? CONTEST_PHASE_LABEL.running
        : phase === 'frozen'
          ? '封榜中'
          : CONTEST_PHASE_LABEL.ended;

  return (
    <ScreenShell>
      <header className="screen-header">
        <div className="screen-header-left">
          <div className="screen-brand">OiJudge · Contest Screen</div>
          <h1 className="screen-title">{contest.name}</h1>
          <div className="screen-subline">
            <span className={`screen-status screen-status-${phase}`}>{statusLabel}</span>
            <span className="screen-preset">{presetLabel(preset)}</span>
            {officialFrozen ? (
              <span className="screen-official-frozen">官方冻结至 {officialFrozenText}</span>
            ) : null}
            {archived ? <span className="screen-archived">已归档 · 只读</span> : null}
            <span>{contestCountdownText(contest, now)}</span>
            <span className="screen-mail">{formatClock(now)}</span>
          </div>
        </div>
        <div className="screen-controls">
          <label className="screen-top">
            <span>显示</span>
            <select
              value={topLimit}
              onChange={(event) => setTopLimit(event.target.value as '20' | '50' | 'all')}
              className="screen-select"
              aria-label="Top 数量"
            >
              <option value="20">Top 20</option>
              <option value="50">Top 50</option>
              <option value="all">全部</option>
            </select>
          </label>
          <Link to={`/contest/${contest.id}`} className="screen-link">
            返回比赛页
          </Link>
        </div>
      </header>

      {officialFrozen ? (
        <div className="screen-freeze screen-official-freeze-banner">
          <strong>官方分冻结</strong>
          <span>
            官方分冻结至 {officialFrozenText}（Hack 审核窗口），期间正式分不更新。
          </span>
        </div>
      ) : null}

      {frozen ? (
        <div className="screen-freeze">
          <strong>封榜中</strong>
          <span>
            榜单按封榜时间过滤，封榜后的提交暂不计入；当前显示 {ranking.length} 位选手。
          </span>
        </div>
      ) : null}
      {archived ? (
        <div className="screen-archive-note">该比赛已归档，以下为只读正式榜快照。</div>
      ) : null}

      <div className="screen-table-wrap">
        {rows.length === 0 ? (
          <div className="screen-empty">暂无参赛者</div>
        ) : (
          <table className="screen-table">
            <thead>
              <tr>
                <th className="screen-col-rank">排名</th>
                <th className="screen-col-player">选手</th>
                <th className="screen-col-class">班级</th>
                <th className="screen-col-total">总分</th>
                {problems.map((problem, index) => (
                  <th
                    key={problem.id}
                    className="screen-col-problem"
                    title={`${problem.title} · ${problem.points} 分`}
                  >
                    {rankingProblemLetter(index)}
                    <span className="screen-problem-id">#{problem.id}</span>
                  </th>
                ))}
                <th className="screen-col-penalty">{isAcm ? '罚时' : 'AC 数'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.userId}>
                  <td className="screen-col-rank">
                    <span className={`screen-rank screen-rank-${row.rank}`}>{row.rank}</span>
                  </td>
                  <td className="screen-col-player">
                    <span className="screen-player-name">
                      {row.realName ?? row.username}
                      {row.hackedCount > 0 ? (
                        <span
                          className="screen-hacked"
                          title={`被 Hack 提交数：${row.hackedCount}`}
                        >
                          HACKED
                        </span>
                      ) : null}
                    </span>
                    <span className="screen-player-meta">@{row.username}</span>
                  </td>
                  <td className="screen-col-class">{row.className ?? '未分班'}</td>
                  <td className="screen-col-total">{row.totalScore}</td>
                  {problems.map((problem) => {
                    const cell = row.cells.find((item) => item.problemId === problem.id);
                    return (
                      <td
                        key={problem.id}
                        className={`screen-col-problem${
                          cell?.verdict === 'AC' ? ' screen-cell-ac' : ''
                        }`}
                        title={
                          cell
                            ? `${cell.verdict ? verdictTitle(cell.verdict) : '未通过'} · ${
                                cell.score
                              } 分${cell.attempts > 0 ? ` · ${cell.attempts} 次提交` : ''}`
                            : '未提交'
                        }
                      >
                        {cell && cell.verdict !== null ? cell.score : '—'}
                      </td>
                    );
                  })}
                  <td className="screen-col-penalty">
                    {isAcm ? row.penalty : row.solved}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <footer className="screen-footer">
        <span>每 5 秒自动刷新</span>
        <span>更新于 {formatClock(Date.now())} · {presetLabel(preset)}只读数据</span>
      </footer>
    </ScreenShell>
  );
}
