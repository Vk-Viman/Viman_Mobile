// DAY_CLOSED enforcement across EVERY financial write service (BUSINESS_RULES section 8, R9; API_CONTRACTS Wave 2 "DAY_CLOSED enforcement").
// One shared helper (services/day-closing.ts `assertDayOpen`) is used by every service; this file proves it for each of them:
//   - a write (create, void, return) dated on a day that is CLOSED for the book it touches is refused with 409 DAY_CLOSED, the exact
//     owner wording, `error.book` and `error.businessDate`; nothing at all is written by the refused request (every table unchanged);
//   - other days and other books are unaffected (segments are disjoint); a cart touching two books is refused if EITHER is closed;
//   - a void is judged on the RECORD's date, a return on the RETURN's date; DAY_CLOSED comes before the later business rules
//     (insufficient stock, has-returns, ...) but after R-FD / R-RD;
//   - after a reopen the same writes work again; closing again blocks them again;
//   - the database trigger on cash_entries is the backstop for a write that skipped the service check.
// Each scenario is parametrised: create (twice: before and after the closing), void, other-day write, reopen, close again.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, daysAgo, mkProduct, mkTelecom, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import type { Res } from './helpers/catalog.ts';
import { drawNew, drawVoid, err, lossNew, lossVoid, num, productsSnap, stComplete, stDraft, stVoid } from './helpers/phase4.ts';
import { cl, returnNew, rl, sellNew, sellOk, stocked, voidSaleNew } from './helpers/phase5.ts';
import { ez, ezVoid, providerIds, rel, relVoid, topVoid, topWallet } from './helpers/phase6.ts';
import { importFile, xlsx } from './helpers/phase13.ts';
import { psNew, psVoid, supNew, supVoid } from './helpers/phase7.ts';
import { capVoid, closeNew, closeOk, countNew, countVoid, expNew, expVoid, openNew, reopenNew, snap8 } from './helpers/phase8.ts';
import type { Book } from './helpers/phase8.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());

const LABEL: Record<Book, string> = { shop: 'Shop', telecom: 'Telecom', icecream: 'Ice Cream' };
const closedMsg = (book: Book) => `That day is closed for the ${LABEL[book]} cash book. Reopen it first (it will be recorded in the audit log).`;
const shop0 = (s: ApiBase, o: Record<string, unknown> = {}) => mkProduct(s, { minPriceCents: 0, ...o });
const tel0 = (s: ApiBase, o: Record<string, unknown> = {}) => mkTelecom(s, { minPriceCents: 0, ...o });

/** The business day the scenarios close (a backdated day, so today stays open as the "other day"). */
const D = (): string => daysAgo(2);

/** Everything a failed request must leave untouched: all ledger/business tables plus the stock cache. */
const world = (s: ApiBase, omit: string[] = []) => {
  const counts = snap8(s);
  for (const t of omit) delete counts[t];
  return { counts, stock: productsSnap(s) };
};

interface Scenario {
  name: string;
  /** The cash book that gets closed (the one the write touches). */
  book: Book;
  /** One-off set-up on open days (stock, providers ...). */
  prep?: (s: ApiBase) => Promise<any>;
  /** A NEW record dated `date`; the response must be 201 while the day is open. */
  create: (s: ApiBase, ctx: any, date: string) => Promise<Res>;
  /** Voids a record that `create` returned. */
  void?: (s: ApiBase, ctx: any, created: Res) => Promise<Res>;
  /** The scenario can only create ONE record per book (opening balance): skip the "other day" step. */
  once?: boolean;
  /** Tables whose row count may change on a refused request (a stocktake DRAFT is saved and audited but is not a posting). */
  omit?: string[];
}

const ok201 = (r: Res): Res => { expect(r.status, JSON.stringify(r.body)).toBe(201); return r; };

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
    // A stocktake DRAFT posts nothing (so it may be saved on a closed day); COMPLETING it is the posting, and that is refused.
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
    name: 'opening balance (shop)', book: 'shop', once: true,
    create: (s, _c, date) => openNew(s, 'shop', { businessDate: date }),
    void: (s, _c, c) => capVoid(s, c.body.item.id),
  },
  {
    name: 'opening balance (Ice Cream fund)', book: 'icecream', once: true,
    create: (s, _c, date) => openNew(s, 'icecream', { businessDate: date, fund: 'profit' }),
    void: (s, _c, c) => capVoid(s, c.body.item.id),
  },
  {
    name: 'cash count (shop)', book: 'shop',
    create: (s, _c, date) => countNew(s, 'shop', 0, { businessDate: date, note: 'drawer check' }),
    void: (s, _c, c) => countVoid(s, c.body.item.id),
  },
  {
    name: 'cash count (Ice Cream)', book: 'icecream',
    create: (s, _c, date) => countNew(s, 'icecream', 0, { businessDate: date, note: 'drawer check', fund: 'profit' }),
    void: (s, _c, c) => countVoid(s, c.body.item.id),
  },
];

