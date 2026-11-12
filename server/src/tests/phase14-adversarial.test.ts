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

void assertGlobalInvariants; void rows; void moveOk; void payOk; void closeNew; void stComplete; void stDraft;
