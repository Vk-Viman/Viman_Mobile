// Helpers for the Phase 23 "correct this entry" tests (shared, read-only helpers: no test may change them).
import { createHash } from 'node:crypto';
import type { AppContext } from '../../app.ts';
import { INVARIANT_CHECKS } from '../../services/database-validation-invariants.ts';
import { dbIntegrity } from './phase19h.ts';

/**
 * A fingerprint of EVERY row of EVERY table (including audit_logs and corrections): two equal fingerprints mean the database was not
 * changed at all. Used to prove that a refused correction, a preview and an eligibility check leave nothing behind.
 */
export function fingerprint(ctx: AppContext): string {
  const c = ctx.database.conn;
  const tables = (c.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
    .map((r) => r.name);
  const h = createHash('sha256');
  for (const t of tables) {
    h.update(`#${t}\n`);
    for (const row of c.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()) h.update(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n');
  }
  return h.digest('hex');
}

/** Every accounting invariant of the restore validator (stock = movements, cash reversals, Ice Cream funds, void reversals, dates) plus integrity. [] = all reconcile. */
export function allProblems(ctx: AppContext): string[] {
  const out = dbIntegrity(ctx);
  for (const check of INVARIANT_CHECKS) for (const f of check.run(ctx.database.conn, new Date())) out.push(`${f.code}: ${f.message}`);
  return out;
}

/** Number of rows of a table (cheap "nothing was added" assertions). */
export const count = (ctx: AppContext, table: string): number =>
  Number((ctx.database.conn.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number | bigint }).n);
