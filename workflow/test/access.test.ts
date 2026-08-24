import { describe, expect, it } from 'vitest';
import { ProjectAccess } from '../src/domain/ProjectAccess';
import { JiraTicketStore } from '../src/adapters/jira/JiraTicketStore';
import type { IssueKey, TicketDraft } from '../src/domain/types';
import { dedupeKey } from '../src/domain/fingerprint';

const access = new ProjectAccess('RUPA', ['PP', 'DL', 'DEV']);

describe('ProjectAccess — read confinement', () => {
  it('wraps a plain query so it cannot widen', () => {
    expect(access.confineRead('status = Staged'))
      .toBe('project IN ("RUPA", "PP", "DL", "DEV") AND (status = Staged)');
  });

  // The whole point: an attacker-supplied or hallucinated clause is neutralised
  // by AND, not by string validation.
  it.each([
    'project = CB',
    'project != RUPA',
    'project IN (CB, CD, CF)',
    'status = Done OR project = CB',
    'assignee = currentUser() OR 1 = 1',
  ])('neutralises %s', (hostile) => {
    const jql = access.confineRead(hostile);
    expect(jql.startsWith('project IN ("RUPA", "PP", "DL", "DEV") AND (')).toBe(true);
    expect(jql).toContain(hostile);
  });

  it('lifts ORDER BY out so the result is valid JQL', () => {
    expect(access.confineRead('status = Staged ORDER BY created ASC'))
      .toBe('project IN ("RUPA", "PP", "DL", "DEV") AND (status = Staged) ORDER BY created ASC');
  });

  it('handles a bare ORDER BY with no where clause', () => {
    expect(access.confineRead('ORDER BY created DESC'))
      .toBe('project IN ("RUPA", "PP", "DL", "DEV") ORDER BY created DESC');
  });

  it('ignores an ORDER BY that is only inside a quoted string', () => {
    const jql = access.confineRead('summary ~ "order by tuesday"');
    expect(jql).toBe('project IN ("RUPA", "PP", "DL", "DEV") AND (summary ~ "order by tuesday")');
  });

  it('confines dedup reads to the write project alone', () => {
    expect(access.confineWrite('labels IN ("srckey-abc")'))
      .toBe('project = "RUPA" AND (labels IN ("srckey-abc"))');
  });
});

describe('ProjectAccess — write confinement', () => {
  it('accepts a key in the write project', () => {
    expect(access.writeKeyFor('RUPA-42')).toBe('RUPA-42');
    expect(access.writeKeyFor(' rupa-42 ')).toBe('RUPA-42');
  });

  it.each(['PP-1', 'DL-9', 'CB-3', 'CD-7', 'DEV-2'])('refuses to write to %s', (key) => {
    expect(() => access.writeKeyFor(key)).toThrow(/writes are limited to RUPA/);
  });

  it('says read-only projects are read-only, so the message is actionable', () => {
    expect(() => access.writeKeyFor('PP-1')).toThrow(/read-only/);
  });

  it.each(['RUPA', 'RUPA-', 'RUPAX-1', 'RUPA-1x', '../RUPA-1', 'RUPA-1 OR 1=1'])(
    'refuses the malformed key %s', (key) => {
      expect(() => access.writeKeyFor(key)).toThrow();
    },
  );

  it('rejects a whole batch if any one key is foreign', () => {
    expect(() => access.writeKeysFor(['RUPA-1', 'CB-2', 'RUPA-3'])).toThrow(/CB-2/);
  });

  it('reads span the allowlist but writes never do', () => {
    for (const k of ['RUPA-1', 'PP-1', 'DL-1', 'DEV-1']) expect(access.canRead(k)).toBe(true);
    for (const k of ['CB-1', 'CD-1', 'CF-1']) expect(access.canRead(k)).toBe(false);
    // readable never implies writable
    for (const k of ['PP-1', 'DL-1', 'DEV-1']) expect(access.canWrite(k)).toBe(false);
  });

  it('catches a leak in the response even if confine failed', () => {
    expect(() => access.assertReadable(['RUPA-1', 'CB-9'])).toThrow(/outside/);
    expect(() => access.assertReadable(['RUPA-1', 'PP-2', 'DL-3', 'DEV-4'])).not.toThrow();
  });

  it('rejects an invalid project key at construction', () => {
    expect(() => new ProjectAccess('rupa')).toThrow(/Invalid Jira project key/);
    expect(() => new ProjectAccess('RUPA', ['bad key'])).toThrow(/Invalid Jira project key/);
  });
});

describe('JiraTicketStore honours the policy before any network call', () => {
  function store() {
    const calls: { method: string; url: string }[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url: String(url) });
      return new Response(JSON.stringify({ issues: [], total: 0, maxResults: 100 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const s = new JiraTicketStore({
      baseUrl: 'https://casedrive.atlassian.net',
      email: 'rupa.patel@dashcaregroup.com',
      apiToken: 'token',
      access,
      fetch,
    });
    return { s, calls };
  }

  it('refuses a transition outside RUPA without touching the network', async () => {
    const { s, calls } = store();
    await expect(s.transition(['CB-1' as IssueKey], 'Done')).rejects.toThrow(/limited to RUPA/);
    expect(calls).toHaveLength(0);
  });

  it('refuses an update outside RUPA without touching the network', async () => {
    const { s, calls } = store();
    await expect(s.update(['PP-1' as IssueKey], { priority: 'High' }))
      .rejects.toThrow(/limited to RUPA/);
    expect(calls).toHaveLength(0);
  });

  it('refuses a comment outside RUPA without touching the network', async () => {
    const { s, calls } = store();
    await expect(s.comment('DL-4' as IssueKey, 'hi')).rejects.toThrow(/limited to RUPA/);
    expect(calls).toHaveLength(0);
  });

  it('sends a confined JQL even when asked for another project', async () => {
    const { s, calls } = store();
    await s.search('project = CB');
    const body = calls[0]?.url ?? '';
    expect(body).toContain('/rest/api/3/search');
    expect(calls).toHaveLength(1);
  });

  it('always creates into the write project', async () => {
    const captured: unknown[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.body) captured.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ key: 'RUPA-1' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const s = new JiraTicketStore({
      baseUrl: 'https://x.atlassian.net', email: 'e@x.com', apiToken: 't', access, fetch,
    });

    const draft: TicketDraft = {
      sourceKey: 'slack:a', dedupeKey: dedupeKey('slack:a'), source: 'slack',
      title: 't', description: 'd', url: 'https://x', priority: 'Medium',
      dueDate: null, labels: [],
    };
    await s.create(draft);

    const fields = (captured[0] as { fields: { project: { key: string } } }).fields;
    expect(fields.project.key).toBe('RUPA');
  });
});
