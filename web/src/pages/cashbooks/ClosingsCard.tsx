/**
 * ClosingsCard: the days closed (or reopened) for one cash book, with "Reopen" (Cash Books screen).
 * Data: GET /daily-closings?book&from&to (api/cashbooks.ts); each row carries `isClosed`, computed by the server.
 * A closed day refuses every record dated that day in this book until it is reopened (R9); reopening needs a reason and is
 * audited. The expected / counted / over-short figures are what the server saved when the day was closed.
 */
import { useState } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { ErrorState } from '../../components/ErrorState';
import { Money } from '../../components/Money';
import { Spinner } from '../../components/Spinner';
import { useDailyClosings } from '../../api/cashbooks';
import { formatDateTime } from '../../lib/format';
import type { CashBook, DailyClosing } from '../../types/cashbooks';
import { ReopenDayDialog } from './ReopenDayDialog';

/** Closed / reopened days of the book inside the period. */
export function ClosingsCard({ book, from, to }: { book: CashBook; from: string; to: string }) {
  const closings = useDailyClosings({ book, ...(from ? { from } : {}), ...(to ? { to } : {}) });
  const [reopening, setReopening] = useState<DailyClosing | null>(null);

  const columns: Column<DailyClosing>[] = [
    { key: 'date', header: 'Day', render: (c) => <span className="font-medium text-slate-900">{c.businessDate}</span> },
    {
      key: 'state', header: 'State',
      render: (c) => (
        <span>
          {c.isClosed ? <Badge tone="neutral">Closed</Badge> : <Badge tone="amber">Reopened</Badge>}
          {!c.isClosed && c.reopenReason && <span className="mt-1 block text-xs text-slate-500">{c.reopenReason}</span>}
        </span>
      ),
    },
    { key: 'expected', header: 'Books said (Rs.)', align: 'right', render: (c) => <Money cents={c.expectedCents} /> },
    { key: 'counted', header: 'Counted (Rs.)', align: 'right', render: (c) => (c.countedCents === null ? 'Not counted' : <Money cents={c.countedCents} />) },
    { key: 'diff', header: 'Over / short (Rs.)', align: 'right', render: (c) => (c.countedCents === null ? '—' : <Money cents={c.overShortCents} />) },
    { key: 'at', header: 'Closed at', render: (c) => <span className="text-slate-600">{formatDateTime(c.closedAt)}</span> },
    {
      key: 'act', header: 'Actions',
      render: (c) => (c.isClosed ? <Button variant="ghost" onClick={() => setReopening(c)} aria-label={`Reopen ${c.businessDate}`}>Reopen</Button> : null),
    },
  ];

  return (
    <Card title="Closed days">
      {closings.isPending ? (
        <div className="flex justify-center py-8"><Spinner label="Loading closed days" /></div>
      ) : closings.isError ? (
        <ErrorState error={closings.error} onRetry={() => void closings.refetch()} />
      ) : (
        <DataTable columns={columns} rows={closings.data.items} rowKey={(c) => c.id}
          emptyTitle="No days closed in this period" emptyHint="Use “Close day” when you have counted the drawer. A closed day cannot be changed until you reopen it." />
      )}
      {reopening && <ReopenDayDialog closing={reopening} onClose={() => setReopening(null)} />}
    </Card>
  );
}
