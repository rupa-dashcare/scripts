import { describe, expect, it } from 'vitest';
import { Redactor, REDACTED } from '../src/domain/redact';
import { StructuredLogger } from '../src/adapters/logging/StructuredLogger';

/**
 * Synthetic credentials, assembled at runtime rather than written as literals.
 * A real-looking token in a test file trips GitHub push protection — and more to
 * the point, credential-shaped strings do not belong in a repo at all. These
 * still match the production patterns, which is all the tests need.
 */
const ATLASSIAN = ['ATATT3x', 'F'.repeat(48), '=', 'AAAAAAAA'].join('');
const SLACK = ['xoxp', '0'.repeat(10), '0'.repeat(10), 'a'.repeat(16)].join('-');
const SLACK_BOT = ['xoxb', '1'.repeat(12), 'b'.repeat(20)].join('-');
const GRANOLA = ['grn', '_', 'c'.repeat(22)].join('');
const GOOGLE_ACCESS = ['ya29.', 'd'.repeat(36)].join('');
const GOOGLE_REFRESH = ['1//0', 'e'.repeat(35)].join('');
const JWT = ['eyJ' + 'a'.repeat(12), 'b'.repeat(16), 'c'.repeat(20)].join('.');

describe('Redactor — by registered value', () => {
  it('removes a registered secret anywhere it appears', () => {
    const r = new Redactor([ATLASSIAN]);
    expect(r.text(`auth failed for ${ATLASSIAN} on retry`)).not.toContain(ATLASSIAN);
    expect(r.text(`auth failed for ${ATLASSIAN} on retry`)).toContain(REDACTED);
  });

  it('removes it from a URL, a JSON blob and a stack trace alike', () => {
    const r = new Redactor([ATLASSIAN]);
    for (const shape of [
      `https://x.example/?token=${ATLASSIAN}`,
      JSON.stringify({ nested: { deep: ATLASSIAN } }),
      `Error: boom\n    at f (${ATLASSIAN})`,
    ]) {
      expect(r.text(shape)).not.toContain(ATLASSIAN);
    }
  });

  it('catches the base64 form, so a logged Basic header cannot leak it', () => {
    const r = new Redactor([ATLASSIAN]);
    const encoded = Buffer.from(ATLASSIAN, 'utf8').toString('base64');
    expect(r.text(`authorization: Basic ${encoded}`)).not.toContain(encoded);
  });

  it('ignores values too short to redact safely', () => {
    // Redacting "RUPA" would mangle every log line in the system.
    const r = new Redactor(['RUPA', '', undefined]);
    expect(r.text('project RUPA is fine')).toBe('project RUPA is fine');
  });

  it('does not partially replace when one secret contains another', () => {
    const r = new Redactor(['abcdefghij', 'abcdefghijklmnop']);
    expect(r.text('abcdefghijklmnop')).toBe(REDACTED);
  });
});

describe('Redactor — by shape, for secrets never registered', () => {
  it.each([
    ['atlassian', ATLASSIAN],
    ['slack user token', SLACK],
    ['slack bot token', SLACK_BOT],
    ['granola key', GRANOLA],
    ['google access', GOOGLE_ACCESS],
    ['google refresh', GOOGLE_REFRESH],
    ['jwt', JWT],
  ])('redacts an unregistered %s', (_label, secret) => {
    const r = new Redactor();
    expect(r.text(`value: ${secret}`)).not.toContain(secret);
  });

  it('redacts Authorization headers of either scheme', () => {
    const r = new Redactor();
    expect(r.text(`authorization: Bearer ${'f'.repeat(20)}`)).toContain(REDACTED);
    expect(r.text(`authorization: Basic ${'Zg'.repeat(12)}`)).toContain(REDACTED);
  });

  it('leaves ordinary text alone', () => {
    const r = new Redactor();
    const line = 'created RUPA-12 priority=High due=2026-08-28 ms=142';
    expect(r.text(line)).toBe(line);
  });
});

describe('Redactor — structures', () => {
  it('redacts by key name whatever the value looks like', () => {
    const r = new Redactor();
    const out = r.value({ apiToken: 'plain', authorization: 'x', password: 'y' }) as Record<string, unknown>;
    expect(out).toEqual({ apiToken: REDACTED, authorization: REDACTED, password: REDACTED });
  });

  it('recurses through nested objects and arrays', () => {
    const r = new Redactor([ATLASSIAN]);
    const out = r.value({ a: [{ b: { c: ATLASSIAN } }] });
    expect(JSON.stringify(out)).not.toContain(ATLASSIAN);
  });

  it('preserves an Error as a readable object, redacted', () => {
    const r = new Redactor([ATLASSIAN]);
    const out = r.value(new Error(`bad token ${ATLASSIAN}`)) as { message: string; stack?: string };
    expect(out.message).toContain(REDACTED);
    expect(out.message).not.toContain(ATLASSIAN);
    expect(out.stack).toBeTruthy();
  });

  // A logger that hangs on a cycle is the worst possible failure for a tool
  // whose job is diagnosing failures.
  it('survives a circular structure', () => {
    const r = new Redactor();
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => r.value(a)).not.toThrow();
    expect(JSON.stringify(r.value(a))).toContain('[circular]');
  });

  it('leaves non-strings untouched', () => {
    const r = new Redactor();
    expect(r.value({ n: 42, b: true, z: null })).toEqual({ n: 42, b: true, z: null });
  });

  it('is idempotent', () => {
    const r = new Redactor([ATLASSIAN]);
    const once = r.text(`x ${ATLASSIAN}`);
    expect(r.text(once)).toBe(once);
  });
});

