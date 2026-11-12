// Phase 10 pure rules (services/icecream-rules.ts) - no database, no HTTP. Protects BUSINESS_RULES section 10:
//   10.4  Charged / Settled / Unspent per line (every settlement attribution), combined Unspent, net releases;
//   10.4  profit-eligible limit min(max(0, Unspent_L), max(0, Unspent)) incl. "other line negative" and "line already spent";
//   D4    release split (eligible / cash-only) and the needs-confirmation flag; D1 re-allocation = minus the FULL amount;
//   10.4  Cost <-> Electricity re-label = min(x, max(0, Unspent_source)), profit unchanged, both directions;
//   D2    void guard on the FINAL state: daily entry, re-allocation, re-label; void-and-replace judged after the replacement;
//   10.5  outstanding excess = max(0, -Unspent) as of a date;
//   10.6  period rule: recognized profit / excess not yet charged / profit after excess are pure flows that ADD UP (day rows -> month),
//         balances are as of period end; the identity recognized - true profit = -Unspent (10.4).
// The worked example of 10.8 is replayed here from the document's numbers (helpers/phase10.ts WORKED_EXAMPLE), expected values typed
// from the table, not computed.

import { describe, it, expect } from 'vitest';
import {
  emptyFacts, lineOfFund, moveKind, outstandingExcess, periodReport, planMove, pnlTreatment, profitEligibleLimit, recognizedProfit,
  settledLine, standing, standingBefore, trueProfit, voidGuard, withReplacedDay, withoutDay, withoutMove,
} from '../services/icecream-rules.ts';
import type { DayFact, Fund, IceFacts, MoveFact, PaymentFact, PaymentKind, Standing } from '../services/icecream-rules.ts';
import { WORKED_EXAMPLE, rs } from './helpers/phase10.ts';
import { rng } from './helpers/phase8.ts';

// ---------- fact builders (rupees in, cents inside) ----------
let id = 0;
const day = (date: string, s: number, c: number, e: number): DayFact =>
  ({ id: ++id, businessDate: date, salesCents: rs(s), costCents: rs(c), electricityCents: rs(e), profitShareCents: rs(s - c - e) });
const pay = (date: string, kind: PaymentKind, fund: Fund, amount: number): PaymentFact =>
  ({ id: ++id, businessDate: date, kind, fund, amountCents: rs(amount) });
/** A move with the figures `planMove` computes at the moment of saving (what the service stores). */
function move(facts: IceFacts, date: string, from: Fund, to: Fund, amount: number): MoveFact {
  const p = planMove(standing(facts), from, to, rs(amount));
  return {
    id: ++id, businessDate: date, fromFund: from, toFund: to, amountCents: rs(amount), profitEffectCents: p.profitEffectCents,
    chargeRelabelCents: p.chargeRelabelCents, cashOnlyCents: p.cashOnlyCents,
  };
}
const facts = (p: Partial<IceFacts> = {}): IceFacts => ({ ...emptyFacts(), ...p });
const M = (st: Standing) => [st.materials.chargedCents, st.electricity.chargedCents, st.materials.settledCents, st.electricity.settledCents];

describe('settlement attribution and P&L treatment (10.3, 10.4, E4)', () => {
  const cases: Array<[PaymentKind, Fund, string | null, string]> = [
    ['materials', 'cost', 'materials', 'settlement'],
    ['materials', 'profit', 'materials', 'settlement'], // a payment from the Profit fund still settles its own line
    ['materials', 'electricity', 'materials', 'settlement'],
    ['electricity_bill', 'electricity', 'electricity', 'settlement'],
    ['electricity_bill', 'cost', 'electricity', 'settlement'],
    ['electricity_bill', 'profit', 'electricity', 'settlement'],
    ['other_cost', 'cost', 'materials', 'settlement'],
    ['other_cost', 'electricity', 'electricity', 'settlement'],
    ['other_cost', 'profit', null, 'expense'], // the ONLY expense
  ];
  it.each(cases)('%s from %s settles %s and is a %s', (kind, fund, line, treatment) => {
    expect(settledLine(kind, fund)).toBe(line);
    expect(pnlTreatment(kind, fund)).toBe(treatment);
  });
  it('fund -> line and move kinds', () => {
    expect(lineOfFund('cost')).toBe('materials');
    expect(lineOfFund('electricity')).toBe('electricity');
    expect(lineOfFund('profit')).toBeNull();
    expect(moveKind('cost', 'profit')).toBe('release');
    expect(moveKind('electricity', 'profit')).toBe('release');
    expect(moveKind('profit', 'cost')).toBe('reallocation');
    expect(moveKind('profit', 'electricity')).toBe('reallocation');
    expect(moveKind('cost', 'electricity')).toBe('relabel');
    expect(moveKind('electricity', 'cost')).toBe('relabel');
  });
});

