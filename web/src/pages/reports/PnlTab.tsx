/**
 * PnlTab (route "/reports"): profit and loss for Shop, Telecom, Ice Cream and Combined (Phase 11, BUSINESS_RULES 1, 5-7, 10.3-10.6, E5, C13).
 *
 * The owner picks a segment (kept in the URL) and a period (shared toolbar); the screen shows the summary tiles, the
 * per-period table, the expense breakdown, the notes and the warnings, and a "Download Excel" link for the same figures.
 * Every number is calculated by the server (GET /reports/pnl/:segment); this screen only arranges them.
 * Rules shown to the owner: Combined profit is the OFFICIAL sum of the three segments; the electricity lines are information only
 * (E5); Ice Cream shows recognized profit and, whenever excess cost exists, the three period-flow lines (10.5).
 */
import { Card } from '../../components/Card';
import { Money } from '../../components/Money';
import { usePnl } from '../../api/reportsFinancial';
import type { CombinedPnl, ExpenseLines, IceCreamPnl, PnlSegment, ShopPnl, TelecomPnl } from '../../types/reportsFinancial';
import { ExcessCostBlock, FinState, FinSwitch, FinTile, FinTiles, FinWarnings, useUrlChoice } from './finParts';
import { ReportTableView, ReportToolbar, useReportPeriod } from './shared';

const SEGMENTS: ReadonlyArray<{ value: PnlSegment; label: string }> = [
  { value: 'shop', label: 'Shop' }, { value: 'telecom', label: 'Telecom' }, { value: 'icecream', label: 'Ice Cream' }, { value: 'combined', label: 'Combined' },
];

/** Owner-facing names of the nine expense categories (BUSINESS_RULES 7; there is no electricity category). */
const CATEGORY_LABEL: Record<string, string> = {
  water: 'Water', rent: 'Rent', internet: 'Internet', transport: 'Transport', repairs: 'Repairs', cleaning_supplies: 'Cleaning supplies',
  packaging: 'Packaging', stationery: 'Stationery', other: 'Other',
};

/** Expenses by category: only the categories that have an amount in the period. */
function ExpenseBreakdown({ expenses }: { expenses: ExpenseLines }) {
  const used = Object.entries(expenses.byCategory).filter(([, v]) => v !== 0);
  if (used.length === 0) return null;
  return (
    <Card title="Operating expenses by category" className="mb-4">
      <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {used.map(([cat, cents]) => (
          <li key={cat} className="flex justify-between border-b border-slate-100 py-1"><span>{CATEGORY_LABEL[cat] ?? cat}</span><Money cents={cents} /></li>
        ))}
      </ul>
    </Card>
  );
}

function ShopView({ data }: { data: ShopPnl }) {
  const t = data.totals;
  return (
    <>
      <FinTiles>
        <FinTile label="Goods gross profit" cents={t.goods.grossProfitCents} hint="Sales net of returns, minus cost (automatic + extra)" />
        <FinTile label="Services gross profit" cents={t.services.grossProfitCents} hint="Print / photocopy sales minus standard cost" />
        <FinTile label="Operating expenses" cents={t.expenses.totalCents} />
        <FinTile label="Stock adjustments (net)" cents={t.adjustments.netCents} hint="Losses and stocktake differences" />
        <FinTile label="Net profit" cents={t.netProfitCents} emphasis hint="After cash over / short" />
      </FinTiles>
      <ExpenseBreakdown expenses={t.expenses} />
    </>
  );
}

function TelecomView({ data }: { data: TelecomPnl }) {
  const t = data.totals;
  return (
    <>
      <FinTiles>
        <FinTile label="Commission income" cents={t.commissionRevenueCents} hint="Reload (with rounding extra) + EZCash commission" />
        <FinTile label="Scratch-card gross profit" cents={t.cards.grossProfitCents} />
        <FinTile label="Operating expenses" cents={t.expenses.totalCents} />
        <FinTile label="Stock adjustments (net)" cents={t.adjustments.netCents} />
        <FinTile label="Net profit" cents={t.netProfitCents} emphasis hint="After cash over / short" />
      </FinTiles>
      <Card title="Cash only - not income or cost" className="mb-4">
        <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <li className="flex justify-between border-b border-slate-100 py-1"><span>Reload collected</span><Money cents={t.commissions.reloadSalesCents} /></li>
          <li className="flex justify-between border-b border-slate-100 py-1"><span>EZCash bills collected</span><Money cents={t.commissions.ezcashBillCents} /></li>
          <li className="flex justify-between border-b border-slate-100 py-1"><span>Provider top-ups</span><Money cents={t.memo.providerTopupsCents} /></li>
          <li className="flex justify-between border-b border-slate-100 py-1"><span>Wallet top-ups</span><Money cents={t.memo.walletTopupsCents} /></li>
        </ul>
      </Card>
      <ExpenseBreakdown expenses={t.expenses} />
    </>
  );
}

