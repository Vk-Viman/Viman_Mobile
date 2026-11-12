/**
 * Ice Cream block (BUSINESS_RULES 10.1, 10.5 / D3): the official RECOGNIZED profit and the fund balances are shown in two separate
 * panels so a fund balance is never read as profit. When excess cost is outstanding, the warning and the three period-flow lines are
 * shown; the official profit is never reduced by them.
 */
import { AlertTriangle } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Card } from '../../components/Card';
import { Money } from '../../components/Money';
import type { Dashboard } from '../../types/dashboard';
import { SEGMENT_COLOR } from './segments';

/** @param ice the `icecream` block of the dashboard answer. */
export function IceCreamBlock({ ice }: { ice: Dashboard['icecream'] }) {
  const excess = ice.warnings.find((w) => w.code === 'EXCESS_COST_OUTSTANDING');
  return (
    <Card title="Ice Cream">
      <div className="grid gap-4 md:grid-cols-2">
        <section aria-labelledby="ice-profit" className="rounded-lg border-l-4 p-3" style={{ borderColor: SEGMENT_COLOR.icecream }}>
          <h3 id="ice-profit" className="text-sm font-semibold text-slate-800">Recognized profit (official)</h3>
          <p className="text-2xl font-semibold"><Money cents={ice.recognizedProfitMonthCents} /></p>
          <p className="text-xs text-slate-500">This month</p>
        </section>
        <section aria-labelledby="ice-funds" className="rounded-lg bg-slate-50 p-3">
          <h3 id="ice-funds" className="text-sm font-semibold text-slate-800">Fund balances <span className="font-normal text-slate-500">(not profit)</span></h3>
          <ul className="mt-1 space-y-0.5 text-sm">
            <li className="flex justify-between"><span>Cost</span><Money cents={ice.funds.cost} /></li>
            <li className="flex justify-between"><span>Electricity</span><Money cents={ice.funds.electricity} /></li>
            <li className="flex justify-between"><span>Profit fund</span><Money cents={ice.funds.profit} /></li>
            <li className="flex justify-between border-t border-slate-200 pt-1 font-semibold"><span>Total = Ice Cream cash book</span><Money cents={ice.fundsTotalCents} /></li>
          </ul>
          <p className="mt-1.5">{ice.fundsMatchBook ? <Badge tone="brand">Matches the cash book</Badge> : <Badge tone="red">Does not match the cash book</Badge>}</p>
        </section>
      </div>
      {ice.outstandingExcessCostCents > 0 && (
        <div role="alert" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="flex items-start gap-2 font-semibold"><AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />Excess cost outstanding</p>
          <p className="mt-1">{excess?.message ?? 'More was actually spent than was set aside in the daily allocations. Official profit is not reduced automatically.'}</p>
          <dl className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-xs">Excess cost outstanding now</dt><dd className="font-semibold"><Money cents={ice.outstandingExcessCostCents} /></dd></div>
            <div><dt className="text-xs">Added today</dt><dd className="font-semibold"><Money cents={ice.excessCostNotChargedTodayCents} /></dd></div>
            <div><dt className="text-xs">Added this month</dt><dd className="font-semibold"><Money cents={ice.excessCostNotChargedMonthCents} /></dd></div>
            <div><dt className="text-xs">Profit after excess cost (month)</dt><dd className="font-semibold"><Money cents={ice.profitAfterExcessCostMonthCents} /></dd></div>
          </dl>
        </div>
      )}
    </Card>
  );
}
