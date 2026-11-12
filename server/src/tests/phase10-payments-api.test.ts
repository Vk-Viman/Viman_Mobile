// Phase 10 payments API (BUSINESS_RULES 10.2-10.4, E1-E5, R1, R9, R13, R-FD, section 12). Protects:
//   10.2  every payment is cash OUT of the Ice Cream book naming exactly ONE fund chosen each time (fund required, no server default),
//         cash type by kind (materials / electricity bill / other cost) with a `payment` fund row; negative fund/cash = warning, never a block;
//   E1/E4 the electricity bill is its own KIND (a settlement); a category of "electricity" in any case/spacing is 400 ELECTRICITY_NOT_ALLOWED
//         for every kind and writes nothing; other categories (and descriptions) mentioning electricity are fine;
//   10.3  pnlTreatment is derived: expense ONLY for other_cost paid from Profit (recognized profit - amount); everything else is a settlement
//         (recognized profit unchanged); 10.4 settlement attribution to Materials / Electricity (Unspent falls);
//   R1    void = reversal (cash + fund row, original business date), second void 409, R9 DAY_CLOSED, R-FD, backdated audit, clientRef,
//         validation without coercion, rollback leaves nothing behind.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, breakAudit, get, post } from './helpers/catalog.ts';
import { apiBase, daysAgo, daysAhead, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { FUTURE_MSG, err, num, sql } from './helpers/phase4.ts';
import { cashOfRef, closeOk, fundOfRef, openNew, reopenNew } from './helpers/phase8.ts';
import { PAYMENT_KEYS, dayOk, expectBooksAgree, fundsGet, payNew, payOk, payVoid, rs, snap10 } from './helpers/phase10.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

describe('POST /icecream/payments - create', () => {
  it('201 { payment, funds, warnings }: exact shape; cash OUT in the chosen fund; fund row kind payment; audit with business date', async () => {
    const s = await setup();
    await dayOk(s, { salesCents: rs(10000), costAllocCents: rs(6000), electricityAllocCents: rs(1000) });
    const r = await payNew(s, 'materials', rs(2500), { fund: 'cost', description: '  Milk powder ', category: ' Raw material ' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['funds', 'payment', 'warnings']);
    const p = r.body.payment;
    expect(Object.keys(p).sort()).toEqual(PAYMENT_KEYS);
    expect(p).toMatchObject({ kind: 'materials', fund: 'cost', amountCents: rs(2500), description: 'Milk powder', category: 'Raw material', pnlTreatment: 'settlement',
      status: 'posted', backdated: false, businessDate: today(), voidedAt: null, voidReason: null });
    const cash = cashOfRef(s, 'icecream_payments', p.id);
    expect(cash).toHaveLength(1);
    expect(cash[0]).toMatchObject({ book: 'icecream', type: 'icecream_materials_payment', amount_cents: -rs(2500), fund: 'cost', reverses_entry_id: null, business_date: today() });
    expect(fundOfRef(s, 'icecream_payments', p.id).map((f) => [f.fund, f.amount_cents, f.kind])).toEqual([['cost', -rs(2500), 'payment']]);
    expect(r.body.funds.funds.cost.balanceCents).toBe(rs(3500));
    expect(r.body.funds.lines.materials).toEqual({ chargedCents: rs(6000), settledCents: rs(2500), unspentCents: rs(3500) });
    expect(r.body.funds.recognizedProfitToDateCents).toBe(rs(3000)); // a settlement never changes recognized profit
    const a = auditRows(s.ctx, 'icecream_payment');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'create', before: null, entityId: String(p.id) });
    expect(sql(s, "SELECT business_date, backdated FROM audit_logs WHERE entity = 'icecream_payment'")[0]).toMatchObject({ business_date: today(), backdated: 0 });
    await expectBooksAgree(s);
  });

  it('cash type by kind; the fund is whatever the owner chose (the presets are UI-only) - every kind from every fund', async () => {
    const s = await setup();
    const types = { materials: 'icecream_materials_payment', electricity_bill: 'icecream_electricity_payment', other_cost: 'icecream_other_cost' } as const;
    for (const kind of ['materials', 'electricity_bill', 'other_cost'] as const) {
      for (const fund of ['cost', 'electricity', 'profit']) {
        const p = await payOk(s, kind, rs(10), { fund });
        expect(cashOfRef(s, 'icecream_payments', p.id)[0]).toMatchObject({ type: types[kind], fund, amount_cents: -rs(10) });
      }
    }
    expect(num(s, 'SELECT COUNT(*) FROM icecream_payments')).toBe(9);
    await expectBooksAgree(s);
  });

  it('10.3: pnlTreatment is derived - expense ONLY for other_cost from Profit, a settlement in every other combination', async () => {
    const s = await setup();
    const got: Record<string, string> = {};
    for (const kind of ['materials', 'electricity_bill', 'other_cost'] as const) {
      for (const fund of ['cost', 'electricity', 'profit']) got[`${kind}/${fund}`] = (await payOk(s, kind, rs(1), { fund })).pnlTreatment;
    }
    expect(Object.entries(got).filter(([, v]) => v === 'expense').map(([k]) => k)).toEqual(['other_cost/profit']);
  });

  it('10.3/10.4 effects: other cost from Profit lowers recognized profit; from Cost/Electricity it only lowers that line\'s Unspent; payments settle their own line', async () => {
    const s = await setup();
    await dayOk(s, { salesCents: rs(10000), costAllocCents: rs(6000), electricityAllocCents: rs(1000) });
    const fromProfit = await payNew(s, 'other_cost', rs(100), { fund: 'profit', description: 'Cups' });
    expect(fromProfit.body.funds.recognizedProfitToDateCents).toBe(rs(2900));
    expect(fromProfit.body.funds.recognition.otherExpensesCents).toBe(-rs(100));
    expect(fromProfit.body.funds.lines.materials.settledCents).toBe(0); // an expense settles no allocation
    const fromCost = await payNew(s, 'other_cost', rs(200), { fund: 'cost', description: 'Repair' });
    expect(fromCost.body.funds.recognizedProfitToDateCents).toBe(rs(2900)); // never a separate expense
    expect(fromCost.body.funds.lines.materials).toEqual({ chargedCents: rs(6000), settledCents: rs(200), unspentCents: rs(5800) });
    const fromElec = await payNew(s, 'other_cost', rs(50), { fund: 'electricity', description: 'Wire' });
    expect(fromElec.body.funds.lines.electricity.settledCents).toBe(rs(50));
    const bill = await payNew(s, 'electricity_bill', rs(300), { fund: 'cost', description: 'CEB' }); // bill paid from the COST fund still settles Electricity
    expect(bill.body.funds.lines.electricity.settledCents).toBe(rs(350));
    expect(bill.body.funds.lines.materials.settledCents).toBe(rs(200));
    const mat = await payNew(s, 'materials', rs(400), { fund: 'profit', description: 'Sugar' }); // materials from Profit still settle Materials
    expect(mat.body.funds.lines.materials.settledCents).toBe(rs(600));
    expect(mat.body.funds.recognizedProfitToDateCents).toBe(rs(2900));
    await expectBooksAgree(s);
  });

  it('R13/10.2: a payment that takes a fund (and the book) below zero is SAVED with warnings; excess cost warns when spending exceeds the allocation (D3)', async () => {
    const s = await setup();
    await dayOk(s, { salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100) });
    const r = await payNew(s, 'electricity_bill', rs(500), { fund: 'electricity' });
    expect(r.status).toBe(201);
    const codes = r.body.warnings.map((w: any) => w.code);
    expect(codes).toContain('NEGATIVE_FUND_BALANCE');
    expect(codes).not.toContain('NEGATIVE_CASH_BALANCE'); // the book (Rs 1,000) is still positive
    expect(r.body.warnings.find((w: any) => w.code === 'NEGATIVE_FUND_BALANCE')).toMatchObject({ fund: 'electricity', balanceCents: -rs(400), book: 'icecream' });
    expect(codes).not.toContain('EXCESS_COST_OUTSTANDING'); // materials unspent 600 covers the 400 shortfall
    const big = await payNew(s, 'materials', rs(1500), { fund: 'cost' });
    const bigCodes = big.body.warnings.map((w: any) => w.code);
    expect(bigCodes).toEqual(expect.arrayContaining(['NEGATIVE_CASH_BALANCE', 'NEGATIVE_FUND_BALANCE', 'EXCESS_COST_OUTSTANDING']));
    expect(big.body.funds.outstandingExcessCostCents).toBe(rs(1300)); // 700 allocated - 2,000 paid
    expect(big.body.funds.recognizedProfitToDateCents).toBe(rs(300)); // official profit never reduced automatically
  });

  it('E4: category "electricity" in any case or spacing is 400 ELECTRICITY_NOT_ALLOWED for EVERY kind; nothing is written', async () => {
    const s = await setup();
    const before = snap10(s);
    for (const category of ['electricity', 'Electricity', ' ELECTRICITY ', 'eLeCtRiCiTy', '  electricity']) {
      for (const kind of ['materials', 'electricity_bill', 'other_cost'] as const) {
        const r = await payNew(s, kind, rs(10), { category });
        expect(r.status, `${kind}/${JSON.stringify(category)}`).toBe(400);
        expect(err(r).code).toBe('ELECTRICITY_NOT_ALLOWED');
        expect(Object.keys(err(r).fields)).toEqual(['category']);
        expect(err(r).message).toContain('Electricity bill');
      }
    }
    expect(snap10(s)).toEqual(before);
    // the refusal is validation, so it comes before the date checks
    expect(err(await payNew(s, 'other_cost', rs(10), { category: 'electricity', businessDate: daysAhead(3) })).code).toBe('ELECTRICITY_NOT_ALLOWED');
  });

  it('other categories and descriptions that merely MENTION electricity are fine (only the category value "electricity" is refused)', async () => {
    const s = await setup();
    expect((await payNew(s, 'other_cost', rs(10), { category: 'Electrical repair', description: 'Electricity meter box repair' })).status).toBe(201);
    expect((await payNew(s, 'electricity_bill', rs(10), { description: 'Electricity bill October' })).status).toBe(201);
    expect((await payNew(s, 'other_cost', rs(10), { category: '' })).body.payment.category).toBeNull();
  });

  it('validation: fund is REQUIRED (no server default), kinds and funds are enums, amounts are positive integers, no coercion, unknown fields, postedAt', async () => {
    const s = await setup();
    const before = snap10(s);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ fund: 'bank' }, 'fund'], [{ fund: null }, 'fund'], [{ kind: 'wages' }, 'kind'], [{ amountCents: 0 }, 'amountCents'], [{ amountCents: -5 }, 'amountCents'],
      [{ amountCents: 10.5 }, 'amountCents'], [{ amountCents: '100' }, 'amountCents'], [{ amountCents: 1e12 + 1 }, 'amountCents'], [{ description: '   ' }, 'description'],
      [{ description: 'x'.repeat(201) }, 'description'], [{ category: 'x'.repeat(61) }, 'category'], [{ businessDate: 'yesterday' }, 'businessDate'],
      [{ businessDate: '2026-02-30' }, 'businessDate'], [{ clientRef: 'abc' }, 'clientRef'], [{ postedAt: '2020-01-01T00:00:00Z' }, 'postedAt'],
      [{ pnlTreatment: 'expense' }, 'pnlTreatment'], [{ foo: 1 }, 'foo'],
    ];
    for (const [over, field] of cases) {
      const r = await payNew(s, 'materials', rs(10), over);
      expect(r.status, JSON.stringify(over)).toBe(400);
      expect(err(r).code).toBe('VALIDATION_ERROR');
      expect(Object.keys(err(r).fields), JSON.stringify(over)).toContain(field);
    }
    for (const missing of ['businessDate', 'kind', 'fund', 'amountCents', 'description', 'clientRef']) {
      const body: Record<string, unknown> = { businessDate: today(), kind: 'materials', fund: 'cost', amountCents: 100, description: 'x', clientRef: ref() };
      delete body[missing];
      const r = await post(s.app, '/icecream/payments', body);
      expect(r.status, missing).toBe(400);
      expect(Object.keys(err(r).fields)).toContain(missing);
    }
    expect(snap10(s)).toEqual(before);
  });

  it('R-FD: future date refused with the owner wording; backdated accepted and flagged in the audit', async () => {
    const s = await setup();
    const f = await payNew(s, 'materials', rs(10), { businessDate: daysAhead(1) });
    expect(err(f)).toMatchObject({ code: 'FUTURE_DATE_NOT_ALLOWED', message: FUTURE_MSG, fields: { businessDate: FUTURE_MSG } });
    const b = await payNew(s, 'materials', rs(10), { businessDate: daysAgo(4) });
    expect(b.status).toBe(201);
    expect(b.body.payment.backdated).toBe(true);
    expect(sql(s, "SELECT business_date, backdated FROM audit_logs WHERE entity = 'icecream_payment'")[0]).toMatchObject({ business_date: daysAgo(4), backdated: 1 });
    expect(num(s, 'SELECT COUNT(*) FROM icecream_payments')).toBe(1);
  });

  it('duplicate submission: the same clientRef returns the first payment (200), no second payment, cash entry, fund row or audit row', async () => {
    const s = await setup();
    const clientRef = ref();
    const a = await payNew(s, 'materials', rs(10), { clientRef });
    const before = snap10(s);
    const b = await payNew(s, 'materials', rs(10), { clientRef });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.payment).toEqual(a.body.payment);
    expect(snap10(s)).toEqual(before);
  });

  it('opening balance and capital are NOT allocations: paying from an opening-balance fund creates excess, not profit (nothing is charged)', async () => {
    const s = await setup();
    await openNew(s, 'icecream', { fund: 'cost', amountCents: rs(5000) });
    const r = await payNew(s, 'materials', rs(1000), { fund: 'cost' });
    expect(r.body.funds.funds.cost.balanceCents).toBe(rs(4000));
    expect(r.body.funds.lines.materials).toEqual({ chargedCents: 0, settledCents: rs(1000), unspentCents: -rs(1000) });
    expect(r.body.funds.outstandingExcessCostCents).toBe(rs(1000));
  });
});

