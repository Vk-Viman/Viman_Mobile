// Phase 19 audit, part E: RANDOMIZED closed-day model check (BUSINESS_RULES section 8 + R9).
// Per seed: 400 random operations over all three books - creates of every financial record type, voids, sale / purchase returns and
// return voids, cash counts with adjustments, daily closings (with / without count, with / without variance), reopens - at random
// (backdated) dates. An independent in-test model of the closed-day rules (helpers/phase19cd.ts predict: written from BUSINESS_RULES
// section 8, not from services/day-closing.ts) predicts for every operation: accepted, or the exact error code (and book / closed date).
// After EVERY operation:
//   P1  the ledger balance of each book as of each currently closed day equals the snapshot recorded at closing (counted, else expected);
//   P2  the model's set of closed days equals the database's;
//   P3  a refused write left the database unchanged (row counts of every table + void counters + stock cache; a full hash every 20th refusal).

import { afterEach, describe, expect, it } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { post } from './helpers/catalog.ts';
import type { Res } from './helpers/catalog.ts';
import { apiBase, daysAgo, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { drawNew, drawVoid, err, lossNew, lossVoid, sql, stComplete, stDraft, stVoid } from './helpers/phase4.ts';
import { cl, returnNew, rl, sellNew, voidSaleNew } from './helpers/phase5.ts';
import { ez, ezVoid, rel, relVoid, topProvider, topVoid, topWallet } from './helpers/phase6.ts';
import { psNew, psVoid, supNew, supVoid } from './helpers/phase7.ts';
import { capVoid, closeNew, countNew, countVoid, expNew, expVoid, openNew, reopenNew } from './helpers/phase8.ts';
import { capNew, drawCash, tr, trVoid } from './helpers/phase9.ts';
import { dayNew, dayReplace, dayVoid, moveNew, moveVoid, payNew, payVoid } from './helpers/phase10.ts';
import { voidReturnNew } from './helpers/phase17.ts';
import {
  ALL_BOOKS, backdateBody, balAsOf, closedSnapshotViolations, dayClosedBody, emptyModel, fixture, fullSnapshot, predict, rng,
} from './helpers/phase19cd.ts';
import type { Book, ClosedModel, Fx } from './helpers/phase19cd.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

interface Rec { kind: string; id: number; books: Book[]; date: string; status: 'posted' | 'void'; saleId?: number; key?: string }

/** Cheap fingerprint: row count of every table + count of void/completed rows + the stock cache. Any insert or status flip changes it. */
function light(s: ApiBase): string {
  const conn = s.ctx.database.conn;
  const tables = (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('schema_migrations') ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
  const parts: string[] = [];
  for (const t of tables) {
    const cols = (conn.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    const n = Number((conn.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as unknown as { n: number }).n);
    let extra = '';
    if (cols.includes('status')) extra = String(Number((conn.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE status <> 'posted'`).get() as unknown as { n: number }).n));
    parts.push(`${t}=${n}/${extra}`);
  }
  const stock = conn.prepare('SELECT SUM(qty_on_hand) AS q, SUM(stock_value_cents) AS v FROM products').get() as unknown as { q: number; v: number };
  parts.push(`stock=${stock.q}/${stock.v}`);
  return parts.join('|');
}

/** The model's closed set as the database sees it. */
function dbClosed(s: ApiBase): ClosedModel {
  const m = emptyModel();
  for (const r of sql(s, 'SELECT book, business_date FROM daily_closings WHERE reopened_at IS NULL OR closed_at > reopened_at')) m[r.book as Book].add(r.business_date as string);
  return m;
}

const SEEDS = [11, 2027, 31337, 9001];
const OPS = 400;

describe.each(SEEDS)('randomized closed-day model, seed %i', (seed) => {
  it(`${OPS} operations: accept / exact refusal as predicted, balances at closed days never drift`, async () => {
    const rand = rng(seed);
    const int = (n: number): number => Math.floor(rand() * n);
    const pick = <T,>(a: readonly T[]): T => a[int(a.length)]!;
    const s = await apiBase(await env.build());
    const fx: Fx = await fixture(s);
    const model = emptyModel();
    const closings: Record<string, { id: number }> = {}; // `${book}|${date}` -> closing row
    const recs: Rec[] = [];
    const posted = (kind: string): Rec[] => recs.filter((r) => r.kind === kind && r.status === 'posted');
    const iceDays = new Map<string, number>(); // date -> posted daily entry exists
    const openings = new Set<string>();         // posted opening balances: `${book}|${fund}`
    const saleReturns = new Map<number, Array<{ id: number; date: string; status: 'posted' | 'void' }>>(); // saleId -> returns (stack)
    const saleUnits = new Map<number, number>(); // returnable units left per sale
    const saleHadReturns = new Set<number>();
    const purchaseHadReturns = new Set<number>();
    const purchaseUnits = new Map<number, number>();
    const stats = { ok: 0, refused: 0, byCode: {} as Record<string, number>, ops: {} as Record<string, number> };
    const seedDates = Array.from({ length: 15 }, (_, i) => daysAgo(14 - i)); // today-14 ... today
    let refusals = 0;

    // history that must exist before anything is closed: sales and purchases to return (dated 20 days ago)
    for (let i = 0; i < 6; i++) {
      for (const [prod, book] of [[fx.shopP, 'shop'], [fx.telP, 'telecom']] as const) {
        const sr = await sellNew(s, [cl(prod.id, 4, 3000)], { businessDate: daysAgo(20) });
        recs.push({ kind: 'sale', id: sr.body.sales[0].id, books: [book], date: daysAgo(20), status: 'posted', key: 'item', saleId: sr.body.sales[0].items[0].id });
        saleUnits.set(sr.body.sales[0].id, 4);
        const pu = await post(s.app, '/purchases', { businessDate: daysAgo(20), items: [{ productId: prod.id, packs: 1, packSize: 10, lineTotalCents: 10000 }], clientRef: ref() });
        recs.push({ kind: 'purchase', id: pu.body.item.id, books: [book], date: daysAgo(20), status: 'posted', key: String(pu.body.item.items[0].id) });
        purchaseUnits.set(pu.body.item.id, 10);
      }
    }

    const latestClosed = (): string | null => {
      let m: string | null = null;
      for (const b of ALL_BOOKS) for (const d of model[b]) if (m === null || d > m) m = d;
      return m;
    };
    const randomDate = (): string => {
      const fr = latestClosed();
      if (fr !== null && rand() < 0.7) {
        const base = new Date(Date.parse(`${fr}T00:00:00Z`) + (int(4) - 1) * 86400000).toISOString().slice(0, 10);
        return base > today() ? today() : base < seedDates[0]! ? seedDates[0]! : base;
      }
      return pick(seedDates);
    };
    const fundOf = (b: Book): Record<string, unknown> => (b === 'icecream' ? { fund: pick(['cost', 'electricity', 'profit'] as const) } : {});
    const bookOf2 = (): 'shop' | 'telecom' => pick(['shop', 'telecom'] as const);

    /** One planned operation: its books and date for the model, an optional preparation (not judged), and the call. */
    interface Plan {
      name: string; books: Book[]; date: string; call: () => Promise<Res>; prep?: () => Promise<void>;
      /** Extra business rule that applies only when the closed-day rules accept (returns the expected error code or null). */
      then?: () => string | null;
      onOk?: (r: Res) => void; okStatus?: number; lookupMissing?: boolean;
    }

    const planCreate = (): Plan | null => {
      const d = randomDate();
      const choice = int(24);
      switch (choice) {
        case 0: { const b = pick(ALL_BOOKS); return { name: 'cash drawing', books: [b], date: d, call: () => drawCash(s, { businessDate: d, book: b, ...fundOf(b) }), onOk: (r) => recs.push({ kind: 'cashdraw', id: r.body.item.id, books: [b], date: d, status: 'posted' }) }; }
        case 1: { const b = pick(ALL_BOOKS); return { name: 'capital', books: [b], date: d, call: () => capNew(s, { businessDate: d, book: b, ...fundOf(b) }), onOk: (r) => recs.push({ kind: 'capital', id: r.body.item.id, books: [b], date: d, status: 'posted' }) }; }
        case 2: { const b = bookOf2(); return { name: 'expense', books: [b], date: d, call: () => expNew(s, { businessDate: d, book: b, category: 'internet' }), onOk: (r) => recs.push({ kind: 'expense', id: r.body.item.id, books: [b], date: d, status: 'posted' }) }; }
        case 3: { const b = bookOf2(); const p = b === 'shop' ? fx.shopP : fx.telP; return { name: 'purchase', books: [b], date: d, call: () => post(s.app, '/purchases', { businessDate: d, items: [{ productId: p.id, packs: 1, packSize: 2, lineTotalCents: 2000 }], clientRef: ref() }), onOk: (r) => recs.push({ kind: 'purchase', id: r.body.item.id, books: [b], date: d, status: 'posted', key: String(r.body.item.items[0].id) }) }; }
        case 4: { const mix = int(3); const items = mix === 0 ? [cl(fx.shopP.id, 1, 3000)] : mix === 1 ? [cl(fx.telP.id, 1, 3000)] : [cl(fx.shopP.id, 1, 3000), cl(fx.telP.id, 1, 3000)];
          const books: Book[] = mix === 0 ? ['shop'] : mix === 1 ? ['telecom'] : ['shop', 'telecom'];
          return { name: 'sale', books, date: d, call: () => sellNew(s, items, { businessDate: d }), onOk: (r) => { for (const sale of r.body.sales) recs.push({ kind: 'sale', id: sale.id, books: [sale.book], date: d, status: 'posted', key: 'item', saleId: sale.items[0].id }), saleUnits.set(sale.id, 1); } }; }
        case 5: return { name: 'reload', books: ['telecom'], date: d, call: () => rel(s, fx.prov.Dialog!, 10000, { businessDate: d }), onOk: (r) => recs.push({ kind: 'reload', id: r.body.item.id, books: ['telecom'], date: d, status: 'posted' }) };
        case 6: return { name: 'ezcash', books: ['telecom'], date: d, call: () => ez(s, 10000, { businessDate: d }), onOk: (r) => recs.push({ kind: 'ezcash', id: r.body.item.id, books: ['telecom'], date: d, status: 'posted' }) };
        case 7: { const w = int(2) === 0; return { name: 'top-up', books: ['telecom'], date: d, call: () => (w ? topWallet(s, 3000, { businessDate: d }) : topProvider(s, fx.prov.Dialog!, 3000, { businessDate: d })), onOk: (r) => recs.push({ kind: 'topup', id: r.body.item.id, books: ['telecom'], date: d, status: 'posted' }) }; }
        case 8: return { name: 'print sale', books: ['shop'], date: d, call: () => psNew(s, { businessDate: d }), onOk: (r) => recs.push({ kind: 'print', id: r.body.item.id, books: ['shop'], date: d, status: 'posted' }) };
        case 9: return { name: 'printing supplies', books: ['shop'], date: d, call: () => supNew(s, { businessDate: d }), onOk: (r) => recs.push({ kind: 'supply', id: r.body.item.id, books: ['shop'], date: d, status: 'posted' }) };
        case 10: {
          const from = pick(ALL_BOOKS); const to = pick(ALL_BOOKS.filter((b) => b !== from));
          return { name: 'transfer', books: [from, to], date: d,
            call: () => tr(s, from, to, 500, { businessDate: d, ...(from === 'icecream' ? { fromFund: pick(['cost', 'electricity', 'profit'] as const) } : {}), ...(to === 'icecream' ? { toFund: pick(['cost', 'electricity', 'profit'] as const) } : {}) }),
            onOk: (r) => recs.push({ kind: 'transfer', id: r.body.item.id, books: [from, to], date: d, status: 'posted' }) };
        }
        case 11: return { name: 'ice cream day', books: ['icecream'], date: d, call: () => dayNew(s, { businessDate: d }), then: () => (iceDays.has(d) ? 'DAY_EXISTS' : null), onOk: () => { iceDays.set(d, 1); recs.push({ kind: 'iceday', id: 0, books: ['icecream'], date: d, status: 'posted' }); } };
        case 12: return { name: 'ice cream payment', books: ['icecream'], date: d, call: () => payNew(s, pick(['materials', 'electricity_bill'] as const), 400, { businessDate: d }), onOk: (r) => recs.push({ kind: 'icepay', id: r.body.payment.id, books: ['icecream'], date: d, status: 'posted' }) };
        case 13: return { name: 'ice cream fund move', books: ['icecream'], date: d, call: () => moveNew(s, 'cost', 'electricity', 30, { businessDate: d }), onOk: (r) => recs.push({ kind: 'icemove', id: r.body.move.id, books: ['icecream'], date: d, status: 'posted' }) };
        case 14: { const b = bookOf2(); const p = b === 'shop' ? fx.shopP : fx.telP; return { name: 'stock loss', books: [b], date: d, call: () => lossNew(s, p.id, 1, { businessDate: d }), onOk: (r) => recs.push({ kind: 'loss', id: r.body.item.id, books: [b], date: d, status: 'posted' }) }; }
        case 15: { const b = bookOf2(); const p = b === 'shop' ? fx.shopP : fx.telP; return { name: 'goods drawing', books: [b], date: d, call: () => drawNew(s, p.id, 1, { businessDate: d }), onOk: (r) => recs.push({ kind: 'goods', id: r.body.item.id, books: [b], date: d, status: 'posted' }) }; }
        case 16: {
          const b = bookOf2(); const p = b === 'shop' ? fx.shopP : fx.telP; let draftId = 0;
          return { name: 'stocktake complete', books: [b], date: d,
            prep: async () => { const live = Number(sql(s, 'SELECT qty_on_hand AS q FROM products WHERE id = ?', p.id)[0]!.q); draftId = (await stDraft(s, [{ productId: p.id, countedQty: live - 1 }], { businessDate: d, book: b })).id; },
            call: async () => { const r = await stComplete(s, draftId); return r.status === 200 ? { status: 201, body: { item: r.body.item } } : r; },
            onOk: (r) => recs.push({ kind: 'stocktake', id: r.body.item.id, books: [b], date: d, status: 'posted' }) };
        }
        case 17: {
          const mix = int(3);
          const lines = mix === 0 ? [fx.osShop] : mix === 1 ? [fx.osTel] : [fx.osShop, fx.osTel];
          const books: Book[] = mix === 0 ? ['shop'] : mix === 1 ? ['telecom'] : ['shop', 'telecom'];
          return { name: 'opening stock', books, date: d, call: () => post(s.app, '/opening-stock', { businessDate: d, items: lines.map((p: any) => ({ productId: p.id, qty: 1, unitCostCents: 500 })), clientRef: ref() }), onOk: (r) => recs.push({ kind: 'ostock', id: r.body.item.id, books, date: d, status: 'posted' }) };
        }
        case 18: { const b = pick(ALL_BOOKS); const f = fundOf(b);
          return { name: 'cash count', books: [b], date: d,
            call: () => { const bal = balAsOf(s, b, d); return countNew(s, b, bal >= 0 ? bal + 1000 : 0, { businessDate: d, note: 'random count', ...f }); },
            then: () => null, onOk: (r) => recs.push({ kind: 'count', id: r.body.item.id, books: [b], date: d, status: 'posted' }) }; }
        case 19: { const b = pick(ALL_BOOKS); const f = b === 'icecream' ? { fund: 'profit' } : {};
          return { name: 'opening balance', books: [b], date: d, call: () => openNew(s, b, { businessDate: d, ...f }),
            then: () => (openings.has(`${b}|${(f as any).fund ?? ''}`) ? 'OPENING_BALANCE_EXISTS' : null),
            onOk: (r) => { openings.add(`${b}|${(f as any).fund ?? ''}`); recs.push({ kind: 'opening', id: r.body.item.id, books: [b], date: d, status: 'posted', key: `${b}|${(f as any).fund ?? ''}` }); } };
        }
        case 20: { // sale return
          const cands = posted('sale').filter((r) => r.key === 'item' && (saleUnits.get(r.id) ?? 0) > 0 && r.date <= d);
          if (cands.length === 0) return null;
          const sale = pick(cands);
          return { name: 'sale return', books: sale.books, date: d, call: () => returnNew(s, sale.id, [rl(sale.saleId!, 1, rand() < 0.7)], { businessDate: d }),
            onOk: (r) => { const list = saleReturns.get(sale.id) ?? []; list.push({ id: r.body.item.id, date: d, status: 'posted' }); saleReturns.set(sale.id, list); saleUnits.set(sale.id, (saleUnits.get(sale.id) ?? 0) - 1); saleHadReturns.add(sale.id); recs.push({ kind: 'return', id: r.body.item.id, books: sale.books, date: d, status: 'posted', saleId: sale.id }); } };
        }
        case 21: { // purchase return
          const cands = posted('purchase').filter((r) => (purchaseUnits.get(r.id) ?? 0) > 0 && r.date <= d);
          if (cands.length === 0) return null;
          const pu = pick(cands);
          return { name: 'purchase return', books: pu.books, date: d, call: () => post(s.app, `/purchases/${pu.id}/returns`, { businessDate: d, items: [{ purchaseItemId: Number(pu.key), units: 1 }], clientRef: ref() }),
            onOk: () => { purchaseUnits.set(pu.id, (purchaseUnits.get(pu.id) ?? 0) - 1); purchaseHadReturns.add(pu.id); } };
        }
        case 22: { // ice cream day replace
          const dates = [...iceDays.keys()]; if (dates.length === 0) return null;
          const rd = pick(dates);
          return { name: 'ice cream day replace', books: ['icecream'], date: rd, call: () => dayReplace(s, rd), okStatus: 201 };
        }
        default: return null;
      }
    };

    const planVoid = (): Plan | null => {
      const open = recs.filter((r) => r.status === 'posted' && r.kind !== 'iceday');
      const ice = recs.filter((r) => r.status === 'posted' && r.kind === 'iceday');
      const roll = int(10);
      if (roll === 0 && ice.length > 0) {
        const r = pick(ice);
        return { name: 'ice day void', books: ['icecream'], date: r.date, call: () => dayVoid(s, r.date), onOk: () => { r.status = 'void'; iceDays.delete(r.date); } };
      }
      const cands = open.filter((r) => {
        if (r.kind === 'sale') return !saleHadReturns.has(r.id) && r.date <= today();
        if (r.kind === 'purchase') return !purchaseHadReturns.has(r.id);
        if (r.kind === 'return') { const l = saleReturns.get(r.saleId!)!; const top = [...l].reverse().find((x) => x.status === 'posted'); return top?.id === r.id; }
        return true;
      }).filter((r) => !(r.kind === 'sale' && r.date === daysAgo(20)) || true);
      if (cands.length === 0) return null;
      const r = pick(cands);
      const done = () => { r.status = 'void'; };
      const mk = (call: () => Promise<Res>, extra: Partial<Plan> = {}): Plan => ({ name: `void ${r.kind}`, books: r.books, date: r.date, call, onOk: () => { done(); extra.onOk?.({ status: 200, body: {} }); } });
      switch (r.kind) {
        case 'cashdraw': case 'goods': return mk(() => drawVoid(s, r.id));
        case 'capital': return mk(() => capVoid(s, r.id));
        case 'opening': return mk(() => capVoid(s, r.id), { onOk: () => { openings.delete(r.key!); } });
        case 'expense': return mk(() => expVoid(s, r.id));
        case 'purchase': return mk(() => post(s.app, `/purchases/${r.id}/void`, { reason: 'random void' }));
        case 'sale': return mk(() => voidSaleNew(s, r.id));
        case 'reload': return mk(() => relVoid(s, r.id));
        case 'ezcash': return mk(() => ezVoid(s, r.id));
        case 'topup': return mk(() => topVoid(s, r.id));
        case 'print': return mk(() => psVoid(s, r.id));
        case 'supply': return mk(() => supVoid(s, r.id));
        case 'transfer': return mk(() => trVoid(s, r.id));
        case 'icepay': return mk(() => payVoid(s, r.id));
        case 'icemove': return mk(() => moveVoid(s, r.id));
        case 'loss': return mk(() => lossVoid(s, r.id));
        case 'stocktake': return mk(() => stVoid(s, r.id));
        case 'ostock': return mk(() => post(s.app, `/opening-stock/${r.id}/void`, { reason: 'random void' }));
        case 'count': return mk(() => countVoid(s, r.id));
        case 'return': return mk(() => voidReturnNew(s, r.saleId!, r.id), { onOk: () => {
          const l = saleReturns.get(r.saleId!)!; const top = [...l].reverse().find((x) => x.status === 'posted')!; top.status = 'void';
          saleUnits.set(r.saleId!, (saleUnits.get(r.saleId!) ?? 0) + 1);
        } });
        default: return null;
      }
    };

    for (let step = 0; step < OPS; step++) {
      const roll = rand();
      const label = `seed ${seed} step ${step}`;
      // ---- closings and reopens
      if (roll < 0.06) {
        const b = pick(ALL_BOOKS);
        const fr = [...model[b]].sort().pop();
        const d = fr !== undefined && rand() < 0.5
          ? new Date(Date.parse(`${fr}T00:00:00Z`) + (1 + int(3)) * 86400000).toISOString().slice(0, 10)
          : pick(seedDates);
        const date = d > today() ? today() : d;
        const variant = pick(['none', 'none', 'match', 'variance'] as const);
        const bal = balAsOf(s, b, date);
        const extra: Record<string, unknown> = variant === 'none' ? {}
          : variant === 'match' ? { countedCents: bal, ...(b === 'icecream' ? {} : {}) }
            : { countedCents: bal >= 0 ? bal + 300 : 0, note: 'random variance', ...(b === 'icecream' ? { fund: 'profit' } : {}) };
        if (variant !== 'none' && bal < 0 && variant === 'match') continue; // a matching count needs counted >= 0
        const before = light(s);
        const r = await closeNew(s, b, date, extra);
        stats.ops.close = (stats.ops.close ?? 0) + 1;
        const closedAlready = model[b].has(date);
        const later = [...model[b]].some((x) => x > date);
        if (closedAlready) {
          expect(r.status, `${label} close ${b} ${date}`).toBe(409);
          expect(err(r).code, label).toBe('DAY_ALREADY_CLOSED');
        } else if (variant === 'variance' && later && bal !== (extra.countedCents as number)) {
          expect(r.status, `${label} ${JSON.stringify(r.body)}`).toBe(409);
          expect(err(r)).toEqual(backdateBody(b, [...model[b]].filter((x) => x > date).sort().pop()!, date));
        } else {
          expect(r.status, `${label} close ${b} ${date} ${variant}: ${JSON.stringify(r.body)}`).toBe(201);
          model[b].add(date);
          closings[`${b}|${date}`] = { id: r.body.item.id };
          stats.ok++;
        }
        if (r.status !== 201) { stats.refused++; expect(light(s), `${label} refused close wrote something`).toBe(before); }
      } else if (roll < 0.13) {
        const open: Array<[Book, string]> = [];
        for (const b of ALL_BOOKS) for (const d of model[b]) open.push([b, d]);
        if (open.length === 0) continue;
        const [b, d] = pick(open);
        const r = await reopenNew(s, closings[`${b}|${d}`]!.id, 'random reopen');
        expect(r.status, `${label} reopen ${b} ${d}: ${JSON.stringify(r.body)}`).toBe(200);
        model[b].delete(d);
        stats.ops.reopen = (stats.ops.reopen ?? 0) + 1;
      } else {
        const plan = roll < 0.80 ? planCreate() : planVoid();
        if (!plan) continue;
        if (plan.prep) await plan.prep();
        const before = light(s);
        const r = await plan.call();
        stats.ops[plan.name] = (stats.ops[plan.name] ?? 0) + 1;
        const verdict = plan.name.startsWith('ice cream day replace') || plan.name === 'ice day void'
          ? predict(model, plan.books, plan.date) : predict(model, plan.books, plan.date);
        const msg = `${label} ${plan.name} books=${plan.books.join('+')} date=${plan.date} -> ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
        if (verdict) {
          expect(r.status, msg).toBe(409);
          const expected = verdict.code === 'DAY_CLOSED' ? dayClosedBody(verdict.book, plan.date) : backdateBody(verdict.book, verdict.closedDate, plan.date);
          expect(err(r), msg).toEqual(expected);
          stats.byCode[verdict.code] = (stats.byCode[verdict.code] ?? 0) + 1;
        } else {
          const business = plan.then?.() ?? null;
          if (business) {
            expect(r.status, msg).toBe(409);
            expect(err(r).code, msg).toBe(business);
          } else if (r.status === 422 && err(r).code === 'VOID_BREAKS_RELEASE') {
            // the Ice Cream D2 guard (BUSINESS_RULES 10.4) may refuse a void / replacement of a daily entry: a business refusal, not a closed-day verdict
            stats.byCode.VOID_BREAKS_RELEASE = (stats.byCode.VOID_BREAKS_RELEASE ?? 0) + 1;
          } else {
            expect([200, 201], msg).toContain(r.status);
            plan.onOk?.(r);
          }
        }
        if (!(r.status === 200 || r.status === 201)) {
          stats.refused++; refusals++;
          expect(light(s), `${msg}: a refused request wrote something`).toBe(before);
          if (refusals % 20 === 0) {
            const a = fullSnapshot(s); const b = fullSnapshot(s);
            expect(a).toEqual(b);
          }
        } else stats.ok++;
      }
      // ---- invariants after every operation
      expect(closedSnapshotViolations(s), `${label}: a closed day's balance drifted`).toEqual([]);
      const db = dbClosed(s);
      for (const b of ALL_BOOKS) expect([...db[b]].sort(), `${label} closed set of ${b}`).toEqual([...model[b]].sort());
    }
    console.log(`seed ${seed}: ${JSON.stringify(stats)}`);
    // the run must be meaningful: plenty of accepted writes and of both refusal kinds
    expect(stats.ok).toBeGreaterThan(OPS * 0.3);
    expect(stats.byCode.DAY_CLOSED ?? 0).toBeGreaterThan(3);
    expect(stats.byCode.BACKDATE_BEFORE_CLOSED_DAY ?? 0).toBeGreaterThan(10);
    expect(Object.keys(stats.ops).length).toBeGreaterThan(12);
    expect(closedSnapshotViolations(s)).toEqual([]);
  }, 240000);
});
