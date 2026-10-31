import type { Contest } from '../api/types';
import { useNow } from '../hooks/useNow';
import {
  CONTEST_PHASE_LABEL,
  contestCountdownText,
  contestPhase,
} from '../utils/status';

export function ContestCountdown({
  contest,
  inline = false,
}: {
  contest: Pick<Contest, 'start_at' | 'end_at' | 'status'>;
  inline?: boolean;
}) {
  const now = useNow(1000);
  const phase = contestPhase(contest, now);
  const text = contestCountdownText(contest, now);

  if (inline) {
    return <span className={`countdown countdown-${phase}`}>{text}</span>;
  }

  return (
    <div className={`countdown-box countdown-${phase}`}>
      <div className="countdown-phase">{CONTEST_PHASE_LABEL[phase]}</div>
      <div className="countdown-text">{text}</div>
      {contest.start_at !== null && contest.end_at !== null ? (
        <div className="countdown-range">
          {new Date(contest.start_at).toLocaleString('zh-CN', { hour12: false })}
          <br />至 {new Date(contest.end_at).toLocaleString('zh-CN', { hour12: false })}
        </div>
      ) : null}
    </div>
  );
}
