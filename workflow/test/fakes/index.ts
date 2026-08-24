/**
 * An in-memory implementation of every port (§11.6).
 * The core suite uses these instead of mocks — no vi.mock, no call-order asserts.
 */
import { dedupeLabel } from '../../src/domain/fingerprint';
import type {
  Clock, CredentialStore, Drafter, Logger, Notifier, Source, TicketStore,
} from '../../src/ports/index';
import type {
  DedupeKey, Draft, Issue, IssueKey, IssuePatch, SourceItem, SourceName,
  Status, TicketDraft, TimeWindow,
} from '../../src/domain/types';

export class FakeClock implements Clock {
  private current: Date;
  constructor(iso: string) { this.current = new Date(iso); }
  now(): Date { return new Date(this.current.getTime()); }
  advance(ms: number): void { this.current = new Date(this.current.getTime() + ms); }
}

export class InMemoryTicketStore implements TicketStore {
  readonly created: TicketDraft[] = [];
  readonly comments: { key: IssueKey; body: string }[] = [];
  private readonly issues = new Map<IssueKey, Issue>();
  private counter = 0;

  async findExisting(keys: readonly DedupeKey[]): Promise<ReadonlySet<DedupeKey>> {
    const labels = new Set<string>();
    for (const issue of this.issues.values()) for (const l of issue.labels) labels.add(l);
    return new Set(keys.filter((k) => labels.has(dedupeLabel(k))));
  }

  async create(draft: TicketDraft): Promise<IssueKey> {
    this.counter += 1;
    const key = `RUPA-${this.counter}` as IssueKey;
    this.created.push(draft);
    this.issues.set(key, {
      key,
      summary: draft.title,
      status: 'Staged',
      priority: draft.priority,
      dueDate: draft.dueDate,
      labels: [...draft.labels],
    });
    return key;
  }

  async search(): Promise<readonly Issue[]> { return [...this.issues.values()]; }

  async transition(keys: readonly IssueKey[], to: Status): Promise<void> {
    for (const k of keys) {
      const i = this.issues.get(k);
      if (i) this.issues.set(k, { ...i, status: to });
    }
  }

  async update(keys: readonly IssueKey[], patch: IssuePatch): Promise<void> {
    for (const k of keys) {
      const i = this.issues.get(k);
      if (!i) continue;
      this.issues.set(k, {
        ...i,
        priority: patch.priority ?? i.priority,
        dueDate: patch.dueDate !== undefined ? patch.dueDate : i.dueDate,
      });
    }
  }

  async comment(key: IssueKey, body: string): Promise<void> {
    this.comments.push({ key, body });
  }
}

export class StubSource implements Source {
  constructor(
    readonly name: SourceName,
    private readonly items: readonly SourceItem[],
  ) {}
  async collect(_window: TimeWindow): Promise<readonly SourceItem[]> { return this.items; }
}

export class ExplodingSource implements Source {
  constructor(readonly name: SourceName, private readonly message = 'upstream 503') {}
  async collect(): Promise<readonly SourceItem[]> { throw new Error(this.message); }
}

export class StubDrafter implements Drafter {
  async draft(item: SourceItem): Promise<Draft> {
    return { title: item.title, description: item.body };
  }
}

export class ExplodingDrafter implements Drafter {
  async draft(): Promise<Draft> { throw new Error('model unavailable'); }
}

export class InMemoryCredentialStore implements CredentialStore {
  private readonly map = new Map<string, string>();
  async get(k: string): Promise<string | null> { return this.map.get(k) ?? null; }
  async set(k: string, v: string): Promise<void> { this.map.set(k, v); }
  async swap(k: string, expected: string | null, next: string): Promise<boolean> {
    if ((this.map.get(k) ?? null) !== expected) return false;
    this.map.set(k, next);
    return true;
  }
}

export class RecordingNotifier implements Notifier {
  readonly posts: { channel: string; text: string }[] = [];
  async post(channel: string, text: string): Promise<void> {
    this.posts.push({ channel, text });
  }
}

export const silentLogger: Logger = { info: () => {}, warn: () => {} };

export function item(over: Partial<SourceItem> = {}): SourceItem {
  return {
    sourceKey: 'slack:T1/C1/1712345678.000100',
    source: 'slack',
    title: 'Rotate the staging cert',
    body: 'The staging cert expires next week, someone should rotate it.',
    url: 'https://example.slack.com/archives/C1/p1712345678000100',
    occurredAt: new Date('2026-08-20T10:00:00Z'),
    actors: ['rupa'],
    hints: {},
    ...over,
  };
}
