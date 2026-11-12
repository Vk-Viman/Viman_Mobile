// Phase 10 fund moves API (BUSINESS_RULES 10.2-10.4, D1, D2, D4, R1, R9, R-FD, section 12). Protects:
//   10.2  a move writes TWO fund rows (A -x, B +x) and NO cash entry; negative source = warning only; SAME_FUND is 400;
//   preview  no write at all; answers eligible / cash-only / re-label / profit effect / explanation / negative-fund warning;
//   10.3  release +eligible part, re-allocation -FULL amount (D1), Cost <-> Electricity profit unchanged;
//   D4    split: 409 SPLIT_CONFIRMATION_REQUIRED with the split and a plain-language explanation, nothing posted; the confirmation must
//         name the profit-eligible amount the owner saw - if the split changed meanwhile the server asks again; one atomic record with both parts;
//   D2    void: releases and cash-only moves always voidable; re-allocation / re-label blocked (422 VOID_BREAKS_RELEASE) while a release depends on them;
//   10.6  limits follow SAVING ORDER (a backdated move sees entries saved later in time but dated after it), reports/asOf follow BUSINESS DATE;
//   R1/R9/R-FD/clientRef/validation/rollback as for the other Ice Cream writes.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { auditRows, breakAudit, get, post } from './helpers/catalog.ts';
import { apiBase, daysAgo, daysAhead, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { FUTURE_MSG, err, num, sql } from './helpers/phase4.ts';
import { cashOfRef, closeOk, openNew, reopenNew } from './helpers/phase8.ts';
import { MOVE_KEYS, dayOk, expectBooksAgree, fundRowsOf, fundsGet, moveNew, moveOk, movePreview, moveVoid, payOk, rs, snap10 } from './helpers/phase10.ts';

const env = new TestEnv();
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});
/** A day of Rs 1,000: Cost 600 / Electricity 100 / Profit 300. */
const baseDay = (s: ApiBase, over: Record<string, unknown> = {}) => dayOk(s, { salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100), ...over });

