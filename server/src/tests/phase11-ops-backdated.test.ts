// Phase 11 (agent B) - GET /reports/backdated: records whose business date is earlier than the Colombo date of their posting time.
// Protects: BUSINESS_RULES 12 (backdated = business date < posting date in Asia/Colombo, UTC+5:30; backdated entries are traceable
// through the audit entry) and R-FD (backdating stays legal). Two parts: (1) the real API (records posted now with older business dates),
// (2) the database level, where `posted_at` is written explicitly so the midnight boundary of Colombo time can be tested exactly.
//
// Part 1 scenario (posted today; "today" = D0). Backdated records are exactly those dated before today:
//   purchase D3 (backdated) | purchase D6, then voided (backdated, status void) | purchase today (stock; NOT backdated)
//   sale D2 (backdated) | sale today (NOT) | sales return D1 on the D2 sale (backdated) | sales return today (NOT)
//   expense D1 (backdated) | cash drawing telecom D4 (backdated) | cash drawing today (NOT) | stock loss D1 (backdated)
//   Ice Cream day D2 (backdated)
//   -> 8 backdated: purchase 2, sale 1, sale_return 1, expense 1, drawing 1, stock_loss 1, icecream_day 1.
//   Shop 6 (purchases 2, sale, return, expense, loss), Telecom 1 (drawing), Ice Cream 1.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { TestEnv } from './helpers/tmp.ts';
import { buy, memDb, mkProduct } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { cl, returnOk, rl, sellOk } from './helpers/phase5.ts';
import { lossNew } from './helpers/phase4.ts';
import { drawCash } from './helpers/phase9.ts';
import { expNew } from './helpers/phase8.ts';
import { post } from './helpers/catalog.ts';
import { ref } from './helpers/inventory.ts';
import { D, newBase, rep, repXlsx } from './helpers/phase11ops.ts';
import { backdatedReport } from '../services/reports/backdated-report.ts';

const env = new TestEnv();
let s: ApiBase;
let ids: { purchaseD3: number; purchaseVoid: number; purchaseToday: number; saleD2: number; saleToday: number; returnD1: number; returnToday: number; expenseD1: number; drawingD4: number; lossD1: number; iceD2: number };

beforeAll(async () => {
  s = await newBase(env);
  const p = (await mkProduct(s, { minPriceCents: 0 })).id;
  const q = (await mkProduct(s, { minPriceCents: 0 })).id;
  const purchaseToday = await buy(s, [{ productId: p, packs: 1, packSize: 20, lineTotalCents: 2000 }]);               // today, NOT backdated
  const purchaseD3 = await buy(s, [{ productId: q, packs: 1, packSize: 5, lineTotalCents: 500 }], { businessDate: D(3) });
  const purchaseVoid = await buy(s, [{ productId: q, packs: 1, packSize: 1, lineTotalCents: 100 }], { businessDate: D(6) });
  await post(s.app, `/purchases/${purchaseVoid.id}/void`, { reason: 'test' });
  const saleD2 = (await sellOk(s, [cl(p, 4, 300)], { businessDate: D(2) })).sales[0];
  const saleToday = (await sellOk(s, [cl(p, 1, 300)])).sales[0];
  const returnD1 = (await returnOk(s, saleD2.id, [rl(saleD2.items[0].id, 1, true)], { businessDate: D(1) })).item;
  const returnToday = (await returnOk(s, saleD2.id, [rl(saleD2.items[0].id, 1, true)])).item;
  const expense = await expNew(s, { businessDate: D(1) });
  const drawing = await drawCash(s, { businessDate: D(4), book: 'telecom', amountCents: 200 });
  await drawCash(s, { businessDate: D(0), book: 'shop', amountCents: 300 });                                           // today, NOT backdated
  const loss = await lossNew(s, p, 1, { businessDate: D(1) });
  const ice = await post(s.app, '/icecream/days', { businessDate: D(2), salesCents: 10000, costAllocCents: 6000, electricityAllocCents: 1000, clientRef: ref() });
  for (const r of [expense, drawing, loss, ice]) if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  ids = {
    purchaseD3: purchaseD3.id, purchaseVoid: purchaseVoid.id, purchaseToday: purchaseToday.id, saleD2: saleD2.id, saleToday: saleToday.id,
    returnD1: returnD1.id, returnToday: returnToday.id, expenseD1: expense.body.item.id, drawingD4: drawing.body.item.id, lossD1: loss.body.item.id,
    iceD2: ice.body.day?.id ?? ice.body.record?.id ?? ice.body.item?.id,
  };
}, 60000);
afterAll(async () => { await env.cleanup(); });

