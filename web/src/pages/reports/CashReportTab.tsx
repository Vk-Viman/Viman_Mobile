/**
 * CashReportTab (route "/reports/cash"): the cash book report and the transfers report (Phase 11, BUSINESS_RULES 8, 10.1, 10.2, R14).
 *
 * The owner picks a book (Shop / Telecom / Ice Cream, kept in the URL) and a period. The screen shows, per period, the opening
 * balance, money in, money out and closing balance; the totals by entry type; for Ice Cream the same per fund (Cost, Electricity,
 * Profit - fund closings add up to the book); and, below, the posted transfers between the books with totals by direction.
 * All figures come from GET /reports/cashbook/:book and GET /reports/transfers; this screen only arranges them.
 * A cash book is cash, not profit: the Telecom book is not expected to match Telecom profit (R14), and transfers are never income.
 */
import { Card } from '../../components/Card';
import { Money } from '../../components/Money';
import { useCashbookReport, useTransfersReport } from '../../api/reportsFinancial';
import type { FinBook } from '../../types/reportsFinancial';
import { FinState, FinSwitch, FinTile, FinTiles, FinWarnings, useUrlChoice } from './finParts';
import { ReportTableView, ReportToolbar, useReportPeriod } from './shared';

const BOOKS: ReadonlyArray<{ value: FinBook; label: string }> = [
  { value: 'shop', label: 'Shop' }, { value: 'telecom', label: 'Telecom' }, { value: 'icecream', label: 'Ice Cream' },
];

/** The transfers section: totals by direction per period and the list of posted transfers. */
function TransfersSection({ period }: { period: ReturnType<typeof useReportPeriod>['period'] }) {
  const query = useTransfersReport(period);
  return (
    <FinState query={query}>
      {(t) => (
        <Card title="Transfers between the books" className="mt-4">
          <p className="mb-3 text-sm text-slate-600">
            Moving cash from one book to another is not income or cost. Total moved in the period: <Money cents={t.totals.totalCents} className="font-semibold" /> in {t.totals.count} transfer{t.totals.count === 1 ? '' : 's'}.
          </p>
          <ReportTableView table={t.table} />
          {t.items.length > 0 && <div className="mt-4"><ReportTableView table={t.itemsTable} /></div>}
        </Card>
      )}
    </FinState>
  );
}

/** The Cash books report tab. */
export function CashReportTab() {
  const { period, set } = useReportPeriod();
  const [book, setBook] = useUrlChoice<FinBook>('book', ['shop', 'telecom', 'icecream'], 'shop');
  const query = useCashbookReport(book, period);
  return (
    <div>
      <FinSwitch label="Cash book" options={BOOKS} value={book} onChange={setBook} />
      <ReportToolbar period={period} set={set} downloadPath={`/reports/cashbook/${book}`} />
      <FinState query={query}>
        {(r) => (
          <>
            <FinWarnings warnings={r.warnings} />
            <FinTiles>
              <FinTile label="Opening balance" cents={r.totals.openingCents} hint={`Balance before ${r.from}`} />
              <FinTile label="Money in" cents={r.totals.inCents} />
              <FinTile label="Money out" cents={r.totals.outCents} />
              <FinTile label="Closing balance" cents={r.totals.closingCents} emphasis
                hint={r.totals.closingCents === r.ledgerBalanceAsOfToCents ? `Equals the cash book balance at ${r.to}` : 'Does not match the ledger - please contact support'} />
            </FinTiles>
            <Card title={r.table.title} className="mb-4"><ReportTableView table={r.table} /></Card>
            <Card title="Totals by entry type" className="mb-4"><ReportTableView table={r.typeTable} /></Card>
            {r.fundTable && (
              <Card title="Ice Cream funds" className="mb-4">
                <p className="mb-3 text-sm text-slate-600">
                  The Ice Cream cash is split into Cost, Electricity and Profit funds. The three closing balances add up to the cash book. A fund balance is not income.
                </p>
                <ReportTableView table={r.fundTable} />
              </Card>
            )}
          </>
        )}
      </FinState>
      <TransfersSection period={period} />
    </div>
  );
}
