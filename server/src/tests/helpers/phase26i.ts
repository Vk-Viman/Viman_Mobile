// Package I helpers: a Telecom-segment world built ONLY through the HTTP API (so every row is posted by the real services), a way to read
// the same file as a backup, and small readers. New file of package I; the shared helpers are not edited.

import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cardProduct, mkProduct, buy, ref } from './inventory.ts';
import type { ApiBase } from './inventory.ts';
import { post } from './catalog.ts';
import { drawNew, lossNew, stComplete, stDraft } from './phase4.ts';
import { cl, returnOk, rl, sellOk, voidSaleNew } from './phase5.ts';
import { ez, ezVoid, providerIds, rel, relVoid, topProvider, topWallet } from './phase6.ts';
import { expNew, expVoid, openNew, countNew } from './phase8.ts';
import { capNew, drawCash, tr } from './phase9.ts';
import { seg } from './seg.ts';

export interface SegWorld { products: Record<string, number>; sales: Record<string, number>; records: Record<string, number> }

const must = (what: string, r: { status: number; body: any }): any => {
  if (r.status !== 201 && r.status !== 200) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const D = (md: string): { businessDate: string } => ({ businessDate: `2025-${md}` });

/**
 * A rich Telecom world with REAL segments in all eight places: card products of three providers, opening balances, purchases per
 * provider (one voided, one partly returned), a mixed-provider cart (one sale per segment), returns (resalable and damaged), a voided
 * sale, loss, stocktake, goods drawing, reloads / EZCash / top-ups of several providers (some voided), expenses, capital, cash drawing,
 * cash count, transfers (Shop -> Telecom segment, Telecom segment -> Telecom segment, Telecom -> Shop, one voided) and one closing.
 */
export async function buildSegWorld(s: ApiBase): Promise<SegWorld> {
  const ids = await providerIds(s);
  const dd = (await cardProduct(s, { provider: 'Dialog', name: 'Dialog card 100', sellPriceCents: 10000, minPriceCents: 5000 })).id;
  const mm = (await cardProduct(s, { provider: 'Mobitel', name: 'Mobitel card 100', sellPriceCents: 10000, minPriceCents: 5000 })).id;
  const aa = (await cardProduct(s, { provider: 'Airtel', name: 'Airtel card 100', sellPriceCents: 10000, minPriceCents: 5000 })).id;
  const shopP = (await mkProduct(s, { name: 'Shop thing', sellPriceCents: 20000, minPriceCents: 10000 })).id;
  const r: Record<string, number> = {};
  const sales: Record<string, number> = {};

  await seg.seed(s, { dialog_reloads: 5_000_000, dialog_cards: 2_000_000, mobitel_reloads: 1_000_000, mobitel_cards: 2_000_000, airtel_cards: 1_000_000, airtel_reloads: 500_000, hutch_reloads: 500_000 }, '2025-09-10');
  must('shop opening', await openNew(s, 'shop', { ...D('09-10'), amountCents: 3_000_000 }));

  // purchases per provider (each in its own segment), a partly returned one and a voided one
  await buy(s, [{ productId: shopP, packs: 1, packSize: 10, lineTotalCents: 50_000 }], D('09-10'));
  const pd = await buy(s, [{ productId: dd, packs: 1, packSize: 50, lineTotalCents: 400_000 }], D('09-10'));
  const pm = await buy(s, [{ productId: mm, packs: 1, packSize: 50, lineTotalCents: 400_000 }], D('09-10'));
  const pa = await buy(s, [{ productId: aa, packs: 1, packSize: 50, lineTotalCents: 400_000 }], D('09-10'));
  r.purchaseDialog = pd.id; r.purchaseMobitel = pm.id; r.purchaseAirtel = pa.id;
  must('purchase return', await post(s.app, `/purchases/${pm.id}/returns`, { ...D('09-11'), items: [{ purchaseItemId: pm.items[0].id, units: 2 }], clientRef: ref() }));
  must('purchase void', await post(s.app, `/purchases/${pa.id}/void`, { reason: 'wrong bill' }));
  const pa2 = await buy(s, [{ productId: aa, packs: 1, packSize: 20, lineTotalCents: 160_000 }], D('09-10'));
  r.purchaseAirtel2 = pa2.id;

  // a mixed cart (Dialog + Mobitel cards) = two sales, one per segment, then returns and a void
  const mixed = await sellOk(s, [cl(dd, 5, 10000), cl(mm, 4, 10000), cl(shopP, 1, 20000)].slice(0, 2), D('09-11'));
  if (mixed.sales.length !== 2) throw new Error(`a mixed cart must make one sale per segment, got ${mixed.sales.length}`);
  const sDialog = mixed.sales.find((x: any) => x.segment === 'dialog_cards');
  const sMobitel = mixed.sales.find((x: any) => x.segment === 'mobitel_cards');
  sales.dialog = sDialog.id; sales.mobitel = sMobitel.id;
  r.returnResalable = (await returnOk(s, sDialog.id, [rl(sDialog.items[0].id, 1, true)], D('09-12'))).item.id;
  r.returnDamaged = (await returnOk(s, sMobitel.id, [rl(sMobitel.items[0].id, 1, false)], D('09-12'))).item.id;
  const sAir = (await sellOk(s, [cl(aa, 3, 10000)], D('09-11'))).sales[0];
  must('void sale', await voidSaleNew(s, sAir.id));
  sales.airtelVoided = sAir.id;
  await sellOk(s, [cl(shopP, 1, 20000)], D('09-11'));

  // losses, stocktake, goods drawing
  r.loss = must('loss', await lossNew(s, mm, 1, D('09-12'))).item.id;
  const st = await stDraft(s, [{ productId: dd, countedQty: 40 }], { ...D('09-12'), book: 'telecom' });
  must('stocktake', await stComplete(s, st.id));
  r.stocktake = st.id;
  r.goodsDrawing = must('goods drawing', await drawNew(s, mm, 1, D('09-12'))).item.id;

  // reloads, EZCash, top-ups
  r.reloadDialog = must('reload', await rel(s, ids.Dialog!, 100_000, D('09-11'))).item.id;
  r.reloadMobitel = must('reload', await rel(s, ids.Mobitel!, 80_000, D('09-11'))).item.id;
  r.reloadHutch = must('reload', await rel(s, ids.Hutch!, 60_000, D('09-11'))).item.id;
  const reloadAirtel = must('reload', await rel(s, ids.Airtel!, 30_000, D('09-11'))).item.id;
  must('reload void', await relVoid(s, reloadAirtel));
  r.reloadAirtelVoided = reloadAirtel;
  r.ezcash = must('ezcash', await ez(s, 50_000, D('09-11'))).item.id;
  const ezV = must('ezcash', await ez(s, 20_000, D('09-11'))).item.id;
  must('ezcash void', await ezVoid(s, ezV));
  r.topupMobitel = must('topup', await topProvider(s, ids.Mobitel!, 40_000, D('09-12'))).item.id;
  r.topupWallet = must('wallet', await topWallet(s, 25_000, D('09-12'))).item.id;

  // entry-chosen records
  r.expenseAirtel = must('expense', await expNew(s, { ...D('09-12'), book: 'telecom', category: 'internet', segment: 'airtel_reloads', amountCents: 5_000 })).item.id;
  const expV = must('expense', await expNew(s, { ...D('09-12'), book: 'telecom', category: 'repairs', segment: 'dialog_cards', amountCents: 3_000 })).item.id;
  must('expense void', await expVoid(s, expV));
  r.expenseDialogCardsVoided = expV;
  r.capital = must('capital', await capNew(s, { ...D('09-12'), book: 'telecom', segment: 'mobitel_reloads', amountCents: 100_000 })).item.id;
  r.cashDrawing = must('cash drawing', await drawCash(s, { ...D('09-12'), book: 'telecom', segment: 'hutch_reloads', amountCents: 10_000 })).item.id;
  r.count = must('count', await countNew(s, 'telecom', 4_000_000, { ...D('09-12'), segment: 'dialog_reloads', note: 'counted by the owner' })).item.id;
  r.transferIn = must('transfer', await tr(s, 'shop', 'telecom', 200_000, { ...D('09-12'), toSegment: 'mobitel_cards' })).item.id;
  r.transferInside = must('transfer', await tr(s, 'telecom', 'telecom', 150_000, { ...D('09-12'), fromSegment: 'dialog_reloads', toSegment: 'hutch_reloads' })).item.id;
  r.transferOut = must('transfer', await tr(s, 'telecom', 'shop', 20_000, { ...D('09-12'), fromSegment: 'airtel_cards' })).item.id;
  const trV = must('transfer', await tr(s, 'shop', 'telecom', 30_000, { ...D('09-12'), toSegment: 'airtel_reloads' })).item.id;
  must('transfer void', await post(s.app, `/cash-transfers/${trV}/void`, { reason: 'typo' }));
  r.transferVoided = trV;

  // one closed day for one segment
  await seg.closeOk(s, 'hutch_reloads', '2025-09-13');
  return { products: { dd, mm, aa, shopP }, sales, records: r };
}

/** A DatabaseSync on a file; the caller closes it. */
export const openFile = (p: string): DatabaseSync => new DatabaseSync(p);

/** Fresh private work folder for corrupted copies (remove it in afterAll). */
export function workFolder(prefix = 'viman-p26i-'): string { return mkdtempSync(join(tmpdir(), prefix)); }
export const removeFolder = (p: string): void => rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
export { copyFileSync, mkdirSync };
