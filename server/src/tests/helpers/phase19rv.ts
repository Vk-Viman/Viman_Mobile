// Helpers for the PHASE 19 independent audit of "void a sales return" (BUSINESS_RULES section 4, rule R-VR, migration 017).
// Only thin request builders, ledger readers and STRUCTURAL checkers live here. Every expected MONEY figure lives in the tests, worked out by hand
// (never derived from report code). The randomized test has its own independent model (phase19-returnvoid-random.test.ts).

import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app.ts';
import { get } from './catalog.ts';
import type { ApiBase } from './inventory.ts';
import { ledgerOf, num, poolOf, reconOk, sql } from './phase4.ts';
import { rows, n1 } from './phase14.ts';

export { rows, n1 };

/** GET a period P&L (`seg` = shop | telecom | combined) and return the body. */
export async function pnl(s: { app: FastifyInstance }, seg: 'shop' | 'telecom' | 'combined', from: string, to: string, gran: 'day' | 'month' = 'month'): Promise<any> {
  const r = await get(s.app, `/reports/pnl/${seg}?from=${from}&to=${to}&granularity=${gran}`);
  if (r.status !== 200) throw new Error(`pnl ${seg} failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** The row of a day-granularity report whose label is `day`. */
export const dayRow = (body: any, day: string): any => {
  const r = body.rows.find((x: any) => x.period.label === day);
  if (!r) throw new Error(`no row ${day}`);
  return r;
};

/** Pool of a product as { qty, value } from the cache. */
export const pool = (s: { ctx: AppContext }, id: number) => poolOf(s, id);

/** (9) Stock movement reconciliation: for EVERY product the cache equals the sum of its movements, and the API reconciliation is ok. */
export async function reconAll(s: ApiBase): Promise<void> {
  for (const r of sql(s, 'SELECT id FROM products')) {
    const id = Number(r.id);
    expect(poolOf(s, id), `product ${id}: cache vs sum of movements`).toEqual(ledgerOf(s, id));
  }
  await reconOk(s);
}

/**
 * Structural duplicate / reversal checks for EVERY sales return in the database (audit item 12). Counts only; no money expectation.
 *  - posted return: exactly one refund cash entry (none when the refund is 0) of the right type/book/date/amount, no reversal entry;
 *    exactly one restock movement per RESALABLE line (qty/value as the line), no outflow movement, no sweep; one loss row per damaged line, no movement for it
 *  - void return: the above plus exactly one reversal cash entry (unique link, +refund, same book/date/type) and exactly one reversal movement per resalable line
 *    (qty -line qty) and at most one sweep per product; loss rows void
 *  - sale_items.returned_qty = qty of POSTED return lines
 */
export function assertReturnLedgers(ctx: AppContext): void {
  const returns = rows(ctx, `SELECT r.*, s.book AS book FROM sales_returns r JOIN sales s ON s.id = r.sale_id ORDER BY r.id`);
  for (const r of returns) {
    const id = Number(r.id);
    const tag = `return #${id} (${r.status})`;
    const cash = rows(ctx, `SELECT * FROM cash_entries WHERE ref_table = 'sales_returns' AND ref_id = ? ORDER BY id`, id);
    const orig = cash.filter((c) => c.reverses_entry_id === null);
    const rev = cash.filter((c) => c.reverses_entry_id !== null);
    const refund = Number(r.refund_cents);
    const want = r.book === 'shop' ? 'sale_refund' : 'card_refund';
    expect(orig.length, `${tag}: refund entries`).toBe(refund > 0 ? 1 : 0);
    if (refund > 0) {
      expect(orig[0], `${tag}: refund row`).toMatchObject({ book: r.book, type: want, amount_cents: -refund, business_date: r.business_date });
    }
    if (r.status === 'posted') {
      expect(rev.length, `${tag}: reversal entries on a posted return`).toBe(0);
    } else {
      expect(rev.length, `${tag}: reversal entries`).toBe(refund > 0 ? 1 : 0);
      if (refund > 0) {
        expect(rev[0], `${tag}: reversal row`).toMatchObject({ book: r.book, type: want, amount_cents: refund, business_date: r.business_date, reverses_entry_id: orig[0]!.id });
      }
    }
    const lines = rows(ctx, `SELECT ri.*, si.product_id AS product_id FROM sales_return_items ri JOIN sale_items si ON si.id = ri.sale_item_id WHERE ri.sales_return_id = ? ORDER BY ri.id`, id);
    const resalable = lines.filter((l) => Number(l.resalable) === 1);
    const damaged = lines.filter((l) => Number(l.resalable) === 0);
    const mv = rows(ctx, `SELECT * FROM stock_movements WHERE ref_table = 'sales_returns' AND ref_id = ? ORDER BY id`, id);
    const restock = mv.filter((m) => m.type === 'sale_return' && Number(m.qty_delta) > 0);
    const back = mv.filter((m) => m.type === 'sale_return' && Number(m.qty_delta) < 0);
    const sweeps = mv.filter((m) => m.type === 'adjustment');
    expect(mv.length, `${tag}: only restock / reversal / sweep movements`).toBe(restock.length + back.length + sweeps.length);
    expect(restock.length, `${tag}: one restock movement per resalable line`).toBe(resalable.length);
    const byProduct = (xs: Array<Record<string, any>>, f: (x: Record<string, any>) => number) => {
      const m = new Map<number, number>();
      for (const x of xs) m.set(Number(x.product_id), (m.get(Number(x.product_id)) ?? 0) + f(x));
      return m;
    };
    expect(byProduct(restock, (m) => Number(m.qty_delta)), `${tag}: restocked units per product`).toEqual(byProduct(resalable, (l) => Number(l.qty)));
    expect(byProduct(restock, (m) => Number(m.value_delta_cents)), `${tag}: restocked value per product`).toEqual(byProduct(resalable, (l) => Number(l.cogs_cents)));
    if (r.status === 'posted') {
      expect(back.length + sweeps.length, `${tag}: no outflow movement on a posted return`).toBe(0);
    } else {
      expect(back.length, `${tag}: one reversal movement per resalable line`).toBe(resalable.length);
      expect(byProduct(back, (m) => -Number(m.qty_delta)), `${tag}: reversed units per product`).toEqual(byProduct(resalable, (l) => Number(l.qty)));
      for (const [pid, n] of byProduct(sweeps, () => 1)) expect(n, `${tag}: sweeps of product ${pid}`).toBeLessThanOrEqual(1);
      for (const sw of sweeps) {
        expect(Number(sw.qty_delta), `${tag}: a sweep moves value only`).toBe(0);
        expect(Number(sw.value_delta_cents), `${tag}: a sweep removes value`).toBeLessThan(0);
      }
      // the reversal never removes more than the return restored (R4 limit)
      for (const [pid, restoredValue] of byProduct(restock, (m) => Number(m.value_delta_cents))) {
        const removed = back.filter((b) => Number(b.product_id) === pid).reduce((a, b) => a - Number(b.value_delta_cents), 0);
        expect(removed, `${tag}: removed value of product ${pid} within the restored value`).toBeLessThanOrEqual(restoredValue);
      }
    }
    // damaged lines: exactly one loss row each at the line's cost, void with the return; and NO stock movement of its own
    const losses = rows(ctx, `SELECT * FROM stock_losses WHERE sales_return_id = ? ORDER BY id`, id);
    expect(losses.length, `${tag}: one loss row per damaged line`).toBe(damaged.length);
    expect(losses.map((l) => Number(l.cost_cents)).sort((a, b) => a - b), `${tag}: loss costs`).toEqual(damaged.map((l) => Number(l.cogs_cents)).sort((a, b) => a - b));
    for (const l of losses) {
      expect(l.status, `${tag}: loss status follows the return`).toBe(r.status);
      expect(l.source).toBe('damaged_return');
      expect(n1(ctx, `SELECT COUNT(*) FROM stock_movements WHERE ref_table = 'stock_losses' AND ref_id = ?`, Number(l.id)), `${tag}: a damaged-return loss writes no stock movement`).toBe(0);
    }
    // header sums equal the line sums
    expect(lines.reduce((a, l) => a + Number(l.revenue_cents), 0), `${tag}: refund = sum of line revenue`).toBe(refund);
    expect(lines.reduce((a, l) => a + Number(l.cogs_cents), 0), `${tag}: cogs reversed = sum of line cogs`).toBe(Number(r.cogs_reversed_cents));
    expect(lines.reduce((a, l) => a + Number(l.extra_cost_cents), 0), `${tag}: extra reversed = sum of line extra`).toBe(Number(r.extra_cost_reversed_cents));
  }
  // counters
  expect(n1(ctx, `SELECT COUNT(*) FROM sale_items si WHERE si.returned_qty <>
    COALESCE((SELECT SUM(ri.qty) FROM sales_return_items ri JOIN sales_returns r ON r.id = ri.sales_return_id WHERE ri.sale_item_id = si.id AND r.status = 'posted'), 0)`),
    'returned_qty = qty of posted return lines').toBe(0);
  // a cash entry is reversed at most once; every return cash row belongs to an existing return
  expect(n1(ctx, `SELECT COUNT(*) FROM (SELECT reverses_entry_id FROM cash_entries WHERE reverses_entry_id IS NOT NULL AND ref_table = 'sales_returns' GROUP BY reverses_entry_id HAVING COUNT(*) > 1)`), 'cash entry reversed twice').toBe(0);
  expect(n1(ctx, `SELECT COUNT(*) FROM cash_entries c WHERE c.ref_table = 'sales_returns' AND NOT EXISTS (SELECT 1 FROM sales_returns r WHERE r.id = c.ref_id)`), 'orphan return cash').toBe(0);
  expect(n1(ctx, `SELECT COUNT(*) FROM stock_movements m WHERE m.ref_table = 'sales_returns' AND NOT EXISTS (SELECT 1 FROM sales_returns r WHERE r.id = m.ref_id)`), 'orphan return movement').toBe(0);
  // sale / return interplay: a void sale has no posted return
  expect(n1(ctx, `SELECT COUNT(*) FROM sales_returns r JOIN sales s ON s.id = r.sale_id WHERE s.status = 'void' AND r.status = 'posted'`), 'posted return on a void sale').toBe(0);
}