describe.each(scenarios)('DAY_CLOSED - $name', (sc) => {
  it('refuses create AND void on a closed day (exact message, book, date, nothing written); other days work; reopen restores; re-close blocks again', async () => {
    const s = await setup();
    const ctx = sc.prep ? await sc.prep(s) : undefined;
    const date = D();

    // 1. the day is open: the first record is saved
    const first = ok201(await sc.create(s, ctx, date));

    // 2. close the day for the book this write touches
    await closeOk(s, sc.book, date);

    // 3. create refused: 409 DAY_CLOSED with the owner wording and the book/date fields; nothing changed
    const before = world(s, sc.omit);
    const refused = await sc.create(s, ctx, date);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(err(refused)).toMatchObject({ code: 'DAY_CLOSED', message: closedMsg(sc.book), book: sc.book, businessDate: date });
    expect(world(s, sc.omit)).toEqual(before);

    // 4. void of a record dated that day refused as well (the reversal would copy the closed date)
    if (sc.void) {
      const v = await sc.void(s, ctx, first);
      expect(v.status, JSON.stringify(v.body)).toBe(409);
      expect(err(v)).toMatchObject({ code: 'DAY_CLOSED', message: closedMsg(sc.book), book: sc.book, businessDate: date });
      expect(world(s, sc.omit)).toEqual(before);
    }

    // 5. a different day of the same book is unaffected
    if (!sc.once) ok201(await sc.create(s, ctx, daysAgo(1)));

    // 6. reopen -> the same writes work again
    const closing = (await get(s.app, `/daily-closings?book=${sc.book}&from=${date}&to=${date}`)).body.items[0];
    expect((await reopenNew(s, closing.id, 'correcting a mistake')).status).toBe(200);
    if (sc.void) {
      const v = await sc.void(s, ctx, first);
      expect(v.status, JSON.stringify(v.body)).toBe(200);
    }
    const again = ok201(await sc.create(s, ctx, date));

    // 7. close again -> blocked again (the re-close updated the same closing row)
    expect((await closeNew(s, sc.book, date)).status).toBe(201);
    expect(num(s, 'SELECT COUNT(*) FROM daily_closings WHERE book = ? AND business_date = ?', sc.book, date)).toBe(1);
    const blockedAgain = await sc.create(s, ctx, date);
    expect(blockedAgain.status).toBe(409);
    expect(err(blockedAgain).code).toBe('DAY_CLOSED');
    if (sc.void) expect((await sc.void(s, ctx, again)).status).toBe(409);
  });
});

