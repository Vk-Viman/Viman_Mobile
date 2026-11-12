/**
 * services/icecream-rules.ts - the PURE calculation module of the Ice Cream three-fund system (Phase 10).
 *
 * Layer: pure domain logic. NO database, NO HTTP, NO clock: it works on plain arrays of already-posted records
 * ("facts") so the same code serves the write paths (limits, D4 splits, D2 guards), the Funds screen and, later,
 * the Phase 11 reports. BUSINESS_RULES section 10 is the only authority; rule IDs are quoted next to the code.
 *
 * What is calculated (all derived, nothing stored as a running total - 10.4):
 *  - Charged_L / Settled_L / Unspent_L for the two lines L = Materials (Cost fund) and Electricity, plus the
 *    combined Unspent (10.4) and the net releases (releases minus re-allocations, D2);
 *  - the profit-eligible limit min(max(0, Unspent_L), max(0, Unspent)) and the move plan: release split (D4),
 *    re-allocation (D1) and Cost <-> Electricity re-label (10.3, 10.4);
 *  - the D2 void guard (judged on the FINAL state, so void-and-replace is judged after the replacement);
 *  - recognized profit from the recognition events (10.3), outstanding excess cost (10.5) and the period-flow
 *    report figures of the period rule (10.6): recognized profit, excess cost not yet charged, profit after excess cost.
 *
 * Two kinds of date matter (section 12, 10.6): the caller passes only POSTED records. Limits, splits and guards use
 * ALL of them (they follow the saving order, i.e. whatever is saved at that moment, whatever its business date);
 * reports and `asOf` use only the facts whose business date falls inside the period.
 */

/** The three funds (10.1). */
export type Fund = 'cost' | 'electricity' | 'profit';
/** The two charge lines of 10.4: Materials is the Cost fund's line. */
export type Line = 'materials' | 'electricity';
/** Payment kinds (10.2). */
export type PaymentKind = 'materials' | 'electricity_bill' | 'other_cost';

/** A posted daily entry: sales S, cost allocation C, electricity allocation E, profit share S - C - E (10.2). */
export interface DayFact {
  id: number; businessDate: string; salesCents: number; costCents: number; electricityCents: number; profitShareCents: number;
}
/** A posted payment (10.2). */
export interface PaymentFact { id: number; businessDate: string; kind: PaymentKind; fund: Fund; amountCents: number }
/** A posted fund move with the figures the server computed when it was saved (10.3, 10.4). */
export interface MoveFact {
  id: number; businessDate: string; fromFund: Fund; toFund: Fund; amountCents: number;
  profitEffectCents: number; chargeRelabelCents: number; cashOnlyCents: number;
}
/** Net cash over/short dated in a period: + over, - short (10.3, C4). Voided adjustments net to zero. */
export interface OverShortFact { businessDate: string; amountCents: number }

/** Everything the rules need: the posted records of the Ice Cream book. */
export interface IceFacts { days: DayFact[]; payments: PaymentFact[]; moves: MoveFact[]; overShort: OverShortFact[] }

/** An empty fact set. */
export function emptyFacts(): IceFacts { return { days: [], payments: [], moves: [], overShort: [] }; }

/** Which charge line a fund pays for: Cost -> Materials, Electricity -> Electricity, Profit -> none (10.4). */
export function lineOfFund(fund: Fund): Line | null {
  return fund === 'cost' ? 'materials' : fund === 'electricity' ? 'electricity' : null;
}

/** The fund that carries a line's allocation. */
export function fundOfLine(line: Line): Fund { return line === 'materials' ? 'cost' : 'electricity'; }

/**
 * The line a payment is settled against (10.4): materials -> Materials; the electricity bill -> Electricity; an other
 * cost from the Cost fund -> Materials, from the Electricity fund -> Electricity, from the Profit fund -> none (it is
 * an expense, 10.3). Materials/electricity payments made from the Profit fund still settle their own line.
 */
