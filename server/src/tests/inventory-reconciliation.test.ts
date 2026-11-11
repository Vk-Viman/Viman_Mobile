import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';
import { count, get, post } from './helpers/catalog.ts';
import {
  apiBase, buy, cashRows, daysAgo, mkProduct, mkSupplier, mkTelecom, productOf, ref, today,
} from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { issueStock, reconcileStock } from '../services/inventory.service.ts';
import { latestVersion, loadMigrations, migrate, MIGRATIONS_DIR } from '../db/migrate.ts';

const env = new TestEnv();
afterEach(() => env.cleanup());

const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const line = (productId: number, packs: number, packSize: number, lineTotalCents: number) => ({ productId, packs, packSize, lineTotalCents });
const err = (r: { body: any }) => r.body.error;
const sql = (s: ApiBase, q: string, ...p: any[]) => s.ctx.database.conn.prepare(q).all(...p) as unknown as Array<Record<string, any>>;
const engineSell = (s: ApiBase, productId: number, qty: number) =>
  s.ctx.database.tx((c) => issueStock(c, { productId, businessDate: today(), type: 'sale', qty, refTable: null, refId: null, reason: 'test' }));
const valueMove = (s: ApiBase, productId: number, delta: number) =>
  s.ctx.database.conn.prepare(
    "INSERT INTO stock_movements (product_id, business_date, type, qty_delta, value_delta_cents, reason) VALUES (?, ?, 'adjustment', 0, ?, 'test')",
  ).run(productId, today(), delta);
const ret = (s: ApiBase, purchaseId: number, items: Array<{ purchaseItemId: number; units: number }>, over: Record<string, unknown> = {}) =>
  post(s.app, `/purchases/${purchaseId}/returns`, { businessDate: today(), clientRef: ref(), items, ...over });
const voidP = (s: ApiBase, id: number) => post(s.app, `/purchases/${id}/void`, { reason: 'test' });

