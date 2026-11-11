// Phase 5 persistence and restore - API level with real temp data folders.
// Protects the owner's confidence that sales, their lines (with the frozen cost snapshot), returns, damaged-return losses, voids, stock
// movements, cash entries, audit rows and the clientRef idempotency keys all survive a restart of the app, that returns and voids keep
// working afterwards, and that backups restore correctly: a version-5 backup (before Phase 5) is upgraded to version 6 and Phase 5
// works on it; a version-6 backup brings back exactly the sales that existed when it was taken and discards later changes.
// Organised as: reopen the app on the same folder, then restore scenarios.
// Money in cents; hand calculations are in the comments.

import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';
import { count, get, post } from './helpers/catalog.ts';
import { apiBase, daysAgo, mkProduct, mkTelecom, today } from './helpers/inventory.ts';
import { num, poolOf, reconOk, sql } from './helpers/phase4.ts';
import { cl, lossRows, returnNew, returnOk, rl, sellOk, stocked, voidSaleNew } from './helpers/phase5.ts';
import { createBackup } from '../services/backup.service.ts';
import { latestVersion, loadMigrations, migrate, MIGRATIONS_DIR } from '../db/migrate.ts';

const env = new TestEnv();
afterEach(() => env.cleanup());
const shop0 = (s: Parameters<typeof mkProduct>[0], o: Record<string, unknown> = {}) => mkProduct(s, { minPriceCents: 0, ...o });
const tel0 = (s: Parameters<typeof mkProduct>[0], o: Record<string, unknown> = {}) => mkTelecom(s, { minPriceCents: 0, ...o });

