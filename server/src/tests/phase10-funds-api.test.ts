// Phase 10 Funds endpoints (BUSINESS_RULES 10.1, 10.4-10.7, C4, E5; API_CONTRACTS P10 "GET /icecream/funds", "GET /icecream/funds/entries"). Protects:
//   10.1  fund balances (summing to the Ice Cream cash book) and recognized profit are returned SEPARATELY; the exact contract shape;
//   10.4  Charged / Settled / Unspent per line, combined unspent; opening / capital / cash over-short never become profit-eligible;
//   10.5  excess cost: outstanding excess + EXCESS_COST_OUTSTANDING warning, official profit unchanged, profit after excess cost;
//   10.6  asOf / from / to are BUSINESS dates, never rejected for being in the future; period flows (recognized, excess not yet charged,
//         profit after excess) use only movements inside the period and add up; negative flow when earlier excess is covered;
//   C4    cash over/short is a recognition event (+ over / - short) that never changes Charged / Settled / Unspent;
//   10.7  the fund ledger endpoint returns EVERY row incl. reversals, filters, paging, totals.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get } from './helpers/catalog.ts';
import { apiBase, daysAgo, daysAhead, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { err } from './helpers/phase4.ts';
import { capVoid, countNew, countVoid, openNew } from './helpers/phase8.ts';
import { dayOk, dayVoid, expectBooksAgree, fundLedgerGet, fundsGet, moveOk, moveVoid, payOk, payVoid, rs } from './helpers/phase10.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());

describe('GET /icecream/funds - shape and the two separate measures', () => {
  it('empty book: the exact contract shape with zeros', async () => {
    const s = await setup();
    const r = await fundsGet(s);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['asOf', 'cashBookBalanceCents', 'funds', 'lines', 'outstandingExcessCostCents', 'period', 'profitAfterExcessCostToDateCents',
      'reconciled', 'recognition', 'recognizedProfitToDateCents', 'totalCents', 'unspentAllocationCents', 'warnings'].sort());
    expect(r.body).toMatchObject({
      asOf: null, funds: { cost: { balanceCents: 0 }, electricity: { balanceCents: 0 }, profit: { balanceCents: 0 } }, totalCents: 0, cashBookBalanceCents: 0, reconciled: true,
      lines: { materials: { chargedCents: 0, settledCents: 0, unspentCents: 0 }, electricity: { chargedCents: 0, settledCents: 0, unspentCents: 0 } },
      unspentAllocationCents: 0, outstandingExcessCostCents: 0, recognizedProfitToDateCents: 0, profitAfterExcessCostToDateCents: 0, warnings: [],
      period: { from: null, to: null, recognizedProfitCents: 0, excessCostNotChargedCents: 0, profitAfterExcessCostCents: 0 },
      recognition: { dailyProfitShareCents: 0, profitEligibleReleasesCents: 0, reallocationsCents: 0, otherExpensesCents: 0, cashOverShortCents: 0 },
    });
    expect(Object.keys(r.body.lines.materials).sort()).toEqual(['chargedCents', 'settledCents', 'unspentCents']);
    expect(Object.keys(r.body.funds.cost)).toEqual(['balanceCents']);
  });

  it('10.1: fund balances include opening balance and capital-like money while recognized profit counts ONLY the recognition events', async () => {
    const s = await setup();
    await openNew(s, 'icecream', { fund: 'profit', amountCents: rs(7000), businessDate: daysAgo(5) });
    await dayOk(s, { businessDate: daysAgo(2), salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100) });
    const f = (await fundsGet(s)).body;
    expect(f.funds.profit.balanceCents).toBe(rs(7300)); // cash allocation
    expect(f.recognizedProfitToDateCents).toBe(rs(300)); // official profit: the day's share only (opening balance is never income)
    expect(f.totalCents).toBe(rs(8000));
    expect(f.cashBookBalanceCents).toBe(rs(8000));
    expect(f.reconciled).toBe(true);
    await expectBooksAgree(s);
  });

  it('10.4: lines carry Charged, Settled, Unspent; unspentAllocationCents is their sum', async () => {
    const s = await setup();
    await dayOk(s, { salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100) });
    await payOk(s, 'materials', rs(250), { fund: 'cost' });
    await payOk(s, 'electricity_bill', rs(40), { fund: 'electricity' });
    const f = (await fundsGet(s)).body;
    expect(f.lines).toEqual({ materials: { chargedCents: rs(600), settledCents: rs(250), unspentCents: rs(350) }, electricity: { chargedCents: rs(100), settledCents: rs(40), unspentCents: rs(60) } });
    expect(f.unspentAllocationCents).toBe(rs(410));
    expect(f.outstandingExcessCostCents).toBe(0);
    expect(f.warnings).toEqual([]);
  });

  it('opening balance, capital-style money and over/short are never profit-eligible: a release of them is cash-only (D4)', async () => {
    const s = await setup();
    await openNew(s, 'icecream', { fund: 'cost', amountCents: rs(3000) });
    await openNew(s, 'icecream', { fund: 'electricity', amountCents: rs(1000) });
    const c = await countNew(s, 'icecream', rs(4500), { fund: 'cost', note: 'found extra' }); // +500 over in the Cost fund
    expect(c.status).toBe(201);
    const m = await moveOk(s, 'cost', 'profit', rs(3500));
    expect(m).toMatchObject({ profitEffectCents: 0, cashOnlyCents: rs(3500) });
    const e = await moveOk(s, 'electricity', 'profit', rs(1000));
    expect(e).toMatchObject({ profitEffectCents: 0, cashOnlyCents: rs(1000) });
    const f = (await fundsGet(s)).body;
    expect(f.funds).toEqual({ cost: { balanceCents: 0 }, electricity: { balanceCents: 0 }, profit: { balanceCents: rs(4500) } });
    expect(f.recognizedProfitToDateCents).toBe(rs(500)); // only the over/short counts
    await expectBooksAgree(s);
  });
});