describe('BUSINESS_RULES 10.8 worked example - pure module, row by row', () => {
  it('Charged, Settled and recognized profit after every step match the document', () => {
    let f = facts();
    const check = (i: number) => {
      const step = WORKED_EXAMPLE[i]!;
      const st = standing(f);
      expect(M(st), step.name).toEqual([...step.charged.map(rs), ...step.settled.map(rs)]);
      expect(recognizedProfit(f), step.name).toBe(rs(step.recognized));
    };
    check(0); // opening balance is not a fact for the rules at all (10.3: recognition 0, never charged)
    f = facts({ days: [day('2026-11-01', 60000, 36000, 6000), day('2026-11-02', 40000, 24000, 4000)] });
    check(1);
    f.payments.push(pay('2026-11-03', 'materials', 'cost', 55000));
    check(2);
    f.payments.push(pay('2026-11-03', 'electricity_bill', 'electricity', 12000));
    check(3);
    expect(outstandingExcess(standing(f))).toBe(0); // combined unspent 3,000 -> no excess cost
    expect(standing(f).unspentCents).toBe(rs(3000));
    const relabel = move(f, '2026-11-04', 'cost', 'electricity', 2000);
    expect(relabel.chargeRelabelCents).toBe(rs(2000));
    f.moves.push(relabel);
    check(4);
    const release = move(f, '2026-11-05', 'cost', 'profit', 3000);
    expect(release).toMatchObject({ profitEffectCents: rs(3000), cashOnlyCents: 0 });
    f.moves.push(release);
    check(5);
    f.payments.push(pay('2026-11-06', 'other_cost', 'profit', 1000));
    check(6);
    check(7); // withdrawal and transfer out are not recognition events: no fact, recognized profit stays
    // D4: the last 5,000 Cost -> Profit is the opening balance: eligible 0, cash-only 5,000
    const p = planMove(standing(f), 'cost', 'profit', rs(5000));
    expect(p).toMatchObject({ profitEligibleCents: 0, cashOnlyCents: rs(5000), profitEffectCents: 0, needsConfirmation: true, limitCents: 0 });
    // the P&L of the document: 100,000 - 55,000 - 12,000 - 1,000 = 32,000 = true profit, identity with Unspent 0
    expect(trueProfit(f)).toBe(rs(32000));
    expect(recognizedProfit(f) - trueProfit(f) + standing(f).unspentCents).toBe(0);
  });

  it('D3: bill 20,000 with no re-allocation -> unspent -5,000, outstanding 5,000; the re-allocation covers it (D1) and nets the flow to zero', () => {
    const f = facts({ days: [day('2026-11-01', 100000, 60000, 10000)], payments: [pay('2026-11-02', 'materials', 'cost', 55000), pay('2026-11-03', 'electricity_bill', 'electricity', 20000)] });
    expect(standing(f).unspentCents).toBe(rs(-5000));
    expect(outstandingExcess(standing(f))).toBe(rs(5000));
    expect(recognizedProfit(f)).toBe(rs(30000));
    const day3 = periodReport(f, '2026-11-03', '2026-11-03');
    expect(day3).toMatchObject({ recognizedProfitCents: 0, excessCostNotChargedCents: rs(5000), profitAfterExcessCostCents: rs(-5000) });
    expect(day3.balancesAsOfPeriodEnd.outstandingExcessCostCents).toBe(rs(5000));
    const month = periodReport(f, '2026-11-01', '2026-11-30');
    expect(month).toMatchObject({ recognizedProfitCents: rs(30000), excessCostNotChargedCents: rs(5000), profitAfterExcessCostCents: rs(25000) });
    // re-allocate 5,000 from Profit to Electricity: recognized -5,000, excess covered by the same amount
    f.moves.push(move(f, '2026-11-04', 'profit', 'electricity', 5000));
    const d4 = periodReport(f, '2026-11-04', '2026-11-04');
    expect(d4).toMatchObject({ recognizedProfitCents: rs(-5000), excessCostNotChargedCents: rs(-5000), profitAfterExcessCostCents: 0 });
    expect(outstandingExcess(standing(f))).toBe(0);
    expect(periodReport(f, '2026-11-01', '2026-11-30')).toMatchObject({ recognizedProfitCents: rs(25000), excessCostNotChargedCents: 0, profitAfterExcessCostCents: rs(25000) });
  });
});

