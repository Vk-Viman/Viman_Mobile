// Package I (2/3): every rule of the `segments` validator is broken, one at a time, in a COPY of a valid database built through the API
// (raw SQL with the safety triggers lifted inside the copy only, like phase22-restore-validation). The copy must be refused with the right
// plain-language failure. The expected message is the sentence a shop owner would read; companions (a second check that also sees the same
// damage, e.g. the cash ledger) are allowed but `segments` must always be among the failed checks.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase } from './helpers/inventory.ts';
import { buildSegWorld, removeFolder, workFolder } from './helpers/phase26i.ts';
import type { SegWorld } from './helpers/phase26i.ts';
import { damagedCopy } from './helpers/phase22rs.ts';
import { createBackup } from '../services/backup.service.ts';
import { validateDatabase } from '../services/database-validation.ts';
import type { ValidationResult } from '../services/database-validation.ts';
import { checkSegments } from '../services/database-validation-invariants.ts';

const env = new TestEnv();
let work = '';
let base = '';
let world: SegWorld;
let seq = 0;

beforeAll(async () => {
  const s = await apiBase(await env.build());
  world = await buildSegWorld(s);
  work = workFolder();
  base = join(work, 'base.db');
  copyFileSync(join(s.ctx.backupsDir, createBackup(s.ctx, 'manual').name), base);
  await s.app.close();
}, 240000);
// All tests are synchronous and heavy; yielding after each lets vitest's worker report progress (as in phase22-restore-validation).
afterEach(async () => { await new Promise((r) => setTimeout(r, 0)); });
afterAll(async () => { await env.cleanup(); removeFolder(work); });

const damaged = (fn: (db: DatabaseSync) => void): string => damagedCopy(base, join(work, `d${++seq}.db`), fn);
function verdict(file: string): ValidationResult {
  const db = new DatabaseSync(file);
  try { return validateDatabase(db); } finally { db.close(); }
}
const checkCodes = (r: ValidationResult): string[] => [...new Set(r.failures.map((f) => f.code))];
const segMessages = (r: ValidationResult): string[] => r.failures.filter((f) => f.code === 'segments').map((f) => f.message);
/** The corrupted copy is refused and `segments` reports a failure matching `re`. */
function refused(file: string, re: RegExp): ValidationResult {
  const r = verdict(file);
  expect(r.ok).toBe(false);
  for (const f of r.failures) expect(f.message).not.toMatch(/node:|SQLITE_|\.ts:/);
  const status = r.checks.find((c) => c.code === 'segments')?.status;
  if (status === 'skipped') {
    // some damage is ALSO caught earlier by the table's own CHECK constraint (the integrity check of the trial copy), which makes the data
    // checks meaningless and skips them: the restore is refused all the same; the segments check itself is run directly on the damaged file
    expect(r.checks.find((c) => c.code === 'integrity_check')?.status).toBe('failed');
    const db = new DatabaseSync(file);
    try {
      const direct = checkSegments(db).map((f) => f.message);
      expect(direct.some((m) => re.test(m)), `${re} not in ${JSON.stringify(direct)}`).toBe(true);
    } finally { db.close(); }
    return r;
  }
  expect(status).toBe('failed');
  expect(segMessages(r).some((m) => re.test(m)), `${re} not in ${JSON.stringify(segMessages(r))}`).toBe(true);
  return r;
}
const NO_SEGMENT = /records that name no segment/;
const SHOP_SEGMENT = /Shop or Ice Cream records that carry a Telecom segment/;
const WRONG_KIND = /segment that does not belong to that kind of record/;
const OWNER = /cash entries whose segment differs from the record they belong to/;
const PRODUCTS = /segment differs from the segment of the products on them/;
const PROVIDER = /segment is not their provider's/;
const OPENING = /more than one opening balance/;
const COLLECTIONS = /collections in a Telecom segment differ/;
const HISTORY = /differs from their stock history/;
const TOTAL = /does not equal the sum of its segments/;

