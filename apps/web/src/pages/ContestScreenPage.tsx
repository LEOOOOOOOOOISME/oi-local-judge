import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { OfficialRanking } from '../api/types';
import { useNow } from '../hooks/useNow';
import {
  CONTEST_PHASE_LABEL,
  contestPhase,
  verdictTitle,
} from '../utils/status';
import {
  fetchOfficialRanking,
  presetFromMode,
  presetLabel,
} from '../utils/officialRanking';
import { rankingProblemLetter } from '../utils/ranking';
import {
  rollIntervalMs,
  rollRevealCount,
  screenCountdown,
  type ScreenMode,
} from '../utils/screen';
import '../styles/screen.css';

const ROLL_SPEEDS = [0.5, 1, 2] as const;
const ROLL_STEP = 1;

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
  const [mode, setMode] = useState<ScreenMode>('live');
  const [rollRevealed, setRollRevealed] = useState(0);
  const [rollRunning, setRollRunning] = useState(false);
  const [rollSpeed, setRollSpeed] = useState<0.5 | 1 | 2>(1);

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

  const totalRows = rows.length;
  const revealed = Math.min(rollRevealed, totalRows);
  const rollComplete = totalRows > 0 && revealed >= totalRows;
  const rollStarted = revealed > 0;
  const rollPercent = totalRows > 0 ? Math.round((revealed / totalRows) * 100) : 0;
  const rollActionLabel = rollRunning
    ? '暂停'
    : rollComplete
      ? '已全部揭示'
      : rollStarted
        ? '继续'
        : '开始滚榜';

  /** 换比赛时重置滚榜，避免沿用上一场的揭示进度。 */
  useEffect(() => {
    setRollRevealed(0);
    setRollRunning(false);
  }, [contestId]);

  /** 榜单变短（Top N 调整/选手减少）时收敛，但不重置已揭示数量。 */
  useEffect(() => {
    setRollRevealed((prev) => Math.min(prev, rows.length));
  }, [rows.length]);

  /** 滚榜定时器：仅滚榜模式运行，卸载/暂停/切换模式时清理。 */
  useEffect(() => {
    if (mode !== 'roll' || !rollRunning || rows.length === 0) return;
    const timer = window.setInterval(() => {
      setRollRevealed((prev) => rollRevealCount(rows.length, prev, ROLL_STEP));
    }, rollIntervalMs(rollSpeed));
    return () => window.clearInterval(timer);
  }, [mode, rollRunning, rollSpeed, rows.length]);

  useEffect(() => {
    if (rollRunning && totalRows > 0 && revealed >= totalRows) {
      setRollRunning(false);
    }
  }, [rollRunning, revealed, totalRows]);

  function toggleRoll() {
    if (rollRunning) {
      setRollRunning(false);
      return;
    }
    if (totalRows === 0 || revealed >= totalRows) return;
    setRollRevealed((prev) => rollRevealCount(totalRows, prev, ROLL_STEP));
    setRollRunning(true);
  }

  function skipRoll() {
    setRollRunning(false);
    setRollRevealed(totalRows);
  }

  function resetRoll() {
    setRollRunning(false);
    setRollRevealed(0);
  }

  function changeMode(next: ScreenMode) {
    if (next === mode) return;
    setMode(next);
    if (next === 'live') setRollRunning(false);
  }

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
  const freezeAt = contest.freeze_at ?? data?.config.freezeAt ?? null;
  const frozen = phase === 'frozen' || (freezeAt !== null && freezeAt <= now);
  const countdown = screenCountdown(
    {
      start_at: contest.start_at,
      end_at: contest.end_at,
      freeze_at: freezeAt,
      status: contest.status,
    },
    now,
  );
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
            <span className="screen-mail">{formatClock(now)}</span>
          </div>
        </div>
        <div className="screen-header-right">
          <div
            className={`screen-countdown screen-countdown-${countdown.kind}${
              countdown.parts?.urgent ? ' screen-countdown-urgent' : ''
            }`}
          >
            <span className="screen-countdown-label">{countdown.label}</span>
            {countdown.parts ? (
              <span className="screen-countdown-time">{countdown.parts.text}</span>
            ) : null}
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
            <div className="screen-mode" role="group" aria-label="大屏模式">
              <button
                type="button"
                className={`screen-mode-btn${mode === 'live' ? ' is-active' : ''}`}
                onClick={() => changeMode('live')}
                aria-pressed={mode === 'live'}
              >
                实时榜
              </button>
              <button
                type="button"
                className={`screen-mode-btn${mode === 'roll' ? ' is-active' : ''}`}
                onClick={() => changeMode('roll')}
                aria-pressed={mode === 'roll'}
              >
                ICPC 滚榜
              </button>
            </div>
            <Link to={`/contest/${contest.id}`} className="screen-link">
              返回比赛页
            </Link>
          </div>
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

      {mode === 'roll' ? (
        <section className="screen-roll-bar" aria-label="ICPC 滚榜控制">
          <div className="screen-roll-summary">
            <span
              className={`screen-roll-state${rollComplete ? ' screen-roll-state-done' : ''}`}
            >
              {rollComplete
                ? '滚榜完成'
                : rollRunning
                  ? '滚榜进行中'
                  : rollStarted
                    ? '已暂停'
                    : '等待开始'}
            </span>
            <span className="screen-roll-progress-text">
              已揭示 {revealed}/{totalRows}
            </span>
            <div
              className="screen-roll-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={totalRows}
              aria-valuenow={revealed}
              aria-label="滚榜揭示进度"
            >
              <span style={{ width: `${rollPercent}%` }} />
            </div>
          </div>
          <div className="screen-roll-actions">
            <button
              type="button"
              className="screen-roll-btn screen-roll-btn-primary"
              onClick={toggleRoll}
              disabled={totalRows === 0 || (rollComplete && !rollRunning)}
            >
              {rollActionLabel}
            </button>
            <button
              type="button"
              className="screen-roll-btn"
              onClick={skipRoll}
              disabled={totalRows === 0 || rollComplete}
            >
              跳过全部
            </button>
            <button
              type="button"
              className="screen-roll-btn screen-roll-btn-reset"
              onClick={resetRoll}
              disabled={revealed === 0 && !rollRunning}
            >
              重置
            </button>
            <div className="screen-roll-speed" role="group" aria-label="滚榜速度">
              {ROLL_SPEEDS.map((speed) => (
                <button
                  key={speed}
                  type="button"
                  className={`screen-roll-speed-btn${rollSpeed === speed ? ' is-active' : ''}`}
                  onClick={() => setRollSpeed(speed)}
                  aria-pressed={rollSpeed === speed}
                >
                  {speed}x
                </button>
              ))}
            </div>
          </div>
        </section>
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
              {rows.map((row, index) => {
                const isRevealed = mode !== 'roll' || index >= totalRows - revealed;
                return (
                  <tr
                    key={row.userId}
                    className={
                      mode === 'roll'
                        ? `screen-roll-row ${
                            isRevealed ? 'screen-roll-revealed' : 'screen-roll-hidden'
                          }`
                        : undefined
                    }
                    aria-hidden={mode === 'roll' && !isRevealed ? true : undefined}
                  >
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
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <footer className="screen-footer">
        <span>
          每 5 秒自动刷新
          {mode === 'roll' ? ' · 滚榜仅影响展示，不修改排名与分数' : ''}
        </span>
        <span>更新于 {formatClock(Date.now())} · {presetLabel(preset)}只读数据</span>
      </footer>
    </ScreenShell>
  );
}