// =============================================================================================
describe('DAY_CLOSED - returns are judged on the RETURN\'s date', () => {
  it('sale return: refused when the return date is closed; the sale\'s own closed day does not matter; after reopen it works', async () => {
    const s = await setup();
    const p = await stocked(s, shop0, 100, 100000);
    const sale = (await sellOk(s, [cl(p.id, 3, 3000)], { businessDate: daysAgo(5) })).sales[0];
    const lineId = sale.items[0].id;
    await closeOk(s, 'shop', daysAgo(5)); // the SALE's day is closed - irrelevant for a return dated later
    const R = daysAgo(1);
    const rc = await closeOk(s, 'shop', R);
    const before = world(s);
    const refused = await returnNew(s, sale.id, [rl(lineId, 1, true)], { businessDate: R });
    expect(refused.status).toBe(409);
    expect(err(refused)).toMatchObject({ code: 'DAY_CLOSED', message: closedMsg('shop'), book: 'shop', businessDate: R });
    expect(world(s)).toEqual(before);
    // an open day (today) is fine, even though the original sale's day is closed
    expect((await returnNew(s, sale.id, [rl(lineId, 1, true)], { businessDate: today() })).status).toBe(201);
    // reopen the return's day: now it works
    await reopenNew(s, rc.id, 'late return');
    expect((await returnNew(s, sale.id, [rl(lineId, 1, false)], { businessDate: R })).status).toBe(201); // a damaged one this time
  });

  it('validation order: FUTURE then RETURN_BEFORE_ORIGINAL_DATE then DAY_CLOSED then the quantity rules', async () => {
    const s = await setup();
    const p = await stocked(s, shop0, 100, 100000);
    const sale = (await sellOk(s, [cl(p.id, 1, 3000)], { businessDate: daysAgo(3) })).sales[0];
    const lineId = sale.items[0].id;
    await closeOk(s, 'shop', daysAgo(4)); // closed day BEFORE the sale
    await closeOk(s, 'shop', daysAgo(1));
    // a return dated before the sale: R-RD wins over DAY_CLOSED
    const early = await returnNew(s, sale.id, [rl(lineId, 1, true)], { businessDate: daysAgo(4) });
    expect(err(early).code).toBe('RETURN_BEFORE_ORIGINAL_DATE');
    // a future date: R-FD first
    expect(err(await returnNew(s, sale.id, [rl(lineId, 1, true)], { businessDate: daysAgo(-1) })).code).toBe('FUTURE_DATE_NOT_ALLOWED');
    // a closed day AND an impossible quantity: DAY_CLOSED is reported, not RETURN_EXCEEDS_SOLD
    const both = await returnNew(s, sale.id, [rl(lineId, 99, true)], { businessDate: daysAgo(1) });
    expect(err(both).code).toBe('DAY_CLOSED');
    // an open day with the impossible quantity gives the quantity error
    expect(err(await returnNew(s, sale.id, [rl(lineId, 99, true)], { businessDate: today() })).code).toBe('RETURN_EXCEEDS_SOLD');
  });

  it('purchase return: judged on the return date; the purchase\'s own closed day does not block it', async () => {
    const s = await setup();
    const p = await shop0(s);
    const buyR = await post(s.app, '/purchases', { businessDate: daysAgo(5), items: [{ productId: p.id, packs: 1, packSize: 5, lineTotalCents: 5000 }], clientRef: ref() });
    const purchase = buyR.body.item;
    const itemId = purchase.items[0].id;
    await closeOk(s, 'shop', daysAgo(5));
    const R = daysAgo(1);
    const rc = await closeOk(s, 'shop', R);
    const ret = (date: string, units = 1) => post(s.app, `/purchases/${purchase.id}/returns`, { businessDate: date, items: [{ purchaseItemId: itemId, units }], clientRef: ref() });
    const before = world(s);
    const refused = await ret(R);
    expect(refused.status).toBe(409);
    expect(err(refused)).toMatchObject({ code: 'DAY_CLOSED', book: 'shop', businessDate: R, message: closedMsg('shop') });
    expect(world(s)).toEqual(before);
    expect((await ret(today())).status).toBe(201);
    await reopenNew(s, rc.id, 'late return');
    expect((await ret(R)).status).toBe(201);
    // DAY_CLOSED comes before the quantity rule here as well
    await closeOk(s, 'shop', daysAgo(0));
    expect(err(await ret(today(), 99)).code).toBe('DAY_CLOSED');
  });

  it('telecom card sale return is judged on the TELECOM book only', async () => {
    const s = await setup();
    const card = await stocked(s, tel0, 50, 50000);
    const sale = (await sellOk(s, [cl(card.id, 2, 2000)], { businessDate: daysAgo(4) })).sales[0];
    await closeOk(s, 'shop', daysAgo(1)); // shop closed: irrelevant
    expect((await returnNew(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: daysAgo(1) })).status).toBe(201);
    await closeOk(s, 'telecom', daysAgo(1));
    expect(err(await returnNew(s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: daysAgo(1) }))).toMatchObject({ code: 'DAY_CLOSED', book: 'telecom' });
  });
});

