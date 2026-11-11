import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';
import { count, get, post } from './helpers/catalog.ts';
import { apiBase, buy, daysAgo, mkProduct, mkTelecom, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { drawNew, drawVoid, lossNew, lossVoid, mvs, num, poolOf, reconOk, sql, stComplete, stDraft, stNew, stVoid } from './helpers/phase4.ts';
import { createBackup } from '../services/backup.service.ts';
import { latestVersion, loadMigrations, migrate, MIGRATIONS_DIR } from '../db/migrate.ts';

const env = new TestEnv();
afterEach(() => env.cleanup());

const bl = (productId: number, units: number, lineTotalCents: number) => ({ productId, packs: 1, packSize: units, lineTotalCents });

describe('persistence across app reopen', () => {
  it('stocktakes (draft / completed / void), losses, drawings, movements, audit and idempotency keys survive; drafts stay usable', async () => {
    const first = await env.build();
    const s1 = await apiBase(first);
    const A = await mkProduct(s1, { name: 'Keep A' });
    const T = await mkTelecom(s1, { name: 'Keep T' });
    await buy(s1, [bl(A.id, 10, 300000)]);
    await buy(s1, [bl(A.id, 10, 400000)]);
    await buy(s1, [bl(T.id, 10, 50000)]);
    const done = await stDraft(s1, [{ productId: A.id, countedQty: 17 }], { businessDate: daysAgo(2), clientRef: 'persist-st-done1' });
    await stComplete(s1, done.id);                                              // loss 105000 -> 17/595000
    const voided = await stDraft(s1, [{ productId: T.id, countedQty: 5 }], { book: 'telecom' });
    await stComplete(s1, voided.id);                                            // loss 25000
    await stVoid(s1, voided.id, 'wrong');
    const draft = await stDraft(s1, [{ productId: A.id, countedQty: 12 }], { clientRef: 'persist-st-draft' });
    const loss = (await lossNew(s1, A.id, 2, { clientRef: 'persist-loss-001' })).body.item;   // 70000 -> 15/525000
    const loss2 = (await lossNew(s1, T.id, 1, { reason: 'expired' })).body.item;
    await lossVoid(s1, loss2.id);
    const dr = (await drawNew(s1, A.id, 1, { clientRef: 'persist-draw-001' })).body.item;     // 35000 -> 14/490000
    const dr2 = (await drawNew(s1, T.id, 1)).body.item;
    await drawVoid(s1, dr2.id);

    const lists = {
      st: (await get(s1.app, '/stocktakes')).body,
      loss: (await get(s1.app, '/stock-losses')).body,
      draw: (await get(s1.app, '/drawings')).body,
      val: (await get(s1.app, '/inventory/valuation?includeZero=true')).body,
      mv: sql(s1, 'SELECT * FROM stock_movements ORDER BY id'),
    };
    const audit = count(s1.ctx, 'audit_logs');
    expect(poolOf(s1, A.id)).toEqual({ qty: 14, value: 490000 });
    await first.app.close();

    const second = await env.build({ dataDir: first.dataDir });
    const s2 = await apiBase(second);
    expect((await get(s2.app, '/stocktakes')).body).toEqual(lists.st);
    expect((await get(s2.app, '/stock-losses')).body).toEqual(lists.loss);
    expect((await get(s2.app, '/drawings')).body).toEqual(lists.draw);
    expect((await get(s2.app, '/inventory/valuation?includeZero=true')).body).toEqual(lists.val);
    expect(sql(s2, 'SELECT * FROM stock_movements ORDER BY id')).toEqual(lists.mv);
    expect(count(s2.ctx, 'audit_logs')).toBe(audit);
    expect((await get(s2.app, '/health')).body.schemaVersion).toBe(latestVersion());
    await reconOk(s2);

    // idempotency keys persist: repeats are 200 and write nothing
    const movs = num(s2, 'SELECT COUNT(*) FROM stock_movements');
    const rl = await post(s2.app, '/stock-losses', { businessDate: today(), productId: A.id, qty: 9, reason: 'lost', clientRef: 'persist-loss-001' });
    expect([rl.status, rl.body.item.id]).toEqual([200, loss.id]);
    const rd = await post(s2.app, '/drawings', { kind: 'goods', businessDate: today(), productId: A.id, qty: 9, clientRef: 'persist-draw-001' });
    expect([rd.status, rd.body.item.id]).toEqual([200, dr.id]);
    const rs = await stNew(s2, { clientRef: 'persist-st-done1', book: 'shop', items: [] });
    expect([rs.status, rs.body.item.id, rs.body.item.status]).toEqual([200, done.id, 'completed']);
    expect(num(s2, 'SELECT COUNT(*) FROM stock_movements')).toBe(movs);

    // the open draft is live against the current pool and can still be completed
    const d = (await get(s2.app, `/stocktakes/${draft.id}`)).body.item;
    expect(d.items[0]).toMatchObject({ expectedQty: 14, differenceQty: -2, valueDeltaCents: null });
    expect((await stComplete(s2, draft.id)).status).toBe(200);                      // loss 2 = 490000*2/14 = 70000
    expect(poolOf(s2, A.id)).toEqual({ qty: 12, value: 420000 });
    // a void after reopen still reverses exactly
    expect((await stVoid(s2, done.id)).status).toBe(200);                           // +3 / +105000
    expect(poolOf(s2, A.id)).toEqual({ qty: 15, value: 525000 });
    expect((await lossVoid(s2, loss.id)).status).toBe(200);                         // +2 / +70000
    expect(poolOf(s2, A.id)).toEqual({ qty: 17, value: 595000 });
    await reconOk(s2);
  });
});

// =============================================================================================
describe('restore', () => {
  it('restoring a version-4 backup migrates it to the latest schema and Phase 4 works on it', async () => {
    const b = await env.build();
    const s: ApiBase = await apiBase(b);
    const dir = env.newDir();
    const mdir = join(dir, 'mig');
    mkdirSync(mdir, { recursive: true });
    for (const f of loadMigrations().filter((m) => m.version <= 4)) copyFileSync(join(MIGRATIONS_DIR, f.name), join(mdir, f.name));
    const v4 = join(dir, 'v4.db');
    const c = new DatabaseSync(v4);
    try {
      c.exec('PRAGMA foreign_keys = ON');
      c.exec('PRAGMA journal_mode = DELETE');
      expect(migrate(c, mdir).version).toBe(4);
      const cat = Number((c.prepare("SELECT id FROM categories WHERE name = 'Other'").get() as any).id);
      c.prepare(`INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents) VALUES ('Legacy4', ?, 'stock', 'shop', 1000, 500)`).run(cat);
      const pid = Number((c.prepare("SELECT id FROM products WHERE name = 'Legacy4'").get() as any).id);
      c.prepare("INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, reason) VALUES (?, ?, 'purchase', 10, 3000, 'legacy')").run(pid, daysAgo(3));
      expect(c.prepare('SELECT qty_on_hand AS q, stock_value_cents AS v FROM products WHERE id = ?').get(pid)).toEqual({ q: 10, v: 3000 });
      expect(c.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'stocktakes'").get()).toEqual({ n: 0 });
    } finally { c.close(); }

    const name = 'viman-20250202-000000-manual.db';
    copyFileSync(v4, join(dirname(s.ctx.database.filePath), 'backups', name));
    const res = await post(s.app, '/backups/restore', { name, confirm: 'RESTORE' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.schemaVersion).toBe(latestVersion());
    expect(latestVersion()).toBeGreaterThanOrEqual(5);
    const tables = sql(s, "SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['stocktakes', 'stocktake_items', 'stock_losses', 'owner_drawings']));

    const prod = (await get(s.app, '/products?q=Legacy4')).body.items[0];
    expect(prod).toMatchObject({ qtyOnHand: 10, stockValueCents: 3000 });
    // valuation as of before / after the legacy movement
    const v = (await get(s.app, `/inventory/valuation?asOf=${daysAgo(2)}`)).body;
    expect(v.items[0]).toMatchObject({ name: 'Legacy4', qty: 10, valueCents: 3000, avgUnitCostCents: 300 });
    expect((await get(s.app, `/inventory/valuation?asOf=${daysAgo(4)}`)).body.items).toEqual([]);
    // Phase 4 writes work on the migrated database
    const d = await stDraft(s, [{ productId: prod.id, countedQty: 8 }]);
    expect((await stComplete(s, d.id)).status).toBe(200);                           // loss 2 = 600
    expect((await lossNew(s, prod.id, 3)).body.item.costCents).toBe(900);           // 2400*3/8
    expect((await drawNew(s, prod.id, 5)).body.item.amountCents).toBe(1500);        // all 5 left: 1500
    expect(poolOf(s, prod.id)).toEqual({ qty: 0, value: 0 });
    await reconOk(s);
  });

  it('a version-5 backup keeps stocktakes, losses and drawings when restored over newer changes', async () => {
    const b = await env.build();
    const s = await apiBase(b);
    const P = await mkProduct(s, { name: 'Backup item' });
    await buy(s, [bl(P.id, 10, 300000)]);
    const st = await stDraft(s, [{ productId: P.id, countedQty: 9 }]);
    await stComplete(s, st.id);                                                     // 9 / 270000
    const loss = (await lossNew(s, P.id, 1)).body.item;                             // 30000 -> 8 / 240000
    const backup = createBackup(s.ctx, 'manual', new Date('2026-03-01T00:00:00Z'));
    // later changes that the restore must discard
    await drawNew(s, P.id, 2);
    await stVoid(s, st.id, 'later');
    expect(num(s, 'SELECT COUNT(*) FROM owner_drawings')).toBe(1);

    const res = await post(s.app, '/backups/restore', { name: backup.name, confirm: 'RESTORE' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(num(s, 'SELECT COUNT(*) FROM owner_drawings')).toBe(0);
    expect(poolOf(s, P.id)).toEqual({ qty: 8, value: 240000 });
    expect((await get(s.app, `/stocktakes/${st.id}`)).body.item.status).toBe('completed');
    expect((await get(s.app, `/stock-losses/${loss.id}`)).body.item).toMatchObject({ status: 'posted', costCents: 30000 });
    expect(mvs(s).length).toBe(3);
    await reconOk(s);
    // and the restored database still accepts Phase 4 writes
    expect((await stVoid(s, st.id)).status).toBe(200);
    expect(poolOf(s, P.id)).toEqual({ qty: 9, value: 270000 });
  });
});
