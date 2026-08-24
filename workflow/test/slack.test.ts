import { describe, expect, it } from 'vitest';
import { SlackSource } from '../src/adapters/slack/SlackSource';
import { RUPA, TEAM, slackFetch } from './fixtures/slack';

const WINDOW = {
  from: new Date('2026-08-23T00:00:00Z'),
  to: new Date('2026-08-24T00:00:00Z'),
};

function source(fetch = slackFetch()) {
  return new SlackSource({
    token: 'xoxp-test',
    triggerEmoji: 'ticket',
    userId: RUPA,
    teamId: TEAM,
    fetch,
  });
}

describe('SlackSource', () => {
  it('collects only messages I reacted to with the trigger emoji', async () => {
    const items = await source().collect(WINDOW);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.title)).toEqual([
      'The staging cert expires next week',
      'can you own this one',
    ]);
  });

  it('ignores a different emoji', async () => {
    const items = await source().collect(WINDOW);
    expect(items.some((i) => i.body.includes('lunch?'))).toBe(false);
  });

  it('ignores the trigger emoji when somebody else added it', async () => {
    const items = await source().collect(WINDOW);
    expect(items.some((i) => i.body.includes('vendor email'))).toBe(false);
  });

  it('ignores reactions on files', async () => {
    const items = await source().collect(WINDOW);
    expect(items.every((i) => i.sourceKey.startsWith('slack:'))).toBe(true);
  });

  it('builds a stable sourceKey from team, channel and ts', async () => {
    const [first] = await source().collect(WINDOW);
    expect(first?.sourceKey).toBe(`slack:${TEAM}/C0INCID/1787479200.000100`);
  });

  it('is stable across runs — the key never depends on content', async () => {
    const a = await source().collect(WINDOW);
    const b = await source().collect(WINDOW);
    expect(a.map((i) => i.sourceKey)).toEqual(b.map((i) => i.sourceKey));
  });

  it('carries the channel through as a triage hint', async () => {
    const [first] = await source().collect(WINDOW);
    expect(first?.hints.channel).toBe('C0INCID');
  });

  it('builds a working permalink', async () => {
    const [first] = await source().collect(WINDOW);
    expect(first?.url).toBe('https://slack.com/archives/C0INCID/p1787479200000100');
  });

  it('pulls thread replies in as context', async () => {
    const items = await source().collect(WINDOW);
    const threaded = items.find((i) => i.title === 'can you own this one');
    expect(threaded?.body).toContain('--- thread ---');
    expect(threaded?.body).toContain('4xx spikes');
  });

  it('does not fetch a thread for an unthreaded message', async () => {
    const fetch = slackFetch();
    await source(fetch).collect(WINDOW);
    const replyCalls = fetch.calls.filter((c) => c.includes('conversations.replies'));
    expect(replyCalls).toHaveLength(1);
  });

  it('survives an unreadable thread rather than dropping the item', async () => {
    const fetch = slackFetch({ 'conversations.replies': { ok: false, error: 'channel_not_found' } });
    const items = await source(fetch).collect(WINDOW);
    expect(items).toHaveLength(2);
    expect(items[1]?.body).not.toContain('--- thread ---');
  });

  it('excludes messages outside the window', async () => {
    const items = await source().collect({
      from: new Date('2026-08-23T10:30:00Z'),
      to: new Date('2026-08-24T00:00:00Z'),
    });
    expect(items.map((i) => i.title)).toEqual(['can you own this one']);
  });

  // Slack answers HTTP 200 with ok:false — a non-error that is an error.
  it('treats ok:false as a failure', async () => {
    const fetch = slackFetch({ 'reactions.list': { ok: false, error: 'invalid_auth' } });
    await expect(source(fetch).collect(WINDOW)).rejects.toThrow(/invalid_auth/);
  });

  it('falls back to a placeholder title for an empty message', async () => {
    const fetch = slackFetch({
      'reactions.list': {
        ok: true,
        items: [{
          type: 'message',
          channel: 'C0GEN',
          message: { ts: '1787479200.000900', text: '', user: 'U0DEV',
            reactions: [{ name: 'ticket', users: [RUPA] }] },
        }],
      },
    });
    const [only] = await source(fetch).collect(WINDOW);
    expect(only?.title).toBe('Slack message');
  });

  it('follows pagination cursors', async () => {
    let page = 0;
    const paging = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('reactions.list')) {
        page += 1;
        return new Response(JSON.stringify(page === 1
          ? {
              ok: true,
              items: [{ type: 'message', channel: 'C1', message: { ts: '1787479200.000001',
                text: 'one', user: 'U', reactions: [{ name: 'ticket', users: [RUPA] }] } }],
              response_metadata: { next_cursor: 'abc' },
            }
          : {
              ok: true,
              items: [{ type: 'message', channel: 'C1', message: { ts: '1787479200.000002',
                text: 'two', user: 'U', reactions: [{ name: 'ticket', users: [RUPA] }] } }],
              response_metadata: { next_cursor: '' },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
    }) as typeof globalThis.fetch;

    const items = await source(paging as ReturnType<typeof slackFetch>).collect(WINDOW);
    expect(items.map((i) => i.title)).toEqual(['one', 'two']);
    expect(page).toBe(2);
  });

  it('reports health status via check()', async () => {
    const r = await source().check();
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('ticket');
  });
});
