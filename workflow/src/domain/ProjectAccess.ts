import type { IssueKey } from './types';

/**
 * A hard boundary on which Jira projects this system may read and write.
 *
 * Atlassian API tokens cannot be restricted to a project — scopes control
 * capability (read/write/delete), never which project — so a token minted from a
 * personal account can reach every project that account can reach. This class is
 * the compensating control: every read and every write in the Jira adapter goes
 * through it, so the system cannot address a project outside the policy even if
 * asked to.
 *
 * Policy:
 *   write  →  exactly one project
 *   read   →  that project plus an explicit allowlist, and nothing else
 *
 * The read guard WRAPS rather than validates. Validating a JQL string is a losing
 * game; wrapping it in `project IN (...) AND (...)` means no clause the caller
 * writes can widen the result set, because AND cannot be escaped from.
 */
export class ProjectAccess {
  readonly readable: readonly string[];
  private readonly writePattern: RegExp;
  private readonly readPattern: RegExp;

  constructor(
    /** The single project this system may create or modify issues in. */
    readonly writeKey: string,
    /** Extra projects it may read. The write project is always readable. */
    readOnlyKeys: readonly string[] = [],
  ) {
    assertKey(writeKey);
    readOnlyKeys.forEach(assertKey);

    this.readable = [writeKey, ...readOnlyKeys.filter((k) => k !== writeKey)];
    this.writePattern = new RegExp(`^${writeKey}-\\d+$`);
    this.readPattern = new RegExp(`^(${this.readable.join('|')})-\\d+$`);
  }

  /**
   * Projects that may be mirrored: readable but not writable. Excluding the
   * write project is what stops the mirror source consuming its own output.
   */
  get mirrorKeys(): readonly string[] {
    return this.readable.filter((k) => k !== this.writeKey);
  }

  /** Confines a read to the readable set. */
  confineRead(jql: string): string {
    const list = this.readable.map((k) => `"${k}"`).join(', ');
    return wrap(jql, `project IN (${list})`);
  }

  /** Confines a read to the write project alone — used for our own dedup. */
  confineWrite(jql: string): string {
    return wrap(jql, `project = "${this.writeKey}"`);
  }

  /** Rejects any key this system may not modify. */
  writeKeyFor(raw: string): IssueKey {
    const key = normalise(raw);
    if (!this.writePattern.test(key)) {
      throw new Error(
        `Refusing to modify "${raw}" — writes are limited to ${this.writeKey}. `
        + `Readable projects (${this.readable.join(', ')}) are read-only.`,
      );
    }
    return key as IssueKey;
  }

  writeKeysFor(raw: readonly string[]): readonly IssueKey[] {
    return raw.map((k) => this.writeKeyFor(k));
  }

  canRead(raw: string): boolean {
    return this.readPattern.test(normalise(raw));
  }

  canWrite(raw: string): boolean {
    return this.writePattern.test(normalise(raw));
  }

  /**
   * Last line of defence: proves a response never leaked outside the policy.
   * Cheap, and it catches a confine() bug rather than trusting it.
   */
  assertReadable(keys: readonly string[]): void {
    const foreign = keys.filter((k) => !this.canRead(k));
    if (foreign.length > 0) {
      throw new Error(
        `Jira returned issues outside ${this.readable.join(', ')}: ${foreign.slice(0, 5).join(', ')}`,
      );
    }
  }
}

function assertKey(key: string): void {
  if (!/^[A-Z][A-Z0-9_]+$/.test(key)) {
    throw new Error(`Invalid Jira project key: ${JSON.stringify(key)}`);
  }
}

function normalise(raw: string): string {
  return raw.trim().toUpperCase();
}

/** `a AND (b ORDER BY c)` is invalid JQL, so ORDER BY is lifted out first. */
function wrap(jql: string, clause: string): string {
  const trimmed = jql.trim();
  const at = findOrderBy(trimmed);
  const where = (at === -1 ? trimmed : trimmed.slice(0, at)).trim();
  const order = at === -1 ? '' : ` ${trimmed.slice(at).trim()}`;
  return where.length === 0 ? `${clause}${order}` : `${clause} AND (${where})${order}`;
}

/** Index of a top-level ORDER BY, ignoring any inside quotes. */
function findOrderBy(jql: string): number {
  let quote: string | null = null;
  for (let i = 0; i < jql.length; i += 1) {
    const c = jql[i];
    if (quote) {
      if (c === quote && jql[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if ((c === 'o' || c === 'O') && /^order\s+by\b/i.test(jql.slice(i))) return i;
  }
  return -1;
}
