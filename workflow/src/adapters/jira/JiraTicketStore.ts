import type { Checkable, CheckResult, TicketStore } from '../../ports/index';
import type {
  DedupeKey, Issue, IssueKey, IssuePatch, Priority, Status, TicketDraft,
} from '../../domain/types';
import { dedupeLabel } from '../../domain/fingerprint';
import type { ProjectAccess } from '../../domain/ProjectAccess';

export interface JiraOptions {
  /**
   * Where REST calls go. For a classic token this is the site URL; for a scoped
   * token it must be https://api.atlassian.com/ex/jira/<cloudId>, which is what
   * apiBaseUrl() builds. Scoped tokens 401 against the site URL.
   */
  readonly apiBaseUrl: string;
  readonly email: string;
  readonly apiToken: string;
  /** Every read and write is confined to this policy. See ProjectAccess. */
  readonly access: ProjectAccess;
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
  private readonly access: ProjectAccess;

  constructor(private readonly opts: JiraOptions) {
    this.http = opts.fetch ?? globalThis.fetch;
    this.access = opts.access;
  }

  /** Convenience for the adapter's own queries and URLs. */
  private get projectKey(): string {
    return this.access.writeKey;
  }

  async findExisting(keys: readonly DedupeKey[]): Promise<ReadonlySet<DedupeKey>> {
    const found = new Set<DedupeKey>();
    if (keys.length === 0) return found;

    // JQL has a practical clause limit; chunk rather than risk a 400.
    for (const chunk of chunked(keys, 100)) {
      const labels = chunk.map((k) => `"${dedupeLabel(k)}"`).join(', ');
      const issues = await this.query(this.access.confineWrite(`labels IN (${labels})`));
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
      project: { key: this.projectKey },
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
    const key = this.access.writeKeyFor(body.key);

    // A remote link makes "view original" one click (§6).
    await this.request('POST', `/rest/api/3/issue/${key}/remotelink`, {
      object: { url: draft.url, title: `Original — ${draft.source}` },
    }).catch(() => undefined);

    return key;
  }

  /** Public read path. Confined to the readable projects, never wider. */
  async search(jql: string): Promise<readonly Issue[]> {
    return this.query(this.access.confineRead(jql));
  }

  private async query(jql: string): Promise<readonly Issue[]> {
    const out: Issue[] = [];
    let startAt = 0;
    for (;;) {
      const page = await this.request<JiraSearch>('POST', '/rest/api/3/search', {
        jql, startAt, maxResults: 100,
        fields: ['summary', 'status', 'priority', 'duedate', 'labels', 'updated'],
      });
      for (const i of page.issues ?? []) {
        out.push({
          key: i.key as IssueKey,
          summary: i.fields.summary ?? '',
          status: (i.fields.status?.name ?? 'Staged') as Status,
          priority: (i.fields.priority?.name ?? 'Medium') as Priority,
          dueDate: i.fields.duedate ?? null,
          labels: i.fields.labels ?? [],
          updated: i.fields.updated ? new Date(i.fields.updated) : null,
        });
      }
      startAt += page.maxResults ?? 100;
      if (startAt >= (page.total ?? 0)) break;
    }
    // Belt and braces: prove confine() actually held rather than trusting it.
    this.access.assertReadable(out.map((i) => i.key));
    return out;
  }

  async transition(rawKeys: readonly IssueKey[], to: Status): Promise<void> {
    const keys = this.access.writeKeysFor(rawKeys);
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

  async update(rawKeys: readonly IssueKey[], patch: IssuePatch): Promise<void> {
    const keys = this.access.writeKeysFor(rawKeys);
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

  async comment(rawKey: IssueKey, body: string): Promise<void> {
    const key = this.access.writeKeyFor(rawKey);
    await this.request('POST', `/rest/api/3/issue/${key}/comment`, { body: adf(body) });
  }

  async check(): Promise<CheckResult> {
    try {
      const me = await this.request<{ displayName: string }>('GET', '/rest/api/3/myself');
      const proj = await this.request<{ name: string }>(
        'GET', `/rest/api/3/project/${this.projectKey}`,
      );
      return { ok: true, detail: `${me.displayName} → project "${proj.name}"` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Discovers custom field ids so .env can be filled in — `wf doctor`. */
  async listFields(): Promise<readonly { id: string; name: string }[]> {
    return this.request<{ id: string; name: string }[]>('GET', '/rest/api/3/field');
  }

  async projectInfo(): Promise<ProjectInfo> {
    const p = await this.request<{
      name: string; isPrivate?: boolean; style?: string; projectTypeKey?: string;
    }>('GET', `/rest/api/3/project/${this.projectKey}`);
    return {
      name: p.name,
      isPrivate: p.isPrivate === true,
      style: p.style ?? 'classic',
      projectTypeKey: p.projectTypeKey ?? 'software',
    };
  }

  async projectStatuses(): Promise<readonly { issueType: string; statuses: readonly string[] }[]> {
    const raw = await this.request<{ name: string; statuses: { name: string }[] }[]>(
      'GET', `/rest/api/3/project/${this.projectKey}/statuses`,
    );
    return raw.map((t) => ({ issueType: t.name, statuses: t.statuses.map((s) => s.name) }));
  }

  /** Issue types this account may actually create in the project. */
  async createMeta(): Promise<readonly string[]> {
    const meta = await this.request<{ projects?: { issuetypes?: { name: string }[] }[] }>(
      'GET',
      `/rest/api/3/issue/createmeta?projectKeys=${encodeURIComponent(this.projectKey)}`,
    );
    return meta.projects?.[0]?.issuetypes?.map((t) => t.name) ?? [];
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const auth = Buffer.from(`${this.opts.email}:${this.opts.apiToken}`).toString('base64');
    const res = await this.http(`${this.opts.apiBaseUrl}${path}`, {
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

export interface ProjectInfo {
  readonly name: string;
  readonly isPrivate: boolean;
  readonly style: string;
  /** software | business | service_desk — decides the settings URL shape. */
  readonly projectTypeKey: string;
}

interface JiraSearch {
  issues?: { key: string; fields: {
    summary?: string; status?: { name?: string }; priority?: { name?: string };
    duedate?: string | null; labels?: string[]; updated?: string;
  } }[];
  total?: number;
  maxResults?: number;
}

interface JiraTransitions {
  transitions: { id: string; name?: string; to?: { name?: string } }[];
}

/**
 * Scoped API tokens must be used against the api.atlassian.com gateway; classic
 * tokens work against the site URL. Passing the wrong one yields a bare 401 with
 * no explanation, so this is worth getting right in one place.
 */
export function apiBaseUrl(siteUrl: string, cloudId?: string): string {
  const site = siteUrl.replace(/\/+$/, '');
  return cloudId ? `https://api.atlassian.com/ex/jira/${cloudId}` : site;
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
