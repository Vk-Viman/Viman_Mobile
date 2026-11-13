// Phase 14 adversarial tests: try to BREAK the API. Every dated financial write endpoint is attacked with future dates, unknown fields, wrong types
// (no coercion), huge / negative / fractional numbers, closed days, duplicates; text fields are fed SQL-injection and XSS strings. Each refusal must
// carry the DOCUMENTED error code (API_CONTRACTS) AND must write NOTHING: the whole database is fingerprinted before and after (`snapshotAll`).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, buy, daysAgo, mkProduct, mkSupplier, mkTelecom, ref } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { get, post, put, raw } from './helpers/catalog.ts';
import { assertGlobalInvariants, diffSnapshots, must, rows, snapshotAll } from './helpers/phase14.ts';
import { cl, returnOk, sellOk } from './helpers/phase5.ts';
import { providerIds } from './helpers/phase6.ts';
import { closeNew, openNew } from './helpers/phase8.ts';
import { dayOk, moveOk, payOk } from './helpers/phase10.ts';
import { stComplete, stDraft } from './helpers/phase4.ts';

const env = new TestEnv();
afterAll(async () => { await env.cleanup(); });

interface W {
  s: ApiBase; A: number; B: number; K: number; sup: number; prov: Record<string, number>; typeId: number;
  sale1: any; sale2: any; pA: any; pB: any; pK: any; unusedSaleItem: number;
}
const D = (n: number) => daysAgo(n);

/** A small shop with stock, opening balances, one sale + return, and an Ice Cream day; nothing is closed yet. */
async function world(): Promise<W> {
  const s = await apiBase(await env.build());
  const A = (await mkProduct(s, { name: 'Adv A', sellPriceCents: 5000, minPriceCents: 100 })).id;
  const B = (await mkProduct(s, { name: 'Adv B', sellPriceCents: 4000, minPriceCents: 100 })).id;
  const K = (await mkTelecom(s, { name: 'Adv K', sellPriceCents: 1000, minPriceCents: 100 })).id;
  const sup = (await mkSupplier(s)).id;
  const prov = await providerIds(s);
  const typeId = (await get(s.app, '/print-service-types')).body.items[0].id;
  await must(await openNew(s, 'shop', { businessDate: D(12), amountCents: 10000000 }), 'open');
  await must(await openNew(s, 'telecom', { businessDate: D(12), amountCents: 5000000 }), 'open');
  await must(await openNew(s, 'icecream', { businessDate: D(12), amountCents: 1000000, fund: 'cost' }), 'open');
  const pA = await buy(s, [{ productId: A, packs: 1, packSize: 20, lineTotalCents: 200000 }], { businessDate: D(10), supplierId: sup });
  const pB = await buy(s, [{ productId: B, packs: 1, packSize: 10, lineTotalCents: 100000 }], { businessDate: D(10) });
  const pK = await buy(s, [{ productId: K, packs: 1, packSize: 50, lineTotalCents: 100000 }], { businessDate: D(10) });
  const sale1 = (await sellOk(s, [cl(A, 5, 5000)], { businessDate: D(8) })).sales[0];
  await returnOk(s, sale1.id, [{ saleItemId: sale1.items[0].id, qty: 1, resalable: true }], { businessDate: D(6) });
  const sale2 = (await sellOk(s, [cl(B, 2, 4000)], { businessDate: D(7) })).sales[0];
  await dayOk(s, { businessDate: D(9), salesCents: 100000, costAllocCents: 60000, electricityAllocCents: 10000 });
  return { s, A, B, K, sup, prov, typeId, sale1, sale2, pA, pB, pK, unusedSaleItem: sale2.items[0].id };
}

interface Req { method: 'POST' | 'PUT'; url: string; body: any }
/** Every dated financial write endpoint, as a request builder for a given business date. */
const MAKERS: Record<string, (w: W, d: string) => Req> = {
  sale: (w, d) => ({ method: 'POST', url: '/sales', body: { businessDate: d, items: [{ productId: w.A, qty: 1, unitPriceCents: 5000 }], clientRef: ref() } }),
  saleReturn: (w, d) => ({ method: 'POST', url: `/sales/${w.sale2.id}/returns`, body: { businessDate: d, items: [{ saleItemId: w.unusedSaleItem, qty: 1, resalable: true }], clientRef: ref() } }),
  purchase: (w, d) => ({ method: 'POST', url: '/purchases', body: { businessDate: d, items: [{ productId: w.A, packs: 1, packSize: 2, lineTotalCents: 1000 }], clientRef: ref() } }),
  purchaseReturn: (w, d) => ({ method: 'POST', url: `/purchases/${w.pB.id}/returns`, body: { businessDate: d, items: [{ purchaseItemId: w.pB.items[0].id, units: 1 }], clientRef: ref() } }),
  openingStock: (w, d) => ({ method: 'POST', url: '/opening-stock', body: { businessDate: d, items: [{ productId: w.A, qty: 1, totalValueCents: 1000 }], clientRef: ref() } }),
  stocktake: (w, d) => ({ method: 'POST', url: '/stocktakes', body: { businessDate: d, book: 'shop', items: [{ productId: w.A, countedQty: 3 }], clientRef: ref() } }),
  loss: (w, d) => ({ method: 'POST', url: '/stock-losses', body: { businessDate: d, productId: w.A, qty: 1, reason: 'lost', clientRef: ref() } }),
  goodsDrawing: (w, d) => ({ method: 'POST', url: '/drawings', body: { kind: 'goods', businessDate: d, productId: w.A, qty: 1, clientRef: ref() } }),
  cashDrawing: (_w, d) => ({ method: 'POST', url: '/drawings', body: { kind: 'cash', businessDate: d, book: 'shop', amountCents: 1000, clientRef: ref() } }),
  reload: (w, d) => ({ method: 'POST', url: '/reload-sales', body: { businessDate: d, providerId: w.prov.Dialog, salesCents: 10000, extraCents: 5, clientRef: ref() } }),
  ezcash: (_w, d) => ({ method: 'POST', url: '/ezcash-sales', body: { businessDate: d, billTotalCents: 10000, clientRef: ref() } }),
  topup: (w, d) => ({ method: 'POST', url: '/telecom/topups', body: { businessDate: d, kind: 'provider_topup', providerId: w.prov.Dialog, amountCents: 1000, clientRef: ref() } }),
  printSale: (w, d) => ({ method: 'POST', url: '/print-sales', body: { businessDate: d, serviceTypeId: w.typeId, qty: 2, clientRef: ref() } }),
  supplies: (_w, d) => ({ method: 'POST', url: '/printing-supplies', body: { businessDate: d, amountCents: 1000, description: 'paper', clientRef: ref() } }),
  expense: (_w, d) => ({ method: 'POST', url: '/expenses', body: { businessDate: d, book: 'shop', category: 'rent', amountCents: 1000, description: 'rent', clientRef: ref() } }),
  openingBalance: (_w, d) => ({ method: 'POST', url: '/cashbooks/shop/opening', body: { businessDate: d, amountCents: 1000, clientRef: ref() } }),
  capital: (_w, d) => ({ method: 'POST', url: '/capital', body: { businessDate: d, book: 'icecream', fund: 'electricity', amountCents: 1000, clientRef: ref() } }),
  transfer: (_w, d) => ({ method: 'POST', url: '/cash-transfers', body: { businessDate: d, fromBook: 'shop', toBook: 'icecream', toFund: 'cost', amountCents: 1000, clientRef: ref() } }),
  count: (_w, d) => ({ method: 'POST', url: '/cash-counts', body: { businessDate: d, book: 'shop', countedCents: 1, note: 'x', clientRef: ref() } }),
  closing: (_w, d) => ({ method: 'POST', url: '/daily-closings', body: { book: 'shop', businessDate: d, clientRef: ref() } }),
  iceDay: (_w, d) => ({ method: 'POST', url: '/icecream/days', body: { businessDate: d, salesCents: 1000, costAllocCents: 100, electricityAllocCents: 100, clientRef: ref() } }),
  iceDayPut: (_w, d) => ({ method: 'PUT', url: `/icecream/days/${D(9)}`, body: { businessDate: d, salesCents: 1000, costAllocCents: 100, electricityAllocCents: 100, clientRef: ref() } }),
  icePayment: (_w, d) => ({ method: 'POST', url: '/icecream/payments', body: { businessDate: d, kind: 'materials', fund: 'cost', amountCents: 1000, description: 'x', clientRef: ref() } }),
  iceMove: (_w, d) => ({ method: 'POST', url: '/icecream/fund-moves', body: { businessDate: d, fromFund: 'cost', toFund: 'electricity', amountCents: 1000, clientRef: ref() } }),
};
/** The PUT replace endpoint has no businessDate in its body (the date is in the path): its date attacks go through the path instead. */
const BODY_DATED = Object.keys(MAKERS).filter((k) => k !== 'iceDayPut');

