import type { Logger, LogLevel } from '../../ports/index';
import type { Redactor } from '../../domain/redact';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly redactor: Redactor;
  /** JSON lines for machines (CI), aligned text for humans (a terminal). */
  readonly format?: 'json' | 'text';
  readonly runId?: string;
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
}

/**
 * Every line goes through the Redactor on the way out — there is no path from
 * a caller to the output that skips it. That is deliberate: a logger you have
 * to remember to sanitise is one that will eventually leak a token.
 */
export class StructuredLogger implements Logger {
  private readonly threshold: number;
  private readonly context: Record<string, unknown>;

  constructor(
    private readonly opts: LoggerOptions,
    context: Record<string, unknown> = {},
  ) {
    this.threshold = ORDER[opts.level ?? 'info'];
    this.context = context;
  }

  debug(msg: string, meta?: Record<string, unknown>): void { this.emit('debug', msg, meta); }
  info(msg: string, meta?: Record<string, unknown>): void { this.emit('info', msg, meta); }
  warn(msg: string, meta?: Record<string, unknown>): void { this.emit('warn', msg, meta); }
  error(msg: string, meta?: Record<string, unknown>): void { this.emit('error', msg, meta); }

  child(context: Record<string, unknown>): Logger {
    return new StructuredLogger(this.opts, { ...this.context, ...context });
  }

  async time<T>(msg: string, fn: () => Promise<T>, meta?: Record<string, unknown>): Promise<T> {
    const started = this.clock();
    try {
      const result = await fn();
      this.debug(msg, { ...meta, ms: this.clock() - started, outcome: 'ok' });
      return result;
    } catch (e) {
      // The failure path is the reason this system logs at all, so it is the
      // one that must never lose information.
      this.error(msg, { ...meta, ms: this.clock() - started, outcome: 'failed', error: e });
      throw e;
    }
  }

  private clock(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
  }

  private emit(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (ORDER[level] < this.threshold) return;

    const record = {
      ts: (this.opts.now?.() ?? new Date()).toISOString(),
      level,
      ...(this.opts.runId ? { run: this.opts.runId } : {}),
      ...this.context,
      msg,
      ...(meta ?? {}),
    };

    const safe = this.opts.redactor.value(record) as Record<string, unknown>;
    const write = this.opts.write ?? ((l: string) => process.stderr.write(`${l}\n`));
    write(this.opts.format === 'json' ? JSON.stringify(safe) : format(safe));
  }
}

const GLYPH: Record<string, string> = { debug: '·', info: '·', warn: '!', error: '✗' };

function format(r: Record<string, unknown>): string {
  const { ts, level, msg, ...rest } = r;
  const time = typeof ts === 'string' ? ts.slice(11, 23) : '';
  const pairs = Object.entries(rest)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${scalar(v)}`)
    .join(' ');
  return `  ${time} ${GLYPH[String(level)] ?? '·'} ${String(msg)}${pairs ? `  ${pairs}` : ''}`;
}

function scalar(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