describe('C4 - cash over / short is a recognition event', () => {
  it('over = + profit, short = - profit, in whichever fund the owner chose; Charged / Settled / Unspent untouched; a void nets to zero on the same date', async () => {
    const s = await setup();
    await dayOk(s, { businessDate: daysAgo(3), salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100) });
    const short = await countNew(s, 'icecream', rs(1000 - 80), { fund: 'profit', note: 'till short', businessDate: daysAgo(2) });
    expect(short.body.item.differenceCents).toBe(-rs(80));
    let f = (await fundsGet(s)).body;
    expect(f.recognizedProfitToDateCents).toBe(rs(220));
    expect(f.recognition.cashOverShortCents).toBe(-rs(80));
    expect(f.funds.profit.balanceCents).toBe(rs(220));
    const over = await countNew(s, 'icecream', rs(920 + 30), { fund: 'cost', note: 'found', businessDate: daysAgo(1) });
    expect(over.body.item.differenceCents).toBe(rs(30));
    f = (await fundsGet(s)).body;
    expect(f.recognizedProfitToDateCents).toBe(rs(250)); // 300 - 80 + 30, although the +30 sits in the Cost fund
    expect(f.funds.cost.balanceCents).toBe(rs(630));
    expect(f.lines.materials).toEqual({ chargedCents: rs(600), settledCents: 0, unspentCents: rs(600) });
    expect(f.unspentAllocationCents).toBe(rs(700));
    // asOf: the short is dated daysAgo(2), the over daysAgo(1)
    expect((await fundsGet(s, `?asOf=${daysAgo(3)}`)).body.recognizedProfitToDateCents).toBe(rs(300));
    expect((await fundsGet(s, `?asOf=${daysAgo(2)}`)).body.recognizedProfitToDateCents).toBe(rs(220));
    await countVoid(s, short.body.item.id);
    f = (await fundsGet(s)).body;
    expect(f.recognizedProfitToDateCents).toBe(rs(330));
    expect((await fundsGet(s, `?asOf=${daysAgo(2)}`)).body.recognizedProfitToDateCents).toBe(rs(300)); // the void lands on the count's own date
    await expectBooksAgree(s);
  });
});

