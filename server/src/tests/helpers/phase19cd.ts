// Helpers of the Phase 19 closed-day audit (BUSINESS_RULES section 8 + R9; migration 016). Independent of the phase 16 test.
// Four groups:
//  (1) dates and message builders (the audit writes the expected texts itself, never reading them from the code under test);
//  (2) fullSnapshot: a fingerprint of EVERY table (rows hashed, audit_logs included) - a refused request must leave it equal;
//  (3) the OPERATION REGISTRY: one entry per financial write (create / void / return / replace) of API_CONTRACTS, per book;
//  (4) a seeded generator and a small independent model of the closed-day rules used by the randomized and edge tests.

import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import type { AppContext } from '../../app.ts';
import type { Res } from './catalog.ts';
import { get, post } from './catalog.ts';
import { apiBase, daysAgo, mkProduct, mkTelecom, ref, today } from './inventory.ts';
import type { ApiBase } from './inventory.ts';
import { drawNew, drawVoid, lossNew, lossVoid, stComplete, stDraft, stVoid } from './phase4.ts';
import { sql } from './phase4.ts';
import { cl, returnNew, rl, sellNew, stocked, voidSaleNew } from './phase5.ts';
import { ez, ezVoid, providerIds, rel, relVoid, topProvider, topVoid, topWallet } from './phase6.ts';
import { psNew, psVoid, supNew, supVoid } from './phase7.ts';
import { capVoid, closeNew, countNew, countVoid, expNew, expVoid, openNew, reopenNew } from './phase8.ts';
import type { Book } from './phase8.ts';
import { capNew, drawCash, tr, trVoid } from './phase9.ts';
import { dayNew, dayReplace, dayVoid, moveNew, moveVoid, payNew, payVoid } from './phase10.ts';
import { importFile, mkSku, xlsx } from './phase13.ts';
import { voidReturnNew } from './phase17.ts';

export type { Book } from './phase8.ts';
export const ALL_BOOKS: readonly Book[] = ['shop', 'telecom', 'icecream'];

// ---------------------------------------------------------------------------------------------
// (1) dates and messages:  E (open, earlier) < M < C (closed) < L (open, later) <= today
// ---------------------------------------------------------------------------------------------
export const E = (): string => daysAgo(6);
export const M = (): string => daysAgo(4);
export const C = (): string => daysAgo(3);
export const L = (): string => daysAgo(1);
/** The date of seeded history (documents that must pre-exist before anything is closed). */
export const OLD = (): string => daysAgo(12);

export const LABEL: Record<Book, string> = { shop: 'Shop', telecom: 'Telecom', icecream: 'Ice Cream' };
export const closedMsg = (book: Book): string => `That day is closed for the ${LABEL[book]} cash book. Reopen it first (it will be recorded in the audit log).`;
export const backMsg = (book: Book, closed: string): string =>
  `A later day (${closed}) is already closed for the ${LABEL[book]} cash book. Entries dated before it would change a closed day. Reopen that day first, or use a date after it.`;

/** Expected error body of a DAY_CLOSED refusal. */
export const dayClosedBody = (book: Book, date: string) => ({ code: 'DAY_CLOSED', message: closedMsg(book), book, businessDate: date });
/** Expected error body of a BACKDATE_BEFORE_CLOSED_DAY refusal. */
export const backdateBody = (book: Book, closedDate: string, date: string) =>
  ({ code: 'BACKDATE_BEFORE_CLOSED_DAY', message: backMsg(book, closedDate), book, closedDate, businessDate: date });

export const ok = (r: Res): boolean => r.status === 200 || r.status === 201;
export const must = (r: Res): Res => { expect(ok(r), JSON.stringify(r.body)).toBe(true); return r; };