describe('the starting point', () => {
  it('the uncorrupted copy is valid (so every refusal below is caused by the damage)', () => {
    expect(verdict(base).failures).toEqual([]);
  });
});

describe('a Telecom row without a segment, a Shop row with one', () => {
  const tables: [string, string][] = [
    ['cash_entries', "WHERE book = 'telecom' AND type = 'reload_collection' AND reverses_entry_id IS NULL"],
    ['cash_counts', "WHERE book = 'telecom'"], ['capital_entries', "WHERE book = 'telecom' AND kind = 'capital'"],
    ['owner_drawings', "WHERE book = 'telecom' AND kind = 'cash'"], ['expenses', "WHERE book = 'telecom'"], ['purchases', "WHERE book = 'telecom'"],
    ['stock_losses', "WHERE book = 'telecom'"], ['stocktakes', "WHERE book = 'telecom'"], ['sales', "WHERE book = 'telecom'"], ['daily_closings', "WHERE book = 'telecom'"],
    ['reload_sales', ''], ['ezcash_sales', ''], ['telecom_topups', ''],
  ];
  it.each(tables)('%s: segment removed from a Telecom row is refused', (t, where) => {
    const r = refused(damaged((db) => db.exec(`UPDATE ${t} SET segment = NULL WHERE id = (SELECT MIN(id) FROM ${t} ${where})`)), NO_SEGMENT);
    const f = r.failures.find((x) => x.code === 'segments' && NO_SEGMENT.test(x.message));
    if (f) expect(f.detail).toMatch(/\d/); // (absent when the table's own CHECK constraint stopped the validation first; see `refused`)
  });

  it.each([['from_segment'], ['to_segment']])('a Telecom side of a transfer without a segment (%s) is refused', (col) => {
    const side = col === 'from_segment' ? 'from_book' : 'to_book';
    refused(damaged((db) => db.exec(`UPDATE cash_transfers SET ${col} = NULL WHERE id = (SELECT MIN(id) FROM cash_transfers WHERE ${side} = 'telecom')`)), NO_SEGMENT);
  });

  it('a cash entry removed from its segment also breaks "Telecom = sum of its segments"', () => {
    const r = refused(damaged((db) => db.exec("UPDATE cash_entries SET segment = NULL WHERE id = (SELECT MIN(id) FROM cash_entries WHERE book = 'telecom' AND type = 'expense' AND reverses_entry_id IS NULL)")), TOTAL);
    expect(segMessages(r).some((m) => NO_SEGMENT.test(m))).toBe(true);
  });

  const shopTables: [string, string][] = [
    ['cash_entries', "WHERE book = 'shop'"], ['cash_counts', "WHERE book = 'shop'"], ['capital_entries', "WHERE book = 'shop'"], ['expenses', "WHERE book = 'shop'"],
    ['purchases', "WHERE book = 'shop'"], ['sales', "WHERE book = 'shop'"], ['daily_closings', "WHERE book = 'shop'"],
  ];
  it.each(shopTables)('%s: a Shop row carrying a Telecom segment is refused', (t, where) => {
    const seg = ['purchases', 'sales'].includes(t) ? 'dialog_cards' : 'dialog_reloads';
    refused(damaged((db) => db.exec(`UPDATE ${t} SET segment = '${seg}' WHERE id = (SELECT MIN(id) FROM ${t} ${where})`)), SHOP_SEGMENT);
  });

  it('an Ice Cream cash entry and a Shop side of a transfer with a segment are refused', () => {
    refused(damaged((db) => db.exec("UPDATE cash_entries SET segment = 'mobitel_cards' WHERE id = (SELECT MIN(id) FROM cash_entries WHERE book = 'icecream')")), SHOP_SEGMENT);
    refused(damaged((db) => db.exec("UPDATE cash_transfers SET to_segment = 'dialog_cards' WHERE id = (SELECT MIN(id) FROM cash_transfers WHERE to_book = 'shop')")), SHOP_SEGMENT);
  });
});

