// Package H: per-segment Telecom reports on raw-SQL data in real segments (13D). Hand-calculated figures; Total = sum of the segments for every field;
// cash book per segment; transfers between segments net zero in the Telecom total; Excel export tables; segment filters of the operational reports.
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { MAKE, cardProduct, freshDb, providerId } from './helpers/phase26db.ts';
import { sqlSale, sqlSaleItem } from './helpers/phase5.ts';
import { telecomPnl, figuresEqualSum } from '../services/reports/pnl-telecom.ts';
import { cashbookReport } from '../services/reports/cashbook-report.ts';
import { transfersReport } from '../services/reports/transfers-report.ts';
import { drawingsReport } from '../services/reports/drawings-report.ts';
import { salesReport } from '../services/reports/sales-report.ts';
import { backdatedReport } from '../services/reports/backdated-report.ts';
import { closingsBlock } from '../services/dashboard-closings.ts';
import { exportPackTables } from '../services/dashboard-export.ts';

const D1 = '2025-03-10';
const D2 = '2025-03-12';
const Q = { from: '2025-03-01', to: '2025-03-31', granularity: 'month' as const };

/** A posted cash count with the given over (+) / short (-) difference (counted = expected + difference). */
function count(c: DatabaseSync, segment: string, date: string, diff: number): void {
  MAKE.cash_counts!(c, { book: 'telecom', segment, business_date: date, expected_cents: 1000, counted_cents: 1000 + diff, difference_cents: diff, note: 'test' });
}

function world(): DatabaseSync {
  const c = freshDb();
  const mob = providerId(c, 'Mobitel');
  // Dialog Reloads: commission 650 (base 600 + extra 50) + EZCash 80 - expense 200 - short 30 = 500
  MAKE.reload_sales!(c, { segment: 'dialog_reloads', business_date: D1, commission_cents: 650, extra_cents: 50 });
  MAKE.ezcash_sales!(c, { segment: 'dialog_reloads', business_date: D1, commission_cents: 80 });
  MAKE.expenses!(c, { book: 'telecom', segment: 'dialog_reloads', business_date: D1, category: 'internet', amount_cents: 200 });
  count(c, 'dialog_reloads', D1, -30);
  MAKE.telecom_topups!(c, { segment: 'dialog_reloads', business_date: D1, kind: 'provider_topup', provider_id: providerId(c, 'Dialog'), amount_cents: 7000 });
  // Mobitel Reloads: commission 900 - expense 100 + over 20 = 820
  MAKE.reload_sales!(c, { segment: 'mobitel_reloads', provider_id: mob, business_date: D1, commission_bp: 900, commission_cents: 900 });
  MAKE.expenses!(c, { book: 'telecom', segment: 'mobitel_reloads', business_date: D2, category: 'rent', amount_cents: 100 });
  count(c, 'mobitel_reloads', D2, 20);
  // Dialog Cards: 10,000 - 6,000 - 100 = 3,900 - loss 500 - expense 300 - short 10 = 3,090
  const dp = cardProduct(c, 'Dialog');
  const s1 = sqlSale(c, { book: 'telecom', segment: 'dialog_cards', date: D1, total: 10000 });
  sqlSaleItem(c, s1, dp, { qty: 2, price: 5000, cogs: 6000, extra: 100 });
  MAKE.stock_losses!(c, { book: 'telecom', segment: 'dialog_cards', product_id: dp, business_date: D2, cost_cents: 500 });
  MAKE.expenses!(c, { book: 'telecom', segment: 'dialog_cards', business_date: D2, category: 'other', amount_cents: 300 });
  count(c, 'dialog_cards', D2, -10);
  // Airtel Cards: 2,000 - 1,500 = 500
  const ap = cardProduct(c, 'Airtel');
  const s2 = sqlSale(c, { book: 'telecom', segment: 'airtel_cards', date: D2, total: 2000 });
  sqlSaleItem(c, s2, ap, { qty: 1, price: 2000, cogs: 1500 });
  // cash entries per segment
  for (const [seg, amounts] of [['dialog_reloads', [10000, -2500]], ['mobitel_reloads', [4000]], ['dialog_cards', [8000, -1000]], ['airtel_cards', [3000]]] as const) {
    for (const a of amounts) MAKE.cash_entries!(c, { book: 'telecom', segment: seg, business_date: D1, amount_cents: a });
  }
  MAKE.cash_entries!(c, { book: 'telecom', segment: 'dialog_reloads', business_date: '2025-02-20', amount_cents: 500 }); // before the range: opening
  MAKE.cash_entries!(c, { book: 'shop', business_date: D1, amount_cents: 999 });
  return c;
}

