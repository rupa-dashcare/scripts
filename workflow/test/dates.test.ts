import { describe, expect, it } from 'vitest';
import { addBusinessDays, addDays, toJiraDate } from '../src/domain/dates';

describe('dates', () => {
  it('adds calendar days', () => {
    expect(toJiraDate(addDays(new Date('2026-08-20T00:00:00Z'), 7))).toBe('2026-08-27');
  });

  it.each([
    // Thursday 2026-08-20 → +1 business day is Friday
    ['2026-08-20T00:00:00Z', 1, '2026-08-21'],
    // Thursday +2 skips the weekend → Monday
    ['2026-08-20T00:00:00Z', 2, '2026-08-24'],
    // Friday +1 → Monday
    ['2026-08-21T00:00:00Z', 1, '2026-08-24'],
    // Friday +5 → the next Friday
    ['2026-08-21T00:00:00Z', 5, '2026-08-28'],
    // Saturday +1 → Monday
    ['2026-08-22T00:00:00Z', 1, '2026-08-24'],
  ])('addBusinessDays(%s, %i) = %s', (from, n, expected) => {
    expect(toJiraDate(addBusinessDays(new Date(from), n))).toBe(expected);
  });

  it('never lands on a weekend', () => {
    for (let n = 1; n <= 30; n += 1) {
      const d = addBusinessDays(new Date('2026-08-20T00:00:00Z'), n);
      expect([0, 6]).not.toContain(d.getUTCDay());
    }
  });
});
