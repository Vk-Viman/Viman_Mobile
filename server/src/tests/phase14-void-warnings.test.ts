// Phase 14 - R13 on voids: voiding a sale, a print sale, a reload sale or an EZCash sale takes cash OUT of a book, so the void
// returns the shared non-blocking `warnings` (cash-warnings.ts), computed after the reversal in the same transaction.
// The void always succeeds; with enough cash left the array is empty. Money in cents; hand calculations are in the comments.

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { cashBal, cl, sellOk, voidSaleNew } from './helpers/phase5.ts';
import { mkProduct } from './helpers/inventory.ts';
import { stocked } from './helpers/phase5.ts';
import { providerIds, ez, ezVoid, rel, relVoid } from './helpers/phase6.ts';
import { psNew, psVoid } from './helpers/phase7.ts';
import { bookBal, expNew, openNew } from './helpers/phase8.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const setup = async (): Promise<ApiBase> => apiBase(await env.build());

const warn = (book: string, balanceCents: number, shown: string) => ({
  code: 'NEGATIVE_CASH_BALANCE', book, balanceCents,
  message: `The ${book === 'shop' ? 'Shop' : 'Telecom'} cash book is now below zero (${shown}). Check that the opening balance and sales are recorded.`,
});

describe('R13 warnings on voids of cash-in records', () => {
  // Hand calculation (shop): purchase 10 units for 300,000 -> cash -300,000. Sale of 4 @ 100,000 -> +400,000 = 100,000.
  // Expense 150,000 -> -50,000. Void of the sale removes 400,000 -> -450,000 (below zero).
  it('sale void: saved, with the shop warning when the book ends below zero', async () => {
    const s = await setup();
    const P = await stocked(s, mkProduct, 10, 300000, { minPriceCents: 0 });
    const sale = (await sellOk(s, [cl(P.id, 4, 100000)])).sales[0];
    expect(cashBal(s, 'shop')).toBe(100000);
    expect((await expNew(s, { amountCents: 150000 })).status).toBe(201);
    expect(cashBal(s, 'shop')).toBe(-50000);

    const r = await voidSaleNew(s, sale.id);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(['item', 'warnings']);
    expect(r.body.item.status).toBe('void');
    expect(r.body.warnings).toEqual([warn('shop', -450000, '-Rs. 4,500.00')]);
    expect(cashBal(s, 'shop')).toBe(-450000);
  });

  // Opening balance 1,000,000 - purchase 300,000 = 700,000; sale +400,000 = 1,100,000; void -400,000 = 700,000 (>= 0).
  it('sale void: no warning (empty array) while the book stays at or above zero', async () => {
    const s = await setup();
    await openNew(s, 'shop', { amountCents: 1000000 });
    const P = await stocked(s, mkProduct, 10, 300000, { minPriceCents: 0 });
    const sale = (await sellOk(s, [cl(P.id, 4, 100000)])).sales[0];
    const r = await voidSaleNew(s, sale.id);
    expect(r.status).toBe(200);
    expect(r.body.warnings).toEqual([]);
    expect(bookBal(s, 'shop')).toBe(700000);
  });

  // Print sale: 3 pages BW_1S @ 1,500 = 4,500 in. Expense 10,000 -> -5,500. Void removes 4,500 -> -10,000.
  it('print sale void: warns when the shop book ends below zero; the void still succeeds', async () => {
    const s = await setup();
    const sale = (await psNew(s)).body.item;
    expect(sale.revenueCents).toBe(4500);
    await expNew(s, { amountCents: 10000 });
    const r = await psVoid(s, sale.id);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(['item', 'warnings']);
    expect(r.body.item.status).toBe('void');
    expect(r.body.warnings).toEqual([warn('shop', -10000, '-Rs. 100.00')]);
  });

  // Nothing else touched the book: +4,500 then -4,500 = exactly 0 -> no warning.
  it('print sale void: no warning when the book returns to exactly zero', async () => {
    const s = await setup();
    const sale = (await psNew(s)).body.item;
    const r = await psVoid(s, sale.id);
    expect(r.status).toBe(200);
    expect(r.body.warnings).toEqual([]);
    expect(bookBal(s, 'shop')).toBe(0);
  });

  // Reload: 100,000 collected into Telecom. Telecom expense 150,000 -> -50,000. Void removes 100,000 -> -150,000.
  it('reload sale void: warns when the telecom book ends below zero; the void still succeeds', async () => {
    const s = await setup();
    const ids = await providerIds(s);
    const sale = (await rel(s, ids.Dialog!, 100000)).body.item;
    await expNew(s, { book: 'telecom', amountCents: 150000 });
    expect(bookBal(s, 'telecom')).toBe(-50000);
    const r = await relVoid(s, sale.id);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(['item', 'warnings']);
    expect(r.body.item.status).toBe('void');
    expect(r.body.warnings).toEqual([warn('telecom', -150000, '-Rs. 1,500.00')]);
  });

  it('reload sale void: no warning when the telecom book returns to zero', async () => {
    const s = await setup();
    const ids = await providerIds(s);
    const sale = (await rel(s, ids.Dialog!, 100000)).body.item;
    const r = await relVoid(s, sale.id);
    expect(r.status).toBe(200);
    expect(r.body.warnings).toEqual([]);
  });

  // EZCash: bill total 200,000 in. Telecom expense 250,000 -> -50,000. Void removes 200,000 -> -250,000.
  it('EZCash void: warns when the telecom book ends below zero; the void still succeeds', async () => {
    const s = await setup();
    const sale = (await ez(s, 200000)).body.item;
    await expNew(s, { book: 'telecom', amountCents: 250000 });
    expect(bookBal(s, 'telecom')).toBe(-50000);
    const r = await ezVoid(s, sale.id);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(['item', 'warnings']);
    expect(r.body.item.status).toBe('void');
    expect(r.body.warnings).toEqual([warn('telecom', -250000, '-Rs. 2,500.00')]);
  });

  it('EZCash void: no warning when the telecom book returns to zero', async () => {
    const s = await setup();
    const sale = (await ez(s, 200000)).body.item;
    const r = await ezVoid(s, sale.id);
    expect(r.status).toBe(200);
    expect(r.body.warnings).toEqual([]);
  });
});