describe('POST /icecream/fund-moves/preview', () => {
  it('release within the limit: all eligible, no confirmation; writes NOTHING', async () => {
    const s = await setup();
    await baseDay(s);
    const before = snap10(s);
    const r = await movePreview(s, 'cost', 'profit', rs(500));
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['cashOnlyCents', 'chargeRelabelCents', 'explanation', 'kind', 'needsConfirmation', 'profitEffectCents', 'profitEligibleCents', 'warnings']);
    expect(r.body).toMatchObject({ profitEligibleCents: rs(500), cashOnlyCents: 0, chargeRelabelCents: 0, profitEffectCents: rs(500), needsConfirmation: false, kind: 'release', warnings: [] });
    expect(r.body.explanation).toContain('counted as profit');
    expect(snap10(s)).toEqual(before);
  });

  it('D4 split: eligible and cash-only parts with a plain-language explanation naming the cash-only amount', async () => {
    const s = await setup();
    await openNew(s, 'icecream', { fund: 'cost', amountCents: rs(5000) });
    const r = (await movePreview(s, 'cost', 'profit', rs(5000))).body;
    expect(r).toMatchObject({ profitEligibleCents: 0, cashOnlyCents: rs(5000), profitEffectCents: 0, needsConfirmation: true });
    expect(r.explanation).toBe('Rs. 5,000.00 of this is opening balance, capital or money already spent (or more than is left of the materials allocation), so it will not count as profit. Rs. 0.00 will be counted as profit. The cash moves either way.');
  });

  it('re-allocation and re-label previews; negative-fund warning when the source would go below zero', async () => {
    const s = await setup();
    await baseDay(s);
    const re = (await movePreview(s, 'profit', 'cost', rs(50))).body;
    expect(re).toMatchObject({ kind: 'reallocation', profitEffectCents: -rs(50), profitEligibleCents: 0, cashOnlyCents: 0, chargeRelabelCents: 0, needsConfirmation: false });
    expect(re.explanation).toContain('lowers the recognized profit by the full Rs. 50.00');
    const rl = (await movePreview(s, 'cost', 'electricity', rs(100))).body;
    expect(rl).toMatchObject({ kind: 'relabel', chargeRelabelCents: rs(100), profitEffectCents: 0 });
    const low = (await movePreview(s, 'electricity', 'cost', rs(150))).body; // electricity fund holds only 100
    expect(low.warnings).toEqual([expect.objectContaining({ code: 'NEGATIVE_FUND_BALANCE', fund: 'electricity', balanceCents: -rs(50) })]);
    expect(low.chargeRelabelCents).toBe(rs(100)); // only 100 of electricity is still unspent
    expect(low.explanation).toContain('only Rs. 100.00 of the cost charge moves');
  });

  it('SAME_FUND and validation errors', async () => {
    const s = await setup();
    const same = await movePreview(s, 'cost', 'cost', 100);
    expect(same.status).toBe(400);
    expect(err(same).code).toBe('SAME_FUND');
    for (const body of [{ fromFund: 'cost', toFund: 'bank', amountCents: 5 }, { fromFund: 'cost', toFund: 'profit', amountCents: 0 }, { fromFund: 'cost', toFund: 'profit', amountCents: 1.5 },
      { fromFund: 'cost', toFund: 'profit' }, { fromFund: 'cost', toFund: 'profit', amountCents: 5, extra: 1 }]) {
      expect((await post(s.app, '/icecream/fund-moves/preview', body)).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('POST /icecream/fund-moves - create', () => {
  it('release within the limit: 201 { move, funds, warnings }, TWO fund rows (-x / +x), NO cash entry, recognized profit + eligible part', async () => {
    const s = await setup();
    await baseDay(s);
    const cashBefore = num(s, 'SELECT COUNT(*) FROM cash_entries');
    const r = await moveNew(s, 'cost', 'profit', rs(500), { note: ' weekly sweep ' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['funds', 'move', 'warnings']);
    const m = r.body.move;
    expect(Object.keys(m).sort()).toEqual(MOVE_KEYS);
    expect(m).toMatchObject({ fromFund: 'cost', toFund: 'profit', amountCents: rs(500), kind: 'release', profitEffectCents: rs(500), chargeRelabelCents: 0, cashOnlyCents: 0,
      note: 'weekly sweep', status: 'posted', backdated: false, businessDate: today() });
    expect(num(s, 'SELECT COUNT(*) FROM cash_entries')).toBe(cashBefore); // a move never touches the cash book
    expect(cashOfRef(s, 'icecream_fund_moves', m.id)).toHaveLength(0);
    expect(fundRowsOf(s, 'icecream_fund_moves', m.id).map((f) => [f.fund, f.amount_cents, f.kind])).toEqual([['cost', -rs(500), 'fund_move'], ['profit', rs(500), 'fund_move']]);
    expect(r.body.funds.funds).toEqual({ cost: { balanceCents: rs(100) }, electricity: { balanceCents: rs(100) }, profit: { balanceCents: rs(800) } });
    expect(r.body.funds.recognizedProfitToDateCents).toBe(rs(800)); // 300 + eligible 500
    expect(r.body.funds.lines.materials.chargedCents).toBe(rs(100)); // the release lowers the charge
    const a = auditRows(s.ctx, 'icecream_fund_move');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'create', before: null, entityId: String(m.id) });
    expect(sql(s, "SELECT business_date, backdated FROM audit_logs WHERE entity = 'icecream_fund_move'")[0]).toMatchObject({ business_date: today(), backdated: 0 });
    await expectBooksAgree(s);
  });

  it('D4: above the limit and unconfirmed -> 409 SPLIT_CONFIRMATION_REQUIRED with the split and explanation; NOTHING posted', async () => {
    const s = await setup();
    await baseDay(s);
    await openNew(s, 'icecream', { fund: 'cost', amountCents: rs(5000) });
    const before = snap10(s);
    const r = await moveNew(s, 'cost', 'profit', rs(1000)); // limit is the 600 allocated; the rest is the opening balance
    expect(r.status).toBe(409);
    expect(err(r)).toMatchObject({ code: 'SPLIT_CONFIRMATION_REQUIRED', profitEligibleCents: rs(600), cashOnlyCents: rs(400) });
    expect(err(r).explanation).toBe(err(r).message);
    expect(err(r).explanation).toContain('Rs. 400.00 of this is opening balance, capital or money already spent');
    expect(snap10(s)).toEqual(before);
  });

  it('D4: a confirmation posts ONE atomic record with both parts; cash moves in full, profit rises only by the eligible part, the charge falls by the eligible part', async () => {
    const s = await setup();
    await baseDay(s);
    await openNew(s, 'icecream', { fund: 'cost', amountCents: rs(5000) });
    const r = await moveNew(s, 'cost', 'profit', rs(1000), { confirmSplit: true, confirmedProfitEligibleCents: rs(600) });
    expect(r.status).toBe(201);
    expect(r.body.move).toMatchObject({ amountCents: rs(1000), profitEffectCents: rs(600), cashOnlyCents: rs(400), chargeRelabelCents: 0 });
    expect(num(s, 'SELECT COUNT(*) FROM icecream_fund_moves')).toBe(1);
    expect(fundRowsOf(s, 'icecream_fund_moves', r.body.move.id).map((f) => f.amount_cents)).toEqual([-rs(1000), rs(1000)]);
    expect(r.body.funds.funds.cost.balanceCents).toBe(rs(5000 + 600 - 1000));
    expect(r.body.funds.funds.profit.balanceCents).toBe(rs(300 + 1000));
    expect(r.body.funds.recognizedProfitToDateCents).toBe(rs(300 + 600));
    expect(r.body.funds.lines.materials.chargedCents).toBe(0);
    await expectBooksAgree(s);
  });

  it('D4 re-confirmation: a stale or missing confirmation gets the CURRENT split again; only the matching amount posts', async () => {
    const s = await setup();
    await baseDay(s);
    // confirmation without the amount the owner saw -> asked again
    const noAmount = await moveNew(s, 'cost', 'profit', rs(800), { confirmSplit: true });
    expect(noAmount.status).toBe(409);
    expect(err(noAmount)).toMatchObject({ profitEligibleCents: rs(600), cashOnlyCents: rs(200) });
    // the owner saw eligible 600; meanwhile Rs 100 of materials was paid -> the limit is now 500
    await payOk(s, 'materials', rs(100), { fund: 'cost' });
    const stale = await moveNew(s, 'cost', 'profit', rs(800), { confirmSplit: true, confirmedProfitEligibleCents: rs(600) });
    expect(stale.status).toBe(409);
    expect(err(stale)).toMatchObject({ code: 'SPLIT_CONFIRMATION_REQUIRED', profitEligibleCents: rs(500), cashOnlyCents: rs(300) });
    expect(num(s, 'SELECT COUNT(*) FROM icecream_fund_moves')).toBe(0);
    const ok = await moveNew(s, 'cost', 'profit', rs(800), { confirmSplit: true, confirmedProfitEligibleCents: rs(500) });
    expect(ok.status).toBe(201);
    expect(ok.body.move).toMatchObject({ profitEffectCents: rs(500), cashOnlyCents: rs(300) });
  });

  it('a confirmation for a move that needs none is simply accepted (no split to confirm); confirmSplit alone does not skip a real split', async () => {
    const s = await setup();
    await baseDay(s);
    const r = await moveNew(s, 'cost', 'profit', rs(100), { confirmSplit: true, confirmedProfitEligibleCents: 0 });
    expect(r.status).toBe(201);
    expect(r.body.move).toMatchObject({ profitEffectCents: rs(100), cashOnlyCents: 0 });
    const split = await moveNew(s, 'cost', 'profit', rs(900), { confirmSplit: true, confirmedProfitEligibleCents: rs(900) }); // limit is now 500
    expect(split.status).toBe(409);
    expect((await moveNew(s, 'cost', 'profit', rs(900), { confirmSplit: false, confirmedProfitEligibleCents: rs(500) })).status).toBe(409);
  });

  it('release from Electricity uses the Electricity line and the combined unspent', async () => {
    const s = await setup();
    await baseDay(s); // electricity allocation 100, materials 600
    await payOk(s, 'materials', rs(550), { fund: 'cost' }); // materials unspent 50, electricity unspent 100, combined 150
    const p = (await movePreview(s, 'electricity', 'profit', rs(120))).body;
    expect(p).toMatchObject({ profitEligibleCents: rs(100), cashOnlyCents: rs(20), needsConfirmation: true });
    const r = await moveOk(s, 'electricity', 'profit', rs(120));
    expect(r.profitEffectCents).toBe(rs(100));
    expect((await fundsGet(s)).body.lines.electricity.chargedCents).toBe(0);
  });

  it('D1 re-allocation: Profit -> Cost lowers recognized profit by the FULL amount and raises the line charge; the fund may go negative (warning only)', async () => {
    const s = await setup();
    await baseDay(s);
    const r = await moveNew(s, 'profit', 'cost', rs(500)); // profit fund holds only 300
    expect(r.status).toBe(201);
    expect(r.body.move).toMatchObject({ kind: 'reallocation', profitEffectCents: -rs(500), cashOnlyCents: 0, chargeRelabelCents: 0 });
    expect(r.body.warnings).toEqual([expect.objectContaining({ code: 'NEGATIVE_FUND_BALANCE', fund: 'profit', balanceCents: -rs(200) })]);
    expect(r.body.funds.recognizedProfitToDateCents).toBe(rs(300 - 500));
    expect(r.body.funds.lines.materials.chargedCents).toBe(rs(1100));
    await expectBooksAgree(s);
  });

  it('Cost <-> Electricity re-label: cash moves, charge re-labelled by min(x, unspent source), profit unchanged; both directions', async () => {
    const s = await setup();
    await baseDay(s);
    await payOk(s, 'materials', rs(560), { fund: 'cost' }); // materials unspent 40
    const a = await moveOk(s, 'cost', 'electricity', rs(100));
    expect(a).toMatchObject({ kind: 'relabel', chargeRelabelCents: rs(40), profitEffectCents: 0, cashOnlyCents: 0 });
    const f = (await fundsGet(s)).body;
    expect([f.lines.materials.chargedCents, f.lines.electricity.chargedCents]).toEqual([rs(560), rs(140)]);
    const b = await moveOk(s, 'electricity', 'cost', rs(30));
    expect(b.chargeRelabelCents).toBe(rs(30));
    expect((await fundsGet(s)).body.recognizedProfitToDateCents).toBe(rs(300));
    await expectBooksAgree(s);
  });

  it('SAME_FUND is 400 and writes nothing; validation: enums, positive integer amounts, confirmedProfitEligibleCents integer >= 0, unknown fields, postedAt', async () => {
    const s = await setup();
    const before = snap10(s);
    const same = await moveNew(s, 'profit', 'profit', 100);
    expect(same.status).toBe(400);
    expect(err(same).code).toBe('SAME_FUND');
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ fromFund: 'bank' }, 'fromFund'], [{ toFund: 5 }, 'toFund'], [{ amountCents: 0 }, 'amountCents'], [{ amountCents: -1 }, 'amountCents'], [{ amountCents: '5' }, 'amountCents'],
      [{ amountCents: 2.5 }, 'amountCents'], [{ amountCents: 1e12 + 1 }, 'amountCents'], [{ confirmSplit: 'yes' }, 'confirmSplit'], [{ confirmedProfitEligibleCents: -1 }, 'confirmedProfitEligibleCents'],
      [{ confirmedProfitEligibleCents: 1.5 }, 'confirmedProfitEligibleCents'], [{ note: 'x'.repeat(501) }, 'note'], [{ businessDate: '2026-02-30' }, 'businessDate'],
      [{ clientRef: 'abc' }, 'clientRef'], [{ postedAt: '2020-01-01T00:00:00Z' }, 'postedAt'], [{ profitEffectCents: 5 }, 'profitEffectCents'],
    ];
    for (const [over, field] of cases) {
      const r = await moveNew(s, 'cost', 'profit', rs(10), over);
      expect(r.status, JSON.stringify(over)).toBe(400);
      expect(Object.keys(err(r).fields), JSON.stringify(over)).toContain(field);
    }
    expect(snap10(s)).toEqual(before);
  });

  it('R-FD: future date refused; a backdated move is accepted and flagged', async () => {
    const s = await setup();
    await baseDay(s, { businessDate: daysAgo(6) });
    const f = await moveNew(s, 'cost', 'profit', rs(10), { businessDate: daysAhead(1) });
    expect(err(f)).toMatchObject({ code: 'FUTURE_DATE_NOT_ALLOWED', message: FUTURE_MSG });
    const b = await moveNew(s, 'cost', 'profit', rs(10), { businessDate: daysAgo(3) });
    expect(b.status).toBe(201);
    expect(b.body.move.backdated).toBe(true);
    expect(sql(s, "SELECT business_date, backdated FROM audit_logs WHERE entity = 'icecream_fund_move'")[0]).toMatchObject({ business_date: daysAgo(3), backdated: 1 });
    expect(fundRowsOf(s, 'icecream_fund_moves', b.body.move.id).every((f) => f.business_date === daysAgo(3))).toBe(true);
  });

  it('duplicate submission: the same clientRef returns the first move (200); no second move or fund rows - even for a split that was confirmed', async () => {
    const s = await setup();
    await baseDay(s);
    const clientRef = ref();
    const a = await moveNew(s, 'cost', 'profit', rs(900), { clientRef, confirmSplit: true, confirmedProfitEligibleCents: rs(600) });
    const before = snap10(s);
    const b = await moveNew(s, 'cost', 'profit', rs(900), { clientRef });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.move).toEqual(a.body.move);
    expect(snap10(s)).toEqual(before);
  });

  it('R9: create and void on a closed Ice Cream day are 409 DAY_CLOSED (no cash entry is involved, the service still guards); reopen lifts it', async () => {
    const s = await setup();
    const date = daysAgo(2);
    await baseDay(s, { businessDate: date });
    const m = await moveOk(s, 'cost', 'profit', rs(100), { businessDate: date });
    const closing = await closeOk(s, 'icecream', date);
    const before = snap10(s);
    const c = await moveNew(s, 'cost', 'profit', rs(10), { businessDate: date });
    expect(err(c)).toMatchObject({ code: 'DAY_CLOSED', book: 'icecream', businessDate: date });
    expect(err(await moveVoid(s, m.id))).toMatchObject({ code: 'DAY_CLOSED', book: 'icecream', businessDate: date });
    expect(snap10(s)).toEqual(before);
    await reopenNew(s, closing.id);
    expect((await moveVoid(s, m.id)).status).toBe(200);
  });
});

