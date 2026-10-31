export const WS_EVENTS = {
  submissionQueued: 'submission.queued',
  submissionUpdated: 'submission.updated',
  rankingDelta: 'ranking.delta',
  announcement: 'announcement',
  clarification: 'clarification',
} as const;

export const VERDICTS = [
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
] as const;

export type Verdict = (typeof VERDICTS)[number];
