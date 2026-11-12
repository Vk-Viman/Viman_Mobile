/**
 * IceCreamReportTab (route "/reports/icecream"): the Ice Cream profit and loss and the fund statement (Phase 11, BUSINESS_RULES 10.1-10.6).
 *
 * Two measures, always shown apart (10.1):
 *  - RECOGNIZED PROFIT (block 1): sales - materials allocated - electricity allocated - other costs from the Profit Fund +/- over/short, with
 *    the excess-cost lines whenever excess cost exists (period flows, 10.5, 10.6) and the memo of what was actually paid;
 *  - FUND BALANCES (block 2): per fund opening, allocations, money in, moves, payments, drawings, transfers out, over/short and closing; the
 *    three funds add up to the Ice Cream cash book. A fund balance is never income.
 * Figures come from GET /reports/pnl/icecream and GET /reports/icecream-funds; this screen only arranges them.
 */
import { Card } from '../../components/Card';
import { Money } from '../../components/Money';
import { useFundsReport, usePnl } from '../../api/reportsFinancial';
import type { FinFund } from '../../types/reportsFinancial';
import { ExcessCostBlock, FinState, FinTile, FinTiles, FinWarnings } from './finParts';
import { ReportTableView, ReportToolbar, useReportPeriod } from './shared';

const FUND_NAME: Record<FinFund, string> = { cost: 'Cost', electricity: 'Electricity', profit: 'Profit' };
const FUNDS: readonly FinFund[] = ['cost', 'electricity', 'profit'];

/** The Ice Cream report tab. */
export function IceCreamReportTab() {
  const { period, set } = useReportPeriod();
  const pnl = usePnl('icecream', period);
  const funds = useFundsReport(period);
  return (
    <div>
      <ReportToolbar period={period} set={set} downloadPath="/reports/icecream-funds" />
      <h2 className="mb-2 text-base font-semibold text-slate-900">Profit and loss (recognized profit)</h2>
      <FinState query={pnl}>
        {(p) => (
          <>
            <FinWarnings warnings={p.warnings} />
            <FinTiles>
              <FinTile label="Sales" cents={p.totals.salesCents} />
              <FinTile label="Materials (allocated)" cents={p.totals.materialsChargeCents} />
              <FinTile label="Electricity (allocated)" cents={p.totals.electricityChargeCents} hint="The whole shop's electricity" />
              <FinTile label="Recognized profit" cents={p.totals.recognizedProfitCents} emphasis hint="The official Ice Cream profit" />
            </FinTiles>
            <ExcessCostBlock recognizedLabel="Recognized profit" recognizedCents={p.totals.recognizedProfitCents} excessCents={p.totals.excessCostNotChargedCents}
              afterCents={p.totals.profitAfterExcessCostCents} outstandingCents={p.totals.balancesAsOfPeriodEnd.outstandingExcessCostCents} asOf={p.to} />
            <Card title={p.table.title} className="mb-6"><ReportTableView table={p.table} /></Card>
          </>
        )}
      </FinState>

      <h2 className="mb-2 text-base font-semibold text-slate-900">Fund statement (balances)</h2>
      <FinState query={funds}>
        {(f) => (
          <>
            <p className="mb-3 text-sm text-slate-600">
              Fund balances are the Ice Cream cash set aside for materials, electricity and profit. They are shown apart from recognized profit and are never income.
            </p>
            <FinTiles>
              {FUNDS.map((k) => <FinTile key={k} label={`${FUND_NAME[k]} fund at ${f.to}`} cents={f.totals.funds[k].closingCents} />)}
              <FinTile label="Ice Cream cash book" cents={f.totals.cashBookClosingCents} emphasis
                hint={f.totals.reconciled ? 'Cost + Electricity + Profit adds up to the cash book' : 'The funds do NOT add up to the cash book - please contact support'} />
            </FinTiles>
            <Card title={f.table.title} className="mb-4"><ReportTableView table={f.table} /></Card>
            <Card title={f.profitTable.title} className="mb-4">
              <p className="mb-3 text-sm text-slate-600">Recognized profit by event, kept apart from the fund balances above. Total recognized profit: <Money cents={f.totals.profit.recognizedProfitCents} className="font-semibold" />.</p>
              <ReportTableView table={f.profitTable} />
            </Card>
          </>
        )}
      </FinState>
    </div>
  );
}
