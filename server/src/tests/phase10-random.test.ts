// Phase 10 randomized invariants (BUSINESS_RULES 10.1-10.7, D1-D4). A seeded sequence of >= 300 operations through the REAL API mixes
// daily entries, replacements, voids, payments of all kinds from all funds, moves of all six directions (with the D4 confirmation),
// move/payment voids, opening balances (Phase 8 endpoint), cash over/short (Phase 8 endpoint) and their voids, all dated randomly over the last
// 30 days (so many are backdated and saved out of date order). After EVERY step it proves:
//   10.1/10.7  Cost + Electricity + Profit = Ice Cream cash book = sum of Ice Cream cash entries = sum of fund entries;
//   model      the fund balances, Charged / Settled / Unspent per line, combined unspent, outstanding excess and RECOGNIZED PROFIT equal an
//              INDEPENDENT model written in this file from the document's rules (it never calls icecream-rules.ts);
//   10.4       the identity recognized profit - true profit = -Unspent, with true profit = sales - all payments +/- over/short;
//   D2/D4      every void the server blocks is one the model says is blocked (and the reverse); every split the server asks to confirm
//              is the one the model computes; the stored move figures equal the model's.
// A failing run can be replayed exactly: the generator is seeded.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { post } from './helpers/catalog.ts';
import { apiBase, daysAgo, ref } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { capVoid, countNew, countVoid, fundBal, openNew, rng } from './helpers/phase8.ts';
import type { Fund } from './helpers/phase8.ts';
import { dayNew, dayReplace, dayVoid, fundSum, fundsGet, iceCash, moveNew, moveVoid, payNew, payVoid, rs } from './helpers/phase10.ts';
import { num } from './helpers/phase4.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

// ---------------------------------------------------------------------------------------------
// The independent model (rules typed from BUSINESS_RULES 10.2-10.4, not from the implementation)
// ---------------------------------------------------------------------------------------------
interface MDay { id: number; date: string; S: number; C: number; E: number; active: boolean }
interface MPay { id: number; kind: 'materials' | 'electricity_bill' | 'other_cost'; fund: Fund; amt: number; active: boolean }
interface MMove { id: number; from: Fund; to: Fund; amt: number; eff: number; relabel: number; cashOnly: number; active: boolean }
interface MOpen { id: number; fund: Fund; amt: number; active: boolean }
interface MCount { id: number; fund: Fund | null; delta: number; active: boolean }

interface Calc { chM: number; chE: number; seM: number; seE: number; unspent: number; netRel: number; recognized: number; truth: number; funds: Record<Fund, number> }

class Model {
  days: MDay[] = []; pays: MPay[] = []; moves: MMove[] = []; opens: MOpen[] = []; counts: MCount[] = [];

  /** Everything derived from a chosen set of days / moves (payments, openings and counts as they are). */
  calc(days: MDay[] = this.days, moves: MMove[] = this.moves): Calc {
    let chM = 0; let chE = 0; let seM = 0; let seE = 0; let rel = 0; let rea = 0; let dayProfit = 0; let otherFromProfit = 0; let sales = 0; let allPay = 0; let os = 0;
    const funds: Record<Fund, number> = { cost: 0, electricity: 0, profit: 0 };
    for (const d of days) {
      if (!d.active) continue;
      chM += d.C; chE += d.E; sales += d.S; dayProfit += d.S - d.C - d.E;
      funds.cost += d.C; funds.electricity += d.E; funds.profit += d.S - d.C - d.E;
    }
    for (const m of moves) {
      if (!m.active) continue;
      funds[m.from] -= m.amt; funds[m.to] += m.amt;
      switch (`${m.from}>${m.to}`) {
        case 'cost>profit': chM -= m.eff; rel += m.eff; break;
        case 'electricity>profit': chE -= m.eff; rel += m.eff; break;
        case 'profit>cost': chM += m.amt; rea += m.amt; break;
        case 'profit>electricity': chE += m.amt; rea += m.amt; break;
        case 'cost>electricity': chM -= m.relabel; chE += m.relabel; break;
        case 'electricity>cost': chE -= m.relabel; chM += m.relabel; break;
        default: throw new Error('impossible move');
      }
    }
    for (const p of this.pays) {
      if (!p.active) continue;
      allPay += p.amt;
      funds[p.fund] -= p.amt;
      if (p.kind === 'materials') seM += p.amt;
      else if (p.kind === 'electricity_bill') seE += p.amt;
      else if (p.fund === 'cost') seM += p.amt;
      else if (p.fund === 'electricity') seE += p.amt;
      else otherFromProfit += p.amt;
    }
    for (const o of this.opens) if (o.active) funds[o.fund] += o.amt;
    for (const c of this.counts) if (c.active && c.fund !== null) { funds[c.fund] += c.delta; os += c.delta; }
    const unspent = (chM - seM) + (chE - seE);
    return {
      chM, chE, seM, seE, unspent, netRel: rel - rea, funds,
      recognized: dayProfit + rel - rea - otherFromProfit + os,
      truth: sales - allPay + os, // true profit: money in from sales minus every payment actually made, +/- over/short
    };
  }