describe('a segment of the wrong kind for its table', () => {
  it('a reload, EZCash or top-up record in a Cards segment; a sale, purchase, loss or stocktake in a Reloads segment; an unknown name', () => {
    refused(damaged((db) => db.exec("UPDATE reload_sales SET segment = 'dialog_cards' WHERE id = (SELECT MIN(id) FROM reload_sales)")), WRONG_KIND);
    refused(damaged((db) => db.exec("UPDATE ezcash_sales SET segment = 'mobitel_cards' WHERE id = (SELECT MIN(id) FROM ezcash_sales)")), WRONG_KIND);
    refused(damaged((db) => db.exec("UPDATE telecom_topups SET segment = 'hutch_cards' WHERE id = (SELECT MIN(id) FROM telecom_topups)")), WRONG_KIND);
    refused(damaged((db) => db.exec("UPDATE sales SET segment = 'dialog_reloads' WHERE id = (SELECT MIN(id) FROM sales WHERE book = 'telecom')")), WRONG_KIND);
    refused(damaged((db) => db.exec("UPDATE purchases SET segment = 'mobitel_reloads' WHERE id = (SELECT MIN(id) FROM purchases WHERE book = 'telecom')")), WRONG_KIND);
    refused(damaged((db) => db.exec("UPDATE stock_losses SET segment = 'airtel_reloads' WHERE id = (SELECT MIN(id) FROM stock_losses WHERE book = 'telecom')")), WRONG_KIND);
    refused(damaged((db) => db.exec("UPDATE stocktakes SET segment = 'hutch_reloads' WHERE id = (SELECT MIN(id) FROM stocktakes WHERE book = 'telecom')")), WRONG_KIND);
    refused(damaged((db) => db.exec("UPDATE cash_entries SET segment = 'vodafone_cards' WHERE id = (SELECT MIN(id) FROM cash_entries WHERE book = 'telecom')")), WRONG_KIND);
    refused(damaged((db) => db.exec("UPDATE expenses SET segment = 'telecom' WHERE id = (SELECT MIN(id) FROM expenses WHERE book = 'telecom')")), WRONG_KIND);
  });
});

describe('a reversal keeps the segment of its original', () => {
  it('a reversal moved to another segment is refused by the cash ledger check AND the segments check', () => {
    const r = verdict(damaged((db) => db.exec(`UPDATE cash_entries SET segment = 'hutch_cards' WHERE id = (SELECT MIN(id) FROM cash_entries WHERE reverses_entry_id IS NOT NULL AND segment = 'airtel_cards')`)));
    expect(r.ok).toBe(false);
    expect(checkCodes(r)).toContain('cash_ledger');
    expect(r.failures.find((f) => f.code === 'cash_ledger')!.detail).toMatch(/is in another Telecom segment than its original/);
    expect(segMessages(r).some((m) => OWNER.test(m))).toBe(true);
  });

  it('a reversal marked legacy while its original is a real segment (a made-up legacy row) is refused', () => {
    const r = verdict(damaged((db) => db.exec("UPDATE cash_entries SET segment = 'legacy' WHERE id = (SELECT MIN(id) FROM cash_entries WHERE reverses_entry_id IS NOT NULL AND book = 'telecom')")));
    expect(r.ok).toBe(false);
    expect(checkCodes(r)).toContain('cash_ledger');
    expect(r.failures.find((f) => f.code === 'cash_ledger')!.detail).toMatch(/another Telecom segment/);
  });

  it('the original moved instead of the reversal is also noticed', () => {
    const r = verdict(damaged((db) => db.exec(`UPDATE cash_entries SET segment = 'hutch_cards' WHERE id = (SELECT o.id FROM cash_entries o JOIN cash_entries c ON c.reverses_entry_id = o.id WHERE o.segment = 'airtel_cards' LIMIT 1)`)));
    expect(r.ok).toBe(false);
    expect(checkCodes(r)).toContain('cash_ledger');
  });
});