describe('Telecom P&L by segment', () => {
  it('hand-calculated figures per segment, and the Total is the sum of the segments for every field', () => {
    const c = world();
    const r = telecomPnl(c, Q);
    const net = (code: string) => r.telecomSegments.find((b) => b.segment === code)!.totals.netProfitCents;
    expect(net('dialog_reloads')).toBe(500);
    expect(net('mobitel_reloads')).toBe(820);
    expect(net('dialog_cards')).toBe(3090);
    expect(net('airtel_cards')).toBe(500);
    expect(net('hutch_cards')).toBe(0);
    expect(r.totals.netProfitCents).toBe(4910);
    expect(r.telecomSegments.map((b) => b.segment)).toEqual(['dialog_cards', 'dialog_reloads', 'mobitel_cards', 'mobitel_reloads', 'airtel_cards', 'airtel_reloads', 'hutch_cards', 'hutch_reloads']);
    const dr = r.telecomSegments.find((b) => b.segment === 'dialog_reloads')!.totals;
    expect(dr.commissions.reloadCommissionCents).toBe(650);
    expect(dr.commissions.reloadExtraCents).toBe(50);
    expect(dr.commissions.reloadBaseCommissionCents).toBe(600);
    expect(dr.commissions.ezcashCommissionCents).toBe(80);
    expect(dr.memo.providerTopupsCents).toBe(7000);
    const dc = r.telecomSegments.find((b) => b.segment === 'dialog_cards')!.totals;
    expect(dc.cards).toMatchObject({ revenueCents: 10000, costAutomaticCents: 6000, costExtraCents: 100, grossProfitCents: 3900 });
    expect(dc.adjustments.lossesCents).toBe(500);
    expect(dc.expenses.byCategory.other).toBe(300);
    expect(r.segmentsMatchTotal).toBe(true);
    expect(figuresEqualSum(r.totals, r.telecomSegments.map((b) => b.totals))).toBe(true);
    // the filtered report is that segment's figures; the unchanged rows/totals/table are the whole book
    const f = telecomPnl(c, Q, 'mobitel_reloads');
    expect(f.totals.netProfitCents).toBe(820);
    expect(f.telecomSegments).toHaveLength(1);
    expect(r.table.totals!.netProfit).toBe(4910);
    // day granularity: still additive per row
    const days = telecomPnl(c, { ...Q, granularity: 'day' });
    expect(days.segmentsMatchTotal).toBe(true);
    expect(days.rows.reduce((s, x) => s + x.netProfitCents, 0)).toBe(4910);
    // legacy appears only with activity
    expect(r.telecomSegments.some((b) => b.segment === 'legacy')).toBe(false);
  });

  it('the by-segment table has lines x segments + total', () => {
    const t = telecomPnl(world(), Q).segmentTable;
    expect(t.columns.map((x) => x.key)).toEqual(['line', 'dialog_cards', 'dialog_reloads', 'mobitel_cards', 'mobitel_reloads', 'airtel_cards', 'airtel_reloads', 'hutch_cards', 'hutch_reloads', 'total']);
    const net = t.rows.find((x) => x.line === 'Net profit')!;
    expect(net.total).toBe(4910);
    expect(net.dialog_cards).toBe(3090);
  });
});