// ---------------------------------------------------------------------------------------------
// (2) full database fingerprint
// ---------------------------------------------------------------------------------------------
/** Every table: row count + SHA-256 of all rows (id order). Nothing is excluded except the migration log. */
export function fullSnapshot(s: { ctx: AppContext }, omit: readonly string[] = []): Record<string, string> {
  const conn = s.ctx.database.conn;
  const tables = (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'schema_migrations' ORDER BY name").all() as Array<{ name: string }>)
    .map((t) => t.name);
  const out: Record<string, string> = {};
  for (const t of tables) {
    if (omit.includes(t)) continue;
    const rows = conn.prepare(`SELECT * FROM "${t}" ORDER BY 1`).all() as Array<Record<string, unknown>>;
    out[t] = `${rows.length}:${createHash('sha256').update(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))).digest('hex')}`;
  }
  return out;
}

/** Ledger balance of a book as of a date (independent of the services). */
export const balAsOf = (s: { ctx: AppContext }, book: Book, date: string): number =>
  Number(Object.values(sql(s, 'SELECT COALESCE(SUM(amount_cents),0) AS t FROM cash_entries WHERE book = ? AND business_date <= ?', book, date)[0]!)[0]);

// ---------------------------------------------------------------------------------------------
// (3) fixtures and the operation registry
// ---------------------------------------------------------------------------------------------
/** What an operation needs, built once per test (all history is dated OLD or today, so nothing here is near a closed day). */
export interface Fx {
  s: ApiBase;
  shopP: any; telP: any;
  /** Fresh stock-less products for opening stock (so that voiding a batch is never blocked by "stock used"). */
  osShop: any; osTel: any;
  prov: Record<string, number>;
  /** Pre-existing documents (dated OLD) to be returned: one per return call. */
  sales: Array<{ shop: any[]; telecom: any[] }>;
  purchases: Array<{ shop: any[]; telecom: any[] }>;
  n: Record<string, number>;
}

const shop0 = (s: ApiBase, o: Record<string, unknown> = {}) => mkProduct(s, { minPriceCents: 0, ...o });
const tel0 = (s: ApiBase, o: Record<string, unknown> = {}) => mkTelecom(s, { minPriceCents: 0, ...o });

/** Builds the common fixture. `returns` = how many returnable sales / purchases to seed per book. */
export async function fixture(s: ApiBase, o: { returns?: number } = {}): Promise<Fx> {
  const shopP = await stocked(s, shop0, 2000, 2000000, { sellPriceCents: 3000 });
  const telP = await stocked(s, tel0, 2000, 2000000, { sellPriceCents: 3000 });
  const osShop = await mkSku(s, undefined, { minPriceCents: 0 });
  const osTel = await mkSku(s, undefined, { minPriceCents: 0, categoryId: s.ids['Scratch Cards'] });
  const prov = await providerIds(s);
  const fx: Fx = { s, shopP, telP, osShop, osTel, prov, sales: [], purchases: [], n: {} };
  const k = o.returns ?? 0;
  for (let i = 0; i < k; i++) {
    const a = await sellNew(s, [cl(shopP.id, 4, 3000)], { businessDate: OLD() });
    const b = await sellNew(s, [cl(telP.id, 4, 3000)], { businessDate: OLD() });
    fx.sales.push({ shop: a.body.sales, telecom: b.body.sales });
    const pa = await post(s.app, '/purchases', { businessDate: OLD(), items: [{ productId: shopP.id, packs: 1, packSize: 10, lineTotalCents: 10000 }], clientRef: ref() });
    const pb = await post(s.app, '/purchases', { businessDate: OLD(), items: [{ productId: telP.id, packs: 1, packSize: 10, lineTotalCents: 10000 }], clientRef: ref() });
    fx.purchases.push({ shop: [pa.body.item], telecom: [pb.body.item] });
  }
  return fx;
}
export const next = (fx: Fx, key: string): number => { fx.n[key] = (fx.n[key] ?? -1) + 1; return fx.n[key]!; };

/** One financial write. `create` returns the raw response; `void` voids what `create` made (when the API has a void). */
export interface Op {
  key: string;
  /** Every cash book the write touches (the matrix closes each one in turn; the others stay open). */
  books: Book[];
  /** Needs `fixture(..., {returns})` seeds. */
  returns?: boolean;
  /** Dates (E, C, L) of Ice Cream daily entries that must exist before the day is closed (replace operation). */
  seedDays?: boolean;
  create: (fx: Fx, date: string) => Promise<Res>;
  void?: (fx: Fx, created: Res, date: string, focus: Book) => Promise<Res>;
  /** Tables left out of the 'nothing written' comparison (a stocktake's DRAFT is a separate, non-posting write made before the completion). */
  omit?: string[];
  /** Only one posted record per book can exist at a time (opening balance): no second record, no later-date create. */
  single?: boolean;
  /** One posted record per DATE (Ice Cream daily entry): the matrix voids the old one before re-creating the same date. */
  perDate?: boolean;
  /** Voiding is not offered by the API, or is covered through the dedicated operation (e.g. returns). */
  noVoidRecord?: boolean;
}

const stockedMk = (fx: Fx, book: Book): any => (book === 'shop' ? fx.shopP : fx.telP);
const bookKey = (b: Book): 'shop' | 'telecom' => (b === 'telecom' ? 'telecom' : 'shop');

/** Per-book operations of the cash/stock families. */
function perBook(book: 'shop' | 'telecom'): Op[] {
  const sfx = `(${book})`;
  const ops: Op[] = [
    {
      key: `purchase ${sfx}`, books: [book],
      create: (fx, d) => post(fx.s.app, '/purchases', { businessDate: d, items: [{ productId: stockedMk(fx, book).id, packs: 1, packSize: 2, lineTotalCents: 2000 }], clientRef: ref() }),
      void: (fx, c) => post(fx.s.app, `/purchases/${c.body.item.id}/void`, { reason: 'audit void' }),
    },
    {
      key: `sale ${sfx}`, books: [book],
      create: (fx, d) => sellNew(fx.s, [cl(stockedMk(fx, book).id, 1, 3000)], { businessDate: d }),
      void: (fx, c) => voidSaleNew(fx.s, c.body.sales[0].id),
    },
    {
      key: `stock loss ${sfx}`, books: [book],
      create: (fx, d) => lossNew(fx.s, stockedMk(fx, book).id, 1, { businessDate: d }),
      void: (fx, c) => lossVoid(fx.s, c.body.item.id),
    },
    {
      // A draft posts nothing: the audit judges the COMPLETION (the posting) and the void of a completed stocktake.
      key: `stocktake complete ${sfx}`, books: [book], omit: ['stocktakes', 'stocktake_items', 'audit_logs', 'sqlite_sequence'],
      create: async (fx, d) => {
        const p = stockedMk(fx, book);
        const live = (await get(fx.s.app, `/products/${p.id}`)).body.item.qtyOnHand as number;
        const draft = await stDraft(fx.s, [{ productId: p.id, countedQty: live - 1 }], { businessDate: d, book });
        const done = await stComplete(fx.s, draft.id);
        return done.status === 200 ? { status: 201, body: { item: done.body.item } } : done;
      },
      void: (fx, c) => stVoid(fx.s, c.body.item.id),
    },
    {
      key: `goods drawing ${sfx}`, books: [book],
      create: (fx, d) => drawNew(fx.s, stockedMk(fx, book).id, 1, { businessDate: d }),
      void: (fx, c) => drawVoid(fx.s, c.body.item.id),
    },
    {
      key: `opening stock manual ${sfx}`, books: [book],
      create: (fx, d) => post(fx.s.app, '/opening-stock', { businessDate: d, items: [{ productId: (book === 'shop' ? fx.osShop : fx.osTel).id, qty: 1, unitCostCents: 1000 }], clientRef: ref() }),
      void: (fx, c) => post(fx.s.app, `/opening-stock/${c.body.item.id}/void`, { reason: 'audit void' }),
    },
    {
      key: `opening stock excel ${sfx}`, books: [book],
      create: async (fx, d) => {
        const p = book === 'shop' ? fx.osShop : fx.osTel;
        const r = await importFile(fx.s, await xlsx([[p.code, p.name, 1, 10, null, `n-${ref()}`]]), { date: d });
        return r.status === 201 ? { status: 201, body: { item: r.body.batch } } : r;
      },
      void: (fx, c) => post(fx.s.app, `/opening-stock/${c.body.item.id}/void`, { reason: 'audit void' }),
    },
    {
      key: `expense ${sfx}`, books: [book],
      create: (fx, d) => expNew(fx.s, { businessDate: d, book, category: 'internet' }),
      void: (fx, c) => expVoid(fx.s, c.body.item.id),
    },
    {
      key: `sale return ${sfx}`, books: [book], returns: true, noVoidRecord: false,
      create: async (fx, d) => {
        const sale = fx.sales[next(fx, 'sr')]![book][0];
        const r = await returnNew(fx.s, sale.id, [rl(sale.items[0].id, 1, true)], { businessDate: d });
        if (ok(r)) (r as any).meta = { saleId: sale.id };
        return r;
      },
      void: (fx, c) => voidReturnNew(fx.s, (c as any).meta.saleId, c.body.item.id),
    },
    {
      key: `sale return damaged ${sfx}`, books: [book], returns: true,
      create: async (fx, d) => {
        const sale = fx.sales[next(fx, 'srd')]![book][0];
        const r = await returnNew(fx.s, sale.id, [rl(sale.items[0].id, 1, false)], { businessDate: d });
        if (ok(r)) (r as any).meta = { saleId: sale.id };
        return r;
      },
      void: (fx, c) => voidReturnNew(fx.s, (c as any).meta.saleId, c.body.item.id),
    },
    {
      // The API has no void for a purchase return.
      key: `purchase return ${sfx}`, books: [book], returns: true,
      create: async (fx, d) => {
        const pu = fx.purchases[next(fx, 'pr')]![book][0];
        return post(fx.s.app, `/purchases/${pu.id}/returns`, { businessDate: d, items: [{ purchaseItemId: pu.items[0].id, units: 1 }], clientRef: ref() });
      },
    },
  ];
  return ops;
}

/** Operations that exist for any of the three books (money in and out of the drawer). */
function perCashBook(book: Book): Op[] {
  const fund = book === 'icecream' ? { fund: 'profit' } : {};
  return [
    {
      key: `cash drawing (${book})`, books: [book],
      create: (fx, d) => drawCash(fx.s, { businessDate: d, book, ...fund }),
      void: (fx, c) => drawVoid(fx.s, c.body.item.id),
    },
    {
      key: `capital (${book})`, books: [book],
      create: (fx, d) => capNew(fx.s, { businessDate: d, book, ...fund }),
      void: (fx, c) => capVoid(fx.s, c.body.item.id),
    },
    {
      key: `opening balance (${book})`, books: [book], single: true,
      create: (fx, d) => openNew(fx.s, book, { businessDate: d, ...fund }),
      void: (fx, c) => capVoid(fx.s, c.body.item.id),
    },
    {
      // Always 1,000 cents above the balance as of its date, so the adjustment (a cash entry) is never zero.
      key: `cash count with adjustment (${book})`, books: [book],
      create: (fx, d) => countNew(fx.s, book, balAsOf(fx.s, book, d) + 1000, { businessDate: d, note: 'drawer over', ...fund }),
      void: (fx, c) => countVoid(fx.s, c.body.item.id),
    },
  ];
}

const TELECOM_ONLY: Op[] = [
  {
    key: 'reload sale', books: ['telecom'],
    create: (fx, d) => rel(fx.s, fx.prov.Dialog!, 10000, { businessDate: d }),
    void: (fx, c) => relVoid(fx.s, c.body.item.id),
  },
  {
    key: 'EZCash bill', books: ['telecom'],
    create: (fx, d) => ez(fx.s, 10000, { businessDate: d }),
    void: (fx, c) => ezVoid(fx.s, c.body.item.id),
  },
  {
    key: 'provider top-up', books: ['telecom'],
    create: (fx, d) => topProvider(fx.s, fx.prov.Dialog!, 5000, { businessDate: d }),
    void: (fx, c) => topVoid(fx.s, c.body.item.id),
  },
  {
    key: 'wallet top-up', books: ['telecom'],
    create: (fx, d) => topWallet(fx.s, 5000, { businessDate: d }),
    void: (fx, c) => topVoid(fx.s, c.body.item.id),
  },
];

const SHOP_ONLY: Op[] = [
  {
    key: 'print sale', books: ['shop'],
    create: (fx, d) => psNew(fx.s, { businessDate: d }),
    void: (fx, c) => psVoid(fx.s, c.body.item.id),
  },
  {
    key: 'printing supplies', books: ['shop'],
    create: (fx, d) => supNew(fx.s, { businessDate: d }),
    void: (fx, c) => supVoid(fx.s, c.body.item.id),
  },
];

const ICE_ONLY: Op[] = [
  {
    key: 'ice cream daily entry (create)', books: ['icecream'], perDate: true,
    create: (fx, d) => dayNew(fx.s, { businessDate: d }),
    void: (fx, c) => dayVoid(fx.s, c.body.day.businessDate),
  },
  {
    // Replacement = void-and-replace of the entry of that date; the matrix seeds an entry on E, C and L first.
    key: 'ice cream daily entry (replace)', books: ['icecream'], seedDays: true,
    create: (fx, d) => dayReplace(fx.s, d),
    noVoidRecord: true,
  },
  {
    key: 'ice cream payment (materials)', books: ['icecream'],
    create: (fx, d) => payNew(fx.s, 'materials', 5000, { businessDate: d }),
    void: (fx, c) => payVoid(fx.s, c.body.payment.id),
  },
  {
    key: 'ice cream payment (electricity bill)', books: ['icecream'],
    create: (fx, d) => payNew(fx.s, 'electricity_bill', 5000, { businessDate: d }),
    void: (fx, c) => payVoid(fx.s, c.body.payment.id),
  },
  {
    key: 'ice cream payment (other cost)', books: ['icecream'],
    create: (fx, d) => payNew(fx.s, 'other_cost', 5000, { businessDate: d, fund: 'profit' }),
    void: (fx, c) => payVoid(fx.s, c.body.payment.id),
  },
  {
    // Cost -> Electricity is a re-label (no D4 confirmation) and writes NO cash entry: only the record trigger and the service guard it.
    key: 'ice cream fund move', books: ['icecream'],
    create: (fx, d) => moveNew(fx.s, 'cost', 'electricity', 100, { businessDate: d }),
    void: (fx, c) => moveVoid(fx.s, c.body.move.id),
  },
];

/** Transfers: both books are touched, in both directions; the Ice Cream side names its fund. */
function transfers(): Op[] {
  const out: Op[] = [];
  for (const from of ALL_BOOKS) {
    for (const to of ALL_BOOKS) {
      if (from === to) continue;
      out.push({
        key: `transfer ${from} -> ${to}`, books: [from, to],
        create: (fx, d) => tr(fx.s, from, to, 1000, {
          businessDate: d, ...(from === 'icecream' ? { fromFund: 'profit' } : {}), ...(to === 'icecream' ? { toFund: 'profit' } : {}),
        }),
        void: (fx, c) => trVoid(fx.s, c.body.item.id),
      });
    }
  }
  return out;
}

/** Operations that touch Shop AND Telecom with one request. */
const MIXED: Op[] = [
  {
    key: 'sale cart with a Shop and a Telecom line', books: ['shop', 'telecom'],
    create: (fx, d) => sellNew(fx.s, [cl(fx.shopP.id, 1, 3000), cl(fx.telP.id, 1, 3000)], { businessDate: d }),
    // The cart made two sales (one per book). Voiding is per sale, so the audit voids the sale of the `focus` book only.
    void: (fx, c, _d, focus) => voidSaleNew(fx.s, c.body.sales.find((x: any) => x.book === (focus === 'telecom' ? 'telecom' : 'shop')).id),
  },
  {
    key: 'opening stock batch with a Shop and a Telecom product', books: ['shop', 'telecom'],
    create: (fx, d) => post(fx.s.app, '/opening-stock', {
      businessDate: d, items: [{ productId: fx.osShop.id, qty: 1, unitCostCents: 1000 }, { productId: fx.osTel.id, qty: 1, unitCostCents: 1000 }], clientRef: ref(),
    }),
    void: (fx, c) => post(fx.s.app, `/opening-stock/${c.body.item.id}/void`, { reason: 'audit void' }),
  },
];

/** The registry: every financial write of API_CONTRACTS that has a business date. */
export function allOps(): Op[] {
  return [
    ...perBook('shop'), ...perBook('telecom'),
    ...ALL_BOOKS.flatMap((b) => perCashBook(b)),
    ...TELECOM_ONLY, ...SHOP_ONLY, ...ICE_ONLY, ...transfers(), ...MIXED,
  ];
}

export async function setupFx(env: { build: () => Promise<{ app: any; ctx: AppContext }> }, op?: Op): Promise<Fx> {
  const s = await apiBase(await env.build());
  const fx = await fixture(s, { returns: op?.returns ? 14 : 0 });
  if (op?.seedDays) {
    for (const d of [E(), M(), C(), L()]) must(await dayNew(s, { businessDate: d }));
  }
  return fx;
}

// ---------------------------------------------------------------------------------------------
// closing helpers
// ---------------------------------------------------------------------------------------------
/** Closes the given books on a date (no count); returns the closing rows by book. */
export async function closeBooks(s: ApiBase, books: Iterable<Book>, date: string): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  for (const b of books) {
    const r = await closeNew(s, b, date);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    out[b] = r.body.item;
  }
  return out;
}
export async function reopenAll(s: ApiBase, closings: Record<string, any>, reason = 'audit reopen'): Promise<void> {
  for (const c of Object.values(closings)) {
    const r = await reopenNew(s, c.id, reason);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
}
/** Re-closes (the same row is updated) every book of `closings` on `date`. */
export async function recloseAll(s: ApiBase, closings: Record<string, any>, date: string): Promise<void> {
  for (const b of Object.keys(closings)) {
    const r = await closeNew(s, b as Book, date);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
}

// ---------------------------------------------------------------------------------------------
// (4) seeded generator + independent model of the closed-day rules
// ---------------------------------------------------------------------------------------------
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The model's view of closings: per book, the set of dates currently closed. */
export type ClosedModel = Record<Book, Set<string>>;
export const emptyModel = (): ClosedModel => ({ shop: new Set(), telecom: new Set(), icecream: new Set() });

/**
 * What the closed-day rules (BUSINESS_RULES 8, written independently of services/day-closing.ts) say about a write dated `date` touching
 * `books`: 'DAY_CLOSED' wins over 'BACKDATE_BEFORE_CLOSED_DAY'; within a kind the first book in shop, telecom, icecream order is named.
 */
export function predict(model: ClosedModel, books: Iterable<Book>, date: string):
  { code: 'DAY_CLOSED'; book: Book } | { code: 'BACKDATE_BEFORE_CLOSED_DAY'; book: Book; closedDate: string } | null {
  const touched = new Set(books);
  let back: { code: 'BACKDATE_BEFORE_CLOSED_DAY'; book: Book; closedDate: string } | null = null;
  for (const b of ALL_BOOKS) {
    if (!touched.has(b)) continue;
    if (model[b].has(date)) return { code: 'DAY_CLOSED', book: b };
    const later = [...model[b]].filter((d) => d > date).sort();
    if (later.length > 0 && back === null) back = { code: 'BACKDATE_BEFORE_CLOSED_DAY', book: b, closedDate: later[later.length - 1]! };
  }
  return back;
}

/** The ledger-based property: for every currently closed day, the balance as of that day equals what the closing recorded. */
export function closedSnapshotViolations(s: { ctx: AppContext }): string[] {
  const out: string[] = [];
  const rows = sql(s, `SELECT book, business_date, expected_cents, counted_cents FROM daily_closings
                        WHERE reopened_at IS NULL OR closed_at > reopened_at`);
  for (const r of rows) {
    const want = r.counted_cents === null ? Number(r.expected_cents) : Number(r.counted_cents);
    const have = balAsOf(s, r.book as Book, r.business_date as string);
    if (have !== want) out.push(`${r.book} ${r.business_date}: ledger ${have} != closing ${want}`);
  }
  return out;
}

export { today };