/** Count of rows of every table that a return void may touch (a refused void must leave all of them identical; we use full snapshots too). */
export const cnt = (ctx: AppContext, table: string): number => n1(ctx, `SELECT COUNT(*) FROM "${table}"`);

/** Total of a cash book from the ledger rows (cents). */
export const cashOf = (s: { ctx: AppContext }, book: string): number =>
  num(s, 'SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book = ?', book);

/** All permutations of `xs` (for "every possible void order"). */
export function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs.slice()];
  const out: T[][] = [];
  xs.forEach((x, i) => { for (const p of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...p]); });
  return out;
}

// =====================================================================================================================================
// RANDOMIZED SIMULATION with an INDEPENDENT MODEL (audit item 13). The model below is written from BUSINESS_RULES (sections 3, 4 R-VR, 8, 11, C5, C7, C13), not from the service code: it keeps its own stock pools,
// cash books (with a dated ledger for closing expectations), sale lines, returned quantities, purchases, closings and P&L attribution, predicts for EVERY operation either success (with the exact figures) or the exact
// refusal code (and status, and error fields), and after EVERY operation compares the API / database with itself and runs assertGlobalInvariants + assertReturnLedgers.
// =====================================================================================================================================
import { assertGlobalInvariants, diffSnapshots, rng14, segNetFromTables, shopIdentity, snapshotAll } from './phase14.ts';
import { post } from './catalog.ts';
import { mkProduct, mkTelecom, ref } from './inventory.ts';
import { err } from './phase4.ts';
import { mdr, voidSaleNew } from './phase5.ts';
import { closeNew, openNew, reopenNew } from './phase8.ts';
import { voidReturnNew } from './phase17.ts';
import { dash } from './phase12.ts';

