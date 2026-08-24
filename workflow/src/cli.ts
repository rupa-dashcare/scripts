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
  .description('verify every credential and print what is reachable')
  .option('--fields', 'list Jira custom field ids, to fill in .env')
  .action(async (opts: { fields?: boolean }) => {
    const config = loadConfig();
    const c = buildContainer(config);

    console.log(`\n  project   ${config.jira.projectKey} @ ${config.jira.baseUrl}`);
    console.log(`  lookback  ${config.ingest.lookbackHours}h`);
    console.log(`  sources   ${c.sources.size} registered\n`);

    let failed = 0;
    for (const check of c.checks) {
      const r = await check.check();
      if (!r.ok) failed += 1;
      console.log(`  ${r.ok ? '✓' : '✗'} ${check.checkName.padEnd(16)} ${r.detail}`);
    }

    for (const [label, value] of [
      ['Source field', config.jira.fieldSource],
      ['Source Key field', config.jira.fieldSourceKey],
      ['Source URL field', config.jira.fieldSourceUrl],
    ] as const) {
      if (!value) console.log(`  · ${label} not configured — run \`wf doctor --fields\``);
    }

    if (!c.credentials) {
      console.log('  · cloudflare-kv    not configured (needed from Phase 2)');
    }

    if (opts.fields) {
      const jira = c.tickets as { listFields?: () => Promise<readonly { id: string; name: string }[]> };
      const fields = (await jira.listFields?.()) ?? [];
      console.log('\n  custom fields:');
      for (const f of fields.filter((f) => f.id.startsWith('customfield_'))) {
        console.log(`    ${f.id.padEnd(24)} ${f.name}`);
      }
    }

    console.log('');
    process.exitCode = failed > 0 ? 1 : 0;
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

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});

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
