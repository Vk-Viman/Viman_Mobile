// Closed-day ordering protection through the API (BUSINESS_RULES section 8; API_CONTRACTS "Approved-decisions contract" part A; migration 016).
// Rule under test: a financial write - create, void or return - dated EARLIER than the latest currently-closed day of any cash book it touches is
// refused 409 BACKDATE_BEFORE_CLOSED_DAY (book, closedDate, businessDate); dated EXACTLY on a closed day it stays DAY_CLOSED; a later date, a book
// without closed days, and a reopened day are unaffected. The same helper (services/day-closing.ts assertDayOpen) serves every write service, so the
// matrix below runs the SAME script for every write type:
//   dates:  E = 6 days ago (the record's date)   M = 4 days ago (closed)   C = 3 days ago (closed, the LATEST)   L = yesterday   (E < M < C < L)
//   1. a record dated E is saved while everything is open;  2. M and C are closed;
//   3. create dated E  -> BACKDATE (closedDate C, the LATEST closed day), nothing written;  4. void of the record dated E -> BACKDATE, nothing written;
//   5. create dated C -> DAY_CLOSED (unchanged code + message);  create dated M -> DAY_CLOSED;  6. create dated L -> accepted (later date);
//   7. reopen C: the latest closed day is now M, so the refusal names M (a reopened day no longer counts);
//   8. reopen M: void of the old record and create dated E are accepted;  9. close M and C again: refused again.
// Then the specific rules: multi-book precedence, validation order, closing out of order, idempotent repeats, rollback, open periods.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, daysAgo, daysAhead, mkProduct, mkTelecom, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import type { Res } from './helpers/catalog.ts';
import { drawNew, drawVoid, err, lossNew, lossVoid, num, productsSnap, stComplete, stDraft, stVoid } from './helpers/phase4.ts';
import { cl, returnNew, rl, sellNew, sellOk, stocked, voidSaleNew } from './helpers/phase5.ts';
import { ez, ezVoid, providerIds, rel, relVoid, topVoid, topWallet } from './helpers/phase6.ts';
import { importFile, xlsx } from './helpers/phase13.ts';
import { psNew, psVoid, supNew, supVoid } from './helpers/phase7.ts';
import { capVoid, closeNew, closeOk, countNew, countVoid, expNew, expVoid, openNew, reopenNew, snap8 } from './helpers/phase8.ts';
import type { Book } from './helpers/phase8.ts';
import { capNew, drawCash, tr, trVoid } from './helpers/phase9.ts';
import { dayNew, dayReplace, dayVoid, moveNew, moveVoid, payNew, payVoid } from './helpers/phase10.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());

const LABEL: Record<Book, string> = { shop: 'Shop', telecom: 'Telecom', icecream: 'Ice Cream' };
const closedMsg = (book: Book) => `That day is closed for the ${LABEL[book]} cash book. Reopen it first (it will be recorded in the audit log).`;
const backMsg = (book: Book, closed: string) =>
  `A later day (${closed}) is already closed for the ${LABEL[book]} cash book. Entries dated before it would change a closed day. Reopen that day first, or use a date after it.`;
const shop0 = (s: ApiBase, o: Record<string, unknown> = {}) => mkProduct(s, { minPriceCents: 0, ...o });
const tel0 = (s: ApiBase, o: Record<string, unknown> = {}) => mkTelecom(s, { minPriceCents: 0, ...o });

const E = (): string => daysAgo(6);
const M = (): string => daysAgo(4);
const C = (): string => daysAgo(3);
const L = (): string => daysAgo(1);

/** Everything a refused request must leave untouched: ledgers, business tables, Ice Cream records, stock cache. */
const world = (s: ApiBase, omit: string[] = []) => {
  const counts = snap8(s);
  for (const t of ['icecream_days', 'icecream_payments', 'icecream_fund_moves', 'cash_transfers']) counts[t] = num(s, `SELECT COUNT(*) FROM ${t}`);
  for (const t of omit) delete counts[t];
  return { counts, stock: productsSnap(s) };
};
const ok201 = (r: Res): Res => { expect(r.status, JSON.stringify(r.body)).toBe(201); return r; };
/** Balance of a book as of a date, straight from the ledger (independent of the service). */
const balAsOf = (s: ApiBase, book: Book, date: string): number =>
  num(s, 'SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book = ? AND business_date <= ?', book, date);

interface Scenario {
  name: string;
  /** Every cash book that gets closed (the matrix closes them all; the refusal names the first in shop, telecom, icecream order). */
  book: Book;
  prep?: (s: ApiBase) => Promise<any>;
  create: (s: ApiBase, ctx: any, date: string) => Promise<Res>;
  void?: (s: ApiBase, ctx: any, created: Res) => Promise<Res>;
  /** Only ONE record per book can exist at a time (opening balance, Ice Cream daily entry per date): the matrix voids the old one first. */
  once?: boolean;
  /** At most ONE posted record exists at a time and the old one cannot be voided while the day is closed (opening balance): the matrix skips the "later date" creates. */
  single?: boolean;
  omit?: string[];
}