// =============================================================================================
describe('GET /inventory/reconciliation', () => {
  it('empty database: ok with zero products', async () => {
    const s = await setup();
    const r = await get(s.app, '/inventory/reconciliation');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, checkedProducts: 0, mismatches: [] });
  });

  it('products without movements reconcile (0/0), services included in checkedProducts', async () => {
    const s = await setup();
    await mkProduct(s); await mkProduct(s, { kind: 'service' });
    expect((await get(s.app, '/inventory/reconciliation')).body).toEqual({ ok: true, checkedProducts: 2, mismatches: [] });
  });

  async function mixedScenario() {
    const s = await setup();
    const a = await mkProduct(s); const b = await mkProduct(s); const c = await mkProduct(s); const t = await mkTelecom(s, { kind: 'stock' });
    await mkProduct(s, { kind: 'service' });
    const sup = await mkSupplier(s);
    const A1 = await buy(s, [line(a.id, 1, 10, 300000), line(b.id, 2, 5, 400000)], { supplierId: sup.id });
    const A2 = await buy(s, [line(a.id, 1, 10, 400000)], { businessDate: daysAgo(3) });
    const A3 = await buy(s, [line(c.id, 1, 3, 100000)]);
    const A4 = await buy(s, [line(t.id, 1, 20, 7000)]);
    expect((await ret(s, A1.id, [{ purchaseItemId: A1.items[0].id, units: 3 }])).status).toBe(201);
    expect((await ret(s, A3.id, [{ purchaseItemId: A3.items[0].id, units: 1 }])).status).toBe(201);
    engineSell(s, a.id, 2);
    engineSell(s, b.id, 4);
    expect((await voidP(s, A4.id)).status).toBe(200);
    // a sweep: value-only +2500 on c then return the rest
    valueMove(s, c.id, 2500);
    expect((await ret(s, A3.id, [{ purchaseItemId: A3.items[0].id, units: 2 }])).status).toBe(201);
    expect((await voidP(s, A2.id)).status).toBe(200);
    return { s, a, b, c, t };
  }

  it('is ok after a mixed scenario: purchases, returns, void, engine sales, sweep', async () => {
    const { s, a, b, c, t } = await mixedScenario();
    const r = await get(s.app, '/inventory/reconciliation');
    expect(r.body).toEqual({ ok: true, checkedProducts: 5, mismatches: [] });
    // a: A1 10/300000 + A2 10/400000 = 20/700000; return 3 of A1 (refund 90000) -> 17/610000;
    // sale 2 -> round(610000*2/17)=71765 -> 15/538235; void A2 (10 units, cost 400000) -> 5/138235
    expect(await productOf(s, a.id)).toMatchObject({ qtyOnHand: 5, stockValueCents: 138235 });
    // b: 10/400000, return... A1 item0 is product a only; b: sale 4 -> 160000 -> 6/240000
    expect(await productOf(s, b.id)).toMatchObject({ qtyOnHand: 6, stockValueCents: 240000 });
    // c: 3/100000, return 1 -> 33333 -> 2/66667; +2500 -> 2/69167; return 2 (refund 66667): sweep 2500 then -66667 -> 0/0
    expect(await productOf(s, c.id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0 });
    expect(await productOf(s, t.id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0 });
    const cm = sql(s, 'SELECT type, qty_delta, value_delta_cents FROM stock_movements WHERE product_id = ? ORDER BY id', c.id)
      .map((m) => [m.type, Number(m.qty_delta), Number(m.value_delta_cents)]);
    expect(cm).toEqual([
      ['purchase', 3, 100000], ['purchase_return', -1, -33333], ['adjustment', 0, 2500],
      ['adjustment', 0, -2500], ['purchase_return', -2, -66667],
    ]);
  });

  it('reports an exact mismatch when the quantity cache is tampered with', async () => {
    const { s, a } = await mixedScenario();
    s.ctx.database.conn.prepare('UPDATE products SET qty_on_hand = qty_on_hand + 1 WHERE id = ?').run(a.id);
    const r = await get(s.app, '/inventory/reconciliation');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.checkedProducts).toBe(5);
    expect(r.body.mismatches).toEqual([{
      productId: a.id, name: a.name, cacheQty: 6, movementQty: 5, cacheValueCents: 138235, movementValueCents: 138235,
    }]);
  });

  it('reports value tampering, and several products at once; ok again after restoring the cache', async () => {
    const { s, a, b } = await mixedScenario();
    const conn = s.ctx.database.conn;
    conn.prepare('UPDATE products SET stock_value_cents = stock_value_cents - 7 WHERE id = ?').run(b.id);
    conn.prepare('UPDATE products SET qty_on_hand = 100, stock_value_cents = 5 WHERE id = ?').run(a.id);
    const r = await get(s.app, '/inventory/reconciliation');
    expect(r.body.ok).toBe(false);
    const m = [...r.body.mismatches].sort((x: any, y: any) => x.productId - y.productId);
    expect(m).toEqual([
      { productId: a.id, name: a.name, cacheQty: 100, movementQty: 5, cacheValueCents: 5, movementValueCents: 138235 },
      { productId: b.id, name: b.name, cacheQty: 6, movementQty: 6, cacheValueCents: 239993, movementValueCents: 240000 },
    ]);
    conn.prepare('UPDATE products SET qty_on_hand = 5, stock_value_cents = 138235 WHERE id = ?').run(a.id);
    conn.prepare('UPDATE products SET stock_value_cents = 240000 WHERE id = ?').run(b.id);
    expect((await get(s.app, '/inventory/reconciliation')).body.ok).toBe(true);
  });

  it('a stock product with a cache but no movements is a mismatch', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    s.ctx.database.conn.prepare('UPDATE products SET qty_on_hand = 5, stock_value_cents = 100 WHERE id = ?').run(p.id);
    const r = await get(s.app, '/inventory/reconciliation');
    expect(r.body.mismatches).toEqual([{ productId: p.id, name: p.name, cacheQty: 5, movementQty: 0, cacheValueCents: 100, movementValueCents: 0 }]);
  });
});