describe('Cash book report by segment', () => {
  it('per-segment report = its entries; the Telecom report = the sum; opening + in - out = closing', () => {
    const c = world();
    const whole = cashbookReport(c, 'telecom', Q);
    const seg = (code: string) => whole.segments!.find((x) => x.segment === code)!;
    expect(seg('dialog_reloads')).toMatchObject({ openingCents: 500, inCents: 10000, outCents: 2500, closingCents: 8000 });
    expect(seg('dialog_cards')).toMatchObject({ openingCents: 0, inCents: 8000, outCents: 1000, closingCents: 7000 });
    for (const x of whole.segments!) expect(x.openingCents + x.inCents - x.outCents).toBe(x.closingCents);
    const sum = (k: 'openingCents' | 'inCents' | 'outCents' | 'closingCents') => whole.segments!.reduce((s, x) => s + x[k], 0);
    expect(sum('openingCents')).toBe(whole.totals.openingCents);
    expect(sum('inCents')).toBe(whole.totals.inCents);
    expect(sum('outCents')).toBe(whole.totals.outCents);
    expect(sum('closingCents')).toBe(whole.totals.closingCents);
    expect(whole.totals.closingCents).toBe(whole.ledgerBalanceAsOfToCents);
    expect(whole.segmentTable!.totals!.closing).toBe(whole.totals.closingCents);
    const one = cashbookReport(c, 'telecom', Q, 'dialog_reloads');
    expect(one.totals).toMatchObject({ openingCents: 500, inCents: 10000, outCents: 2500, closingCents: 8000 });
    expect(one.ledgerBalanceAsOfToCents).toBe(8000);
    // Shop is unaffected by a segment
    expect(cashbookReport(c, 'shop', Q, 'dialog_reloads').totals.closingCents).toBe(999);
    expect(cashbookReport(c, 'shop', Q).segmentTable).toBeUndefined();
  });

  it('a negative segment warns per segment, never the Telecom total', () => {
    const c = freshDb();
    MAKE.cash_entries!(c, { book: 'telecom', segment: 'dialog_reloads', business_date: D1, amount_cents: 1000 });
    MAKE.cash_entries!(c, { book: 'telecom', segment: 'mobitel_cards', business_date: D1, amount_cents: -300 });
    const w = cashbookReport(c, 'telecom', Q).warnings;
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: 'NEGATIVE_CASH_BALANCE', segment: 'mobitel_cards' });
  });
});