type Book = 'shop' | 'telecom';
const BOOKS2: Book[] = ['shop', 'telecom'];
const DATES = Array.from({ length: 12 }, (_v, i) => `2025-03-${String(i + 1).padStart(2, '0')}`);
const M = (a: number, b: number, c: number): number => Number(mdr(BigInt(a), BigInt(b), BigInt(c)));

interface MProd { id: number; book: Book; qty: number; value: number }
interface MPur { id: number; itemId: number; pid: number; book: Book; date: string; units: number; total: number; retUnits: number; retValue: number; status: 'posted' | 'void' }
interface MLine { id: number; pid: number; qty: number; rev: number; cogs: number; extra: number }
interface MSale { id: number; book: Book; date: string; lines: MLine[]; status: 'posted' | 'void' }
interface MRetLine { lineId: number; pid: number; qty: number; res: boolean; rev: number; cogs: number; extra: number }
interface MRet { id: number; sale: MSale; date: string; status: 'posted' | 'void'; lines: MRetLine[]; refund: number }
interface Exp { status: number; code: string; extra?: Record<string, unknown> }

/** Counters of what a simulation exercised. */
export interface RvStats {
  ops: number; ok: Record<string, number>; refused: Record<string, number>;
  voidSweeps: number; voidGains: number; purchaseSweeps: number; purchaseGains: number; damagedReturns: number; multiLineReturns: number; sameProductTwoLines: number; extraCostLines: number;
}
export const newStats = (): RvStats => ({ ops: 0, ok: {}, refused: {}, voidSweeps: 0, voidGains: 0, purchaseSweeps: 0, purchaseGains: 0, damagedReturns: 0, multiLineReturns: 0, sameProductTwoLines: 0, extraCostLines: 0 });

/** The seeded random simulation. `run(n)` builds the shop through the API and executes n random operations, verifying after each one. */
export class RvSim {
  s: ApiBase; seed: number; rnd: () => number; stats: RvStats = newStats();
  prods: MProd[] = []; cash: Record<Book, number> = { shop: 0, telecom: 0 };
  ledger: Array<{ book: Book; date: string; amt: number }> = [];
  purs: MPur[] = []; sales: MSale[] = []; rets: MRet[] = [];
  /** stock adjustment COSTS (+ cost / - gain) of purchase returns, purchase voids and sales-return voids, attributed to their business date */
  adj: Array<{ book: Book; date: string; amt: number }> = [];
  closings = new Map<string, { id: number; closed: boolean }>();

  constructor(s: ApiBase, seed: number) { this.s = s; this.seed = seed; this.rnd = rng14(seed); }

  ri(a: number, b: number): number { return a + Math.floor(this.rnd() * (b - a + 1)); }
  chance(p: number): boolean { return this.rnd() < p; }
  pick<T>(xs: T[]): T { return xs[Math.floor(this.rnd() * xs.length)]!; }
  prod(id: number): MProd { return this.prods.find((p) => p.id === id)!; }

  async build(): Promise<void> {
    const s = this.s;
    for (let i = 0; i < 3; i++) this.prods.push({ id: (await mkProduct(s, { sellPriceCents: 10000, minPriceCents: 0 })).id, book: 'shop', qty: 0, value: 0 });
    for (let i = 0; i < 2; i++) this.prods.push({ id: (await mkTelecom(s, { sellPriceCents: 10000, minPriceCents: 0 })).id, book: 'telecom', qty: 0, value: 0 });
    for (const [book, amt] of [['shop', 2000000], ['telecom', 1000000]] as const) {
      expect((await openNew(s, book, { businessDate: DATES[0]!, amountCents: amt })).status).toBe(201);
      this.cash[book] += amt; this.ledger.push({ book, date: DATES[0]!, amt });
    }
  }

