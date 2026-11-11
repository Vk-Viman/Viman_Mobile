/**
 * LedgerCard: the cash ledger of one book for the selected period, with the running balance (BUSINESS_RULES section 8).
 * Data: GET /cashbooks/:book (api/cashbooks.ts), paged by the server; the running balance of every row is calculated by the
 * server over the WHOLE period, so page 2 continues exactly where page 1 stopped. Rows are ordered by business date, then
 * posting order. A void shows as its own "reversal" row (R1). Ice Cream rows carry the fund column (10.2). A date that is closed
 * for this book carries a "Closed" badge (R9).
 */
import { useEffect, useState } from 'react';
import { Badge } from '../../components/Badge';
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { ErrorState } from '../../components/ErrorState';
import { Money } from '../../components/Money';
import { Pager } from '../../components/Pager';
import { Spinner } from '../../components/Spinner';
import { useCashBookLedger } from '../../api/cashbooks';
import { PAGE_SIZE } from '../../lib/constants';
import type { CashBook, CashBookLedger, LedgerItem } from '../../types/cashbooks';
import { FUND_LABEL, entryLabel } from './shared';

interface Props {
  book: CashBook;
  from: string;
  to: string;
  /** Receives the ledger when it has loaded (the panel shows its totals and fund movement). */
  onLoaded: (ledger: CashBookLedger | undefined) => void;
}

/** The ledger table with its pager. */
export function LedgerCard({ book, from, to, onLoaded }: Props) {
  const [page, setPage] = useState(0);
  // A new book or period always starts at the first page.
  useEffect(() => { setPage(0); }, [book, from, to]);
  const ledger = useCashBookLedger(book, { from: from || undefined, to: to || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  useEffect(() => { onLoaded(ledger.data); }, [ledger.data, onLoaded]);

  const closed = new Set(ledger.data?.closedDates ?? []);
  const columns: Column<LedgerItem>[] = [
    {
      key: 'date', header: 'Date',
      render: (r) => <span className="inline-flex flex-wrap items-center gap-2">{r.businessDate}{closed.has(r.businessDate) && <Badge tone="neutral">Closed</Badge>}</span>,
    },
    {
      key: 'type', header: 'What',
      render: (r) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          <span className="font-medium text-slate-900">{entryLabel(r.type)}</span>
          {r.reversesEntryId !== null && <Badge tone="amber">Reversal</Badge>}
        </span>
      ),
    },
    ...(book === 'icecream' ? [{ key: 'fund', header: 'Fund', render: (r: LedgerItem) => (r.fund ? FUND_LABEL[r.fund] : '—') }] : []),
    { key: 'note', header: 'Reference', render: (r) => <span className="text-slate-600">{r.note || (r.refTable ? `${r.refTable.replace(/_/g, ' ')} #${r.refId}` : '—')}</span> },
    { key: 'in', header: 'Money in (Rs.)', align: 'right', render: (r) => (r.amountCents > 0 ? <Money cents={r.amountCents} /> : '') },
    { key: 'out', header: 'Money out (Rs.)', align: 'right', render: (r) => (r.amountCents < 0 ? <Money cents={-r.amountCents} /> : '') },
    { key: 'bal', header: 'Balance (Rs.)', align: 'right', render: (r) => <Money cents={r.runningBalanceCents} className="font-semibold" /> },
  ];

  return (
    <Card title="Ledger">
      {ledger.isPending ? (
        <div className="flex justify-center py-12"><Spinner label="Loading the ledger" /></div>
      ) : ledger.isError ? (
        <ErrorState error={ledger.error} onRetry={() => void ledger.refetch()} />
      ) : (
        <>
          <p className="mb-3 text-sm text-slate-600">
            Balance brought forward: <Money cents={ledger.data.openingCents} className="font-semibold" />. Each row shows the balance after it.
          </p>
          <DataTable columns={columns} rows={ledger.data.items} rowKey={(r) => r.id}
            emptyTitle="No cash movements in this period" emptyHint="Try a wider period, or set the opening balance to start the book." />
          <Pager page={page} total={ledger.data.total} limit={PAGE_SIZE} noun="entries" onPage={setPage} />
        </>
      )}
    </Card>
  );
}