describe('10.5 excess cost (D3) and the period rule (10.6)', () => {
  it('outstanding excess, warning text, official profit unchanged and profit after excess cost; a later allocation shrinks it', async () => {
    const s = await setup();
    await dayOk(s, { businessDate: daysAgo(6), salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100) });
    await payOk(s, 'materials', rs(900), { fund: 'cost', businessDate: daysAgo(5) }); // 700 allocated, 900 spent -> excess 200
    let f = (await fundsGet(s)).body;
    expect(f.unspentAllocationCents).toBe(-rs(200));
    expect(f.outstandingExcessCostCents).toBe(rs(200));
    expect(f.recognizedProfitToDateCents).toBe(rs(300));
    expect(f.profitAfterExcessCostToDateCents).toBe(rs(100));
    const w = f.warnings.find((x: any) => x.code === 'EXCESS_COST_OUTSTANDING');
    expect(w).toMatchObject({ book: 'icecream', outstandingExcessCostCents: rs(200) });
    expect(w.message).toContain('Rs. 200.00 excess cost outstanding');
    expect(w.message).toContain('Official profit is not reduced automatically');
    expect(w.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // asOf before the payment: no excess; the warning names the asOf date
    const early = (await fundsGet(s, `?asOf=${daysAgo(6)}`)).body;
    expect(early.outstandingExcessCostCents).toBe(0);
    expect(early.warnings).toEqual([]);
    const at = (await fundsGet(s, `?asOf=${daysAgo(5)}`)).body;
    expect(at.warnings.find((x: any) => x.code === 'EXCESS_COST_OUTSTANDING').asOf).toBe(daysAgo(5));
    // a later daily allocation covers it: the excess shrinks
    await dayOk(s, { businessDate: daysAgo(2), salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100) });
    f = (await fundsGet(s)).body;
    expect(f.outstandingExcessCostCents).toBe(0);
    expect(f.unspentAllocationCents).toBe(rs(500));
    expect(f.warnings.some((x: any) => x.code === 'EXCESS_COST_OUTSTANDING')).toBe(false);
  });

  it('period flows: day rows add up to the span; a negative flow "earlier excess now covered"; balances are as of the end and never summed', async () => {
    const s = await setup();
    await dayOk(s, { businessDate: daysAgo(6), salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100) });
    await payOk(s, 'materials', rs(900), { fund: 'cost', businessDate: daysAgo(5) }); // excess +200 arises on day -5
    await dayOk(s, { businessDate: daysAgo(2), salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100) }); // covered on day -2 (+700 allocated)
    const period = async (from: string, to: string) => (await fundsGet(s, `?from=${from}&asOf=${to}`)).body.period;
    const d5 = await period(daysAgo(5), daysAgo(5));
    expect(d5).toMatchObject({ recognizedProfitCents: 0, excessCostNotChargedCents: rs(200), profitAfterExcessCostCents: -rs(200) });
    const d2 = await period(daysAgo(2), daysAgo(2));
    expect(d2).toMatchObject({ recognizedProfitCents: rs(300), excessCostNotChargedCents: -rs(200), profitAfterExcessCostCents: rs(500) }); // add-back of the earlier excess
    const all = await period(daysAgo(6), today());
    expect(all).toMatchObject({ recognizedProfitCents: rs(600), excessCostNotChargedCents: 0, profitAfterExcessCostCents: rs(600) });
    // additivity over every single day of the span
    let rec = 0; let exc = 0; let after = 0;
    for (let i = 6; i >= 0; i--) {
      const p = await period(daysAgo(i), daysAgo(i));
      rec += p.recognizedProfitCents; exc += p.excessCostNotChargedCents; after += p.profitAfterExcessCostCents;
    }
    expect([rec, exc, after]).toEqual([all.recognizedProfitCents, all.excessCostNotChargedCents, all.profitAfterExcessCostCents]);
    // no `from`: the span runs from the beginning, so the excess flow equals the outstanding balance at asOf
    const toDate = (await fundsGet(s, `?asOf=${daysAgo(5)}`)).body;
    expect(toDate.period).toMatchObject({ from: null, to: daysAgo(5), excessCostNotChargedCents: rs(200) });
    expect(toDate.period.excessCostNotChargedCents).toBe(toDate.outstandingExcessCostCents);
  });

  it('asOf and from are report dates: a future asOf is accepted and shows today\'s figures; bad dates and from > asOf are 400', async () => {
    const s = await setup();
    await dayOk(s);
    const now = (await fundsGet(s)).body;
    const future = await fundsGet(s, `?asOf=${daysAhead(30)}`);
    expect(future.status).toBe(200);
    expect(future.body.funds).toEqual(now.funds);
    expect(future.body.recognizedProfitToDateCents).toBe(now.recognizedProfitToDateCents);
    expect(future.body.asOf).toBe(daysAhead(30));
    expect((await fundsGet(s, '?asOf=2026-02-30')).status).toBe(400);
    expect((await fundsGet(s, '?asOf=abc')).status).toBe(400);
    expect((await fundsGet(s, '?from=2026-13-01')).status).toBe(400);
    const bad = await fundsGet(s, `?from=${daysAgo(1)}&asOf=${daysAgo(3)}`);
    expect(bad.status).toBe(400);
    expect(Object.keys(err(bad).fields)).toEqual(['from']);
    expect((await fundsGet(s, '?bogus=1')).status).toBe(400);
  });

  it('negative fund balance warning per fund as of the date', async () => {
    const s = await setup();
    await dayOk(s, { businessDate: daysAgo(3), salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100) });
    await payOk(s, 'electricity_bill', rs(150), { fund: 'electricity', businessDate: daysAgo(1) });
    const f = (await fundsGet(s)).body;
    expect(f.warnings.filter((w: any) => w.code === 'NEGATIVE_FUND_BALANCE')).toEqual([expect.objectContaining({ fund: 'electricity', balanceCents: -rs(50) })]);
    expect((await fundsGet(s, `?asOf=${daysAgo(2)}`)).body.warnings).toEqual([]);
  });

  it('a voided capital/opening entry changes the fund balances but never the recognized profit', async () => {
    const s = await setup();
    const o = await openNew(s, 'icecream', { fund: 'cost', amountCents: rs(900) });
    await dayOk(s);
    const before = (await fundsGet(s)).body;
    await capVoid(s, o.body.item.id);
    const after = (await fundsGet(s)).body;
    expect(after.funds.cost.balanceCents).toBe(before.funds.cost.balanceCents - rs(900));
    expect(after.recognizedProfitToDateCents).toBe(before.recognizedProfitToDateCents);
    await expectBooksAgree(s);
  });
});

