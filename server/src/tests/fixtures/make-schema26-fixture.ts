// Generates the FROZEN schema-26 populated database used by phase27-migration.test.ts (the independent source of the "upgrade a populated
// database" test for migrations 027 and 028, sales discounts). It must be run on a commit whose latest migration is 026 (before migration 027
// exists); the output files are committed and never regenerated. From the repo root:
//   node --import ./server/src/tests/fixtures/no-vitest.mjs server/src/tests/fixtures/make-schema26-fixture.ts
// Outputs: schema26-world.db (one self-contained file: journal_mode DELETE, WAL checkpointed) and schema26-world.figures.json (key figures).
// The world is the Phase 14 world plus extra activity built through the real HTTP API: Shop goods (several lines, partial and final returns,
// a void, a corrected sale), print / photocopy / other-service sales (some voided, one corrected), Telecom card sales in the Dialog, Airtel,
// Hutch and Mobitel card segments with returns and a void, reloads / EZCash / top-ups, purchases, stock loss, stocktake, expenses, capital,
// drawings, transfers, counts and closed days.

import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../../app.ts';
import { apiBase, buy, cardProduct, mkProduct, ref } from '../helpers/inventory.ts';
import { get, post } from '../helpers/catalog.ts';
import { buildWorld14, must, rs } from '../helpers/phase14.ts';
import { clc, cl, returnOk, rl, sellOk, voidSaleNew } from '../helpers/phase5.ts';
import { closeNew, countNew, expNew } from '../helpers/phase8.ts';
import { capNew, drawCash, tr } from '../helpers/phase9.ts';
import { ez, rel, topProvider, topWallet } from '../helpers/phase6.ts';
import { psNew, psVoid, supNew } from '../helpers/phase7.ts';
import { drawNew, lossNew, stComplete, stDraft } from '../helpers/phase4.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'viman-fixture26-'));
const { app, ctx } = await buildApp({ dataDir, webDistDir: null, logger: false });
const conn = ctx.database.conn;
const version = (conn.prepare('SELECT MAX(version) v FROM schema_migrations').get() as any).v;
if (Number(version) !== 26) throw new Error(`fixture must be generated at schema version 26, found ${version}`);

const s = await apiBase({ app, ctx });
const w = await buildWorld14(s);
const on = (md: string) => ({ businessDate: `2025-${md}` });

// ---- Shop goods (2025-09-13 .. 09-14) ----
const G1 = (await mkProduct(s, { name: 'Power bank', sellPriceCents: rs(3500), minPriceCents: rs(2000) })).id;
const G2 = (await mkProduct(s, { name: 'Screen guard', sellPriceCents: rs(600), minPriceCents: rs(100) })).id;
const G3 = (await mkProduct(s, { name: 'Memory card', sellPriceCents: rs(1800), minPriceCents: rs(900) })).id;
await buy(s, [{ productId: G1, packs: 1, packSize: 12, lineTotalCents: rs(24000) }, { productId: G2, packs: 1, packSize: 50, lineTotalCents: rs(10000) },
  { productId: G3, packs: 1, packSize: 20, lineTotalCents: rs(20000) }], on('09-13'));
const m1 = (await sellOk(s, [cl(G1, 3, rs(3500)), cl(G2, 7, rs(600)), clc(G3, 2, rs(1750), rs(1010))], on('09-13'))).sales[0];
await returnOk(s, m1.id, [rl(m1.items[0].id, 1, true), rl(m1.items[1].id, 2, false)], on('09-13')); // partial returns
const m2 = (await sellOk(s, [cl(G2, 5, rs(600)), cl(G3, 1, rs(1800))], on('09-13'))).sales[0];
await returnOk(s, m2.id, [rl(m2.items[0].id, 3, true)], on('09-13'));
await returnOk(s, m2.id, [rl(m2.items[0].id, 2, true)], on('09-14')); // final return of that line
const m3 = (await sellOk(s, [cl(G1, 2, rs(3300))], on('09-14'))).sales[0];
await must(await voidSaleNew(s, m3.id), 'void goods sale');
const m4 = (await sellOk(s, [cl(G2, 10, rs(600)), cl(G3, 3, rs(1800))], on('09-14'))).sales[0];
await must(await post(app, `/sales/${m4.id}/correct`, { reason: 'wrong quantity', replacement: { items: [cl(G2, 8, rs(600)), cl(G3, 3, rs(1800))], clientRef: ref() } }), 'correct goods sale');
await must(await lossNew(s, G2, 2, { ...on('09-14'), reason: 'damaged' }), 'loss G2');
await must(await drawNew(s, G3, 1, on('09-14')), 'goods drawing G3');
await must(await stComplete(s, (await stDraft(s, [{ productId: G1, countedQty: 8 }], { ...on('09-14'), book: 'shop' })).id), 'stocktake goods');

