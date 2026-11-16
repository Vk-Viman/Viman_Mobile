// PHASE 23 - type-specific rules of "correct this entry" for stock losses and Ice Cream payments / fund moves (group 10 of the contract):
// restock and re-remove at the right cost, damaged-return loss refused, three funds = Ice Cream cash book = fund ledger, D2 release guard,
// D4 split confirmation, fund-negative warnings, electricity rule on the replacement.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, buy, daysAgo, mkProduct, ref } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { openNew } from './helpers/phase8.ts';
import { lossNew, poolOf, reconOk } from './helpers/phase4.ts';
import { returnOk, rl, sellOne } from './helpers/phase5.ts';
import { dayOk, expectBooksAgree, fundsGet, moveOk, payOk, rs } from './helpers/phase10.ts';
import { allProblems, fingerprint } from './helpers/phase23.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());
const body = (reason: string, replacement: Record<string, unknown>) => ({ reason, replacement });

describe('stock loss correction', () => {
  it('restocks at the original cost and removes the new quantity at the CURRENT average (hand calculation)', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    await openNew(s, 'shop', { businessDate: daysAgo(40), amountCents: 5_000_000 });
    await buy(s, [{ productId: p.id, packs: 1, packSize: 10, lineTotalCents: 10_000 }], { businessDate: daysAgo(30) }); // 10 @ 1,000
    const loss = (await lossNew(s, p.id, 4, { businessDate: daysAgo(20) })).body.item; // cost 4,000; pool 6 / 6,000
    expect(loss.costCents).toBe(4000);
    await buy(s, [{ productId: p.id, packs: 1, packSize: 10, lineTotalCents: 20_000 }], { businessDate: daysAgo(10) }); // pool 16 / 26,000
    expect(poolOf(s, p.id)).toEqual({ qty: 16, value: 26_000 });
    const r = await post(s.app, `/stock-losses/${loss.id}/correct`, body('counted wrong', { productId: p.id, qty: 2, reason: 'damaged', clientRef: ref() }));
    expect(r.status).toBe(201);
    // void: +4 units at the original 4,000 -> 20 / 30,000 (average 1,500); new loss of 2 removes 3,000
    expect(r.body.replacement).toMatchObject({ qty: 2, costCents: 3000, businessDate: daysAgo(20) });
    expect(poolOf(s, p.id)).toEqual({ qty: 18, value: 27_000 });
    await reconOk(s);
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('a loss from a damaged sales return is 409 CORRECTION_NOT_SUPPORTED (check, preview, correct) and the void refusal stays', async () => {
    const s = await setup();
    const p = await mkProduct(s);
    await openNew(s, 'shop', { businessDate: daysAgo(40), amountCents: 5_000_000 });
    await buy(s, [{ productId: p.id, packs: 1, packSize: 10, lineTotalCents: 10_000 }], { businessDate: daysAgo(30) });
    const sale = await sellOne(s, p.id, 2, 150_000);
    await returnOk(s, sale.id, [rl(sale.items[0].id, 1, false)]);
    const dl = (await get(s.app, '/stock-losses')).body.items.find((l: any) => l.source === 'damaged_return');
    const fp = fingerprint(s.ctx);
    const rep = body('x', { productId: p.id, qty: 1, reason: 'damaged', clientRef: ref() });
    expect((await get(s.app, `/stock-losses/${dl.id}/correct-check`)).body).toMatchObject({ eligible: false, code: 'CORRECTION_NOT_SUPPORTED' });
    for (const path of ['correct-preview', 'correct']) {
      const r = await post(s.app, `/stock-losses/${dl.id}/${path}`, rep);
      expect([r.status, r.body.error.code]).toEqual([409, 'CORRECTION_NOT_SUPPORTED']);
    }
    const v = await post(s.app, `/stock-losses/${dl.id}/void`, { reason: 'x' });
    expect(v.body.error.code).toBe('DAMAGED_RETURN_LOSS');
    expect(fingerprint(s.ctx)).toBe(fp);
  });
});

describe('Ice Cream payment correction', () => {
  it('keeps the three funds, the Ice Cream cash book and the fund ledger equal; the answer carries funds', async () => {
    const s = await setup();
    await dayOk(s, { businessDate: daysAgo(10) });
    const pay = await payOk(s, 'materials', rs(100), { businessDate: daysAgo(5) });
    const r = await post(s.app, `/icecream/payments/${pay.id}/correct`, body('typo', { kind: 'materials', fund: 'cost', amountCents: rs(120), description: 'Materials', clientRef: ref() }));
    expect(r.status).toBe(201);
    expect(r.body.funds.reconciled).toBe(true);
    expect(r.body.funds.funds.cost.balanceCents).toBe((await fundsGet(s)).body.funds.cost.balanceCents);
    await expectBooksAgree(s);
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('the replacement may change kind and fund; a huge replacement warns (cash and fund negative) but is not blocked', async () => {
    const s = await setup();
    await openNew(s, 'icecream', { businessDate: daysAgo(40), fund: 'cost', amountCents: rs(500) });
    const pay = await payOk(s, 'materials', rs(10), { businessDate: daysAgo(5) });
    const bill = await post(s.app, `/icecream/payments/${pay.id}/correct`, body('it was the bill', { kind: 'electricity_bill', fund: 'electricity', amountCents: rs(900), description: 'Bill', clientRef: ref() }));
    expect(bill.status).toBe(201);
    expect(bill.body.replacement).toMatchObject({ kind: 'electricity_bill', fund: 'electricity', pnlTreatment: 'settlement' });
    const codes = bill.body.warnings.map((w: any) => w.code);
    expect(codes).toContain('NEGATIVE_FUND_BALANCE');
    const big = await post(s.app, `/icecream/payments/${bill.body.replacement.id}/correct`, body('again', { kind: 'other_cost', fund: 'cost', amountCents: rs(90_000), description: 'Huge', clientRef: ref() }));
    expect(big.status).toBe(201);
    expect(big.body.warnings.map((w: any) => w.code)).toEqual(expect.arrayContaining(['NEGATIVE_CASH_BALANCE']));
    await expectBooksAgree(s);
  });

  it('E4: an "electricity" category on the replacement is refused in every spelling, nothing changes', async () => {
    const s = await setup();
    await openNew(s, 'icecream', { businessDate: daysAgo(40), fund: 'cost', amountCents: rs(500) });
    const pay = await payOk(s, 'other_cost', rs(10), { businessDate: daysAgo(5) });
    const fp = fingerprint(s.ctx);
    for (const category of ['Electricity', '  ELECTRICITY ', 'electricity']) {
      for (const path of ['correct-preview', 'correct']) {
        const r = await post(s.app, `/icecream/payments/${pay.id}/${path}`, body('x', { kind: 'other_cost', fund: 'cost', amountCents: rs(5), category, description: 'x', clientRef: ref() }));
        expect([r.status, r.body.error.code]).toEqual([400, 'ELECTRICITY_NOT_ALLOWED']);
      }
    }
    expect(fingerprint(s.ctx)).toBe(fp);
  });
});

describe('Ice Cream fund move correction', () => {
  const baseDay = (s: ApiBase) => dayOk(s, { businessDate: daysAgo(20), salesCents: rs(1000), costAllocCents: rs(600), electricityAllocCents: rs(100) });

  it('D2: correcting a re-allocation is refused VOID_BREAKS_RELEASE while a release depends on it; nothing changes', async () => {
    const s = await setup();
    await baseDay(s);
    const re = await moveOk(s, 'profit', 'cost', rs(200), { businessDate: daysAgo(10) });
    await moveOk(s, 'cost', 'profit', rs(800), { businessDate: daysAgo(9) });
    const fp = fingerprint(s.ctx);
    const rep = body('typo', { fromFund: 'profit', toFund: 'cost', amountCents: rs(100), clientRef: ref() });
    expect((await get(s.app, `/icecream/fund-moves/${re.id}/correct-check`)).body).toMatchObject({ eligible: false, code: 'VOID_BREAKS_RELEASE' });
    for (const path of ['correct-preview', 'correct']) {
      const r = await post(s.app, `/icecream/fund-moves/${re.id}/${path}`, rep);
      expect([r.status, r.body.error.code]).toEqual([422, 'VOID_BREAKS_RELEASE']);
    }
    expect(fingerprint(s.ctx)).toBe(fp);
  });

  it('a release can always be corrected (D2 only protects what released profit depends on) and the funds stay equal', async () => {
    const s = await setup();
    await baseDay(s);
    const rel = await moveOk(s, 'cost', 'profit', rs(500), { businessDate: daysAgo(10) });
    const r = await post(s.app, `/icecream/fund-moves/${rel.id}/correct`, body('less', { fromFund: 'cost', toFund: 'profit', amountCents: rs(300), clientRef: ref() }));
    expect(r.status).toBe(201);
    expect(r.body.replacement).toMatchObject({ kind: 'release', profitEffectCents: rs(300) });
    expect(r.body.funds.reconciled).toBe(true);
    await expectBooksAgree(s);
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('D4: a replacement release above the limit needs the owner\'s split confirmation (409, nothing saved); with it the correction is posted', async () => {
    const s = await setup();
    await openNew(s, 'icecream', { businessDate: daysAgo(40), fund: 'cost', amountCents: rs(5000) });
    const m = await moveOk(s, 'cost', 'electricity', rs(10), { businessDate: daysAgo(10) });
    const fp = fingerprint(s.ctx);
    const rep = { fromFund: 'cost', toFund: 'profit', amountCents: rs(5000), clientRef: ref() };
    const need = await post(s.app, `/icecream/fund-moves/${m.id}/correct`, body('release', rep));
    expect([need.status, need.body.error.code]).toEqual([409, 'SPLIT_CONFIRMATION_REQUIRED']);
    expect(need.body.error.profitEligibleCents).toBe(0);
    expect(fingerprint(s.ctx)).toBe(fp);
    const ok = await post(s.app, `/icecream/fund-moves/${m.id}/correct`, body('release', { ...rep, confirmSplit: true, confirmedProfitEligibleCents: 0 }));
    expect(ok.status).toBe(201);
    expect(ok.body.replacement).toMatchObject({ cashOnlyCents: rs(5000) });
    await expectBooksAgree(s);
  });

  it('fund-negative: the replacement may take a fund below zero with a warning only', async () => {
    const s = await setup();
    await openNew(s, 'icecream', { businessDate: daysAgo(40), fund: 'cost', amountCents: rs(500) });
    const m = await moveOk(s, 'cost', 'electricity', rs(10), { businessDate: daysAgo(10) });
    const r = await post(s.app, `/icecream/fund-moves/${m.id}/correct`, body('wrong way', { fromFund: 'electricity', toFund: 'cost', amountCents: rs(50), clientRef: ref() }));
    expect(r.status).toBe(201);
    expect(r.body.warnings.map((w: any) => w.code)).toContain('NEGATIVE_FUND_BALANCE');
    expect(r.body.funds.funds.electricity.balanceCents).toBe(-rs(50));
    await expectBooksAgree(s);
  });
});