describe('10.6 ordering - limits follow SAVING order, reports follow BUSINESS date', () => {
  it('a move dated BEFORE a day that was saved earlier still sees that day\'s allocation (limit = everything saved so far, whatever its date)', async () => {
    const s = await setup();
    await baseDay(s, { businessDate: today() }); // saved first, dated today
    const r = await moveNew(s, 'cost', 'profit', rs(600), { businessDate: daysAgo(10) }); // saved second, dated 10 days ago
    expect(r.status).toBe(201); // no split: the full 600 is eligible although the allocation is dated after the move
    expect(r.body.move).toMatchObject({ profitEffectCents: rs(600), cashOnlyCents: 0, backdated: true });
  });

  it('a day saved AFTER the move but dated before it does not help the earlier move: it was judged on what existed at saving time', async () => {
    const s = await setup();
    const first = await moveNew(s, 'cost', 'profit', rs(100), { businessDate: daysAgo(1) }); // nothing allocated yet: all cash-only
    expect(first.status).toBe(409);
    expect(err(first)).toMatchObject({ profitEligibleCents: 0, cashOnlyCents: rs(100) });
    const m = await moveOk(s, 'cost', 'profit', rs(100), { businessDate: daysAgo(1) }); // confirmed split, stored: eligible 0
    expect(m.profitEffectCents).toBe(0);
    await baseDay(s, { businessDate: daysAgo(5) }); // saved later, dated earlier
    expect(sql(s, 'SELECT profit_effect_cents, cash_only_cents FROM icecream_fund_moves WHERE id = ?', m.id)[0]).toMatchObject({ profit_effect_cents: 0, cash_only_cents: rs(100) });
    // the SAME release now would be eligible: limit follows the posting order of what exists now
    expect((await movePreview(s, 'cost', 'profit', rs(100))).body.profitEligibleCents).toBe(rs(100));
  });

  it('reports and asOf follow the BUSINESS date: balances and recognized profit as of a date use only rows dated on or before it', async () => {
    const s = await setup();
    await baseDay(s, { businessDate: daysAgo(10) });
    await moveOk(s, 'cost', 'profit', rs(500), { businessDate: daysAgo(4) }); // saved LAST among these, dated in between
    await baseDay(s, { businessDate: daysAgo(2), salesCents: rs(2000), costAllocCents: rs(1000), electricityAllocCents: rs(200) });
    const at = async (d: string) => (await fundsGet(s, `?asOf=${d}`)).body;
    expect((await at(daysAgo(11))).totalCents).toBe(0);
    const a = await at(daysAgo(5));
    expect(a.funds).toEqual({ cost: { balanceCents: rs(600) }, electricity: { balanceCents: rs(100) }, profit: { balanceCents: rs(300) } });
    expect(a.recognizedProfitToDateCents).toBe(rs(300));
    const b = await at(daysAgo(4));
    expect(b.funds.cost.balanceCents).toBe(rs(100));
    expect(b.funds.profit.balanceCents).toBe(rs(800));
    expect(b.recognizedProfitToDateCents).toBe(rs(800));
    const c = await at(daysAgo(2));
    expect(c.recognizedProfitToDateCents).toBe(rs(800 + 800));
    expect(c.totalCents).toBe(rs(3000));
    expect(c.totalCents).toBe(c.cashBookBalanceCents);
  });
});