// ---- print / photocopy / other-service sales ----
await must(await psNew(s, { ...on('09-13'), qty: 25 }, 'PC_BW_1S'), 'photocopy 25');
await must(await psNew(s, { ...on('09-13'), qty: 12 }, 'CLR_2S'), 'colour 2 sided');
const psA = await must(await psNew(s, { ...on('09-13'), qty: 40 }, 'BW_2S'), 'print 40');
await must(await psVoid(s, psA.item.id, 'duplicate entry'), 'void print');
const psB = await must(await psNew(s, { ...on('09-14'), qty: 3, notes: 'Passport form' }, 'CUSTOM'), 'custom service');
await must(await psNew(s, { ...on('09-14'), qty: 60 }, 'PC_BW_2S'), 'photocopy 2 sided');
await must(await post(app, `/print-sales/${psB.item.id}/correct`, { reason: 'wrong count', replacement: { serviceTypeId: psB.item.serviceTypeId, qty: 4, notes: 'Passport form', clientRef: ref() } }), 'correct print');
await must(await supNew(s, { ...on('09-14'), amountCents: rs(2200), description: 'Photocopy paper' }), 'supplies');

// ---- Telecom card sales in several segments (returns, a void) ----
const A1 = (await cardProduct(s, { provider: 'Airtel', name: 'Airtel 100', sellPriceCents: rs(100), minPriceCents: 100 })).id;
const H1 = (await cardProduct(s, { provider: 'Hutch', name: 'Hutch 50', sellPriceCents: rs(50), minPriceCents: 100 })).id;
const M1 = (await cardProduct(s, { provider: 'Mobitel', name: 'Mobitel 200', sellPriceCents: rs(200), minPriceCents: 100 })).id;
await buy(s, [{ productId: A1, packs: 1, packSize: 100, lineTotalCents: rs(9000) }], on('09-13')); // one purchase document per provider
await buy(s, [{ productId: H1, packs: 1, packSize: 100, lineTotalCents: rs(4500) }], on('09-13'));
await buy(s, [{ productId: M1, packs: 1, packSize: 50, lineTotalCents: rs(9000) }], on('09-13'));
const ta = (await sellOk(s, [clc(A1, 20, rs(100), rs(90))], on('09-13'))).sales[0];
await returnOk(s, ta.id, [rl(ta.items[0].id, 4, true)], on('09-13'));
await returnOk(s, ta.id, [rl(ta.items[0].id, 16, true)], on('09-14')); // final return of the Airtel line
const th = (await sellOk(s, [cl(H1, 30, rs(50))], on('09-13'))).sales[0];
await must(await voidSaleNew(s, th.id), 'void hutch cards');
await sellOk(s, [cl(H1, 10, rs(50)), cl(M1, 5, rs(200))], on('09-14'));
const tm = (await sellOk(s, [clc(M1, 6, rs(200), rs(180))], on('09-14'))).sales[0];
await returnOk(s, tm.id, [rl(tm.items[0].id, 2, false)], on('09-14'));
await sellOk(s, [cl(A1, 8, rs(100)), cl(G2, 2, rs(600))], on('09-14')); // one visit: Airtel cards + goods = two sales

// ---- reloads / EZCash / top-ups / expenses / capital / drawings / transfers ----
await must(await rel(s, w.prov.Airtel!, rs(3500), on('09-13')), 'reload airtel');
await must(await rel(s, w.prov.Hutch!, rs(1500), on('09-14')), 'reload hutch');
await must(await ez(s, rs(2000), on('09-13')), 'ezcash');
await must(await topWallet(s, rs(600), on('09-13')), 'wallet');
await must(await topProvider(s, w.prov.Dialog!, rs(900), on('09-14')), 'topup dialog');
await must(await expNew(s, { ...on('09-14'), book: 'telecom', category: 'internet', amountCents: rs(700) }), 'telecom expense');
await must(await expNew(s, { ...on('09-14'), book: 'shop', category: 'cleaning_supplies', amountCents: rs(350) }), 'shop expense');
await must(await capNew(s, { ...on('09-14'), book: 'shop', amountCents: rs(3000) }), 'shop capital');
await must(await drawCash(s, { ...on('09-14'), book: 'shop', amountCents: rs(500) }), 'shop drawing');
await must(await tr(s, 'shop', 'telecom', rs(2000), on('09-14')), 'transfer shop>telecom');