describe('a cash entry carries the segment of the record that owns it', () => {
  const kinds: [string, string][] = [
    ['sales', "ref_table = 'sales' AND type = 'card_sale'"],
    ['sales_returns', "ref_table = 'sales_returns'"],
    ['purchases', "ref_table = 'purchases' AND book = 'telecom'"],
    ['purchase_returns', "ref_table = 'purchase_returns' AND book = 'telecom'"],
    ['expenses', "ref_table = 'expenses' AND book = 'telecom'"],
    ['capital_entries (opening balance / capital)', "ref_table = 'capital_entries' AND book = 'telecom'"],
    ['owner_drawings', "ref_table = 'owner_drawings' AND book = 'telecom'"],
    ['cash_counts', "ref_table = 'cash_counts' AND book = 'telecom'"],
    ['reload_sales', "ref_table = 'reload_sales'"],
    ['ezcash_sales', "ref_table = 'ezcash_sales'"],
    ['telecom_topups', "ref_table = 'telecom_topups'"],
  ];
  it.each(kinds)('%s: the cash entry moved to another segment is refused', (_n, where) => {
    const cond = `${where} AND reverses_entry_id IS NULL AND book = 'telecom'`;
    const r = refused(damaged((db) => db.exec(`UPDATE cash_entries SET segment = CASE WHEN segment = 'hutch_reloads' THEN 'airtel_reloads' ELSE 'hutch_reloads' END WHERE id = (SELECT MIN(id) FROM cash_entries WHERE ${cond})`)), OWNER);
    expect(r.failures.find((f) => f.code === 'segments' && OWNER.test(f.message))!.detail).toMatch(/cash entry \d+/);
  });

  it('a record moved away from its cash entry (the expense changed, the entry did not) is refused', () => {
    refused(damaged((db) => db.exec("UPDATE expenses SET segment = 'hutch_cards' WHERE id = ?".replace('?', String(world.records.expenseAirtel)))), OWNER);
  });

  it('transfer legs: a leg that differs from its side of the transfer, and a transfer side edited under its legs', () => {
    refused(damaged((db) => db.exec(`UPDATE cash_entries SET segment = 'airtel_cards' WHERE type = 'transfer_in' AND ref_table = 'cash_transfers' AND ref_id = ${world.records.transferInside} AND reverses_entry_id IS NULL`)), OWNER);
    refused(damaged((db) => db.exec(`UPDATE cash_entries SET segment = 'airtel_cards' WHERE type = 'transfer_out' AND ref_table = 'cash_transfers' AND ref_id = ${world.records.transferInside} AND reverses_entry_id IS NULL`)), OWNER);
    refused(damaged((db) => db.exec(`UPDATE cash_transfers SET to_segment = 'dialog_cards' WHERE id = ${world.records.transferInside}`)), OWNER);
    refused(damaged((db) => db.exec(`UPDATE cash_transfers SET from_segment = 'hutch_cards' WHERE id = ${world.records.transferOut}`)), OWNER);
  });

  it('a transfer whose two Telecom sides are the same segment is refused', () => {
    refused(damaged((db) => db.exec(`UPDATE cash_transfers SET to_segment = from_segment WHERE id = ${world.records.transferInside}`)), /two sides are the same cash book and segment/);
  });

  it('a legacy cash entry on a record of a real segment (the made-up legacy of a new record) is refused', () => {
    refused(damaged((db) => db.exec(`UPDATE cash_entries SET segment = 'legacy' WHERE type = 'reload_collection' AND ref_table = 'reload_sales' AND ref_id = ${world.records.reloadDialog} AND reverses_entry_id IS NULL`)), OWNER);
    refused(damaged((db) => db.exec(`UPDATE cash_entries SET segment = 'legacy' WHERE ref_table = 'sales_returns' AND reverses_entry_id IS NULL AND book = 'telecom'`)), OWNER);
  });
});