describe('POST /icecream/fund-moves/:id/void', () => {
  it('R1: reversal fund rows (kind reversal, original date), move void; releases can always be voided; audit with reason', async () => {
    const s = await setup();
    await baseDay(s);
    const m = await moveOk(s, 'cost', 'profit', rs(500), { businessDate: daysAgo(1) });
    const r = await moveVoid(s, m.id, 'wrong day');
    expect(r.status).toBe(200);
    expect(r.body.move).toMatchObject({ status: 'void', voidReason: 'wrong day' });
    expect(r.body.funds.funds).toEqual({ cost: { balanceCents: rs(600) }, electricity: { balanceCents: rs(100) }, profit: { balanceCents: rs(300) } });
    expect(r.body.funds.recognizedProfitToDateCents).toBe(rs(300));
    expect(r.body.funds.lines.materials.chargedCents).toBe(rs(600));
    const rows = fundRowsOf(s, 'icecream_fund_moves', m.id);
    expect(rows.map((f) => [f.fund, f.amount_cents, f.kind])).toEqual([['cost', -rs(500), 'fund_move'], ['profit', rs(500), 'fund_move'], ['cost', rs(500), 'reversal'], ['profit', -rs(500), 'reversal']]);
    expect(rows[2]!.reverses_entry_id).toBe(rows[0]!.id);
    expect(rows[3]!.reverses_entry_id).toBe(rows[1]!.id);
    expect(rows.slice(2).every((f) => f.business_date === daysAgo(1))).toBe(true);
    expect(cashOfRef(s, 'icecream_fund_moves', m.id)).toHaveLength(0);
    expect(auditRows(s.ctx, 'icecream_fund_move').map((a) => a.action)).toEqual(['create', 'void']);
    expect(sql(s, "SELECT business_date, backdated, note FROM audit_logs WHERE action = 'void' AND entity = 'icecream_fund_move'")[0]).toMatchObject({ business_date: daysAgo(1), backdated: 1, note: 'wrong day' });
    await expectBooksAgree(s);
  });

  it('a cash-only (split) move can always be voided', async () => {
    const s = await setup();
    await openNew(s, 'icecream', { fund: 'cost', amountCents: rs(500) });
    const m = await moveOk(s, 'cost', 'profit', rs(500));
    expect(m.cashOnlyCents).toBe(rs(500));
    expect((await moveVoid(s, m.id)).status).toBe(200);
  });

  it('D2: a re-allocation cannot be voided while a release depends on the charge it added; after the release is voided it can', async () => {
    const s = await setup();
    await baseDay(s);
    const re = await moveOk(s, 'profit', 'cost', rs(200)); // Charged_M 800
    const rel = await moveOk(s, 'cost', 'profit', rs(800)); // release eligible 800 -> Charged_M 0
    expect(rel.profitEffectCents).toBe(rs(800));
    const before = snap10(s);
    const r = await moveVoid(s, re.id);
    expect(r.status).toBe(422);
    expect(err(r)).toMatchObject({ code: 'VOID_BREAKS_RELEASE' });
    expect(err(r).message).toContain('reverse the release first');
    expect(snap10(s)).toEqual(before);
    expect((await moveVoid(s, rel.id)).status).toBe(200); // releases can always be voided
    expect((await moveVoid(s, re.id)).status).toBe(200);
    await expectBooksAgree(s);
  });

  it('D2: a Cost <-> Electricity move cannot be voided when that would leave a released line with a negative charge', async () => {
    const s = await setup();
    await baseDay(s);
    const rl = await moveOk(s, 'cost', 'electricity', rs(300)); // M 300, E 400
    const rel = await moveOk(s, 'electricity', 'profit', rs(400)); // E 0
    const r = await moveVoid(s, rl.id);
    expect(err(r).code).toBe('VOID_BREAKS_RELEASE');
    await moveVoid(s, rel.id);
    expect((await moveVoid(s, rl.id)).status).toBe(200);
  });

  it('a re-allocation that nothing depends on can be voided (no release exists)', async () => {
    const s = await setup();
    await baseDay(s);
    const re = await moveOk(s, 'profit', 'electricity', rs(50));
    expect((await moveVoid(s, re.id)).status).toBe(200);
    expect((await fundsGet(s)).body.recognizedProfitToDateCents).toBe(rs(300));
  });

  it('404 unknown id, 409 ALREADY_VOID, reason required, id digits', async () => {
    const s = await setup();
    await baseDay(s);
    const m = await moveOk(s, 'cost', 'profit', rs(10));
    expect((await moveVoid(s, 99999)).status).toBe(404);
    expect((await post(s.app, `/icecream/fund-moves/${m.id}/void`, { reason: ' ' })).status).toBe(400);
    expect((await post(s.app, '/icecream/fund-moves/abc/void', { reason: 'x' })).status).toBe(400);
    expect((await moveVoid(s, m.id)).status).toBe(200);
    expect(err(await moveVoid(s, m.id)).code).toBe('ALREADY_VOID');
  });
});

