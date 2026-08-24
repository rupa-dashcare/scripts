#!/usr/bin/env -S node --import tsx
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { loadConfig } from './config';
import { buildContainer, consoleLogger, systemClock } from './container';

loadDotEnv();

const program = new Command();
program.name('wf').description('Personal workflow system — signal to ticket').version('0.1.0');

program
  .command('doctor')
  .description('verify every credential and that Jira is shaped correctly')
  .option('--fields', 'list every Jira custom field id')
  .action(async (opts: { fields?: boolean }) => {
    const config = loadConfig();
    const c = buildContainer(config);

    console.log(`\n  site      ${config.jira.baseUrl}`);
    console.log(`  project   ${config.jira.projectKey}`);
    console.log(`  as        ${config.jira.email}`);
    console.log(`  lookback  ${config.ingest.lookbackHours}h`);
    console.log(`  sources   ${c.sources.size} registered\n`);

    const remedies: string[] = [];
    let failed = 0;

    console.log('  connectivity');
    for (const check of c.checks) {
      const r = await check.check();
      if (!r.ok) failed += 1;
      console.log(`    ${mark(r.ok)} ${check.checkName.padEnd(18)} ${r.detail}`);
    }
    if (!c.credentials) {
      console.log('    · cloudflare-kv      not configured (first needed in Phase 2)');
    }

    // Project shape is only meaningful once Jira is actually reachable.
    if (failed === 0) {
      console.log('\n  project setup');
      for (const f of await c.setup.inspect()) {
        if (!f.ok) {
          failed += 1;
          if (f.remedy) remedies.push(`${f.name}\n      ${f.remedy}`);
        }
        console.log(`    ${mark(f.ok)} ${f.name.padEnd(18)} ${f.detail}`);
      }
    }

    if (remedies.length > 0) {
      console.log('\n  to fix');
      for (const r of remedies) console.log(`    · ${r}`);
    }

    if (opts.fields) {
      const jira = c.tickets as { listFields?: () => Promise<readonly { id: string; name: string }[]> };
      const fields = (await jira.listFields?.()) ?? [];
      console.log('\n  custom fields');
      for (const f of fields.filter((f) => f.id.startsWith('customfield_'))) {
        console.log(`    ${f.id.padEnd(24)} ${f.name}`);
      }
    }

    console.log(failed === 0 ? '\n  all green\n' : `\n  ${failed} problem(s)\n`);
    process.exitCode = failed > 0 ? 1 : 0;
  });

program
  .command('setup')
  .description('print the one-time manual Jira checklist')
  .action(() => {
    const config = loadConfig();
    const site = config.jira.baseUrl.replace(/\/+$/, '');
    const key = config.jira.projectKey;
    // RUPA is a team-managed *business* project, so settings live under /jira/core.
    const settings = `${site}/jira/core/projects/${key}/settings`;
    console.log(`
  One-time Jira setup. The project already exists — ${key} ("To Do's") — so this
  is three edits, not a creation. None of it is reachable through the API without
  site-admin rights, so it is a browser job. See DESIGN.md §6.

  1. Make it private
     ${settings}/access
     It is currently visible to the whole site.

  2. Add the workflow statuses
     ${settings}/workflows
     Staged → To Do → In Progress → Done, plus Rejected as a terminal state.
     New issues must land in Staged. (To Do, In Progress and Done already exist.)

  3. Add three fields to the Task issue type
     ${settings}/issuetypes
     Team-managed projects attach fields per issue type, so open Task and add:
     · Source      — short text
     · Source Key  — short text
     · Source URL  — URL

  4. Mint an API token
     https://id.atlassian.com/manage-profile/security/api-tokens

  5. Fill in .env, then run:  npm run wf -- doctor
     doctor verifies all of the above and prints the exact JIRA_FIELD_* ids.

  6. Push the same values as GitHub secrets:
     gh secret set JIRA_BASE_URL --body '${site}'
     gh secret set JIRA_EMAIL --body '${config.jira.email}'
     gh secret set JIRA_API_TOKEN        # prompts, so it stays out of shell history
     gh secret set JIRA_PROJECT_KEY --body '${key}'
     gh secret set JIRA_FIELD_SOURCE --body '<from doctor>'
     gh secret set JIRA_FIELD_SOURCE_KEY --body '<from doctor>'
     gh secret set JIRA_FIELD_SOURCE_URL --body '<from doctor>'
`);
  });

program
  .command('ingest')
  .description('collect from every source and create staged tickets')
  .option('--dry-run', 'print what would be created, change nothing')
  .option('--hours <n>', 'override the lookback window')
  .action(async (opts: { dryRun?: boolean; hours?: string }) => {
    const config = loadConfig();
    const c = buildContainer(config, systemClock, consoleLogger);

    const hours = opts.hours ? Number(opts.hours) : config.ingest.lookbackHours;
    const to = systemClock.now();
    const from = new Date(to.getTime() - hours * 3_600_000);

    const report = await c.pipeline.run({ from, to }, { dryRun: opts.dryRun });

    console.log(
      `\n  collected ${report.collected}  duplicates ${report.duplicates}  created ${report.created.length}`,
    );
    for (const key of report.created) console.log(`    + ${key}`);
    for (const f of report.failures) console.log(`    ! ${f.source}: ${f.error}`);
    console.log('');

    // A failed source is a warning, never a failed run (§11.4) — unless all failed.
    process.exitCode = report.failures.length > 0 && report.collected === 0 ? 1 : 0;
  });

program
  .command('stage')
  .description('work the staging queue')
  .argument('<action>', 'review | list | approve | reject')
  .option('--all', 'apply to every staged issue (approve/reject only)')
  .option('--key <issueKey...>', 'specific issue keys')
  .action(async (action: string, opts: { all?: boolean; key?: string[] }) => {
    const config = loadConfig();
    const c = buildContainer(config);
    const jql = `project = "${config.jira.projectKey}" AND status = "Staged" ORDER BY created ASC`;

    if (action === 'list' || action === 'review') {
      const issues = await c.tickets.search(jql);
      if (issues.length === 0) {
        console.log('\n  nothing staged\n');
        return;
      }
      console.log(`\n  ${issues.length} staged\n`);
      for (const i of issues) {
        const due = i.dueDate ?? '—';
        console.log(`    ${i.key.padEnd(12)} ${i.priority.padEnd(8)} due ${due}  ${i.summary}`);
      }
      console.log(`\n  approve:  npm run wf -- stage approve --key ${issues[0]?.key}`);
      console.log(`  or all:   npm run wf -- stage approve --all\n`);
      return;
    }

    if (action !== 'approve' && action !== 'reject') {
      throw new Error(`unknown action "${action}" — use review, list, approve or reject`);
    }

    const target = opts.key?.length
      ? opts.key.map((k) => k as never)
      : opts.all
        ? (await c.tickets.search(jql)).map((i) => i.key)
        : null;

    if (!target) throw new Error('pass --key <ISSUE-1> or --all');
    if (target.length === 0) {
      console.log('\n  nothing staged\n');
      return;
    }

    const to = action === 'approve' ? 'To Do' : 'Rejected';
    await c.tickets.transition(target, to);
    console.log(`\n  ${target.length} → ${to}\n`);
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});

function mark(ok: boolean): string {
  return ok ? '\u2713' : '\u2717';
}

/** Minimal .env loader — avoids a dependency for four lines of parsing. */
function loadDotEnv(path = '.env'): void {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return; }
  for (const line of raw.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m?.[1]) continue;
    const value = (m[2] ?? '').trim().replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined && value.length > 0) process.env[m[1]] = value;
  }
}
