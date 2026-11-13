import { describe, expect, it } from 'vitest';
import { BoundedTtlMap } from '../src/http/auth-rate-limit.js';

describe('BoundedTtlMap', () => {
  it('expires old entries and caps the number of keys', () => {
    let now = 1_000;
    const map = new BoundedTtlMap<number>(3, 100, () => now);
    map.record('a', 1000);
    map.record('b', 1000);
    map.record('c', 1000);
    map.record('d', 1000);
    expect(map.size).toBe(3);
    expect(map.get('a')).toEqual([]);

    now = 1_200;
    expect(map.get('b')).toEqual([]);
    expect(map.size).toBe(0);
  });

  it('keeps only the active window for a key', () => {
    let now = 1_000;
    const map = new BoundedTtlMap<number>(4, 100, () => now);
    map.record('a', 1000);
    now = 1_050;
    map.record('a', 1050);
    now = 1_120;
    expect(map.get('a')).toEqual([1050]);
  });
});
