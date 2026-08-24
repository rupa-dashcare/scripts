import type { Checkable, CheckResult, Source } from '../../ports/index';
import { sourceKey } from '../../domain/fingerprint';
import type { SourceItem, TimeWindow } from '../../domain/types';

export interface SlackOptions {
  /** A user token (xoxp-). A bot token only sees channels the bot has joined. */
  readonly token: string;
  /** Reaction that flags a message. Without the colons. */
  readonly triggerEmoji: string;
  /** Only reactions added by this user id count. */
  readonly userId: string;
  readonly teamId: string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The Phase 1 trigger (DESIGN.md §3): I react with :ticket: on a message.
 *
 * Selection is entirely mechanical — a reaction, by me, with the configured
 * emoji. No model decides whether something qualifies.
 */
export class SlackSource implements Source, Checkable {
  readonly name = 'slack' as const;
  readonly checkName = 'slack';
  private readonly http: typeof globalThis.fetch;

  constructor(private readonly opts: SlackOptions) {
    this.http = opts.fetch ?? globalThis.fetch;
  }

  async collect(window: TimeWindow): Promise<readonly SourceItem[]> {
    const reactions = await this.myReactions();
    const items: SourceItem[] = [];

    for (const entry of reactions) {
      if (!this.isTrigger(entry)) continue;

      const ts = Number.parseFloat(entry.message.ts) * 1000;
      if (Number.isNaN(ts)) continue;
      // The reaction is what matters, but Slack only exposes the message time.
      // A generous window plus Jira-side dedup makes re-reading harmless.
      if (ts < window.from.getTime() || ts > window.to.getTime()) continue;

      items.push(await this.toItem(entry));
    }
    return items;
  }

  /** reactions.list returns only items the calling user reacted to — exactly the filter we want. */
  private async myReactions(): Promise<readonly ReactionItem[]> {
    const out: ReactionItem[] = [];
    let cursor: string | undefined;

    do {
      const params = new URLSearchParams({ user: this.opts.userId, limit: '100', full: 'true' });
      if (cursor) params.set('cursor', cursor);

      const body = await this.call<ReactionsList>('reactions.list', params);
      for (const i of body.items ?? []) {
        if (i.type === 'message' && i.message && i.channel) out.push(i as ReactionItem);
      }
      cursor = body.response_metadata?.next_cursor || undefined;
    } while (cursor);

    return out;
  }

  private isTrigger(entry: ReactionItem): boolean {
    return (entry.message.reactions ?? []).some(
      (r) => r.name === this.opts.triggerEmoji && (r.users ?? []).includes(this.opts.userId),
    );
  }

  private async toItem(entry: ReactionItem): Promise<SourceItem> {
    const { channel, message } = entry;
    const thread = message.thread_ts && message.thread_ts !== message.ts
      ? await this.threadContext(channel, message.thread_ts)
      : '';

    const text = message.text ?? '';
    const body = thread ? `${text}\n\n--- thread ---\n${thread}` : text;

    return {
      sourceKey: sourceKey('slack', this.opts.teamId, channel, message.ts),
      source: 'slack',
      title: firstLine(text),
      body,
      url: this.permalink(channel, message.ts),
      occurredAt: new Date(Number.parseFloat(message.ts) * 1000),
      actors: [message.user ?? 'unknown'],
      hints: { channel },
    };
  }

  /** Best-effort: a thread we cannot read must not sink the whole item. */
  private async threadContext(channel: string, threadTs: string): Promise<string> {
    try {
      const params = new URLSearchParams({ channel, ts: threadTs, limit: '20' });
      const body = await this.call<{ messages?: SlackMessage[] }>('conversations.replies', params);
      return (body.messages ?? [])
        .map((m) => `${m.user ?? '?'}: ${m.text ?? ''}`)
        .join('\n');
    } catch {
      return '';
    }
  }

  private permalink(channel: string, ts: string): string {
    return `https://slack.com/archives/${channel}/p${ts.replace('.', '')}`;
  }

  async check(): Promise<CheckResult> {
    try {
      const body = await this.call<{ user?: string; team?: string }>('auth.test', new URLSearchParams());
      return { ok: true, detail: `${body.user ?? '?'} @ ${body.team ?? '?'} — :${this.opts.triggerEmoji}:` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  private async call<T>(method: string, params: URLSearchParams): Promise<T> {
    const res = await this.http(`https://slack.com/api/${method}?${params}`, {
      headers: { authorization: `Bearer ${this.opts.token}` },
    });
    if (!res.ok) throw new Error(`Slack ${method} → ${res.status} ${res.statusText}`);

    const body = (await res.json()) as { ok: boolean; error?: string } & T;
    // Slack returns HTTP 200 with ok:false — a non-error that is an error.
    if (!body.ok) throw new Error(`Slack ${method} → ${body.error ?? 'unknown error'}`);
    return body;
  }
}

interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  thread_ts?: string;
  reactions?: { name: string; users?: string[] }[];
}

interface ReactionItem {
  type: string;
  channel: string;
  message: SlackMessage;
}

interface ReactionsList {
  items?: { type: string; channel?: string; message?: SlackMessage }[];
  response_metadata?: { next_cursor?: string };
}

function firstLine(text: string): string {
  const line = (text.split('\n').find((l) => l.trim().length > 0) ?? '').trim();
  return line.length > 0 ? line : 'Slack message';
}
