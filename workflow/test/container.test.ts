import { describe, expect, it } from 'vitest';
import { buildContainer } from '../src/container';
import { loadConfig } from '../src/config';
import { FakeClock, silentLogger } from './fakes/index';

const BASE = {
  JIRA_BASE_URL: 'https://casedrive.atlassian.net',
  JIRA_EMAIL: 'rupa.patel@dashcaregroup.com',
  JIRA_API_TOKEN: 'token',
  JIRA_PROJECT_KEY: 'RUPA',
} as NodeJS.ProcessEnv;

const WITH_SLACK = {
  ...BASE,
  SLACK_USER_TOKEN: 'xoxp-x',
  SLACK_USER_ID: 'U1',
  SLACK_TEAM_ID: 'T1',
} as NodeJS.ProcessEnv;

function container(env: NodeJS.ProcessEnv) {
  return buildContainer(loadConfig(env), new FakeClock('2026-08-24T00:00:00Z'), silentLogger);
}

const WITH_READS = { ...BASE, JIRA_READ_PROJECT_KEYS: 'PP,DL,DEV' } as NodeJS.ProcessEnv;

describe('container', () => {
  it('registers no sources when nothing is configured', () => {
    expect(container(BASE).sources.size).toBe(0);
  });

  it('registers the mirror source once read-only projects exist', () => {
    const c = container(WITH_READS);
    expect(c.sources.enabled().map((s) => s.name)).toEqual(['jira']);
    expect(c.access.mirrorKeys).toEqual(['PP', 'DL', 'DEV']);
  });

  it('does not register the mirror when there is nowhere to mirror from', () => {
    expect(container(BASE).access.mirrorKeys).toEqual([]);
    expect(container(BASE).sources.enabled().map((s) => s.name)).not.toContain('jira');
  });

  it('runs Slack and the mirror together', () => {
    const both = { ...WITH_SLACK, JIRA_READ_PROJECT_KEYS: 'PP,DL,DEV' } as NodeJS.ProcessEnv;
    expect(container(both).sources.enabled().map((s) => s.name).sort())
      .toEqual(['jira', 'slack']);
  });

  it('registers Slack once its three values are present', () => {
    const c = container(WITH_SLACK);
    expect(c.sources.size).toBe(1);
    expect(c.sources.enabled().map((s) => s.name)).toEqual(['slack']);
  });

  it('does not register Slack on a partial config', () => {
    const partial = { ...WITH_SLACK, SLACK_TEAM_ID: undefined } as NodeJS.ProcessEnv;
    expect(container(partial).sources.size).toBe(0);
  });

  it('adds Slack to the doctor checks only when registered', () => {
    expect(container(BASE).checks.map((c) => c.checkName)).toEqual(['jira']);
    expect(container(WITH_SLACK).checks.map((c) => c.checkName)).toEqual(['jira', 'slack']);
    expect(container(WITH_READS).checks.map((c) => c.checkName))
      .toEqual(['jira', 'jira-upstream']);
  });

  it('leaves the credential store null until Cloudflare is configured', () => {
    expect(container(BASE).credentials).toBeNull();
    const withKv = {
      ...BASE, CF_ACCOUNT_ID: 'a', CF_KV_NAMESPACE_ID: 'n', CF_API_TOKEN: 't',
    } as NodeJS.ProcessEnv;
    expect(container(withKv).credentials).not.toBeNull();
  });

  it('rejects an incomplete Jira config with a readable message', () => {
    expect(() => loadConfig({ JIRA_BASE_URL: 'not-a-url' } as NodeJS.ProcessEnv))
      .toThrow(/jira\.baseUrl/);
  });

  it('defaults the trigger emoji to ticket', () => {
    expect(loadConfig(BASE).slack.triggerEmoji).toBe('ticket');
  });
});
