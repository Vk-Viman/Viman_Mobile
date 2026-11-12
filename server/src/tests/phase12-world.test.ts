// Phase 12 DASHBOARD against the scripted two-month shop (March-April 2025, helpers/phase11fin.ts, posted through the real API).
// Every expected number below is worked out BY HAND from that script (the working is in the comments, using the same day-by-day
// reasoning as phase11-fin-world.test.ts) and never read from dashboard or report code. A second group then proves that each
// dashboard figure EQUALS the matching Phase 11 report / Funds / valuation answer for the same range (no re-derived figure).
// Protects (BUSINESS_RULES / API_CONTRACTS Phase 12): segment sales/profit definitions (1, 5, 10, R5, R14), Ice Cream profit =
// RECOGNIZED profit with funds kept apart (10.1), D3 excess-cost flows and warning (10.5, 10.6), series zero-filled (30 days, 12 months).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { get } from './helpers/catalog.ts';
import { num } from './helpers/phase4.ts';
import { buildFinWorld, q, rep } from './helpers/phase11fin.ts';
import { ZERO_TILE, dash, datesEndingOn, tileOf } from './helpers/phase12.ts';

const env = new TestEnv();
let s: ApiBase;
let d430: any; // dashboard as of 2025-04-30
let d402: any; // as of 2025-04-02 (a busy April day)
let d331: any; // as of 2025-03-31
let d312: any; // as of 2025-03-12 (excess cost outstanding in the middle of March)

beforeAll(async () => {
  s = await apiBase(await env.build());
  await buildFinWorld(s, true);
  for (const [k, date] of [['d430', '2025-04-30'], ['d402', '2025-04-02'], ['d331', '2025-03-31'], ['d312', '2025-03-12']] as const) {
    const r = await dash(s, date);
    expect(r.status, date).toBe(200);
    if (k === 'd430') d430 = r.body; else if (k === 'd402') d402 = r.body; else if (k === 'd331') d331 = r.body; else d312 = r.body;
  }
}, 240000);
afterAll(async () => { await env.cleanup(); });

describe('GET /dashboard - tiles (hand-calculated)', () => {
  /**
   * 2025-04-30, "this month" = 04-01..04-30 (April, from the day tables of the Phase 11 world):
   *  Shop     sales = goods revenue (R3 return: -150,000) + print 04-04 (20 x 2,500 = 50,000) = -100,000; profit -103,500
   *           (R3 GP -57,000, rent -80,000, print GP +32,000, shop count over +1,500).
   *  Telecom  sales = card revenue 0 + reload commission 04-01 (100,000 x 6% = 6,000) = 6,000; profit 6,000 - repairs 7,000 - count short 300 = -1,300.
   *  Ice Cream sales 20,000 (the 04-02 day); recognized profit = share 20,000 - 10,000 - 2,000 = 8,000.
   *  Combined sales -100,000 + 6,000 + 20,000 = -74,000 (negative: April has more returns than sales); profit -103,500 - 1,300 + 8,000 = -96,800.
   *  Nothing is posted on 04-30 itself, so "today" is all zero.
   */
  it('2025-04-30: today is all zero; the month tile matches the April hand calculation and keeps negative values negative', () => {
    expect(d430.asOf).toBe('2025-04-30');
    expect(d430.today).toEqual(ZERO_TILE);
    expect(d430.month).toEqual(tileOf([-100000, -103500], [6000, -1300], [20000, 8000], [-74000, -96800]));
  });

  /**
   * 2025-04-02: Shop R3 return -150,000 sales, profit -57,000. Telecom: repairs -7,000 (no commission that day). Ice Cream day 20,000 sales,
   * profit 8,000. Combined today: sales -150,000 + 0 + 20,000 = -130,000; profit -57,000 - 7,000 + 8,000 = -56,000.
   * Month so far (04-01..04-02): Telecom also has the 04-01 reload commission 6,000 -> sales 6,000, profit -1,000. Combined sales -150,000 + 6,000 + 20,000 = -124,000;
   * profit -57,000 - 1,000 + 8,000 = -50,000.
   */
  it('2025-04-02: a busy day; today and month-so-far hand-calculated', () => {
    expect(d402.today).toEqual(tileOf([-150000, -57000], [0, -7000], [20000, 8000], [-130000, -56000]));
    expect(d402.month).toEqual(tileOf([-150000, -57000], [6000, -1000], [20000, 8000], [-124000, -50000]));
  });

  /**
   * March (asOf 03-31): Shop goods revenue 342,000 + print 23,000 = 365,000, profit -77,600. Telecom: cards 18,000 + commission 316,445 = 334,445, profit 279,945.
   * Ice Cream sales 330,000, recognized 94,500. Combined sales 1,029,445; profit 296,845.
   */
  it('2025-03-31: the whole of March as "this month"', () => {
    expect(d331.today).toEqual(ZERO_TILE);
    expect(d331.month).toEqual(tileOf([365000, -77600], [334445, 279945], [330000, 94500], [1029445, 296845]));
  });
});

