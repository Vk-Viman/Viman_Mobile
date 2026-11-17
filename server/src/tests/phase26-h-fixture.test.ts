// Package H: the frozen schema-23 world, upgraded through migrations 024-026, still produces EXACTLY the old report and dashboard figures; every
// old Telecom row is `legacy`, so the legacy segment block equals the old Telecom total.
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';
import { migrate } from '../db/migrate.ts';
import { loadFacts } from '../repositories/icecream.repo.ts';
import { combinedPnl } from '../services/reports/pnl-combined.ts';
import { telecomPnl } from '../services/reports/pnl-telecom.ts';
import { shopPnl } from '../services/reports/pnl-shop.ts';
import { cashbookReport } from '../services/reports/cashbook-report.ts';
import { segmentLines } from '../services/dashboard-segments.ts';
import { closingsBlock } from '../services/dashboard-closings.ts';

const env = new TestEnv();
const open: DatabaseSync[] = [];
afterEach(async () => { for (const c of open.splice(0)) { try { c.close(); } catch { /* closed */ } } await env.cleanup(); });
const F = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'schema23-world.figures.json'), 'utf8'));

function upgraded(): DatabaseSync {
  const file = join(env.newDir(), 'world.db');
  copyFileSync(join(import.meta.dirname, 'fixtures', 'schema23-world.db'), file);
  const c = new DatabaseSync(file);
  open.push(c);
  c.exec('PRAGMA foreign_keys = ON');
  migrate(c);
  return c;
}
const q = { from: F.pnlTelecom.from, to: F.pnlTelecom.to, granularity: F.pnlTelecom.granularity };
const json = (x: unknown) => JSON.parse(JSON.stringify(x));

describe('report figures after the segment migrations equal the frozen schema-23 figures', () => {
  it('Telecom P&L rows and totals are identical; the legacy block equals the old Telecom total', () => {
    const c = upgraded();
    const r = telecomPnl(c, q);
    expect(json(r.rows)).toEqual(F.pnlTelecom.rows);
    expect(json(r.totals)).toEqual(F.pnlTelecom.totals);
    expect(json(r.table)).toEqual(F.pnlTelecom.table);
    const legacy = r.telecomSegments.at(-1)!;
    expect(legacy.segment).toBe('legacy');
    expect(json(legacy.totals)).toEqual(F.pnlTelecom.totals);
    expect(json(legacy.rows)).toEqual(F.pnlTelecom.rows);
    // no real segment has any figure; the total is the sum of the blocks
    for (const b of r.telecomSegments.filter((x) => x.segment !== 'legacy')) expect(b.totals.netProfitCents).toBe(0);
    expect(r.segmentsMatchTotal).toBe(true);
  });

  it('Shop and Combined P&L are identical', () => {
    const c = upgraded();
    expect(json(shopPnl(c, q).totals)).toEqual(F.pnlShop.totals);
    const comb = combinedPnl(c, q);
    expect(json(comb.rows)).toEqual(F.pnlCombined.rows);
    expect(json(comb.totals)).toEqual(F.pnlCombined.totals);
  });

  it('dashboard tiles and the Telecom cash balance are identical', () => {
    const c = upgraded();
    const facts = loadFacts(c);
    const month = segmentLines(c, facts, [{ from: '2025-09-01', to: F.dashboard.asOf, label: '2025-09' }])[0]!;
    expect(json({ salesCents: month.combined.salesCents, profitCents: month.combined.profitCents, bySegment: { shop: month.shop, telecom: month.telecom, icecream: month.icecream } }))
      .toEqual(F.dashboard.month);
    const tel = cashbookReport(c, 'telecom', { from: '2025-08-01', to: '2025-09-30', granularity: 'month' });
    expect(tel.ledgerBalanceAsOfToCents).toBe(F.cashbooks.books.find((b: { book: string }) => b.book === 'telecom').balanceCents);
    expect(tel.segments!.find((x) => x.segment === 'legacy')!.closingCents).toBe(tel.totals.closingCents);
    expect(tel.warnings).toEqual([]);
  });

  it('the old Telecom closings do not nag: legacy is never listed, the Telecom entry stays one empty line', () => {
    const c = upgraded();
    const tel = closingsBlock(c, F.dashboard.asOf);
    expect(tel.openDaysBehind.filter((x) => x.book === 'telecom')).toEqual([{ book: 'telecom', dates: [] }]);
    expect(tel.lastClosedByBook.telecom).toBe(F.dashboard.closings.lastClosedByBook.telecom);
  });
});