const scenarios: Scenario[] = [
  {
    name: 'purchase (shop)', book: 'shop',
    prep: async (s) => shop0(s),
    create: (s, p, date) => post(s.app, '/purchases', { businessDate: date, items: [{ productId: p.id, packs: 1, packSize: 2, lineTotalCents: 2000 }], clientRef: ref() }),
    void: (s, _p, c) => post(s.app, `/purchases/${c.body.item.id}/void`, { reason: 'test void' }),
  },
  {
    name: 'purchase (telecom)', book: 'telecom',
    prep: async (s) => tel0(s),
    create: (s, p, date) => post(s.app, '/purchases', { businessDate: date, items: [{ productId: p.id, packs: 1, packSize: 2, lineTotalCents: 2000 }], clientRef: ref() }),
    void: (s, _p, c) => post(s.app, `/purchases/${c.body.item.id}/void`, { reason: 'test void' }),
  },
  {
    name: 'sale (shop)', book: 'shop',
    prep: async (s) => stocked(s, shop0, 100, 100000, { sellPriceCents: 3000 }),
    create: (s, p, date) => sellNew(s, [cl(p.id, 1, 3000)], { businessDate: date }),
    void: (s, _p, c) => voidSaleNew(s, c.body.sales[0].id),
  },
  {
    name: 'sale (telecom card)', book: 'telecom',
    prep: async (s) => stocked(s, tel0, 100, 100000, { sellPriceCents: 3000 }),
    create: (s, p, date) => sellNew(s, [cl(p.id, 1, 3000)], { businessDate: date }),
    void: (s, _p, c) => voidSaleNew(s, c.body.sales[0].id),
  },
  {
    name: 'stock loss', book: 'shop',
    prep: async (s) => stocked(s, shop0, 100, 100000),
    create: (s, p, date) => lossNew(s, p.id, 1, { businessDate: date }),
    void: (s, _p, c) => lossVoid(s, c.body.item.id),
  },
  {
    name: 'stock loss (telecom product)', book: 'telecom',
    prep: async (s) => stocked(s, tel0, 100, 100000),
    create: (s, p, date) => lossNew(s, p.id, 1, { businessDate: date }),
    void: (s, _p, c) => lossVoid(s, c.body.item.id),
  },
  {
    // A stocktake DRAFT posts nothing; COMPLETING it is the posting, and that is what the ordering rule refuses.
    name: 'stocktake (complete + void)', book: 'shop', omit: ['stocktakes', 'audit_logs'],
    prep: async (s) => stocked(s, shop0, 100, 100000),
    create: async (s, p, date) => {
      const live = (await get(s.app, `/products/${p.id}`)).body.item.qtyOnHand as number;
      const draft = await stDraft(s, [{ productId: p.id, countedQty: live - 1 }], { businessDate: date });
      const done = await stComplete(s, draft.id);
      return done.status === 200 ? { status: 201, body: { item: done.body.item } } : done;
    },
    void: (s, _p, c) => stVoid(s, c.body.item.id),
  },
  {
    name: 'goods drawing', book: 'shop',
    prep: async (s) => stocked(s, shop0, 100, 100000),
    create: (s, p, date) => drawNew(s, p.id, 1, { businessDate: date }),
    void: (s, _p, c) => drawVoid(s, c.body.item.id),
  },
  {
    name: 'cash drawing (shop)', book: 'shop',
    create: (s, _c, date) => drawCash(s, { businessDate: date }),
    void: (s, _c, c) => drawVoid(s, c.body.item.id),
  },
  {
    name: 'capital (shop)', book: 'shop',
    create: (s, _c, date) => capNew(s, { businessDate: date, book: 'shop' }),
    void: (s, _c, c) => capVoid(s, c.body.item.id),
  },
  {
    name: 'capital (Ice Cream fund)', book: 'icecream',
    create: (s, _c, date) => capNew(s, { businessDate: date, book: 'icecream', fund: 'profit' }),
    void: (s, _c, c) => capVoid(s, c.body.item.id),
  },
  {
    name: 'opening stock (shop product)', book: 'shop',
    prep: async (s) => shop0(s),
    create: (s, p, date) => post(s.app, '/opening-stock', { businessDate: date, items: [{ productId: p.id, qty: 1, unitCostCents: 1000 }], clientRef: ref() }),
    void: (s, _p, c) => post(s.app, `/opening-stock/${c.body.item.id}/void`, { reason: 'test void' }),
  },
  {
    name: 'opening stock (telecom product)', book: 'telecom',
    prep: async (s) => tel0(s),
    create: (s, p, date) => post(s.app, '/opening-stock', { businessDate: date, items: [{ productId: p.id, qty: 1, unitCostCents: 1000 }], clientRef: ref() }),
    void: (s, _p, c) => post(s.app, `/opening-stock/${c.body.item.id}/void`, { reason: 'test void' }),
  },
  {
    name: 'reload', book: 'telecom',
    prep: async (s) => providerIds(s),
    create: (s, ids, date) => rel(s, ids.Dialog!, 10000, { businessDate: date }),
    void: (s, _i, c) => relVoid(s, c.body.item.id),
  },
  {
    name: 'EZCash', book: 'telecom',
    create: (s, _c, date) => ez(s, 10000, { businessDate: date }),
    void: (s, _c, c) => ezVoid(s, c.body.item.id),
  },
  {
    name: 'wallet top-up', book: 'telecom',
    create: (s, _c, date) => topWallet(s, 5000, { businessDate: date }),
    void: (s, _c, c) => topVoid(s, c.body.item.id),
  },
  {
    name: 'print sale', book: 'shop',
    create: (s, _c, date) => psNew(s, { businessDate: date }),
    void: (s, _c, c) => psVoid(s, c.body.item.id),
  },
  {
    name: 'printing supplies', book: 'shop',
    create: (s, _c, date) => supNew(s, { businessDate: date }),
    void: (s, _c, c) => supVoid(s, c.body.item.id),
  },
  {
    name: 'expense (shop)', book: 'shop',
    create: (s, _c, date) => expNew(s, { businessDate: date }),
    void: (s, _c, c) => expVoid(s, c.body.item.id),
  },
  {
    name: 'expense (telecom)', book: 'telecom',
    create: (s, _c, date) => expNew(s, { businessDate: date, book: 'telecom', category: 'internet' }),
    void: (s, _c, c) => expVoid(s, c.body.item.id),
  },
  {
    name: 'opening balance (shop)', book: 'shop', once: true, single: true,
    create: (s, _c, date) => openNew(s, 'shop', { businessDate: date }),
    void: (s, _c, c) => capVoid(s, c.body.item.id),
  },
  {
    name: 'opening balance (Ice Cream fund)', book: 'icecream', once: true, single: true,
    create: (s, _c, date) => openNew(s, 'icecream', { businessDate: date, fund: 'profit' }),
    void: (s, _c, c) => capVoid(s, c.body.item.id),
  },
  {
    // The count is always made 1,000 cents ABOVE the book's balance as of its date, so the adjustment (a cash entry) is never zero.
    name: 'cash count with an adjustment (shop)', book: 'shop',
    create: (s, _c, date) => countNew(s, 'shop', balAsOf(s, 'shop', date) + 1000, { businessDate: date, note: 'drawer over' }),
    void: (s, _c, c) => countVoid(s, c.body.item.id),
  },
  {
    name: 'cash count with an adjustment (Ice Cream)', book: 'icecream',
    create: (s, _c, date) => countNew(s, 'icecream', balAsOf(s, 'icecream', date) + 1000, { businessDate: date, note: 'drawer over', fund: 'profit' }),
    void: (s, _c, c) => countVoid(s, c.body.item.id),
  },
  {
    name: 'Ice Cream daily entry', book: 'icecream', once: true,
    create: (s, _c, date) => dayNew(s, { businessDate: date }),
    void: (s, _c, c) => dayVoid(s, c.body.day.businessDate),
  },
  {
    name: 'Ice Cream payment', book: 'icecream',
    create: (s, _c, date) => payNew(s, 'materials', 5000, { businessDate: date }),
    void: (s, _c, c) => payVoid(s, c.body.payment.id),
  },
  {
    // Cost -> Electricity is a re-label (no D4 confirmation); a move writes NO cash entry, so only the record trigger guards it.
    name: 'Ice Cream fund move', book: 'icecream',
    create: (s, _c, date) => moveNew(s, 'cost', 'electricity', 100, { businessDate: date }),
    void: (s, _c, c) => moveVoid(s, c.body.move.id),
  },
  {
    // Both books are touched: the closed book is the DESTINATION of the transfer.
    name: 'transfer Shop -> Telecom (telecom closed)', book: 'telecom',
    create: (s, _c, date) => tr(s, 'shop', 'telecom', 1000, { businessDate: date }),
    void: (s, _c, c) => trVoid(s, c.body.item.id),
  },
  {
    // ... or the SOURCE.
    name: 'transfer Shop -> Telecom (shop closed)', book: 'shop',
    create: (s, _c, date) => tr(s, 'shop', 'telecom', 1000, { businessDate: date }),
    void: (s, _c, c) => trVoid(s, c.body.item.id),
  },
  {
    name: 'transfer Telecom -> Ice Cream fund (Ice Cream closed)', book: 'icecream',
    create: (s, _c, date) => tr(s, 'telecom', 'icecream', 1000, { businessDate: date, toFund: 'profit' }),
    void: (s, _c, c) => trVoid(s, c.body.item.id),
  },
  {
    name: 'transfer Ice Cream fund -> Shop (Ice Cream closed)', book: 'icecream',
    create: (s, _c, date) => tr(s, 'icecream', 'shop', 1000, { businessDate: date, fromFund: 'profit' }),
    void: (s, _c, c) => trVoid(s, c.body.item.id),
  },
];

