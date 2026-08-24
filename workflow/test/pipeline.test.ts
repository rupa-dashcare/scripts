import { describe, expect, it } from 'vitest';
import { Dedupe } from '../src/core/Dedupe';
import { Pipeline } from '../src/core/Pipeline';
import { SourceRegistry } from '../src/core/SourceRegistry';
import { TriageRules } from '../src/core/TriageRules';
import { defaultRules } from '../src/core/rules/index';
import { DeterministicDrafter } from '../src/core/DeterministicDrafter';
import {
  ExplodingSource, FakeClock, InMemoryTicketStore, StubDrafter, StubSource,
  item, silentLogger,
} from './fakes/index';
import type { SourceItem } from '../src/domain/types';

const WINDOW = { from: new Date('2026-08-19T00:00:00Z'), to: new Date('2026-08-21T00:00:00Z') };

function build(items: readonly SourceItem[], tickets = new InMemoryTicketStore()) {
  const sources = new SourceRegistry().register(new StubSource('slack', items));
  const pipeline = new Pipeline(
    sources,
    new Dedupe(tickets),
    new TriageRules(defaultRules()),
    new StubDrafter(),
    tickets,
    new FakeClock('2026-08-20T09:00:00Z'),
    silentLogger,
  );
  return { pipeline, tickets, sources };
}

describe('Pipeline', () => {
  it('creates one staged ticket per fresh item', async () => {
    const { pipeline, tickets } = build([item()]);
    const report = await pipeline.run(WINDOW);

    expect(report.created).toHaveLength(1);
    expect(tickets.created[0]?.title).toBe('Rotate the staging cert');
    expect(tickets.created[0]?.priority).toBe('Medium');
    expect(tickets.created[0]?.labels).toContain('src-slack');
  });

  // The single most important test in the suite — DESIGN.md §8.
  it('is idempotent: running twice creates exactly one ticket', async () => {
    const { pipeline, tickets } = build([item()]);

    await pipeline.run(WINDOW);
    await pipeline.run(WINDOW);

    expect(tickets.created).toHaveLength(1);
  });

  it('collapses duplicates inside a single run', async () => {
    const { pipeline, tickets } = build([item(), item(), item()]);
    const report = await pipeline.run(WINDOW);

    expect(tickets.created).toHaveLength(1);
    expect(report.duplicates).toBe(2);
  });

  it('treats items from different sources as distinct', async () => {
    const tickets = new InMemoryTicketStore();
    const sources = new SourceRegistry()
      .register(new StubSource('slack', [item({ sourceKey: 'slack:a' })]))
      .register(new StubSource('gmail', [item({ source: 'gmail', sourceKey: 'gmail:a' })]));
    const pipeline = new Pipeline(
      sources, new Dedupe(tickets), new TriageRules(defaultRules()),
      new StubDrafter(), tickets, new FakeClock('2026-08-20T09:00:00Z'), silentLogger,
    );

    await pipeline.run(WINDOW);
    expect(tickets.created).toHaveLength(2);
  });

  it('survives a broken source and still processes the healthy ones', async () => {
    const tickets = new InMemoryTicketStore();
    const sources = new SourceRegistry()
      .register(new ExplodingSource('granola'))
      .register(new StubSource('slack', [item()]));
    const pipeline = new Pipeline(
      sources, new Dedupe(tickets), new TriageRules(defaultRules()),
      new StubDrafter(), tickets, new FakeClock('2026-08-20T09:00:00Z'), silentLogger,
    );

    const report = await pipeline.run(WINDOW);

    expect(report.created).toHaveLength(1);
    expect(report.failures).toEqual([{ source: 'granola', error: 'upstream 503' }]);
  });

  it('creates nothing on a dry run', async () => {
    const { pipeline, tickets } = build([item()]);
    const report = await pipeline.run(WINDOW, { dryRun: true });

    expect(tickets.created).toHaveLength(0);
    expect(report.created).toHaveLength(0);
    expect(report.collected).toBe(1);
  });

  it('writes the dedupe label so the next run can find it', async () => {
    const { pipeline, tickets } = build([item()]);
    await pipeline.run(WINDOW);
    expect(tickets.created[0]?.labels.some((l) => /^srckey-[0-9a-f]{16}$/.test(l))).toBe(true);
  });

  it('records the triage reasons on the issue', async () => {
    const { pipeline, tickets } = build([item({ hints: { isVip: true } })]);
    await pipeline.run(WINDOW);
    expect(tickets.created[0]?.description).toContain('Triage: vip-sender');
  });

  it('handles an empty run without querying Jira', async () => {
    const { pipeline, tickets } = build([]);
    const report = await pipeline.run(WINDOW);
    expect(report).toMatchObject({ collected: 0, duplicates: 0, created: [] });
    expect(tickets.created).toHaveLength(0);
  });
});

describe('DeterministicDrafter', () => {
  it('falls back to the first non-empty line', async () => {
    const d = await new DeterministicDrafter().draft(item({ title: '', body: '\n\nfix the thing\nmore' }));
    expect(d.title).toBe('fix the thing');
  });

  it('truncates a long title', async () => {
    const d = await new DeterministicDrafter(20).draft(item({ title: 'x'.repeat(200) }));
    expect(d.title).toHaveLength(20);
    expect(d.title.endsWith('…')).toBe(true);
  });

  it('never returns an empty title', async () => {
    const d = await new DeterministicDrafter().draft(item({ title: '', body: '' }));
    expect(d.title).toBe('Untitled');
  });

  it('keeps a link back to the original', async () => {
    const d = await new DeterministicDrafter().draft(item());
    expect(d.description).toContain('https://example.slack.com');
  });
});

describe('SourceRegistry', () => {
  it('refuses a duplicate registration rather than silently replacing', () => {
    const r = new SourceRegistry().register(new StubSource('slack', []));
    expect(() => r.register(new StubSource('slack', []))).toThrow(/already registered/);
  });

  it('filters to the requested sources', () => {
    const r = new SourceRegistry()
      .register(new StubSource('slack', []))
      .register(new StubSource('gmail', []));
    expect(r.enabled(['gmail']).map((s) => s.name)).toEqual(['gmail']);
    expect(r.enabled()).toHaveLength(2);
  });
});
