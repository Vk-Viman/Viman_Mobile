/**
 * TodaySales: small table of today's sales under the POS cart.
 * Where: Sales > POS. API: GET /sales?from=today&to=today (api/sales.ts). `today` is the server's business date
 * (GET /health), so a wrong PC clock cannot show the wrong day. Refreshes by itself after a save because the
 * sales mutations invalidate the sales cache.
 */
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { ErrorState } from '../../components/ErrorState';
import { Money } from '../../components/Money';
import { Spinner } from '../../components/Spinner';
import { BookBadge, PostedStatusBadge } from '../../components/StatusBadges';
import { useSales } from '../../api/sales';
import { formatDateTime } from '../../lib/format';
import type { Sale } from '../../types/api';

/** @param today business date (YYYY-MM-DD); the parent renders this only once it is known. */
export function TodaySales({ today }: { today: string }) {
  const list = useSales({ from: today, to: today, limit: 50 });

  const columns: Column<Sale>[] = [
    {
      key: 'id',
      header: 'Sale / time',
      render: (s) => (
        <span>
          <span className="font-medium">#{s.id}</span>
          <span className="ml-2 text-xs text-slate-500">{formatDateTime(s.postedAt)}</span>
        </span>
      ),
    },
    { key: 'book', header: 'Book', render: (s) => <BookBadge book={s.book} /> },
    { key: 'total', header: 'Total', align: 'right', render: (s) => <Money cents={s.totalCents} /> },
    { key: 'status', header: 'Status', render: (s) => <PostedStatusBadge status={s.status} /> },
  ];

  return (
    <Card title="Today's sales">
      {list.isPending ? (
        <div className="flex justify-center py-6"><Spinner label="Loading today's sales" /></div>
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable columns={columns} rows={list.data.items} rowKey={(s) => s.id} emptyTitle="No sales yet today" />
      )}
    </Card>
  );
}