describe('GET /icecream/funds/entries - the complete fund ledger', () => {
  it('returns every row including reversals with kind, ref and reversesEntryId; filters by fund and business date; totals; paging', async () => {
    const s = await setup();
    await openNew(s, 'icecream', { fund: 'cost', amountCents: rs(500), businessDate: daysAgo(4) });
    await dayOk(s, { businessDate: daysAgo(3), salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100) });
    const p = await payOk(s, 'materials', rs(200), { fund: 'cost', businessDate: daysAgo(2) });
    const mv = await moveOk(s, 'cost', 'electricity', rs(50), { businessDate: daysAgo(1) });
    await payVoid(s, p.id);
    expect(err(await dayVoid(s, daysAgo(3))).code).toBe('VOID_BREAKS_RELEASE'); // the re-label depends on the day's allocation (D2)
    expect((await moveVoid(s, mv.id)).status).toBe(200);
    expect((await dayVoid(s, daysAgo(3))).status).toBe(200);
    const all = (await fundLedgerGet(s)).body;
    expect(Object.keys(all).sort()).toEqual(['items', 'total', 'totals']);
    expect(Object.keys(all.items[0]).sort()).toEqual(['amountCents', 'businessDate', 'fund', 'id', 'kind', 'note', 'postedAt', 'reversesEntryId', 'refId', 'refTable'].sort());
    // opening 1 + day 3 + payment 1 + its reversal 1 + move 2 + its reversals 2 + day reversal 3 = 13 rows
    expect(all.total).toBe(13);
    expect(all.items).toHaveLength(13);
    expect(all.items.filter((r: any) => r.kind === 'reversal')).toHaveLength(6);
    expect(all.items.filter((r: any) => r.kind === 'reversal').every((r: any) => r.reversesEntryId !== null)).toBe(true);
    expect(all.totals.netCents).toBe(all.totals.inCents - all.totals.outCents);
    expect(all.totals.netCents).toBe(rs(500 - 0)); // only the opening balance remains after the voids (move nets to zero)
    // ordered by business date, then posting order
    const dates = all.items.map((r: any) => r.businessDate);
    expect([...dates].sort()).toEqual(dates);
    const cost = (await fundLedgerGet(s, '?fund=cost')).body;
    expect(cost.items.every((r: any) => r.fund === 'cost')).toBe(true);
    expect(cost.items.reduce((t: number, r: any) => t + r.amountCents, 0)).toBe((await fundsGet(s)).body.funds.cost.balanceCents);
    const win = (await fundLedgerGet(s, `?from=${daysAgo(2)}&to=${daysAgo(1)}`)).body;
    expect(win.items.every((r: any) => r.businessDate >= daysAgo(2) && r.businessDate <= daysAgo(1))).toBe(true);
    const page = (await fundLedgerGet(s, '?limit=4&offset=4')).body;
    expect(page.items.map((r: any) => r.id)).toEqual(all.items.slice(4, 8).map((r: any) => r.id));
    expect(page.total).toBe(13);
    expect((await fundLedgerGet(s, `?from=${daysAgo(1)}&to=${daysAgo(3)}`)).status).toBe(400);
    expect((await fundLedgerGet(s, '?fund=bank')).status).toBe(400);
    expect((await fundLedgerGet(s, '?limit=0')).status).toBe(400);
    expect((await get(s.app, '/icecream/funds/entries?limit=501')).status).toBe(400);
    await expectBooksAgree(s);
  });
});