  /** 10.4 profit-eligible limit for a release out of `fund`. */
  limit(fund: 'cost' | 'electricity'): number {
    const c = this.calc();
    return Math.min(Math.max(0, fund === 'cost' ? c.chM - c.seM : c.chE - c.seE), Math.max(0, c.unspent));
  }

  /** The figures a move must be stored with. */
  plan(from: Fund, to: Fund, amt: number): { eff: number; relabel: number; cashOnly: number } {
    const c = this.calc();
    if (to === 'profit') {
      const eligible = Math.min(amt, this.limit(from as 'cost' | 'electricity'));
      return { eff: eligible, relabel: 0, cashOnly: amt - eligible };
    }
    if (from === 'profit') return { eff: -amt, relabel: 0, cashOnly: 0 };
    const unspentSource = from === 'cost' ? c.chM - c.seM : c.chE - c.seE;
    return { eff: 0, relabel: Math.min(amt, Math.max(0, unspentSource)), cashOnly: 0 };
  }

  /** D2: blocked only if the change lowers some Charged_L or the combined Unspent AND the result has Charged_L < 0 or net releases > 0 with Unspent < 0. */
  blocks(before: Calc, after: Calc): boolean {
    const lowers = after.chM < before.chM || after.chE < before.chE || after.unspent < before.unspent;
    const bad = after.chM < 0 || after.chE < 0 || (after.netRel > 0 && after.unspent < 0);
    return lowers && bad;
  }
}

// ---------------------------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------------------------
const FUNDS: Fund[] = ['cost', 'electricity', 'profit'];

