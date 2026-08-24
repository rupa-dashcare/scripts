import { createHash } from 'node:crypto';
import type { DedupeKey, SourceName } from './types';

/**
 * Stable, globally unique identity for a source item (DESIGN.md §4).
 * Parts must be things the source itself guarantees are immutable —
 * a Slack ts, a Gmail message id — never anything derived from content.
 */
export function sourceKey(source: SourceName, ...parts: readonly string[]): string {
  if (parts.length === 0 || parts.some((p) => p.length === 0)) {
    throw new Error(`sourceKey(${source}): every part must be a non-empty string`);
  }
  return `${source}:${parts.join('/')}`;
}

/** Jira short-text fields only support fuzzy ~ in JQL, so dedup rides on a label. */
export function dedupeKey(key: string): DedupeKey {
  return createHash('sha1').update(key).digest('hex').slice(0, 16) as DedupeKey;
}

export function dedupeLabel(key: DedupeKey): string {
  return `srckey-${key}`;
}