export function settledLine(kind: PaymentKind, fund: Fund): Line | null {
  if (kind === 'materials') return 'materials';
  if (kind === 'electricity_bill') return 'electricity';
  return lineOfFund(fund);
}

/**
 * P&L treatment of a payment, derived and never chosen (10.3, E4): an expense only for an other cost paid from the
 * Profit fund; everything else settles allocations that were already charged.
 */
export function pnlTreatment(kind: PaymentKind, fund: Fund): 'expense' | 'settlement' {
  return kind === 'other_cost' && fund === 'profit' ? 'expense' : 'settlement';
}

/** What a fund move is, by its funds (10.3). */
export type MoveKind = 'release' | 'reallocation' | 'relabel';

/** Move into Profit = release; out of Profit = re-allocation; Cost <-> Electricity = re-label. */
export function moveKind(from: Fund, to: Fund): MoveKind {
  if (to === 'profit') return 'release';
  if (from === 'profit') return 'reallocation';
  return 'relabel';
}

// ---------- accumulation ----------

/** Raw sums of the facts accepted by a date filter (the building block of balances and period flows). */
interface Sums {
  salesCents: number;
  chargedMaterials: number; chargedElectricity: number;
  settledMaterials: number; settledElectricity: number;
  dailyProfitShare: number; releases: number; reallocations: number; otherFromProfit: number; overShort: number;
  actualMaterialsPaid: number; actualElectricityPaid: number; otherFromCostElec: number;
}

function zeroSums(): Sums {
  return {
    salesCents: 0, chargedMaterials: 0, chargedElectricity: 0, settledMaterials: 0, settledElectricity: 0,
    dailyProfitShare: 0, releases: 0, reallocations: 0, otherFromProfit: 0, overShort: 0,
    actualMaterialsPaid: 0, actualElectricityPaid: 0, otherFromCostElec: 0,
  };
}

/** Adds a signed amount to a line's charge. */
function charge(s: Sums, line: Line, cents: number): void {
  if (line === 'materials') s.chargedMaterials += cents; else s.chargedElectricity += cents;
}

/**
 * Adds up every fact whose business date `accept` allows.
 *
 * Charged_L (10.4) = daily allocations to L + re-allocations into L +/- Cost<->Electricity re-labels - profit-eligible
 * releases from L. Settled_L = payments attributed to L (`settledLine`).
 */
function accumulate(facts: IceFacts, accept: (date: string) => boolean): Sums {
  const s = zeroSums();
  for (const d of facts.days) {
    if (!accept(d.businessDate)) continue;
    s.salesCents += d.salesCents;
    charge(s, 'materials', d.costCents);
    charge(s, 'electricity', d.electricityCents);
    s.dailyProfitShare += d.profitShareCents; // 10.3: daily entry recognizes S - C - E
  }
  for (const m of facts.moves) {
    if (!accept(m.businessDate)) continue;
    const kind = moveKind(m.fromFund, m.toFund);
    if (kind === 'release') {
      // 10.3/10.4: only the profit-eligible part leaves the line's charge and becomes profit; cash-only moves no charge (D4)
      const line = lineOfFund(m.fromFund) as Line;
      charge(s, line, -m.profitEffectCents);
      s.releases += m.profitEffectCents;
    } else if (kind === 'reallocation') {
      // D1: Profit -> Cost/Electricity charges the line by the full amount and lowers recognized profit by the same
      charge(s, lineOfFund(m.toFund) as Line, m.amountCents);
      s.reallocations += m.amountCents;
    } else {
      // 10.4: the cash always moves; only the re-label amount moves the charge, profit is unchanged
      charge(s, lineOfFund(m.fromFund) as Line, -m.chargeRelabelCents);
      charge(s, lineOfFund(m.toFund) as Line, m.chargeRelabelCents);
    }
  }
  for (const p of facts.payments) {
    if (!accept(p.businessDate)) continue;
    const line = settledLine(p.kind, p.fund);
    if (line === 'materials') s.settledMaterials += p.amountCents;
    else if (line === 'electricity') s.settledElectricity += p.amountCents;
    if (p.kind === 'materials') s.actualMaterialsPaid += p.amountCents;
    else if (p.kind === 'electricity_bill') s.actualElectricityPaid += p.amountCents;
    else if (p.fund === 'profit') s.otherFromProfit += p.amountCents; // 10.3: the only payment that lowers profit
    else s.otherFromCostElec += p.amountCents;
  }
  for (const o of facts.overShort) {
    if (accept(o.businessDate)) s.overShort += o.amountCents; // 10.3: + over / - short
  }
  return s;
}

