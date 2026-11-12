/**
 * services/reports/stock-losses-report.ts - Stock losses by period, reason, product and book, plus the stock-adjustment memo.
 *
 * Layer: report service, a pure function `(conn, query) => figures`. Read-only.
 *
 * Rules protected:
 *  - BUSINESS_RULES section 11 (R2, R3): a loss is valued at the weighted-average cost frozen on its record and
 *    belongs to its product's book. Only `status = 'posted'` records count (R1: a voided loss shows nothing).
 *  - A damaged sales return writes exactly one loss row (section 4); it is included once here and shown in its own
 *    column ("from returns"), never added again anywhere.
 *  - The memo block `stockAdjustmentsNetCents` is the section 11 line: posted losses (manual and damaged-return) +
 *    stocktake losses + residual sweeps - stocktake gains - purchase refund gain (R4, same as the P&L). Stocktake and sweep parts come from the stock MOVEMENTS by
 *    business date including the reversal rows of voids (so voided stocktakes net out): `stocktake_loss`, `stocktake_gain`
 *    and the value-only `adjustment` (R4 sweep), each as -sum(value_delta). Losses come from `stock_losses` (not from
 *    `loss` movements) because a damaged sales return writes a loss row but NO stock movement. Personal use is not an adjustment (section 9).
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Granularity, ReportTable } from '../../lib/report-table.ts';
import { addInto, fillPeriods, num, numericOnly, periodKeySql } from './ops-common.ts';
import type { ReportWarning, SqlRow, StockBook } from './ops-common.ts';

/** Loss reasons (database CHECK). */
export const LOSS_REASONS = ['damaged', 'lost', 'expired', 'other'] as const;
/** One loss reason. */
export type LossReasonName = typeof LOSS_REASONS[number];

/** Request: business dates, row granularity and an optional book. */
export interface LossesQuery { from: string; to: string; granularity: Granularity; book?: StockBook }

/** Figures of one period row. Money in cents. */
export interface LossFigures {
  lossCount: number; qty: number; costCents: number; damagedCents: number; lostCents: number; expiredCents: number; otherCents: number;
  /** Cost of the losses created by damaged sales returns (already inside `costCents`). */
  fromReturnsCents: number;
  /** Memo (section 11): stocktake losses, stocktake gains, residual sweeps and the net stock-adjustments line, from movements. */
  stocktakeLossCents: number; stocktakeGainCents: number; sweepCents: number; stockAdjustmentsNetCents: number;
  /** R4: purchase refund (return / void) above the stock value removed - a gain; it reduces `stockAdjustmentsNetCents` (same figure as the P&L). */
  purchaseRefundGainCents: number;
}

/** Breakdown line over the whole range. */
export interface LossBreakdown { lossCount: number; qty: number; costCents: number }

/** Report body. */
export interface LossesReport {
  from: string; to: string; granularity: Granularity;
  rows: Array<{ period: { from: string; to: string; label: string } } & LossFigures>;
  totals: LossFigures;
  byReason: Array<{ reason: LossReasonName } & LossBreakdown>;
  byBook: Array<{ book: StockBook } & LossBreakdown>;
  byProduct: Array<{ productId: number; productName: string; book: StockBook } & LossBreakdown>;
  table: ReportTable;
  extraTables: ReportTable[];
  warnings: ReportWarning[];
}

const zero = (): LossFigures => ({
  lossCount: 0, qty: 0, costCents: 0, damagedCents: 0, lostCents: 0, expiredCents: 0, otherCents: 0, fromReturnsCents: 0,
  stocktakeLossCents: 0, stocktakeGainCents: 0, sweepCents: 0, stockAdjustmentsNetCents: 0, purchaseRefundGainCents: 0,
});

