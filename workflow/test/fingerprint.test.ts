import { describe, expect, it } from 'vitest';
import { dedupeKey, dedupeLabel, sourceKey } from '../src/domain/fingerprint';

describe('fingerprint', () => {
  it('is stable across calls', () => {
    const k = sourceKey('slack', 'T1', 'C1', '1712345678.000100');
    expect(dedupeKey(k)).toBe(dedupeKey(k));
  });

  it('distinguishes different items', () => {
    expect(dedupeKey(sourceKey('slack', 'T1', 'C1', '1'))).not
      .toBe(dedupeKey(sourceKey('slack', 'T1', 'C1', '2')));
  });

  it('distinguishes the same id across sources', () => {
    expect(dedupeKey(sourceKey('slack', 'abc'))).not.toBe(dedupeKey(sourceKey('gmail', 'abc')));
  });

  it('produces a JQL-safe label', () => {
    const label = dedupeLabel(dedupeKey(sourceKey('drive', 'file1', 'comment2')));
    expect(label).toMatch(/^srckey-[0-9a-f]{16}$/);
    expect(label).not.toMatch(/[\s"']/);
  });

  it('rejects empty parts, which would collide silently', () => {
    expect(() => sourceKey('slack', '')).toThrow();
    expect(() => sourceKey('slack')).toThrow();
  });
});
