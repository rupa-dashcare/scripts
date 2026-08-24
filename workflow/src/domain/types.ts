/** Pure domain vocabulary. No I/O, no vendor types, no imports outside domain/. */

export type SourceName =
  | 'slack' | 'granola' | 'gmail' | 'graph' | 'drive' | 'calendar' | 'jira';

export type Priority = 'Highest' | 'High' | 'Medium' | 'Low' | 'Lowest';

export type Status = 'Staged' | 'To Do' | 'In Progress' | 'Done' | 'Rejected';

/** sha1(sourceKey) truncated — the exact-matchable half of the dedup pair. */
export type DedupeKey = string & { readonly __brand: 'DedupeKey' };
export type IssueKey = string & { readonly __brand: 'IssueKey' };

export interface TriageHints {
  readonly channel?: string;
  readonly labels?: readonly string[];
  readonly folder?: string;
  readonly senderDomain?: string;
  readonly isVip?: boolean;
  readonly attendees?: readonly string[];
  /** A date the source itself stated, e.g. "by Friday" in a meeting action item. */
  readonly statedDueDate?: string;
}

/** What every adapter produces. The pipeline knows nothing else about a source. */
export interface SourceItem {
  readonly sourceKey: string;
  readonly source: SourceName;
  /** Deterministic fallback title, used verbatim if drafting fails. */
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly occurredAt: Date;
  readonly actors: readonly string[];
  readonly hints: TriageHints;
}

export interface Triage {
  readonly priority: Priority;
  readonly dueDate: string | null;
  /** Which rules fired, in order. Written to the issue so triage is auditable. */
  readonly reasons: readonly string[];
}

export interface Draft {
  readonly title: string;
  readonly description: string;
  /** Optional model suggestion. Never written to the priority field — §5. */
  readonly suggestedPriority?: Priority;
  readonly suggestionReason?: string;
}

export interface TicketDraft {
  readonly sourceKey: string;
  readonly dedupeKey: DedupeKey;
  readonly source: SourceName;
  readonly title: string;
  readonly description: string;
  readonly url: string;
  readonly priority: Priority;
  readonly dueDate: string | null;
  readonly labels: readonly string[];
}

export interface Issue {
  readonly key: IssueKey;
  readonly summary: string;
  readonly status: Status;
  readonly priority: Priority;
  readonly dueDate: string | null;
  readonly labels: readonly string[];
}

export interface IssuePatch {
  readonly priority?: Priority;
  readonly dueDate?: string | null;
  readonly addLabels?: readonly string[];
  readonly removeLabels?: readonly string[];
}

export interface TimeWindow {
  readonly from: Date;
  readonly to: Date;
}

export interface SourceFailure {
  readonly source: SourceName;
  readonly error: string;
}

export interface RunReport {
  readonly collected: number;
  readonly duplicates: number;
  readonly created: readonly IssueKey[];
  readonly failures: readonly SourceFailure[];
}
