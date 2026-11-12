/**
 * FundsTab (route "/ice-cream/funds"): the Ice Cream funds overview and the fund ledger.
 * API: GET /icecream/funds?asOf=&from= and GET /icecream/funds/entries (api/icecream.ts). Nothing is calculated here.
 *
 * Two SEPARATE measures, never mixed (BUSINESS_RULES 10.1):
 *  - FUND BALANCES (Cost, Electricity, Profit): how the Ice Cream cash is set aside. They always add up to the Ice Cream cash book
 *    (shown as a check) and a fund may be below zero (red, a warning). A fund balance is not income;
 *  - RECOGNIZED PROFIT: the official Ice Cream profit, changed only by the recognition events of 10.3.
 * The Charged / Settled / Unspent lines (10.4) show how much of the daily allocations is still unspent. When real spending went past the
 * allocations (Unspent below zero) the screen shows the excess-cost warning and the three period-flow lines of 10.5 / 10.6: recognized
 * profit, excess cost not yet charged (the CHANGE in the excess during the period) and profit after excess cost. Official profit is never
 * reduced automatically. `asOf` and `from` are business dates (10.6). The fund ledger lists every row, voids shown as reversals (10.7).
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { DateRangeFields } from '../../components/FilterFields';
import { Money } from '../../components/Money';
import { Pager } from '../../components/Pager';
import { SelectField } from '../../components/SelectField';
import { Spinner } from '../../components/Spinner';
import { TextField } from '../../components/TextField';
import { useFundLedger, useFunds } from '../../api/icecream';
import { PAGE_SIZE } from '../../lib/constants';
import { formatLKR } from '../../lib/format';
import type { IceFund } from '../../types/cashbooks';
import type { ExcessCostWarning, FundEntry, FundsSummary, LineState } from '../../types/icecream';
import { FUNDS, FUND_ENTRY_LABEL, FUND_LABEL } from './shared';

/** Signed money for a flow: "+Rs. 5,000.00" or "−Rs. 5,000.00" (the minus is a real minus sign). */
function signed(cents: number): string {
  return cents > 0 ? `+${formatLKR(cents)}` : cents < 0 ? `−${formatLKR(-cents)}` : formatLKR(0);
}

/** The three fund tiles and the "adds up to the cash book" check (10.1). */
function FundTiles({ s }: { s: FundsSummary }) {
  return (
    <Card title="Fund balances">
      <p className="mb-3 text-sm text-slate-600">
        The Ice Cream cash is split into three funds. This split only shows what the cash is set aside for - it is not income.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {FUNDS.map((f) => {
          const cents = s.funds[f].balanceCents;
          return (
            <div key={f} className={`rounded-lg border p-3 ${cents < 0 ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-slate-50'}`}>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{FUND_LABEL[f]} fund</p>
              <p className="mt-1 text-lg font-semibold"><Money cents={cents} /></p>
              {cents < 0 && <p className="mt-1 text-xs text-red-700">Below zero: more was paid out of this fund than it holds.</p>}
            </div>
          );
        })}
      </div>
      <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-700">
        {s.reconciled ? <CheckCircle2 size={16} className="text-brand-600" aria-hidden="true" /> : <AlertTriangle size={16} className="text-red-600" aria-hidden="true" />}
        <span>
          Cost + Electricity + Profit = <Money cents={s.totalCents} className="font-semibold" />
          {s.reconciled ? <span className="text-slate-500"> - the same as the Ice Cream cash book ({formatLKR(s.cashBookBalanceCents)}).</span>
            : <span className="font-medium text-red-700"> - this does NOT match the Ice Cream cash book (<Money cents={s.cashBookBalanceCents} />). Please contact support.</span>}
        </span>
      </p>
    </Card>
  );
}

/** Charged / Settled / Unspent of one line as a table row. */
function LineRow({ label, line }: { label: string; line: LineState }) {
  return (
    <tr className="border-b border-slate-100">
      <th scope="row" className="px-3 py-2 text-left font-medium text-slate-900">{label}</th>
      <td className="num px-3 py-2 text-right"><Money cents={line.chargedCents} /></td>
      <td className="num px-3 py-2 text-right"><Money cents={line.settledCents} /></td>
      <td className="num px-3 py-2 text-right font-semibold"><Money cents={line.unspentCents} /></td>
    </tr>
  );
}