describe('profit-eligible limit and release split (10.4, D4)', () => {
  it('limit = min(max(0, Unspent_L), max(0, Unspent)): the line AND the combined unspent both cap it', () => {
    // Materials unspent 5,000, Electricity unspent -3,000 -> combined 2,000 caps the Cost release at 2,000
    const f = facts({ days: [day('d1', 20000, 15000, 2000)], payments: [pay('d1', 'materials', 'cost', 10000), pay('d1', 'electricity_bill', 'electricity', 5000)] });
    const st = standing(f);
    expect([st.materials.unspentCents, st.electricity.unspentCents, st.unspentCents]).toEqual([rs(5000), rs(-3000), rs(2000)]);
    expect(profitEligibleLimit(st, 'materials')).toBe(rs(2000));
    expect(profitEligibleLimit(st, 'electricity')).toBe(0); // negative line: nothing eligible
  });
  it('a line already fully spent (or never charged) has limit 0; opening/capital are not facts so they can never be eligible', () => {
    expect(profitEligibleLimit(standing(facts()), 'materials')).toBe(0);
    const f = facts({ days: [day('d1', 1000, 600, 100)], payments: [pay('d1', 'materials', 'cost', 600)] });
    expect(profitEligibleLimit(standing(f), 'materials')).toBe(0);
    expect(profitEligibleLimit(standing(f), 'electricity')).toBe(rs(100));
  });
  it('release below / at / above the limit: eligible part, cash-only rest, confirmation only above', () => {
    const f = facts({ days: [day('d1', 1000, 600, 100)] }); // limit Cost 600, Electricity 100
    expect(planMove(standing(f), 'cost', 'profit', rs(500))).toMatchObject({ profitEligibleCents: rs(500), cashOnlyCents: 0, needsConfirmation: false, profitEffectCents: rs(500), limitCents: rs(600) });
    expect(planMove(standing(f), 'cost', 'profit', rs(600))).toMatchObject({ profitEligibleCents: rs(600), cashOnlyCents: 0, needsConfirmation: false });
    expect(planMove(standing(f), 'cost', 'profit', rs(601))).toMatchObject({ profitEligibleCents: rs(600), cashOnlyCents: rs(1), needsConfirmation: true, profitEffectCents: rs(600) });
    expect(planMove(standing(f), 'electricity', 'profit', rs(250))).toMatchObject({ profitEligibleCents: rs(100), cashOnlyCents: rs(150), needsConfirmation: true });
  });
  it('a release lowers the line charge by the eligible part ONLY (the cash-only part never touches the charge)', () => {
    const f = facts({ days: [day('d1', 1000, 600, 100)] });
    f.moves.push(move(f, 'd2', 'cost', 'profit', 800)); // eligible 600, cash-only 200
    const st = standing(f);
    expect(st.materials.chargedCents).toBe(0);
    expect(st.netReleasesCents).toBe(rs(600));
    expect(recognizedProfit(f)).toBe(rs(300 + 600));
    // the same cost cannot be released twice
    expect(planMove(st, 'cost', 'profit', rs(1)).profitEligibleCents).toBe(0);
  });
});

