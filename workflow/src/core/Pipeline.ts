import { dedupeKey, dedupeLabel } from '../domain/fingerprint';
import type { Clock, Drafter, Logger, TicketStore } from '../ports/index';
import type {
  IssueKey, RunReport, SourceFailure, SourceItem, TicketDraft, TimeWindow,
} from '../domain/types';
import type { Dedupe } from './Dedupe';
import type { SourceRegistry } from './SourceRegistry';
import type { TriageRules } from './TriageRules';

/**
 * collect → dedupe → triage → draft → create (§2).
 * Sources run independently: one broken adapter becomes a warning in the
 * report, never a dead run (§11.4).
 */
export class Pipeline {
  constructor(
    private readonly sources: SourceRegistry,
    private readonly dedupe: Dedupe,
    private readonly triage: TriageRules,
    private readonly drafter: Drafter,
    private readonly tickets: TicketStore,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  async run(window: TimeWindow, opts: { dryRun?: boolean } = {}): Promise<RunReport> {
    const sources = this.sources.enabled();
    const settled = await Promise.allSettled(sources.map((s) => s.collect(window)));

    const collected: SourceItem[] = [];
    const failures: SourceFailure[] = [];

    settled.forEach((result, i) => {
      const source = sources[i];
      if (!source) return;
      if (result.status === 'fulfilled') {
        collected.push(...result.value);
      } else {
        const error = result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
        failures.push({ source: source.name, error });
        this.log.warn(`source "${source.name}" failed`, { error });
      }
    });

    const { fresh, duplicates } = await this.dedupe.filter(collected);
    const created: IssueKey[] = [];

    for (const item of fresh) {
      const draft = await this.toDraft(item);
      if (opts.dryRun) {
        this.log.info(`would create: ${draft.title}`, {
          priority: draft.priority, due: draft.dueDate, source: draft.source,
        });
        continue;
      }
      created.push(await this.tickets.create(draft));
    }

    return { collected: collected.length, duplicates, created, failures };
  }

  private async toDraft(item: SourceItem): Promise<TicketDraft> {
    const triage = this.triage.evaluate(item, this.clock);
    const drafted = await this.drafter.draft(item);
    const key = dedupeKey(item.sourceKey);

    const description = triage.reasons.length > 0
      ? `${drafted.description}\n\nTriage: ${triage.reasons.join(', ')}`
      : drafted.description;

    return {
      sourceKey: item.sourceKey,
      dedupeKey: key,
      source: item.source,
      title: drafted.title,
      description,
      url: item.url,
      priority: triage.priority,
      dueDate: triage.dueDate,
      labels: [dedupeLabel(key), `src-${item.source}`],
    };
  }
}