describe('sales, purchases, stocktakes, losses and goods drawings carry the segment of their products', () => {
  it('a sale in another card segment than its products', () => {
    const r = refused(damaged((db) => db.exec(`UPDATE sales SET segment = 'mobitel_cards' WHERE id = ${world.sales.airtelVoided}`)), PRODUCTS);
    expect(r.failures.find((f) => PRODUCTS.test(f.message))!.detail).toMatch(/sale \d+ \(product \d+\)/);
  });
  it('a sale made legacy although its products are in a real segment', () => {
    refused(damaged((db) => db.exec(`UPDATE sales SET segment = 'legacy' WHERE id = ${world.sales.mobitel}`)), PRODUCTS);
  });
  it('a purchase, a stocktake, a stock loss in another card segment than their products', () => {
    refused(damaged((db) => db.exec(`UPDATE purchases SET segment = 'hutch_cards' WHERE id = ${world.records.purchaseDialog}`)), PRODUCTS);
    refused(damaged((db) => db.exec(`UPDATE stocktakes SET segment = 'airtel_cards' WHERE id = ${world.records.stocktake}`)), PRODUCTS);
    refused(damaged((db) => db.exec(`UPDATE stock_losses SET segment = 'dialog_cards' WHERE id = ${world.records.loss}`)), PRODUCTS);
  });
  it('a goods drawing in another segment than its product', () => {
    refused(damaged((db) => db.exec(`UPDATE owner_drawings SET segment = 'dialog_cards' WHERE id = ${world.records.goodsDrawing}`)), PRODUCTS);
  });
  it('a Telecom sale line holding a Shop product (or the other way round) is refused', () => {
    refused(damaged((db) => db.exec(`UPDATE sale_items SET product_id = ${world.products.shopP} WHERE sale_id = ${world.sales.dialog}`)), PRODUCTS);
    refused(damaged((db) => db.exec(`UPDATE sale_items SET product_id = ${world.products.dd} WHERE sale_id = (SELECT MIN(id) FROM sales WHERE book = 'shop')`)), PRODUCTS);
  });
});

describe('reload, EZCash and top-up records carry the segment of their provider', () => {
  it('a reload of Dialog booked in another provider\'s reloads, in a wrong-provider reload of its own kind', () => {
    refused(damaged((db) => db.exec(`UPDATE reload_sales SET segment = 'airtel_reloads' WHERE id = ${world.records.reloadDialog}`)), PROVIDER);
    refused(damaged((db) => db.exec(`UPDATE reload_sales SET segment = 'dialog_reloads' WHERE id = ${world.records.reloadHutch}`)), PROVIDER);
  });
  it('an EZCash sale outside Dialog Reloads', () => {
    refused(damaged((db) => db.exec(`UPDATE ezcash_sales SET segment = 'mobitel_reloads' WHERE id = ${world.records.ezcash}`)), PROVIDER);
  });
  it('a provider top-up outside its provider\'s reloads; a wallet top-up outside Dialog Reloads', () => {
    refused(damaged((db) => db.exec(`UPDATE telecom_topups SET segment = 'dialog_reloads' WHERE id = ${world.records.topupMobitel}`)), PROVIDER);
    refused(damaged((db) => db.exec(`UPDATE telecom_topups SET segment = 'mobitel_reloads' WHERE id = ${world.records.topupWallet}`)), PROVIDER);
  });
  it('a reload made legacy while its provider is known and its cash entry is a real segment', () => {
    refused(damaged((db) => db.exec(`UPDATE reload_sales SET segment = 'legacy' WHERE id = ${world.records.reloadMobitel}`)), OWNER);
  });
});

