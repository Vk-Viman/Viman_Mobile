// Phase 19 HISTORY audit - DEFECT 2 (expected RED, severity LOW / MEDIUM, missing protections that pre-date PR #13 and need raw SQL to reach).
// (a) schema_migrations has no delete / update guard: deleting a row makes the next start try to re-run a migration (the app cannot start) or hides a tampered history.
// (b) any other document can be flipped posted -> void by raw SQL without reversal rows (same class as defect 1, systemic for the 18 other voidable tables).
// (c) a cash entry that claims to reverse another entry is accepted even if it does not mirror it (type, amount, book, reference); only reversals of RETURNS
//     are validated (trigger trg_cash_entries_return_reversal in migration 017).

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, today } from './helpers/inventory.ts';
import { must } from './helpers/phase14.ts';
import { expNew } from './helpers/phase8.ts';
import { n1, probe } from './helpers/phase19h.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

describe('DEFECT 2: protections that the database does not give', () => {
  it('(a) a row of schema_migrations cannot be deleted or rewritten', async () => {
    const s = await apiBase(await env.build());
    expect(probe(s.ctx, 'DELETE FROM schema_migrations WHERE version = 5'), 'delete accepted').not.toBeNull();
    expect(probe(s.ctx, "UPDATE schema_migrations SET checksum = 'x' WHERE version = 5"), 'update accepted').not.toBeNull();
  });
  it('(b) an expense cannot be flipped to void by raw SQL while its cash entry has no reversal', async () => {
    const s = await apiBase(await env.build());
    const e = await must(await expNew(s, { businessDate: today(), book: 'shop', category: 'rent', amountCents: 5000 }), 'expense');
    const err = probe(s.ctx, `UPDATE expenses SET status = 'void', voided_at = '${today()}T00:00:00.000Z', void_reason = 'raw' WHERE id = ${e.item.id}`);
    expect(err, 'flip without reversal accepted').not.toBeNull();
  });
  it('(c) a cash entry that claims to reverse an unrelated entry is refused', async () => {
    const s = await apiBase(await env.build());
    const e = await must(await expNew(s, { businessDate: today(), book: 'shop', category: 'rent', amountCents: 5000 }), 'expense');
    const orig = n1(s.ctx, "SELECT id FROM cash_entries WHERE ref_table = 'expenses' AND ref_id = ?", e.item.id);
    const err = probe(s.ctx, `INSERT INTO cash_entries (book, business_date, type, amount_cents, reverses_entry_id) VALUES ('telecom', '${today()}', 'capital', 77, ${orig})`);
    expect(err, 'mismatching reversal accepted').not.toBeNull();
  });
});
