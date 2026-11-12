// Phase 10 worked example (BUSINESS_RULES 10.8) reproduced step by step through the real API. The expected numbers are typed from the
// document's table (helpers/phase10.ts WORKED_EXAMPLE), never taken from the code under test. Protects:
//   10.1  fund balances and recognized profit are separate measures; Cost + Electricity + Profit = Ice Cream cash book after EVERY step;
//   10.3  recognition events: daily entry +profit share, release +eligible part, other cost from Profit -, withdrawal/transfer 0;
//   10.4  Charged / Settled per line after every step incl. the Cost -> Electricity re-label and the release;
//   10.8  the final identity "P&L = 100,000 - 55,000 - 12,000 - 1,000 = 32,000 = true profit";
//   D4    moving the last 5,000 Cost -> Profit: profit-eligible 0, cash-only 5,000, posted only after confirmation, profit stays 32,000;
//   D3    a Rs 20,000 bill with no re-allocation: outstanding excess 5,000, period flow +5,000, profit after excess = recognized - 5,000,
//         and a re-allocation from Profit nets the period flow to zero (nothing counted twice).
// Phase 9 records (withdrawal, transfer to Shop) are written through `postCash`, exactly as Phase 9 will (cash entry + fund row).

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, daysAgo, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { openNew } from './helpers/phase8.ts';
import { WORKED_EXAMPLE, dayOk, expectBooksAgree, fundsGet, moveNew, movePreview, moveOk, payNew, payOk, rs } from './helpers/phase10.ts';
import type { Step } from './helpers/phase10.ts';
import { postCash } from '../services/cash-posting.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());

/** Checks one row of the document's table against the API and the ledgers. */
async function expectStep(s: ApiBase, step: Step): Promise<void> {
  const f = (await fundsGet(s)).body;
  const label = step.name;
  expect([f.funds.cost.balanceCents, f.funds.electricity.balanceCents, f.funds.profit.balanceCents], `${label}: fund balances`)
    .toEqual(step.funds.map(rs));
  expect([f.lines.materials.chargedCents, f.lines.electricity.chargedCents], `${label}: charged M/E`).toEqual(step.charged.map(rs));
  expect([f.lines.materials.settledCents, f.lines.electricity.settledCents], `${label}: settled M/E`).toEqual(step.settled.map(rs));
  expect(f.recognizedProfitToDateCents, `${label}: recognized profit`).toBe(rs(step.recognized));
  await expectBooksAgree(s);
}

/** Phase 9 stand-in: a cash withdrawal / transfer out of the Profit fund (cash entry + fund row in one transaction). */
function profitCashOut(s: ApiBase, type: 'drawing_cash' | 'transfer_out', kind: 'drawing' | 'transfer_out', cents: number): void {
  s.ctx.database.tx((conn) => {
    postCash(conn, { book: 'icecream', fund: 'profit', businessDate: today(), type, amountCents: -cents, refTable: 'phase9_stub', refId: 1, fundKind: kind });
  });
}