// ---------- balances (10.4, 10.5) ----------

/** One line's state: Charged, Settled and Unspent = Charged - Settled (10.4). */
export interface LineState { chargedCents: number; settledCents: number; unspentCents: number }

/** The state of both lines at a moment: balances, never summed over time (10.6). */
export interface Standing {
  materials: LineState; electricity: LineState;
  /** Combined Unspent = sum of the lines (10.4). */
  unspentCents: number;
  /** Net releases = profit-eligible releases - re-allocations (D2). */
  netReleasesCents: number;
}

function lineState(charged: number, settled: number): LineState {
  return { chargedCents: charged, settledCents: settled, unspentCents: charged - settled };
}

function standingOf(s: Sums): Standing {
  const materials = lineState(s.chargedMaterials, s.settledMaterials);
  const electricity = lineState(s.chargedElectricity, s.settledElectricity);
  return {
    materials, electricity, unspentCents: materials.unspentCents + electricity.unspentCents,
    netReleasesCents: s.releases - s.reallocations,
  };
}

/**
 * Balances of Charged / Settled / Unspent over every fact (no `asOf`) or over the facts dated on or before `asOf`
 * (10.6: `asOf` is a business date). Without `asOf` this is the state the write rules use (saving order, 10.6).
 */
export function standing(facts: IceFacts, asOf?: string): Standing {
  return standingOf(accumulate(facts, (d) => asOf === undefined || d <= asOf));
}

/** Balances over the facts dated strictly BEFORE `date` (the "period start" of 10.6). */
export function standingBefore(facts: IceFacts, date: string): Standing {
  return standingOf(accumulate(facts, (d) => d < date));
}

/** 10.5: outstanding excess cost = max(0, -Unspent) of a standing (a balance at a date). */
export function outstandingExcess(st: Standing): number {
  return Math.max(0, -st.unspentCents);
}

/** The state of one line. */
export function lineOf(st: Standing, line: Line): LineState { return st[line]; }

// ---------- move planning (10.3, 10.4, D1, D4) ----------

/** The profit-eligible limit for a release out of `line` (10.4): min(max(0, Unspent_L), max(0, Unspent)). */
export function profitEligibleLimit(st: Standing, line: Line): number {
  return Math.min(Math.max(0, lineOf(st, line).unspentCents), Math.max(0, st.unspentCents));
}

/** What a move of a given amount would do, computed from the current standing. */
export interface MovePlan {
  kind: MoveKind; amountCents: number;
  /** Release only: the part that increases recognized profit (<= limit). */
  profitEligibleCents: number;
  /** Release only: the part that moves cash but has no profit effect (D4). */
  cashOnlyCents: number;
  /** Cost <-> Electricity only: min(x, max(0, Unspent_source)) (10.4). */
  chargeRelabelCents: number;
  /** Effect on recognized profit: +eligible (release), -amount (re-allocation, D1), 0 (re-label). */
  profitEffectCents: number;
  /** Release only: the profit-eligible limit that was applied. */
  limitCents: number;
  /** D4: true when a release exceeds the limit and must be confirmed by the owner before it is posted. */
  needsConfirmation: boolean;
}

/**
 * Plans a move of `amountCents` from one fund to another (10.3, 10.4, D1, D4). Pure: the caller passes the standing
 * of ALL posted facts at the moment of saving.
 *
 * @throws RangeError when the funds are the same or the amount is not a positive integer (callers validate first).
 */