describe('GET /dashboard - cash and Ice Cream funds (hand-calculated, kept apart from profit)', () => {
  /**
   * Cash book balances from the Phase 11 cash-book hand calculations: 04-30 Shop 606,000, Telecom 5,778,413, Ice Cream 586,500
   * = funds Cost 637,000 + Electricity -111,000 + Profit 60,500. 03-31 Shop 784,500, Telecom 5,685,713, Ice Cream 646,500 (630,000 - 33,000 + 49,500).
   * 04-02: Shop 784,500 - R3 refund 150,000 = 634,500; Telecom 5,685,713 + 100,000 reload - 7,000 repairs = 5,778,713;
   * Ice Cream 646,500 + day sales 20,000 - electricity bill 80,000 = 586,500 = Cost 640,000 + Electricity -111,000 + Profit 57,500 (the 04-03 move is later).
   */
  it('balances per book as of the date, with Ice Cream funds apart and the "= book" check', () => {
    expect(d430.cash.books).toEqual([
      { book: 'shop', balanceCents: 606000 },
      { book: 'telecom', balanceCents: 5778413 },
      { book: 'icecream', balanceCents: 586500, fundsMatchBook: true, funds: { cost: 637000, electricity: -111000, profit: 60500 } },
    ]);
    expect(d430.cash.totalCents).toBe(606000 + 5778413 + 586500);
    expect(d331.cash.books.map((b: any) => b.balanceCents)).toEqual([784500, 5685713, 646500]);
    expect(d331.cash.books[2].funds).toEqual({ cost: 630000, electricity: -33000, profit: 49500 });
    expect(d402.cash.books.map((b: any) => b.balanceCents)).toEqual([634500, 5778713, 586500]);
    expect(d402.cash.books[2].funds).toEqual({ cost: 640000, electricity: -111000, profit: 57500 });
  });

  it('the invariant Cost + Electricity + Profit = Ice Cream cash book holds on every date, and the fund block is never part of profit', () => {
    for (const d of [d430, d402, d331, d312]) {
      const f = d.icecream.funds;
      const book = d.cash.books.find((b: any) => b.book === 'icecream');
      expect(f.cost + f.electricity + f.profit, d.asOf).toBe(book.balanceCents);
      expect(d.icecream.fundsTotalCents).toBe(book.balanceCents);
      expect(d.icecream.fundsMatchBook).toBe(true);
      expect(book.fundsMatchBook).toBe(true);
    }
    // 04-30: the Profit FUND balance (60,500) is not the recognized profit of the month (8,000) nor of the whole history (102,500)
    expect(d430.icecream.funds.profit).toBe(60500);
    expect(d430.icecream.recognizedProfitMonthCents).toBe(8000);
    expect(d430.month.bySegment.icecream.profitCents).toBe(8000);
  });
});