const WIDE = () => `?from=${D(30)}&to=${D(0)}`;
const key = (r: any) => `${r.recordType}:${r.recordId}`;

describe('GET /reports/backdated (API)', () => {
  it('lists exactly the records dated before the day they were saved', async () => {
    const r = await rep(s, '/reports/backdated', `${WIDE()}&limit=200`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(8);
    expect(r.body.byType.map((x: any) => [x.recordType, x.count]).sort()).toEqual([
      ['drawing', 1], ['expense', 1], ['icecream_day', 1], ['purchase', 2], ['sale', 1], ['sale_return', 1], ['stock_loss', 1],
    ]);
    const got = new Set(r.body.rows.map(key));
    for (const k of [`purchase:${ids.purchaseD3}`, `purchase:${ids.purchaseVoid}`, `sale:${ids.saleD2}`, `sale_return:${ids.returnD1}`, `expense:${ids.expenseD1}`,
      `drawing:${ids.drawingD4}`, `stock_loss:${ids.lossD1}`, `icecream_day:${ids.iceD2}`]) expect(got.has(k)).toBe(true);
    // records dated today are NOT backdated
    for (const k of [`purchase:${ids.purchaseToday}`, `sale:${ids.saleToday}`, `sale_return:${ids.returnToday}`]) expect(got.has(k)).toBe(false);
    expect(r.body.rows.filter((x: any) => x.recordType === 'drawing').map((x: any) => x.amountCents)).toEqual([200]);   // today's 300 drawing is absent
  });

  it('each line carries amount, book, status, both dates and the audit entry id', async () => {
    const r = await rep(s, '/reports/backdated', `${WIDE()}&limit=200`);
    const sale = r.body.rows.find((x: any) => x.recordType === 'sale');
    // sale D2: 4 units x 300 = 1,200
    expect(sale).toMatchObject({ recordId: ids.saleD2, amountCents: 1200, book: 'shop', status: 'posted', businessDate: D(2), daysBackdated: 2, recordLabel: 'Sale' });
    expect(sale.postedDate).toBe(D(0));
    expect(sale.postedAt.endsWith('Z')).toBe(true);
    // the audit entry: found independently in audit_logs (entity 'sale', entity id, action create) and flagged backdated with the business date
    const audit = s.ctx.database.conn.prepare("SELECT id, backdated, business_date FROM audit_logs WHERE entity = 'sale' AND entity_id = ? AND action = 'create'").get(String(ids.saleD2)) as unknown as { id: number; backdated: number; business_date: string };
    expect(sale.auditId).toBe(Number(audit.id));
    expect(Number(audit.backdated)).toBe(1);
    expect(audit.business_date).toBe(D(2));
    const pv = r.body.rows.find((x: any) => x.recordType === 'purchase' && x.recordId === ids.purchaseVoid);
    expect(pv).toMatchObject({ status: 'void', daysBackdated: 6, amountCents: 100, businessDate: D(6) });   // voided records are listed, marked void
    expect(r.body.rows.every((x: any) => x.auditId !== null)).toBe(true);
    const ret = r.body.rows.find((x: any) => x.recordType === 'sale_return');
    expect(ret).toMatchObject({ amountCents: 300, daysBackdated: 1, book: 'shop' });
    const ice = r.body.rows.find((x: any) => x.recordType === 'icecream_day');
    expect(ice).toMatchObject({ book: 'icecream', amountCents: 10000, daysBackdated: 2 });
  });

  it('filters by book and by business-date range', async () => {
    const book = async (b: string) => (await rep(s, '/reports/backdated', `${WIDE()}&book=${b}`)).body;
    expect((await book('shop')).total).toBe(6);
    expect((await book('telecom')).rows.map((x: any) => x.recordType)).toEqual(['drawing']);
    expect((await book('icecream')).rows.map((x: any) => x.recordType)).toEqual(['icecream_day']);
    const one = await rep(s, '/reports/backdated', `?from=${D(1)}&to=${D(1)}`);
    expect(one.body.rows.map((x: any) => x.recordType).sort()).toEqual(['expense', 'sale_return', 'stock_loss']);   // dated D1
    expect((await rep(s, '/reports/backdated', `?from=${D(6)}&to=${D(6)}`)).body.total).toBe(1);                   // the voided purchase
    expect((await rep(s, '/reports/backdated', `?from=${D(0)}&to=${D(0)}`)).body.total).toBe(0);                   // nothing dated today is backdated
    expect((await rep(s, '/reports/backdated', `?from=${D(30)}&to=${D(20)}`)).body.rows).toEqual([]);
  });

  it('paging: 3 + 3 + 2 rows, no repeats, newest posting first', async () => {
    const seen: string[] = [];
    let lastPosted = '9999';
    for (const [off, n] of [[0, 3], [3, 3], [6, 2]]) {
      const r = await rep(s, '/reports/backdated', `${WIDE()}&limit=3&offset=${off}`);
      expect(r.body.total).toBe(8);
      expect(r.body.rows.length).toBe(n);
      for (const x of r.body.rows) { seen.push(key(x)); expect(x.postedAt <= lastPosted).toBe(true); lastPosted = x.postedAt; }
    }
    expect(new Set(seen).size).toBe(8);
  });

  it('is read-only and has an Excel download', async () => {
    const before = Number((s.ctx.database.conn.prepare('SELECT COUNT(*) AS n FROM audit_logs').get() as unknown as { n: number }).n);
    expect((await repXlsx(s, '/reports/backdated', WIDE())).isZip).toBe(true);
    expect(Number((s.ctx.database.conn.prepare('SELECT COUNT(*) AS n FROM audit_logs').get() as unknown as { n: number }).n)).toBe(before);
  });
});

// Part 2: the Colombo midnight boundary. Colombo = UTC + 5h30, so 18:30 UTC is exactly midnight in Colombo.
//  a) business 03-10, saved 03-10 19:00 UTC = 03-11 00:30 Colombo -> BACKDATED (1 day)
//  b) business 03-10, saved 03-10 18:00 UTC = 03-10 23:30 Colombo -> not backdated
//  c) business 03-11, saved 03-10 18:30 UTC = 03-11 00:00 Colombo -> not backdated (same day)
//  d) business 03-10, saved 03-10 18:29:59 UTC = 03-10 23:59:59 Colombo -> not backdated
//  e) business 03-09, saved 03-10 00:00 UTC = 03-10 05:30 Colombo -> BACKDATED (1 day)
describe('backdated definition at the Colombo midnight boundary (database level)', () => {
  it('compares the business date with the Colombo date of the posting time, not the UTC date', () => {
    const track: DatabaseSync[] = [];
    const c = memDb(track);
    try {
      const add = (businessDate: string, postedAt: string, n: number): number => Number(c.prepare(
        "INSERT INTO purchases (business_date, posted_at, book, total_cents, client_ref) VALUES (?, ?, 'shop', ?, ?)",
      ).run(businessDate, postedAt, n, `boundary-${n}`).lastInsertRowid);
      const a = add('2026-03-10', '2026-03-10T19:00:00.000Z', 1);
      add('2026-03-10', '2026-03-10T18:00:00.000Z', 2);
      add('2026-03-11', '2026-03-10T18:30:00.000Z', 3);
      add('2026-03-10', '2026-03-10T18:29:59.000Z', 4);
      const e = add('2026-03-09', '2026-03-10T00:00:00.000Z', 5);
      const r = backdatedReport(c, { from: '2026-03-01', to: '2026-03-31', limit: 50, offset: 0 });
      expect(r.total).toBe(2);
      expect(r.rows.map((x) => x.recordId).sort()).toEqual([a, e].sort());
      expect(r.rows.find((x) => x.recordId === a)).toMatchObject({ postedDate: '2026-03-11', daysBackdated: 1, businessDate: '2026-03-10', auditId: null });
      expect(r.rows.find((x) => x.recordId === e)).toMatchObject({ postedDate: '2026-03-10', daysBackdated: 1 });
    } finally { for (const x of track) x.close(); }
  });
});
