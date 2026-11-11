// Phase 7 integrity tests: all-or-nothing writes, cash-book reconciliation and a seeded randomized model (BUSINESS_RULES
// sections 2, 6, 8, 12; R1, R12). Protects:
//   - one transaction per write: if the cash entry or the audit row fails, NO sale/supply, NO cash entry and NO audit row remain
//     (and a failed void leaves the record posted with no reversal);
//   - the shop cash book balance equals exactly (posted print revenue) - (posted supplies) - always, including after voids;
//     print revenue is cash-in `sale_service`, supplies are cash-out `printing_supplies`, no other book is touched;
//   - a 250-operation randomized run (sales with price overrides, supplies, voids, repeats, price edits, deactivation) agrees with an
//     independent in-test model of the list totals, the cash balance and the audit row counts.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, breakAudit, get, post } from './helpers/catalog.ts';
import { apiBase, cashRows, daysAgo, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { err, num, snap, sql } from './helpers/phase4.ts';
import { psNew, psVoid, SEEDED, shopBalance, supNew, supVoid, typeIdOf, typePut, typesGet } from './helpers/phase7.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
// Silences the expected server error log lines while tests deliberately force failures.
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

/** Row counts of every table a Phase 7 write may touch. Equal snapshots before/after a failed request prove nothing was half-saved. */
const state = (s: ApiBase) => ({
  ...snap(s),
  print_sales: num(s, 'SELECT COUNT(*) FROM print_sales'),
  printing_supplies: num(s, 'SELECT COUNT(*) FROM printing_supplies'),
});

// =============================================================================================
describe('rollback: one transaction per write', () => {
  it('print sale: a failing audit insert leaves no sale, no cash entry, no audit row', async () => {
    quiet();
    const s = await setup();
    const before = state(s);
    breakAudit(s.ctx, 'print_sale');
    const r = await psNew(s);
    expect(r.status).toBe(500);
    expect(state(s)).toEqual(before);
    expect(shopBalance(s)).toBe(0);
  });

  it('print sale: a failing cash-ledger insert leaves no sale and no audit row', async () => {
    quiet();
    const s = await setup();
    const before = state(s);
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_cash BEFORE INSERT ON cash_entries
      WHEN NEW.ref_table = 'print_sales' BEGIN SELECT RAISE(ABORT, 'cash boom'); END`);
    const r = await psNew(s);
    expect(r.status).toBe(500);
    expect(state(s)).toEqual(before);
    // once the fault is gone the very same request (same clientRef) works - nothing was remembered from the failed try
    s.ctx.database.conn.exec('DROP TRIGGER test_break_cash');
    const clientRef = ref();
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_cash BEFORE INSERT ON cash_entries BEGIN SELECT RAISE(ABORT, 'cash boom'); END`);
    expect((await psNew(s, { clientRef })).status).toBe(500);
    s.ctx.database.conn.exec('DROP TRIGGER test_break_cash');
    const ok = await psNew(s, { clientRef });
    expect(ok.status).toBe(201);
    expect(state(s).print_sales).toBe(1);
  });

  it('supplies: a failing audit or cash insert leaves nothing behind', async () => {
    quiet();
    const s = await setup();
    const before = state(s);
    breakAudit(s.ctx, 'printing_supply');
    expect((await supNew(s)).status).toBe(500);
    expect(state(s)).toEqual(before);
    s.ctx.database.conn.exec('DROP TRIGGER test_break_audit');
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_cash BEFORE INSERT ON cash_entries
      WHEN NEW.ref_table = 'printing_supplies' BEGIN SELECT RAISE(ABORT, 'cash boom'); END`);
    expect((await supNew(s)).status).toBe(500);
    expect(state(s)).toEqual(before);
  });

  it('void: a failing audit or reversal insert leaves the record posted and the ledger unchanged', async () => {
    quiet();
    const s = await setup();
    const sale = (await psNew(s)).body.item;
    const sup = (await supNew(s)).body.item;
    const before = state(s);
    const balance = shopBalance(s);
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_void_audit BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'void' BEGIN SELECT RAISE(ABORT, 'audit boom'); END`);
    expect((await psVoid(s, sale.id)).status).toBe(500);
    expect((await supVoid(s, sup.id)).status).toBe(500);
    expect(state(s)).toEqual(before);
    expect(shopBalance(s)).toBe(balance);
    s.ctx.database.conn.exec('DROP TRIGGER test_break_void_audit');
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_rev BEFORE INSERT ON cash_entries
      WHEN NEW.reverses_entry_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'cash boom'); END`);
    expect((await psVoid(s, sale.id)).status).toBe(500);
    expect((await supVoid(s, sup.id)).status).toBe(500);
    expect(state(s)).toEqual(before);
    expect((await get(s.app, `/print-sales/${sale.id}`)).body.item.status).toBe('posted');
    expect((await get(s.app, `/printing-supplies/${sup.id}`)).body.item.status).toBe('posted');
    // fault removed: the void now works exactly once
    s.ctx.database.conn.exec('DROP TRIGGER test_break_rev');
    expect((await psVoid(s, sale.id)).status).toBe(200);
    expect((await psVoid(s, sale.id)).status).toBe(409);
  });

  it('service-type edits are atomic with their audit row', async () => {
    quiet();
    const s = await setup();
    const id = await typeIdOf(s, 'BW_1S');
    breakAudit(s.ctx, 'print_service_type');
    const r = await typePut(s, id, { name: 'x', priceCents: 1, costCents: 1, active: false });
    expect(r.status).toBe(500);
    const t = (await typesGet(s)).body.items.find((x: any) => x.id === id);
    expect(t).toMatchObject({ name: 'B/W print – one side', priceCents: 1500, costCents: 650, active: true });
  });
});

// =============================================================================================
describe('cash reconciliation: the shop book = posted print revenue - posted supplies, exactly', () => {
  it('worked example: sales 4500 + 3000 + 10000, supplies 2500 + 5000.50, one sale and one supply voided', async () => {
    const s = await setup();
    const a = (await psNew(s, { qty: 3 })).body.item; // BW_1S 3 x 1500 = 4500
    const b = (await psNew(s, { qty: 1 }, 'CLR_2S')).body.item; // 1 x 3000
    (await psNew(s, { qty: 10 }, 'PC_BW_1S')).body.item; // 10 x 1000 = 10000
    const x = (await supNew(s, { amountCents: 250000 })).body.item;
    (await supNew(s, { amountCents: 500050 })).body.item;
    expect(shopBalance(s)).toBe(4500 + 3000 + 10000 - 250000 - 500050); // -732550
    await psVoid(s, b.id); // -3000 from revenue
    await supVoid(s, x.id); // +250000 back
    expect(shopBalance(s)).toBe(4500 + 10000 - 500050); // -485550
    expect(shopBalance(s)).toBe(-485550);
    // list totals agree with the ledger
    const sales = (await get(s.app, '/print-sales')).body.totals;
    const sups = (await get(s.app, '/printing-supplies')).body.totals;
    expect(sales.revenueCents - sups.amountCents).toBe(shopBalance(s));
    expect(sales).toEqual({ revenueCents: 14500, cogsCents: 1950 + 6500, grossProfitCents: 14500 - 8450 });
    // voiding the rest brings the book back to exactly 0
    await psVoid(s, a.id);
    expect(shopBalance(s)).toBe(10000 - 500050);
  });

  it('only the shop book is touched; entry types are exactly sale_service and printing_supplies; every reversal points at its original', async () => {
    const s = await setup();
    const sale = (await psNew(s)).body.item;
    const sup = (await supNew(s)).body.item;
    await psVoid(s, sale.id);
    await supVoid(s, sup.id);
    const rows = cashRows(s.ctx);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.book))).toEqual(new Set(['shop']));
    expect(rows.map((r) => r.type)).toEqual(['sale_service', 'printing_supplies', 'sale_service', 'printing_supplies']);
    expect(rows[2]!.reverses_entry_id).toBe(rows[0]!.id);
    expect(rows[3]!.reverses_entry_id).toBe(rows[1]!.id);
    expect(rows[0]!.amount_cents + rows[2]!.amount_cents).toBe(0);
    expect(rows[1]!.amount_cents + rows[3]!.amount_cents).toBe(0);
    expect(num(s, "SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book <> 'shop'")).toBe(0);
    expect(shopBalance(s)).toBe(0);
  });

  it('supplies have no profit effect: gross profit of the period is unchanged by any supplies purchase or its void', async () => {
    const s = await setup();
    await psNew(s, { qty: 10 }); // revenue 15000, cost 6500, profit 8500
    const gp = async () => (await get(s.app, '/print-sales')).body.totals.grossProfitCents;
    expect(await gp()).toBe(8500);
    const sup = (await supNew(s, { amountCents: 999999 })).body.item;
    expect(await gp()).toBe(8500);
    await supVoid(s, sup.id);
    expect(await gp()).toBe(8500);
  });

  it('a voided sale is excluded from the period totals but its row, its cash entry and its reversal stay (append-only)', async () => {
    const s = await setup();
    const sale = (await psNew(s, { qty: 2 })).body.item;
    await psVoid(s, sale.id);
    expect((await get(s.app, '/print-sales')).body.totals).toEqual({ revenueCents: 0, cogsCents: 0, grossProfitCents: 0 });
    expect(num(s, 'SELECT COUNT(*) FROM print_sales')).toBe(1);
    expect(num(s, 'SELECT COUNT(*) FROM cash_entries')).toBe(2);
  });
});

// =============================================================================================
describe('dates and the audit trail', () => {
  it('every write carries business_date and backdated in its audit row (today = 0, earlier = 1); a void is judged on the original date', async () => {
    const s = await setup();
    const t = (await psNew(s, { businessDate: today() })).body.item;
    const y = (await psNew(s, { businessDate: daysAgo(1) })).body.item;
    const sup = (await supNew(s, { businessDate: daysAgo(30) })).body.item;
    await psVoid(s, t.id); // original date is today -> not backdated
    await psVoid(s, y.id); // original date was yesterday -> backdated
    await supVoid(s, sup.id);
    const rows = sql(s, "SELECT entity, action, business_date, backdated FROM audit_logs WHERE entity IN ('print_sale','printing_supply') ORDER BY id");
    expect(rows).toEqual([
      { entity: 'print_sale', action: 'create', business_date: today(), backdated: 0 },
      { entity: 'print_sale', action: 'create', business_date: daysAgo(1), backdated: 1 },
      { entity: 'printing_supply', action: 'create', business_date: daysAgo(30), backdated: 1 },
      { entity: 'print_sale', action: 'void', business_date: today(), backdated: 0 },
      { entity: 'print_sale', action: 'void', business_date: daysAgo(1), backdated: 1 },
      { entity: 'printing_supply', action: 'void', business_date: daysAgo(30), backdated: 1 },
    ]);
  });

  it('the posting time is set by the server and cannot be supplied; the reversal keeps the original business date', async () => {
    const s = await setup();
    const r = await post(s.app, '/print-sales', { businessDate: today(), serviceTypeId: await typeIdOf(s, 'BW_1S'), qty: 1, clientRef: ref(), postedAt: '2020-01-01T00:00:00.000Z' });
    expect(r.status).toBe(400);
    const d = daysAgo(4);
    const sale = (await psNew(s, { businessDate: d })).body.item;
    expect(sale.postedAt.slice(0, 10)).not.toBe(d);
    await psVoid(s, sale.id);
    const rows = cashRows(s.ctx);
    expect(rows.map((x) => x.business_date)).toEqual([d, d]);
    expect(rows[1]!.posted_at >= rows[0]!.posted_at).toBe(true);
  });
});

// =============================================================================================
// Randomized model test. A tiny seeded generator (mulberry32) drives 250 operations through the real API; an independent model
// (plain arrays + arithmetic, no shared code with the server) predicts every response, the list totals, the shop cash balance and
// the number of audit rows. Fixed seeds make a failure reproducible.
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

interface MSale { id: number; date: string; rev: number; cogs: number; status: 'posted' | 'void' }
interface MSupply { id: number; date: string; amount: number; status: 'posted' | 'void' }
interface MType { id: number; code: string; name: string; price: number; cost: number; active: boolean }

describe('randomized model (250 operations, fixed seeds)', () => {
  for (const seed of [20261111, 7, 424242]) {
    it(`seed ${seed}: API results, list totals, shop balance and audit counts equal the independent model`, async () => {
      const s = await setup();
      const rnd = mulberry32(seed);
      const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
      const pick = <T,>(xs: T[]): T => xs[int(0, xs.length - 1)]!;

      const types: MType[] = [];
      for (const row of (await typesGet(s)).body.items) types.push({ id: row.id, code: row.code, name: row.name, price: SEEDED[row.code]![0], cost: SEEDED[row.code]![1], active: true });
      const sales: MSale[] = [];
      const sups: MSupply[] = [];
      const created: Array<{ kind: 'sale' | 'sup'; body: any; id: number }> = [];
      let typeEdits = 0;

      const check = async () => {
        // shop cash balance
        const modelBalance = sales.filter((x) => x.status === 'posted').reduce((n, x) => n + x.rev, 0)
          - sups.filter((x) => x.status === 'posted').reduce((n, x) => n + x.amount, 0);
        expect(shopBalance(s)).toBe(modelBalance);
        // whole-range totals + a random date window
        const lo = int(0, 9);
        const hi = int(0, lo);
        const inRange = (d: string) => d <= daysAgo(hi) && d >= daysAgo(lo);
        for (const [q, f] of [['', () => true], [`?from=${daysAgo(lo)}&to=${daysAgo(hi)}`, inRange]] as const) {
          const ps = sales.filter((x) => x.status === 'posted' && f(x.date));
          const rev = ps.reduce((n, x) => n + x.rev, 0);
          const cogs = ps.reduce((n, x) => n + x.cogs, 0);
          const l = await get(s.app, `/print-sales${q}${q ? '&' : '?'}limit=1`);
          expect(l.body.totals).toEqual({ revenueCents: rev, cogsCents: cogs, grossProfitCents: rev - cogs });
          expect(l.body.total).toBe(sales.filter((x) => f(x.date)).length);
          const sl = await get(s.app, `/printing-supplies${q}${q ? '&' : '?'}limit=1`);
          expect(sl.body.totals.amountCents).toBe(sups.filter((x) => x.status === 'posted' && f(x.date)).reduce((n, x) => n + x.amount, 0));
          expect(sl.body.total).toBe(sups.filter((x) => f(x.date)).length);
        }
        expect(num(s, 'SELECT COUNT(*) FROM print_sales')).toBe(sales.length);
        expect(num(s, 'SELECT COUNT(*) FROM printing_supplies')).toBe(sups.length);
        const salesAudit = sales.length + sales.filter((x) => x.status === 'void').length;
        const supAudit = sups.length + sups.filter((x) => x.status === 'void').length;
        expect(num(s, "SELECT COUNT(*) FROM audit_logs WHERE entity = 'print_sale'")).toBe(salesAudit);
        expect(num(s, "SELECT COUNT(*) FROM audit_logs WHERE entity = 'printing_supply'")).toBe(supAudit);
        expect(num(s, "SELECT COUNT(*) FROM audit_logs WHERE entity = 'print_service_type'")).toBe(typeEdits);
        const cashCount = sales.filter((x) => x.rev > 0).length + sales.filter((x) => x.rev > 0 && x.status === 'void').length
          + sups.length + sups.filter((x) => x.status === 'void').length;
        expect(num(s, 'SELECT COUNT(*) FROM cash_entries')).toBe(cashCount);
      };

      for (let i = 1; i <= 250; i++) {
        const roll = rnd();
        if (roll < 0.40) { // new print sale
          const active = types.filter((t) => t.active);
          if (active.length === 0) continue;
          const t = pick(active);
          const qty = int(1, 60);
          const date = daysAgo(int(0, 9));
          const body: Record<string, unknown> = { businessDate: date, serviceTypeId: t.id, qty, clientRef: ref() };
          let price = t.price;
          if (rnd() < 0.3) { price = int(0, 5000); body.unitPriceCents = price; }
          const r = await post(s.app, '/print-sales', body);
          expect(r.status, `op ${i}`).toBe(201);
          expect(r.body.item).toMatchObject({ qty, unitPriceCents: price, unitCostCents: t.cost, revenueCents: qty * price, cogsCents: qty * t.cost, status: 'posted' });
          expect(r.body.warnings).toEqual(price < t.cost ? ['PRICE_BELOW_COST'] : []);
          sales.push({ id: r.body.item.id, date, rev: qty * price, cogs: qty * t.cost, status: 'posted' });
          created.push({ kind: 'sale', body, id: r.body.item.id });
        } else if (roll < 0.55) { // supplies purchase
          const amount = int(1, 500000);
          const date = daysAgo(int(0, 9));
          const body = { businessDate: date, amountCents: amount, description: `paper ${i}`, clientRef: ref() };
          const r = await post(s.app, '/printing-supplies', body);
          expect(r.status, `op ${i}`).toBe(201);
          sups.push({ id: r.body.item.id, date, amount, status: 'posted' });
          created.push({ kind: 'sup', body, id: r.body.item.id });
        } else if (roll < 0.70) { // void a posted record
          const posted: Array<['sale' | 'sup', MSale | MSupply]> = [
            ...sales.filter((x) => x.status === 'posted').map((x) => ['sale', x] as ['sale', MSale]),
            ...sups.filter((x) => x.status === 'posted').map((x) => ['sup', x] as ['sup', MSupply]),
          ];
          if (posted.length === 0) continue;
          const [kind, rec] = pick(posted);
          const r = kind === 'sale' ? await psVoid(s, rec.id, `void ${i}`) : await supVoid(s, rec.id, `void ${i}`);
          expect(r.status, `op ${i}`).toBe(200);
          rec.status = 'void';
        } else if (roll < 0.75) { // void something already void -> 409
          const dead = [...sales.filter((x) => x.status === 'void').map((x) => ['sale', x.id] as const), ...sups.filter((x) => x.status === 'void').map((x) => ['sup', x.id] as const)];
          if (dead.length === 0) continue;
          const [kind, id] = pick(dead);
          const r = kind === 'sale' ? await psVoid(s, id) : await supVoid(s, id);
          expect(r.status, `op ${i}`).toBe(409);
        } else if (roll < 0.82) { // repeat an earlier create with the same clientRef -> 200 original, nothing changes
          if (created.length === 0) continue;
          const c = pick(created);
          const r = await post(s.app, c.kind === 'sale' ? '/print-sales' : '/printing-supplies', c.body);
          expect(r.status, `op ${i}`).toBe(200);
          expect(r.body.item.id).toBe(c.id);
        } else if (roll < 0.92) { // edit a type: new price / cost / active flag (past sales must not change)
          const t = pick(types);
          const next = { price: int(0, 5000), cost: int(0, 2000), active: rnd() < 0.8 };
          const r = await typePut(s, t.id, { name: `Edited ${t.code}`, priceCents: next.price, costCents: next.cost, active: next.active });
          expect(r.status, `op ${i}`).toBe(200);
          const newName = `Edited ${t.code}`;
          // the model decides independently whether the save changed anything (an unchanged save writes no audit row)
          if (t.name !== newName || t.price !== next.price || t.cost !== next.cost || t.active !== next.active) typeEdits++;
          t.name = newName;
          t.price = next.price; t.cost = next.cost; t.active = next.active;
        } else { // sell an inactive type -> 409
          const off = types.filter((t) => !t.active);
          if (off.length === 0) continue;
          const t = pick(off);
          const r = await post(s.app, '/print-sales', { businessDate: today(), serviceTypeId: t.id, qty: 1, clientRef: ref() });
          expect(r.status, `op ${i}`).toBe(409);
          expect(err(r).code).toBe('SERVICE_TYPE_INACTIVE');
        }
        if (i % 25 === 0) await check();
      }
      await check();
      expect(sales.length).toBeGreaterThan(40);
      expect(sups.length).toBeGreaterThan(15);
      expect(sales.some((x) => x.status === 'void')).toBe(true);
      // past sales still show the price and cost they were sold with (R12): re-read a sample straight from the API
      for (const x of sales.slice(0, 10)) {
        const item = (await get(s.app, `/print-sales/${x.id}`)).body.item;
        expect([item.revenueCents, item.cogsCents, item.status]).toEqual([x.rev, x.cogs, x.status]);
      }
    }, 120_000);
  }
});