describe('GET /dashboard - Ice Cream recognized profit, excess cost (D3) and warnings', () => {
  /**
   * 04-30: April recognized profit 8,000. Outstanding excess at 03-31 is 0 and at 04-30 is 16,000 (U = -16,000 after the 04-02 day), so the April flow
   * is +16,000 and "profit after excess cost" = 8,000 - 16,000 = -8,000. Nothing happens on 04-30 itself: today's flow is 0.
   */
  it('2025-04-30: month flows, outstanding excess and the EXCESS_COST_OUTSTANDING warning (official profit is NOT reduced)', () => {
    const i = d430.icecream;
    expect(i.recognizedProfitMonthCents).toBe(8000);
    expect(i.excessCostNotChargedTodayCents).toBe(0);
    expect(i.excessCostNotChargedMonthCents).toBe(16000);
    expect(i.profitAfterExcessCostMonthCents).toBe(-8000);
    expect(i.outstandingExcessCostCents).toBe(16000);
    expect(i.warnings.map((w: any) => w.code)).toEqual(['NEGATIVE_FUND_BALANCE', 'EXCESS_COST_OUTSTANDING']);
    const excess = i.warnings.find((w: any) => w.code === 'EXCESS_COST_OUTSTANDING');
    expect(excess).toMatchObject({ outstandingExcessCostCents: 16000, asOf: '2025-04-30', book: 'icecream' });
    expect(d430.month.bySegment.icecream.profitCents).toBe(8000); // still the official figure
    expect(d430.warnings.map((w: any) => w.code)).toEqual(['NEGATIVE_FUND_BALANCE', 'EXCESS_COST_OUTSTANDING']);
  });

  /** 04-02: today's flow -12,000 (U goes from -28,000 to -16,000: excess 28,000 -> 16,000); April so far +16,000. */
  it('2025-04-02: the day flow can be negative (earlier excess now covered)', () => {
    expect(d402.icecream.excessCostNotChargedTodayCents).toBe(-12000);
    expect(d402.icecream.excessCostNotChargedMonthCents).toBe(16000);
    expect(d402.icecream.profitAfterExcessCostMonthCents).toBe(-8000);
    expect(d402.icecream.outstandingExcessCostCents).toBe(16000);
  });

  /**
   * 03-12 (middle of March): outstanding excess 11,000 (the 03-12 electricity bill 50,000 leaves U = -11,000), the flow of that day is +11,000
   * (it was 0 the evening before). Recognized to 03-12: shares 30,000 + 22,000 + 18,000 - other cost 2,000 = 68,000; after excess 68,000 - 11,000 = 57,000.
   */
  it('2025-03-12: a mid-month warning with its flows; 2025-03-31: no excess left, so no D3 warning', () => {
    const i = d312.icecream;
    expect(i.recognizedProfitMonthCents).toBe(68000);
    expect(i.excessCostNotChargedTodayCents).toBe(11000);
    expect(i.excessCostNotChargedMonthCents).toBe(11000);
    expect(i.profitAfterExcessCostMonthCents).toBe(57000);
    expect(i.outstandingExcessCostCents).toBe(11000);
    expect(i.warnings.some((w: any) => w.code === 'EXCESS_COST_OUTSTANDING')).toBe(true);
    const m = d331.icecream;
    expect(m.recognizedProfitMonthCents).toBe(94500);
    expect(m.excessCostNotChargedMonthCents).toBe(0);
    expect(m.profitAfterExcessCostMonthCents).toBe(94500);
    expect(m.outstandingExcessCostCents).toBe(0);
    expect(m.warnings.map((w: any) => w.code)).toEqual(['NEGATIVE_FUND_BALANCE']); // the electricity fund is below zero (-33,000), no excess warning
  });
});

describe('GET /dashboard - stock and top products (hand-calculated)', () => {
  /**
   * Stock value at 04-30 (weighted average, from the script): A 5 units = 150,000 (4 after the stocktake and loss/drawing, +3 returned at 30,000 each; see the
   * Phase 11 shop notes), B 0, C 6 = 60,000 (40,000 + gain 20,000), E 0 (the purchase return swept the rest), X (cards) 15 = 75,000 -> 285,000.
   * At 03-31 A has 2 units = 60,000 (the 04-02 return is later) -> 195,000.
   */
  it('stock value as of the date; no product has a minimum set, so nothing is low', () => {
    expect(d430.stock.valueCents).toBe(285000);
    expect(num(s, "SELECT COALESCE(SUM(stock_value_cents),0) FROM products")).toBe(285000); // the cache agrees (an independent read)
    expect(d331.stock.valueCents).toBe(195000);
    expect(d430.stock).toMatchObject({ lowStockCount: 0, lowStock: [], negativeOrWarning: [] });
  });

  /**
   * March, by product (net of returns): A revenue 304,000 - 102,000 = 202,000, cost 123,000 -> GP 79,000; E 60,000 / cost 30,000 -> 30,000;
   * B 80,000 / cost 66,667 -> 13,333; X cards 18,000 / cost 15,300 -> 2,700. (A + B + E = 122,333 = the Shop goods gross profit of March.)
   * April: only the R3 return of A: revenue -150,000, GP -57,000.
   */
  it('top products this month, most profitable first (net of returns)', () => {
    expect(d331.series.topProducts).toEqual([
      { name: 'Phone case A', revenueCents: 202000, grossProfitCents: 79000 },
      { name: 'Earphone E', revenueCents: 60000, grossProfitCents: 30000 },
      { name: 'Charger B', revenueCents: 80000, grossProfitCents: 13333 },
      { name: 'Scratch card X', revenueCents: 18000, grossProfitCents: 2700 },
    ]);
    expect(d430.series.topProducts).toEqual([{ name: 'Phone case A', revenueCents: -150000, grossProfitCents: -57000 }]);
  });
});

