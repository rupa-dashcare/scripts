import { describe, expect, it } from 'vitest';
import { TriageRules } from '../src/core/TriageRules';
import { defaultRules } from '../src/core/rules/index';
import { FakeClock, item } from './fakes/index';

const clock = new FakeClock('2026-08-20T09:00:00Z'); // a Thursday
const rules = new TriageRules(defaultRules(['C-INCIDENTS']));

describe('triage rules', () => {
  it('applies the per-source default', () => {
    const t = rules.evaluate(item({ source: 'drive', hints: {} }), clock);
    expect(t.priority).toBe('Low');
    expect(t.dueDate).toBe('2026-08-27');
    expect(t.reasons).toContain('source-default');
  });

  it('escalates in an incident channel', () => {
    const t = rules.evaluate(item({ hints: { channel: 'C-INCIDENTS' } }), clock);
    expect(t.priority).toBe('High');
    expect(t.dueDate).toBe('2026-08-21');
  });

  it('escalates on a keyword anywhere in the body', () => {
    const t = rules.evaluate(item({ body: 'this is a blocker for launch' }), clock);
    expect(t.priority).toBe('High');
  });

  it('is case-insensitive about keywords', () => {
    expect(rules.evaluate(item({ body: 'OUTAGE in prod' }), clock).priority).toBe('High');
  });

  it('lets a stated due date beat the computed one', () => {
    const t = rules.evaluate(
      item({ source: 'granola', hints: { statedDueDate: '2026-09-01' } }),
      clock,
    );
    expect(t.dueDate).toBe('2026-09-01');
  });

  it('gives an earlier rule precedence over a later one', () => {
    // incident channel (High, +1bd) is registered before keyword escalation
    const t = rules.evaluate(
      item({ body: 'urgent', hints: { channel: 'C-INCIDENTS' } }),
      clock,
    );
    expect(t.dueDate).toBe('2026-08-21');
    expect(t.reasons[0]).toBe('slack-incident-channel');
  });

  it('records only the rules that actually contributed a field', () => {
    // vip-sender sets both priority and due date, so source-default adds nothing
    const t = rules.evaluate(item({ hints: { isVip: true } }), clock);
    expect(t.reasons).toEqual(['vip-sender']);
  });

  it('records a later rule when it fills a field an earlier one left open', () => {
    // stated-due-date sets only the due date; priority still falls to the default
    const t = rules.evaluate(
      item({ source: 'drive', hints: { statedDueDate: '2026-09-01' } }),
      clock,
    );
    expect(t.reasons).toEqual(['stated-due-date', 'source-default']);
    expect(t.dueDate).toBe('2026-09-01');
    expect(t.priority).toBe('Low');
  });

  it('always produces a priority', () => {
    for (const source of ['slack', 'granola', 'gmail', 'graph', 'drive', 'calendar', 'jira'] as const) {
      expect(rules.evaluate(item({ source, hints: {} }), clock).priority).toBeTruthy();
    }
  });
});