/** The Charged / Settled / Unspent table of 10.4. */
function LinesCard({ s }: { s: FundsSummary }) {
  return (
    <Card title="Set aside and spent (Charged, Settled, Unspent)">
      <p className="mb-3 text-sm text-slate-600">
        <strong>Charged</strong> is what the daily entries set aside (adjusted by releases, charge-backs and re-labels). <strong>Settled</strong> is what was actually paid.
        <strong> Unspent</strong> is the difference: the part still available to release into profit.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              {['Line', 'Charged', 'Settled', 'Unspent'].map((h, i) => (
                <th key={h} scope="col" className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <LineRow label="Materials (Cost fund)" line={s.lines.materials} />
            <LineRow label="Electricity" line={s.lines.electricity} />
            <tr>
              <th scope="row" className="px-3 py-2 text-left font-semibold text-slate-900">Both lines</th>
              <td className="px-3 py-2" /><td className="px-3 py-2" />
              <td className="num px-3 py-2 text-right font-semibold"><Money cents={s.unspentAllocationCents} /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** Recognized profit (official), the excess-cost warning and the three period-flow lines (10.3, 10.5, 10.6). */
function ProfitCard({ s, asOfLabel }: { s: FundsSummary; asOfLabel: string }) {
  const excess = s.warnings.find((w): w is ExcessCostWarning => w.code === 'EXCESS_COST_OUTSTANDING');
  const r = s.recognition;
  const flows = s.period;
  const showFlows = Boolean(excess) || flows.excessCostNotChargedCents !== 0;
  const periodText = flows.from ? `${flows.from} to ${flows.to ?? 'today'}` : flows.to ? `the beginning to ${flows.to}` : 'the beginning to today';
  return (
    <Card title="Recognized profit (official)">
      <p className="mb-3 text-sm text-slate-600">
        This is the official Ice Cream profit. It changes only through daily entries, releases to Profit, charge-backs from Profit, other costs paid from Profit and cash over / short -
        never through the fund balances above, withdrawals or transfers.
      </p>
      <p className="text-sm text-slate-600">Recognized profit {asOfLabel}</p>
      <p className="text-2xl font-semibold"><Money cents={s.recognizedProfitToDateCents} /></p>
      <dl className="mt-3 grid max-w-md grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        <dt className="text-slate-600">Daily profit shares</dt><dd><Money cents={r.dailyProfitShareCents} /></dd>
        <dt className="text-slate-600">Released to Profit (profit-eligible part)</dt><dd><Money cents={r.profitEligibleReleasesCents} /></dd>
        <dt className="text-slate-600">Charged back from Profit</dt><dd><Money cents={r.reallocationsCents} /></dd>
        <dt className="text-slate-600">Other costs paid from Profit</dt><dd><Money cents={r.otherExpensesCents} /></dd>
        <dt className="text-slate-600">Cash over / short</dt><dd><Money cents={r.cashOverShortCents} /></dd>
      </dl>

      {excess && (
        <div role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600" aria-hidden="true" />
          <div>
            <p className="font-semibold">Excess cost outstanding: {formatLKR(excess.outstandingExcessCostCents)} as of {excess.asOf}</p>
            <p className="mt-1">{excess.message}</p>
          </div>
        </div>
      )}
      {showFlows && (
        <div className="mt-4 rounded-lg border border-slate-200 p-3 text-sm">
          <p className="font-medium text-slate-900">For the period {periodText}</p>
          <dl className="mt-2 grid max-w-xl grid-cols-[1fr_auto] gap-x-4 gap-y-1">
            <dt className="text-slate-600">Recognized profit</dt>
            <dd><Money cents={flows.recognizedProfitCents} className="font-semibold" /></dd>
            <dt className="text-slate-600">Excess cost not yet charged</dt>
            <dd className={`num whitespace-nowrap font-semibold ${flows.excessCostNotChargedCents > 0 ? 'text-amber-800' : ''}`}>
              {flows.excessCostNotChargedCents < 0 ? `${signed(flows.excessCostNotChargedCents)} (earlier excess now covered)` : signed(flows.excessCostNotChargedCents)}
            </dd>
            <dt className="text-slate-600">Profit after excess cost</dt>
            <dd><Money cents={flows.profitAfterExcessCostCents} className="font-semibold" /></dd>
          </dl>
          <p className="mt-2 text-xs text-slate-500">
            These three lines only use what happened inside the period, so they add up from day to month to year. &quot;Excess cost not yet charged&quot; is the change
            in the excess during the period; the outstanding balance is {formatLKR(s.outstandingExcessCostCents)}.
          </p>
        </div>
      )}
    </Card>
  );
}

/** The fund ledger with its filters. */
function LedgerCard() {
  const [fund, setFund] = useState<'' | IceFund>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [fund, from, to]);
  const ledger = useFundLedger({ fund: fund || undefined, from: from || undefined, to: to || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE });

  const columns: Column<FundEntry>[] = [
    { key: 'date', header: 'Date', render: (e) => e.businessDate },
    { key: 'fund', header: 'Fund', render: (e) => FUND_LABEL[e.fund] },
    {
      key: 'what', header: 'What',
      render: (e) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          {FUND_ENTRY_LABEL[e.kind]}
          {e.kind === 'reversal' && <Badge tone="red">Cancels #{e.reversesEntryId}</Badge>}
          {e.note && <span className="text-xs text-slate-500">{e.note}</span>}
        </span>
      ),
    },
    { key: 'amount', header: 'Amount (Rs.)', align: 'right', render: (e) => <Money cents={e.amountCents} /> },
    { key: 'id', header: 'Row', align: 'right', render: (e) => <span className="text-xs text-slate-500">#{e.id}</span> },
  ];

  return (
    <Card title="Fund ledger">
      <p className="mb-3 text-sm text-slate-600">Every movement of the three funds, oldest first. A void appears as a reversal row that cancels the original; nothing is ever deleted.</p>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <DateRangeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
        <SelectField label="Fund" value={fund} onChange={(e) => setFund(e.target.value as '' | IceFund)}>
          <option value="">All funds</option>
          {FUNDS.map((f) => <option key={f} value={f}>{FUND_LABEL[f]} fund</option>)}
        </SelectField>
      </div>
      {ledger.isPending ? (
        <div className="flex justify-center py-12"><Spinner label="Loading the fund ledger" /></div>
      ) : ledger.isError ? (
        <ErrorState error={ledger.error} onRetry={() => void ledger.refetch()} />
      ) : ledger.data.total === 0 && !(fund || from || to) ? (
        <EmptyState title="No fund movements yet" hint="Daily entries, payments and fund moves appear here." />
      ) : (
        <>
          <p className="mb-3 text-sm font-semibold text-slate-900">
            In <span className="num">{formatLKR(ledger.data.totals.inCents)}</span>, out <span className="num">{formatLKR(ledger.data.totals.outCents)}</span>, net <span className="num">{formatLKR(ledger.data.totals.netCents)}</span>
            <span className="font-normal text-slate-500"> for the rows that match these filters.</span>
          </p>
          <DataTable columns={columns} rows={ledger.data.items} rowKey={(e) => e.id} emptyTitle="No fund movements match these filters" emptyHint="Try a different date range or fund." />
          <Pager page={page} total={ledger.data.total} limit={PAGE_SIZE} noun="rows" onPage={setPage} />
        </>
      )}
    </Card>
  );
}

/** The Funds screen. */
export function FundsTab() {
  const [asOf, setAsOf] = useState('');
  const [from, setFrom] = useState('');
  const funds = useFunds({ asOf: asOf || undefined, from: from || undefined });
  const bad = from !== '' && asOf !== '' && from > asOf;

  return (
    <div className="space-y-5">
      <Card title="Show figures as of a date">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="As of date (blank = now)" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          <TextField label="Period starts on (optional)" type="date" value={from} max={asOf || undefined} onChange={(e) => setFrom(e.target.value)}
            hint="Used for the three period lines under Recognized profit; blank = from the beginning." error={bad ? 'The start cannot be after the as-of date.' : undefined} />
        </div>
      </Card>
      {funds.isPending ? (
        <div className="flex justify-center py-12"><Spinner label="Loading the funds" /></div>
      ) : funds.isError ? (
        <ErrorState error={funds.error} onRetry={() => void funds.refetch()} />
      ) : (
        <>
          {funds.data.warnings.filter((w) => w.code === 'NEGATIVE_FUND_BALANCE' || w.code === 'ICECREAM_FUNDS_MISMATCH').map((w) => (
            <p key={w.code + ('fund' in w ? (w.fund ?? '') : '')} role="alert" className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600" aria-hidden="true" />{w.message}
            </p>
          ))}
          <FundTiles s={funds.data} />
          <ProfitCard s={funds.data} asOfLabel={asOf ? `as of ${asOf}` : 'to date'} />
          <LinesCard s={funds.data} />
        </>
      )}
      <LedgerCard />
    </div>
  );
}