// =============================================================================================
describe('DAY_CLOSED - books touched and ordering before other business rules', () => {
  it('a day closed for one book never blocks another book (segments are disjoint)', async () => {
    const s = await setup();
    await closeOk(s, 'shop', D());
    expect((await expNew(s, { businessDate: D(), book: 'telecom', category: 'internet' })).status).toBe(201);
    expect((await ez(s, 10000, { businessDate: D() })).status).toBe(201);
    expect((await openNew(s, 'icecream', { businessDate: D(), fund: 'cost' })).status).toBe(201);
    expect((await countNew(s, 'telecom', 0, { businessDate: D(), note: 'x' })).status).toBe(201);
    expect(err(await expNew(s, { businessDate: D() })).code).toBe('DAY_CLOSED');
    await closeOk(s, 'icecream', D());
    expect((await expNew(s, { businessDate: D(), book: 'telecom', category: 'water' })).status).toBe(201);
    expect(err(await openNew(s, 'icecream', { businessDate: D(), fund: 'profit' }))).toMatchObject({ code: 'DAY_CLOSED', book: 'icecream' });
  });

  it('a cart with a shop AND a telecom product is refused if EITHER book is closed (the first closed book is named: shop, then telecom)', async () => {
    const s = await setup();
    const a = await stocked(s, shop0, 10, 10000);
    const b = await stocked(s, tel0, 10, 10000);
    const date = D();
    const cart = [cl(a.id, 1, 3000), cl(b.id, 1, 3000)];
    await closeOk(s, 'telecom', date);
    const before = world(s);
    const r1 = await sellNew(s, cart, { businessDate: date });
    expect(r1.status).toBe(409);
    expect(err(r1)).toMatchObject({ code: 'DAY_CLOSED', book: 'telecom', businessDate: date });
    expect(world(s)).toEqual(before); // not even the shop half was saved
    // a shop-only cart on that date is fine
    expect((await sellNew(s, [cl(a.id, 1, 3000)], { businessDate: date })).status).toBe(201);
    await closeOk(s, 'shop', date);
    const r2 = await sellNew(s, cart, { businessDate: date });
    expect(err(r2)).toMatchObject({ code: 'DAY_CLOSED', book: 'shop' });
  });

  it('DAY_CLOSED comes BEFORE the later business rules: insufficient stock (sale, loss, drawing), HAS_RETURNS and purchase-void stock checks', async () => {
    const s = await setup();
    const p = await stocked(s, shop0, 5, 5000);
    const date = D();
    const sale = (await sellOk(s, [cl(p.id, 2, 3000)], { businessDate: date })).sales[0];
    await post(s.app, `/sales/${sale.id}/returns`, { businessDate: date, items: [{ saleItemId: sale.items[0].id, qty: 1, resalable: true }], clientRef: ref() });
    await closeOk(s, 'shop', date);
    expect(err(await sellNew(s, [cl(p.id, 999, 3000)], { businessDate: date })).code).toBe('DAY_CLOSED');
    expect(err(await lossNew(s, p.id, 999, { businessDate: date })).code).toBe('DAY_CLOSED');
    expect(err(await drawNew(s, p.id, 999, { businessDate: date })).code).toBe('DAY_CLOSED');
    // the sale has a return, so a void would be HAS_RETURNS - but the closed day is reported first
    expect(err(await voidSaleNew(s, sale.id)).code).toBe('DAY_CLOSED');
  });

  it('a stocktake DRAFT is not a posting (allowed on a closed day); completing it is refused; a completed one cannot be voided on a closed day', async () => {
    const s = await setup();
    const p = await stocked(s, shop0, 10, 10000);
    const date = D();
    await closeOk(s, 'shop', date);
    const draft = await stDraft(s, [{ productId: p.id, countedQty: 9 }], { businessDate: date }); // saving a draft is fine
    const done = await stComplete(s, draft.id);
    expect(done.status).toBe(409);
    expect(err(done)).toMatchObject({ code: 'DAY_CLOSED', book: 'shop', businessDate: date });
    expect((await get(s.app, `/stocktakes/${draft.id}`)).body.item.status).toBe('draft');
    expect((await get(s.app, `/products/${p.id}`)).body.item.qtyOnHand).toBe(10);
    // a draft on an OPEN day completes, and voiding it after that day closes is refused
    const draft2 = await stDraft(s, [{ productId: p.id, countedQty: 8 }], { businessDate: daysAgo(1) });
    expect((await stComplete(s, draft2.id)).status).toBe(200);
    await closeOk(s, 'shop', daysAgo(1));
    expect(err(await stVoid(s, draft2.id)).code).toBe('DAY_CLOSED');
    // a DRAFT may still be voided (nothing was posted)
    const draft3 = await stDraft(s, [{ productId: p.id, countedQty: 7 }], { businessDate: date });
    expect((await stVoid(s, draft3.id)).status).toBe(200);
  });

  it('a stocktake of the telecom book is judged on the telecom book', async () => {
    const s = await setup();
    const c = await stocked(s, tel0, 10, 10000);
    const date = D();
    await closeOk(s, 'shop', date);
    const d1 = await stDraft(s, [{ productId: c.id, countedQty: 9 }], { businessDate: date, book: 'telecom' });
    expect((await stComplete(s, d1.id)).status).toBe(200);
    await closeOk(s, 'telecom', date);
    const d2 = await stDraft(s, [{ productId: c.id, countedQty: 8 }], { businessDate: date, book: 'telecom' });
    expect(err(await stComplete(s, d2.id))).toMatchObject({ code: 'DAY_CLOSED', book: 'telecom' });
  });

  it('opening-stock Excel import is refused on a closed day of the product\'s book (nothing saved)', async () => {
    const s = await setup();
    const p = await shop0(s, { code: 'SKU-DAYC' });
    const date = D();
    await closeOk(s, 'shop', date);
    const file = await xlsx([[p.code, p.name, 2, '10.00', null]]);
    const before = world(s);
    const r = await importFile(s, file, { date });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(err(r)).toMatchObject({ code: 'DAY_CLOSED', book: 'shop', businessDate: date });
    expect(world(s, ['import_runs'])).toEqual(before);
  });

  it('closing a day does not stop READS or reports, and a day with no records can be closed and reopened', async () => {
    const s = await setup();
    const c = await closeOk(s, 'telecom', daysAgo(10));
    expect((await get(s.app, '/expenses')).status).toBe(200);
    expect((await get(s.app, '/cashbooks/telecom')).status).toBe(200);
    expect((await reopenNew(s, c.id, 'closed by mistake')).status).toBe(200);
  });
});

