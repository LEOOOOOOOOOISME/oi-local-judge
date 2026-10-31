import { describe, expect, it } from 'vitest';
import { VERDICTS, WS_EVENTS } from './protocol.js';

describe('protocol', () => {
  it('keeps stable WebSocket event names', () => {
    expect(WS_EVENTS).toEqual({
      submissionQueued: 'submission.queued',
      submissionUpdated: 'submission.updated',
      rankingDelta: 'ranking.delta',
      announcement: 'announcement',
      clarification: 'clarification',
    });
  });

  it('contains all judge verdicts', () => {
    expect(VERDICTS).toEqual([
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
  });
});
