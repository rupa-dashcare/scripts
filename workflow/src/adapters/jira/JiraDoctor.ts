import type { SetupFinding, SetupInspector } from '../../ports/index';

interface Probe {
  readonly ok: boolean;
  readonly status: number;
  readonly message: string;
}

interface JiraApi {
  probe(method: string, path: string, body?: unknown): Promise<Probe>;
  allStatuses(): Promise<readonly string[]>;
  listFields(): Promise<readonly { id: string; name: string }[]>;
  projectStatuses(): Promise<readonly { issueType: string; statuses: readonly string[] }[]>;
  createMeta(): Promise<readonly string[]>;
  projectInfo(): Promise<{
    name: string; isPrivate: boolean; style: string; projectTypeKey: string;
  }>;
}

/** Field names the pipeline expects, in the order .env lists them. */
const REQUIRED_FIELDS = [
  { env: 'JIRA_FIELD_SOURCE', name: 'Source' },
  { env: 'JIRA_FIELD_SOURCE_KEY', name: 'Source Key' },
  { env: 'JIRA_FIELD_SOURCE_URL', name: 'Source URL' },
] as const;

const REQUIRED_STATUSES = ['Staged', 'To Do', 'In Progress', 'Done', 'Rejected'] as const;

/**
 * Every capability the pipeline needs, the call that exercises it, and the
 * granular scope that call requires. Scoped API tokens fail with a bare
 * "scope does not match", so mapping the failure back to a scope name is the
 * difference between a two-minute fix and an afternoon of guessing.
 */
const SCOPE_PROBES = [
  { need: 'read project',     scope: 'read:project:jira',      method: 'GET',  path: (k: string) => `/rest/api/3/project/${k}` },
  { need: 'read statuses',    scope: 'read:issue-status:jira', method: 'GET',  path: (k: string) => `/rest/api/3/project/${k}/statuses` },
  { need: 'read fields',      scope: 'read:field:jira',        method: 'GET',  path: () => '/rest/api/3/field' },
  { need: 'read create meta', scope: 'read:issue-meta:jira',   method: 'GET',  path: (k: string) => `/rest/api/3/issue/createmeta?projectKeys=${k}` },
  { need: 'search issues',    scope: 'read:issue:jira + read:jql:jira', method: 'POST', path: () => '/rest/api/3/search/jql', body: (k: string) => ({ jql: `project = "${k}"`, maxResults: 1 }) },
] as const;

/**
 * Verifies the Jira project is shaped the way DESIGN.md §6 requires.
 * Everything here is read-only — doctor never mutates the project.
 */
export class JiraDoctor implements SetupInspector {
  constructor(
    private readonly api: JiraApi,
    private readonly projectKey: string,
    private readonly configured: Readonly<Record<string, string | undefined>>,
    private readonly siteUrl: string,
    /** Statuses the mirror is configured to skip, for validation. */
    private readonly mirrorSkipStatuses: readonly string[] = [],
  ) {}

  /** Learned from checkProject(), which always runs first. */
  private projectType = 'software';

  /** Work-management projects live under /jira/core, software under /jira/software. */
  private settings(projectTypeKey: string, page: string): string {
    const area = projectTypeKey === 'business'
      ? 'core'
      : projectTypeKey === 'service_desk' ? 'servicedesk' : 'software';
    return `${this.siteUrl}/jira/${area}/projects/${this.projectKey}/settings/${page}`;
  }

  async inspect(): Promise<readonly SetupFinding[]> {
    const findings: SetupFinding[] = [];

    // Scopes first: everything below fails confusingly without them.
    const scopes = await this.checkScopes();
    findings.push(...scopes);
    if (scopes.some((f) => !f.ok)) return findings;

    findings.push(...(await this.checkProject()));
    findings.push(await this.checkIssueType());
    findings.push(await this.checkStatuses());
    findings.push(...(await this.checkFields()));
    findings.push(await this.checkSkipStatuses());

    return findings;
  }

  /** Names the missing scope instead of leaving you with a bare 401. */
  private async checkScopes(): Promise<readonly SetupFinding[]> {
    const out: SetupFinding[] = [];
    for (const p of SCOPE_PROBES) {
      const body = 'body' in p ? p.body(this.projectKey) : undefined;
      const r = await this.api.probe(p.method, p.path(this.projectKey), body);

      if (r.ok) {
        out.push({ name: p.need, ok: true, detail: p.scope });
        continue;
      }
      const scopeIssue = r.status === 401 || r.status === 403;
      out.push({
        name: p.need,
        ok: false,
        detail: scopeIssue
          ? `token is missing ${p.scope}`
          : `HTTP ${r.status} ${r.message}`,
        ...(scopeIssue ? { remedy: `add scope: ${p.scope}` } : {}),
      });
    }
    return out;
  }