// =============================================================================================
describe('GET /products/:id/movements', () => {
  it('posting order (newest first), shape, product block equals GET /products/:id', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const P1 = await buy(s, [line(p.id, 1, 10, 1000)]);
    engineSell(s, p.id, 2);
    await ret(s, P1.id, [{ purchaseItemId: P1.items[0].id, units: 1 }]);
    const r = await get(s.app, `/products/${p.id}/movements`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['items', 'product', 'total']);
    expect(r.body.total).toBe(3);
    expect(r.body.items.map((m: any) => m.type)).toEqual(['purchase_return', 'sale', 'purchase']);
    expect(r.body.items[0].id).toBeGreaterThan(r.body.items[1].id);
    expect(Object.keys(r.body.items[0]).sort()).toEqual([
      'businessDate', 'id', 'postedAt', 'productId', 'qtyDelta', 'reason', 'refId', 'refTable', 'type', 'unitCostCents', 'valueDeltaCents',
    ]);
    // sale of 2 from 10/1000 -> 200 (unit 100); return 1 of 10 -> refund 100, pool 8/800 -> 7/700
    expect(r.body.items[1]).toMatchObject({ type: 'sale', qtyDelta: -2, valueDeltaCents: -200, unitCostCents: 100, productId: p.id, refTable: null, refId: null });
    expect(r.body.items[2]).toMatchObject({ type: 'purchase', qtyDelta: 10, valueDeltaCents: 1000, unitCostCents: 100, refTable: 'purchases', refId: P1.id, businessDate: today() });
    expect(r.body.items[0]).toMatchObject({ type: 'purchase_return', qtyDelta: -1, valueDeltaCents: -100, refTable: 'purchase_returns' });
    expect(r.body.items[2].postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(r.body.product).toEqual(await productOf(s, p.id));
    expect(r.body.product).toMatchObject({ qtyOnHand: 7, stockValueCents: 700 });
  });

  it('product with no movements -> empty list; other products movements are not mixed in', async () => {
    const s = await setup();
    const p = await mkProduct(s); const q = await mkProduct(s);
    await buy(s, [line(q.id, 1, 2, 10)]);
    const r = await get(s.app, `/products/${p.id}/movements`);
    expect(r.body.items).toEqual([]);
    expect(r.body.total).toBe(0);
    expect((await get(s.app, `/products/${q.id}/movements`)).body.total).toBe(1);
  });

  it('a backdated purchase shows its business date but keeps its posting-order position', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const first = await buy(s, [line(p.id, 1, 1, 100)]);
    const old = await buy(s, [line(p.id, 1, 1, 200)], { businessDate: daysAgo(30) });
    const r = await get(s.app, `/products/${p.id}/movements`);
    expect(r.body.items.map((m: any) => [m.refId, m.businessDate])).toEqual([[old.id, daysAgo(30)], [first.id, today()]]);
    expect(r.body.items[0].postedAt >= r.body.items[1].postedAt).toBe(true);
    // business-date filters see it by its business date
    expect((await get(s.app, `/products/${p.id}/movements?to=${daysAgo(10)}`)).body.items.map((m: any) => m.refId)).toEqual([old.id]);
    expect((await get(s.app, `/products/${p.id}/movements?from=${daysAgo(10)}`)).body.items.map((m: any) => m.refId)).toEqual([first.id]);
  });

  it('filters: from/to inclusive, type, combined; paging with stable total', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const P1 = await buy(s, [line(p.id, 1, 10, 1000)], { businessDate: daysAgo(10) });
    await buy(s, [line(p.id, 1, 10, 1000)], { businessDate: daysAgo(5) });
    await ret(s, P1.id, [{ purchaseItemId: P1.items[0].id, units: 1 }], { businessDate: daysAgo(5) });
    engineSell(s, p.id, 1);
    const ids = (r: { body: any }) => r.body.items.map((m: any) => m.type);
    const url = (q: string) => `/products/${p.id}/movements?${q}`;
    expect(ids(await get(s.app, url('type=purchase')))).toEqual(['purchase', 'purchase']);
    expect(ids(await get(s.app, url('type=sale')))).toEqual(['sale']);
    expect(ids(await get(s.app, url('type=loss')))).toEqual([]);
    expect(ids(await get(s.app, url(`from=${daysAgo(5)}&to=${daysAgo(5)}`)))).toEqual(['purchase_return', 'purchase']);
    expect(ids(await get(s.app, url(`to=${daysAgo(6)}`)))).toEqual(['purchase']);
    expect(ids(await get(s.app, url(`from=${daysAgo(5)}&type=purchase`)))).toEqual(['purchase']);
    expect(ids(await get(s.app, url(`from=${today()}`)))).toEqual(['sale']);
    const page1 = await get(s.app, url('limit=2'));
    const page2 = await get(s.app, url('limit=2&offset=2'));
    expect([page1.body.total, page2.body.total]).toEqual([4, 4]);
    expect([...page1.body.items, ...page2.body.items].map((m: any) => m.type)).toEqual(ids(await get(s.app, url(''))));
    expect((await get(s.app, url('offset=9'))).body.items).toEqual([]);
    expect((await get(s.app, url('limit=200'))).status).toBe(200);
  });

  it('404 for an unknown product; 400 for bad params', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    const nf = await get(s.app, '/products/99999/movements');
    expect(nf.status).toBe(404);
    expect(err(nf).code).toBe('NOT_FOUND');
    for (const q of ['limit=0', 'limit=201', 'limit=x', 'offset=-1', 'type=bogus', 'from=abc', 'to=2026-02-31', 'from=2026-1-1', 'bogus=1']) {
      const r = await get(s.app, `/products/${p.id}/movements?${q}`);
      expect(r.status, q).toBe(400);
      expect(err(r).code, q).toBe('VALIDATION_ERROR');
    }
    expect((await get(s.app, '/products/abc/movements')).status).toBe(400);
  });
});

