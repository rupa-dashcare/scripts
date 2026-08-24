import type { Clock } from '../ports/index';
import type { Priority, SourceItem, Triage } from '../domain/types';

/**
 * Strategy objects (§11.5). A new rule is a new class appended to the set;
 * existing rules are never edited, so an added rule cannot regress an old one.
 */
export interface TriageRule {
  readonly id: string;
  matches(item: SourceItem): boolean;
  apply(item: SourceItem, clock: Clock): TriageOutcome;
}

export interface TriageOutcome {
  readonly priority?: Priority;
  readonly dueDate?: string;
}

export const DEFAULT_TRIAGE: Readonly<Triage> = {
  priority: 'Medium',
  dueDate: null,
  reasons: [],
};

export class TriageRules {
  constructor(private readonly rules: readonly TriageRule[]) {}

  /** First rule to set a field wins that field. Order is significant. */
  evaluate(item: SourceItem, clock: Clock): Triage {
    let priority: Priority | undefined;
    let dueDate: string | undefined;
    const reasons: string[] = [];

    for (const rule of this.rules) {
      if (!rule.matches(item)) continue;
      const out = rule.apply(item, clock);
      let contributed = false;
      if (priority === undefined && out.priority !== undefined) {
        priority = out.priority;
        contributed = true;
      }
      if (dueDate === undefined && out.dueDate !== undefined) {
        dueDate = out.dueDate;
        contributed = true;
      }
      if (contributed) reasons.push(rule.id);
    }

    return {
      priority: priority ?? DEFAULT_TRIAGE.priority,
      dueDate: dueDate ?? DEFAULT_TRIAGE.dueDate,
      reasons,
    };
  }
}