  // ---------------------------------------------------------------- model helpers
  closedDates(book: Book): string[] { return [...this.closings].filter(([k, v]) => v.closed && k.startsWith(`${book}|`)).map(([k]) => k.split('|')[1]!); }
  /** assertDayOpen: DAY_CLOSED of any touched book beats BACKDATE_BEFORE_CLOSED_DAY. */
  dayErr(books: Book[], date: string): Exp | null {
    let bd: Exp | null = null;
    for (const b of BOOKS2) {
      if (!books.includes(b)) continue;
      const cl = this.closedDates(b);
      if (cl.includes(date)) return { status: 409, code: 'DAY_CLOSED', extra: { book: b, businessDate: date } };
      const later = cl.filter((d) => d > date).sort();
      if (later.length > 0 && bd === null) bd = { status: 409, code: 'BACKDATE_BEFORE_CLOSED_DAY', extra: { book: b, closedDate: later[later.length - 1], businessDate: date } };
    }
    return bd;
  }
  dateFor(books: Book[]): string {
    let lo = 0;
    for (const b of books) for (const d of this.closedDates(b)) lo = Math.max(lo, DATES.indexOf(d) + 1);
    return this.chance(0.8) ? DATES[Math.min(11, lo + this.ri(0, 11 - Math.min(lo, 11)))]! : this.pick(DATES);
  }
  cashIn(book: Book, date: string, amt: number): void { if (amt !== 0) { this.cash[book] += amt; this.ledger.push({ book, date, amt }); } }
  retQtyOf(lineId: number): { qty: number; rev: number; cogs: number; extra: number } {
    const o = { qty: 0, rev: 0, cogs: 0, extra: 0 };
    for (const r of this.rets) if (r.status === 'posted') for (const l of r.lines) if (l.lineId === lineId) { o.qty += l.qty; o.rev += l.rev; o.cogs += l.cogs; o.extra += l.extra; }
    return o;
  }
  /** C5 / C7 (written from the rule): proportional part, the return that completes the line takes the exact remainder. */
  portion(total: number, qty: number, lineQty: number, doneQty: number, doneAmt: number): number {
    const remaining = Math.max(0, total - doneAmt);
    return doneQty + qty === lineQty ? remaining : Math.min(M(total, qty, lineQty), remaining);
  }
  /** Net profit of one book on one business date (null = all dates) from the model's own records. */
  profit(book: Book, date: string | null): number {
    const inD = (d: string) => date === null || d === date;
    let p = 0;
    for (const sl of this.sales) if (sl.status === 'posted' && sl.book === book && inD(sl.date)) for (const l of sl.lines) p += l.rev - l.cogs - l.extra;
    for (const r of this.rets) if (r.status === 'posted' && r.sale.book === book && inD(r.date)) for (const l of r.lines) { p -= l.rev - l.cogs - l.extra; if (!l.res) p -= l.cogs; }
    for (const e of this.adj) if (e.book === book && inD(e.date)) p -= e.amt;
    return p;
  }

  // ---------------------------------------------------------------- attempt + compare
  async attempt(kind: string, req: () => Promise<{ status: number; body: any }>, exp: Exp | null): Promise<{ status: number; body: any }> {
    this.stats.ops++;
    if (exp) {
      const before = snapshotAll(this.s.ctx);
      const r = await req();
      expect(r.status, `${kind}: expected ${exp.code}, got ${r.status} ${JSON.stringify(r.body)}`).toBe(exp.status);
      expect(err(r), `${kind}: error`).toMatchObject({ code: exp.code, ...(exp.extra ?? {}) });
      expect(diffSnapshots(before, snapshotAll(this.s.ctx)), `${kind} refused (${exp.code}) must write nothing`).toEqual([]);
      this.stats.refused[exp.code] = (this.stats.refused[exp.code] ?? 0) + 1;
      return r;
    }
    const r = await req();
    expect([200, 201], `${kind}: expected success, got ${r.status} ${JSON.stringify(r.body)}`).toContain(r.status);
    this.stats.ok[kind] = (this.stats.ok[kind] ?? 0) + 1;
    return r;
  }

  // ---------------------------------------------------------------- operations
  async opBuy(): Promise<void> {
    const p = this.pick(this.prods); const units = this.ri(1, 9);
    const unitCost = this.chance(0.3) ? (this.chance(0.5) ? this.ri(1, 15) : this.ri(500, 1200)) : this.ri(20, 400); // extreme costs move the weighted average a lot (gain / sweep paths)
    const total = this.chance(0.1) ? 0 : units * unitCost + this.ri(0, 9);
    const date = this.dateFor([p.book]);
    const body = { businessDate: date, items: [{ productId: p.id, packs: 1, packSize: units, lineTotalCents: total }], clientRef: ref() };
    const dayE = this.dayErr([p.book], date);
    const r = await this.attempt('purchase', () => post(this.s.app, '/purchases', body), dayE);
    if (dayE) return;
    p.qty += units; p.value += total; this.cashIn(p.book, date, -total);
    this.purs.push({ id: r.body.item.id, itemId: r.body.item.items[0].id, pid: p.id, book: p.book, date, units, total, retUnits: 0, retValue: 0, status: 'posted' });
  }

