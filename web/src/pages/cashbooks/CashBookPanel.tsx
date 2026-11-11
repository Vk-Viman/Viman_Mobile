/**
 * CashBookPanel: everything about ONE cash book on the Cash Books screen: period picker, opening / in / out / closing tiles,
 * the actions (count cash, close day), the Ice Cream fund block, the opening balance card, the closed days and the ledger.
 * Data: GET /cashbooks/:book (via LedgerCard), GET /cashbooks (fund balances); every figure is calculated by the server
 * (BUSINESS_RULES section 8: closing = opening + in - out). The period defaults to "this month"; "All time" sends no dates.
 */
import { useCallback, useState } from 'react';
import { CalendarCheck, Calculator } from 'lucide-react';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DateRangeFields } from '../../components/FilterFields';
import { Money } from '../../components/Money';
import type { CashBook, CashBookLedger, CashBookSummary } from '../../types/cashbooks';
import { CashCountDialog } from './CashCountDialog';
import { ClosingsCard } from './ClosingsCard';
import { CloseDayDialog } from './CloseDayDialog';
import { FundBalances } from './FundBalances';
import { LedgerCard } from './LedgerCard';
import { OpeningCard } from './OpeningCard';
import { CASHBOOK_LABEL, monthStart } from './shared';

interface Props {
  book: CashBook;
  /** The server's business date (Asia/Colombo): the default end of the period. */
  today: string;
  /** This book's line of GET /cashbooks (balance, funds, last closed day). */
  summary: CashBookSummary | undefined;
}

/** A summary tile: a label above a money figure. */
function Tile({ label, cents, strong = false }: { label: string; cents: number | undefined; strong?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-lg ${strong ? 'font-bold' : 'font-semibold'}`}>{cents === undefined ? '…' : <Money cents={cents} />}</p>
    </div>
  );
}

/** The panel of the selected book. */
export function CashBookPanel({ book, today, summary }: Props) {
  // null = the default period (this month up to today); { '', '' } = all time.
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const from = range ? range.from : monthStart(today);
  const to = range ? range.to : today;
  const [ledger, setLedger] = useState<CashBookLedger | undefined>(undefined);
  const [counting, setCounting] = useState(false);
  const [closing, setClosing] = useState(false);
  const onLoaded = useCallback((l: CashBookLedger | undefined) => setLedger(l), []);

  return (
    <div className="space-y-5">
      <Card title={`${CASHBOOK_LABEL[book]} cash book`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setCounting(true)}><Calculator size={16} aria-hidden="true" /> Count cash</Button>
            <Button onClick={() => setClosing(true)}><CalendarCheck size={16} aria-hidden="true" /> Close day</Button>
          </div>
        }>
        <div className="mb-4 grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <DateRangeFields from={from} to={to} onFrom={(v) => setRange({ from: v, to })} onTo={(v) => setRange({ from, to: v })} />
          <div className="flex gap-2 sm:col-span-2 lg:col-span-2">
            <Button variant="secondary" onClick={() => setRange(null)}>This month</Button>
            <Button variant="secondary" onClick={() => setRange({ from: '', to: '' })}>All time</Button>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Opening balance" cents={ledger?.openingCents} />
          <Tile label="Money in" cents={ledger?.inCents} />
          <Tile label="Money out" cents={ledger?.outCents} />
          <Tile label="Closing balance" cents={ledger?.closingCents} strong />
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Closing = opening + money in − money out for the period. Balance of the whole book today:{' '}
          {summary ? <Money cents={summary.balanceCents} className="font-semibold" /> : '…'}
          {summary?.lastClosedDate && <> · last closed day {summary.lastClosedDate}</>}.
        </p>
      </Card>

      {book === 'icecream' && <FundBalances balances={summary?.funds} bookCents={summary?.balanceCents} period={ledger?.funds} />}
      <OpeningCard book={book} />
      <ClosingsCard book={book} from={from} to={to} />
      <LedgerCard book={book} from={from} to={to} onLoaded={onLoaded} />

      {counting && <CashCountDialog book={book} onClose={() => setCounting(false)} />}
      {closing && <CloseDayDialog book={book} onClose={() => setClosing(false)} />}
    </div>
  );
}
