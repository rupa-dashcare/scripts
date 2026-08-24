import type { Checkable, CheckResult, TicketStore } from '../../ports/index';
import type {
  DedupeKey, Issue, IssueKey, IssuePatch, Priority, Status, TicketDraft,
} from '../../domain/types';
import { dedupeLabel } from '../../domain/fingerprint';

export interface JiraOptions {
  readonly baseUrl: string;
  readonly email: string;
  readonly apiToken: string;
  readonly projectKey: string;
  readonly fieldSource?: string;
  readonly fieldSourceKey?: string;
  readonly fieldSourceUrl?: string;
  readonly stagedStatus?: Status;
  readonly fetch?: typeof globalThis.fetch;
}

/** Jira Cloud REST v3 over plain fetch — no SDK, so the adapter stays thin. */
export class JiraTicketStore implements TicketStore, Checkable {
  readonly checkName = 'jira';
  private readonly http: typeof globalThis.fetch;

  constructor(private readonly opts: JiraOptions) {
    this.http = opts.fetch ?? globalThis.fetch;
  }

  async findExisting(keys: readonly DedupeKey[]): Promise<ReadonlySet<DedupeKey>> {
    const found = new Set<DedupeKey>();
    if (keys.length === 0) return found;

    // JQL has a practical clause limit; chunk rather than risk a 400.
    for (const chunk of chunked(keys, 100)) {
      const labels = chunk.map((k) => `"${dedupeLabel(k)}"`).join(', ');
      const jql = `project = "${this.opts.projectKey}" AND labels IN (${labels})`;
      const issues = await this.search(jql);
      for (const issue of issues) {
        for (const label of issue.labels) {
          const m = /^srckey-([0-9a-f]{16})$/.exec(label);
          if (m?.[1]) found.add(m[1] as DedupeKey);
        }
      }
    }
    return found;
  }

  async create(draft: TicketDraft): Promise<IssueKey> {
    const fields: Record<string, unknown> = {
      project: { key: this.opts.projectKey },
      summary: draft.title,
      issuetype: { name: 'Task' },
      description: adf(draft.description),
      priority: { name: draft.priority },
      labels: [...draft.labels],
    };
    if (draft.dueDate) fields.duedate = draft.dueDate;
    if (this.opts.fieldSource) fields[this.opts.fieldSource] = { value: draft.source };
    if (this.opts.fieldSourceKey) fields[this.opts.fieldSourceKey] = draft.sourceKey;
    if (this.opts.fieldSourceUrl) fields[this.opts.fieldSourceUrl] = draft.url;

    const body = await this.request<{ key: string }>('POST', '/rest/api/3/issue', { fields });
    const key = body.key as IssueKey;

    // A remote link makes "view original" one click (§6).
    await this.request('POST', `/rest/api/3/issue/${key}/remotelink`, {
      object: { url: draft.url, title: `Original — ${draft.source}` },
    }).catch(() => undefined);

    return key;
  }

  async search(jql: string): Promise<readonly Issue[]> {
    const out: Issue[] = [];
    let startAt = 0;
    for (;;) {
      const page = await this.request<JiraSearch>('POST', '/rest/api/3/search', {
        jql, startAt, maxResults: 100,
        fields: ['summary', 'status', 'priority', 'duedate', 'labels'],
      });
      for (const i of page.issues ?? []) {
        out.push({
          key: i.key as IssueKey,
          summary: i.fields.summary ?? '',
          status: (i.fields.status?.name ?? 'Staged') as Status,
          priority: (i.fields.priority?.name ?? 'Medium') as Priority,
          dueDate: i.fields.duedate ?? null,
          labels: i.fields.labels ?? [],
        });
      }
      startAt += page.maxResults ?? 100;
      if (startAt >= (page.total ?? 0)) break;
    }
    return out;
  }

  async transition(keys: readonly IssueKey[], to: Status): Promise<void> {
    for (const key of keys) {
      const { transitions } = await this.request<JiraTransitions>(
        'GET', `/rest/api/3/issue/${key}/transitions`,
      );
      const match = transitions.find((t) => t.to?.name === to || t.name === to);
      if (!match) throw new Error(`${key}: no transition to "${to}" from its current status`);
      await this.request('POST', `/rest/api/3/issue/${key}/transitions`, {
        transition: { id: match.id },
      });
    }
  }

  async update(keys: readonly IssueKey[], patch: IssuePatch): Promise<void> {
    for (const key of keys) {
      const fields: Record<string, unknown> = {};
      if (patch.priority) fields.priority = { name: patch.priority };
      if (patch.dueDate !== undefined) fields.duedate = patch.dueDate;

      const update: Record<string, unknown> = {};
      const labelOps = [
        ...(patch.addLabels ?? []).map((l) => ({ add: l })),
        ...(patch.removeLabels ?? []).map((l) => ({ remove: l })),
      ];
      if (labelOps.length > 0) update.labels = labelOps;

      const payload: Record<string, unknown> = {};
      if (Object.keys(fields).length > 0) payload.fields = fields;
      if (Object.keys(update).length > 0) payload.update = update;
      if (Object.keys(payload).length === 0) continue;

      await this.request('PUT', `/rest/api/3/issue/${key}`, payload);
    }
  }

  async comment(key: IssueKey, body: string): Promise<void> {
    await this.request('POST', `/rest/api/3/issue/${key}/comment`, { body: adf(body) });
  }

  async check(): Promise<CheckResult> {
    try {
      const me = await this.request<{ displayName: string }>('GET', '/rest/api/3/myself');
      const proj = await this.request<{ name: string }>(
        'GET', `/rest/api/3/project/${this.opts.projectKey}`,
      );
      return { ok: true, detail: `${me.displayName} → project "${proj.name}"` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Discovers custom field ids so .env can be filled in — `wf doctor --fields`. */
  async listFields(): Promise<readonly { id: string; name: string }[]> {
    return this.request<{ id: string; name: string }[]>('GET', '/rest/api/3/field');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const auth = Buffer.from(`${this.opts.email}:${this.opts.apiToken}`).toString('base64');
    const res = await this.http(`${this.opts.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Basic ${auth}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Jira ${method} ${path} → ${res.status} ${res.statusText} ${text.slice(0, 300)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

interface JiraSearch {
  issues?: { key: string; fields: {
    summary?: string; status?: { name?: string }; priority?: { name?: string };
    duedate?: string | null; labels?: string[];
  } }[];
  total?: number;
  maxResults?: number;
}

interface JiraTransitions {
  transitions: { id: string; name?: string; to?: { name?: string } }[];
}

/** Jira Cloud wants Atlassian Document Format, not a plain string. */
function adf(text: string): unknown {
  return {
    type: 'doc',
    version: 1,
    content: text.split('\n\n').map((para) => ({
      type: 'paragraph',
      content: para.length > 0 ? [{ type: 'text', text: para }] : [],
    })),
  };
}

function* chunked<T>(items: readonly T[], size: number): Generator<readonly T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}