  async opSale(forced?: Array<{ productId: number; qty: number; unitPriceCents: number }>): Promise<void> {
    const n = forced ? 0 : this.ri(1, 4);
    const cart: Array<{ productId: number; qty: number; unitPriceCents: number; unitCostCents?: number }> = forced ? [...forced] : [];
    const avail = new Map(this.prods.map((p) => [p.id, p.qty]));
    const bookPref = this.pick(BOOKS2);
    for (let i = 0; i < n; i++) {
      const pool = this.chance(0.8) ? this.prods.filter((p) => p.book === bookPref) : this.prods;
      const stocked = pool.filter((p) => (avail.get(p.id) ?? 0) > 0);
      const p = stocked.length > 0 && this.chance(0.85) ? this.pick(stocked) : this.pick(pool);
      const have = avail.get(p.id) ?? 0;
      const qty = have > 0 && this.chance(0.92) ? this.ri(1, Math.min(6, have)) : this.ri(1, 7);
      avail.set(p.id, Math.max(0, have - qty));
      cart.push({ productId: p.id, qty, unitPriceCents: this.chance(0.08) ? 0 : this.ri(30, 900), ...(this.chance(0.3) ? { unitCostCents: this.chance(0.75) ? this.ri(350, 700) : this.ri(0, 400) } : {}) });
    }
    const books = [...new Set(cart.map((c) => this.prod(c.productId).book))];
    const date = this.dateFor(books);
    const body = { businessDate: date, items: cart, clientRef: ref() };
    // predict
    let exp: Exp | null = this.dayErr(books, date);
    const pools = new Map(this.prods.map((p) => [p.id, { qty: p.qty, value: p.value }]));
    const lines: Array<MLine & { book: Book }> = [];
    if (!exp) {
      for (const c of cart) {
        const pl = pools.get(c.productId)!;
        if (c.qty > pl.qty) { exp = { status: 422, code: 'INSUFFICIENT_STOCK', extra: { onHand: pl.qty, productId: c.productId } }; break; }
        const cogs = c.qty === pl.qty ? pl.value : M(pl.value, c.qty, pl.qty);
        pl.qty -= c.qty; pl.value -= cogs;
        let extra = 0;
        if (c.unitCostCents !== undefined) {
          const charged = c.qty * c.unitCostCents;
          if (charged < cogs) { exp = { status: 422, code: 'COST_BELOW_AUTOMATIC', extra: { minUnitCostCents: Math.ceil(cogs / c.qty) } }; break; }
          extra = charged - cogs;
        }
        lines.push({ id: 0, pid: c.productId, qty: c.qty, rev: c.qty * c.unitPriceCents, cogs, extra, book: this.prod(c.productId).book });
      }
    }
    const r = await this.attempt('sale', () => post(this.s.app, '/sales', body), exp);
    if (exp) return;
    for (const [id, pl] of pools) { const p = this.prod(id); p.qty = pl.qty; p.value = pl.value; }
    const byBook = new Map<Book, Array<MLine & { book: Book }>>();
    for (const l of lines) byBook.set(l.book, [...(byBook.get(l.book) ?? []), l]);
    expect(r.body.sales.map((x: any) => x.book)).toEqual(BOOKS2.filter((b) => byBook.has(b)));
    for (const sale of r.body.sales) {
      const mine = byBook.get(sale.book as Book)!;
      expect(sale.items.length).toBe(mine.length);
      mine.forEach((l, i) => {
        const it = sale.items[i];
        expect([it.productId, it.qty, it.revenueCents, it.cogsCents, it.extraCostCents], `sale line ${i}`).toEqual([l.pid, l.qty, l.rev, l.cogs, l.extra]);
        l.id = it.id;
        if (l.extra > 0) this.stats.extraCostLines++;
      });
      if (new Set(mine.map((l) => l.pid)).size < mine.length) this.stats.sameProductTwoLines++;
      const ms: MSale = { id: sale.id, book: sale.book, date, lines: mine.map((l) => ({ id: l.id, pid: l.pid, qty: l.qty, rev: l.rev, cogs: l.cogs, extra: l.extra })), status: 'posted' };
      this.sales.push(ms);
      this.cashIn(ms.book, date, ms.lines.reduce((a, l) => a + l.rev, 0));
    }
  }