export function planMove(st: Standing, from: Fund, to: Fund, amountCents: number): MovePlan {
  if (from === to) throw new RangeError('A move needs two different funds');
  if (!Number.isSafeInteger(amountCents) || amountCents < 1) throw new RangeError('A move needs a positive amount');
  const kind = moveKind(from, to);
  const base = { kind, amountCents, profitEligibleCents: 0, cashOnlyCents: 0, chargeRelabelCents: 0, profitEffectCents: 0, limitCents: 0, needsConfirmation: false };
  if (kind === 'release') {
    const limit = profitEligibleLimit(st, lineOfFund(from) as Line);
    const eligible = Math.min(amountCents, limit);
    const cashOnly = amountCents - eligible;
    return { ...base, profitEligibleCents: eligible, cashOnlyCents: cashOnly, profitEffectCents: eligible, limitCents: limit, needsConfirmation: cashOnly > 0 };
  }
  if (kind === 'reallocation') return { ...base, profitEffectCents: -amountCents }; // D1: the FULL amount
  const relabel = Math.min(amountCents, Math.max(0, lineOf(st, lineOfFund(from) as Line).unspentCents));
  return { ...base, chargeRelabelCents: relabel };
}

// ---------- D2 void guard ----------

/** Result of the D2 check. */
export interface GuardResult { blocked: boolean; reason: 'CHARGED_NEGATIVE' | 'RELEASE_UNBACKED' | null }

/**
 * D2 (10.4): voiding a daily entry (incl. void-and-replace), a re-allocation or a Cost<->Electricity move is blocked
 * ONLY if the change lowers some Charged_L or the combined Unspent AND the resulting state has any Charged_L < 0, or
 * net releases > 0 while combined Unspent < 0. Judged on the FINAL state (`after`); `before` is the state with the
 * record still in place. Voids of releases and of payments only loosen the limits and are never checked.
 */
export function voidGuard(before: Standing, after: Standing): GuardResult {
  const lowers = after.materials.chargedCents < before.materials.chargedCents
    || after.electricity.chargedCents < before.electricity.chargedCents
    || after.unspentCents < before.unspentCents;
  if (!lowers) return { blocked: false, reason: null };
  if (after.materials.chargedCents < 0 || after.electricity.chargedCents < 0) return { blocked: true, reason: 'CHARGED_NEGATIVE' };
  if (after.netReleasesCents > 0 && after.unspentCents < 0) return { blocked: true, reason: 'RELEASE_UNBACKED' };
  return { blocked: false, reason: null };
}

/** The facts without one daily entry (the state after its void). */
export function withoutDay(facts: IceFacts, id: number): IceFacts {
  return { ...facts, days: facts.days.filter((d) => d.id !== id) };
}

/** The facts without one fund move. */
export function withoutMove(facts: IceFacts, id: number): IceFacts {
  return { ...facts, moves: facts.moves.filter((m) => m.id !== id) };
}

/** The facts with one daily entry replaced by another (the FINAL state of a void-and-replace). */
export function withReplacedDay(facts: IceFacts, id: number, replacement: DayFact): IceFacts {
  return { ...facts, days: [...facts.days.filter((d) => d.id !== id), replacement] };
}

// ---------- recognized profit and the period report (10.3, 10.5, 10.6) ----------

/** Signed contributions to recognized profit (10.3); re-allocations and other expenses are negative. */
export interface Recognition {
  dailyProfitShareCents: number; profitEligibleReleasesCents: number; reallocationsCents: number;
  otherExpensesCents: number; cashOverShortCents: number;
}

