import { describe, expect, it } from 'vitest';
import { serverPortFromEnv } from '../src/server-port.js';

describe('desktop server port', () => {
  it('defaults to the documented 8787 port', () => {
    expect(serverPortFromEnv({})).toBe('8787');
    expect(serverPortFromEnv({ OIJ_PORT: '   ' })).toBe('8787');
  });

  it('honours an explicit operator override', () => {
    expect(serverPortFromEnv({ OIJ_PORT: '9000' })).toBe('9000');
    expect(serverPortFromEnv({ OIJ_PORT: '0' })).toBe('0');
  });
});
