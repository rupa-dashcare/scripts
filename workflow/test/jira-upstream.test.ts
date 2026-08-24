import { describe, expect, it } from 'vitest';
import { JiraUpstreamSource } from '../src/adapters/jira/JiraUpstreamSource';
import { ProjectAccess } from '../src/domain/ProjectAccess';
import { TriageRules } from '../src/core/TriageRules';
import { defaultRules } from '../src/core/rules/index';
import { FakeClock } from './fakes/index';
import type { Issue, IssueKey } from '../src/domain/types';

const access = new ProjectAccess('RUPA', ['PP', 'DL', 'DEV']);
const SITE = 'https://casedrive.atlassian.net';
const WINDOW = {
  from: new Date('2026-08-22T09:30:00Z'),
  to: new Date('2026-08-24T00:00:00Z'),
};

function issue(over: Partial<Issue> = {}): Issue {
  return {
    key: 'PP-101' as IssueKey,
    summary: 'Ship the intake redesign',
    status: 'In Progress',
    priority: 'High',
    dueDate: '2026-08-28',
    labels: [],
    updated: new Date('2026-08-23T12:00:00Z'),
    ...over,
  };
}

function source(issues: readonly Issue[]) {
  const queries: string[] = [];
  const tickets = {
    async search(jql: string) { queries.push(jql); return issues; },
  };
  return {
    src: new JiraUpstreamSource({ tickets, access, siteUrl: SITE }),
    queries,
  };
}

describe('JiraUpstreamSource', () => {
  it('mirrors an assigned upstream issue', async () => {
    const { src } = source([issue()]);
    const [item] = await src.collect(WINDOW);

    expect(item?.source).toBe('jira');
    expect(item?.title).toBe('Ship the intake redesign');
    expect(item?.url).toBe(`${SITE}/browse/PP-101`);
    expect(item?.sourceKey).toBe('jira:PP-101');
  });

  it('queries only the read-only projects, never RUPA', async () => {
    const { src, queries } = source([]);
    await src.collect(WINDOW);

    expect(queries[0]).toContain('project IN ("PP", "DL", "DEV")');
    expect(queries[0]).not.toContain('"RUPA"');
  });

  it('restricts to issues assigned to me', async () => {
    const { src, queries } = source([]);
    await src.collect(WINDOW);
    expect(queries[0]).toContain('assignee = currentUser()');
  });

  it('skips finished work', async () => {
    const { src, queries } = source([]);
    await src.collect(WINDOW);
    expect(queries[0]).toContain('status NOT IN ("Done", "Closed", "Resolved"');
  });

  it('formats the window as JQL expects', async () => {
    const { src, queries } = source([]);
    await src.collect(WINDOW);
    expect(queries[0]).toContain('updated >= "2026/08/22 09:30"');
  });

  // Without this the queue would consume its own output forever.
  it('never mirrors an issue from the write project', async () => {
    const { src } = source([issue({ key: 'RUPA-5' as IssueKey }), issue()]);
    const items = await src.collect(WINDOW);
    expect(items).toHaveLength(1);
    expect(items[0]?.sourceKey).toBe('jira:PP-101');
  });

  it('is a pointer, not a copy — the body links back and says so', async () => {
    const { src } = source([issue()]);
    const [item] = await src.collect(WINDOW);
    expect(item?.body).toContain('the upstream issue stays the source of truth');
    expect(item?.body).toContain(`${SITE}/browse/PP-101`);
  });

  it('carries upstream triage through as hints', async () => {
    const { src } = source([issue()]);
    const [item] = await src.collect(WINDOW);
    expect(item?.hints).toMatchObject({
      upstreamKey: 'PP-101', upstreamPriority: 'High', upstreamDueDate: '2026-08-28',
    });
  });

  it('has a stable sourceKey across runs', async () => {
    const { src } = source([issue()]);
    const a = await src.collect(WINDOW);
    const b = await src.collect(WINDOW);
    expect(a[0]?.sourceKey).toBe(b[0]?.sourceKey);
  });

  it('collects nothing when no read-only projects are configured', async () => {
    const soloAccess = new ProjectAccess('RUPA');
    const tickets = { async search() { throw new Error('should not be called'); } };
    const src = new JiraUpstreamSource({ tickets, access: soloAccess, siteUrl: SITE });
    expect(await src.collect(WINDOW)).toEqual([]);
  });

  it('mirrors across every allowed project', async () => {
    const { src } = source([
      issue({ key: 'PP-1' as IssueKey }),
      issue({ key: 'DL-2' as IssueKey }),
      issue({ key: 'DEV-3' as IssueKey }),
    ]);
    const items = await src.collect(WINDOW);
    expect(items.map((i) => i.sourceKey)).toEqual(['jira:PP-1', 'jira:DL-2', 'jira:DEV-3']);
  });
});

describe('mirrored issues inherit upstream triage', () => {
  const rules = new TriageRules(defaultRules());
  const clock = new FakeClock('2026-08-24T09:00:00Z');

  it('takes the upstream priority and due date rather than inventing them', async () => {
    const { src } = source([issue({ priority: 'Highest', dueDate: '2026-09-15' })]);
    const [item] = await src.collect(WINDOW);
    const t = rules.evaluate(item!, clock);

    expect(t.priority).toBe('Highest');
    expect(t.dueDate).toBe('2026-09-15');
    expect(t.reasons).toContain('inherit-upstream');
  });

  it('falls back to the source default when upstream has no due date', async () => {
    const { src } = source([issue({ priority: 'Low', dueDate: null })]);
    const [item] = await src.collect(WINDOW);
    const t = rules.evaluate(item!, clock);

    expect(t.priority).toBe('Low');
    expect(t.dueDate).toBe('2026-08-31'); // jira default, +7 days
    expect(t.reasons).toEqual(['inherit-upstream', 'source-default']);
  });

  it('does not let a keyword override an inherited priority', async () => {
    const { src } = source([issue({ summary: 'urgent blocker in prod', priority: 'Low' })]);
    const [item] = await src.collect(WINDOW);
    expect(rules.evaluate(item!, clock).priority).toBe('Low');
  });
});