describe('re-allocation (D1) and Cost <-> Electricity re-label (10.4)', () => {
  it('D1: Profit -> Cost/Electricity lowers recognized profit by the FULL amount and raises that line\'s charge, even above the Profit balance', () => {
    const f = facts({ days: [day('d1', 1000, 600, 100)] });
    const p = planMove(standing(f), 'profit', 'cost', rs(5000));
    expect(p).toMatchObject({ kind: 'reallocation', profitEffectCents: rs(-5000), profitEligibleCents: 0, cashOnlyCents: 0, chargeRelabelCents: 0, needsConfirmation: false });
    f.moves.push(move(f, 'd2', 'profit', 'cost', 50));
    expect(standing(f).materials.chargedCents).toBe(rs(650));
    expect(recognizedProfit(f)).toBe(rs(300 - 50));
    expect(standing(f).netReleasesCents).toBe(rs(-50));
    f.moves.push(move(f, 'd2', 'profit', 'electricity', 20));
    expect(standing(f).electricity.chargedCents).toBe(rs(120));
  });
  it('re-label = min(x, max(0, Unspent_source)); the charge moves between the lines, profit unchanged, both directions', () => {
    const f = facts({ days: [day('d1', 1000, 600, 100)], payments: [pay('d1', 'materials', 'cost', 590)] }); // Materials unspent 10, Electricity 100
    expect(planMove(standing(f), 'cost', 'electricity', rs(500))).toMatchObject({ kind: 'relabel', chargeRelabelCents: rs(10), profitEffectCents: 0, cashOnlyCents: 0 });
    expect(planMove(standing(f), 'electricity', 'cost', rs(500))).toMatchObject({ chargeRelabelCents: rs(100) });
    expect(planMove(standing(f), 'electricity', 'cost', rs(40))).toMatchObject({ chargeRelabelCents: rs(40) });
    f.moves.push(move(f, 'd2', 'electricity', 'cost', 40));
    const st = standing(f);
    expect([st.materials.chargedCents, st.electricity.chargedCents]).toEqual([rs(640), rs(60)]);
    expect(recognizedProfit(f)).toBe(rs(300));
    expect(st.unspentCents).toBe(rs(110)); // a re-label never changes the combined unspent
  });
  it('a source line with nothing unspent re-labels nothing (cash only moves)', () => {
    const f = facts({ days: [day('d1', 1000, 600, 100)], payments: [pay('d1', 'materials', 'cost', 700)] }); // Materials unspent -100
    expect(planMove(standing(f), 'cost', 'electricity', rs(300)).chargeRelabelCents).toBe(0);
  });
  it('rejects the same fund and non-positive / fractional amounts', () => {
    const st = standing(facts());
    expect(() => planMove(st, 'cost', 'cost', 100)).toThrow(RangeError);
    expect(() => planMove(st, 'cost', 'profit', 0)).toThrow(RangeError);
    expect(() => planMove(st, 'cost', 'profit', 1.5)).toThrow(RangeError);
  });
});

