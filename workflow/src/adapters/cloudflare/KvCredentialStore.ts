import type { Checkable, CheckResult, CredentialStore } from '../../ports/index';

export interface KvOptions {
  readonly accountId: string;
  readonly namespaceId: string;
  readonly apiToken: string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Credentials and cursors only — never issue state (§4.1).
 * swap() is the compare-and-swap that keeps refresh-token rotation safe (§3.2).
 */
export class KvCredentialStore implements CredentialStore, Checkable {
  readonly checkName = 'cloudflare-kv';
  private readonly http: typeof globalThis.fetch;
  private readonly base: string;

  constructor(private readonly opts: KvOptions) {
    this.http = opts.fetch ?? globalThis.fetch;
    this.base = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/storage/kv/namespaces/${opts.namespaceId}`;
  }

  async get(key: string): Promise<string | null> {
    const res = await this.http(`${this.base}/values/${encodeURIComponent(key)}`, {
      headers: { authorization: `Bearer ${this.opts.apiToken}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`KV get ${key} → ${res.status} ${res.statusText}`);
    return res.text();
  }

  async set(key: string, value: string): Promise<void> {
    const form = new FormData();
    form.set('value', value);
    form.set('metadata', JSON.stringify({}));
    const res = await this.http(`${this.base}/values/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${this.opts.apiToken}` },
      body: form,
    });
    if (!res.ok) throw new Error(`KV set ${key} → ${res.status} ${res.statusText}`);
  }

  /**
   * KV has no native CAS, so this is read-verify-write. It closes the common
   * race (two runners refreshing at once) but is not a hard guarantee — the
   * workflow's `concurrency` group is the real lock. See DESIGN.md §3.2.
   */
  async swap(key: string, expected: string | null, next: string): Promise<boolean> {
    const current = await this.get(key);
    if (current !== expected) return false;
    await this.set(key, next);
    return true;
  }

  async check(): Promise<CheckResult> {
    try {
      const res = await this.http(`${this.base}/keys?limit=1`, {
        headers: { authorization: `Bearer ${this.opts.apiToken}` },
      });
      if (!res.ok) return { ok: false, detail: `${res.status} ${res.statusText}` };
      return { ok: true, detail: 'namespace reachable' };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
}
