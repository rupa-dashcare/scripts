/**
 * Scrubs credentials out of anything bound for a log.
 *
 * Two layers, because either alone is insufficient:
 *
 *  1. **Known values.** The real secrets are registered at startup, so they are
 *     removed wherever they appear — inside a URL, a JSON blob, a stack trace,
 *     a base64 header. This catches secrets whose shape we never anticipated.
 *  2. **Known shapes.** Patterns for the credential formats we expect, so a
 *     token that was never registered — one read from a response, or a new
 *     source's key — still does not survive.
 *
 * Plus key-name matching for objects, so `{ apiToken: "..." }` is redacted even
 * if the value matches no pattern and was never registered.
 */

const MASK = '[redacted]';

/** Shapes of credentials this system handles, or plausibly will. */
const PATTERNS: readonly RegExp[] = [
  /ATATT3x[A-Za-z0-9_\-=+/]{20,}/g,            // Atlassian API token
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g,          // Slack tokens
  /\bgrn_[A-Za-z0-9_\-]{10,}/g,                 // Granola API key
  /\bya29\.[A-Za-z0-9_\-]{20,}/g,               // Google access token
  /\b1\/\/[A-Za-z0-9_\-]{20,}/g,                // Google refresh token
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\b(Bearer|Basic)\s+[A-Za-z0-9._\-=+/]{8,}/gi, // Authorization headers
  /\b[A-Za-z0-9_\-]*(?:secret|token|key)=[^\s&"']{8,}/gi, // token=... in query strings
];

/** Object keys whose value is always a credential, whatever it looks like. */
const SECRET_KEY = /(token|secret|password|passwd|authorization|auth|credential|apikey|api_key|cookie|private)/i;

/** Below this length, redacting a registered value would mangle ordinary text. */
const MIN_SECRET_LENGTH = 8;

export class Redactor {
  private readonly values: string[] = [];

  constructor(secrets: readonly (string | undefined)[] = []) {
    secrets.forEach((s) => this.add(s));
  }

  /** Registers a real secret value. Short or empty values are ignored. */
  add(secret: string | undefined): void {
    if (!secret || secret.length < MIN_SECRET_LENGTH) return;
    if (this.values.includes(secret)) return;
    this.values.push(secret);

    // A Basic header is base64(email:token); redact that encoded form too,
    // so a logged header is caught even without the Basic pattern matching.
    try {
      this.values.push(Buffer.from(secret, 'utf8').toString('base64'));
    } catch {
      /* non-encodable values are simply not registered in that form */
    }
  }

  text(input: string): string {
    let out = input;
    // Longest first, so a secret containing another is not partially replaced.
    for (const v of [...this.values].sort((a, b) => b.length - a.length)) {
      out = out.split(v).join(MASK);
    }
    for (const p of PATTERNS) out = out.replace(p, MASK);
    return out;
  }

  /** Deep-redacts a structure, by value, by pattern and by key name. */
  value<T>(input: T, seen = new WeakSet<object>()): unknown {
    if (typeof input === 'string') return this.text(input);
    if (input === null || typeof input !== 'object') return input;

    // Cycles would otherwise hang the logger — the worst possible failure mode
    // for something whose job is diagnosing failures.
    if (seen.has(input as object)) return '[circular]';
    seen.add(input as object);

    if (Array.isArray(input)) return input.map((v) => this.value(v, seen));

    if (input instanceof Error) {
      return {
        name: input.name,
        message: this.text(input.message),
        stack: input.stack ? this.text(input.stack) : undefined,
      };
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && v !== undefined && v !== null
        ? MASK
        : this.value(v, seen);
    }
    return out;
  }
}

export const REDACTED = MASK;