async function run(seed: number, ops: number): Promise<{ counts: Record<string, number> }> {
  const s: ApiBase = await apiBase(await env.build());
  const r = rng(seed);
  const m = new Model();
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const money = (maxRupees: number): number => rs(1 + Math.floor(r() * maxRupees));
  const randDate = (): string => daysAgo(Math.floor(r() * 30));
  const tally: Record<string, number> = {};
  const note = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };

  /** The per-step proof. */
  async function check(step: number, what: string): Promise<void> {
    const label = `seed ${seed} step ${step} (${what})`;
    const f = fundBal(s);
    const book = iceCash(s);
    expect(f.cost + f.electricity + f.profit, `${label}: funds = cash book`).toBe(book);
    expect(fundSum(s), `${label}: fund entries = cash entries`).toBe(book);
    expect(num(s, "SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book = 'icecream'"), `${label}: cash entries`).toBe(book);
    const c = m.calc();
    expect(f, `${label}: fund balances vs model`).toEqual(c.funds);
    const api = (await fundsGet(s)).body;
    expect(api.totalCents, `${label}: api total`).toBe(book);
    expect(api.cashBookBalanceCents, `${label}: api cash book`).toBe(book);
    expect(api.reconciled, `${label}: reconciled`).toBe(true);
    expect([api.lines.materials.chargedCents, api.lines.materials.settledCents, api.lines.electricity.chargedCents, api.lines.electricity.settledCents], `${label}: lines`)
      .toEqual([c.chM, c.seM, c.chE, c.seE]);
    expect(api.unspentAllocationCents, `${label}: unspent`).toBe(c.unspent);
    expect(api.outstandingExcessCostCents, `${label}: excess`).toBe(Math.max(0, -c.unspent));
    expect(api.recognizedProfitToDateCents, `${label}: recognized profit vs model`).toBe(c.recognized);
    expect(api.profitAfterExcessCostToDateCents, `${label}: profit after excess`).toBe(c.recognized - Math.max(0, -c.unspent));
    // 10.4 identity: recognized profit - true profit = -Unspent
    expect(c.recognized - c.truth + c.unspent, `${label}: identity`).toBe(0);
    expect(api.warnings.some((w: any) => w.code === 'EXCESS_COST_OUTSTANDING'), `${label}: excess warning`).toBe(c.unspent < 0);
    for (const fund of FUNDS) {
      expect(api.warnings.some((w: any) => w.code === 'NEGATIVE_FUND_BALANCE' && w.fund === fund), `${label}: negative ${fund} warning`).toBe(f[fund] < 0);
    }
  }

  // go-live: one opening balance (so the books are never all zero from the start)
  const first = await openNew(s, 'icecream', { fund: 'cost', amountCents: rs(2000), businessDate: daysAgo(30) });
  expect(first.status).toBe(201);
  m.opens.push({ id: first.body.item.id, fund: 'cost', amt: rs(2000), active: true });
  await check(0, 'opening');

  for (let step = 1; step <= ops; step++) {
    const roll = r();
    let what = '';
    if (roll < 0.17) {
      // ---- new daily entry (or a replacement / void when every date is taken) ----
      what = 'day';
      const free = Array.from({ length: 30 }, (_, i) => daysAgo(i)).filter((d) => !m.days.some((x) => x.active && x.date === d));
      if (free.length === 0) { what = 'skip'; note('skip'); continue; }
      const date = pick(free);
      const S = money(6000);
      const negative = r() < 0.1;
      const C = negative ? S + money(200) : Math.floor(r() * (S / 100 + 1)) * 100;
      const E = negative ? 0 : Math.floor(r() * ((S - C) / 100 + 1)) * 100;
      const body = { businessDate: date, salesCents: S, costAllocCents: C, electricityAllocCents: E };
      let res = await dayNew(s, body);
      if (negative) {
        expect(res.status, `step ${step}: negative needs confirmation`).toBe(422);
        expect(res.body.error.code).toBe('NEGATIVE_PROFIT_UNCONFIRMED');
        res = await dayNew(s, { ...body, confirmNegativeProfit: true });
        note('negativeDay');
      }
      expect(res.status, `step ${step}: ${JSON.stringify(res.body)}`).toBe(201);
      m.days.push({ id: res.body.day.id, date, S, C, E, active: true });
      note('day');
    } else if (roll < 0.23) {
      // ---- replace an entry (D2 judged on the final state) ----
      what = 'replace';
      const act = m.days.filter((d) => d.active);
      if (act.length === 0) { note('skip'); continue; }
      const old = pick(act);
      const S = money(6000);
      const C = Math.floor(r() * (S / 100 + 1)) * 100;
      const E = Math.floor(r() * ((S - C) / 100 + 1)) * 100;
      const before = m.calc();
      const nd: MDay = { id: -1, date: old.date, S, C, E, active: true };
      const after = m.calc(m.days.map((d) => (d === old ? nd : d)));
      const blocked = m.blocks(before, after);
      const res = await dayReplace(s, old.date, { salesCents: S, costAllocCents: C, electricityAllocCents: E });
      if (blocked) {
        expect(res.status, `step ${step}: model says replace blocked`).toBe(422);
        expect(res.body.error.code).toBe('VOID_BREAKS_RELEASE');
        note('replaceBlocked');
      } else {
        expect(res.status, `step ${step}: replace ${JSON.stringify(res.body)}`).toBe(200);
        old.active = false;
        m.days.push({ id: res.body.day.id, date: old.date, S, C, E, active: true });
        note('replace');
      }
    } else if (roll < 0.29) {
      // ---- void an entry (D2) ----
      what = 'dayVoid';
      const act = m.days.filter((d) => d.active);
      if (act.length === 0) { note('skip'); continue; }
      const d = pick(act);
      const blocked = m.blocks(m.calc(), m.calc(m.days.map((x) => (x === d ? { ...x, active: false } : x))));
      const res = await dayVoid(s, d.date);
      if (blocked) {
        expect(res.status, `step ${step}: model says day void blocked`).toBe(422);
        expect(res.body.error.code).toBe('VOID_BREAKS_RELEASE');
        note('dayVoidBlocked');
      } else {
        expect(res.status, `step ${step}: ${JSON.stringify(res.body)}`).toBe(200);
        d.active = false;
        note('dayVoid');
      }
    } else if (roll < 0.5) {
      // ---- payment of any kind from any fund ----
      what = 'payment';
      const kind = pick(['materials', 'electricity_bill', 'other_cost'] as const);
      const fund = pick(FUNDS);
      const amt = money(2500);
      const res = await payNew(s, kind, amt, { fund, businessDate: randDate() });
      expect(res.status, `step ${step}: ${JSON.stringify(res.body)}`).toBe(201);
      m.pays.push({ id: res.body.payment.id, kind, fund, amt, active: true });
      expect(res.body.payment.pnlTreatment).toBe(kind === 'other_cost' && fund === 'profit' ? 'expense' : 'settlement');
      note(`pay:${kind}`);
    } else if (roll < 0.56) {
      what = 'payVoid';
      const act = m.pays.filter((p) => p.active);
      if (act.length === 0) { note('skip'); continue; }
      const p = pick(act);
      const res = await payVoid(s, p.id);
      expect(res.status, `step ${step}: ${JSON.stringify(res.body)}`).toBe(200);
      p.active = false;
      note('payVoid');
    } else if (roll < 0.8) {
      // ---- fund move, D4 confirmation when asked ----
      what = 'move';
      const from = pick(FUNDS);
      const to = pick(FUNDS.filter((x) => x !== from));
      const amt = money(2500);
      const plan = m.plan(from, to, amt);
      const date = randDate();
      const body = { businessDate: date, fromFund: from, toFund: to, amountCents: amt, clientRef: ref() };
      let res = await post(s.app, '/icecream/fund-moves', body);
      if (plan.cashOnly > 0) {
        expect(res.status, `step ${step}: split must be confirmed`).toBe(409);
        expect(res.body.error.code).toBe('SPLIT_CONFIRMATION_REQUIRED');
        expect(res.body.error.profitEligibleCents, `step ${step}: eligible`).toBe(plan.eff);
        expect(res.body.error.cashOnlyCents, `step ${step}: cash-only`).toBe(plan.cashOnly);
        // a stale confirmation is refused with the current split
        const stale = await post(s.app, '/icecream/fund-moves', { ...body, confirmSplit: true, confirmedProfitEligibleCents: plan.eff + 1 });
        expect(stale.status).toBe(409);
        res = await post(s.app, '/icecream/fund-moves', { ...body, confirmSplit: true, confirmedProfitEligibleCents: plan.eff });
        note('split');
      }
      expect(res.status, `step ${step}: ${JSON.stringify(res.body)}`).toBe(201);
      const mv = res.body.move;
      expect([mv.profitEffectCents, mv.chargeRelabelCents, mv.cashOnlyCents], `step ${step}: stored move figures`).toEqual([plan.eff, plan.relabel, plan.cashOnly]);
      m.moves.push({ id: mv.id, from, to, amt, eff: plan.eff, relabel: plan.relabel, cashOnly: plan.cashOnly, active: true });
      note(`move:${from}>${to}`);
    } else if (roll < 0.88) {
      // ---- move void (D2 for re-allocations and re-labels; releases always allowed) ----
      what = 'moveVoid';
      const act = m.moves.filter((x) => x.active);
      if (act.length === 0) { note('skip'); continue; }
      const mv = act[Math.floor(r() * act.length)]!;
      const isRelease = mv.to === 'profit';
      const blocked = !isRelease && m.blocks(m.calc(), m.calc(undefined, m.moves.map((x) => (x === mv ? { ...x, active: false } : x))));
      const res = await moveVoid(s, mv.id);
      if (blocked) {
        expect(res.status, `step ${step}: model says move void blocked`).toBe(422);
        expect(res.body.error.code).toBe('VOID_BREAKS_RELEASE');
        note('moveVoidBlocked');
      } else {
        expect(res.status, `step ${step}: ${JSON.stringify(res.body)}`).toBe(200);
        mv.active = false;
        note('moveVoid');
      }
    } else if (roll < 0.93) {
      // ---- cash over / short through the Phase 8 endpoint (default Profit, or any fund) ----
      what = 'count';
      const expected = iceCash(s);
      const counted = Math.max(0, expected + (Math.floor(r() * 41) - 20) * 100);
      const fund = pick(FUNDS);
      const res = await countNew(s, 'icecream', counted, { fund, note: 'random count' });
      expect(res.status, `step ${step}: ${JSON.stringify(res.body)}`).toBe(201);
      const diff = res.body.item.differenceCents as number;
      expect(diff).toBe(counted - expected);
      m.counts.push({ id: res.body.item.id, fund: diff === 0 ? null : fund, delta: diff, active: true });
      note('count');
    } else if (roll < 0.95) {
      what = 'countVoid';
      const act = m.counts.filter((c) => c.active && c.fund !== null);
      if (act.length === 0) { note('skip'); continue; }
      const c = pick(act);
      expect((await countVoid(s, c.id)).status).toBe(200);
      c.active = false;
      note('countVoid');
    } else {
      // ---- opening balance of a fund (one posted per fund) and voiding one ----
      what = 'opening';
      const fund = pick(FUNDS);
      const existing = m.opens.find((o) => o.fund === fund && o.active);
      if (existing && r() < 0.5) {
        expect((await capVoid(s, existing.id)).status).toBe(200);
        existing.active = false;
        note('openingVoid');
      } else {
        const amt = money(3000);
        const res = await openNew(s, 'icecream', { fund, amountCents: amt, businessDate: randDate() });
        if (existing) {
          expect(res.status).toBe(409);
          expect(res.body.error.code).toBe('OPENING_BALANCE_EXISTS');
        } else {
          expect(res.status, JSON.stringify(res.body)).toBe(201);
          m.opens.push({ id: res.body.item.id, fund, amt, active: true });
          note('opening');
        }
      }
    }
    await check(step, what);
  }
  return { counts: tally };
}

