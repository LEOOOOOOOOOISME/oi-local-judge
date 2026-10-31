import type { SubmissionStatus, Verdict } from '../api/types';
import { SUBMISSION_STATUS_LABEL, verdictTitle } from '../utils/status';

const KNOWN_VERDICTS = new Set<string>([
  'AC',
  'WA',
  'TLE',
  'MLE',
  'RE',
  'CE',
  'OLE',
  'PE',
  'PC',
  'SK',
  'SE',
  'UKE',
]);

export function VerdictBadge({
  verdict,
  size = 'sm',
}: {
  verdict: Verdict | null | undefined;
  size?: 'sm' | 'lg';
}) {
  if (!verdict) {
    return <span className={`verdict verdict-none${size === 'lg' ? ' verdict-lg' : ''}`}>—</span>;
  }
  const kind = KNOWN_VERDICTS.has(verdict) ? verdict.toLowerCase() : 'none';
  return (
    <span
      className={`verdict verdict-${kind}${size === 'lg' ? ' verdict-lg' : ''}`}
      title={verdictTitle(verdict)}
    >
      {verdict}
    </span>
  );
}

export function SubmissionStatusBadge({
  status,
  verdict,
}: {
  status: SubmissionStatus;
  verdict: Verdict | null;
}) {
  if (status === 'finished') {
    return <VerdictBadge verdict={verdict} />;
  }
  return (
    <span className={`sub-status sub-status-${status}`}>
      {SUBMISSION_STATUS_LABEL[status] ?? status}
    </span>
  );
}
