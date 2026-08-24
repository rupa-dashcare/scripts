/** All date maths is pure and clock-injected, so §5's relative rules are assertable. */

const DAY_MS = 86_400_000;

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

/** Skips Saturday and Sunday. Does not know about holidays — deliberately. */
export function addBusinessDays(from: Date, days: number): Date {
  let d = new Date(from.getTime());
  let remaining = days;
  while (remaining > 0) {
    d = addDays(d, 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return d;
}

/** Jira's due-date wire format. */
export function toJiraDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function withinWindow(at: Date, from: Date, to: Date): boolean {
  return at.getTime() >= from.getTime() && at.getTime() <= to.getTime();
}