describe('D2 void guard - judged on the FINAL state (10.4)', () => {
  /** Day 1,000 (C 600 / E 100); a release of 600 from Cost depends on its Materials allocation. */
  function withRelease() {
    const d = day('d1', 1000, 600, 100);
    const f = facts({ days: [d] });
    f.moves.push(move(f, 'd2', 'cost', 'profit', 600));
    return { f, d };
  }
  it('voiding the daily entry that a release depends on is BLOCKED (Charged_Materials would be negative)', () => {
    const { f, d } = withRelease();
    const g = voidGuard(standing(f), standing(withoutDay(f, d.id)));
    expect(g).toEqual({ blocked: true, reason: 'CHARGED_NEGATIVE' });
  });
  it('allowed again once the release is reversed (the release is simply no longer a posted fact)', () => {
    const { f, d } = withRelease();
    const noRelease = { ...f, moves: [] };
    expect(voidGuard(standing(noRelease), standing(withoutDay(noRelease, d.id))).blocked).toBe(false);
  });
  it('voiding a day with no release is allowed even if an excess cost appears (D3 shows it as a warning)', () => {
    const d = day('d1', 1000, 600, 100);
    const f = facts({ days: [d], payments: [pay('d1', 'materials', 'cost', 600)] });
    const after = standing(withoutDay(f, d.id));
    expect(after.unspentCents).toBe(rs(-600));
    expect(voidGuard(standing(f), after).blocked).toBe(false);
  });
  it('net releases > 0 while combined Unspent < 0 after the change is blocked (RELEASE_UNBACKED)', () => {
    // two days; a release of 100 from day 1's Materials; then the Cost was fully paid; voiding day 2 lowers unspent below zero
    const d1 = day('d1', 300, 100, 0);
    const d2 = day('d2', 300, 100, 0);
    const f = facts({ days: [d1, d2] });
    f.moves.push(move(f, 'd3', 'cost', 'profit', 100));
    f.payments.push(pay('d3', 'materials', 'cost', 100));
    // Charged_M = 200 - 100 = 100, Settled 100, unspent 0; removing d2: Charged_M = 0 (not negative) but unspent = -100 with net releases 100
    const g = voidGuard(standing(f), standing(withoutDay(f, d2.id)));
    expect(g).toEqual({ blocked: true, reason: 'RELEASE_UNBACKED' });
  });
  it('re-allocation void: Profit -> Cost 200 lowered Charged; voiding it re-checks the final state', () => {
    const d = day('d1', 1000, 600, 100);
    const f = facts({ days: [d] });
    const re = move(f, 'd2', 'profit', 'cost', 200); // Charged_M 800
    f.moves.push(re);
    f.moves.push(move(f, 'd3', 'cost', 'profit', 800)); // release up to the charged 800 (limit min(800, 800+100... ) = 800)
    expect(standing(f).materials.chargedCents).toBe(0);
    // voiding the re-allocation drops Charged_M to -200 -> blocked
    expect(voidGuard(standing(f), standing(withoutMove(f, re.id))).blocked).toBe(true);
    // without the release it would be fine
    const f2 = facts({ days: [d], moves: [re] });
    expect(voidGuard(standing(f2), standing(withoutMove(f2, re.id))).blocked).toBe(false);
  });
  it('re-label void: lowering Charged_Electricity below zero is blocked', () => {
    const d = day('d1', 1000, 600, 100);
    const f = facts({ days: [d] });
    const rl = move(f, 'd2', 'cost', 'electricity', 300); // M 300, E 400
    f.moves.push(rl);
    f.moves.push(move(f, 'd3', 'electricity', 'profit', 400)); // E released fully: E charged 0
    expect(voidGuard(standing(f), standing(withoutMove(f, rl.id))).blocked).toBe(true); // E would be -300
  });
  it('void-and-replace is judged on the FINAL state: lowering below what a release needs is blocked, raising or equal is allowed', () => {
    const { f, d } = withRelease();
    const repl = (c: number, e: number, s = 1000): DayFact => ({ id: -1, businessDate: 'd1', salesCents: rs(s), costCents: rs(c), electricityCents: rs(e), profitShareCents: rs(s - c - e) });
    const guard = (r: DayFact) => voidGuard(standing(f), standing(withReplacedDay(f, d.id, r))).blocked;
    expect(guard(repl(700, 100))).toBe(false); // raised cost allocation
    expect(guard(repl(600, 100))).toBe(false); // identical
    expect(guard(repl(500, 200))).toBe(true); // Charged_M 500 - 600 released = -100
    expect(guard(repl(600, 0, 700))).toBe(false); // only electricity lowered: Charged_E 0, not negative, no unspent below zero
  });
  it('voids of releases and payments never lower a charge or the combined unspent, so the guard never fires', () => {
    const { f } = withRelease();
    const rel = f.moves[0]!;
    expect(voidGuard(standing(f), standing(withoutMove(f, rel.id))).blocked).toBe(false);
    const g = facts({ days: [day('d1', 1000, 600, 100)], payments: [pay('d1', 'materials', 'cost', 100)] });
    const noPay = { ...g, payments: [] };
    expect(voidGuard(standing(g), standing(noPay)).blocked).toBe(false);
  });
  it('a change that lowers nothing is allowed even when the current state is already irregular', () => {
    const bad = standing(facts({ days: [day('d1', 100, 0, 0)], moves: [{ id: 99, businessDate: 'd1', fromFund: 'cost', toFund: 'profit', amountCents: rs(50), profitEffectCents: rs(50), chargeRelabelCents: 0, cashOnlyCents: 0 }] }));
    expect(bad.materials.chargedCents).toBeLessThan(0);
    expect(voidGuard(bad, bad).blocked).toBe(false);
  });
});