// ---- counts and closed days (last: they block earlier dates) ----
const bal = async (book: string): Promise<number> => Number(((await get(app, '/cashbooks')).body.books as any[]).find((b) => b.book === book).balanceCents);
await must(await countNew(s, 'shop', (await bal('shop')) - 50, { ...on('09-14'), note: 'Short by fifty cents' }), 'shop count');
await must(await closeNew(s, 'shop', '2025-09-14'), 'close shop 09-14');
await must(await closeNew(s, 'telecom', '2025-09-14', { segment: 'airtel_cards' }), 'close airtel cards');

// ---- figures through the API and the raw tables ----
const q = 'from=2025-08-01&to=2025-09-30&granularity=month';
const all = (sql: string): any[] => conn.prepare(sql).all() as any[];
const one = (sql: string): any => all(sql)[0];
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x)));
const figures = {
  schemaVersion: 26,
  cashbooks: (await get(app, '/cashbooks')).body,
  cashByBook: plain(all('SELECT book, COALESCE(SUM(amount_cents),0) AS cents, COUNT(*) AS n FROM cash_entries GROUP BY book ORDER BY book')),
  cashBySegment: plain(all("SELECT book, COALESCE(segment,'') AS segment, COALESCE(SUM(amount_cents),0) AS cents, COUNT(*) AS n FROM cash_entries GROUP BY book, segment ORDER BY book, segment")),
  pnlShop: (await get(app, `/reports/pnl/shop?${q}`)).body,
  pnlTelecom: (await get(app, `/reports/pnl/telecom?${q}`)).body,
  pnlIcecream: (await get(app, `/reports/pnl/icecream?${q}`)).body,
  pnlCombined: (await get(app, `/reports/pnl/combined?${q}`)).body,
  valuation: (await get(app, '/reports/inventory/valuation')).body,
  dashboard: (await get(app, '/dashboard?asOf=2025-09-15')).body,
  saleItems: plain(one(`SELECT COUNT(*) AS n, COALESCE(SUM(qty),0) AS qty, COALESCE(SUM(returned_qty),0) AS returnedQty, COALESCE(SUM(revenue_cents),0) AS revenueCents,
    COALESCE(SUM(cogs_cents),0) AS cogsCents, COALESCE(SUM(extra_cost_cents),0) AS extraCostCents, COALESCE(SUM(unit_price_cents),0) AS unitPriceCents FROM sale_items`)),
  saleItemsByBook: plain(all(`SELECT s.book, COALESCE(s.segment,'') AS segment, s.status, COUNT(*) AS n, SUM(i.qty) AS qty, SUM(i.returned_qty) AS returnedQty,
    SUM(i.revenue_cents) AS revenueCents, SUM(i.cogs_cents) AS cogsCents, SUM(i.extra_cost_cents) AS extraCostCents
    FROM sale_items i JOIN sales s ON s.id = i.sale_id GROUP BY s.book, s.segment, s.status ORDER BY s.book, s.segment, s.status`)),
  printSales: plain(one(`SELECT COUNT(*) AS n, COALESCE(SUM(qty),0) AS qty, COALESCE(SUM(revenue_cents),0) AS revenueCents, COALESCE(SUM(cogs_cents),0) AS cogsCents,
    COALESCE(SUM(unit_price_cents),0) AS unitPriceCents, COALESCE(SUM(unit_cost_cents),0) AS unitCostCents FROM print_sales`)),
  printSalesByStatus: plain(all('SELECT status, COUNT(*) AS n, SUM(qty) AS qty, SUM(revenue_cents) AS revenueCents, SUM(cogs_cents) AS cogsCents FROM print_sales GROUP BY status ORDER BY status')),
  rowCounts: plain(Object.fromEntries(all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((t) => [t.name, Number(one(`SELECT COUNT(*) AS n FROM "${t.name}"`).n)]))),
};

await app.close();
const dbFile = join(dataDir, 'viman.db');
const c = new DatabaseSync(dbFile);
c.exec('PRAGMA wal_checkpoint(TRUNCATE)');
c.exec('PRAGMA journal_mode = DELETE');
c.close();
copyFileSync(dbFile, join(here, 'schema26-world.db'));
writeFileSync(join(here, 'schema26-world.figures.json'), JSON.stringify(figures, null, 2) + '\n');
rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
console.log('written', join(here, 'schema26-world.db'));
