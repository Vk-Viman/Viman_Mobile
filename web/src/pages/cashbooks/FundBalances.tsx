/**
 * FundBalances: the Ice Cream fund block of the Cash Books screen (BUSINESS_RULES section 10).
 * Shows the three fund balances (Cost, Electricity, Profit) beside the cash book balance, and the period movement of each fund.
 * Two separate measures, never mixed (10.1): fund balances are an internal split of the cash; they are NOT income, and recognized
 * profit is reported elsewhere. Invariant: Cost + Electricity + Profit = the Ice Cream cash book (the server also checks it and
 * warns if it ever fails). A fund may go below zero: it is shown in red with a warning, never blocked (10.2).
 * Figures come from GET /cashbooks (balances) and GET /cashbooks/icecream (period); nothing is calculated here except
 * adding the three balances for the "adds up" line.
 */
import { Card } from '../../components/Card';
import { Money } from '../../components/Money';
import type { FundPeriod, IceFund } from '../../types/cashbooks';
import { FUNDS, FUND_LABEL } from './shared';

interface Props {
  /** All-time fund balances (GET /cashbooks). */
  balances: Record<IceFund, number> | undefined;
  /** The Ice Cream book balance (all time). */
  bookCents: number | undefined;
  /** Per-fund opening / in / out / closing for the selected period (GET /cashbooks/icecream). */
  period: Record<IceFund, FundPeriod> | undefined;
}

/** Fund tiles, the "adds up to the book" line and the per-fund period table. */
export function FundBalances({ balances, bookCents, period }: Props) {
  if (!balances || bookCents === undefined) return null;
  const sum = FUNDS.reduce((a, f) => a + balances[f], 0);
  return (
    <Card title="Ice Cream funds">
      <p className="mb-3 text-sm text-slate-600">
        The Ice Cream cash is split into three funds. This split is not income: it only shows what the cash is set aside for.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {FUNDS.map((f) => (
          <div key={f} className={`rounded-lg border p-3 ${balances[f] < 0 ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-slate-50'}`}>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{FUND_LABEL[f]} fund</p>
            <p className="mt-1 text-lg font-semibold"><Money cents={balances[f]} /></p>
            {balances[f] < 0 && <p className="mt-1 text-xs text-red-700">Below zero: check the opening balances and payments.</p>}
          </div>
        ))}
      </div>
      <p className="mt-3 text-sm text-slate-700">
        Cost + Electricity + Profit = <Money cents={sum} className="font-semibold" />
        {sum === bookCents ? <span className="text-slate-500"> — the same as the Ice Cream cash book.</span>
          : <span className="font-medium text-red-700"> — this does NOT match the Ice Cream cash book (<Money cents={bookCents} />). Please contact support.</span>}
      </p>
      {period && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="mb-2 text-left text-sm font-semibold text-slate-900">Fund movement in the selected period</caption>
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                {['Fund', 'Opening', 'In', 'Out', 'Closing'].map((h, i) => (
                  <th key={h} scope="col" className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {FUNDS.map((f) => (
                <tr key={f} className="border-b border-slate-100">
                  <th scope="row" className="px-3 py-2 text-left font-medium text-slate-900">{FUND_LABEL[f]}</th>
                  <td className="num px-3 py-2 text-right"><Money cents={period[f].openingCents} /></td>
                  <td className="num px-3 py-2 text-right"><Money cents={period[f].inCents} /></td>
                  <td className="num px-3 py-2 text-right"><Money cents={period[f].outCents} /></td>
                  <td className="num px-3 py-2 text-right font-semibold"><Money cents={period[f].closingCents} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