/** Stock losses report for [from, to]. */
export function stockLossesReport(conn: DatabaseSync, q: LossesQuery): LossesReport {
  const key = periodKeySql('l.business_date', q.granularity);
  const bookSql = q.book !== undefined ? ' AND l.book = ?' : '';
  const base: SQLInputValue[] = [q.from, q.to, ...(q.book !== undefined ? [q.book] : [])];
  const byLabel = new Map<string, LossFigures>();
  const at = (label: string): LossFigures => { let f = byLabel.get(label); if (!f) { f = zero(); byLabel.set(label, f); } return f; };

  for (const r of conn.prepare(
    `SELECT ${key} AS k, COUNT(*) AS n, SUM(l.qty) AS qty, SUM(l.cost_cents) AS cost,
            SUM(CASE WHEN l.reason = 'damaged' THEN l.cost_cents ELSE 0 END) AS damaged,
            SUM(CASE WHEN l.reason = 'lost' THEN l.cost_cents ELSE 0 END) AS lost,
            SUM(CASE WHEN l.reason = 'expired' THEN l.cost_cents ELSE 0 END) AS expired,
            SUM(CASE WHEN l.reason = 'other' THEN l.cost_cents ELSE 0 END) AS other,
            SUM(CASE WHEN l.source = 'damaged_return' THEN l.cost_cents ELSE 0 END) AS from_returns
       FROM stock_losses l WHERE l.status = 'posted' AND l.business_date BETWEEN ? AND ?${bookSql} GROUP BY k`,
  ).all(...base) as unknown as SqlRow[]) {
    const f = at(String(r.k));
    f.lossCount = num(r.n); f.qty = num(r.qty); f.costCents = num(r.cost); f.damagedCents = num(r.damaged); f.lostCents = num(r.lost);
    f.expiredCents = num(r.expired); f.otherCents = num(r.other); f.fromReturnsCents = num(r.from_returns);
  }

  // Memo: stock adjustments from the movements (reversal rows included so voids net out).
  const mKey = periodKeySql('m.business_date', q.granularity);
  const mBook = q.book !== undefined ? ' AND p.book = ?' : '';
  for (const r of conn.prepare(
    `SELECT ${mKey} AS k,
            SUM(CASE WHEN m.type = 'stocktake_loss' THEN -m.value_delta_cents ELSE 0 END) AS st_loss,
            SUM(CASE WHEN m.type = 'stocktake_gain' THEN m.value_delta_cents ELSE 0 END) AS st_gain,
            SUM(CASE WHEN m.type = 'adjustment' THEN -m.value_delta_cents ELSE 0 END) AS sweep
       FROM stock_movements m JOIN products p ON p.id = m.product_id
      WHERE m.type IN ('stocktake_loss', 'stocktake_gain', 'adjustment') AND m.business_date BETWEEN ? AND ?${mBook} GROUP BY k`,
  ).all(...base) as unknown as SqlRow[]) {
    const f = at(String(r.k));
    f.stocktakeLossCents = num(r.st_loss); f.stocktakeGainCents = num(r.st_gain); f.sweepCents = num(r.sweep);
  }

  // R4 purchase refund gain (same definition as fin-queries.ts adjustmentsByPeriod): refunds of returns (return date) + totals of voided
  // purchases (original date) - value removed by the purchase_return / purchase_void movements (the residual sweep is NOT in that value).
  const pBook = q.book !== undefined ? ' AND pu.book = ?' : '';
  const gainRows: Array<[string, string, SQLInputValue[]]> = [
    [periodKeySql('r.business_date', q.granularity),
      `SELECT KEY AS k, SUM(r.refund_cents) AS v FROM purchase_returns r JOIN purchases pu ON pu.id = r.purchase_id
        WHERE r.business_date BETWEEN ? AND ?${pBook} GROUP BY k`, base],
    [periodKeySql('pu.business_date', q.granularity),
      `SELECT KEY AS k, SUM(pu.total_cents) AS v FROM purchases pu WHERE pu.status = 'void' AND pu.business_date BETWEEN ? AND ?${pBook} GROUP BY k`, base],
    [mKey,
      `SELECT KEY AS k, SUM(m.value_delta_cents) AS v FROM stock_movements m JOIN products p ON p.id = m.product_id
        WHERE m.type IN ('purchase_return', 'purchase_void') AND m.business_date BETWEEN ? AND ?${mBook} GROUP BY k`, base],
  ];
  for (const [kSql, sql, params] of gainRows) {
    for (const r of conn.prepare(sql.replace('KEY', kSql)).all(...params) as unknown as SqlRow[]) at(String(r.k)).purchaseRefundGainCents += num(r.v);
  }

  // Section 11 line: posted losses (manual AND damaged-return, which writes no stock movement) + stocktake losses + sweeps - gains - refund gain.
  for (const f of byLabel.values()) f.stockAdjustmentsNetCents = f.costCents + f.stocktakeLossCents + f.sweepCents - f.stocktakeGainCents - f.purchaseRefundGainCents;
  const rows = fillPeriods(q.from, q.to, q.granularity, byLabel, zero);
  const totals = zero();
  for (const r of rows) addInto(totals, r);

  const group = (col: string, extra: string) => conn.prepare(
    `SELECT ${col} AS g, ${extra} COUNT(*) AS n, SUM(l.qty) AS qty, SUM(l.cost_cents) AS cost
       FROM stock_losses l JOIN products p ON p.id = l.product_id
      WHERE l.status = 'posted' AND l.business_date BETWEEN ? AND ?${bookSql} GROUP BY g ORDER BY cost DESC, g`,
  ).all(...base) as unknown as SqlRow[];
  const brk = (r: SqlRow): LossBreakdown => ({ lossCount: num(r.n), qty: num(r.qty), costCents: num(r.cost) });
  const byReason = group('l.reason', '').map((r) => ({ reason: r.g as LossReasonName, ...brk(r) }));
  const byBook = group('l.book', '').map((r) => ({ book: r.g as StockBook, ...brk(r) }));
  const byProduct = group('l.product_id', 'MIN(p.name) AS pname, MIN(l.book) AS pbook,').map((r) => ({
    productId: num(r.g), productName: String(r.pname), book: r.pbook as StockBook, ...brk(r),
  }));

  const cols = (extra: ReportTable['columns']): ReportTable['columns'] => [
    ...extra, { key: 'lossCount', label: 'Losses', kind: 'int' }, { key: 'qty', label: 'Units', kind: 'int' }, { key: 'costCents', label: 'Cost', kind: 'money' },
  ];
  const table: ReportTable = {
    title: 'Stock losses',
    columns: [
      { key: 'period', label: 'Period', kind: 'text' }, { key: 'lossCount', label: 'Losses', kind: 'int' }, { key: 'qty', label: 'Units', kind: 'int' },
      { key: 'costCents', label: 'Cost', kind: 'money' }, { key: 'damagedCents', label: 'Damaged', kind: 'money' }, { key: 'lostCents', label: 'Lost', kind: 'money' },
      { key: 'expiredCents', label: 'Expired', kind: 'money' }, { key: 'otherCents', label: 'Other', kind: 'money' },
      { key: 'fromReturnsCents', label: 'From damaged returns', kind: 'money' }, { key: 'stocktakeLossCents', label: 'Stocktake losses', kind: 'money' },
      { key: 'stocktakeGainCents', label: 'Stocktake gains', kind: 'money' }, { key: 'sweepCents', label: 'Residual sweeps', kind: 'money' },
      { key: 'purchaseRefundGainCents', label: 'Purchase refund above stock value removed (R4)', kind: 'money' },
      { key: 'stockAdjustmentsNetCents', label: 'Stock adjustments (net)', kind: 'money' },
    ],
    rows: rows.map((r) => ({ period: r.period.label, ...numericOnly(r) })),
    totals: { period: 'Total', ...numericOnly(totals) },
    notes: [
      'Losses are valued at the average cost when recorded. Voided losses are not counted.',
      'Stock adjustments (net) = losses + stocktake losses + residual sweeps - stocktake gains - purchase refund gain (voids net out). Personal-use goods drawings are not adjustments.',
    ],
  };
  const extraTables: ReportTable[] = [
    { title: 'Losses by reason', columns: cols([{ key: 'name', label: 'Reason', kind: 'text' }]), rows: byReason.map((r) => ({ name: r.reason, ...brk2(r) })) },
    { title: 'Losses by book', columns: cols([{ key: 'name', label: 'Book', kind: 'text' }]), rows: byBook.map((r) => ({ name: r.book, ...brk2(r) })) },
    { title: 'Losses by product', columns: cols([{ key: 'name', label: 'Product', kind: 'text' }, { key: 'book', label: 'Book', kind: 'text' }]),
      rows: byProduct.map((r) => ({ name: r.productName, book: r.book, ...brk2(r) })) },
  ];
  return { from: q.from, to: q.to, granularity: q.granularity, rows, totals, byReason, byBook, byProduct, table, extraTables, warnings: [] };
}

function brk2(b: LossBreakdown): Record<string, number> { return { lossCount: b.lossCount, qty: b.qty, costCents: b.costCents }; }