describe.each(scenarios)('ordering - $name', (sc) => {
  it('E < M < C: refused before the latest closed day (create AND void, exact body, nothing written); DAY_CLOSED on closed days; later dates fine; reopen restores', async () => {
    const s = await setup();
    const ctx = sc.prep ? await sc.prep(s) : undefined;

    // 1. everything is open: the first record is saved, dated E
    const first = ok201(await sc.create(s, ctx, E()));

    // 2. two days of the book are closed: M, then C (the latest)
    const cM = await closeOk(s, sc.book, M());
    const cC = await closeOk(s, sc.book, C());

    // 3. a create dated E is earlier than the latest closed day C: refused, full body, nothing written
    const before = world(s, sc.omit);
    const refused = await sc.create(s, ctx, E());
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error).toEqual({
      code: 'BACKDATE_BEFORE_CLOSED_DAY', message: backMsg(sc.book, C()), book: sc.book, closedDate: C(), businessDate: E(),
    });
    expect(world(s, sc.omit)).toEqual(before);

    // 4. a void of the record dated E is refused the same way (its reversal would copy date E)
    if (sc.void) {
      const v = await sc.void(s, ctx, first);
      expect(v.status, JSON.stringify(v.body)).toBe(409);
      expect(v.body.error).toEqual({
        code: 'BACKDATE_BEFORE_CLOSED_DAY', message: backMsg(sc.book, C()), book: sc.book, closedDate: C(), businessDate: E(),
      });
      expect(world(s, sc.omit)).toEqual(before);
    }

    // 5. exactly on a closed day it stays DAY_CLOSED (code, message and fields unchanged), for M and for C
    for (const d of [M(), C()]) {
      const r = await sc.create(s, ctx, d);
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.error).toEqual({ code: 'DAY_CLOSED', message: closedMsg(sc.book), book: sc.book, businessDate: d });
    }
    expect(world(s, sc.omit)).toEqual(before);

    // 6. a date after every closed day is fine
    const later = sc.single ? undefined : ok201(await sc.create(s, ctx, once(sc) ? today() : L()));

    // 7. reopening the LATEST closed day C: the latest closed day is now M, so the same create names M (a reopened day no longer counts)
    expect((await reopenNew(s, cC.id, 'correcting a mistake')).status).toBe(200);
    const stillRefused = await sc.create(s, ctx, E());
    expect(stillRefused.body.error).toEqual({
      code: 'BACKDATE_BEFORE_CLOSED_DAY', message: backMsg(sc.book, M()), book: sc.book, closedDate: M(), businessDate: E(),
    });
    // the reopened day C itself is no longer DAY_CLOSED, and it is later than M, so a write dated C is accepted
    const onReopened = sc.single ? undefined : ok201(await sc.create(s, ctx, once(sc) ? daysAgo(2) : C()));

    // 8. reopening M too: nothing is closed any more, so the old record can be voided and a new one dated E created
    expect((await reopenNew(s, cM.id, 'correcting a mistake')).status).toBe(200);
    if (sc.void) {
      const v = await sc.void(s, ctx, first);
      expect(v.status, JSON.stringify(v.body)).toBe(200);
    }
    const again = ok201(await sc.create(s, ctx, E()));

    // 9. closing M and C again protects E again (the re-close updated the same closing rows)
    expect((await closeNew(s, sc.book, M())).status).toBe(201);
    expect((await closeNew(s, sc.book, C())).status).toBe(201);
    const blocked = await sc.create(s, ctx, E());
    expect(blocked.status).toBe(409);
    expect(err(blocked)).toMatchObject({ code: 'BACKDATE_BEFORE_CLOSED_DAY', closedDate: C() });
    if (sc.void) {
      const v = await sc.void(s, ctx, again);
      expect(v.status).toBe(409);
      expect(err(v)).toMatchObject({ code: 'BACKDATE_BEFORE_CLOSED_DAY', closedDate: C(), businessDate: E() });
    }
    expect(later?.status ?? 201).toBe(201);
    expect(onReopened?.status ?? 201).toBe(201);
  });
});