  async opReturn(): Promise<void> {
    if (this.sales.length === 0) return this.opBuy();
    const posted = this.sales.filter((x) => x.status === 'posted');
    const sale = posted.length > 0 && this.chance(0.9) ? this.pick(posted) : this.pick(this.sales);
    const nLines = this.ri(1, Math.min(4, sale.lines.length));
    const chosen = [...sale.lines].sort(() => this.rnd() - 0.5).slice(0, nLines);
    const req = chosen.map((l) => {
      const rem = l.qty - this.retQtyOf(l.id).qty;
      return { line: l, qty: rem > 0 && !this.chance(0.05) ? this.ri(1, rem) : rem + 1, resalable: this.chance(0.7) };
    });
    const date = this.chance(0.9) ? DATES[Math.min(11, Math.max(DATES.indexOf(sale.date), 0) + this.ri(0, 3))]! : this.pick(DATES);
    const body = { businessDate: date, items: req.map((q) => ({ saleItemId: q.line.id, qty: q.qty, resalable: q.resalable })), clientRef: ref() };
    let exp: Exp | null = null;
    if (date < sale.date) exp = { status: 400, code: 'RETURN_BEFORE_ORIGINAL_DATE' };
    else exp = this.dayErr([sale.book], date);
    if (!exp && sale.status === 'void') exp = { status: 409, code: 'SALE_VOID' };
    if (!exp && req.some((q) => q.qty > q.line.qty - this.retQtyOf(q.line.id).qty)) exp = { status: 422, code: 'RETURN_EXCEEDS_SOLD' };
    const r = await this.attempt('return', () => post(this.s.app, `/sales/${sale.id}/returns`, body), exp);
    if (exp) return;
    const lines: MRetLine[] = req.map((q) => {
      const so = this.retQtyOf(q.line.id);
      return { lineId: q.line.id, pid: q.line.pid, qty: q.qty, res: q.resalable,
        rev: this.portion(q.line.rev, q.qty, q.line.qty, so.qty, so.rev), cogs: this.portion(q.line.cogs, q.qty, q.line.qty, so.qty, so.cogs), extra: this.portion(q.line.extra, q.qty, q.line.qty, so.qty, so.extra) };
    });
    const refund = lines.reduce((a, l) => a + l.rev, 0);
    const it = r.body.item;
    expect([it.refundCents, it.cogsReversedCents, it.extraCostReversedCents], 'return totals').toEqual([refund, lines.reduce((a, l) => a + l.cogs, 0), lines.reduce((a, l) => a + l.extra, 0)]);
    for (const l of lines) {
      const x = it.items.find((y: any) => y.saleItemId === l.lineId);
      expect([x.qty, x.resalable, x.revenueCents, x.cogsCents, x.extraCostCents], 'return line').toEqual([l.qty, l.res, l.rev, l.cogs, l.extra]);
      if (l.res) { const p = this.prod(l.pid); p.qty += l.qty; p.value += l.cogs; }
    }
    if (lines.some((l) => !l.res)) this.stats.damagedReturns++;
    if (lines.length > 1) this.stats.multiLineReturns++;
    this.cashIn(sale.book, date, -refund);
    this.rets.push({ id: it.id, sale, date, status: 'posted', lines, refund });
  }

  /** Targeted: leave exactly the returned units of a product in stock (sell the surplus), then void that return - the pool value then decides gain / sweep / plain removal. */
  async opSweepHunt(): Promise<void> {
    const cands = this.rets.filter((r) => r.status === 'posted' && r.lines.some((l) => l.res));
    if (cands.length === 0) return this.opVoidReturn();
    const ret = this.pick(cands);
    const need = new Map<number, number>();
    for (const l of ret.lines) if (l.res) need.set(l.pid, (need.get(l.pid) ?? 0) + l.qty);
    const [pid, q] = this.pick([...need]);
    const surplus = this.prod(pid).qty - q;
    if (surplus > 0 && this.chance(0.9)) { await this.opSale([{ productId: pid, qty: surplus, unitPriceCents: this.ri(30, 900) }]); await this.verify(true); }
    await this.opVoidReturn(ret);
  }

  async opVoidReturn(forced?: MRet): Promise<void> {
    if (this.rets.length === 0) return this.opReturn();
    const postedR = this.rets.filter((r) => r.status === 'posted');
    let ret: MRet;
    if (forced) ret = forced;
    else if (postedR.length > 0 && this.chance(0.5)) ret = postedR[postedR.length - 1]!;
    else if (postedR.length > 0 && this.chance(0.85)) ret = this.pick(postedR);
    else ret = this.pick(this.rets);
    let exp: Exp | null = null;
    if (ret.status === 'void') exp = { status: 409, code: 'ALREADY_VOID' };
    if (!exp) {
      const mine = new Set(ret.lines.map((l) => l.lineId));
      const newer = this.rets.filter((o) => o.id > ret.id && o.status === 'posted' && o.lines.some((l) => mine.has(l.lineId)));
      if (newer.length > 0) exp = { status: 409, code: 'RETURN_NOT_NEWEST', extra: { newerReturnId: Math.max(...newer.map((o) => o.id)) } };
    }
    if (!exp) exp = this.dayErr([ret.sale.book], ret.date);
    if (!exp) {
      const need = new Map<number, number>();
      for (const l of ret.lines) if (l.res) need.set(l.pid, (need.get(l.pid) ?? 0) + l.qty);
      for (const [pid, q] of need) if (this.prod(pid).qty < q) { exp = { status: 409, code: 'RETURN_STOCK_NOT_AVAILABLE', extra: { productId: pid, onHand: this.prod(pid).qty, needed: q } }; break; }
    }
    const r = await this.attempt('void-return', () => voidReturnNew(this.s, ret.sale.id, ret.id, 'random void'), exp);
    if (exp) return;
    expect(r.body.item.status).toBe('void');
    let cost = 0;
    for (const l of ret.lines) {
      if (!l.res) continue;
      const p = this.prod(l.pid);
      const removed = Math.min(l.cogs, p.value);
      let sweep = 0;
      if (p.qty - l.qty === 0 && p.value - removed > 0) sweep = p.value - removed;
      p.qty -= l.qty; p.value -= removed + sweep;
      cost += sweep - (l.cogs - removed);
      if (sweep > 0) this.stats.voidSweeps++;
      if (l.cogs - removed > 0) this.stats.voidGains++;
    }
    ret.status = 'void';
    this.cashIn(ret.sale.book, ret.date, ret.refund);
    if (cost !== 0) this.adj.push({ book: ret.sale.book, date: ret.date, amt: cost });
  }

