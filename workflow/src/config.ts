import { z } from 'zod';

const Schema = z.object({
  jira: z.object({
    baseUrl: z.string().url(),
    email: z.string().email(),
    apiToken: z.string().min(1),
    projectKey: z.string().min(1),
    fieldSource: z.string().optional(),
    fieldSourceKey: z.string().optional(),
    fieldSourceUrl: z.string().optional(),
  }),
  kv: z.object({
    accountId: z.string().optional(),
    namespaceId: z.string().optional(),
    apiToken: z.string().optional(),
  }),
  ingest: z.object({
    lookbackHours: z.coerce.number().int().positive().default(48),
    incidentChannels: z.array(z.string()).default([]),
  }),
});

export type Config = z.infer<typeof Schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.safeParse({
    jira: {
      baseUrl: env.JIRA_BASE_URL,
      email: env.JIRA_EMAIL,
      apiToken: env.JIRA_API_TOKEN,
      projectKey: env.JIRA_PROJECT_KEY,
      fieldSource: env.JIRA_FIELD_SOURCE,
      fieldSourceKey: env.JIRA_FIELD_SOURCE_KEY,
      fieldSourceUrl: env.JIRA_FIELD_SOURCE_URL,
    },
    kv: {
      accountId: env.CF_ACCOUNT_ID,
      namespaceId: env.CF_KV_NAMESPACE_ID,
      apiToken: env.CF_API_TOKEN,
    },
    ingest: {
      lookbackHours: env.LOOKBACK_HOURS ?? 48,
      incidentChannels: (env.INCIDENT_CHANNELS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    },
  });

  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration — check your .env:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
