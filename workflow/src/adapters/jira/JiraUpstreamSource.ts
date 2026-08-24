import { sourceKey } from '../../domain/fingerprint';
import type { ProjectAccess } from '../../domain/ProjectAccess';
import type { Checkable, CheckResult, TicketStore } from '../../ports/index';
import type { Issue, SourceItem, TimeWindow } from '../../domain/types';

export interface JiraUpstreamOptions {
  /** Only search() is used. Reads are already confined by ProjectAccess. */
  readonly tickets: Pick<TicketStore, 'search'>;
  readonly access: ProjectAccess;
  readonly siteUrl: string;
  /** Statuses to skip. Anything already finished is not worth mirroring. */
  readonly skipStatuses?: readonly string[];
}

/**
 * Assignment is not the same as action.
 *
 * The first live run surfaced 27 issues, of which 21 sat in "Awaiting Client
 * Response" and 2 in "Backlog" — blocked on somebody else or not started.
 * Mirroring those buries the three that actually need doing.
 *
 * Site-specific, so it is configurable; this default reflects casedrive's
 * workflow. Statuses must match exactly — JQL has no wildcard for status.
 */
const DEFAULT_SKIP = [
  // finished
  'Done', 'Closed', 'Resolved', 'Cancelled', 'Canceled',
  // blocked on someone else
  'Awaiting Client Response', 'Awaiting Tab32 Response', 'Blocked', 'Waiting for support',
  // not started
  'Backlog',
];

/**
 * Mirrors issues assigned to me in the read-only projects (PP, DL, DEV) into
 * RUPA, so one queue shows everything I owe someone.
 *
 * It creates a **linked mirror, not a copy** — a pointer with the upstream's
 * priority and due date, never a duplicate of its content. The upstream issue
 * stays the source of truth and is never written to; this system cannot write
 * outside RUPA at all (DESIGN.md §6.5).
 *
 * Selection is mechanical: assigned to me, not finished, touched inside the
 * window. No model is involved.
 */
export class JiraUpstreamSource implements Checkable {
  readonly name = 'jira' as const;
  readonly checkName = 'jira-upstream';

  constructor(private readonly opts: JiraUpstreamOptions) {}

  /**
   * Deliberately ignores the time window.
   *
   * Every other source is event-shaped: a Slack reaction, an email arriving —
   * things that happen at a moment, where a window is the natural bound. "Issues
   * assigned to me and not finished" is a *state*, not an event. An issue
   * assigned four months ago and untouched since is still owed, and a window
   * would hide it forever — which is exactly what happened on the first live
   * run: 27 open issues, all last touched in April, all silently skipped.
   *
   * Re-reading the same set every run is cheap (one query) and harmless, because
   * dedup by srckey label makes creation idempotent regardless.
   */
  async collect(_window: TimeWindow): Promise<readonly SourceItem[]> {
    const mirrors = this.opts.access.mirrorKeys;
    if (mirrors.length === 0) return [];

    const projects = mirrors.map((k) => `"${k}"`).join(', ');
    const skip = (this.opts.skipStatuses ?? DEFAULT_SKIP).map((s) => `"${s}"`).join(', ');

    const jql = `project IN (${projects}) AND assignee = currentUser()`
      + ` AND status NOT IN (${skip})`;

    const issues = await this.opts.tickets.search(jql);

    return issues
      // Never mirror our own output — that would feed the queue into itself.
      .filter((i) => !this.opts.access.canWrite(i.key))
      .map((i) => this.toItem(i));
  }

  private toItem(issue: Issue): SourceItem {
    const url = `${this.opts.siteUrl}/browse/${issue.key}`;
    return {
      sourceKey: sourceKey('jira', issue.key),
      source: 'jira',
      title: issue.summary,
      body: [
        `Mirrored from ${issue.key} — the upstream issue stays the source of truth.`,
        '',
        `Status:   ${issue.status}`,
        `Priority: ${issue.priority}`,
        `Due:      ${issue.dueDate ?? '—'}`,
        '',
        url,
      ].join('\n'),
      url,
      occurredAt: issue.updated ?? new Date(0),
      actors: [],
      hints: {
        upstreamKey: issue.key,
        upstreamPriority: issue.priority,
        upstreamDueDate: issue.dueDate,
        upstreamStatus: issue.status,
      },
    };
  }

  async check(): Promise<CheckResult> {
    const mirrors = this.opts.access.mirrorKeys;
    if (mirrors.length === 0) {
      return { ok: true, detail: 'no read-only projects configured — nothing to mirror' };
    }
    try {
      await this.opts.tickets.search(`project IN (${mirrors.map((k) => `"${k}"`).join(', ')})`);
      return { ok: true, detail: `mirroring from ${mirrors.join(', ')} (read-only)` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        detail: /401|403|scope/i.test(msg) ? 'blocked by token scopes — see below' : msg,
      };
    }
  }
}