  async opVoidSale(): Promise<void> {
    if (this.sales.length === 0) return this.opBuy();
    const sale = this.chance(0.7) ? this.pick(this.sales.filter((x) => x.status === 'posted').concat(this.sales.slice(-1))) : this.pick(this.sales);
    let exp: Exp | null = this.dayErr([sale.book], sale.date);
    if (!exp && sale.status === 'void') exp = { status: 409, code: 'ALREADY_VOID' };
    if (!exp && this.rets.some((r) => r.sale === sale && r.status === 'posted')) exp = { status: 409, code: 'HAS_RETURNS' };
    await this.attempt('void-sale', () => voidSaleNew(this.s, sale.id, 'random sale void'), exp);
    if (exp) return;
    for (const l of sale.lines) { const p = this.prod(l.pid); p.qty += l.qty; p.value += l.cogs; }
    this.cashIn(sale.book, sale.date, -sale.lines.reduce((a, l) => a + l.rev, 0));
    sale.status = 'void';
  }

  async opPurchaseReturn(): Promise<void> {
    if (this.purs.length === 0) return this.opBuy();
    const pur = this.pick(this.purs);
    const rem = pur.units - pur.retUnits;
    const units = rem > 0 && !this.chance(0.05) ? this.ri(1, rem) : rem + 1;
    const date = this.chance(0.9) ? DATES[Math.min(11, DATES.indexOf(pur.date) + this.ri(0, 4))]! : this.pick(DATES);
    const body = { businessDate: date, items: [{ purchaseItemId: pur.itemId, units }], clientRef: ref() };
    const p = this.prod(pur.pid);
    let exp: Exp | null = null;
    if (date < pur.date) exp = { status: 400, code: 'RETURN_BEFORE_ORIGINAL_DATE' };
    else exp = this.dayErr([pur.book], date);
    if (!exp && pur.status === 'void') exp = { status: 409, code: 'PURCHASE_VOID' };
    if (!exp && units > rem) exp = { status: 422, code: 'RETURN_EXCEEDS_PURCHASED' };
    if (!exp && units > p.qty) exp = { status: 422, code: 'INSUFFICIENT_STOCK' };
    const r = await this.attempt('purchase-return', () => post(this.s.app, `/purchases/${pur.id}/returns`, body), exp);
    if (exp) return;
    const portion = this.portion(pur.total, units, pur.units, pur.retUnits, pur.retValue);
    expect(r.body.item.refundCents).toBe(portion);
    const removed = Math.min(portion, p.value);
    let sweep = 0;
    if (p.qty - units === 0 && p.value - removed > 0) sweep = p.value - removed;
    p.qty -= units; p.value -= removed + sweep;
    this.cashIn(pur.book, date, portion);
    pur.retUnits += units; pur.retValue += portion;
    if (sweep > 0) this.stats.purchaseSweeps++;
    if (portion - removed > 0) this.stats.purchaseGains++;
    if (sweep - (portion - removed) !== 0) this.adj.push({ book: pur.book, date, amt: sweep - (portion - removed) });
  }

  async opPurchaseVoid(): Promise<void> {
    if (this.purs.length === 0) return this.opBuy();
    const pur = this.pick(this.purs);
    const p = this.prod(pur.pid);
    let exp: Exp | null = this.dayErr([pur.book], pur.date);
    if (!exp && pur.status === 'void') exp = { status: 409, code: 'ALREADY_VOID' };
    if (!exp && pur.retUnits > 0) exp = { status: 409, code: 'HAS_RETURNS' };
    if (!exp && pur.units > p.qty) exp = { status: 422, code: 'INSUFFICIENT_STOCK' };
    await this.attempt('purchase-void', () => post(this.s.app, `/purchases/${pur.id}/void`, { reason: 'random purchase void' }), exp);
    if (exp) return;
    const removed = Math.min(pur.total, p.value);
    let sweep = 0;
    if (p.qty - pur.units === 0 && p.value - removed > 0) sweep = p.value - removed;
    p.qty -= pur.units; p.value -= removed + sweep;
    this.cashIn(pur.book, pur.date, pur.total);
    pur.status = 'void';
    if (sweep > 0) this.stats.purchaseSweeps++;
    if (pur.total - removed > 0) this.stats.purchaseGains++;
    if (sweep - (pur.total - removed) !== 0) this.adj.push({ book: pur.book, date: pur.date, amt: sweep - (pur.total - removed) });
  }

