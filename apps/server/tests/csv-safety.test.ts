import { describe, expect, it } from 'vitest';
import { csvCell } from '../src/services/csv.js';

describe('CSV cell escaping', () => {
  it('neutralizes spreadsheet formulas', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+cmd')).toBe("'+cmd");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('still quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell('a\nb')).toBe('"a\nb"');
    expect(csvCell('normal')).toBe('normal');
  });
});