describe('POST /icecream/payments/:id/void', () => {
  it('R1: reversal cash entry + fund row with the original business date, payment void, Settled falls back; audit with reason', async () => {
    const s = await setup();
    await dayOk(s, { salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100) });
    const p = await payOk(s, 'materials', rs(250), { businessDate: daysAgo(2), fund: 'cost' });
    const r = await payVoid(s, p.id, 'wrong supplier');
    expect(r.status).toBe(200);
    expect(r.body.payment).toMatchObject({ status: 'void', voidReason: 'wrong supplier' });
    expect(r.body.payment.voidedAt).toBeTruthy();
    expect(r.body.funds.lines.materials.settledCents).toBe(0);
    expect(r.body.funds.funds.cost.balanceCents).toBe(rs(600));
    const cash = cashOfRef(s, 'icecream_payments', p.id);
    expect(cash).toHaveLength(2);
    expect(cash[1]).toMatchObject({ amount_cents: rs(250), reverses_entry_id: cash[0]!.id, business_date: daysAgo(2), fund: 'cost', type: 'icecream_materials_payment' });
    expect(fundOfRef(s, 'icecream_payments', p.id).map((f) => [f.kind, f.amount_cents])).toEqual([['payment', -rs(250)], ['reversal', rs(250)]]);
    expect(auditRows(s.ctx, 'icecream_payment').map((a) => a.action)).toEqual(['create', 'void']);
    expect(sql(s, "SELECT business_date, backdated, note FROM audit_logs WHERE action = 'void' AND entity = 'icecream_payment'")[0]).toMatchObject({ business_date: daysAgo(2), backdated: 1, note: 'wrong supplier' });
    await expectBooksAgree(s);
  });

  it('voiding the expense payment from Profit restores recognized profit', async () => {
    const s = await setup();
    await dayOk(s);
    const p = await payOk(s, 'other_cost', rs(50), { fund: 'profit' });
    expect((await fundsGet(s)).body.recognizedProfitToDateCents).toBe(rs(250));
    await payVoid(s, p.id);
    expect((await fundsGet(s)).body.recognizedProfitToDateCents).toBe(rs(300));
  });

  it('404 unknown id, 409 ALREADY_VOID on the second void, reason required, id must be digits', async () => {
    const s = await setup();
    const p = await payOk(s, 'materials', rs(10));
    expect((await payVoid(s, 99999)).status).toBe(404);
    expect((await post(s.app, `/icecream/payments/${p.id}/void`, { reason: ' ' })).status).toBe(400);
    expect((await post(s.app, `/icecream/payments/${p.id}/void`, {})).status).toBe(400);
    expect((await post(s.app, '/icecream/payments/abc/void', { reason: 'x' })).status).toBe(400);
    expect((await payVoid(s, p.id)).status).toBe(200);
    const again = await payVoid(s, p.id);
    expect(again.status).toBe(409);
    expect(err(again).code).toBe('ALREADY_VOID');
  });

  it('R9: create and void on a closed Ice Cream day are 409 DAY_CLOSED and write nothing; a reopen lifts it', async () => {
    const s = await setup();
    const date = daysAgo(2);
    const p = await payOk(s, 'materials', rs(10), { businessDate: date });
    const closing = await closeOk(s, 'icecream', date);
    const before = snap10(s);
    const c = await payNew(s, 'materials', rs(10), { businessDate: date });
    expect(c.status).toBe(409);
    expect(err(c)).toMatchObject({ code: 'DAY_CLOSED', book: 'icecream', businessDate: date });
    const v = await payVoid(s, p.id);
    expect(err(v)).toMatchObject({ code: 'DAY_CLOSED', book: 'icecream', businessDate: date });
    expect(snap10(s)).toEqual(before);
    await reopenNew(s, closing.id);
    expect((await payVoid(s, p.id)).status).toBe(200);
  });
});