// =============================================================================================
describe('randomized sequence (seeded): model-checked pools, reconciliation, no negative stock', () => {
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /** Independent half-up division of (v * q) / n using BigInt. */
  const roundDiv = (v: number, q: number, n: number): number => Number((2n * BigInt(v) * BigInt(q) + BigInt(n)) / (2n * BigInt(n)));

  interface Pool { qty: number; value: number }
  interface PItem { id: number; productId: number; units: number; total: number; returned: number; ret?: number }
  interface PRec { id: number; book: string; offset: number; total: number; status: 'posted' | 'void'; items: PItem[] }

  it('300 operations of every kind keep the DB equal to an independent model', async () => {
    const s = await setup();
    const rnd = mulberry32(20261110);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

    const products = [await mkProduct(s), await mkProduct(s), await mkProduct(s), await mkTelecom(s, { kind: 'stock' }), await mkTelecom(s, { kind: 'stock' })];
    const bookOf = new Map<number, string>(products.map((p) => [p.id, p.book]));
    const model = new Map<number, Pool>(products.map((p) => [p.id, { qty: 0, value: 0 }]));
    const purchases: PRec[] = [];
    const cash = { shop: 0, telecom: 0 };
    const stats: Record<string, number> = {};
    const bump = (k: string) => { stats[k] = (stats[k] ?? 0) + 1; };

    const removeCapped = (productId: number, units: number, maxValue: number) => {
      const m = model.get(productId)!;
      const removed = Math.min(maxValue, m.value);
      m.qty -= units;
      m.value = m.qty === 0 ? 0 : m.value - removed; // value left with qty 0 is swept
    };

    const checkAll = (label: string) => {
      const rows = sql(s, 'SELECT id, qty_on_hand AS q, stock_value_cents AS v FROM products');
      for (const r of rows) {
        const m = model.get(Number(r.id))!;
        expect([Number(r.id), Number(r.q), Number(r.v)], label).toEqual([Number(r.id), m.qty, m.value]);
        expect(Number(r.q), label).toBeGreaterThanOrEqual(0);
        expect(Number(r.v), label).toBeGreaterThanOrEqual(0);
        expect(Number(r.q) === 0 ? Number(r.v) : 0, label).toBe(0);
      }
    };

    const OPS = 300;
    for (let i = 0; i < OPS; i++) {
      const roll = rnd();
      const label = `op ${i}`;
      if (roll < 0.38 || purchases.length === 0) {
        // ---- purchase
        const book = pick(['shop', 'telecom']);
        const pool = products.filter((p) => p.book === book);
        const nLines = int(1, 2);
        const lines = Array.from({ length: nLines }, () => line(pick(pool).id, int(1, 3), int(1, 5), rnd() < 0.1 ? 0 : int(1, 5000)));
        const offset = rnd() < 0.5 ? 0 : int(1, 20);
        const r = await post(s.app, '/purchases', { businessDate: daysAgo(offset), items: lines, clientRef: ref() });
        expect(r.status, label + JSON.stringify(r.body)).toBe(201);
        const it = r.body.item;
        for (const l of it.items) {
          const m = model.get(l.productId)!;
          m.qty += l.units; m.value += l.lineTotalCents;
        }
        cash[it.book as 'shop' | 'telecom'] -= it.totalCents;
        purchases.push({
          id: it.id, book: it.book, offset, total: it.totalCents, status: 'posted',
          items: it.items.map((l: any) => ({ id: l.id, productId: l.productId, units: l.units, total: l.lineTotalCents, returned: 0 })),
        });
        bump('purchase');
      } else if (roll < 0.58) {
        // ---- return
        const cands = purchases.filter((p) => p.status === 'posted' && p.items.some((it) => it.returned < it.units));
        if (cands.length === 0) continue;
        const pu = pick(cands);
        const open = pu.items.filter((it) => it.returned < it.units);
        const chosen = rnd() < 0.3 && open.length > 1 ? open : [pick(open)];
        const req = chosen.map((it) => ({ purchaseItemId: it.id, units: rnd() < 0.4 ? it.units - it.returned : int(1, it.units - it.returned) }));
        const date = daysAgo(int(0, pu.offset));
        const r = await ret(s, pu.id, req, { businessDate: date });
        if (r.status === 201) {
          const refund = r.body.item.refundCents as number;
          let sum = 0;
          for (const li of r.body.item.items as any[]) {
            const pi = pu.items.find((x) => x.id === li.purchaseItemId)!;
            // independent C7 check of the line value
            const proportional = roundDiv(pi.total, li.units, pi.units);
            const remainder = pi.total - sumReturned(pu, pi.id);
            const expected = pi.returned + li.units === pi.units ? remainder : proportional;
            expect(li.valueCents, label).toBe(expected);
            removeCapped(pi.productId, li.units, li.valueCents);
            pi.returned += li.units;
            pi.ret = (pi.ret ?? 0) + li.valueCents;
            sum += li.valueCents;
          }
          expect(refund, label).toBe(sum);
          cash[pu.book as 'shop' | 'telecom'] += refund;
          bump('return');
        } else {
          expect([422], label + JSON.stringify(r.body)).toContain(r.status);
          expect(err(r).code, label).toBe('INSUFFICIENT_STOCK');
          bump('return-rejected');
        }
      } else if (roll < 0.68) {
        // ---- void
        const pu = pick(purchases);
        const r = await voidP(s, pu.id);
        if (r.status === 200) {
          expect(pu.status, label).toBe('posted');
          expect(pu.items.every((it) => it.returned === 0), label).toBe(true);
          for (const it of pu.items) removeCapped(it.productId, it.units, it.total);
          pu.status = 'void';
          cash[pu.book as 'shop' | 'telecom'] += pu.total;
          bump('void');
          if (pu.total > 0) bump('void-paid'); // zero-total purchases have no cash entry to reverse
        } else {
          expect([409, 422], label + JSON.stringify(r.body)).toContain(r.status);
          expect(['ALREADY_VOID', 'HAS_RETURNS', 'INSUFFICIENT_STOCK'], label).toContain(err(r).code);
          bump('void-rejected');
        }
      } else if (roll < 0.93) {
        // ---- engine sale
        const p = pick(products);
        const m = model.get(p.id)!;
        if (m.qty === 0) {
          const e = (() => { try { engineSell(s, p.id, 1); return null; } catch (x) { return x as any; } })();
          expect(e?.code, label).toBe('INSUFFICIENT_STOCK');
          bump('sale-rejected');
          continue;
        }
        const qty = rnd() < 0.2 ? m.qty : int(1, Math.min(m.qty, 4));
        const res = engineSell(s, p.id, qty);
        const expected = qty === m.qty ? m.value : roundDiv(m.value, qty, m.qty);
        expect(res.valueRemovedCents, label).toBe(expected);
        m.qty -= qty; m.value -= expected;
        bump('sale');
      } else {
        // ---- value-only adjustment (makes pool value differ from purchase values -> exercises caps and sweeps)
        const p = pick(products);
        const m = model.get(p.id)!;
        if (m.qty === 0) continue;
        const delta = rnd() < 0.5 ? int(1, 800) : -int(0, Math.min(m.value, 800));
        if (delta === 0) continue;
        valueMove(s, p.id, delta);
        m.value += delta;
        bump('adjust');
      }
      checkAll(label);
      if (i % 25 === 0) expect(reconcileStock(s.ctx.database.conn), label).toMatchObject({ ok: true });
    }

    function sumReturned(pu: PRec, itemId: number): number { return (pu.items.find((x) => x.id === itemId) as any).ret ?? 0; }

    // The run must have exercised every path
    expect(stats.purchase).toBeGreaterThan(40);
    expect(stats.return).toBeGreaterThan(10);
    expect(stats.void).toBeGreaterThan(3);
    expect(stats.sale).toBeGreaterThan(20);
    expect(stats.adjust).toBeGreaterThan(5);
    expect(['purchase', 'return', 'return-rejected', 'void', 'void-rejected', 'sale', 'sale-rejected', 'adjust'].reduce((a, k) => a + (stats[k] ?? 0), 0)).toBeGreaterThanOrEqual(200);
    expect(sql(s, "SELECT COUNT(*) AS n FROM stock_movements WHERE type = 'adjustment' AND qty_delta = 0 AND reason LIKE 'Residual%'")[0]!.n)
      .toBeDefined();

    // Final invariants
    const rec = await get(s.app, '/inventory/reconciliation');
    expect(rec.body).toEqual({ ok: true, checkedProducts: 5, mismatches: [] });
    for (const p of products) {
      const sums = sql(s, 'SELECT COALESCE(SUM(qty_delta),0) AS q, COALESCE(SUM(value_delta_cents),0) AS v FROM stock_movements WHERE product_id = ?', p.id)[0]!;
      const prod = await productOf(s, p.id);
      expect([Number(sums.q), Number(sums.v)]).toEqual([prod.qtyOnHand, prod.stockValueCents]);
      expect([prod.qtyOnHand, prod.stockValueCents]).toEqual([model.get(p.id)!.qty, model.get(p.id)!.value]);
    }
    const bal = (book: string) => Number(sql(s, 'SELECT COALESCE(SUM(amount_cents),0) AS t FROM cash_entries WHERE book = ?', book)[0]!.t);
    expect(bal('shop')).toBe(cash.shop);
    expect(bal('telecom')).toBe(cash.telecom);
    expect(bal('icecream')).toBe(0);
    // Every void has a reversal pointing at an existing original with the same business date
    const rev = sql(s, 'SELECT r.business_date AS rd, o.business_date AS od, r.amount_cents AS ra, o.amount_cents AS oa FROM cash_entries r JOIN cash_entries o ON o.id = r.reverses_entry_id');
    expect(rev.length).toBe(stats['void-paid']);
    for (const x of rev) { expect(x.rd).toBe(x.od); expect(Number(x.ra)).toBe(-Number(x.oa)); }
    // Status in the API matches the model
    for (const pu of purchases) expect((await get(s.app, `/purchases/${pu.id}`)).body.item.status).toBe(pu.status);
    // Every purchase_return has refund = sum of lines, returnedUnits match
    for (const pu of purchases) {
      const api = (await get(s.app, `/purchases/${pu.id}`)).body.item;
      expect(api.items.map((i: any) => i.returnedUnits)).toEqual(pu.items.map((i) => i.returned));
    }
  }, 120000);
});

