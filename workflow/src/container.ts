/**
 * Composition root (§11.7). The ONLY file allowed to construct adapters —
 * dependency-cruiser fails the build if anything else imports src/adapters.
 */
import { JiraDoctor } from './adapters/jira/JiraDoctor';
import { JiraTicketStore } from './adapters/jira/JiraTicketStore';
import { KvCredentialStore } from './adapters/cloudflare/KvCredentialStore';
import { Dedupe } from './core/Dedupe';
import { DeterministicDrafter } from './core/DeterministicDrafter';
import { Pipeline } from './core/Pipeline';
import { SourceRegistry } from './core/SourceRegistry';
import { TriageRules } from './core/TriageRules';
import { defaultRules } from './core/rules/index';
import type {
  Checkable, Clock, CredentialStore, Logger, SetupInspector, TicketStore,
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
}

export const systemClock: Clock = { now: () => new Date() };

export const consoleLogger: Logger = {
  info: (msg, meta) => console.log(meta ? `${msg} ${fmt(meta)}` : msg),
  warn: (msg, meta) => console.warn(meta ? `! ${msg} ${fmt(meta)}` : `! ${msg}`),
};

export function buildContainer(
  config: Config,
  clock: Clock = systemClock,
  log: Logger = consoleLogger,
): Container {
  const jira = new JiraTicketStore({
    baseUrl: config.jira.baseUrl,
    email: config.jira.email,
    apiToken: config.jira.apiToken,
    projectKey: config.jira.projectKey,
    fieldSource: config.jira.fieldSource,
    fieldSourceKey: config.jira.fieldSourceKey,
    fieldSourceUrl: config.jira.fieldSourceUrl,
  });

  const kv = config.kv.accountId && config.kv.namespaceId && config.kv.apiToken
    ? new KvCredentialStore({
        accountId: config.kv.accountId,
        namespaceId: config.kv.namespaceId,
        apiToken: config.kv.apiToken,
      })
    : null;

  // Phase 1+ registers real sources here. Phase 0 ships the wiring, not the adapters.
  const sources = new SourceRegistry();

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

  return { config, tickets: jira, credentials: kv, pipeline, sources, checks, setup };
}

function fmt(meta: Record<string, unknown>): string {
  return Object.entries(meta).map(([k, v]) => `${k}=${String(v)}`).join(' ');
}