describe('GET /icecream/fund-moves', () => {
  it('newest first, void rows listed but not summed, filters and paging', async () => {
    const s = await setup();
    await baseDay(s, { businessDate: daysAgo(5) });
    const a = await moveOk(s, 'cost', 'profit', rs(100), { businessDate: daysAgo(3) });
    await moveOk(s, 'profit', 'cost', rs(20), { businessDate: daysAgo(2) });
    await moveOk(s, 'cost', 'electricity', rs(30), { businessDate: daysAgo(1) });
    await moveVoid(s, a.id);
    const all = (await get(s.app, '/icecream/fund-moves')).body;
    expect(all.items.map((m: any) => [m.kind, m.status])).toEqual([['relabel', 'posted'], ['reallocation', 'posted'], ['release', 'void']]);
    expect(all.total).toBe(3);
    expect(all.totals).toEqual({ amountCents: rs(50), profitEffectCents: -rs(20), cashOnlyCents: 0 });
    expect((await get(s.app, '/icecream/fund-moves?status=void')).body.items).toHaveLength(1);
    expect((await get(s.app, `/icecream/fund-moves?from=${daysAgo(2)}&to=${daysAgo(2)}`)).body.items).toHaveLength(1);
    expect((await get(s.app, '/icecream/fund-moves?limit=1&offset=1')).body.items.map((m: any) => m.kind)).toEqual(['reallocation']);
    expect((await get(s.app, '/icecream/fund-moves?status=bogus')).status).toBe(400);
  });
});

