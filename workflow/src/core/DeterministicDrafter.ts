import type { Drafter } from '../ports/index';
import type { Draft, SourceItem } from '../domain/types';

/**
 * The fallback from §1: no model, no network, never fails.
 * The LLM drafter (Phase 1) wraps this and falls back to it on any error
 * or schema-validation failure, so drafting can degrade but not break.
 */
export class DeterministicDrafter implements Drafter {
  constructor(private readonly maxTitle = 120) {}

  async draft(item: SourceItem): Promise<Draft> {
    return {
      title: truncate(firstLine(item.title) || firstLine(item.body) || 'Untitled', this.maxTitle),
      description: [item.body.trim(), '', `Source: ${item.url}`].join('\n'),
    };
  }
}

function firstLine(s: string): string {
  return (s.split('\n').find((l) => l.trim().length > 0) ?? '').trim();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}