describe('one opening balance per scope', () => {
  it('a second posted opening balance in the same book and segment is refused (the unique index is removed in the copy only)', () => {
    const r = refused(damaged((db) => {
      db.exec('DROP INDEX ux_capital_opening_balance');
      const cols = (db.prepare('PRAGMA table_info(capital_entries)').all() as { name: string }[]).map((c) => c.name).filter((c) => c !== 'id');
      const list = cols.map((c) => (c === 'client_ref' ? "'dup-opening-balance-1'" : `"${c}"`)).join(', ');
      db.exec(`INSERT INTO capital_entries (${cols.map((c) => `"${c}"`).join(', ')})
        SELECT ${list} FROM capital_entries WHERE kind = 'opening_balance' AND status = 'posted' AND segment = 'mobitel_cards'`);
    }), OPENING);
    expect(r.failures.find((f) => OPENING.test(f.message))!.detail).toMatch(/telecom \/ mobitel_cards: 2 opening balances/);
  });
  it('two openings for the same segment are fine when one of them is voided; Shop and the other segments are separate scopes', () => {
    expect(verdict(base).failures).toEqual([]);
    const db = new DatabaseSync(base, { readOnly: true });
    try {
      const n = Number(Object.values(db.prepare("SELECT COUNT(*) FROM capital_entries WHERE kind = 'opening_balance' AND status = 'posted'").get() as Record<string, unknown>)[0]);
      expect(n).toBeGreaterThanOrEqual(8);
    } finally { db.close(); }
  });
});

describe('the collections of a segment equal its reload and EZCash records', () => {
  it('a reload record whose amount was edited after the cash was posted', () => {
    const r = refused(damaged((db) => db.exec(`UPDATE reload_sales SET sales_cents = sales_cents + 100 WHERE id = ${world.records.reloadDialog}`)), COLLECTIONS);
    expect(r.failures.find((f) => COLLECTIONS.test(f.message))!.detail).toMatch(/dialog_reloads: cash 100000 but reload sales total 100100/);
  });
  it('an EZCash record whose amount was edited', () => {
    refused(damaged((db) => db.exec(`UPDATE ezcash_sales SET bill_total_cents = bill_total_cents - 50 WHERE id = ${world.records.ezcash}`)), COLLECTIONS);
  });
  it('a reload collection entry that was deleted from the ledger of one segment', () => {
    refused(damaged((db) => db.exec(`DELETE FROM cash_entries WHERE ref_table = 'reload_sales' AND ref_id = ${world.records.reloadHutch} AND reverses_entry_id IS NULL`)), COLLECTIONS);
  });
});

describe('a product keeps its segment: its category\'s provider must not change after it has stock history', () => {
  it('the provider of a card category changed after the products were bought and sold', () => {
    const r = refused(damaged((db) => db.exec(`UPDATE categories SET provider_id = (SELECT id FROM reload_providers WHERE name = 'Hutch') WHERE name = 'Mobitel Cards'`)), HISTORY);
    expect(r.failures.find((f) => HISTORY.test(f.message))!.detail).toMatch(/product \d+/);
    expect(segMessages(r).some((m) => PRODUCTS.test(m))).toBe(true);
  });
  it('a product moved to another provider\'s category (the lock trigger lifted in the copy)', () => {
    refused(damaged((db) => db.exec(`UPDATE products SET category_id = (SELECT id FROM categories WHERE name = 'Dialog Cards') WHERE id = ${world.products.mm}`)), HISTORY);
  });
});

describe('every failure is a plain sentence, and the failed checks are listed', () => {
  it('two different segment problems give two failures of the same check, both in words', () => {
    const r = verdict(damaged((db) => {
      db.exec("UPDATE reload_sales SET segment = 'airtel_reloads' WHERE id = (SELECT MIN(id) FROM reload_sales)");
      db.exec("UPDATE expenses SET segment = NULL WHERE id = (SELECT MIN(id) FROM expenses WHERE book = 'telecom')");
    }));
    expect(r.ok).toBe(false);
    const msgs = segMessages(r);
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    for (const m of msgs) { expect(m).toMatch(/^The Telecom segments in the file are inconsistent: /); expect(m).toMatch(/\(\d+ records?\)\.$/); }
  });
});
