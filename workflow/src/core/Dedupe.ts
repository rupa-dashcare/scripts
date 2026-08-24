import { dedupeKey } from '../domain/fingerprint';
import type { TicketStore } from '../ports/index';
import type { DedupeKey, SourceItem } from '../domain/types';

export interface DedupeResult {
  readonly fresh: readonly SourceItem[];
  readonly duplicates: number;
}

/**
 * Jira is the only source of truth for "does this already exist" (§4).
 * One batched query per run, never one per candidate.
 */
export class Dedupe {
  constructor(private readonly tickets: TicketStore) {}

  async filter(items: readonly SourceItem[]): Promise<DedupeResult> {
    if (items.length === 0) return { fresh: [], duplicates: 0 };

    const keyed = items.map((item) => ({ item, key: dedupeKey(item.sourceKey) }));

    // Two items in the same run can share a key; keep the first.
    const seen = new Set<DedupeKey>();
    const unique: typeof keyed = [];
    let duplicates = 0;
    for (const entry of keyed) {
      if (seen.has(entry.key)) { duplicates += 1; continue; }
      seen.add(entry.key);
      unique.push(entry);
    }

    const existing = await this.tickets.findExisting([...seen]);
    const fresh: SourceItem[] = [];
    for (const entry of unique) {
      if (existing.has(entry.key)) duplicates += 1;
      else fresh.push(entry.item);
    }

    return { fresh, duplicates };
  }
}