describe('GET /icecream/payments', () => {
  it('newest first, void rows listed but not summed, filters by kind/fund/status/dates, paging', async () => {
    const s = await setup();
    const a = await payOk(s, 'materials', rs(100), { businessDate: daysAgo(3), fund: 'cost' });
    await payOk(s, 'electricity_bill', rs(200), { businessDate: daysAgo(2), fund: 'electricity' });
    await payOk(s, 'other_cost', rs(300), { businessDate: daysAgo(1), fund: 'profit' });
    await payVoid(s, a.id);
    const all = (await get(s.app, '/icecream/payments')).body;
    expect(all.items.map((p: any) => [p.kind, p.status])).toEqual([['other_cost', 'posted'], ['electricity_bill', 'posted'], ['materials', 'void']]);
    expect(all.total).toBe(3);
    expect(all.totals.amountCents).toBe(rs(500));
    expect((await get(s.app, '/icecream/payments?kind=electricity_bill')).body.items).toHaveLength(1);
    expect((await get(s.app, '/icecream/payments?fund=profit')).body.items).toHaveLength(1);
    expect((await get(s.app, '/icecream/payments?status=void')).body.items).toHaveLength(1);
    expect((await get(s.app, `/icecream/payments?from=${daysAgo(2)}&to=${daysAgo(2)}`)).body.items).toHaveLength(1);
    expect((await get(s.app, '/icecream/payments?limit=1&offset=2')).body.items.map((p: any) => p.kind)).toEqual(['materials']);
    expect((await get(s.app, '/icecream/payments?kind=bogus')).status).toBe(400);
    expect((await get(s.app, '/icecream/payments?limit=501')).status).toBe(400);
  });
});