describe('Transfers, drawings, sales, backdated by segment', () => {
  it('a transfer between two Telecom segments is net zero in the Telecom book and moves the segments', () => {
    const c = freshDb();
    MAKE.cash_transfers!(c, { from_book: 'telecom', to_book: 'telecom', from_segment: 'dialog_reloads', to_segment: 'mobitel_cards', to_fund: null, amount_cents: 700, business_date: D1 });
    MAKE.cash_transfers!(c, { from_book: 'shop', to_book: 'telecom', to_segment: 'hutch_cards', to_fund: null, amount_cents: 300, business_date: D1 });
    const r = transfersReport(c, Q);
    expect(r.totals.byBook.telecom).toMatchObject({ outCents: 700, inCents: 1000, netCents: 300 });
    expect(r.totals.bySegment.dialog_reloads).toMatchObject({ outCents: 700, inCents: 0, netCents: -700 });
    expect(r.totals.bySegment.mobitel_cards!.netCents).toBe(700);
    const segNet = Object.values(r.totals.bySegment).reduce((s, x) => s + x.netCents, 0);
    expect(segNet).toBe(r.totals.byBook.telecom.netCents);
    expect(transfersReport(c, Q, 'hutch_cards').items).toHaveLength(1);
    expect(r.segmentTable.rows.length).toBeGreaterThanOrEqual(8);
  });

  it('drawings and capital by segment sum to the Telecom book; filters limit the report', () => {
    const c = freshDb();
    MAKE.owner_drawings!(c, { book: 'telecom', segment: 'dialog_reloads', amount_cents: 400, business_date: D1 });
    MAKE.owner_drawings!(c, { book: 'telecom', segment: 'airtel_reloads', amount_cents: 600, business_date: D1 });
    MAKE.capital_entries!(c, { book: 'telecom', segment: 'airtel_reloads', amount_cents: 50, business_date: D1 });
    const r = drawingsReport(c, Q);
    expect(r.bySegment.reduce((s, x) => s + x.totalCents, 0)).toBe(1000);
    expect(r.byBook.find((b) => b.book === 'telecom')!.totalCents).toBe(1000);
    expect(r.bySegment.find((x) => x.segment === 'airtel_reloads')).toMatchObject({ cashCents: 600, capitalCents: 50 });
    expect(drawingsReport(c, { ...Q, segment: 'dialog_reloads' }).totals.totalCents).toBe(400);
  });

  it('sales by Telecom segment and the segment filter', () => {
    const c = world();
    const r = salesReport(c, Q);
    expect(r.byTelecomSegment.map((x) => x.segment)).toEqual(['dialog_cards', 'mobitel_cards', 'airtel_cards', 'hutch_cards']);
    expect(r.byTelecomSegment.reduce((s, x) => s + x.revenueCents, 0)).toBe(r.totalsByBook.telecom.revenueCents);
    expect(r.byTelecomSegment.find((x) => x.segment === 'airtel_cards')).toMatchObject({ revenueCents: 2000, costCents: 1500, grossProfitCents: 500 });
    expect(salesReport(c, { ...Q, segment: 'dialog_cards' }).totals.revenueCents).toBe(10000);
  });

  it('backdated rows carry the segment and the report filters on it', () => {
    const c = freshDb();
    // business date far before the posting day = backdated
    MAKE.expenses!(c, { book: 'telecom', segment: 'hutch_reloads', business_date: '2020-01-02', amount_cents: 10 });
    MAKE.expenses!(c, { book: 'shop', business_date: '2020-01-02', amount_cents: 10 });
    const q = { from: '2020-01-01', to: '2020-01-31', limit: 50, offset: 0 };
    const all = backdatedReport(c, q);
    expect(new Set(all.rows.map((x) => x.segment))).toEqual(new Set([null, 'hutch_reloads']));
    const f = backdatedReport(c, { ...q, segment: 'hutch_reloads' });
    expect(f.total).toBe(1);
    expect(f.rows[0]!.segment).toBe('hutch_reloads');
  });
});

describe('Dashboard closings and the Excel export pack', () => {
  it('days not closed are listed per Telecom segment with activity', () => {
    const c = freshDb();
    MAKE.cash_entries!(c, { book: 'telecom', segment: 'dialog_reloads', business_date: '2025-05-01', amount_cents: 100 });
    MAKE.cash_entries!(c, { book: 'telecom', segment: 'mobitel_cards', business_date: '2025-05-05', amount_cents: 100 });
    MAKE.daily_closings!(c, { book: 'telecom', segment: 'dialog_reloads', business_date: '2025-05-03' });
    const tel = closingsBlock(c, '2025-05-08').openDaysBehind.filter((x) => x.book === 'telecom');
    expect(tel.map((x) => x.segment)).toEqual(['dialog_reloads', 'mobitel_cards']);
    expect(tel[0]!.dates).not.toContain('2025-05-03');
    expect(tel[0]!.dates).toContain('2025-05-02');
    expect(tel[1]!.dates).toEqual(['2025-05-05', '2025-05-06', '2025-05-07']);
    expect(tel[0]!.label).toBe('Dialog Reloads');
  });

  it('the export pack has the by-segment P&L and cash book sheets', () => {
    const titles = exportPackTables(world(), Q.from, Q.to).map((t) => t.title);
    expect(titles).toContain('Telecom P&L by segment');
    expect(titles).toContain('Cash book - Telecom segments');
    const cash = exportPackTables(world(), Q.from, Q.to).find((t) => t.title === 'Cash book - Telecom segments')!;
    expect(cash.rows.length).toBe(8);
  });
});
