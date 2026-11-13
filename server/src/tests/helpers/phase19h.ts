// Helpers for the Phase 19 HISTORY / RECONCILIATION audit tests (migrations 016-018 must not change any historical record, and the books must reconcile).
// (1) `buildWorld19`: the six-week world of phase 14 PLUS full / partial / damaged returns, void-returns, a re-return after a void, and one void of
//     (almost) every voidable document type, all posted through the real HTTP API. (2) Independent SQL reconcilers: they never call report code,
//     they read the tables directly and return a list of problems (an empty list means "reconciled"). Money is integer cents.

import { expect } from 'vitest';
import type { AppContext } from '../../app.ts';
import { get, post } from './catalog.ts';
import { buy, mkProduct, ref } from './inventory.ts';
import type { ApiBase } from './inventory.ts';
import { drawNew, drawVoid, lossNew, lossVoid, stComplete, stDraft, stVoid } from './phase4.ts';
import { cl, clc, returnOk, rl, sellOk, voidSaleNew } from './phase5.ts';
import { ez, ezVoid, rel, relVoid, topVoid, topWallet } from './phase6.ts';
import { psNew, psVoid, supNew, supVoid } from './phase7.ts';
import { capNew, drawCash, tr, trVoid } from './phase9.ts';
import { capVoid, countNew, countVoid, expNew, expVoid } from './phase8.ts';
import { dayOk, dayVoid, moveOk, moveVoid, payOk, payVoid } from './phase10.ts';
import { buildWorld14, n1, rows, rs, todayColombo } from './phase14.ts';
import type { World14 } from './phase14.ts';
import { voidReturnOk } from './phase17.ts';

export { n1, rows, rs, todayColombo };

/** The id of the thing a create / void call returned (`{ item: { id } }`, `{ id }` or the first sale). */
export const idOf = (b: any): number => Number(b?.item?.id ?? b?.id ?? b?.sales?.[0]?.id);

export interface World19 { w: World14; extra: Record<string, any>; voided: Record<string, number>; }

/**
 * One write that must succeed (status < 300) and must leave at least one NEW audit row behind (BUSINESS_RULES: every financial write is audited).
 * Returns the response body.
 */
export async function step(s: ApiBase, label: string, call: () => Promise<{ status: number; body: any }>): Promise<any> {
  const a0 = n1(s.ctx, 'SELECT COUNT(*) FROM audit_logs');
  const r = await call();
  if (r.status >= 300) throw new Error(`${label} failed: ${r.status} ${JSON.stringify(r.body)}`);
  expect(n1(s.ctx, 'SELECT COUNT(*) FROM audit_logs'), `${label}: no audit row written`).toBeGreaterThan(a0);
  return r.body;
}