  private async checkProject(): Promise<readonly SetupFinding[]> {
    try {
      const p = await this.api.projectInfo();
      this.projectType = p.projectTypeKey;
      return [
        {
          name: 'project',
          ok: true,
          detail: `"${p.name}" (${p.style}, ${p.projectTypeKey})`,
        },
        {
          // The REST API's isPrivate flag does NOT track a team-managed project's
          // Open/Limited/Private access level — RUPA reads false while the UI shows
          // Private. There is no supported endpoint for the real value, so this is
          // reported as something to eyeball, never as a failure.
          name: 'access level',
          ok: true,
          advisory: true,
          detail: `not exposed by the API — confirm at ${this.settings(p.projectTypeKey, 'access')}`,
        },
      ];
    } catch (e) {
      return [{
        name: 'project',
        ok: false,
        detail: msg(e),
        remedy: `Create a private team-managed project with key ${this.projectKey} at ${this.siteUrl}/jira/projects?create=true`,
      }];
    }
  }

  private async checkIssueType(): Promise<SetupFinding> {
    try {
      const types = await this.api.createMeta();
      const ok = types.includes('Task');
      return {
        name: 'issue type "Task"',
        ok,
        detail: ok ? 'creatable' : `available: ${types.join(', ') || 'none'}`,
        ...(ok ? {} : { remedy: 'Add a "Task" issue type, or change the type in JiraTicketStore.create()' }),
      };
    } catch (e) {
      return { name: 'issue type "Task"', ok: false, detail: msg(e) };
    }
  }

  private async checkStatuses(): Promise<SetupFinding> {
    try {
      const perType = await this.api.projectStatuses();
      const present = new Set(perType.flatMap((t) => t.statuses));
      const missing = REQUIRED_STATUSES.filter((s) => !present.has(s));
      if (missing.length === 0) {
        return { name: 'workflow statuses', ok: true, detail: REQUIRED_STATUSES.join(' → ') };
      }
      return {
        name: 'workflow statuses',
        ok: false,
        detail: `missing: ${missing.join(', ')} (have: ${[...present].join(', ')})`,
        remedy: `${this.settings(this.projectType, 'workflows')} — add the missing statuses. "Staged" must be the status new issues land in.`,
      };
    } catch (e) {
      return { name: 'workflow statuses', ok: false, detail: msg(e) };
    }
  }

  /**
   * Jira accepts an unknown status in `NOT IN` without complaint, so a typo here
   * fails silently — the filter simply stops filtering, and the queue floods.
   * Loud beats silent.
   */
  private async checkSkipStatuses(): Promise<SetupFinding> {
    if (this.mirrorSkipStatuses.length === 0) {
      return { name: 'mirror skip list', ok: true, advisory: true, detail: 'using built-in default' };
    }
    try {
      const known = new Set((await this.api.allStatuses()).map((s) => s.toLowerCase()));
      const unknown = this.mirrorSkipStatuses.filter((s) => !known.has(s.toLowerCase()));
      if (unknown.length === 0) {
        return {
          name: 'mirror skip list',
          ok: true,
          detail: `${this.mirrorSkipStatuses.length} statuses, all recognised`,
        };
      }
      return {
        name: 'mirror skip list',
        ok: false,
        detail: `not a status on this site: ${unknown.join(', ')}`,
        remedy: 'Jira ignores unknown statuses silently, so these filter nothing. Fix the spelling in JIRA_MIRROR_SKIP_STATUSES.',
      };
    } catch (e) {
      return { name: 'mirror skip list', ok: true, advisory: true, detail: msg(e) };
    }
  }

  private async checkFields(): Promise<readonly SetupFinding[]> {
    let fields: readonly { id: string; name: string }[];
    try {
      fields = await this.api.listFields();
    } catch (e) {
      return [{ name: 'custom fields', ok: false, detail: msg(e) }];
    }

    const byName = new Map(fields.map((f) => [f.name.toLowerCase(), f.id]));

    return REQUIRED_FIELDS.map(({ env, name }) => {
      const discovered = byName.get(name.toLowerCase());
      const configured = this.configured[env];

      if (!discovered) {
        return {
          name: `field "${name}"`,
          ok: false,
          detail: 'does not exist in Jira',
          remedy: `${this.settings(this.projectType, 'issuetypes')} — add a "${name}" field to the Task issue type (team-managed projects add fields per issue type)`,
        };
      }
      if (configured !== discovered) {
        return {
          name: `field "${name}"`,
          ok: false,
          detail: configured ? `.env says ${configured}, Jira says ${discovered}` : 'not set in .env',
          remedy: `${env}=${discovered}`,
        };
      }
      return { name: `field "${name}"`, ok: true, detail: discovered };
    });
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