/** `once` scenarios (one record per book / per day) use distinct dates instead of repeating L and C. */
function once(sc: Scenario): boolean { return sc.once === true; }

// =============================================================================================
describe('ordering - returns are judged on the RETURN\'s date', () => {
  it('sale return: refused before the latest closed day (even when the sale is older and its own day is open); R-RD first; later dates fine', async () => {
    const s = await setup();
    const p = await stocked(s, shop0, 100, 100000);
    const sale = (await sellOk(s, [cl(p.id, 10, 3000)], { businessDate: daysAgo(9) })).sales[0];
    const lineId = sale.items[0].id;
    await closeOk(s, 'shop', C());
    const before = world(s);
    const r = await returnNew(s, sale.id, [rl(lineId, 1, true)], { businessDate: E() });
    expect(r.status).toBe(409);
    expect(r.body.error).toEqual({ code: 'BACKDATE_BEFORE_CLOSED_DAY', message: backMsg('shop', C()), book: 'shop', closedDate: C(), businessDate: E() });
    expect(world(s)).toEqual(before);
    // exactly on the closed day: DAY_CLOSED
    expect(err(await returnNew(s, sale.id, [rl(lineId, 1, true)], { businessDate: C() })).code).toBe('DAY_CLOSED');
    // R-RD (return before the sale's own date) is reported before the closed-day checks
    expect(err(await returnNew(s, sale.id, [rl(lineId, 1, true)], { businessDate: daysAgo(10) })).code).toBe('RETURN_BEFORE_ORIGINAL_DATE');
    // the closed-day check is reported before the quantity rule
    expect(err(await returnNew(s, sale.id, [rl(lineId, 99, true)], { businessDate: E() })).code).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    // a later date works, and so does the open day after a reopen
    expect((await returnNew(s, sale.id, [rl(lineId, 1, true)], { businessDate: L() })).status).toBe(201);
    const closing = (await get(s.app, `/daily-closings?book=shop&from=${C()}&to=${C()}`)).body.items[0];
    await reopenNew(s, closing.id, 'late return');
    expect((await returnNew(s, sale.id, [rl(lineId, 1, false)], { businessDate: E() })).status).toBe(201);
  });

  it('purchase return: judged on the return date; the purchase\'s own day is irrelevant', async () => {
    const s = await setup();
    const p = await shop0(s);
    const purchase = (await post(s.app, '/purchases', { businessDate: daysAgo(9), items: [{ productId: p.id, packs: 1, packSize: 50, lineTotalCents: 50000 }], clientRef: ref() })).body.item;
    const itemId = purchase.items[0].id;
    await closeOk(s, 'shop', C());
    const ret = (date: string, units = 1) => post(s.app, `/purchases/${purchase.id}/returns`, { businessDate: date, items: [{ purchaseItemId: itemId, units }], clientRef: ref() });
    const before = world(s);
    const r = await ret(E());
    expect(r.status).toBe(409);
    expect(r.body.error).toEqual({ code: 'BACKDATE_BEFORE_CLOSED_DAY', message: backMsg('shop', C()), book: 'shop', closedDate: C(), businessDate: E() });
    expect(world(s)).toEqual(before);
    expect(err(await ret(C())).code).toBe('DAY_CLOSED');
    expect(err(await ret(E(), 999)).code).toBe('BACKDATE_BEFORE_CLOSED_DAY'); // before the quantity rule
    expect((await ret(L())).status).toBe(201);
    const closing = (await get(s.app, `/daily-closings?book=shop&from=${C()}&to=${C()}`)).body.items[0];
    await reopenNew(s, closing.id, 'late return');
    expect((await ret(E())).status).toBe(201);
  });
});

