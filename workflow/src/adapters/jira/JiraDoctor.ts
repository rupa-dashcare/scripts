import type { SetupFinding, SetupInspector } from '../../ports/index';

interface JiraApi {
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
 * Verifies the Jira project is shaped the way DESIGN.md §6 requires.
 * Everything here is read-only — doctor never mutates the project.
 */
export class JiraDoctor implements SetupInspector {
  constructor(
    private readonly api: JiraApi,
    private readonly projectKey: string,
    private readonly configured: Readonly<Record<string, string | undefined>>,
    private readonly siteUrl: string,
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

    findings.push(await this.checkProject());
    findings.push(await this.checkIssueType());
    findings.push(await this.checkStatuses());
    findings.push(...(await this.checkFields()));

    return findings;
  }

  private async checkProject(): Promise<SetupFinding> {
    try {
      const p = await this.api.projectInfo();
      this.projectType = p.projectTypeKey;
      if (!p.isPrivate) {
        return {
          name: 'project is private',
          ok: false,
          detail: `"${p.name}" is visible to the whole site`,
          remedy: `${this.settings(p.projectTypeKey, 'access')} — set access to Private`,
        };
      }
      return {
        name: 'project is private',
        ok: true,
        detail: `"${p.name}" (${p.style}, ${p.projectTypeKey})`,
      };
    } catch (e) {
      return {
        name: 'project exists',
        ok: false,
        detail: msg(e),
        remedy: `Create a private team-managed project with key ${this.projectKey} at ${this.siteUrl}/jira/projects?create=true`,
      };
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