const send = (w: W, r: Req) => (r.method === 'POST' ? post(w.s.app, r.url, r.body) : put(w.s.app, r.url, r.body));
const code = (r: { body: any }) => r.body?.error?.code;

/** Sends `r`, then checks status/code and that the whole database is byte-for-byte unchanged. */
async function refused(w: W, label: string, r: () => Promise<{ status: number; body: any }>, status: number | number[], codes: string | string[]): Promise<void> {
  const before = snapshotAll(w.s.ctx);
  const res = await r();
  const ok = Array.isArray(status) ? status : [status];
  const cs = Array.isArray(codes) ? codes : [codes];
  expect(ok, `${label}: status ${res.status} ${JSON.stringify(res.body).slice(0, 250)}`).toContain(res.status);
  expect(cs, `${label}: code ${code(res)}`).toContain(code(res));
  expect(diffSnapshots(before, snapshotAll(w.s.ctx)), `${label}: a refused request changed tables`).toEqual([]);
}

// ---------------------------------------------------------------------------------------------------------------------------------
describe('every dated write endpoint: dates', () => {
  let w: W;
  beforeAll(async () => { w = await world(); }, 120000);

  it('a future date is refused FUTURE_DATE_NOT_ALLOWED (tomorrow, next year, 2099) and writes nothing', async () => {
    for (const name of BODY_DATED) for (const d of [D(-1), D(-366), '2099-12-31']) {
      await refused(w, `${name} @ ${d}`, () => send(w, MAKERS[name]!(w, d)), 400, 'FUTURE_DATE_NOT_ALLOWED');
    }
    // the PUT replace path: the date is the path parameter
    await refused(w, 'PUT ice day future', () => put(w.s.app, `/icecream/days/${D(-1)}`, { salesCents: 1, costAllocCents: 0, electricityAllocCents: 0, clientRef: ref() }), 400, 'FUTURE_DATE_NOT_ALLOWED');
  });

  it('a malformed date is a 400 VALIDATION_ERROR (not 500) and writes nothing', async () => {
    for (const name of BODY_DATED) for (const d of ['2025-02-30', '2025-13-01', 'yesterday', '', '2025/08/01', '20250801', '2025-8-1']) {
      await refused(w, `${name} @ "${d}"`, () => send(w, MAKERS[name]!(w, d)), 400, ['VALIDATION_ERROR', 'FUTURE_DATE_NOT_ALLOWED']);
    }
    for (const name of BODY_DATED) {
      const r = MAKERS[name]!(w, D(1)); r.body.businessDate = 20250801;
      await refused(w, `${name} numeric date`, () => send(w, r), 400, 'VALIDATION_ERROR');
      const m = MAKERS[name]!(w, D(1)); delete m.body.businessDate;
      if (name !== 'closing') await refused(w, `${name} missing date`, () => send(w, m), 400, 'VALIDATION_ERROR');
    }
  });

  it('a return dated before its original is refused RETURN_BEFORE_ORIGINAL_DATE (sales and purchases), the original date is named', async () => {
    for (const [name, original] of [['saleReturn', D(7)], ['purchaseReturn', D(10)]] as const) {
      const d = daysAgo(Number(name === 'saleReturn' ? 8 : 11));
      const req = MAKERS[name]!(w, d);
      const before = snapshotAll(w.s.ctx);
      const r = await send(w, req);
      expect([r.status, code(r)], name).toEqual([400, 'RETURN_BEFORE_ORIGINAL_DATE']);
      expect(r.body.error.originalDate).toBe(original);
      expect(r.body.error.message).toContain(original);
      expect(diffSnapshots(before, snapshotAll(w.s.ctx))).toEqual([]);
    }
    // a return of a not-yet-existing document: 404, written nothing
    await refused(w, 'return of unknown sale', () => post(w.s.app, '/sales/99999/returns', { businessDate: D(1), items: [{ saleItemId: 1, qty: 1, resalable: true }], clientRef: ref() }), 404, 'NOT_FOUND');
    await refused(w, 'return of unknown purchase', () => post(w.s.app, '/purchases/99999/returns', { businessDate: D(1), items: [{ purchaseItemId: 1, units: 1 }], clientRef: ref() }), 404, 'NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('every write endpoint: unknown fields, wrong types, huge/negative numbers', () => {
  let w: W;
  beforeAll(async () => { w = await world(); }, 120000);

  it('an unknown field and a client-supplied postedAt are 400 VALIDATION_ERROR (additionalProperties:false)', async () => {
    for (const name of Object.keys(MAKERS)) {
      const a = MAKERS[name]!(w, D(1)); a.body.bogus = 1;
      await refused(w, `${name} + bogus`, () => send(w, a), 400, 'VALIDATION_ERROR');
      const b = MAKERS[name]!(w, D(1)); b.body.postedAt = '2020-01-01T00:00:00.000Z';
      const before = snapshotAll(w.s.ctx);
      const r = await send(w, b);
      expect([r.status, code(r)], `${name} + postedAt`).toEqual([400, 'VALIDATION_ERROR']);
      expect(r.body.error.fields?.postedAt ?? r.body.error.fields?.['/postedAt'] ?? JSON.stringify(r.body.error.fields), `${name}: postedAt named in fields`).toBeTruthy();
      expect(diffSnapshots(before, snapshotAll(w.s.ctx))).toEqual([]);
      const c = MAKERS[name]!(w, D(1)); c.body.clientRef = 'short';
      await refused(w, `${name} short clientRef`, () => send(w, c), 400, 'VALIDATION_ERROR');
      const d2 = MAKERS[name]!(w, D(1)); d2.body.clientRef = 'bad ref with spaces!!';
      await refused(w, `${name} bad clientRef`, () => send(w, d2), 400, 'VALIDATION_ERROR');
    }
  });

  /** Every numeric leaf of every body gets: "123", null, true, 1.5, -1, 2^53+1, 1e21, 1e13. All must be a clean 400 (id-like fields may also be 404). */
  it('every numeric field of every endpoint rejects strings, null, booleans, fractions, negatives, unsafe and huge numbers - no coercion, no 500', async () => {
    const BAD = ['"123"', 'null', 'true', '1.5', '-1', '9007199254740993', '1e21', '1e13'];
    let checked = 0;
    for (const name of Object.keys(MAKERS)) {
      const base = MAKERS[name]!(w, D(1));
      const leaves = numericPaths(base.body);
      for (const path of leaves) {
        for (const lit of BAD) {
          const text = withLiteral(base.body, path, lit);
          const before = snapshotAll(w.s.ctx);
          const res = await raw(w.s.app, base.method, base.url, text);
          const idLike = /Id$/.test(String(path[path.length - 1]));
          const okStatus = idLike ? [400, 404, 422] : [400];
          expect(okStatus, `${name} ${path.join('.')} = ${lit}: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`).toContain(res.status);
          expect(res.status, `${name} ${path.join('.')} = ${lit}: must not be a 500`).not.toBe(500);
          expect(diffSnapshots(before, snapshotAll(w.s.ctx)), `${name} ${path.join('.')} = ${lit}: wrote something`).toEqual([]);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('zero and negative amounts: money fields that must be positive reject 0 (amounts), and every quantity rejects 0', async () => {
    const cases: Array<[string, string[]]> = [
      ['expense', ['amountCents']], ['capital', ['amountCents']], ['transfer', ['amountCents']], ['cashDrawing', ['amountCents']], ['supplies', ['amountCents']],
      ['topup', ['amountCents']], ['ezcash', ['billTotalCents']], ['reload', ['salesCents']], ['iceMove', ['amountCents']], ['icePayment', ['amountCents']],
      ['openingBalance', ['amountCents']], ['loss', ['qty']], ['goodsDrawing', ['qty']], ['printSale', ['qty']],
    ];
    for (const [name, fields] of cases) for (const f of fields) {
      const r = MAKERS[name]!(w, D(1)); r.body[f] = 0;
      await refused(w, `${name}.${f} = 0`, () => send(w, r), 400, 'VALIDATION_ERROR');
    }
  });

  it('the documented upper limits hold: amounts above 10^12 cents, a line total above 99,999,999,999, a unit price above 999,999,999, qty above 1,000,000', async () => {
    const e = MAKERS.expense!(w, D(1)); e.body.amountCents = 1_000_000_000_001;
    await refused(w, 'expense 10^12+1', () => send(w, e), 400, 'VALIDATION_ERROR');
    const p = MAKERS.purchase!(w, D(1)); p.body.items[0].lineTotalCents = 100_000_000_000;
    await refused(w, 'purchase line > max', () => send(w, p), 400, 'VALIDATION_ERROR');
    const s1 = MAKERS.sale!(w, D(1)); s1.body.items[0].unitPriceCents = 1_000_000_000;
    await refused(w, 'sale price > max', () => send(w, s1), 400, 'VALIDATION_ERROR');
    const s2 = MAKERS.sale!(w, D(1)); s2.body.items[0].qty = 1_000_001;
    await refused(w, 'sale qty > max', () => send(w, s2), 400, 'VALIDATION_ERROR');
    const pk = MAKERS.purchase!(w, D(1)); pk.body.items[0].packs = 1_000_001;
    await refused(w, 'packs > max', () => send(w, pk), 400, 'VALIDATION_ERROR');
  });

  it('malformed JSON bodies and wrong content shapes are 400, never 500', async () => {
    for (const body of ['{', '[]', '"x"', 'null', '{"businessDate":', '\u0000']) {
      const before = snapshotAll(w.s.ctx);
      const r = await raw(w.s.app, 'POST', '/expenses', body);
      expect([400, 415], `body ${JSON.stringify(body)} -> ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`).toContain(r.status);
      expect(diffSnapshots(before, snapshotAll(w.s.ctx))).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
/** Paths (arrays of keys) of every number leaf in a body, except dates. */
function numericPaths(o: any, prefix: Array<string | number> = []): Array<Array<string | number>> {
  const out: Array<Array<string | number>> = [];
  if (typeof o === 'number') return [prefix];
  if (Array.isArray(o)) o.forEach((v, i) => out.push(...numericPaths(v, [...prefix, i])));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) out.push(...numericPaths(v, [...prefix, k]));
  return out;
}
/** JSON text of `body` with the leaf at `path` replaced by the raw literal `lit` (so values JSON.stringify cannot produce can be sent). */
function withLiteral(body: any, path: Array<string | number>, lit: string): string {
  const clone = JSON.parse(JSON.stringify(body));
  let cur = clone;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]!];
  cur[path[path.length - 1]!] = '__LIT__';
  return JSON.stringify(clone).replace('"__LIT__"', lit);
}

// ---------------------------------------------------------------------------------------------------------------------------------
describe('text fields: SQL injection and XSS strings are stored verbatim and returned as JSON strings', () => {
  const XSS = '<script>alert(1)</script>"><img src=x onerror=alert(1)>&amp;';
  const SQLI = "Robert'); DROP TABLE cash_entries;-- ' OR '1'='1 \\\" ;";
  let w: W;
  beforeAll(async () => { w = await world(); }, 120000);

  it('expense, supplies, transfer, capital, drawing, count, sale, purchase, ice payment/day: text round-trips exactly; no table is dropped or altered', async () => {
    const t = D(1);
    const tables0 = rows(w.s.ctx, "SELECT name FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name").map((r) => r.name);
    const cashRowsBefore = Number(rows(w.s.ctx, 'SELECT COUNT(*) n FROM cash_entries')[0]!.n);
    const cases: Array<[string, string, any, (b: any) => any[]]> = [
      ['/expenses', 'expense', { businessDate: t, book: 'shop', category: 'other', amountCents: 100, description: XSS, notes: SQLI, clientRef: ref() }, (b) => [b.item.description, b.item.notes]],
      ['/printing-supplies', 'supplies', { businessDate: t, amountCents: 100, description: SQLI, clientRef: ref() }, (b) => [b.item.description]],
      ['/cash-transfers', 'transfer', { businessDate: t, fromBook: 'shop', toBook: 'telecom', amountCents: 100, note: XSS, clientRef: ref() }, (b) => [b.item.note]],
      ['/capital', 'capital', { businessDate: t, book: 'shop', amountCents: 100, note: SQLI, clientRef: ref() }, (b) => [b.item.note]],
      ['/drawings', 'drawing', { kind: 'cash', businessDate: t, book: 'shop', amountCents: 100, note: XSS, clientRef: ref() }, (b) => [b.item.note]],
      ['/cash-counts', 'count', { businessDate: t, book: 'shop', countedCents: 1, note: XSS + SQLI, clientRef: ref() }, (b) => [b.item.note]],
      ['/sales', 'sale', { businessDate: t, items: [{ productId: w.A, qty: 1, unitPriceCents: 5000 }], notes: XSS, clientRef: ref() }, (b) => [b.sales[0].notes]],
      ['/purchases', 'purchase', { businessDate: t, items: [{ productId: w.A, packs: 1, packSize: 1, lineTotalCents: 10 }], billNo: "B'--", notes: SQLI, clientRef: ref() }, (b) => [b.item.billNo, b.item.notes]],
      ['/icecream/payments', 'ice payment', { businessDate: t, kind: 'other_cost', fund: 'cost', amountCents: 100, category: XSS, description: SQLI, clientRef: ref() }, (b) => [b.payment.description, b.payment.category]],
      ['/icecream/days', 'ice day', { businessDate: t, salesCents: 100, costAllocCents: 10, electricityAllocCents: 10, notes: XSS, items: [{ itemName: SQLI, qty: 1, unitPriceCents: 100 }], clientRef: ref() }, (b) => [b.day.notes, b.day.items[0].itemName]],
      ['/products', 'product', { name: XSS, description: SQLI, categoryId: w.s.ids.Electronics, kind: 'stock', sellPriceCents: 100, minPriceCents: 1 }, (b) => [b.item.name, b.item.description]],
      ['/suppliers', 'supplier', { name: SQLI, phone: '<b>1</b>&amp;', notes: XSS }, (b) => [b.item.name, b.item.phone, b.item.notes]],
    ];
    for (const [url, label, body, pick] of cases) {
      const res = await w.s.app.inject({ method: 'POST', url: `/api/v1${url}`, payload: body });
      expect(res.statusCode, `${label}: ${res.body.slice(0, 200)}`).toBe(201);
      expect(String(res.headers['content-type']), `${label}: content type`).toContain('application/json');
      const got = pick(res.json());
      const sent = [body.description, body.notes, body.note, body.name, body.phone, body.billNo, body.category, body.items?.[0]?.itemName].filter((x) => typeof x === 'string');
      for (const g of got) expect(sent, `${label}: stored text must equal what was sent`).toContain(g);
      expect(typeof got[0]).toBe('string');
    }
    // nothing structural changed; the ledger only grew
    const tables1 = rows(w.s.ctx, "SELECT name FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name").map((r) => r.name);
    expect(tables1).toEqual(tables0);
    expect(Number(rows(w.s.ctx, 'SELECT COUNT(*) n FROM cash_entries')[0]!.n)).toBeGreaterThan(cashRowsBefore);
    // the stored text is read back through the list endpoints as the same JSON strings
    const list = (await get(w.s.app, '/expenses?limit=200')).body.items as any[];
    expect(list.some((e) => e.description === XSS && e.notes === SQLI)).toBe(true);
    // a search with injection text is a plain string match, not SQL
    const q = await get(w.s.app, `/products?q=${encodeURIComponent("' OR 1=1 --")}`);
    expect(q.status).toBe(200);
    expect(q.body.items).toEqual([]);
    await assertGlobalInvariants(w.s);
  });

  it('a text field with a NUL character or 100 kB of text never causes a 500', async () => {
    for (const text of ['a\u0000b', 'x'.repeat(100_000), '‮​😀']) {
      const r = await post(w.s.app, '/expenses', { businessDate: D(1), book: 'shop', category: 'other', amountCents: 100, description: text, clientRef: ref() });
      expect([201, 400], `${JSON.stringify(text.slice(0, 10))} -> ${r.status}`).toContain(r.status);
      if (r.status === 201) expect(r.body.item.description).toBe(text);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('duplicate submissions and concurrent injects', () => {
  let w: W;
  beforeAll(async () => { w = await world(); }, 120000);
  const rowsOf = (table: string) => Number(rows(w.s.ctx, `SELECT COUNT(*) n FROM ${table}`)[0]!.n);

  /** Six identical requests fired at once: exactly one creates (201), the others return the original (200) and the books move exactly once. */
  it('the same clientRef sent six times at once creates ONE record for every create endpoint', async () => {
    const names = ['sale', 'purchase', 'expense', 'reload', 'ezcash', 'topup', 'printSale', 'supplies', 'capital', 'transfer', 'cashDrawing', 'loss', 'goodsDrawing',
      'count', 'iceDay', 'icePayment', 'iceMove', 'stocktake', 'openingStock'];
    for (const name of names) {
      const req = MAKERS[name]!(w, D(4));
      const cashBefore = rowsOf('cash_entries'); const mvBefore = rowsOf('stock_movements'); const fundBefore = rowsOf('icecream_fund_entries'); const auditBefore = rowsOf('audit_logs');
      const out = await Promise.all(Array.from({ length: 6 }, () => send(w, req)));
      const statuses = out.map((o) => o.status).sort();
      expect(statuses, `${name}: ${JSON.stringify(out.map((o) => [o.status, code(o)]))}`).toEqual([200, 200, 200, 200, 200, 201]);
      // a single control run with a fresh clientRef writes the same number of ledger rows as the six identical requests did together
      const delta = [rowsOf('cash_entries') - cashBefore, rowsOf('stock_movements') - mvBefore, rowsOf('icecream_fund_entries') - fundBefore, rowsOf('audit_logs') - auditBefore];
      const ctl = MAKERS[name]!(w, D(4));
      const c0 = [rowsOf('cash_entries'), rowsOf('stock_movements'), rowsOf('icecream_fund_entries'), rowsOf('audit_logs')];
      const cr = await send(w, ctl);
      if (cr.status === 201 && name !== 'count') { // (a second cash count of the same figure legitimately has no difference to post)
        const delta2 = [rowsOf('cash_entries') - c0[0]!, rowsOf('stock_movements') - c0[1]!, rowsOf('icecream_fund_entries') - c0[2]!, rowsOf('audit_logs') - c0[3]!];
        expect(delta, `${name}: six concurrent duplicates wrote a different number of rows than one request`).toEqual(delta2);
      }
    }
    await assertGlobalInvariants(w.s);
  });

  it('a repeated clientRef returns the ORIGINAL record (same id), and reusing it for different content is refused or answers the original, never a second record', async () => {
    const req = MAKERS.expense!(w, D(4));
    const a = await send(w, req); const b = await send(w, req);
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.item.id).toBe(a.body.item.id);
    const other = { ...req.body, amountCents: 99999 };
    const before = rowsOf('expenses');
    const c = await post(w.s.app, '/expenses', other);
    expect([200, 409, 400]).toContain(c.status);
    if (c.status === 200) expect(c.body.item.amountCents, 'a duplicate must return the original amount, not the new one').toBe(1000);
    expect(rowsOf('expenses')).toBe(before);
    // the same clientRef on two different documents of the same kind in different books
    const t1 = await post(w.s.app, '/cash-transfers', { businessDate: D(4), fromBook: 'shop', toBook: 'telecom', amountCents: 100, clientRef: 'dupe-ref-0001' });
    const t2 = await post(w.s.app, '/cash-transfers', { businessDate: D(4), fromBook: 'telecom', toBook: 'shop', amountCents: 100, clientRef: 'dupe-ref-0001' });
    expect(t1.status).toBe(201);
    expect([200, 409]).toContain(t2.status);
    expect(rowsOf('cash_transfers') - 0).toBeGreaterThan(0);
    expect(Number(rows(w.s.ctx, "SELECT COUNT(*) n FROM cash_transfers WHERE client_ref = 'dupe-ref-0001'")[0]!.n)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('closed days: every write AND every void on a closed day is refused DAY_CLOSED and writes nothing', () => {
  let w: W;
  const rec: Record<string, { url: string }> = {};
  beforeAll(async () => {
    w = await world();
    const d = D(2);
    const mk = async (name: string, voidPath: (b: any) => string, r: Req, pick: (b: any) => any = (b) => b.item) => {
      const res = await send(w, r);
      if (res.status !== 201) throw new Error(`${name} setup: ${res.status} ${JSON.stringify(res.body)}`);
      rec[name] = { url: voidPath(res.body) };
      void pick;
    };
    await mk('sale', (b) => `/sales/${b.sales[0].id}/void`, MAKERS.sale!(w, d));
    await mk('purchase', (b) => `/purchases/${b.item.id}/void`, MAKERS.purchase!(w, d));
    await mk('expense', (b) => `/expenses/${b.item.id}/void`, MAKERS.expense!(w, d));
    await mk('reload', (b) => `/reload-sales/${b.item.id}/void`, MAKERS.reload!(w, d));
    await mk('ezcash', (b) => `/ezcash-sales/${b.item.id}/void`, MAKERS.ezcash!(w, d));
    await mk('topup', (b) => `/telecom/topups/${b.item.id}/void`, MAKERS.topup!(w, d));
    await mk('printSale', (b) => `/print-sales/${b.item.id}/void`, MAKERS.printSale!(w, d));
    await mk('supplies', (b) => `/printing-supplies/${b.item.id}/void`, MAKERS.supplies!(w, d));
    await mk('capital', (b) => `/capital-entries/${b.item.id}/void`, MAKERS.capital!(w, d));
    await mk('transfer', (b) => `/cash-transfers/${b.item.id}/void`, MAKERS.transfer!(w, d));
    await mk('cashDrawing', (b) => `/drawings/${b.item.id}/void`, MAKERS.cashDrawing!(w, d));
    await mk('goodsDrawing', (b) => `/drawings/${b.item.id}/void`, MAKERS.goodsDrawing!(w, d));
    await mk('loss', (b) => `/stock-losses/${b.item.id}/void`, MAKERS.loss!(w, d));
    await mk('icePayment', (b) => `/icecream/payments/${b.payment.id}/void`, MAKERS.icePayment!(w, d));
    await mk('iceMove', (b) => `/icecream/fund-moves/${b.move.id}/void`, MAKERS.iceMove!(w, d));
    await mk('iceDay', () => `/icecream/days/${d}/void`, MAKERS.iceDay!(w, d));
    const st = await stDraft(w.s, [{ productId: w.A, countedQty: 10 }], { businessDate: d, book: 'shop' });
    await must(await stComplete(w.s, st.id), 'stocktake');
    rec.stocktake = { url: `/stocktakes/${st.id}/void` };
    const cnt = await must(await post(w.s.app, '/cash-counts', { businessDate: d, book: 'shop', countedCents: 1, note: 'x', clientRef: ref() }), 'count');
    rec.count = { url: `/cash-counts/${cnt.item.id}/void` };
    for (const b of ['shop', 'telecom', 'icecream'] as const) await must(await closeNew(w.s, b, d), `close ${b}`);
  }, 120000);

  it('every dated create endpoint refuses the closed day (validation order: schema -> R-FD -> DAY_CLOSED)', async () => {
    const skip = new Set(['closing', 'iceDayPut', 'stocktake']); // a stocktake DRAFT is not a posting; completing it is (checked below)
    for (const name of Object.keys(MAKERS)) {
      if (skip.has(name)) continue;
      await refused(w, `${name} on a closed day`, () => send(w, MAKERS[name]!(w, D(2))), 409, 'DAY_CLOSED');
    }
    const draft = await stDraft(w.s, [{ productId: w.A, countedQty: 2 }], { businessDate: D(2), book: 'shop' });
    await refused(w, 'completing a stocktake on a closed day', () => post(w.s.app, `/stocktakes/${draft.id}/complete`, {}), 409, 'DAY_CLOSED');
    // the PUT replace of a closed ice cream day
    await refused(w, 'PUT ice day on closed day', () => put(w.s.app, `/icecream/days/${D(2)}`, { salesCents: 5, costAllocCents: 0, electricityAllocCents: 0, clientRef: ref() }), 409, 'DAY_CLOSED');
    // closing it again is a different documented error
    await refused(w, 'close twice', () => post(w.s.app, '/daily-closings', { book: 'shop', businessDate: D(2), clientRef: ref() }), 409, 'DAY_ALREADY_CLOSED');
  });

  it('every void of a record dated on the closed day is refused DAY_CLOSED', async () => {
    expect(Object.keys(rec).length).toBeGreaterThanOrEqual(17);
    for (const [name, r] of Object.entries(rec)) {
      await refused(w, `void ${name} on a closed day`, () => post(w.s.app, r.url, { reason: 'try' }), 409, 'DAY_CLOSED');
    }
  });

  it('a sale return dated on the closed day is refused; the other days are unaffected; reopen makes the void work and it is audited', async () => {
    await refused(w, 'return on closed day', () => send(w, MAKERS.saleReturn!(w, D(2))), 409, 'DAY_CLOSED');
    // section 8 (migration 016): the day BEFORE a closed day is protected (BACKDATE_BEFORE_CLOSED_DAY); the day AFTER is open
    await refused(w, 'the day before a closed day', () => send(w, MAKERS.expense!(w, D(3))), 409, 'BACKDATE_BEFORE_CLOSED_DAY');
    const ok = await send(w, MAKERS.expense!(w, D(1)));
    expect(ok.status, 'the day after is open').toBe(201);
    const closings = (await get(w.s.app, '/daily-closings?book=shop')).body.items as any[];
    const c = closings.find((x) => x.businessDate === D(2) && x.isClosed)!;
    const before = Number(rows(w.s.ctx, "SELECT COUNT(*) n FROM audit_logs WHERE action = 'reopen' OR entity LIKE '%closing%'")[0]!.n);
    await must(await post(w.s.app, `/daily-closings/${c.id}/reopen`, { reason: 'qa reopen' }), 'reopen');
    expect(Number(rows(w.s.ctx, "SELECT COUNT(*) n FROM audit_logs WHERE action = 'reopen' OR entity LIKE '%closing%'")[0]!.n), 'reopen is audited').toBeGreaterThan(before);
    const v = await post(w.s.app, rec.expense!.url, { reason: 'now fine' });
    expect(v.status).toBe(200);
    await assertGlobalInvariants(w.s);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('voids: twice, at the same time, and with dependents', () => {
  let w: W;
  beforeAll(async () => { w = await world(); }, 120000);

  it('voiding anything twice is 409 ALREADY_VOID and changes nothing the second time', async () => {
    const list: Array<[string, Req, (b: any) => string]> = [
      ['sale', MAKERS.sale!(w, D(5)), (b) => `/sales/${b.sales[0].id}/void`],
      ['purchase', MAKERS.purchase!(w, D(5)), (b) => `/purchases/${b.item.id}/void`],
      ['expense', MAKERS.expense!(w, D(5)), (b) => `/expenses/${b.item.id}/void`],
      ['reload', MAKERS.reload!(w, D(5)), (b) => `/reload-sales/${b.item.id}/void`],
      ['ezcash', MAKERS.ezcash!(w, D(5)), (b) => `/ezcash-sales/${b.item.id}/void`],
      ['topup', MAKERS.topup!(w, D(5)), (b) => `/telecom/topups/${b.item.id}/void`],
      ['print', MAKERS.printSale!(w, D(5)), (b) => `/print-sales/${b.item.id}/void`],
      ['supplies', MAKERS.supplies!(w, D(5)), (b) => `/printing-supplies/${b.item.id}/void`],
      ['capital', MAKERS.capital!(w, D(5)), (b) => `/capital-entries/${b.item.id}/void`],
      ['transfer', MAKERS.transfer!(w, D(5)), (b) => `/cash-transfers/${b.item.id}/void`],
      ['cash drawing', MAKERS.cashDrawing!(w, D(5)), (b) => `/drawings/${b.item.id}/void`],
      ['goods drawing', MAKERS.goodsDrawing!(w, D(5)), (b) => `/drawings/${b.item.id}/void`],
      ['loss', MAKERS.loss!(w, D(5)), (b) => `/stock-losses/${b.item.id}/void`],
      ['ice payment', MAKERS.icePayment!(w, D(5)), (b) => `/icecream/payments/${b.payment.id}/void`],
      ['ice move', MAKERS.iceMove!(w, D(5)), (b) => `/icecream/fund-moves/${b.move.id}/void`],
      ['ice day', MAKERS.iceDay!(w, D(5)), () => `/icecream/days/${D(5)}/void`],
      ['count', { method: 'POST', url: '/cash-counts', body: { businessDate: D(5), book: 'telecom', countedCents: 1, note: 'x', clientRef: ref() } }, (b) => `/cash-counts/${b.item.id}/void`],
    ];
    for (const [name, req, urlOf] of list) {
      const made = await send(w, req);
      expect(made.status, `${name}: ${JSON.stringify(made.body).slice(0, 200)}`).toBe(201);
      const url = urlOf(made.body);
      const first = await post(w.s.app, url, { reason: 'first' });
      expect(first.status, `${name} first void: ${JSON.stringify(first.body)}`).toBe(200);
      // (the ice cream daily entry is addressed by date: once voided there is no posted entry any more -> 404 NOT_FOUND; reported as a gap, API_CONTRACTS says ALREADY_VOID)
      if (name === 'ice day') await refused(w, `${name} second void`, () => post(w.s.app, url, { reason: 'second' }), [404, 409], ['NOT_FOUND', 'ALREADY_VOID']);
      else await refused(w, `${name} second void`, () => post(w.s.app, url, { reason: 'second' }), 409, 'ALREADY_VOID');
    }
    await assertGlobalInvariants(w.s);
  });

  it('two simultaneous voids of the same record: exactly one succeeds, the other is ALREADY_VOID, and the reversal is written once', async () => {
    for (const [name, req, urlOf] of [
      ['sale', MAKERS.sale!(w, D(5)), (b: any) => `/sales/${b.sales[0].id}/void`],
      ['expense', MAKERS.expense!(w, D(5)), (b: any) => `/expenses/${b.item.id}/void`],
      ['transfer', MAKERS.transfer!(w, D(5)), (b: any) => `/cash-transfers/${b.item.id}/void`],
      ['ice payment', MAKERS.icePayment!(w, D(5)), (b: any) => `/icecream/payments/${b.payment.id}/void`],
    ] as Array<[string, Req, (b: any) => string]>) {
      const made = await send(w, req);
      const url = urlOf(made.body);
      const cash0 = Number(rows(w.s.ctx, 'SELECT COALESCE(SUM(amount_cents),0) t FROM cash_entries')[0]!.t);
      const out = await Promise.all([post(w.s.app, url, { reason: 'a' }), post(w.s.app, url, { reason: 'b' }), post(w.s.app, url, { reason: 'c' })]);
      expect(out.map((o) => o.status).sort(), name).toEqual([200, 409, 409]);
      expect(out.filter((o) => o.status === 409).every((o) => code(o) === 'ALREADY_VOID'), name).toBe(true);
      // the void reversed the original exactly once: the ledger total is now the total from BEFORE the record existed
      const reversals = Number(rows(w.s.ctx, 'SELECT COUNT(*) n FROM cash_entries WHERE reverses_entry_id IS NOT NULL')[0]!.n);
      const originalsReversed = Number(rows(w.s.ctx, 'SELECT COUNT(DISTINCT reverses_entry_id) n FROM cash_entries WHERE reverses_entry_id IS NOT NULL')[0]!.n);
      expect(reversals, `${name}: each original reversed at most once`).toBe(originalsReversed);
      void cash0;
    }
    await assertGlobalInvariants(w.s);
  });

  it('dependents block the void: returns exist (sale, purchase), stock already consumed (purchase, opening batch), damaged-return loss, ice cream release guard', async () => {
    // sale with a return: sale1 already has a return in the world
    await refused(w, 'void sale with return', () => post(w.s.app, `/sales/${w.sale1.id}/void`, { reason: 'x' }), 409, 'HAS_RETURNS');
    // purchase with a return
    const p = await buy(w.s, [{ productId: w.B, packs: 1, packSize: 4, lineTotalCents: 40000 }], { businessDate: D(5) });
    await must(await post(w.s.app, `/purchases/${p.id}/returns`, { businessDate: D(4), items: [{ purchaseItemId: p.items[0].id, units: 1 }], clientRef: ref() }), 'purchase return');
    await refused(w, 'void purchase with return', () => post(w.s.app, `/purchases/${p.id}/void`, { reason: 'x' }), 409, 'HAS_RETURNS');
    // purchase whose stock has been sold on: W.K 50 units bought, sell 49, void -> only 1 on hand
    await sellOk(w.s, [cl(w.K, 49, 1000)], { businessDate: D(5) });
    await refused(w, 'void purchase after its stock was sold', () => post(w.s.app, `/purchases/${w.pK.id}/void`, { reason: 'x' }), 422, 'INSUFFICIENT_STOCK');
    // opening stock batch consumed
    const ob = await must(await post(w.s.app, '/opening-stock', { businessDate: D(11), items: [{ productId: w.B, qty: 3, totalValueCents: 3000 }], clientRef: ref() }), 'opening stock');
    await sellOk(w.s, [cl(w.B, 12, 4000)], { businessDate: D(5) }); // B had 10 - 2 + 3 + 3 = ... sells nearly everything
    await refused(w, 'void consumed opening batch', () => post(w.s.app, `/opening-stock/${ob.item.id}/void`, { reason: 'x' }), 409, 'OPENING_BATCH_IN_USE');
    // the loss created by a DAMAGED sales return cannot be voided on its own
    const sale = (await sellOk(w.s, [cl(w.A, 2, 5000)], { businessDate: D(5) })).sales[0];
    await returnOk(w.s, sale.id, [{ saleItemId: sale.items[0].id, qty: 1, resalable: false }], { businessDate: D(4) });
    const lossId = Number(rows(w.s.ctx, "SELECT id FROM stock_losses WHERE source = 'damaged_return'")[0]!.id);
    await refused(w, 'void damaged-return loss', () => post(w.s.app, `/stock-losses/${lossId}/void`, { reason: 'x' }), 409, 'DAMAGED_RETURN_LOSS');
    await assertGlobalInvariants(w.s);
  });

  it('D2 guard: a daily entry or a re-label that a release depends on cannot be voided until the release is reversed', async () => {
    const w2 = await world();
    // day S 10,000 C 6,000 E 1,000 -> Unspent Materials 6,000; release 5,000 Cost -> Profit (all eligible)
    const day = D(8);
    await dayOk(w2.s, { businessDate: day, salesCents: 1000000, costAllocCents: 600000, electricityAllocCents: 100000 });
    const rel = await moveOk(w2.s, 'cost', 'profit', 500000, { businessDate: D(8) });
    await refused(w2, 'void the day a release depends on', () => post(w2.s.app, `/icecream/days/${day}/void`, { reason: 'x' }), [409, 422], 'VOID_BREAKS_RELEASE');
    const r = await post(w2.s.app, `/icecream/fund-moves/${rel.id}/void`, { reason: 'reverse the release' });
    expect(r.status, 'voiding a release only loosens the limits').toBe(200);
    const v = await post(w2.s.app, `/icecream/days/${day}/void`, { reason: 'now fine' });
    expect(v.status).toBe(200);
    await assertGlobalInvariants(w2.s);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('negative stock is impossible', () => {
  let w: W;
  beforeAll(async () => { w = await world(); }, 120000);
  const pool = async (id: number) => { const p = (await get(w.s.app, `/products/${id}`)).body.item; return [p.qtyOnHand, p.stockValueCents]; };

  it('sale, cart of several lines, loss, goods drawing, purchase return and stocktake can never take more than is on hand', async () => {
    const [q0, v0] = await pool(w.B); // B: 10 bought, 2 sold -> 8
    expect(q0).toBe(8);
    await refused(w, 'sale of 9 when 8 on hand', () => post(w.s.app, '/sales', { businessDate: D(1), items: [{ productId: w.B, qty: 9, unitPriceCents: 4000 }], clientRef: ref() }), 422, 'INSUFFICIENT_STOCK');
    await refused(w, 'cart 5 + 4 of the same product', () => post(w.s.app, '/sales', { businessDate: D(1), items: [{ productId: w.B, qty: 5, unitPriceCents: 4000 }, { productId: w.B, qty: 4, unitPriceCents: 4000 }], clientRef: ref() }), 422, 'INSUFFICIENT_STOCK');
    await refused(w, 'loss of 9', () => post(w.s.app, '/stock-losses', { businessDate: D(1), productId: w.B, qty: 9, reason: 'lost', clientRef: ref() }), 422, 'INSUFFICIENT_STOCK');
    await refused(w, 'goods drawing of 9', () => post(w.s.app, '/drawings', { kind: 'goods', businessDate: D(1), productId: w.B, qty: 9, clientRef: ref() }), 422, 'INSUFFICIENT_STOCK');
    await refused(w, 'stocktake counting -1', () => post(w.s.app, '/stocktakes', { businessDate: D(1), book: 'shop', items: [{ productId: w.B, countedQty: -1 }], clientRef: ref() }), 400, 'VALIDATION_ERROR');
    expect(await pool(w.B)).toEqual([q0, v0]);
    // sell all but one, then try to return a purchase for more units than remain
    await sellOk(w.s, [cl(w.B, 7, 4000)], { businessDate: D(2) });
    await refused(w, 'purchase return of 10 with 1 on hand', () => post(w.s.app, `/purchases/${w.pB.id}/returns`, { businessDate: D(1), items: [{ purchaseItemId: w.pB.items[0].id, units: 10 }], clientRef: ref() }), 422, 'INSUFFICIENT_STOCK');
    expect((await pool(w.B))[0]).toBe(1);
    // selling the last unit empties the pool: value must be exactly zero (no leftover cents)
    await sellOk(w.s, [cl(w.B, 1, 4000)], { businessDate: D(1) });
    expect(await pool(w.B)).toEqual([0, 0]);
    await refused(w, 'sale from an empty pool', () => post(w.s.app, '/sales', { businessDate: D(1), items: [{ productId: w.B, qty: 1, unitPriceCents: 4000 }], clientRef: ref() }), 422, 'INSUFFICIENT_STOCK');
    await assertGlobalInvariants(w.s);
  });

  it('a sale line whose cost is below the automatic cost is refused COST_BELOW_AUTOMATIC (422) and writes nothing', async () => {
    await refused(w, 'cost below automatic', () => post(w.s.app, '/sales', { businessDate: D(1), items: [{ productId: w.A, qty: 1, unitPriceCents: 5000, unitCostCents: 1 }], clientRef: ref() }), 422, 'COST_BELOW_AUTOMATIC');
  });

  it('a sale whose total would not fit in exact integer arithmetic is refused (100 lines x 1,000,000 x Rs 9,999,999.99)', async () => {
    const big = await mkProduct(w.s, { name: 'Overflow probe' });
    await must(await post(w.s.app, '/purchases', { businessDate: D(1), items: [{ productId: big.id, packs: 1_000_000, packSize: 1_000_000, lineTotalCents: 0 }], clientRef: ref() }), 'huge purchase');
    const items = Array.from({ length: 100 }, () => ({ productId: big.id, qty: 1_000_000, unitPriceCents: 999_999_999 }));
    await refused(w, 'overflowing sale', () => post(w.s.app, '/sales', { businessDate: D(1), items, clientRef: ref() }), 400, 'VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('electricity is never an expense or cost category (E1-E5)', () => {
  let w: W;
  beforeAll(async () => { w = await world(); }, 120000);

  it('Shop and Telecom expenses: every spelling, case and spacing of electricity is refused; Ice Cream expenses are refused too', async () => {
    const variants = ['electricity', 'Electricity', 'ELECTRICITY', ' electricity', 'electricity ', '\telectricity\t', 'electricity\n', 'ElEcTrIcItY'];
    for (const book of ['shop', 'telecom']) for (const category of variants) {
      await refused(w, `${book} expense "${JSON.stringify(category)}"`, () => post(w.s.app, '/expenses', { businessDate: D(1), book, category, amountCents: 100, description: 'bill', clientRef: ref() }), 400, 'ELECTRICITY_NOT_ALLOWED');
    }
    for (const category of ['electricity bill', 'electric', 'power', 'elec', '​electricity', 'electricity ']) for (const book of ['shop', 'telecom']) {
      const before = snapshotAll(w.s.ctx);
      const r = await post(w.s.app, '/expenses', { businessDate: D(1), book, category, amountCents: 100, description: 'bill', clientRef: ref() });
      expect(r.status, `${book} "${category}" must not be stored`).toBe(400);
      expect(diffSnapshots(before, snapshotAll(w.s.ctx))).toEqual([]);
    }
    for (const category of ['electricity', 'rent']) {
      await refused(w, `ice cream book expense ${category}`, () => post(w.s.app, '/expenses', { businessDate: D(1), book: 'icecream', category, amountCents: 100, description: 'x', clientRef: ref() }), 400, ['USE_ICECREAM_PAYMENTS', 'ELECTRICITY_NOT_ALLOWED']);
    }
  });

  it('Ice Cream payments: the electricity category is refused on every kind (the bill itself is a settlement, never an expense)', async () => {
    for (const kind of ['materials', 'other_cost', 'electricity_bill']) for (const category of ['electricity', 'Electricity', ' ELECTRICITY ', 'electricity\n']) {
      await refused(w, `ice ${kind} category ${JSON.stringify(category)}`, () => post(w.s.app, '/icecream/payments', { businessDate: D(1), kind, fund: 'cost', amountCents: 100, category, description: 'x', clientRef: ref() }), 400, 'ELECTRICITY_NOT_ALLOWED');
    }
  });

  it('the database itself refuses an electricity expense (CHECK) even when written with raw SQL, and the DB holds no electricity row', async () => {
    const c = w.s.ctx.database.conn;
    expect(() => c.prepare(`INSERT INTO expenses (business_date, book, category, amount_cents, description, status, client_ref) VALUES (?, 'shop', 'electricity', 100, 'x', 'posted', 'sqlref-0001')`).run(D(1))).toThrow();
    expect(() => c.prepare(`INSERT INTO expenses (business_date, book, category, amount_cents, description, status, client_ref) VALUES (?, 'icecream', 'rent', 100, 'x', 'posted', 'sqlref-0002')`).run(D(1))).toThrow();
    expect(Number(rows(w.s.ctx, "SELECT COUNT(*) n FROM expenses WHERE lower(category) LIKE '%electric%'")[0]!.n)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('Ice Cream daily entry edge cases', () => {
  let w: W;
  beforeAll(async () => { w = await world(); }, 120000);

  it('items that do not add up to the sales total are refused ITEMS_TOTAL_MISMATCH (even by 1 cent); matching items are accepted; zero-quantity items are a 400', async () => {
    const body = (items: any[], salesCents = 1000) => ({ businessDate: D(1), salesCents, costAllocCents: 100, electricityAllocCents: 100, items, clientRef: ref() });
    await refused(w, 'items 999 vs 1000', () => post(w.s.app, '/icecream/days', body([{ itemName: 'x', qty: 3, unitPriceCents: 333 }])), 422, 'ITEMS_TOTAL_MISMATCH');
    await refused(w, 'items 1001 vs 1000', () => post(w.s.app, '/icecream/days', body([{ itemName: 'x', qty: 1, unitPriceCents: 1001 }])), 422, 'ITEMS_TOTAL_MISMATCH');
    await refused(w, 'qty 0', () => post(w.s.app, '/icecream/days', body([{ itemName: 'x', qty: 0, unitPriceCents: 1000 }])), 400, 'VALIDATION_ERROR');
    await refused(w, 'negative price', () => post(w.s.app, '/icecream/days', body([{ itemName: 'x', qty: 1, unitPriceCents: -1000 }])), 400, 'VALIDATION_ERROR');
    const ok = await post(w.s.app, '/icecream/days', body([{ itemName: 'cone', qty: 2, unitPriceCents: 300 }, { itemName: 'cup', qty: 4, unitPriceCents: 100 }]));
    expect(ok.status).toBe(201);
    // a negative profit share (cost + electricity > sales) needs the explicit confirmation
    await refused(w, 'negative share unconfirmed', () => post(w.s.app, '/icecream/days', { businessDate: D(2), salesCents: 100, costAllocCents: 90, electricityAllocCents: 20, clientRef: ref() }), 422, 'NEGATIVE_PROFIT_UNCONFIRMED');
    // second entry for the same date
    await refused(w, 'second entry for a date', () => post(w.s.app, '/icecream/days', body([])), 409, 'DAY_EXISTS');
    await assertGlobalInvariants(w.s);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('returns, warnings, cash counts as-of a date, report/dashboard query validation', () => {
  let w: W;
  beforeAll(async () => { w = await world(); }, 120000);

  it('return rules: more than sold, the same line twice, a line of another sale, a voided sale, a missing flag', async () => {
    const sale = (await sellOk(w.s, [cl(w.A, 3, 5000)], { businessDate: D(5) })).sales[0];
    const item = sale.items[0].id;
    const body = (items: any[]) => ({ businessDate: D(4), items, clientRef: ref() });
    await refused(w, 'return 4 of 3', () => post(w.s.app, `/sales/${sale.id}/returns`, body([{ saleItemId: item, qty: 4, resalable: true }])), 422, 'RETURN_EXCEEDS_SOLD');
    await refused(w, 'same line twice', () => post(w.s.app, `/sales/${sale.id}/returns`, body([{ saleItemId: item, qty: 1, resalable: true }, { saleItemId: item, qty: 1, resalable: true }])), 400, ['VALIDATION_ERROR']);
    await refused(w, 'line of another sale', () => post(w.s.app, `/sales/${sale.id}/returns`, body([{ saleItemId: w.unusedSaleItem, qty: 1, resalable: true }])), 400, ['VALIDATION_ERROR']);
    await refused(w, 'missing resalable flag', () => post(w.s.app, `/sales/${sale.id}/returns`, body([{ saleItemId: item, qty: 1 }])), 400, 'VALIDATION_ERROR');
    await refused(w, 'qty 0', () => post(w.s.app, `/sales/${sale.id}/returns`, body([{ saleItemId: item, qty: 0, resalable: true }])), 400, 'VALIDATION_ERROR');
    await returnOk(w.s, sale.id, [{ saleItemId: item, qty: 3, resalable: true }], { businessDate: D(4) });
    await refused(w, 'return after everything was returned', () => post(w.s.app, `/sales/${sale.id}/returns`, body([{ saleItemId: item, qty: 1, resalable: true }])), 422, 'RETURN_EXCEEDS_SOLD');
    const s2 = (await sellOk(w.s, [cl(w.A, 1, 5000)], { businessDate: D(5) })).sales[0];
    await must(await post(w.s.app, `/sales/${s2.id}/void`, { reason: 'x' }), 'void');
    await refused(w, 'return of a voided sale', () => post(w.s.app, `/sales/${s2.id}/returns`, body([{ saleItemId: s2.items[0].id, qty: 1, resalable: true }])), 409, 'SALE_VOID');
    // refunds: the exact remainder rule - three partial returns of a line sold at an awkward total add up to exactly the revenue
    const s3 = (await sellOk(w.s, [cl(w.A, 7, 1333)], { businessDate: D(5) })).sales[0]; // revenue 9,331
    const got: number[] = [];
    for (const q of [2, 3, 2]) got.push((await returnOk(w.s, s3.id, [{ saleItemId: s3.items[0].id, qty: q, resalable: true }], { businessDate: D(3) })).item.refundCents);
    expect(got.reduce((a, b) => a + b, 0), 'refunds add up to the revenue exactly').toBe(9331);
    expect(got).toEqual([2666, 3999, 2666]); // 9,331x2/7 = 2,665.99 -> 2,666 ; x3/7 = 3,998.99 -> 3,999 ; the last takes the remainder 9,331 - 2,666 - 3,999 = 2,666
    await assertGlobalInvariants(w.s);
  });

  it('spending more than the book holds is a WARNING, never a block (R13)', async () => {
    const r = await post(w.s.app, '/expenses', { businessDate: D(1), book: 'telecom', category: 'other', amountCents: 999_000_000, description: 'huge', clientRef: ref() });
    expect(r.status).toBe(201);
    expect(r.body.warnings.some((x: any) => x.code === 'NEGATIVE_CASH_BALANCE' && x.book === 'telecom')).toBe(true);
    await assertGlobalInvariants(w.s);
  });

  it('a cash count dated in the past expects the balance AS OF that date, ignoring later entries', async () => {
    const asOf = (d: string, book: string) => Number(rows(w.s.ctx, 'SELECT COALESCE(SUM(amount_cents),0) t FROM cash_entries WHERE book = ? AND business_date <= ?', book, d)[0]!.t);
    await must(await post(w.s.app, '/capital', { businessDate: D(3), book: 'shop', amountCents: 777000, clientRef: ref() }), 'capital');
    const expected = asOf(D(4), 'shop');
    expect(expected).not.toBe(asOf(D(0), 'shop')); // a later entry exists, so the two differ
    const api = (await get(w.s.app, `/cash-counts/expected?book=shop&businessDate=${D(4)}`)).body.expectedCents;
    expect(api).toBe(expected);
    const c = await must(await post(w.s.app, '/cash-counts', { businessDate: D(4), book: 'shop', countedCents: expected + 150, note: 'over', clientRef: ref() }), 'count');
    expect([c.item.expectedCents, c.item.differenceCents]).toEqual([expected, 150]);
    await assertGlobalInvariants(w.s);
  });

  it('report and dashboard queries: bad dates, from > to, > 3,660 days, unknown granularity/parameters are 400; future asOf is accepted', async () => {
    const bad = [
      '/reports/pnl/shop?from=2025-13-01&to=2025-12-31&granularity=month', '/reports/pnl/shop?from=2025-02-01&to=2025-01-01&granularity=month',
      '/reports/pnl/shop?from=2000-01-01&to=2025-01-01&granularity=day', '/reports/pnl/shop?from=2025-01-01&to=2025-02-01&granularity=week',
      '/reports/pnl/shop?from=2025-01-01&to=2025-02-01&granularity=month&bogus=1', '/reports/pnl/shop?to=2025-02-01&granularity=month',
      '/reports/pnl/combined?from=abc&to=2025-02-01&granularity=month', '/dashboard?asOf=abc', '/dashboard?asOf=2025-02-30', '/dashboard?bogus=1',
      '/reports/inventory/valuation?asOf=2026-02-30', '/icecream/funds?asOf=nope', '/cashbooks/vault', '/reports/export-pack?from=2025-02-01&to=2025-01-01',
    ];
    for (const u of bad) {
      const r = await get(w.s.app, u);
      expect([400, 404], `${u} -> ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`).toContain(r.status);
    }
    const fut = await get(w.s.app, '/dashboard?asOf=2099-12-31');
    expect(fut.status).toBe(200);
    const f2 = await get(w.s.app, `/reports/pnl/shop?from=2098-01-01&to=2099-12-31&granularity=month`);
    expect(f2.status, 'future report dates are never rejected').toBe(200);
    expect(f2.body.totals.netProfitCents).toBe(0);
  });

  it('later changes to master data never change history: commission rates, print prices, product prices and names', async () => {
    const w3 = await world();
    const bw = await buildAugSep(w3.s);
    const snapReports = async () => JSON.stringify(await Promise.all(['shop', 'telecom', 'icecream', 'combined'].map(async (x) => (await get(w3.s.app, `/reports/pnl/${x}?from=2025-08-01&to=2025-09-30&granularity=day`)).body.rows)));
    const before = await snapReports();
    const cash0 = JSON.stringify(rows(w3.s.ctx, 'SELECT * FROM cash_entries ORDER BY id'));
    await must(await put(w3.s.app, '/settings', { rates: { reloadCommissionBp: 1500, ezcashCommissionBp: 900 } }), 'rates');
    for (const id of Object.values(bw.prov)) await must(await put(w3.s.app, `/reload-providers/${id}`, { commissionBp: 4000, active: true }), 'provider');
    for (const t of (await get(w3.s.app, '/print-service-types')).body.items as any[]) await must(await put(w3.s.app, `/print-service-types/${t.id}`, { name: t.name, priceCents: 99999, costCents: 88888, active: true }), 'type');
    for (const p of (await get(w3.s.app, '/products?limit=100')).body.items as any[]) await must(await put(w3.s.app, `/products/${p.id}`, { sellPriceCents: 999999, minPriceCents: 1, name: `${p.name} renamed` }), 'product');
    expect(await snapReports(), 'P&L by day changed after master data edits').toBe(before);
    expect(JSON.stringify(rows(w3.s.ctx, 'SELECT * FROM cash_entries ORDER BY id'))).toBe(cash0);
    await assertGlobalInvariants(w3.s);
  });
});

/** A short two-month history (reload, EZCash, print, sale, ice cream day) for the "history never changes" test. */
async function buildAugSep(s: ApiBase): Promise<{ prov: Record<string, number> }> {
  const prov = await providerIds(s);
  const P = (await mkProduct(s, { name: 'Hist P', sellPriceCents: 5000, minPriceCents: 1 })).id;
  await buy(s, [{ productId: P, packs: 1, packSize: 10, lineTotalCents: 20000 }], { businessDate: '2025-08-02' });
  await sellOk(s, [cl(P, 3, 5000)], { businessDate: '2025-08-03' });
  await must(await post(s.app, '/reload-sales', { businessDate: '2025-08-03', providerId: prov.Dialog, salesCents: 1234567, clientRef: ref() }), 'reload');
  await must(await post(s.app, '/ezcash-sales', { businessDate: '2025-08-04', billTotalCents: 765432, clientRef: ref() }), 'ez');
  const ty = (await get(s.app, '/print-service-types')).body.items[0];
  await must(await post(s.app, '/print-sales', { businessDate: '2025-09-01', serviceTypeId: ty.id, qty: 7, clientRef: ref() }), 'print');
  await dayOk(s, { businessDate: '2025-09-02', salesCents: 5000, costAllocCents: 2000, electricityAllocCents: 500 });
  return { prov };
}