describe('GET /dashboard - series (zero-filled, hand-calculated)', () => {
  it('daily: exactly 30 rows ending on the date, zero on quiet days, combined sales and profit on busy ones', () => {
    const rows = d430.series.daily;
    expect(rows).toHaveLength(30);
    expect(rows.map((r: any) => r.date)).toEqual(datesEndingOn('2025-04-30', 30)); // 04-01 .. 04-30
    const by = Object.fromEntries(rows.map((r: any) => [r.date, r]));
    // 04-01 reload commission 6,000; 04-02 sales -150,000 + 20,000, profit -57,000 - 7,000 + 8,000; 04-03 rent -80,000; 04-04 print 50,000 / 32,000;
    // 04-05 shop count over +1,500; 04-06 telecom count short -300 (days from the Phase 11 hand tables)
    expect(by['2025-04-01']).toEqual({ date: '2025-04-01', salesCents: 6000, profitCents: 6000 });
    expect(by['2025-04-02']).toEqual({ date: '2025-04-02', salesCents: -130000, profitCents: -56000 });
    expect(by['2025-04-03']).toEqual({ date: '2025-04-03', salesCents: 0, profitCents: -80000 });
    expect(by['2025-04-04']).toEqual({ date: '2025-04-04', salesCents: 50000, profitCents: 32000 });
    expect(by['2025-04-05']).toEqual({ date: '2025-04-05', salesCents: 0, profitCents: 1500 });
    expect(by['2025-04-06']).toEqual({ date: '2025-04-06', salesCents: 0, profitCents: -300 });
    for (const d of datesEndingOn('2025-04-30', 30).filter((x) => x > '2025-04-06')) expect(by[d], d).toEqual({ date: d, salesCents: 0, profitCents: 0 });
    // rows add up to the month tile
    expect(rows.reduce((a: number, r: any) => a + r.profitCents, 0)).toBe(-96800);
    expect(rows.reduce((a: number, r: any) => a + r.salesCents, 0)).toBe(-74000);
  });

  it('daily window across a month boundary: asOf 2025-03-31 starts 03-02 (30 days) and includes the busy 03-02', () => {
    const rows = d331.series.daily;
    expect(rows).toHaveLength(30);
    expect(rows[0].date).toBe('2025-03-02');
    expect(rows[29].date).toBe('2025-03-31');
    // 03-02: Shop sales 304,000, profit 120,000; Telecom reload commission 307,407; Ice Cream sales 100,000, share 30,000 -> sales 711,407, profit 457,407
    expect(rows[0]).toEqual({ date: '2025-03-02', salesCents: 711407, profitCents: 457407 });
  });

  /** Monthly (12 rows, last one = the date's month): March -77,600 / 279,945 / 94,500 = 296,845; April -103,500 / -1,300 / 8,000 = -96,800; every earlier month zero. */
  it('monthly: exactly 12 rows 2024-05..2025-04, profit per segment stacked, zero before the first record', () => {
    const rows = d430.series.monthly;
    expect(rows).toHaveLength(12);
    expect(rows.map((r: any) => r.month)).toEqual(['2024-05', '2024-06', '2024-07', '2024-08', '2024-09', '2024-10', '2024-11', '2024-12', '2025-01', '2025-02', '2025-03', '2025-04']);
    for (const r of rows.slice(0, 10)) expect(r).toEqual({ month: r.month, shopCents: 0, telecomCents: 0, icecreamCents: 0, combinedCents: 0 });
    expect(rows[10]).toEqual({ month: '2025-03', shopCents: -77600, telecomCents: 279945, icecreamCents: 94500, combinedCents: 296845 });
    expect(rows[11]).toEqual({ month: '2025-04', shopCents: -103500, telecomCents: -1300, icecreamCents: 8000, combinedCents: -96800 });
  });

  it('monthly: the last month runs only up to the date (asOf 2025-04-02 shows April so far), and a January date wraps the year correctly', async () => {
    expect(d402.series.monthly[11]).toEqual({ month: '2025-04', shopCents: -57000, telecomCents: -1000, icecreamCents: 8000, combinedCents: -50000 });
    const jan = (await dash(s, '2025-01-15')).body;
    expect(jan.series.monthly.map((r: any) => r.month)).toEqual(['2024-02', '2024-03', '2024-04', '2024-05', '2024-06', '2024-07', '2024-08', '2024-09', '2024-10', '2024-11', '2024-12', '2025-01']);
  });
});