describe('outstanding excess and standing as of a business date (10.5, 10.6)', () => {
  it('excess at a date = max(0, -Unspent) from events dated on or before it; later events are ignored', () => {
    const f = facts({ days: [day('2026-11-01', 100, 60, 10)], payments: [pay('2026-11-05', 'materials', 'cost', 80)] });
    expect(outstandingExcess(standing(f, '2026-11-04'))).toBe(0);
    expect(outstandingExcess(standing(f, '2026-11-05'))).toBe(rs(10)); // unspent 60+10-80 = -10
    expect(outstandingExcess(standing(f))).toBe(rs(10));
    expect(outstandingExcess(standingBefore(f, '2026-11-05'))).toBe(0);
    expect(outstandingExcess(standingBefore(f, '2026-11-06'))).toBe(rs(10));
    expect(outstandingExcess(standing(f, '2026-10-31'))).toBe(0);
  });
  it('a later daily allocation shrinks the excess (it is "charged" in the later period: negative flow)', () => {
    const f = facts({ days: [day('2026-11-01', 100, 60, 10), day('2026-11-10', 100, 60, 10)], payments: [pay('2026-11-05', 'materials', 'cost', 80)] });
    const r = periodReport(f, '2026-11-10', '2026-11-10');
    expect(r.excessCostNotChargedCents).toBe(rs(-10)); // "-Rs 10 (earlier excess now covered)"
    expect(r.recognizedProfitCents).toBe(rs(30));
    expect(r.profitAfterExcessCostCents).toBe(rs(40)); // 30 - (-10)
  });
  it('period report figures: charge lines are movements inside the period, memo and balances as of the end', () => {
    const f = facts({ days: [day('2026-11-01', 1000, 600, 100)], payments: [pay('2026-11-02', 'materials', 'cost', 100), pay('2026-11-02', 'electricity_bill', 'electricity', 50), pay('2026-11-02', 'other_cost', 'cost', 20), pay('2026-11-02', 'other_cost', 'profit', 30)] });
    f.moves.push(move(f, '2026-11-03', 'cost', 'profit', 100));
    const r = periodReport(f, '2026-11-02', '2026-11-03');
    expect(r.salesCents).toBe(0);
    expect(r.materialsChargeCents).toBe(rs(-100)); // the release lowers the charge, dated in the period
    expect(r.electricityChargeCents).toBe(0);
    expect(r.otherExpensesCents).toBe(rs(30));
    expect(r.recognition).toEqual({ dailyProfitShareCents: 0, profitEligibleReleasesCents: rs(100), reallocationsCents: 0, otherExpensesCents: rs(-30), cashOverShortCents: 0 });
    expect(r.recognizedProfitCents).toBe(rs(70));
    expect(r.memo).toEqual({ actualMaterialsPaidCents: rs(100), actualElectricityPaidCents: rs(50), otherCostsFromCostElecFundsCents: rs(20) });
    expect(r.balancesAsOfPeriodEnd.unspentByLine).toEqual({ materialsCents: rs(600 - 100 - 100 - 20), electricityCents: rs(100 - 50) });
  });
  it('cash over/short is a recognition event (+ over / - short) dated by its business date', () => {
    const f = facts({ overShort: [{ businessDate: '2026-11-02', amountCents: rs(-40) }, { businessDate: '2026-11-03', amountCents: rs(15) }] });
    expect(recognizedProfit(f)).toBe(rs(-25));
    expect(recognizedProfit(f, '2026-11-02')).toBe(rs(-40));
    expect(periodReport(f, '2026-11-03', '2026-11-03').cashOverShortCents).toBe(rs(15));
    expect(standing(f).unspentCents).toBe(0); // over/short never changes Charged/Settled/Unspent (C4)
  });
});