// Close the app, open it again on the same data folder, and compare.
describe('persistence across app reopen', () => {
  // Hand calculation: A 10 / 10,000 (avg 1,000), T 100 / 50,000 (avg 500).
  //  Mixed cart (clientRef persist-cart-001): A 4 @ 1,500 (rev 6,000, cogs 4,000), T 10 @ 600 (rev 6,000, cogs 5,000) -> A 6/6,000, T 90/45,000.
  //  Return on the shop sale: 1 resalable (rev 1,500, cogs 1,000), 1 damaged (rev 1,500, cogs 1,000) -> A 7/7,000, one loss of 1,000.
  //  Second cart (T 5 @ 600) voided -> T back to 90 / 45,000.
  //  After reopen: the final return of the line (2 units) takes the remainder: rev 3,000, cogs 2,000.
  it('sales, returns, damaged loss, voids, movements, cash, audit and idempotency keys survive; returns/voids keep working', async () => {
    const first = await env.build();
    const s1 = await apiBase(first);
    const A = await stocked(s1, shop0, 10, 10000, { name: 'Keep A' });
    const T = await stocked(s1, tel0, 100, 50000, { name: 'Keep T' });
    const cartBody = { businessDate: today(), items: [cl(A.id, 4, 1500), cl(T.id, 10, 600)], clientRef: 'persist-cart-001' };
    const cart = await post(s1.app, '/sales', cartBody);
    expect(cart.status).toBe(201);
    const [shop, tel] = cart.body.sales;
    const ret = (await returnOk(s1, shop.id, [rl(shop.items[0].id, 1, true)], { clientRef: 'persist-ret-0001' })).item;
    const ret2 = (await returnOk(s1, shop.id, [rl(shop.items[0].id, 1, false)], { clientRef: 'persist-ret-0002' })).item;
    const voidMe = (await sellOk(s1, [cl(T.id, 5, 600)], { clientRef: 'persist-void-001', businessDate: daysAgo(2) })).sales[0];
    await voidSaleNew(s1, voidMe.id, 'wrong');
    expect(poolOf(s1, A.id)).toEqual({ qty: 7, value: 7000 });
    expect(poolOf(s1, T.id)).toEqual({ qty: 90, value: 45000 });

    const lists = {
      sales: (await get(s1.app, '/sales')).body,
      one: (await get(s1.app, `/sales/${shop.id}`)).body,
      losses: (await get(s1.app, '/stock-losses')).body,
      val: (await get(s1.app, '/inventory/valuation?includeZero=true')).body,
      mv: sql(s1, 'SELECT * FROM stock_movements ORDER BY id'),
      cash: sql(s1, 'SELECT * FROM cash_entries ORDER BY id'),
    };
    const audit = count(s1.ctx, 'audit_logs');
    expect(lists.one.item.items[0].returnedQty).toBe(2);
    await first.app.close();

    const second = await env.build({ dataDir: first.dataDir });
    const s2 = await apiBase(second);
    expect((await get(s2.app, '/sales')).body).toEqual(lists.sales);
    expect((await get(s2.app, `/sales/${shop.id}`)).body).toEqual(lists.one);
    expect((await get(s2.app, '/stock-losses')).body).toEqual(lists.losses);
    expect((await get(s2.app, '/inventory/valuation?includeZero=true')).body).toEqual(lists.val);
    expect(sql(s2, 'SELECT * FROM stock_movements ORDER BY id')).toEqual(lists.mv);
    expect(sql(s2, 'SELECT * FROM cash_entries ORDER BY id')).toEqual(lists.cash);
    expect(count(s2.ctx, 'audit_logs')).toBe(audit);
    expect((await get(s2.app, '/health')).body.schemaVersion).toBe(latestVersion());
    await reconOk(s2);

    // idempotency keys persist: repeats are 200 and write nothing
    const written = [num(s2, 'SELECT COUNT(*) FROM stock_movements'), num(s2, 'SELECT COUNT(*) FROM cash_entries'), count(s2.ctx, 'audit_logs'), num(s2, 'SELECT COUNT(*) FROM stock_losses')];
    const again = await post(s2.app, '/sales', cartBody);
    expect([again.status, again.body.sales.map((x: any) => x.id)]).toEqual([200, [shop.id, tel.id]]);
    const againRet = await returnNew(s2, shop.id, [rl(shop.items[0].id, 1, true)], { clientRef: 'persist-ret-0001' });
    expect([againRet.status, againRet.body.item.id]).toEqual([200, ret.id]);
    const againRet2 = await returnNew(s2, shop.id, [rl(shop.items[0].id, 1, false)], { clientRef: 'persist-ret-0002' });
    expect([againRet2.status, againRet2.body.item.id]).toEqual([200, ret2.id]);
    expect([num(s2, 'SELECT COUNT(*) FROM stock_movements'), num(s2, 'SELECT COUNT(*) FROM cash_entries'), count(s2.ctx, 'audit_logs'), num(s2, 'SELECT COUNT(*) FROM stock_losses')]).toEqual(written);

    // the C5 remainder still works across the restart: returns so far took 1,500 + 1,500 and 1,000 + 1,000; the last 2 units take the rest
    const last = await returnOk(s2, shop.id, [rl(shop.items[0].id, 2, true)]);
    expect(last.item.items[0]).toMatchObject({ revenueCents: 3000, cogsCents: 2000 });
    expect(poolOf(s2, A.id)).toEqual({ qty: 9, value: 9000 });
    // the sale with returns still cannot be voided; the telecom sale can
    expect((await voidSaleNew(s2, shop.id)).status).toBe(409);
    expect((await voidSaleNew(s2, tel.id)).status).toBe(200);
    expect(poolOf(s2, T.id)).toEqual({ qty: 100, value: 50000 });
    // the damaged-return loss kept its link
    expect(lossRows(s2)).toHaveLength(1);
    expect(lossRows(s2)[0]).toMatchObject({ source: 'damaged_return', sales_return_id: ret2.id, cost_cents: 1000 });
    await reconOk(s2);
  });
});

