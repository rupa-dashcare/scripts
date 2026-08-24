/**
 * Composition root (§11.7). The ONLY file allowed to construct adapters —
 * dependency-cruiser fails the build if anything else imports src/adapters.
 */
import { JiraDoctor } from './adapters/jira/JiraDoctor';
import { apiBaseUrl, JiraTicketStore } from './adapters/jira/JiraTicketStore';
import { JiraUpstreamSource } from './adapters/jira/JiraUpstreamSource';
import { KvCredentialStore } from './adapters/cloudflare/KvCredentialStore';
import { SlackSource } from './adapters/slack/SlackSource';
import { ProjectAccess } from './domain/ProjectAccess';
import { Redactor } from './domain/redact';
import { StructuredLogger } from './adapters/logging/StructuredLogger';
import { Dedupe } from './core/Dedupe';
import { DeterministicDrafter } from './core/DeterministicDrafter';
import { Pipeline } from './core/Pipeline';
import { SourceRegistry } from './core/SourceRegistry';
import { TriageRules } from './core/TriageRules';
import { defaultRules } from './core/rules/index';
import type {
  Checkable, Clock, CredentialStore, Logger, LogLevel, SetupInspector, TicketStore,
} from './ports/index';
import type { Config } from './config';

export interface Container {
  readonly config: Config;
  readonly tickets: TicketStore;
  readonly credentials: CredentialStore | null;
  readonly pipeline: Pipeline;
  readonly sources: SourceRegistry;
  readonly checks: readonly Checkable[];
  readonly setup: SetupInspector;
  readonly access: ProjectAccess;
}

export const systemClock: Clock = { now: () => new Date() };

/**
 * Builds the logger with every known credential already registered, so a secret
 * cannot reach a log line even if some future code path passes it straight in.
 */
export function buildLogger(config: Config, opts: {
  level?: LogLevel; format?: 'json' | 'text'; runId?: string;
} = {}): Logger {
  const redactor = new Redactor([
    config.jira.apiToken,
    config.slack.token,
    config.kv.apiToken,
  ]);
  return new StructuredLogger({
    redactor,
    level: opts.level ?? 'info',
    // A terminal gets aligned text; CI gets JSON lines that can be grepped.
    format: opts.format ?? (process.stdout.isTTY ? 'text' : 'json'),
    runId: opts.runId,
  });
}

export function buildContainer(
  config: Config,
  clock: Clock = systemClock,
  log: Logger = buildLogger(config),
): Container {
  // One policy object, constructed once, threaded through every Jira call.
  const access = new ProjectAccess(config.jira.projectKey, config.jira.readProjectKeys);

  const jira = new JiraTicketStore({
    apiBaseUrl: apiBaseUrl(config.jira.baseUrl, config.jira.cloudId),
    email: config.jira.email,
    apiToken: config.jira.apiToken,
    access,
    fieldSource: config.jira.fieldSource,
    fieldSourceKey: config.jira.fieldSourceKey,
    fieldSourceUrl: config.jira.fieldSourceUrl,
    log,
  });

  const kv = config.kv.accountId && config.kv.namespaceId && config.kv.apiToken
    ? new KvCredentialStore({
        accountId: config.kv.accountId,
        namespaceId: config.kv.namespaceId,
        apiToken: config.kv.apiToken,
      })
    : null;

  // Adding a source is a new class plus one register() line — nothing in core/ changes.
  const sources = new SourceRegistry();

  const slack = config.slack.token && config.slack.userId && config.slack.teamId
    ? new SlackSource({
        token: config.slack.token,
        userId: config.slack.userId,
        teamId: config.slack.teamId,
        triggerEmoji: config.slack.triggerEmoji,
      })
    : null;
  if (slack) sources.register(slack);

  // Mirrors issues assigned to me in the read-only projects. Registered only
  // when there is somewhere to mirror from.
  const upstream = access.mirrorKeys.length > 0
    ? new JiraUpstreamSource({
        tickets: jira,
        access,
        siteUrl: config.jira.baseUrl.replace(/\/+$/, ''),
        ...(config.jira.mirrorSkipStatuses.length > 0
          ? { skipStatuses: config.jira.mirrorSkipStatuses }
          : {}),
      })
    : null;
  if (upstream) sources.register(upstream);

  const pipeline = new Pipeline(
    sources,
    new Dedupe(jira),
    new TriageRules(defaultRules(config.ingest.incidentChannels)),
    new DeterministicDrafter(),
    jira,
    clock,
    log,
  );

  const checks: Checkable[] = [jira];
  if (slack) checks.push(slack);
  if (upstream) checks.push(upstream);
  if (kv) checks.push(kv);

  const setup = new JiraDoctor(
    jira,
    config.jira.projectKey,
    {
      JIRA_FIELD_SOURCE: config.jira.fieldSource,
      JIRA_FIELD_SOURCE_KEY: config.jira.fieldSourceKey,
      JIRA_FIELD_SOURCE_URL: config.jira.fieldSourceUrl,
    },
    config.jira.baseUrl.replace(/\/+$/, ''),
  );

  return { config, tickets: jira, credentials: kv, pipeline, sources, checks, setup, access };
}

function fmt(meta: Record<string, unknown>): string {
  return Object.entries(meta).map(([k, v]) => `${k}=${String(v)}`).join(' ');
}