// =============================================================================================
describe('ordering - opening balance on a later date', () => {
  it.each(['shop', 'icecream'] as const)('%s: with a closed day and no opening balance yet, a later date is accepted and an earlier one refused', async (book) => {
    const s = await setup();
    const extra = book === 'icecream' ? { fund: 'profit' } : {};
    await closeOk(s, book, C());
    expect(err(await openNew(s, book, { businessDate: E(), ...extra })).code).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    ok201(await openNew(s, book, { businessDate: L(), ...extra }));
  });
});

// =============================================================================================
describe('ordering - Ice Cream daily entry replace, opening-stock import', () => {
  it('replacing the entry of a date earlier than the latest closed Ice Cream day is refused; a later date is fine', async () => {
    const s = await setup();
    ok201(await dayNew(s, { businessDate: E() }));
    ok201(await dayNew(s, { businessDate: L() }));
    await closeOk(s, 'icecream', C());
    const before = world(s);
    const r = await dayReplace(s, E());
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error).toEqual({ code: 'BACKDATE_BEFORE_CLOSED_DAY', message: backMsg('icecream', C()), book: 'icecream', closedDate: C(), businessDate: E() });
    expect(world(s)).toEqual(before);
    expect([200, 201]).toContain((await dayReplace(s, L())).status);
  });

  it('the opening-stock Excel import dated before a closed day of the product\'s book is refused with nothing saved', async () => {
    const s = await setup();
    const p = await shop0(s, { code: 'SKU-ORD16' });
    await closeOk(s, 'shop', C());
    const file = await xlsx([[p.code, p.name, 2, '10.00', null]]);
    const before = world(s);
    const r = await importFile(s, file, { date: E() });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error).toEqual({ code: 'BACKDATE_BEFORE_CLOSED_DAY', message: backMsg('shop', C()), book: 'shop', closedDate: C(), businessDate: E() });
    expect(world(s, ['import_runs'])).toEqual(before);
    expect((await importFile(s, file, { date: L() })).status).toBeLessThan(300);
  });
});

