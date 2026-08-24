/**
 * Shapes recorded from the Slack Web API. Kept as literals rather than raw
 * JSON so the compiler catches drift when the adapter's types change.
 */
export const RUPA = 'U0RUPA';
export const TEAM = 'T0TEAM';

export const reactionsList = {
  ok: true,
  items: [
    {
      type: 'message',
      channel: 'C0INCID',
      message: {
        ts: '1787479200.000100', // 2026-08-23T10:00:00Z
        text: 'The staging cert expires next week\nsomeone should rotate it',
        user: 'U0DEV',
        reactions: [
          { name: 'ticket', users: [RUPA], count: 1 },
          { name: 'eyes', users: ['U0OTHER'], count: 1 },
        ],
      },
    },
    {
      // reacted with something else — must be ignored
      type: 'message',
      channel: 'C0GEN',
      message: {
        ts: '1787482800.000200',
        text: 'lunch?',
        user: 'U0DEV',
        reactions: [{ name: 'eyes', users: [RUPA], count: 1 }],
      },
    },
    {
      // :ticket: but added by someone else — must be ignored
      type: 'message',
      channel: 'C0GEN',
      message: {
        ts: '1787486400.000300',
        text: 'please handle the vendor email',
        user: 'U0DEV',
        reactions: [{ name: 'ticket', users: ['U0OTHER'], count: 1 }],
      },
    },
    {
      // a file, not a message
      type: 'file',
      channel: 'C0GEN',
      file: { id: 'F1' },
    },
    {
      // threaded message — the adapter should pull replies in
      type: 'message',
      channel: 'C0GEN',
      message: {
        ts: '1787490000.000400',
        thread_ts: '1787489800.000000',
        text: 'can you own this one',
        user: 'U0PM',
        reactions: [{ name: 'ticket', users: [RUPA], count: 1 }],
      },
    },
  ],
  response_metadata: { next_cursor: '' },
};

export const conversationsReplies = {
  ok: true,
  messages: [
    { ts: '1787489800.000000', text: 'vendor is reporting 4xx spikes', user: 'U0PM' },
    { ts: '1787490000.000400', text: 'can you own this one', user: 'U0PM' },
  ],
};

export const authTest = { ok: true, user: 'rupa', team: 'DashCare' };

/** A fetch stand-in that serves the fixtures and records what was asked for. */
export function slackFetch(
  overrides: Record<string, unknown> = {},
): typeof globalThis.fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const method = /api\/([a-zA-Z.]+)/.exec(url)?.[1] ?? '';

    const table: Record<string, unknown> = {
      'reactions.list': reactionsList,
      'conversations.replies': conversationsReplies,
      'auth.test': authTest,
      ...overrides,
    };

    const body = table[method] ?? { ok: false, error: `no fixture for ${method}` };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}