describe('randomized Ice Cream sequences keep every invariant and match the independent model', () => {
  it.each([20261111, 7, 424242])('seed %i: 320 operations', async (seed) => {
    const { counts } = await run(seed, 320);
    // the sequence must actually have exercised the interesting paths, or the proof would be hollow
    expect(counts.day, 'daily entries').toBeGreaterThan(20);
    expect(counts['pay:materials'] + counts['pay:electricity_bill'] + counts['pay:other_cost'], 'payments').toBeGreaterThan(30);
    const moves = Object.entries(counts).filter(([k]) => k.startsWith('move:')).reduce((t, [, v]) => t + v, 0);
    expect(moves, 'moves').toBeGreaterThan(30);
  }, 240_000);

  it('across seeds the sequences hit splits, blocked voids, negative days and excess cost (coverage of the hard paths)', async () => {
    const total: Record<string, number> = {};
    for (const seed of [11, 12, 13]) {
      const { counts } = await run(seed, 300);
      for (const [k, v] of Object.entries(counts)) total[k] = (total[k] ?? 0) + v;
    }
    expect(total.split, 'D4 splits').toBeGreaterThan(0);
    expect(total.negativeDay, 'negative profit days').toBeGreaterThan(0);
    expect((total.dayVoidBlocked ?? 0) + (total.moveVoidBlocked ?? 0) + (total.replaceBlocked ?? 0), 'D2 blocks').toBeGreaterThan(0);
    for (const dir of ['cost>profit', 'electricity>profit', 'profit>cost', 'profit>electricity', 'cost>electricity', 'electricity>cost']) {
      expect(total[`move:${dir}`], dir).toBeGreaterThan(0);
    }
  }, 300_000);
});
