// PHASE 23 - correcting a cash TRANSFER: both legs stay balanced, BOTH books' closed days decide, and the transfer rules (SAME_BOOK,
// Ice Cream funds 10.2/10.7) apply to the replacement exactly as to a new transfer (the existing create is what runs).

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { post } from './helpers/catalog.ts';
import { apiBase, daysAgo, ref } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { sql } from './helpers/phase4.ts';
import { closeOk } from './helpers/phase8.ts';
import { iceInvariant, legsOf, seedBooks, state, tr } from './helpers/phase9.ts';
import { allProblems, fingerprint } from './helpers/phase23.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const D = (n: number) => daysAgo(n);

async function world(): Promise<ApiBase> {
  const s = await apiBase(await env.build());
  await seedBooks(s, { shop: 1_000_000, telecom: 1_000_000, cost: 1_000_000, electricity: 1_000_000, profit: 1_000_000 }, D(10));
  return s;
}
const fix = (s: ApiBase, id: number, replacement: Record<string, unknown>) =>
  post(s.app, `/cash-transfers/${id}/correct`, { reason: 'wrong books', replacement: { clientRef: ref(), ...replacement } });

/** Every transfer's legs (originals and reversals together) net to zero; the live out-leg of a posted transfer is minus its amount, of a void one zero. */
function legsBalanced(s: ApiBase): void {
  for (const t of sql(s, 'SELECT id, status, amount_cents FROM cash_transfers')) {
    const legs = legsOf(s, t.id as number);
    expect(legs.reduce((a, l) => a + Number(l.amount_cents), 0), `transfer ${t.id} net`).toBe(0);
    const out = legs.filter((l) => l.type === 'transfer_out').reduce((a, l) => a + Number(l.amount_cents), 0);
    expect(out, `transfer ${t.id} out`).toBe(t.status === 'void' ? 0 : -Number(t.amount_cents));
  }
}

describe('correct a transfer: legs and books', () => {
  it('Shop -> Telecom 10,000 corrected to Telecom -> Ice Cream (Electricity fund) 6,000: both old legs reversed, both new legs written, balanced', async () => {
    const s = await world();
    const o = (await tr(s, 'shop', 'telecom', 10_000, { businessDate: D(2) })).body.item;
    expect(state(s)).toMatchObject({ shop: 990_000, telecom: 1_010_000 });
    // Phase 26 (13D): the original's Telecom side was the receiving one, so the new Telecom source must name its segment
    const noSeg = await fix(s, o.id, { fromBook: 'telecom', toBook: 'icecream', toFund: 'electricity', amountCents: 6_000 });
    expect([noSeg.status, noSeg.body.error.code]).toEqual([400, 'SEGMENT_REQUIRED']);
    const r = await fix(s, o.id, { fromBook: 'telecom', fromSegment: 'dialog_reloads', toBook: 'icecream', toFund: 'electricity', amountCents: 6_000 });
    expect(r.status).toBe(201);
    expect(r.body.original).toMatchObject({ id: o.id, status: 'void', voidReason: 'wrong books' });
    expect(r.body.replacement).toMatchObject({ fromBook: 'telecom', toBook: 'icecream', fromFund: null, toFund: 'electricity', businessDate: D(2) });
    expect(state(s)).toMatchObject({ shop: 1_000_000, telecom: 994_000, icecream: 3_006_000, electricity: 1_006_000, cost: 1_000_000, profit: 1_000_000 });
    expect(legsOf(s, o.id)).toHaveLength(4); // 2 original + 2 reversals
    expect(legsOf(s, r.body.replacement.id)).toHaveLength(2);
    expect(r.body.warnings).toEqual([]);
    legsBalanced(s);
    const inv = iceInvariant(s);
    expect(inv.funds).toBe(inv.book);
    expect(inv.fundRows).toBe(inv.cashRows);
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('an Ice Cream source fund can be corrected to another fund; the fund rows follow', async () => {
    const s = await world();
    const o = (await tr(s, 'icecream', 'shop', 4_000, { fromFund: 'profit', businessDate: D(2) })).body.item;
    const r = await fix(s, o.id, { fromBook: 'icecream', fromFund: 'cost', toBook: 'shop', amountCents: 4_000 });
    expect(r.status).toBe(201);
    expect(state(s)).toMatchObject({ cost: 996_000, profit: 1_000_000, icecream: 2_996_000, shop: 1_004_000 });
    const inv = iceInvariant(s);
    expect([inv.funds, inv.fundRows]).toEqual([inv.book, inv.cashRows]);
    legsBalanced(s);
    expect(allProblems(s.ctx)).toEqual([]);
  });

  it('a transfer is not profit: no P&L table changes when a transfer is corrected', async () => {
    const s = await world();
    const o = (await tr(s, 'shop', 'icecream', 5_000, { toFund: 'profit' })).body.item;
    const tables = ['sales', 'expenses', 'stock_movements', 'purchases'];
    const snap = () => tables.map((t) => sql(s, `SELECT COUNT(*) AS n FROM ${t}`)[0]!.n);
    const before = snap();
    await fix(s, o.id, { fromBook: 'shop', toBook: 'icecream', toFund: 'cost', amountCents: 5_000 });
    expect(snap()).toEqual(before);
  });
});

describe('correct a transfer: transfer rules still apply to the replacement', () => {
  it('SAME_BOOK, FUND_REQUIRED (Ice Cream side without a fund) and FUND_NOT_ALLOWED (fund on Shop/Telecom) are refused, nothing changes', async () => {
    const s = await world();
    const o = (await tr(s, 'shop', 'telecom', 1_000)).body.item;
    const fp = fingerprint(s.ctx);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ fromBook: 'shop', toBook: 'shop', amountCents: 5 }, 'SAME_BOOK'],
      [{ fromBook: 'shop', toBook: 'icecream', amountCents: 5 }, 'FUND_REQUIRED'],
      [{ fromBook: 'icecream', toBook: 'shop', amountCents: 5 }, 'FUND_REQUIRED'],
      [{ fromBook: 'shop', toBook: 'telecom', toFund: 'cost', amountCents: 5 }, 'FUND_NOT_ALLOWED'],
      [{ fromBook: 'shop', fromFund: 'cost', toBook: 'telecom', amountCents: 5 }, 'FUND_NOT_ALLOWED'],
    ];
    for (const [body, code] of cases) {
      const r = await fix(s, o.id, body);
      expect([r.status, r.body.error.code], code).toEqual([400, code]);
      expect(fingerprint(s.ctx)).toBe(fp);
    }
  });

  it('negative cash stays a warning: the source book (and its fund) going below zero never blocks the correction', async () => {
    const s = await world();
    const o = (await tr(s, 'shop', 'telecom', 1_000)).body.item;
    const big = await fix(s, o.id, { fromBook: 'shop', toBook: 'telecom', amountCents: 5_000_000 });
    expect(big.status).toBe(201);
    expect(big.body.warnings.some((w: any) => w.code === 'NEGATIVE_CASH_BALANCE' && w.book === 'shop')).toBe(true);
    const o2 = (await tr(s, 'icecream', 'shop', 1_000, { fromFund: 'cost' })).body.item;
    const fund = await fix(s, o2.id, { fromBook: 'icecream', fromFund: 'cost', toBook: 'shop', amountCents: 9_000_000 });
    expect(fund.status).toBe(201);
    expect(fund.body.warnings.some((w: any) => w.code === 'NEGATIVE_FUND_BALANCE' && w.fund === 'cost')).toBe(true);
    expect(allProblems(s.ctx)).toEqual([]);
  });
});