describe('GET /dashboard - every figure equals the matching Phase 11 report for the same range', () => {
  const bodyOf = async (path: string, from: string, to: string, g: 'day' | 'month' = 'month') => (await rep(s, path, q(from, to, g))).body;

  it('month tile = Shop / Telecom / Ice Cream / Combined P&L over 04-01..04-30 (sales lines as defined, profit = the report profit)', async () => {
    const [shop, tel, ice, comb] = await Promise.all(['pnl/shop', 'pnl/telecom', 'pnl/icecream', 'pnl/combined'].map((p) => bodyOf(p, '2025-04-01', '2025-04-30')));
    const m = d430.month;
    expect(m.bySegment.shop).toEqual({ salesCents: shop.totals.goods.revenueCents + shop.totals.services.revenueCents, profitCents: shop.totals.netProfitCents });
    expect(m.bySegment.telecom).toEqual({ salesCents: tel.totals.cards.revenueCents + tel.totals.commissionRevenueCents, profitCents: tel.totals.netProfitCents });
    expect(m.bySegment.icecream).toEqual({ salesCents: ice.totals.salesCents, profitCents: ice.totals.recognizedProfitCents });
    expect(m.profitCents).toBe(comb.totals.recognizedProfitCents);
    expect(m.salesCents).toBe(m.bySegment.shop.salesCents + m.bySegment.telecom.salesCents + m.bySegment.icecream.salesCents);
  });

  it('today tile = the same reports for the single day', async () => {
    const comb = await bodyOf('pnl/combined', '2025-04-02', '2025-04-02', 'day');
    expect(d402.today.profitCents).toBe(comb.totals.recognizedProfitCents);
    expect(d402.today.bySegment.shop.profitCents).toBe(comb.totals.segments.shop.recognizedProfitCents);
    expect(d402.today.bySegment.telecom.profitCents).toBe(comb.totals.segments.telecom.recognizedProfitCents);
    expect(d402.today.bySegment.icecream.profitCents).toBe(comb.totals.segments.icecream.recognizedProfitCents);
  });

  it('daily series = the Combined P&L day rows; monthly series = its month rows (clipped to the date)', async () => {
    const days = await bodyOf('pnl/combined', '2025-04-01', '2025-04-30', 'day');
    expect(days.rows).toHaveLength(30);
    days.rows.forEach((r: any, i: number) => {
      expect(d430.series.daily[i].date).toBe(r.period.from);
      expect(d430.series.daily[i].profitCents).toBe(r.recognizedProfitCents);
    });
    const months = await bodyOf('pnl/combined', '2024-05-01', '2025-04-30', 'month');
    expect(months.rows).toHaveLength(12);
    months.rows.forEach((r: any, i: number) => {
      expect(d430.series.monthly[i]).toEqual({
        month: r.period.label, shopCents: r.segments.shop.recognizedProfitCents, telecomCents: r.segments.telecom.recognizedProfitCents,
        icecreamCents: r.segments.icecream.recognizedProfitCents, combinedCents: r.recognizedProfitCents,
      });
    });
  });

  it('Ice Cream block = the Ice Cream P&L, the Funds summary and the funds report', async () => {
    const ice = await bodyOf('pnl/icecream', '2025-04-01', '2025-04-30');
    const funds = (await get(s.app, '/icecream/funds?asOf=2025-04-30')).body;
    const i = d430.icecream;
    expect(i.recognizedProfitMonthCents).toBe(ice.totals.recognizedProfitCents);
    expect(i.excessCostNotChargedMonthCents).toBe(ice.totals.excessCostNotChargedCents);
    expect(i.profitAfterExcessCostMonthCents).toBe(ice.totals.profitAfterExcessCostCents);
    expect(i.outstandingExcessCostCents).toBe(ice.totals.balancesAsOfPeriodEnd.outstandingExcessCostCents);
    expect(i.funds).toEqual({ cost: funds.funds.cost.balanceCents, electricity: funds.funds.electricity.balanceCents, profit: funds.funds.profit.balanceCents });
    expect(i.fundsTotalCents).toBe(funds.totalCents);
    expect(i.warnings).toEqual(funds.warnings);
    const fr = await bodyOf('icecream-funds', '2025-04-01', '2025-04-30');
    expect(i.funds.cost).toBe(fr.totals.funds.cost.closingCents);
    expect(i.funds.profit).toBe(fr.totals.funds.profit.closingCents);
  });

  it('cash balances = the cash-book reports and the cash book list; stock = valuation and low-stock reports; top products = profitability', async () => {
    for (const book of ['shop', 'telecom', 'icecream'] as const) {
      const r = await bodyOf(`cashbook/${book}`, '2025-04-01', '2025-04-30');
      expect(d430.cash.books.find((b: any) => b.book === book).balanceCents, book).toBe(r.ledgerBalanceAsOfToCents);
      expect(r.ledgerBalanceAsOfToCents).toBe(num(s, 'SELECT COALESCE(SUM(amount_cents),0) FROM cash_entries WHERE book = ?', book));
    }
    const list = (await get(s.app, '/cashbooks')).body; // the live list agrees with the dashboard of the same (latest) date
    expect(list.books.map((b: any) => b.balanceCents)).toEqual(d430.cash.books.map((b: any) => b.balanceCents));
    const val = (await get(s.app, '/reports/inventory/valuation?asOf=2025-04-30')).body;
    expect(d430.stock.valueCents).toBe(val.totals.valueCents);
    const low = (await get(s.app, '/reports/low-stock')).body;
    expect(d430.stock.lowStockCount).toBe(low.totals.products);
    const prof = (await get(s.app, '/reports/product-profitability?from=2025-03-01&to=2025-03-31')).body;
    expect(d331.series.topProducts).toEqual(prof.rows.slice(0, 5).map((r: any) => ({ name: r.productName, revenueCents: r.revenueCents, grossProfitCents: r.grossProfitCents })));
  });
});