function IceCreamView({ data }: { data: IceCreamPnl }) {
  const t = data.totals;
  return (
    <>
      <FinTiles>
        <FinTile label="Sales" cents={t.salesCents} />
        <FinTile label="Materials (allocated)" cents={t.materialsChargeCents} />
        <FinTile label="Electricity (allocated)" cents={t.electricityChargeCents} hint="The whole shop's electricity" />
        <FinTile label="Recognized profit" cents={t.recognizedProfitCents} emphasis hint="The official Ice Cream profit" />
      </FinTiles>
      <ExcessCostBlock recognizedLabel="Recognized profit" recognizedCents={t.recognizedProfitCents} excessCents={t.excessCostNotChargedCents}
        afterCents={t.profitAfterExcessCostCents} outstandingCents={t.balancesAsOfPeriodEnd.outstandingExcessCostCents} asOf={data.to} />
      <Card title="Memo - what was actually paid" className="mb-4">
        <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <li className="flex justify-between border-b border-slate-100 py-1"><span>Materials paid</span><Money cents={t.memo.actualMaterialsPaidCents} /></li>
          <li className="flex justify-between border-b border-slate-100 py-1"><span>Electricity bills paid</span><Money cents={t.memo.actualElectricityPaidCents} /></li>
          <li className="flex justify-between border-b border-slate-100 py-1"><span>Other costs from Cost / Electricity funds</span><Money cents={t.memo.otherCostsFromCostElecFundsCents} /></li>
          <li className="flex justify-between border-b border-slate-100 py-1"><span>Other costs from the Profit Fund (expense)</span><Money cents={t.otherExpensesCents} /></li>
          <li className="flex justify-between border-b border-slate-100 py-1"><span>Unspent allocation at {data.to}</span><Money cents={t.balancesAsOfPeriodEnd.unspentCents} /></li>
        </ul>
        <p className="mt-2 text-xs text-slate-500">Paying a supplier or the electricity bill settles the daily allocation; it is never a second expense.</p>
      </Card>
    </>
  );
}

function CombinedView({ data }: { data: CombinedPnl }) {
  const t = data.totals;
  return (
    <>
      <FinTiles>
        <FinTile label="Shop profit" cents={t.segments.shop.recognizedProfitCents} />
        <FinTile label="Telecom profit" cents={t.segments.telecom.recognizedProfitCents} />
        <FinTile label="Ice Cream recognized profit" cents={t.segments.icecream.recognizedProfitCents} />
        <FinTile label="Combined profit (official)" cents={t.recognizedProfitCents} emphasis hint="Shop + Telecom + Ice Cream recognized" />
      </FinTiles>
      <ExcessCostBlock recognizedLabel="Combined recognized profit" recognizedCents={t.recognizedProfitCents} excessCents={t.icecreamExcessCostNotChargedCents}
        afterCents={t.combinedProfitAfterExcessCostCents} outstandingCents={t.outstandingExcessCostCents} asOf={data.to} />
      <Card title="Electricity - for information only" className="mb-4">
        <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <li className="flex justify-between border-b border-slate-100 py-1"><span>Electricity charged in the period</span><Money cents={t.electricityChargedCents} /></li>
          <li className="flex justify-between border-b border-slate-100 py-1"><span>Electricity bills actually paid (memo)</span><Money cents={t.electricityBillsPaidCents} /></li>
        </ul>
        <p className="mt-2 text-xs text-slate-500">The whole shop electricity bill is carried by the Ice Cream book. These lines are never added to or deducted from any profit above.</p>
      </Card>
    </>
  );
}

/** The Profit & loss tab. */
export function PnlTab() {
  const { period, set } = useReportPeriod();
  const [segment, setSegment] = useUrlChoice<PnlSegment>('segment', ['shop', 'telecom', 'icecream', 'combined'], 'combined');
  const query = usePnl(segment, period);
  return (
    <div>
      <FinSwitch label="Segment" options={SEGMENTS} value={segment} onChange={setSegment} />
      <ReportToolbar period={period} set={set} downloadPath={`/reports/pnl/${segment}`} />
      <FinState query={query}>
        {(data) => (
          <>
            <FinWarnings warnings={data.warnings} />
            {segment === 'shop' && <ShopView data={data as ShopPnl} />}
            {segment === 'telecom' && <TelecomView data={data as TelecomPnl} />}
            {segment === 'icecream' && <IceCreamView data={data as IceCreamPnl} />}
            {segment === 'combined' && <CombinedView data={data as CombinedPnl} />}
            <Card title={data.table.title}><ReportTableView table={data.table} /></Card>
          </>
        )}
      </FinState>
    </div>
  );
}