// =============================================================================================
describe('ordering - several books and precedence', () => {
  it('a book without a closed day is never affected; a closed day of another book does not matter; backdating into an open book still works', async () => {
    const s = await setup();
    await closeOk(s, 'telecom', C());
    // Shop and Ice Cream have no closed day: backdated entries (even before Telecom's closed day) are fine
    ok201(await expNew(s, { businessDate: E() }));
    ok201(await openNew(s, 'icecream', { businessDate: daysAgo(30), fund: 'cost' }));
    ok201(await payNew(s, 'materials', 100, { businessDate: E() }));
    expect((await expNew(s, { businessDate: E(), book: 'telecom', category: 'internet' })).status).toBe(409);
    // after Telecom is reopened Telecom takes backdated entries again
    const closing = (await get(s.app, `/daily-closings?book=telecom&from=${C()}&to=${C()}`)).body.items[0];
    await reopenNew(s, closing.id, 'reopen to backdate');
    ok201(await expNew(s, { businessDate: E(), book: 'telecom', category: 'internet' }));
  });

  it('a transfer between a book WITH a closed day and one WITHOUT is refused (either direction) and names the book that has it', async () => {
    const s = await setup();
    await closeOk(s, 'telecom', C());
    const before = world(s);
    const a = await tr(s, 'shop', 'telecom', 500, { businessDate: E() });
    expect(a.status).toBe(409);
    expect(a.body.error).toEqual({ code: 'BACKDATE_BEFORE_CLOSED_DAY', message: backMsg('telecom', C()), book: 'telecom', closedDate: C(), businessDate: E() });
    const b = await tr(s, 'telecom', 'shop', 500, { businessDate: E() });
    expect(err(b)).toMatchObject({ code: 'BACKDATE_BEFORE_CLOSED_DAY', book: 'telecom' });
    expect(world(s)).toEqual(before); // neither leg was written
    // Shop <-> Ice Cream (no closed day on either): backdated transfer is fine
    ok201(await tr(s, 'shop', 'icecream', 500, { businessDate: E(), toFund: 'cost' }));
  });

  it('two books with different closed days: each one is judged against its OWN latest closed day; the first book in shop/telecom/icecream order is named', async () => {
    const s = await setup();
    await closeOk(s, 'shop', daysAgo(5)); // shop latest closed: 5 days ago
    await closeOk(s, 'telecom', C()); // telecom latest closed: 3 days ago
    // dated 4 days ago: before telecom's closed day, AFTER shop's -> only telecom refuses
    const r = await tr(s, 'shop', 'telecom', 500, { businessDate: daysAgo(4) });
    expect(err(r)).toMatchObject({ code: 'BACKDATE_BEFORE_CLOSED_DAY', book: 'telecom', closedDate: C(), businessDate: daysAgo(4) });
    // dated 6 days ago: before both -> shop is named first
    const r2 = await tr(s, 'telecom', 'shop', 500, { businessDate: E() });
    expect(err(r2)).toMatchObject({ code: 'BACKDATE_BEFORE_CLOSED_DAY', book: 'shop', closedDate: daysAgo(5), businessDate: E() });
    // after both: fine
    ok201(await tr(s, 'shop', 'telecom', 500, { businessDate: L() }));
  });

  it('DAY_CLOSED of any touched book beats BACKDATE_BEFORE_CLOSED_DAY, whichever book is first in the order', async () => {
    const s = await setup();
    await closeOk(s, 'shop', daysAgo(2)); // shop: dated 3 days ago is BEFORE a closed day
    await closeOk(s, 'telecom', C()); // telecom: dated 3 days ago is exactly ON a closed day
    const r = await tr(s, 'shop', 'telecom', 500, { businessDate: C() });
    expect(r.body.error).toEqual({ code: 'DAY_CLOSED', message: closedMsg('telecom'), book: 'telecom', businessDate: C() });
    // and the reverse: shop exact-closed, telecom backdated
    await closeOk(s, 'shop', daysAgo(5));
    await closeOk(s, 'telecom', L());
    const r2 = await tr(s, 'shop', 'telecom', 500, { businessDate: daysAgo(5) });
    expect(r2.body.error).toEqual({ code: 'DAY_CLOSED', message: closedMsg('shop'), book: 'shop', businessDate: daysAgo(5) });
  });

  it('a cart touching a shop AND a telecom product is refused when either book has a later closed day, and nothing of it is saved', async () => {
    const s = await setup();
    const a = await stocked(s, shop0, 10, 10000);
    const b = await stocked(s, tel0, 10, 10000);
    await closeOk(s, 'telecom', C());
    const before = world(s);
    const r = await sellNew(s, [cl(a.id, 1, 3000), cl(b.id, 1, 3000)], { businessDate: E() });
    expect(r.status).toBe(409);
    expect(err(r)).toMatchObject({ code: 'BACKDATE_BEFORE_CLOSED_DAY', book: 'telecom', closedDate: C(), businessDate: E() });
    expect(world(s)).toEqual(before); // not even the shop half
    ok201(await sellNew(s, [cl(a.id, 1, 3000)], { businessDate: E() })); // shop-only cart: shop has no closed day
  });
});