describe('period flows are additive and the 10.4 identity holds (randomized, seeded)', () => {
  /** Builds a random but rule-following history: every move is planned by the module at the moment it is "saved". */
  function randomHistory(seed: number, ops: number): IceFacts {
    const r = rng(seed);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
    const dateOf = (i: number): string => `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`;
    const f = emptyFacts();
    const funds: Fund[] = ['cost', 'electricity', 'profit'];
    for (let i = 0; i < ops; i++) {
      const date = dateOf(Math.floor(r() * 84)); // 3 months, in no particular posting order: reports follow business date
      const roll = r();
      if (roll < 0.3) {
        const s = Math.floor(r() * 500) * 100;
        const c = Math.floor(r() * (s / 100 + 1)) * 100;
        const e = Math.floor(r() * ((s - c) / 100 + 1)) * 100;
        f.days.push({ id: ++id, businessDate: date, salesCents: s, costCents: c, electricityCents: e, profitShareCents: s - c - e });
      } else if (roll < 0.55) {
        const kind = pick<PaymentKind>(['materials', 'electricity_bill', 'other_cost']);
        f.payments.push({ id: ++id, businessDate: date, kind, fund: pick(funds), amountCents: (1 + Math.floor(r() * 300)) * 100 });
      } else if (roll < 0.9) {
        const from = pick(funds);
        const to = pick(funds.filter((x) => x !== from));
        const amount = (1 + Math.floor(r() * 300)) * 100;
        const p = planMove(standing(f), from, to, amount);
        f.moves.push({ id: ++id, businessDate: date, fromFund: from, toFund: to, amountCents: amount, profitEffectCents: p.profitEffectCents, chargeRelabelCents: p.chargeRelabelCents, cashOnlyCents: p.cashOnlyCents });
      } else {
        f.overShort.push({ businessDate: date, amountCents: (Math.floor(r() * 41) - 20) * 100 });
      }
    }
    return f;
  }
  const monthOf = (m: number) => ({ from: `2026-${String(m).padStart(2, '0')}-01`, to: `2026-${String(m).padStart(2, '0')}-28` });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('seed %i: day rows add up to the month, months to the span; identity recognized - true = -Unspent', (seed) => {
    const f = randomHistory(seed, 120);
    const flows = (from: string, to: string) => periodReport(f, from, to);
    for (let m = 1; m <= 3; m++) {
      const { from, to } = monthOf(m);
      const month = flows(from, to);
      let rec = 0; let exc = 0; let after = 0; let mat = 0; let ele = 0; let sales = 0; let oth = 0; let os = 0;
      for (let d = 1; d <= 28; d++) {
        const date = `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const row = flows(date, date);
        rec += row.recognizedProfitCents; exc += row.excessCostNotChargedCents; after += row.profitAfterExcessCostCents;
        mat += row.materialsChargeCents; ele += row.electricityChargeCents; sales += row.salesCents; oth += row.otherExpensesCents; os += row.cashOverShortCents;
      }
      expect(rec, `m${m} recognized`).toBe(month.recognizedProfitCents);
      expect(exc, `m${m} excess flow`).toBe(month.excessCostNotChargedCents);
      expect(after, `m${m} profit after excess`).toBe(month.profitAfterExcessCostCents);
      expect([mat, ele, sales, oth, os]).toEqual([month.materialsChargeCents, month.electricityChargeCents, month.salesCents, month.otherExpensesCents, month.cashOverShortCents]);
    }
    // months add up to the whole span, and the span's excess flow = outstanding at the end (start of history = 0)
    const whole = flows('2026-01-01', '2026-03-28');
    const sum = [1, 2, 3].map((m) => flows(monthOf(m).from, monthOf(m).to));
    expect(sum.reduce((t, x) => t + x.recognizedProfitCents, 0)).toBe(whole.recognizedProfitCents);
    expect(sum.reduce((t, x) => t + x.excessCostNotChargedCents, 0)).toBe(whole.excessCostNotChargedCents);
    expect(whole.excessCostNotChargedCents).toBe(outstandingExcess(standing(f, '2026-03-28')));
    expect(whole.profitAfterExcessCostCents).toBe(whole.recognizedProfitCents - outstandingExcess(standing(f, '2026-03-28')));
    // 10.4 identity at several dates and for the whole history
    for (const asOf of ['2026-01-10', '2026-02-14', '2026-03-28', undefined]) {
      expect(recognizedProfit(f, asOf) - trueProfit(f, asOf) + standing(f, asOf).unspentCents, `identity as of ${asOf}`).toBe(0);
    }
    // charged = sum of its movements (a balance is the sum of the flows over the whole history)
    const all = flows('2026-01-01', '2026-12-31');
    expect(all.materialsChargeCents).toBe(standing(f).materials.chargedCents);
    expect(all.electricityChargeCents).toBe(standing(f).electricity.chargedCents);
  });
});