/** The figures of one report row (a day, a month, any period) per the period rule 10.6 and API_CONTRACTS `/reports/pnl/icecream`. */
export interface PeriodReport {
  salesCents: number;
  /** Movements of Charged_Materials dated in the period (allocations, re-allocations, re-labels, releases). */
  materialsChargeCents: number;
  electricityChargeCents: number;
  /** Other costs paid from the Profit fund (positive magnitude). */
  otherExpensesCents: number;
  cashOverShortCents: number;
  /** The official Ice Cream profit of the period: the sum of `recognition`. */
  recognizedProfitCents: number;
  recognition: Recognition;
  memo: { actualMaterialsPaidCents: number; actualElectricityPaidCents: number; otherCostsFromCostElecFundsCents: number };
  /** 10.6: outstanding excess at period end - outstanding excess at period start (a pure flow, additive). */
  excessCostNotChargedCents: number;
  /** 10.6: recognized profit - excess cost not yet charged (both for the period). */
  profitAfterExcessCostCents: number;
  /** Balances at period end: never summed across rows. */
  balancesAsOfPeriodEnd: {
    unspentByLine: { materialsCents: number; electricityCents: number }; unspentCents: number; outstandingExcessCostCents: number;
  };
}

/** Recognized profit of raw sums: daily shares + releases - re-allocations - other expenses +/- over/short (10.3). */
function recognitionOf(s: Sums): Recognition {
  return {
    dailyProfitShareCents: s.dailyProfitShare, profitEligibleReleasesCents: s.releases, reallocationsCents: 0 - s.reallocations, // `0 - x`, never `-x`: a unary minus of 0 would give -0
    otherExpensesCents: 0 - s.otherFromProfit, cashOverShortCents: s.overShort,
  };
}

/** Sum of the recognition components. */
export function recognizedTotal(r: Recognition): number {
  return r.dailyProfitShareCents + r.profitEligibleReleasesCents + r.reallocationsCents + r.otherExpensesCents + r.cashOverShortCents;
}

/**
 * The report figures of a period (10.6 period rule). Every flow uses ONLY the movements whose business date is inside
 * `from..to` (inclusive; either may be omitted = open end); balances are as of the period end `to` and the excess-cost
 * flow is end minus start, so daily rows add up exactly to the month and months to the year.
 */
export function periodReport(facts: IceFacts, from?: string, to?: string): PeriodReport {
  const inside = (d: string): boolean => (from === undefined || d >= from) && (to === undefined || d <= to);
  const s = accumulate(facts, inside);
  const recognition = recognitionOf(s);
  const recognized = recognizedTotal(recognition);
  const end = standing(facts, to);
  const start = from === undefined ? null : standingBefore(facts, from);
  const excessEnd = outstandingExcess(end);
  const excessFlow = excessEnd - (start === null ? 0 : outstandingExcess(start));
  return {
    salesCents: s.salesCents, materialsChargeCents: s.chargedMaterials, electricityChargeCents: s.chargedElectricity,
    otherExpensesCents: s.otherFromProfit, cashOverShortCents: s.overShort, recognizedProfitCents: recognized, recognition,
    memo: {
      actualMaterialsPaidCents: s.actualMaterialsPaid, actualElectricityPaidCents: s.actualElectricityPaid,
      otherCostsFromCostElecFundsCents: s.otherFromCostElec,
    },
    excessCostNotChargedCents: excessFlow, profitAfterExcessCostCents: recognized - excessFlow,
    balancesAsOfPeriodEnd: {
      unspentByLine: { materialsCents: end.materials.unspentCents, electricityCents: end.electricity.unspentCents },
      unspentCents: end.unspentCents, outstandingExcessCostCents: excessEnd,
    },
  };
}

/** Recognized profit of all movements dated on or before `asOf` (all of them when omitted). */
export function recognizedProfit(facts: IceFacts, asOf?: string): number {
  return recognizedTotal(recognitionOf(accumulate(facts, (d) => asOf === undefined || d <= asOf)));
}

/**
 * "True" profit the owner could compute from the cash actually spent: sales - Settled materials - Settled electricity
 * - other costs from the Profit fund +/- over/short (10.4 identity). Recognized profit minus this = -Unspent.
 */
export function trueProfit(facts: IceFacts, asOf?: string): number {
  const s = accumulate(facts, (d) => asOf === undefined || d <= asOf);
  return s.salesCents - s.settledMaterials - s.settledElectricity - s.otherFromProfit + s.overShort;
}