describe('BUSINESS_RULES 10.8 worked example', () => {
  it('every row of the table: fund balances, Charged M/E, Settled M/E and recognized profit', async () => {
    const s = await setup();
    // Opening 5,000 -> Cost (Phase 8 endpoint)
    expect((await openNew(s, 'icecream', { fund: 'cost', amountCents: rs(5000), businessDate: daysAgo(3) })).status).toBe(201);
    await expectStep(s, WORKED_EXAMPLE[0]!);

    // Daily entries: sales 100,000 split Cost 60,000 / Electricity 10,000 / Profit 30,000 (two days that add up to it)
    await dayOk(s, { businessDate: daysAgo(2), salesCents: rs(60000), costAllocCents: rs(36000), electricityAllocCents: rs(6000) });
    await dayOk(s, { businessDate: daysAgo(1), salesCents: rs(40000), costAllocCents: rs(24000), electricityAllocCents: rs(4000) });
    await expectStep(s, WORKED_EXAMPLE[1]!);

    // Materials 55,000 from Cost
    await payOk(s, 'materials', rs(55000), { fund: 'cost', businessDate: daysAgo(1) });
    await expectStep(s, WORKED_EXAMPLE[2]!);

    // Electricity bill 12,000 from the Electricity fund: it goes negative (warning, not a block), combined unspent 3,000 -> no excess cost
    const billRes = await payNew(s, 'electricity_bill', rs(12000), { fund: 'electricity' });
    expect(billRes.status).toBe(201);
    const bill = billRes.body;
    expect(bill.warnings.map((w: any) => w.code)).toContain('NEGATIVE_FUND_BALANCE');
    expect(bill.warnings.some((w: any) => w.code === 'EXCESS_COST_OUTSTANDING')).toBe(false);
    expect(bill.funds.unspentAllocationCents).toBe(rs(3000));
    expect(bill.funds.outstandingExcessCostCents).toBe(0);
    await expectStep(s, WORKED_EXAMPLE[3]!);

    // Cost -> Electricity 2,000: the cash moves, the charge re-label is 2,000, profit unchanged
    const relabel = await moveOk(s, 'cost', 'electricity', rs(2000));
    expect(relabel).toMatchObject({ chargeRelabelCents: rs(2000), profitEffectCents: 0, cashOnlyCents: 0, kind: 'relabel' });
    await expectStep(s, WORKED_EXAMPLE[4]!);

    // Cost -> Profit 3,000: profit-eligible 3,000 (no confirmation needed), recognized profit 33,000
    const prev = (await movePreview(s, 'cost', 'profit', rs(3000))).body;
    expect(prev).toMatchObject({ profitEligibleCents: rs(3000), cashOnlyCents: 0, needsConfirmation: false, profitEffectCents: rs(3000) });
    const release = await moveOk(s, 'cost', 'profit', rs(3000));
    expect(release).toMatchObject({ profitEffectCents: rs(3000), cashOnlyCents: 0, chargeRelabelCents: 0, kind: 'release' });
    await expectStep(s, WORKED_EXAMPLE[5]!);

    // Cups 1,000 from the Profit fund: an expense, recognized profit 32,000
    const cups = await payOk(s, 'other_cost', rs(1000), { fund: 'profit', description: 'Cups' });
    expect(cups.pnlTreatment).toBe('expense');
    await expectStep(s, WORKED_EXAMPLE[6]!);

    // Withdrawal 20,000 and transfer to Shop 5,000, both from Profit: recognized profit unchanged
    profitCashOut(s, 'drawing_cash', 'drawing', rs(20000));
    profitCashOut(s, 'transfer_out', 'transfer_out', rs(5000));
    await expectStep(s, WORKED_EXAMPLE[7]!);

    // "Fund total 12,000 = cash book (5,000 + 100,000 - 55,000 - 12,000 - 1,000 - 20,000 - 5,000)"
    const f = (await fundsGet(s)).body;
    expect(f.totalCents).toBe(rs(12000));
    expect(f.cashBookBalanceCents).toBe(rs(5000 + 100000 - 55000 - 12000 - 1000 - 20000 - 5000));
    // "P&L: 100,000 - 55,000 - 12,000 - 1,000 = 32,000 = true profit"
    expect(f.recognizedProfitToDateCents).toBe(rs(100000 - 55000 - 12000 - 1000));
    expect(f.unspentAllocationCents).toBe(0);
    expect(f.outstandingExcessCostCents).toBe(0);
    expect(f.warnings).toEqual([]);

    // D4: moving the last 5,000 Cost -> Profit: profit-eligible 0, cash-only 5,000 (it is the opening balance)
    const p2 = (await movePreview(s, 'cost', 'profit', rs(5000))).body;
    expect(p2).toMatchObject({ profitEligibleCents: 0, cashOnlyCents: rs(5000), profitEffectCents: 0, needsConfirmation: true });
    expect(p2.explanation).toContain('Rs. 5,000.00');
    expect(p2.explanation).toContain('will not count as profit');
    const asked = await moveNew(s, 'cost', 'profit', rs(5000));
    expect(asked.status).toBe(409);
    expect(asked.body.error).toMatchObject({ code: 'SPLIT_CONFIRMATION_REQUIRED', profitEligibleCents: 0, cashOnlyCents: rs(5000) });
    // nothing was posted by the unconfirmed request
    expect((await fundsGet(s)).body.funds.cost.balanceCents).toBe(rs(5000));
    const split = await moveOk(s, 'cost', 'profit', rs(5000));
    expect(split).toMatchObject({ profitEffectCents: 0, cashOnlyCents: rs(5000) });
    const after = (await fundsGet(s)).body;
    expect([after.funds.cost.balanceCents, after.funds.electricity.balanceCents, after.funds.profit.balanceCents]).toEqual([0, 0, rs(12000)]);
    expect(after.recognizedProfitToDateCents).toBe(rs(32000)); // the cash moved, profit stayed 32,000
    await expectBooksAgree(s);
  });

  it('D3: a Rs 20,000 bill with no re-allocation -> outstanding excess 5,000, period flow +5,000; a re-allocation from Profit nets to zero', async () => {
    const s = await setup();
    await openNew(s, 'icecream', { fund: 'cost', amountCents: rs(5000), businessDate: daysAgo(4) });
    await dayOk(s, { businessDate: daysAgo(3), salesCents: rs(60000), costAllocCents: rs(36000), electricityAllocCents: rs(6000) });
    await dayOk(s, { businessDate: daysAgo(2), salesCents: rs(40000), costAllocCents: rs(24000), electricityAllocCents: rs(4000) });
    await payOk(s, 'materials', rs(55000), { fund: 'cost', businessDate: daysAgo(2) });
    const bill = await payOk(s, 'electricity_bill', rs(20000), { fund: 'electricity', businessDate: today() });
    expect(bill.pnlTreatment).toBe('settlement');

    // balances: combined Unspent = (60,000 - 55,000) + (10,000 - 20,000) = -5,000
    const f = (await fundsGet(s)).body;
    expect(f.unspentAllocationCents).toBe(rs(-5000));
    expect(f.outstandingExcessCostCents).toBe(rs(5000));
    expect(f.recognizedProfitToDateCents).toBe(rs(30000)); // official profit unchanged
    expect(f.profitAfterExcessCostToDateCents).toBe(rs(25000));
    const w = f.warnings.find((x: any) => x.code === 'EXCESS_COST_OUTSTANDING');
    expect(w.outstandingExcessCostCents).toBe(rs(5000));
    expect(w.message).toContain('Rs. 5,000.00 excess cost outstanding');

    // the period in which the excess arose (the bill's day): excess not yet charged +5,000, recognized 0, profit after = -5,000
    const p = (await fundsGet(s, `?from=${today()}`)).body.period;
    expect(p).toMatchObject({ recognizedProfitCents: 0, excessCostNotChargedCents: rs(5000), profitAfterExcessCostCents: rs(-5000) });
    // the whole span: recognized 30,000, excess +5,000, profit after 25,000
    const all = (await fundsGet(s, `?from=${daysAgo(3)}`)).body.period;
    expect(all).toMatchObject({ recognizedProfitCents: rs(30000), excessCostNotChargedCents: rs(5000), profitAfterExcessCostCents: rs(25000) });

    // The owner re-allocates 5,000 from Profit to Electricity (D1): recognized profit -5,000, the excess is covered
    const re = await moveOk(s, 'profit', 'electricity', rs(5000));
    expect(re).toMatchObject({ profitEffectCents: rs(-5000), kind: 'reallocation' });
    const g = (await fundsGet(s)).body;
    expect(g.outstandingExcessCostCents).toBe(0);
    expect(g.recognizedProfitToDateCents).toBe(rs(25000));
    expect(g.profitAfterExcessCostToDateCents).toBe(rs(25000));
    expect(g.warnings.some((x: any) => x.code === 'EXCESS_COST_OUTSTANDING')).toBe(false);
    // for the re-allocation's own period, recognized -5,000 and excess flow -5,000 net to zero: nothing is counted twice
    const net = (await fundsGet(s, `?from=${today()}`)).body.period;
    expect(net.recognizedProfitCents).toBe(rs(-5000));
    expect(net.excessCostNotChargedCents).toBe(0); // the bill day's own excess (+5,000) and its coverage (-5,000) in the same day
    expect(net.profitAfterExcessCostCents).toBe(rs(-5000));
    await expectBooksAgree(s);
  });
});
