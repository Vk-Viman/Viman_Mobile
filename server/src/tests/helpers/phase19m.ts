// Phase 19 date-policy-aware helpers for the seeded model tests (see phase19-model-*.test.ts).
// After the closed-day ordering rule (migration 016, BUSINESS_RULES section 8) a write dated on or before the latest closed day of a touched book is
// refused. A generator that picks dates uniformly therefore gets most of its writes refused. `biased` picks a date the model KNOWS is permitted
// (strictly after the latest closed day of every touched book, or any date when none is closed) most of the time and a deliberately blocked
// (uniformly random) date the rest of the time, so refusals stay covered without starving the accepted scenarios.

/** Probability that a write gets a date known to be permitted (when one exists). */
export const PERMITTED_SHARE = 0.78;

/** A date for a write: `permitted(d)` is the model's verdict. ~78% of the time a permitted date (if any), otherwise any date at all. */
export function biased(rnd: () => number, dates: readonly string[], permitted: (d: string) => boolean, share = PERMITTED_SHARE): string {
  const ok = dates.filter(permitted);
  if (ok.length > 0 && rnd() < share) return ok[Math.floor(rnd() * ok.length)] as string;
  return dates[Math.floor(rnd() * dates.length)] as string;
}

/** Per-scenario counters: `ok:<category>` accepted, `<CODE>:<category>` refused with that error code. */
export class Cov {
  private m = new Map<string, number>();
  hit(key: string): void { this.m.set(key, (this.m.get(key) ?? 0) + 1); }
  get(key: string): number { return this.m.get(key) ?? 0; }
  /** Sum of every counter whose key starts with `prefix`. */
  sum(prefix: string): number { let n = 0; for (const [k, v] of this.m) if (k.startsWith(prefix)) n += v; return n; }
  /** Sum of every counter whose key ends with `:category`. */
  ofCategory(category: string): number { let n = 0; for (const [k, v] of this.m) if (k.endsWith(`:${category}`)) n += v; return n; }
  /** One line: `label | key=n key=n ...` in key order. */
  line(label: string): string { return `${label} | ${[...this.m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(' ')}`; }
}

/** The one-line statistics table printed to the test output. */
export function statsLine(label: string, stats: Record<string, number>): string {
  return `[phase19m] ${label} | ${Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(' ')}`;
}
