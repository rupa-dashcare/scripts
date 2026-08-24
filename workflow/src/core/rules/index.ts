import { addBusinessDays, addDays, toJiraDate } from '../../domain/dates';
import type { Clock } from '../../ports/index';
import type { SourceItem } from '../../domain/types';
import type { TriageRule, TriageOutcome } from '../TriageRules';

/** Escalation keywords are a deterministic rule, not a model judgement (§5). */
const ESCALATORS = ['blocker', 'outage', 'incident', 'p0', 'eod', 'urgent'];

export class KeywordEscalation implements TriageRule {
  readonly id = 'keyword-escalation';
  matches(item: SourceItem): boolean {
    const hay = `${item.title}\n${item.body}`.toLowerCase();
    return ESCALATORS.some((k) => hay.includes(k));
  }
  apply(_item: SourceItem, clock: Clock): TriageOutcome {
    return { priority: 'High', dueDate: toJiraDate(addBusinessDays(clock.now(), 1)) };
  }
}

/** A date the source stated itself always beats a computed one. */
export class StatedDueDate implements TriageRule {
  readonly id = 'stated-due-date';
  matches(item: SourceItem): boolean {
    return typeof item.hints.statedDueDate === 'string';
  }
  apply(item: SourceItem): TriageOutcome {
    return { dueDate: item.hints.statedDueDate };
  }
}

/** A mirrored Jira issue inherits its upstream triage — §5. */
export class InheritUpstream implements TriageRule {
  readonly id = 'inherit-upstream';
  matches(item: SourceItem): boolean {
    return item.source === 'jira' && item.hints.upstreamPriority !== undefined;
  }
  apply(item: SourceItem): TriageOutcome {
    const out: TriageOutcome = { priority: item.hints.upstreamPriority };
    return item.hints.upstreamDueDate
      ? { ...out, dueDate: item.hints.upstreamDueDate }
      : out;
  }
}

export class SlackIncidentChannel implements TriageRule {
  readonly id = 'slack-incident-channel';
  constructor(private readonly channels: readonly string[]) {}
  matches(item: SourceItem): boolean {
    return item.source === 'slack'
      && typeof item.hints.channel === 'string'
      && this.channels.includes(item.hints.channel);
  }
  apply(_item: SourceItem, clock: Clock): TriageOutcome {
    return { priority: 'High', dueDate: toJiraDate(addBusinessDays(clock.now(), 1)) };
  }
}

export class VipSender implements TriageRule {
  readonly id = 'vip-sender';
  matches(item: SourceItem): boolean {
    return item.hints.isVip === true;
  }
  apply(_item: SourceItem, clock: Clock): TriageOutcome {
    return { priority: 'High', dueDate: toJiraDate(addBusinessDays(clock.now(), 2)) };
  }
}

/** Per-source defaults. Always last — it only fills what nothing else set. */
export class SourceDefault implements TriageRule {
  readonly id = 'source-default';
  matches(): boolean {
    return true;
  }
  apply(item: SourceItem, clock: Clock): TriageOutcome {
    const now = clock.now();
    switch (item.source) {
      case 'slack':
        return { priority: 'Medium', dueDate: toJiraDate(addBusinessDays(now, 3)) };
      case 'granola':
        return { priority: 'Medium', dueDate: toJiraDate(addDays(now, 7)) };
      case 'gmail':
      case 'graph':
        return { priority: 'Medium', dueDate: toJiraDate(addBusinessDays(now, 5)) };
      case 'drive':
        return { priority: 'Low', dueDate: toJiraDate(addDays(now, 7)) };
      case 'calendar':
        return { priority: 'Medium', dueDate: toJiraDate(addDays(now, 7)) };
      case 'jira':
        return { priority: 'Medium', dueDate: toJiraDate(addDays(now, 7)) };
    }
  }
}

export function defaultRules(incidentChannels: readonly string[] = []): readonly TriageRule[] {
  return [
    new StatedDueDate(),
    new InheritUpstream(),
    new SlackIncidentChannel(incidentChannels),
    new VipSender(),
    new KeywordEscalation(),
    new SourceDefault(),
  ];
}