describe('StructuredLogger', () => {
  function logger(level: 'debug' | 'info' = 'debug', secrets: string[] = []) {
    const lines: string[] = [];
    const log = new StructuredLogger({
      redactor: new Redactor(secrets),
      level,
      format: 'json',
      runId: 'run1',
      write: (l) => lines.push(l),
      now: () => new Date('2026-08-24T12:00:00Z'),
    });
    return { log, lines, parsed: () => lines.map((l) => JSON.parse(l)) };
  }

  it('emits structured JSON with level, run id and message', () => {
    const { log, parsed } = logger();
    log.info('ingest started', { sources: 'slack' });
    expect(parsed()[0]).toMatchObject({
      level: 'info', run: 'run1', msg: 'ingest started', sources: 'slack',
    });
  });

  // The property that matters most: no caller can bypass redaction.
  it('redacts secrets passed straight into a log call', () => {
    const { log, lines } = logger('debug', [ATLASSIAN]);
    log.error('auth failed', { token: ATLASSIAN, url: `https://x?t=${ATLASSIAN}` });
    expect(lines[0]).not.toContain(ATLASSIAN);
  });

  it('redacts an unregistered secret by shape', () => {
    const { log, lines } = logger();
    log.info('slack call', { detail: `used ${SLACK}` });
    expect(lines[0]).not.toContain(SLACK);
  });

  it('honours the level threshold', () => {
    const { log, lines } = logger('info');
    log.debug('noisy');
    expect(lines).toHaveLength(0);
    log.warn('audible');
    expect(lines).toHaveLength(1);
  });

  it('stamps child context onto every line', () => {
    const { log, parsed } = logger();
    log.child({ component: 'jira' }).info('request');
    expect(parsed()[0]).toMatchObject({ component: 'jira', msg: 'request' });
  });

  it('times a success at debug and returns the value', async () => {
    const { log, parsed } = logger();
    await expect(log.time('collect', async () => 7)).resolves.toBe(7);
    expect(parsed()[0]).toMatchObject({ level: 'debug', outcome: 'ok' });
  });

  it('logs a failure at error, redacted, and rethrows', async () => {
    const { log, lines, parsed } = logger('debug', [ATLASSIAN]);
    await expect(
      log.time('collect', async () => { throw new Error(`bad ${ATLASSIAN}`); }),
    ).rejects.toThrow();

    expect(parsed()[0]).toMatchObject({ level: 'error', outcome: 'failed' });
    expect(lines[0]).not.toContain(ATLASSIAN);
  });

  it('writes human-readable text when asked', () => {
    const lines: string[] = [];
    new StructuredLogger({
      redactor: new Redactor(), format: 'text', level: 'info',
      write: (l) => lines.push(l), now: () => new Date('2026-08-24T12:00:00Z'),
    }).info('created', { issue: 'RUPA-1' });
    expect(lines[0]).toContain('created');
    expect(lines[0]).toContain('issue=RUPA-1');
  });
});

describe('the Jira adapter cannot leak its credentials into logs', () => {
  it('logs a failed request without the token or the Authorization header', async () => {
    const { JiraTicketStore } = await import('../src/adapters/jira/JiraTicketStore');
    const { ProjectAccess } = await import('../src/domain/ProjectAccess');

    const lines: string[] = [];
    const log = new StructuredLogger({
      redactor: new Redactor([ATLASSIAN]),
      level: 'debug', format: 'json',
      write: (l) => lines.push(l),
    });

    let sentAuth = '';
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sentAuth = String((init?.headers as Record<string, string>)?.authorization ?? '');
      return new Response('{"code":401,"message":"Unauthorized; scope does not match"}', {
        status: 401, statusText: 'Unauthorized',
      });
    }) as typeof globalThis.fetch;

    const store = new JiraTicketStore({
      apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud-1',
      email: 'rupa.patel@dashcaregroup.com',
      apiToken: ATLASSIAN,
      access: new ProjectAccess('RUPA'),
      fetch,
      log,
    });

    await expect(store.search('status = Staged')).rejects.toThrow(/401/);

    // The header really was sent — so this is a redaction test, not a no-op.
    expect(sentAuth).toContain('Basic ');
    expect(lines.length).toBeGreaterThan(0);

    const all = lines.join('\n');
    expect(all).not.toContain(ATLASSIAN);
    expect(all).not.toContain(sentAuth.replace('Basic ', ''));
    // But the diagnosis survives.
    expect(all).toContain('401');
    expect(all).toContain('scope does not match');
  });

  it('keeps user content out of the logged path', async () => {
    const { JiraTicketStore } = await import('../src/adapters/jira/JiraTicketStore');
    const { ProjectAccess } = await import('../src/domain/ProjectAccess');

    const lines: string[] = [];
    const log = new StructuredLogger({
      redactor: new Redactor(), level: 'debug', format: 'json',
      write: (l) => lines.push(l),
    });
    const fetch = (async () => new Response(JSON.stringify({ id: 'x', name: 'y' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as typeof globalThis.fetch;

    const store = new JiraTicketStore({
      apiBaseUrl: 'https://x', email: 'e@x.com', apiToken: 'tok-abcdefghij',
      access: new ProjectAccess('RUPA'), fetch, log,
    });
    await store.createMeta();

    expect(lines.join('\n')).toContain('/rest/api/3/issue/createmeta?…');
    expect(lines.join('\n')).not.toContain('projectKeys=RUPA');
  });
});