  async opClose(): Promise<void> {
    const book = this.pick(BOOKS2);
    const open = DATES.filter((d) => !this.closedDates(book).includes(d));
    if (open.length === 0) return;
    const date = this.pick(open);
    const r = await this.attempt('close', () => closeNew(this.s, book, date), null);
    const expected = this.ledger.filter((e) => e.book === book && e.date <= date).reduce((a, e) => a + e.amt, 0);
    expect(r.body.item.expectedCents, 'closing expected cash').toBe(expected);
    this.closings.set(`${book}|${date}`, { id: r.body.item.id, closed: true });
  }

  async opReopen(): Promise<void> {
    if (this.closings.size === 0) return this.opClose();
    const [key, c] = this.pick([...this.closings]);
    const exp: Exp | null = c.closed ? null : { status: 409, code: 'DAY_NOT_CLOSED' };
    await this.attempt('reopen', () => reopenNew(this.s, c.id, 'random reopen'), exp);
    if (!exp) this.closings.set(key, { id: c.id, closed: false });
  }

  // ---------------------------------------------------------------- the comparison after every operation
  async verify(full: boolean): Promise<void> {
    const s = this.s;
    for (const r of rows(s.ctx, 'SELECT id, qty_on_hand q, stock_value_cents v FROM products')) {
      const p = this.prod(Number(r.id));
      expect([Number(r.q), Number(r.v)], `product ${r.id} pool vs model`).toEqual([p.qty, p.value]);
    }
    for (const b of BOOKS2) {
      expect(cashOf(s, b), `cash ${b}`).toBe(this.cash[b]);
      expect(this.ledger.filter((e) => e.book === b).reduce((a, e) => a + e.amt, 0)).toBe(this.cash[b]);
    }
    const sSt = new Map(rows(s.ctx, 'SELECT id, status FROM sales').map((r) => [Number(r.id), r.status]));
    for (const m of this.sales) expect(sSt.get(m.id), `sale ${m.id} status`).toBe(m.status);
    expect(sSt.size).toBe(this.sales.length);
    const rSt = new Map(rows(s.ctx, 'SELECT id, status FROM sales_returns').map((r) => [Number(r.id), r.status]));
    for (const m of this.rets) expect(rSt.get(m.id), `return ${m.id} status`).toBe(m.status);
    expect(rSt.size).toBe(this.rets.length);
    const pSt = new Map(rows(s.ctx, 'SELECT id, status FROM purchases').map((r) => [Number(r.id), r.status]));
    for (const m of this.purs) expect(pSt.get(m.id), `purchase ${m.id} status`).toBe(m.status);
    const counters = new Map(rows(s.ctx, 'SELECT id, returned_qty q FROM sale_items').map((r) => [Number(r.id), Number(r.q)]));
    for (const sl of this.sales) for (const l of sl.lines) expect(counters.get(l.id), `returned_qty of line ${l.id}`).toBe(this.retQtyOf(l.id).qty);

    // P&L: day rows and totals of Shop and Telecom against the model's own attribution
    for (const b of BOOKS2) {
      const rep = await pnl(s, b, DATES[0]!, DATES[11]!, 'day');
      for (const d of DATES) expect(dayRow(rep, d).netProfitCents, `${b} profit ${d}`).toBe(this.profit(b, d));
      expect(rep.totals.netProfitCents, `${b} profit total`).toBe(this.profit(b, null));
      expect(segNetFromTables(s.ctx, b, DATES[0]!, DATES[11]!), `${b} raw-table profit`).toBe(this.profit(b, null));
    }
    const idn = await shopIdentity(s);
    expect(idn.reportProfit, 'shop identity report').toBe(this.profit('shop', null));
    expect(idn.ledgerProfit, 'shop identity ledger (cash + stock)').toBe(this.profit('shop', null));
    await assertGlobalInvariants(s, { skipAppendOnly: !full });
    assertReturnLedgers(s.ctx);
    await reconAll(s);
    if (full) {
      const d = (await dash(s, DATES[11]!)).body;
      expect(d.month.bySegment.shop.profitCents, 'dashboard shop month').toBe(this.profit('shop', null));
      expect(d.month.bySegment.telecom.profitCents, 'dashboard telecom month').toBe(this.profit('telecom', null));
      const val = (await get(s.app, '/reports/inventory/valuation?includeZero=true')).body;
      for (const b of BOOKS2) {
        const g = val.byBook.find((x: any) => x.book === b);
        const mine = this.prods.filter((p) => p.book === b);
        expect([g.qty, g.valueCents], `valuation ${b}`).toEqual([mine.reduce((a, p) => a + p.qty, 0), mine.reduce((a, p) => a + p.value, 0)]);
      }
    }
  }

  async run(n: number): Promise<void> {
    await this.build();
    await this.verify(true);
    for (let i = 0; i < n; i++) {
      const x = this.rnd() * 100;
      if (x < 17) await this.opBuy();
      else if (x < 37) await this.opSale();
      else if (x < 55) await this.opReturn();
      else if (x < 66) await this.opVoidReturn();
      else if (x < 74) await this.opSweepHunt();
      else if (x < 79) await this.opVoidSale();
      else if (x < 85) await this.opPurchaseReturn();
      else if (x < 89) await this.opPurchaseVoid();
      else if (x < 92) await this.opClose();
      else await this.opReopen();
      await this.verify(true);
    }
  }
}
