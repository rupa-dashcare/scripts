/**
 * The ports. The core depends on these and never on a vendor SDK.
 * Every one of them has an in-memory fake in test/fakes.
 */
import type {
  DedupeKey, Draft, Issue, IssueKey, IssuePatch, Priority,
  SourceItem, SourceName, Status, TicketDraft, TimeWindow,
} from '../domain/types';

export interface Source {
  readonly name: SourceName;
  collect(window: TimeWindow): Promise<readonly SourceItem[]>;
}

export interface TicketStore {
  /** Batched — one query per run, not one per candidate (§4). */
  findExisting(keys: readonly DedupeKey[]): Promise<ReadonlySet<DedupeKey>>;
  create(draft: TicketDraft): Promise<IssueKey>;
  search(jql: string): Promise<readonly Issue[]>;
  transition(keys: readonly IssueKey[], to: Status): Promise<void>;
  update(keys: readonly IssueKey[], patch: IssuePatch): Promise<void>;
  comment(key: IssueKey, body: string): Promise<void>;
}

export interface CredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** Compare-and-swap. Guards refresh-token rotation against two writers (§3.2). */
  swap(key: string, expected: string | null, next: string): Promise<boolean>;
}

export interface Drafter {
  draft(item: SourceItem): Promise<Draft>;
}

export interface Notifier {
  post(channel: string, text: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

/** A single verifiable fact about the setup, with how to fix it if wrong. */
export interface SetupFinding {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** Copy-pasteable or click-by-click remediation. Shown only when ok is false. */
  readonly remedy?: string;
  /**
   * Something worth seeing but that we cannot verify, so it never fails the run.
   * Use this rather than guessing — a check that cries wolf is worse than no check.
   */
  readonly advisory?: boolean;
}

/**
 * Deeper than Checkable: verifies the project is actually shaped the way the
 * pipeline needs (statuses, fields, issue type, create permission).
 */
export interface SetupInspector {
  inspect(): Promise<readonly SetupFinding[]>;
}

/** Health probe used by `wf doctor`. Every adapter implements one. */
export interface Checkable {
  readonly checkName: string;
  check(): Promise<CheckResult>;
}

export interface CheckResult {
  readonly ok: boolean;
  readonly detail: string;
}

export type { Priority, Status };