describe('GET /dashboard - shape', () => {
  it('has exactly the contract keys and a definitions block that explains sales and profit', () => {
    expect(Object.keys(d430).sort()).toEqual(['asOf', 'backup', 'cash', 'closings', 'definitions', 'icecream', 'month', 'series', 'stock', 'today', 'warnings']);
    expect(Object.keys(d430.series).sort()).toEqual(['daily', 'monthly', 'topProducts']);
    expect(Object.keys(d430.closings).sort()).toEqual(['lastClosedByBook', 'openDaysBehind']);
    expect(Object.keys(d430.backup).sort()).toEqual(['ageHours', 'latestAt', 'status']);
    for (const k of ['sales', 'salesShop', 'salesTelecom', 'salesIcecream', 'salesCombined', 'profit', 'today', 'month', 'cash', 'excessCost']) {
      expect(typeof d430.definitions[k], k).toBe('string');
    }
    expect(d430.definitions.salesTelecom).toContain('commission');
    expect(d430.definitions.profit).toContain('RECOGNIZED');
  });

  it('every money figure is a whole number of cents (no fractions, no NaN)', () => {
    const bad: string[] = [];
    const walk = (v: unknown, path: string) => {
      if (typeof v === 'number' && !Number.isInteger(v) && !path.includes('ageHours')) bad.push(path);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, `${path}.${k}`));
    };
    walk(d430, 'dashboard');
    expect(bad).toEqual([]);
  });
});