// =============================================================================================
describe('persistence and restore', () => {
  it('everything survives closing and reopening the app on the same data directory', async () => {
    const first = await env.build();
    const s1 = await apiBase(first);
    const p = await mkProduct(s1);
    const sup = await mkSupplier(s1);
    const P1 = await buy(s1, [line(p.id, 2, 5, 400000)], { supplierId: sup.id, billNo: 'KEEP-1', businessDate: daysAgo(2) });
    const R1 = await ret(s1, P1.id, [{ purchaseItemId: P1.items[0].id, units: 3 }]);
    expect(R1.status).toBe(201);
    const P2 = await buy(s1, [line(p.id, 1, 4, 100)]);
    expect((await voidP(s1, P2.id)).status).toBe(200);
    const listBefore = (await get(s1.app, '/purchases')).body;
    const movesBefore = (await get(s1.app, `/products/${p.id}/movements`)).body;
    const cashBefore = cashRows(s1.ctx);
    const auditBefore = count(s1.ctx, 'audit_logs');
    await first.app.close();

    const second = await env.build({ dataDir: first.dataDir });
    const s2 = await apiBase(second);
    expect((await get(s2.app, '/purchases')).body).toEqual(listBefore);
    expect((await get(s2.app, `/products/${p.id}/movements`)).body).toEqual(movesBefore);
    expect(cashRows(s2.ctx)).toEqual(cashBefore);
    expect(count(s2.ctx, 'audit_logs')).toBe(auditBefore);
    expect(await productOf(s2, p.id)).toMatchObject({ qtyOnHand: 7, stockValueCents: 280000 });
    expect((await get(s2.app, '/inventory/reconciliation')).body.ok).toBe(true);
    // idempotency keys persist
    const again = await post(s2.app, `/purchases/${P1.id}/returns`, {
      businessDate: today(), clientRef: R1.body.item.clientRef, items: [{ purchaseItemId: P1.items[0].id, units: 3 }],
    });
    expect(again.status).toBe(200);
    expect(again.body.item.id).toBe(R1.body.item.id);
    // and the app keeps working
    expect((await ret(s2, P1.id, [{ purchaseItemId: P1.items[0].id, units: 7 }])).status).toBe(201);
    expect(await productOf(s2, p.id)).toMatchObject({ qtyOnHand: 0, stockValueCents: 0 });
    expect((await get(s2.app, '/inventory/reconciliation')).body.ok).toBe(true);
  });

  it('restoring a version-3 backup migrates it to the latest schema and Phase 3 works on it', async () => {
    const s = await setup();
    // build a v3 database file with a supplier and a stock product
    const dir = env.newDir();
    const mdir = join(dir, 'mig');
    mkdirSync(mdir, { recursive: true });
    for (const f of loadMigrations().filter((m) => m.version <= 3)) copyFileSync(join(MIGRATIONS_DIR, f.name), join(mdir, f.name));
    const v3 = join(dir, 'v3.db');
    const c = new DatabaseSync(v3);
    try {
      c.exec('PRAGMA foreign_keys = ON');
      c.exec('PRAGMA journal_mode = DELETE');
      expect(migrate(c, mdir).version).toBe(3);
      const cat = Number((c.prepare("SELECT id FROM categories WHERE name = 'Other'").get() as any).id);
      c.prepare(`INSERT INTO products (name, category_id, kind, book, sell_price_cents, min_price_cents) VALUES ('Legacy Item', ?, 'stock', 'shop', 1000, 500)`).run(cat);
      c.prepare("INSERT INTO suppliers (name) VALUES ('Legacy Supplier')").run();
    } finally { c.close(); }

    const name = 'viman-20250101-000000-manual.db';
    copyFileSync(v3, join(s.ctx.dataDir ?? (await dataDirOf(s)), 'backups', name));
    const res = await post(s.app, '/backups/restore', { name, confirm: 'RESTORE' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.schemaVersion).toBe(latestVersion());
    expect(latestVersion()).toBeGreaterThanOrEqual(4);
    expect((await get(s.app, '/health')).body.schemaVersion).toBe(latestVersion());

    const tables = sql(s, "SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['purchases', 'stock_movements', 'cash_entries']));
    const prod = (await get(s.app, '/products?q=Legacy')).body.items[0];
    const sup = (await get(s.app, '/suppliers')).body.items.find((x: any) => x.name === 'Legacy Supplier');
    expect(prod).toMatchObject({ name: 'Legacy Item', qtyOnHand: 0, stockValueCents: 0 });
    const P = await buy(s, [line(prod.id, 1, 6, 1200)], { supplierId: sup.id });
    expect(P.items[0].unitCostCents).toBe(200);
    expect(await productOf(s, prod.id)).toMatchObject({ qtyOnHand: 6, stockValueCents: 1200 });
    expect((await get(s.app, '/inventory/reconciliation')).body).toEqual({ ok: true, checkedProducts: 1, mismatches: [] });
    expect((await ret(s, P.id, [{ purchaseItemId: P.items[0].id, units: 6 }])).status).toBe(201);
  });
});

async function dataDirOf(s: ApiBase): Promise<string> {
  const row = s.ctx.database.filePath;
  return join(row, '..');
}