describe('rollback: one transaction per fund move write', () => {
  it('a failing audit insert leaves no move and no fund rows', async () => {
    quiet();
    const s = await setup();
    await baseDay(s);
    const before = snap10(s);
    breakAudit(s.ctx, 'icecream_fund_move');
    expect((await moveNew(s, 'cost', 'profit', rs(10))).status).toBe(500);
    expect(snap10(s)).toEqual(before);
  });

  it('a failure AFTER the first fund row (second row refused) leaves nothing; the same clientRef works once the fault is gone', async () => {
    quiet();
    const s = await setup();
    await baseDay(s);
    const before = snap10(s);
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_fund BEFORE INSERT ON icecream_fund_entries WHEN NEW.kind = 'fund_move' AND NEW.amount_cents > 0 BEGIN SELECT RAISE(ABORT, 'fund boom'); END`);
    const clientRef = ref();
    expect((await moveNew(s, 'cost', 'profit', rs(10), { clientRef })).status).toBe(500);
    expect(snap10(s)).toEqual(before);
    s.ctx.database.conn.exec('DROP TRIGGER test_break_fund');
    expect((await moveNew(s, 'cost', 'profit', rs(10), { clientRef })).status).toBe(201);
  });

  it('a failing audit on VOID leaves the move posted and no reversal rows', async () => {
    quiet();
    const s = await setup();
    await baseDay(s);
    const m = await moveOk(s, 'cost', 'profit', rs(10));
    const before = snap10(s);
    s.ctx.database.conn.exec(`CREATE TRIGGER test_break_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'void' BEGIN SELECT RAISE(ABORT, 'audit boom'); END`);
    expect((await moveVoid(s, m.id)).status).toBe(500);
    expect(snap10(s)).toEqual(before);
    expect(sql(s, 'SELECT status FROM icecream_fund_moves WHERE id = ?', m.id)[0]!.status).toBe('posted');
  });
});