// =============================================================================================
describe('DAY_CLOSED - database backstop (trigger on cash_entries)', () => {
  const insertCash = (s: ApiBase, book: string, date: string, extra = '') =>
    s.ctx.database.conn.prepare(
      `INSERT INTO cash_entries (book, business_date, type, amount_cents${extra ? ', fund' : ''}) VALUES (?, ?, ?, ?${extra ? ', ?' : ''})`,
    ).run(...[book, date, book === 'icecream' ? 'icecream_other_cost' : 'expense', -100, ...(extra ? [extra] : [])] as Array<string | number>);
  const msg = (fn: () => unknown): string => { try { fn(); } catch (e) { return (e as Error).message; } return 'no error'; };

  it('a direct cash entry into a closed day aborts with DAY_CLOSED; other books and days are fine; reopen allows it again', async () => {
    const s = await setup();
    const c = await closeOk(s, 'shop', D());
    expect(msg(() => insertCash(s, 'shop', D()))).toBe('DAY_CLOSED');
    expect(msg(() => insertCash(s, 'telecom', D()))).toBe('no error');
    expect(msg(() => insertCash(s, 'shop', daysAgo(1)))).toBe('no error');
    expect(msg(() => insertCash(s, 'icecream', D(), 'cost'))).toBe('no error');
    await reopenNew(s, c.id, 'open again');
    expect(msg(() => insertCash(s, 'shop', D()))).toBe('no error');
    await closeNew(s, 'shop', D()); // re-close
    expect(msg(() => insertCash(s, 'shop', D()))).toBe('DAY_CLOSED');
  });

  it('the closing\'s OWN over/short adjustment is never blocked by its own closing, and a refused insert leaves the ledger as it was', async () => {
    const s = await setup();
    await openNew(s, 'shop', { businessDate: D(), amountCents: 10000 });
    const before = num(s, 'SELECT COUNT(*) FROM cash_entries');
    const r = await closeNew(s, 'shop', D(), { countedCents: 9000, note: 'short' });
    expect(r.status).toBe(201);
    expect(num(s, 'SELECT COUNT(*) FROM cash_entries')).toBe(before + 1);
    expect(msg(() => insertCash(s, 'shop', D()))).toBe('DAY_CLOSED');
    expect(num(s, 'SELECT COUNT(*) FROM cash_entries')).toBe(before + 1);
  });

  it('a trigger abort that slipped past the service check becomes a clean 409 (never a 500) and rolls the whole write back', async () => {
    const s = await setup();
    // The day is closed by a trigger RIGHT AFTER the service's own check passed and the expense row was saved, so only the
    // cash-entry trigger (the backstop) can still stop the write.
    s.ctx.database.conn.exec(`CREATE TRIGGER test_close_midway AFTER INSERT ON expenses
      BEGIN INSERT INTO daily_closings (book, business_date, expected_cents) VALUES (NEW.book, NEW.business_date, 0); END`);
    const before = world(s);
    const r = await expNew(s, { businessDate: D() });
    expect(r.status).toBe(409);
    expect(err(r).code).toBe('DAY_CLOSED');
    expect(world(s)).toEqual(before); // no expense, no closing row, no audit row
    // the mapper itself, for the two aborts of this phase
    const { mapCashAbort } = await import('../services/day-closing.ts');
    let thrown: any;
    try { mapCashAbort(new Error('DAY_CLOSED')); } catch (e) { thrown = e; }
    expect(thrown).toMatchObject({ statusCode: 409, code: 'DAY_CLOSED' });
    let bad: any;
    try { mapCashAbort(new Error('INVALID_BUSINESS_DATE')); } catch (e) { bad = e; }
    expect(bad).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(() => mapCashAbort(new Error('something else'))).not.toThrow();
  });
});
