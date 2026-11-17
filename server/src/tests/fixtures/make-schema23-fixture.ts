// Generates the FROZEN schema-23 populated database used by phase26-segment-migration.test.ts (the independent source of the
// "upgrade a populated database" test). It must be run on a commit whose latest migration is 023 (before migration 024 exists); the output
// files are committed and never regenerated. From the repo root:  node --import ./server/src/tests/fixtures/no-vitest.mjs server/src/tests/fixtures/make-schema23-fixture.ts
// Outputs: schema23-world.db (one self-contained file: journal_mode DELETE, WAL checkpointed) and schema23-world.figures.json (key figures).

import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../../app.ts';
import { apiBase, buy, mkTelecom } from '../helpers/inventory.ts';
import { get, post } from '../helpers/catalog.ts';
import { buildWorld14, must, rs } from '../helpers/phase14.ts';
import { clc, cl, returnOk, rl, sellOk, voidSaleNew } from '../helpers/phase5.ts';
import { closeNew, countNew, expNew } from '../helpers/phase8.ts';
import { capNew, drawCash, tr } from '../helpers/phase9.ts';
import { ez, rel, topProvider, topWallet } from '../helpers/phase6.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'viman-fixture-'));
const { app, ctx } = await buildApp({ dataDir, webDistDir: null, logger: false });
const version = (ctx.database.conn.prepare('SELECT MAX(version) v FROM schema_migrations').get() as any).v;
if (Number(version) !== 23) throw new Error(`fixture must be generated at schema version 23, found ${version}`);

const s = await apiBase({ app, ctx });
const w = await buildWorld14(s);
const on = (md: string) => ({ businessDate: `2025-${md}` });

// ---- extra Telecom activity on top of the Phase 14 world (all dated 2025-09-13, after the world's last date) ----
const K2 = (await mkTelecom(s, { name: 'Scratch card 50', sellPriceCents: rs(50), minPriceCents: 100 })).id;
await buy(s, [{ productId: K2, packs: 1, packSize: 100, lineTotalCents: rs(4000) }], on('09-13'));
const t4 = (await sellOk(s, [clc(K2, 10, rs(50), rs(45))], on('09-13'))).sales[0];
await returnOk(s, t4.id, [rl(t4.items[0].id, 2, true)], on('09-13')); // card return (resalable)
const t5 = (await sellOk(s, [cl(K2, 5, rs(50))], on('09-13'))).sales[0];
await must(await voidSaleNew(s, t5.id), 'void card sale'); // card sale void
const pv = await buy(s, [{ productId: K2, packs: 1, packSize: 10, lineTotalCents: rs(450) }], on('09-13'));
await must(await post(app, `/purchases/${pv.id}/void`, { reason: 'wrong supplier' }), 'void card purchase');
await must(await rel(s, w.prov.Airtel!, rs(3000), on('09-13')), 'reload airtel 2');
await must(await ez(s, rs(1000), on('09-13')), 'ezcash 3');
await must(await topWallet(s, rs(500), on('09-13')), 'wallet 2');
await must(await topProvider(s, w.prov.Hutch!, rs(700), on('09-13')), 'topup hutch');
await must(await expNew(s, { ...on('09-13'), book: 'telecom', category: 'internet', amountCents: rs(900) }), 'telecom expense');
await must(await capNew(s, { ...on('09-13'), book: 'telecom', amountCents: rs(2000) }), 'telecom capital');
await must(await drawCash(s, { ...on('09-13'), book: 'telecom', amountCents: rs(400) }), 'telecom drawing');
await must(await tr(s, 'shop', 'telecom', rs(1500), on('09-13')), 'transfer shop>telecom');
const books = (await get(app, '/cashbooks')).body;
const list: any[] = books.items ?? books.books ?? books;
const telBal = Number(list.find((b: any) => b.book === 'telecom').balanceCents);
await must(await countNew(s, 'telecom', telBal - 100, { ...on('09-13'), note: 'Short by one rupee' }), 'telecom count');
await must(await closeNew(s, 'telecom', '2025-09-13'), 'close telecom day');

// ---- key figures through the API ----
const q = 'from=2025-08-01&to=2025-09-30&granularity=month';
const figures = {
  schemaVersion: 23,
  cashbooks: (await get(app, '/cashbooks')).body,
  pnlTelecom: (await get(app, `/reports/pnl/telecom?${q}`)).body,
  pnlShop: (await get(app, `/reports/pnl/shop?${q}`)).body,
  pnlIcecream: (await get(app, `/reports/pnl/icecream?${q}`)).body,
  pnlCombined: (await get(app, `/reports/pnl/combined?${q}`)).body,
  valuation: (await get(app, '/reports/inventory/valuation')).body,
  dashboard: (await get(app, '/dashboard?asOf=2025-09-14')).body,
};

await app.close();
const dbFile = join(dataDir, 'viman.db');
const c = new DatabaseSync(dbFile);
c.exec('PRAGMA wal_checkpoint(TRUNCATE)');
c.exec('PRAGMA journal_mode = DELETE');
c.close();
copyFileSync(dbFile, join(here, 'schema23-world.db'));
writeFileSync(join(here, 'schema23-world.figures.json'), JSON.stringify(figures, null, 2) + '\n');
rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
console.log('written', join(here, 'schema23-world.db'));