// =============================================================================================
// Restoring backups taken at different schema versions.
describe('restore', () => {
  // A backup made before Phase 5 has none of the Phase 5 tables (and no stock_losses.sales_return_id); after the restore they are created by
  // migration, old data is intact, and a sale, a damaged return and its loss work on the legacy product.
  // Hand calculation: legacy product 10 units / 3,000 (avg 300). Sell 4 @ 1,000: revenue 4,000, COGS 1,200, pool 6 / 1,800.
  // Damaged return of 1: revenue 1,000, COGS 300 -> one loss of 300, pool unchanged 6 / 1,800.
  it('restoring a version-5 backup migrates it to version 6 and Phase 5 works on it', async () => {
    const b = await env.build();
    const s = await apiBase(b);
    const dir = env.newDir();
    const mdir = join(dir, 'mig');
    mkdirSync(mdir, { recursive: true });
    for (const f of loadMigrations().filter((m) => m.version <= 5)) copyFileSync(join(MIGRATIONS_DIR, f.name), join(mdir, f.name));
    const v5 = join(dir, 'v5.db');
    const c = new DatabaseSync(v5);
    try {
      c.exec('PRAGMA foreign_keys = ON');
      c.exec('PRAGMA journal_mode = DELETE');
      expect(migrate(c, mdir).version).toBe(5);
      const cat = Number((c.prepare("SELECT id FROM categories WHERE name = 'Other'").get() as any).id);
      c.prepare(`INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents) VALUES ('Legacy5', ?, 'stock', 'shop', 1000, 500)`).run(cat);
      const pid = Number((c.prepare("SELECT id FROM products WHERE name = 'Legacy5'").get() as any).id);
      c.prepare("INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, reason) VALUES (?, ?, 'purchase', 10, 3000, 'legacy')").run(pid, daysAgo(3));
      c.prepare("INSERT INTO stock_losses (business_date, product_id, book, qty, cost_cents, reason, client_ref) VALUES (?, ?, 'shop', 1, 100, 'lost', 'legacy-loss-0001')").run(daysAgo(3), pid);
      expect(c.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sales'").get()).toEqual({ n: 0 });
    } finally { c.close(); }

    const name = 'viman-20250303-000000-manual.db';
    copyFileSync(v5, join(dirname(s.ctx.database.filePath), 'backups', name));
    const res = await post(s.app, '/backups/restore', { name, confirm: 'RESTORE' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.schemaVersion).toBe(latestVersion());
    expect(latestVersion()).toBeGreaterThanOrEqual(6);
    const tables = sql(s, "SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['sales', 'sale_items', 'sales_returns', 'sales_return_items']));
    expect(sql(s, 'PRAGMA table_info(stock_losses)').map((x) => x.name)).toContain('sales_return_id');

    const prod = (await get(s.app, '/products?q=Legacy5')).body.items[0];
    expect(prod).toMatchObject({ qtyOnHand: 10, stockValueCents: 3000 });
    // the legacy manual loss is visible with the new field
    const legacy = (await get(s.app, '/stock-losses')).body.items[0];
    expect(legacy).toMatchObject({ source: 'manual', salesReturnId: null, costCents: 100 });
    // Phase 5 writes work on the migrated database
    const sale = (await sellOk(s, [cl(prod.id, 4, 1000)])).sales[0];
    expect(sale).toMatchObject({ totalCents: 4000, cogsCents: 1200 });
    expect(poolOf(s, prod.id)).toEqual({ qty: 6, value: 1800 });
    const r = await returnOk(s, sale.id, [rl(sale.items[0].id, 1, false)]);
    expect(r.item).toMatchObject({ refundCents: 1000, cogsReversedCents: 300 });
    expect(lossRows(s).map((l) => [l.source, l.cost_cents, l.sales_return_id])).toEqual([['manual', 100, null], ['damaged_return', 300, r.item.id]]);
    expect(poolOf(s, prod.id)).toEqual({ qty: 6, value: 1800 });
    await reconOk(s);
  });

  // Backup taken after one sale (pool 8 / 8,000 for 10 / 10,000 minus 2): later changes (a return, a second sale, a void) must disappear.
  // After the restore the sale is posted with no returns, so it can be voided: stock returns to 10 / 10,000.
  it('a version-6 backup keeps sales and discards later returns, sales and voids', async () => {
    const b = await env.build();
    const s = await apiBase(b);
    const P = await stocked(s, shop0, 10, 10000, { name: 'Backup item' });
    const sale = (await sellOk(s, [cl(P.id, 2, 1500)], { clientRef: 'backup-sale-001' })).sales[0];
    const backup = createBackup(s.ctx, 'manual', new Date('2026-03-01T00:00:00Z'));
    // later changes that the restore must discard
    await returnOk(s, sale.id, [rl(sale.items[0].id, 1, false)]);
    const other = (await sellOk(s, [cl(P.id, 1, 1500)])).sales[0];
    await voidSaleNew(s, other.id);
    expect(num(s, 'SELECT COUNT(*) FROM sales_returns')).toBe(1);
    expect(num(s, 'SELECT COUNT(*) FROM sales')).toBe(2);

    const res = await post(s.app, '/backups/restore', { name: backup.name, confirm: 'RESTORE' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(num(s, 'SELECT COUNT(*) FROM sales_returns')).toBe(0);
    expect(num(s, 'SELECT COUNT(*) FROM sales')).toBe(1);
    expect(num(s, 'SELECT COUNT(*) FROM stock_losses')).toBe(0);
    expect(poolOf(s, P.id)).toEqual({ qty: 8, value: 8000 });
    expect((await get(s.app, `/sales/${sale.id}`)).body.item).toEqual(sale);
    await reconOk(s);
    // idempotency key of the surviving sale still works; the sale can be voided now
    expect((await post(s.app, '/sales', { businessDate: today(), items: [cl(P.id, 2, 1500)], clientRef: 'backup-sale-001' })).status).toBe(200);
    expect((await voidSaleNew(s, sale.id)).status).toBe(200);
    expect(poolOf(s, P.id)).toEqual({ qty: 10, value: 10000 });
    await reconOk(s);
  });
});