// =============================================================================================
describe('ordering - validation order and idempotence', () => {
  it('schema -> R-FD -> lookups / R-RD -> closed-day checks -> business rules', async () => {
    const s = await setup();
    const p = await stocked(s, shop0, 5, 5000);
    await closeOk(s, 'shop', C());
    // R-FD first: a future date is reported as such (no closed-day error can apply to it anyway)
    expect(err(await expNew(s, { businessDate: daysAhead(1) })).code).toBe('FUTURE_DATE_NOT_ALLOWED');
    // schema first: a malformed date is a validation error, not a closed-day error
    expect(err(await expNew(s, { businessDate: '2026-1-1' })).code).toBe('VALIDATION_ERROR');
    // closed-day check before the later business rules
    expect(err(await sellNew(s, [cl(p.id, 999, 3000)], { businessDate: E() })).code).toBe('BACKDATE_BEFORE_CLOSED_DAY'); // INSUFFICIENT_STOCK later
    expect(err(await lossNew(s, p.id, 999, { businessDate: E() })).code).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    expect(err(await drawNew(s, p.id, 999, { businessDate: E() })).code).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    // a second opening balance for the same book: the closed-day check comes before OPENING_BALANCE_EXISTS
    ok201(await openNew(s, 'telecom', { businessDate: daysAgo(30) }));
    await closeOk(s, 'telecom', C());
    expect(err(await openNew(s, 'telecom', { businessDate: E() })).code).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    // a second daily entry for the same Ice Cream date: the closed-day check comes before DAY_EXISTS
    ok201(await dayNew(s, { businessDate: E() }));
    await closeOk(s, 'icecream', C());
    expect(err(await dayNew(s, { businessDate: E() })).code).toBe('BACKDATE_BEFORE_CLOSED_DAY');
  });

  it('a sale with a return: its void is judged on the sale\'s date (closed-day check before HAS_RETURNS)', async () => {
    const s = await setup();
    const p = await stocked(s, shop0, 5, 5000);
    const sale = (await sellOk(s, [cl(p.id, 2, 3000)], { businessDate: E() })).sales[0];
    ok201(await post(s.app, `/sales/${sale.id}/returns`, { businessDate: E(), items: [{ saleItemId: sale.items[0].id, qty: 1, resalable: true }], clientRef: ref() }));
    await closeOk(s, 'shop', C());
    expect(err(await voidSaleNew(s, sale.id)).code).toBe('BACKDATE_BEFORE_CLOSED_DAY');
  });

  it('an idempotent repeat (same clientRef) of a record dated before a closed day is answered with the saved record, never refused', async () => {
    const s = await setup();
    const clientRef = ref();
    const body = { businessDate: E(), book: 'shop', category: 'rent', amountCents: 50000, description: 'Shop rent', clientRef };
    const first = ok201(await post(s.app, '/expenses', body));
    await closeOk(s, 'shop', C());
    const repeat = await post(s.app, '/expenses', body);
    expect(repeat.status).toBe(200);
    expect(repeat.body.item.id).toBe(first.body.item.id);
    // a NEW clientRef with the same date is refused
    expect(err(await post(s.app, '/expenses', { ...body, clientRef: ref() })).code).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    // and a repeat of a transfer
    const tbody = { businessDate: daysAgo(10), fromBook: 'telecom', toBook: 'icecream', toFund: 'cost', amountCents: 100, clientRef: ref() };
    const t1 = ok201(await post(s.app, '/cash-transfers', tbody));
    await closeOk(s, 'telecom', C());
    const t2 = await post(s.app, '/cash-transfers', tbody);
    expect(t2.status).toBe(200);
    expect(t2.body.item.id).toBe(t1.body.item.id);
  });
});