describe('correct a transfer: both books\' closed days decide', () => {
  for (const closed of ['shop', 'telecom'] as const) {
    it(`original on a day closed in the ${closed} book (either side of the transfer): refused DAY_CLOSED, unchanged`, async () => {
      const s = await world();
      const o = (await tr(s, 'shop', 'telecom', 1_000, { businessDate: D(4) })).body.item;
      await closeOk(s, closed, D(4));
      const fp = fingerprint(s.ctx);
      const r = await fix(s, o.id, { fromBook: 'shop', toBook: 'telecom', amountCents: 2_000 });
      expect([r.status, r.body.error.code]).toEqual([409, 'DAY_CLOSED']);
      expect(fingerprint(s.ctx)).toBe(fp);
    });

    it(`replacement dated on / before a closed day of the ${closed} book: refused by the create, original stays posted`, async () => {
      const s = await world();
      const o = (await tr(s, 'shop', 'telecom', 1_000, { businessDate: D(1) })).body.item;
      await closeOk(s, closed, D(3));
      const fp = fingerprint(s.ctx);
      const onDay = await fix(s, o.id, { fromBook: 'shop', toBook: 'telecom', amountCents: 2_000, businessDate: D(3) });
      expect([onDay.status, onDay.body.error.code]).toEqual([409, 'DAY_CLOSED']);
      const before = await fix(s, o.id, { fromBook: 'shop', toBook: 'telecom', amountCents: 2_000, businessDate: D(4) });
      expect([before.status, before.body.error.code]).toEqual([409, 'BACKDATE_BEFORE_CLOSED_DAY']);
      expect(fingerprint(s.ctx)).toBe(fp);
      expect(sql(s, 'SELECT status FROM cash_transfers WHERE id = ?', o.id)[0]!.status).toBe('posted');
    });
  }

  it('a closed day of a book the NEW transfer touches refuses it, even if the original books were open', async () => {
    const s = await world();
    const o = (await tr(s, 'shop', 'telecom', 1_000, { businessDate: D(1) })).body.item;
    await closeOk(s, 'icecream', D(3));
    const fp = fingerprint(s.ctx);
    const r = await fix(s, o.id, { fromBook: 'shop', toBook: 'icecream', toFund: 'cost', amountCents: 1_000, businessDate: D(3) });
    expect([r.status, r.body.error.code]).toEqual([409, 'DAY_CLOSED']);
    expect(fingerprint(s.ctx)).toBe(fp);
    const ok = await fix(s, o.id, { fromBook: 'shop', toBook: 'icecream', toFund: 'cost', amountCents: 1_000 }); // default date D(1) is open
    expect(ok.status).toBe(201);
    legsBalanced(s);
  });
});