describe('rollback: one transaction per payment write', () => {
  it('a failing audit insert leaves no payment, cash entry or fund row', async () => {
    quiet();
    const s = await setup();
    const before = snap10(s);
    breakAudit(s.ctx, 'icecream_payment');
    expect((await payNew(s, 'materials', rs(10))).status).toBe(500);
    expect(snap10(s)).toEqual(before);
  });

  it('a failing cash insert leaves no payment, fund row or audit row; the same clientRef works once the fault is gone', async () => {
    quiet();
    const s = await setup();
    const before = snap10(s);
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_cash BEFORE INSERT ON cash_entries WHEN NEW.type = 'icecream_other_cost' BEGIN SELECT RAISE(ABORT, 'cash boom'); END`);
    const clientRef = ref();
    expect((await payNew(s, 'other_cost', rs(10), { clientRef })).status).toBe(500);
    expect(snap10(s)).toEqual(before);
    s.ctx.database.conn.exec('DROP TRIGGER test_break_cash');
    expect((await payNew(s, 'other_cost', rs(10), { clientRef })).status).toBe(201);
  });

  it('a failing audit on VOID leaves the payment posted and no reversal rows', async () => {
    quiet();
    const s = await setup();
    const p = await payOk(s, 'materials', rs(10));
    const before = snap10(s);
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'void' BEGIN SELECT RAISE(ABORT, 'audit boom'); END`);
    expect((await payVoid(s, p.id)).status).toBe(500);
    expect(snap10(s)).toEqual(before);
    expect(sql(s, 'SELECT status FROM icecream_payments WHERE id = ?', p.id)[0]!.status).toBe('posted');
  });
});