/** Builds the full history world through the API. Everything after the phase-14 world is dated 2025-09-15 .. 2025-09-19 (all in the past). */
export async function buildWorld19(s: ApiBase): Promise<World19> {
  const w = await buildWorld14(s);
  const d = (md: string) => ({ businessDate: `2025-${md}` });
  const x: Record<string, any> = {};
  const voided: Record<string, number> = {};
  const { P, Q, R, S, K } = w;

  // fresh stock so every sale below is covered
  await step(s, 'buy shop stock', async () => ({ status: 201, body: await buy(s, [{ productId: Q, packs: 1, packSize: 10, lineTotalCents: rs(7000) }, { productId: R, packs: 1, packSize: 10, lineTotalCents: rs(5000) },
    { productId: S, packs: 1, packSize: 20, lineTotalCents: rs(4000) }, { productId: P, packs: 1, packSize: 20, lineTotalCents: rs(6000) }], d('09-15')) }));
  await step(s, 'buy cards', async () => ({ status: 201, body: await buy(s, [{ productId: K, packs: 1, packSize: 50, lineTotalCents: rs(4500) }], d('09-15')) }));

  // ---- sales returns: full (resalable), partial x2 (one damaged), re-return after a void, telecom return and its void, void of a whole sale
  x.s1 = (await sellOk(s, [clc(Q, 4, rs(1200), rs(800))], d('09-15'))).sales[0];
  x.r1 = (await returnOk(s, x.s1.id, [rl(x.s1.items[0].id, 4, true)], d('09-16'))).item;            // full return, resalable
  x.s2 = (await sellOk(s, [cl(R, 2, rs(900)), cl(S, 3, rs(250))], d('09-15'))).sales[0];
  x.r2 = (await returnOk(s, x.s2.id, [rl(x.s2.items[0].id, 1, true)], d('09-16'))).item;            // partial
  x.r3 = (await returnOk(s, x.s2.id, [rl(x.s2.items[1].id, 2, false)], d('09-16'))).item;           // partial, damaged
  await voidReturnOk(s, x.s2.id, x.r3.id, 'void damaged return'); voided.sales_returns = x.r3.id;   // newest posted return is voided
  x.r4 = (await returnOk(s, x.s2.id, [rl(x.s2.items[1].id, 2, true)], d('09-17'))).item;            // re-return of the same units after the void
  x.s3 = (await sellOk(s, [cl(K, 5, rs(100))], d('09-15'))).sales[0];
  x.r5 = (await returnOk(s, x.s3.id, [rl(x.s3.items[0].id, 2, true)], d('09-16'))).item;            // telecom card return
  await voidReturnOk(s, x.s3.id, x.r5.id, 'void card return');
  x.s4 = (await sellOk(s, [cl(P, 2, rs(800))], d('09-15'))).sales[0];
  await step(s, 'void sale', () => voidSaleNew(s, x.s4.id)); voided.sales = x.s4.id;

  // ---- one void of each other document type
  x.rel = await step(s, 'reload', () => rel(s, 1, rs(1000), d('09-15'))); await step(s, 'reload void', () => relVoid(s, idOf(x.rel))); voided.reload_sales = idOf(x.rel);
  x.ez = await step(s, 'ezcash', () => ez(s, rs(5000), d('09-15'))); await step(s, 'ezcash void', () => ezVoid(s, idOf(x.ez))); voided.ezcash_sales = idOf(x.ez);
  x.top = await step(s, 'wallet', () => topWallet(s, rs(1000), d('09-15'))); await step(s, 'topup void', () => topVoid(s, idOf(x.top))); voided.telecom_topups = idOf(x.top);
  x.ps = await step(s, 'print', () => psNew(s, { ...d('09-15'), qty: 10 }, 'BW_1S')); await step(s, 'print void', () => psVoid(s, idOf(x.ps))); voided.print_sales = idOf(x.ps);
  x.sup = await step(s, 'supply', () => supNew(s, { ...d('09-15'), amountCents: rs(300), description: 'Ink' })); await step(s, 'supply void', () => supVoid(s, idOf(x.sup))); voided.printing_supplies = idOf(x.sup);
  x.dg = await step(s, 'goods drawing', () => drawNew(s, P, 1, d('09-15'))); await step(s, 'drawing void', () => drawVoid(s, idOf(x.dg))); voided.owner_drawings = idOf(x.dg);
  x.dc = await step(s, 'cash drawing', () => drawCash(s, { ...d('09-15'), book: 'shop', amountCents: rs(500) })); await step(s, 'cash drawing void', () => drawVoid(s, idOf(x.dc)));
  x.cap = await step(s, 'capital', () => capNew(s, { ...d('09-15'), book: 'telecom', amountCents: rs(700) })); await step(s, 'capital void', () => capVoid(s, idOf(x.cap))); voided.capital_entries = idOf(x.cap);
  x.tr1 = await step(s, 'transfer', () => tr(s, 'shop', 'telecom', rs(1000), d('09-15'))); await step(s, 'transfer void', () => trVoid(s, idOf(x.tr1))); voided.cash_transfers = idOf(x.tr1);
  x.tr2 = await step(s, 'transfer ice', () => tr(s, 'shop', 'icecream', rs(400), { ...d('09-15'), toFund: 'profit' })); await step(s, 'transfer ice void', () => trVoid(s, idOf(x.tr2)));
  x.cnt = await step(s, 'count', () => countNew(s, 'telecom', 1000, { ...d('09-15'), note: 'to void' })); await step(s, 'count void', () => countVoid(s, idOf(x.cnt))); voided.cash_counts = idOf(x.cnt);
  x.exp = await step(s, 'expense', () => expNew(s, { ...d('09-15'), book: 'telecom', category: 'repairs', amountCents: rs(111) })); await step(s, 'expense void', () => expVoid(s, idOf(x.exp))); voided.expenses = idOf(x.exp);
  x.loss = await step(s, 'loss', () => lossNew(s, R, 1, { ...d('09-15'), reason: 'damaged' })); await step(s, 'loss void', () => lossVoid(s, idOf(x.loss))); voided.stock_losses = idOf(x.loss);
  const pv = await buy(s, [{ productId: R, packs: 1, packSize: 3, lineTotalCents: rs(900) }], d('09-15'));
  x.pret = await step(s, 'purchase return', () => post(s.app, `/purchases/${pv.id}/returns`, { ...d('09-16'), items: [{ purchaseItemId: pv.items[0].id, units: 1 }], clientRef: ref() }));
  const pv2 = await buy(s, [{ productId: S, packs: 1, packSize: 5, lineTotalCents: rs(500) }], d('09-15'));
  await step(s, 'purchase void', () => post(s.app, `/purchases/${pv2.id}/void`, { reason: 'dup' })); voided.purchases = pv2.id;
  const st = await stDraft(s, [{ productId: S, countedQty: 1 }], { ...d('09-17'), book: 'shop' });
  await step(s, 'stocktake', () => stComplete(s, st.id)); await step(s, 'stocktake void', () => stVoid(s, st.id)); voided.stocktakes = st.id;
  // an opening-stock batch, then a second one that is voided
  const N1 = (await mkProduct(s, { name: 'Opening A', sellPriceCents: rs(300), minPriceCents: 100 })).id;
  const N2 = (await mkProduct(s, { name: 'Opening B', sellPriceCents: rs(300), minPriceCents: 100 })).id;
  await step(s, 'opening stock', () => post(s.app, '/opening-stock', { ...d('09-15'), items: [{ productId: N1, qty: 6, totalValueCents: rs(600) }], clientRef: ref() }));
  x.os = await step(s, 'opening stock 2', () => post(s.app, '/opening-stock', { ...d('09-15'), items: [{ productId: N2, qty: 5, totalValueCents: rs(500) }], clientRef: ref() }));
  await step(s, 'opening stock void', () => post(s.app, `/opening-stock/${idOf(x.os)}/void`, { reason: 'wrong file' })); voided.opening_stock_batches = idOf(x.os);
  // ice cream: a day that is voided, a payment and a fund move that are voided
  await step(s, 'ice day headroom', () => dayOk(s, { ...d('09-14'), salesCents: rs(30000), costAllocCents: rs(6000), electricityAllocCents: rs(1000) }).then((b) => ({ status: 201, body: b })));
  await step(s, 'ice day', () => dayOk(s, { ...d('09-15'), salesCents: rs(2500), costAllocCents: rs(2000), electricityAllocCents: rs(500) }).then((b) => ({ status: 201, body: b })));
  await step(s, 'ice day void', () => dayVoid(s, '2025-09-15')); voided.icecream_days = 1;
  await step(s, 'ice day 2', () => dayOk(s, { ...d('09-16'), salesCents: rs(2000), costAllocCents: rs(2600), electricityAllocCents: rs(300), confirmNegativeProfit: true }).then((b) => ({ status: 201, body: b })));
  x.pay = await step(s, 'ice payment', () => payOk(s, 'materials', rs(150), { fund: 'cost', ...d('09-16') }).then((b) => ({ status: 201, body: b }))); await step(s, 'ice payment void', () => payVoid(s, idOf(x.pay))); voided.icecream_payments = idOf(x.pay);
  x.mv = await step(s, 'fund move', () => moveOk(s, 'cost', 'electricity', rs(100), d('09-16')).then((b) => ({ status: 201, body: b }))); await step(s, 'fund move void', () => moveVoid(s, idOf(x.mv))); voided.icecream_fund_moves = idOf(x.mv);
  // kept (non-void) late activity so the last days are not all reversals
  await sellOk(s, [cl(S, 1, rs(250)), cl(Q, 1, rs(1200))], d('09-18'));
  await step(s, 'late expense', () => expNew(s, { ...d('09-18'), book: 'shop', category: 'rent', amountCents: rs(2000) }));
  void ref;
  return { w, extra: x, voided };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Independent SQL reconcilers (each returns the list of problems; [] = ok)
// ---------------------------------------------------------------------------------------------------------------------------------------

const asNum = (v: unknown): number => Number(v);
export const BOOKS = ['shop', 'telecom', 'icecream'] as const;
export const FUNDS = ['cost', 'electricity', 'profit'] as const;

/** PRAGMA integrity_check must be exactly 'ok', foreign_key_check and quick_check must be clean. */
export function dbIntegrity(ctx: AppContext): string[] {
  const p: string[] = [];
  const ic = rows(ctx, 'PRAGMA integrity_check').map((r) => String(Object.values(r)[0]));
  if (ic.length !== 1 || ic[0] !== 'ok') p.push(`integrity_check: ${ic.join(';')}`);
  const fk = rows(ctx, 'PRAGMA foreign_key_check');
  if (fk.length) p.push(`foreign_key_check: ${JSON.stringify(fk.slice(0, 3))}`);
  return p;
}

/** STOCK: per product, sum of movements equals the cache; no negative quantity or value; services have no stock. */
export function stockProblems(ctx: AppContext): string[] {
  const p: string[] = [];
  for (const r of rows(ctx, `SELECT p.id, p.name, p.kind, p.qty_on_hand q, p.stock_value_cents v,
      COALESCE((SELECT SUM(qty_delta) FROM stock_movements m WHERE m.product_id = p.id), 0) mq,
      COALESCE((SELECT SUM(value_delta_cents) FROM stock_movements m WHERE m.product_id = p.id), 0) mv FROM products p ORDER BY p.id`)) {
    if (asNum(r.q) !== asNum(r.mq)) p.push(`product ${r.id} ${r.name}: qty cache ${r.q} <> movements ${r.mq}`);
    if (asNum(r.v) !== asNum(r.mv)) p.push(`product ${r.id} ${r.name}: value cache ${r.v} <> movements ${r.mv}`);
    if (asNum(r.q) < 0 || asNum(r.v) < 0) p.push(`product ${r.id}: negative stock ${r.q} / ${r.v}`);
    if (r.kind === 'service' && (asNum(r.q) !== 0 || asNum(r.v) !== 0)) p.push(`service product ${r.id} holds stock`);
    if (asNum(r.q) === 0 && asNum(r.v) !== 0) p.push(`product ${r.id}: zero quantity but value ${r.v}`);
  }
  const orphan = n1(ctx, 'SELECT COUNT(*) FROM stock_movements m WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = m.product_id)');
  if (orphan) p.push(`${orphan} movements without a product`);
  return p;
}

/** Cash balance of every book straight from the ledger. */
export function bookBalances(ctx: AppContext): Record<string, number> {
  const out: Record<string, number> = { shop: 0, telecom: 0, icecream: 0 };
  for (const r of rows(ctx, 'SELECT book, COALESCE(SUM(amount_cents),0) s FROM cash_entries GROUP BY book')) out[String(r.book)] = asNum(r.s);
  return out;
}
/** Ice Cream fund balances from the fund ledger and (independently) from the Ice Cream cash entries. */
export function fundBalances(ctx: AppContext): { ledger: Record<string, number>; cash: Record<string, number> } {
  const ledger: Record<string, number> = { cost: 0, electricity: 0, profit: 0 };
  const cash: Record<string, number> = { cost: 0, electricity: 0, profit: 0 };
  for (const r of rows(ctx, 'SELECT fund, SUM(amount_cents) s FROM icecream_fund_entries GROUP BY fund')) ledger[String(r.fund)] = asNum(r.s);
  for (const r of rows(ctx, "SELECT fund, SUM(amount_cents) s FROM cash_entries WHERE book='icecream' GROUP BY fund")) cash[String(r.fund)] = asNum(r.s);
  return { ledger, cash };
}

/** Reversal rows (cash and fund ledgers) must point to an existing original with the opposite sign, same date / book / fund / reference. */
export function reversalProblems(ctx: AppContext): string[] {
  const p: string[] = [];
  for (const r of rows(ctx, `SELECT c.id, c.amount_cents a, o.id oid, o.amount_cents oa, c.business_date d, o.business_date od, c.book, o.book ob, c.fund, o.fund ofund,
      c.ref_table rt, o.ref_table ort, c.ref_id ri, o.ref_id ori, c.type, o.type otype, o.reverses_entry_id oreverses
      FROM cash_entries c LEFT JOIN cash_entries o ON o.id = c.reverses_entry_id WHERE c.reverses_entry_id IS NOT NULL`)) {
    if (r.oid === null) { p.push(`cash ${r.id}: original missing`); continue; }
    if (asNum(r.a) !== -asNum(r.oa)) p.push(`cash ${r.id}: amount ${r.a} is not the negative of original ${r.oa}`);
    if (r.d !== r.od) p.push(`cash ${r.id}: date ${r.d} <> original ${r.od}`);
    if (r.book !== r.ob) p.push(`cash ${r.id}: book differs`);
    if ((r.fund ?? null) !== (r.ofund ?? null)) p.push(`cash ${r.id}: fund differs`);
    if (r.rt !== r.ort || asNum(r.ri) !== asNum(r.ori)) p.push(`cash ${r.id}: reference differs`);
    if (r.type !== r.otype) p.push(`cash ${r.id}: type ${r.type} <> original ${r.otype}`);
    if (r.oreverses !== null) p.push(`cash ${r.id}: reverses a reversal`);
  }
  for (const r of rows(ctx, `SELECT c.id, c.amount_cents a, o.id oid, o.amount_cents oa, c.business_date d, o.business_date od, c.fund, o.fund ofund, c.ref_table rt, o.ref_table ort, c.ref_id ri, o.ref_id ori
      FROM icecream_fund_entries c LEFT JOIN icecream_fund_entries o ON o.id = c.reverses_entry_id WHERE c.reverses_entry_id IS NOT NULL`)) {
    if (r.oid === null) { p.push(`fund ${r.id}: original missing`); continue; }
    if (asNum(r.a) !== -asNum(r.oa)) p.push(`fund ${r.id}: amount ${r.a} is not the negative of original ${r.oa}`);
    if (r.d !== r.od) p.push(`fund ${r.id}: date differs`);
    if (r.fund !== r.ofund) p.push(`fund ${r.id}: fund differs`);
    if (r.rt !== r.ort || asNum(r.ri) !== asNum(r.ori)) p.push(`fund ${r.id}: reference differs`);
  }
  // an original is reversed at most once
  for (const t of ['cash_entries', 'icecream_fund_entries']) {
    for (const r of rows(ctx, `SELECT reverses_entry_id id, COUNT(*) n FROM ${t} WHERE reverses_entry_id IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1`)) p.push(`${t} ${r.id} reversed ${r.n} times`);
  }
  return p;
}

/** Every table that has both an `id` and a `status` column that can be 'void'. */
export function statusTables(ctx: AppContext): string[] {
  const out: string[] = [];
  for (const t of rows(ctx, "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
    const cols = rows(ctx, `PRAGMA table_info("${t.name}")`).map((c) => String(c.name));
    if (cols.includes('status') && cols.includes('id') && /void/.test(String(t.sql))) out.push(String(t.name));
  }
  return out;
}

/** For every record with status='void': the net of its cash, stock and fund rows (original + reversal) is zero. Returns problems and how many void records each table had. */
export function voidNetProblems(ctx: AppContext): { problems: string[]; voidCounts: Record<string, number> } {
  const problems: string[] = [];
  const voidCounts: Record<string, number> = {};
  for (const t of statusTables(ctx)) {
    const ids = rows(ctx, `SELECT id FROM "${t}" WHERE status = 'void'`).map((r) => asNum(r.id));
    voidCounts[t] = ids.length;
    for (const id of ids) {
      const cash = n1(ctx, 'SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE ref_table = ? AND ref_id = ?', t, id);
      const sq = n1(ctx, 'SELECT COALESCE(SUM(qty_delta),0) FROM stock_movements WHERE ref_table = ? AND ref_id = ?', t, id);
      const sv = n1(ctx, 'SELECT COALESCE(SUM(value_delta_cents),0) FROM stock_movements WHERE ref_table = ? AND ref_id = ?', t, id);
      const fund = n1(ctx, 'SELECT COALESCE(SUM(amount_cents),0) FROM icecream_fund_entries WHERE ref_table = ? AND ref_id = ?', t, id);
      if (cash !== 0) problems.push(`${t} #${id} void: cash net ${cash}`);
      if (sq !== 0 || sv !== 0) problems.push(`${t} #${id} void: stock net qty ${sq} value ${sv}`);
      if (fund !== 0) problems.push(`${t} #${id} void: fund net ${fund}`);
    }
  }
  return { problems, voidCounts };
}

/** Every sale line's returned_qty equals the sum of its POSTED return lines (and never exceeds the quantity sold). */
export function returnedQtyProblems(ctx: AppContext): string[] {
  return rows(ctx, `SELECT si.id, si.qty, si.returned_qty r, COALESCE((SELECT SUM(ri.qty) FROM sales_return_items ri JOIN sales_returns x ON x.id = ri.sales_return_id
      WHERE ri.sale_item_id = si.id AND x.status = 'posted'), 0) p FROM sale_items si`)
    .filter((r) => asNum(r.r) !== asNum(r.p) || asNum(r.r) > asNum(r.qty)).map((r) => `sale_item ${r.id}: returned_qty ${r.r} vs posted return lines ${r.p} (sold ${r.qty})`);
}

/** Every table with a business_date column: nothing dated after today (Asia/Colombo). */
export function futureDateProblems(ctx: AppContext): string[] {
  const today = todayColombo();
  const p: string[] = [];
  for (const t of rows(ctx, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
    const cols = rows(ctx, `PRAGMA table_info("${t.name}")`).map((c) => String(c.name));
    for (const c of cols.filter((x) => x === 'business_date' || x === 'as_of')) {
      const n = n1(ctx, `SELECT COUNT(*) FROM "${t.name}" WHERE "${c}" > ?`, today);
      if (n) p.push(`${t.name}.${c}: ${n} future-dated rows`);
    }
  }
  return p;
}

/** Audit coverage: entity name in audit_logs per business table (each created record has a create row, each void record a void row). */
export const AUDIT_ENTITY: Record<string, string> = {
  sales: 'sale', purchases: 'purchase', expenses: 'expense', reload_sales: 'reload_sale', ezcash_sales: 'ezcash_sale', telecom_topups: 'telecom_topup',
  print_sales: 'print_sale', printing_supplies: 'printing_supply', owner_drawings: 'drawing', capital_entries: 'capital_entry', cash_transfers: 'cash_transfer',
  cash_counts: 'cash_count', icecream_payments: 'icecream_payment', icecream_fund_moves: 'icecream_fund_move', stock_losses: 'stock_loss', stocktakes: 'stocktake',
  opening_stock_batches: 'opening_stock_batch', sales_returns: 'sale_return', purchase_returns: 'purchase_return',
};
export function auditCoverageProblems(ctx: AppContext): string[] {
  const p: string[] = [];
  for (const [t, e] of Object.entries(AUDIT_ENTITY)) {
    // a damaged-return loss is created (and voided) by the sales return itself, which carries the audit row
    const own = t === 'stock_losses' ? " AND (x.source = 'manual')" : '';
    const missingCreate = rows(ctx, `SELECT id FROM "${t}" x WHERE 1=1${own} AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.entity = ? AND a.entity_id = CAST(x.id AS TEXT) AND a.action = 'create')`, e);
    for (const r of missingCreate) p.push(`${t} #${r.id}: no audit 'create' row`);
    const cols = rows(ctx, `PRAGMA table_info("${t}")`).map((c) => String(c.name));
    if (cols.includes('status')) {
      const missingVoid = rows(ctx, `SELECT id FROM "${t}" x WHERE x.status = 'void'${own} AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.entity = ? AND a.entity_id = CAST(x.id AS TEXT) AND a.action = 'void')`, e);
      for (const r of missingVoid) p.push(`${t} #${r.id}: voided but no audit 'void' row`);
    }
  }
  return p;
}

/** Runs one statement inside a savepoint and rolls it back; returns the error text if the database refused it, or null if it succeeded. */
export function probe(ctx: AppContext, sql: string | string[]): string | null {
  const c = ctx.database.conn;
  c.exec('SAVEPOINT p19probe');
  let err: string | null = null;
  try { for (const q of Array.isArray(sql) ? sql : [sql]) c.exec(q); } catch (e) { err = (e as Error).message; }
  c.exec('ROLLBACK TO p19probe');
  c.exec('RELEASE p19probe');
  return err;
}
export { get, post };
