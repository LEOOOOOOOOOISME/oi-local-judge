import { describe, expect, it } from 'vitest';
import { resolveWorkerIsolationMode } from '../src/worker-isolation.js';

const workerFile = 'C:\\data\\runtime\\worker.json';

function reader(content: string | Error) {
  return () => {
    if (content instanceof Error) throw content;
    return content;
  };
}

describe('resolveWorkerIsolationMode', () => {
  it('uses the installer marker to request required mode', () => {
    expect(
      resolveWorkerIsolationMode({
        workerFile,
        env: {},
        readFile: reader(JSON.stringify({ username: 'OiJudgeWorker', required: true })),
      }),
    ).toBe('required');
  });

  it('tolerates a UTF-8 BOM in worker.json', () => {
    expect(
      resolveWorkerIsolationMode({
        workerFile,
        env: {},
        readFile: reader('\uFEFF{"required":true}'),
      }),
    ).toBe('required');
  });

  it('keeps optional when the marker is absent or not required', () => {
    expect(resolveWorkerIsolationMode({ workerFile, env: {}, readFile: reader('{"required":false}') })).toBeUndefined();
    expect(resolveWorkerIsolationMode({ workerFile, env: {}, readFile: reader('{}') })).toBeUndefined();
  });

  it('keeps optional for a missing or unreadable worker.json', () => {
    expect(
      resolveWorkerIsolationMode({
        workerFile,
        env: {},
        readFile: reader(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
      }),
    ).toBeUndefined();
    expect(resolveWorkerIsolationMode({ workerFile, env: {}, readFile: reader('{not json') })).toBeUndefined();
  });

  it('lets an explicit OIJ_WORKER_ISOLATION override the marker in both directions', () => {
    expect(
      resolveWorkerIsolationMode({
        workerFile,
        env: { OIJ_WORKER_ISOLATION: 'optional' },
        readFile: reader('{"required":true}'),
      }),
    ).toBe('optional');
    expect(
      resolveWorkerIsolationMode({
        workerFile,
        env: { OIJ_WORKER_ISOLATION: 'required' },
        readFile: reader('{"required":false}'),
      }),
    ).toBe('required');
  });
});
