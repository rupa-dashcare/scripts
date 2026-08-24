import { describe, expect, it } from 'vitest';
import { JiraDoctor } from '../src/adapters/jira/JiraDoctor';

const SITE = 'https://casedrive.atlassian.net';

function api(over: Partial<Parameters<typeof make>[0]> = {}) {
  return make({
    fields: [
      { id: 'customfield_10101', name: 'Source' },
      { id: 'customfield_10102', name: 'Source Key' },
      { id: 'customfield_10103', name: 'Source URL' },
    ],
    statuses: ['Staged', 'To Do', 'In Progress', 'Done', 'Rejected'],
    issueTypes: ['Task', 'Epic'],
    project: { name: "To Do's", isPrivate: true, style: 'next-gen', projectTypeKey: 'business' },
    ...over,
  });
}

function make(o: {
  fields: { id: string; name: string }[];
  statuses: string[];
  issueTypes: string[];
  project: { name: string; isPrivate: boolean; style: string; projectTypeKey: string } | Error;
}) {
  return {
    async listFields() { return o.fields; },
    async projectStatuses() { return [{ issueType: 'Task', statuses: o.statuses }]; },
    async createMeta() { return o.issueTypes; },
    async projectInfo() {
      if (o.project instanceof Error) throw o.project;
      return o.project;
    },
  };
}

const configured = {
  JIRA_FIELD_SOURCE: 'customfield_10101',
  JIRA_FIELD_SOURCE_KEY: 'customfield_10102',
  JIRA_FIELD_SOURCE_URL: 'customfield_10103',
};

function inspect(
  a: ReturnType<typeof api>,
  cfg: Readonly<Record<string, string | undefined>> = configured,
) {
  return new JiraDoctor(a, 'RUPA', cfg, SITE).inspect();
}

describe('JiraDoctor', () => {
  it('passes a correctly shaped project', async () => {
    const findings = await inspect(api());
    expect(findings.every((f) => f.ok)).toBe(true);
  });

  // The API's isPrivate does not track a team-managed project's access level:
  // RUPA reads false while the UI shows Private. Reporting that as a failure
  // would cry wolf forever, so it is advisory only.
  it('never fails on access level, whatever isPrivate says', async () => {
    for (const isPrivate of [true, false]) {
      const findings = await inspect(api({
        project: { name: "To Do's", isPrivate, style: 'next-gen', projectTypeKey: 'business' },
      }));
      const f = findings.find((x) => x.name === 'access level');
      expect(f?.advisory).toBe(true);
      expect(f?.ok).toBe(true);
      expect(findings.every((x) => x.ok)).toBe(true);
    }
  });

  it('points a business project at /jira/core for access', async () => {
    const findings = await inspect(api());
    const f = findings.find((x) => x.name === 'access level');
    expect(f?.detail).toContain('/jira/core/projects/RUPA/settings/access');
    expect(f?.detail).not.toContain('/jira/software/');
  });

  it('points a software project at /jira/software instead', async () => {
    const findings = await inspect(api({
      project: { name: 'Web App', isPrivate: false, style: 'classic', projectTypeKey: 'software' },
    }));
    const f = findings.find((x) => x.name === 'access level');
    expect(f?.detail).toContain('/jira/software/projects/RUPA/');
  });

  it('tells you how to create a missing project', async () => {
    const findings = await inspect(api({ project: new Error('404 Not Found') }));
    const f = findings.find((x) => x.name === 'project');
    expect(f?.ok).toBe(false);
    expect(f?.remedy).toContain('RUPA');
  });

  it('names exactly which statuses are missing', async () => {
    const findings = await inspect(api({ statuses: ['To Do', 'Done'] }));
    const f = findings.find((x) => x.name === 'workflow statuses');
    expect(f?.ok).toBe(false);
    expect(f?.detail).toContain('Staged');
    expect(f?.detail).toContain('Rejected');
    expect(f?.detail).not.toContain('missing: To Do');
  });

  it('flags a field that does not exist in Jira at all', async () => {
    const findings = await inspect(api({ fields: [{ id: 'customfield_10101', name: 'Source' }] }));
    const f = findings.find((x) => x.name === 'field "Source Key"');
    expect(f?.ok).toBe(false);
    expect(f?.detail).toBe('does not exist in Jira');
  });

  // The common real-world case: field exists, .env has the wrong id.
  it('prints the correct env line when the id is stale', async () => {
    const findings = await inspect(api(), { ...configured, JIRA_FIELD_SOURCE: 'customfield_99999' });
    const f = findings.find((x) => x.name === 'field "Source"');
    expect(f?.ok).toBe(false);
    expect(f?.remedy).toBe('JIRA_FIELD_SOURCE=customfield_10101');
  });

  it('prints the env line when the field is unset', async () => {
    const findings = await inspect(api(), { ...configured, JIRA_FIELD_SOURCE_URL: undefined });
    const f = findings.find((x) => x.name === 'field "Source URL"');
    expect(f?.remedy).toBe('JIRA_FIELD_SOURCE_URL=customfield_10103');
    expect(f?.detail).toBe('not set in .env');
  });

  it('matches field names case-insensitively', async () => {
    const findings = await inspect(api({
      fields: [
        { id: 'customfield_10101', name: 'source' },
        { id: 'customfield_10102', name: 'SOURCE KEY' },
        { id: 'customfield_10103', name: 'Source Url' },
      ],
    }));
    expect(findings.filter((f) => f.name.startsWith('field')).every((f) => f.ok)).toBe(true);
  });

  it('flags a missing Task issue type and lists what is available', async () => {
    const findings = await inspect(api({ issueTypes: ['Bug'] }));
    const f = findings.find((x) => x.name === 'issue type "Task"');
    expect(f?.ok).toBe(false);
    expect(f?.detail).toContain('Bug');
  });

  it('never mutates — inspect only reads', async () => {
    const calls: string[] = [];
    const spy = new Proxy(api(), {
      get(t, k: string) { calls.push(k); return (t as Record<string, unknown>)[k]; },
    });
    await inspect(spy as ReturnType<typeof api>);
    expect(calls.every((c) => /^(listFields|projectStatuses|createMeta|projectInfo)$/.test(c))).toBe(true);
  });
});