// =============================================================================================
describe('ordering - closing out of order and cash counts', () => {
  it('close Wednesday, then close Tuesday: with a count VARIANCE it is refused (nothing written); without a variance it is allowed', async () => {
    const s = await setup();
    const WED = daysAgo(2);
    const TUE = daysAgo(3);
    const MON = daysAgo(4);
    ok201(await openNew(s, 'shop', { businessDate: MON, amountCents: 100000 })); // Rs 1,000.00 on Monday
    await closeOk(s, 'shop', WED); // Wednesday closed (no count)
    const before = world(s);

    // Tuesday with a count of 90,000 against an expected 100,000: variance -10,000 would post a cash_adjustment dated Tuesday -> refused
    const refused = await closeNew(s, 'shop', TUE, { countedCents: 90000, note: 'short' });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error).toEqual({ code: 'BACKDATE_BEFORE_CLOSED_DAY', message: backMsg('shop', WED), book: 'shop', closedDate: WED, businessDate: TUE });
    expect(world(s)).toEqual(before); // no count row, no adjustment, no closing row
    expect(num(s, "SELECT COUNT(*) FROM daily_closings WHERE business_date = ?", TUE)).toBe(0);

    // Tuesday closed WITHOUT a count: nothing is posted, allowed
    const noCount = ok201(await closeNew(s, 'shop', TUE));
    expect(noCount.body.item).toMatchObject({ businessDate: TUE, expectedCents: 100000, countedCents: null, overShortCents: 0 });
    // Monday with a count that MATCHES (variance 0): no cash entry, allowed
    const matching = ok201(await closeNew(s, 'shop', MON, { countedCents: 100000 }));
    expect(matching.body.item).toMatchObject({ businessDate: MON, expectedCents: 100000, countedCents: 100000, overShortCents: 0 });
    expect(num(s, "SELECT COUNT(*) FROM cash_entries WHERE type = 'cash_adjustment'")).toBe(0);
    // another book is unaffected by the shop closings
    ok201(await closeNew(s, 'telecom', MON, { countedCents: 0 }));
  });

  it('after reopening the later day the variance closing works, and the adjustment is dated like the count', async () => {
    const s = await setup();
    ok201(await openNew(s, 'shop', { businessDate: daysAgo(4), amountCents: 100000 }));
    const wed = await closeOk(s, 'shop', daysAgo(2));
    expect((await closeNew(s, 'shop', daysAgo(3), { countedCents: 90000, note: 'short' })).status).toBe(409);
    await reopenNew(s, wed.id, 'need Tuesday count first');
    const tue = ok201(await closeNew(s, 'shop', daysAgo(3), { countedCents: 90000, note: 'short' }));
    expect(tue.body.item).toMatchObject({ expectedCents: 100000, countedCents: 90000, overShortCents: -10000 });
    // re-closing Wednesday (no count) is fine; the adjustment sits on Tuesday and the closed snapshots are consistent
    ok201(await closeNew(s, 'shop', daysAgo(2)));
    expect(balAsOf(s, 'shop', daysAgo(3))).toBe(90000);
    expect(balAsOf(s, 'shop', daysAgo(2))).toBe(90000);
  });

  it('a stand-alone count: with an adjustment it follows the rule; a matching count (no cash entry) is allowed; their voids follow suit', async () => {
    const s = await setup();
    ok201(await openNew(s, 'shop', { businessDate: daysAgo(9), amountCents: 50000 }));
    const matching = ok201(await countNew(s, 'shop', 50000, { businessDate: E() })); // difference 0, no cash entry
    expect(matching.body.item.cashEntryId).toBeNull();
    const withAdj = ok201(await countNew(s, 'shop', 49000, { businessDate: E(), note: 'short 10' }));
    expect(withAdj.body.item.differenceCents).toBe(-1000);
    await closeOk(s, 'shop', C());
    const before = world(s);
    // new counts dated before the closed day: only the one with a difference is refused
    expect(err(await countNew(s, 'shop', 40000, { businessDate: E(), note: 'x' })).code).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    expect(world(s)).toEqual(before);
    ok201(await countNew(s, 'shop', 49000, { businessDate: E() })); // expected as of E is 49,000: matches
    // voids: the count with an adjustment would write a reversal dated E -> refused; the matching one moves no money -> allowed
    expect(err(await countVoid(s, withAdj.body.item.id)).code).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    expect((await countVoid(s, matching.body.item.id)).status).toBe(200);
    // exactly on the closed day both stay DAY_CLOSED
    expect(err(await countNew(s, 'shop', 49000, { businessDate: C() })).code).toBe('DAY_CLOSED');
  });
});

// =============================================================================================
describe('ordering - rollback leaves nothing', () => {
  it('a refused write inside a multi-row operation (purchase with items, sale cart, transfer) leaves every table unchanged', async () => {
    const s = await setup();
    const p = await stocked(s, shop0, 20, 20000);
    await closeOk(s, 'shop', C());
    await closeOk(s, 'telecom', C());
    const before = world(s);
    const auditBefore = num(s, 'SELECT COUNT(*) FROM audit_logs');
    await post(s.app, '/purchases', { businessDate: E(), items: [{ productId: p.id, packs: 2, packSize: 5, lineTotalCents: 9000 }], clientRef: ref() });
    await sellNew(s, [cl(p.id, 2, 3000)], { businessDate: E() });
    await tr(s, 'shop', 'telecom', 100, { businessDate: E() });
    await closeNew(s, 'shop', daysAgo(5), { countedCents: 77, note: 'x' });
    expect(world(s)).toEqual(before);
    expect(num(s, 'SELECT COUNT(*) FROM audit_logs')).toBe(auditBefore);
  });

  it('a trigger abort that slips past the service check becomes a clean 409 BACKDATE_BEFORE_CLOSED_DAY and rolls the whole write back', async () => {
    const s = await setup();
    // A later day is closed by a trigger RIGHT AFTER the service check passed and the expense row was saved, so only the
    // cash-entry trigger (the backstop) can still stop the write.
    s.ctx.database.conn.exec(`CREATE TRIGGER test_close_later_midway AFTER INSERT ON expenses
      BEGIN INSERT INTO daily_closings (book, business_date, expected_cents) VALUES (NEW.book, date(NEW.business_date, '+1 day'), 0); END`);
    const before = world(s);
    const r = await expNew(s, { businessDate: E() });
    expect(r.status).toBe(409);
    expect(err(r).code).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    expect(world(s)).toEqual(before);
    const { mapCashAbort } = await import('../services/day-closing.ts');
    let thrown: any;
    try { mapCashAbort(new Error('BACKDATE_BEFORE_CLOSED_DAY')); } catch (e) { thrown = e; }
    expect(thrown).toMatchObject({ statusCode: 409, code: 'BACKDATE_BEFORE_CLOSED_DAY' });
    // the older code is not swallowed by the newer one
    let old: any;
    try { mapCashAbort(new Error('DAY_CLOSED')); } catch (e) { old = e; }
    expect(old).toMatchObject({ statusCode: 409, code: 'DAY_CLOSED' });
  });
});
