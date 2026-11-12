/**
 * TransfersTab (route "/drawings/transfers"): cash moved between the Shop, Telecom and Ice Cream books.
 * API: GET /cash-transfers (filters, totals, paging), POST /cash-transfers, POST /cash-transfers/:id/void (api/transfers.ts).
 *
 * A transfer is one record with a From side and a To side (BUSINESS_RULES section 8); the server writes the two linked cash
 * entries together, so both books always agree. It is never income, cost or profit (section 9). The Book filter matches either
 * side. Voiding never deletes: the server keeps the transfer (shown as "Void") and reverses BOTH sides (R1); it is refused when
 * the day is closed in EITHER book until reopened (R9) and the server's message names the book. Totals count POSTED transfers only.
 */
import { useEffect, useState } from 'react';
import { ArrowRight, Info, Plus } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { DateRangeFields, PostedStatusFilterSelect } from '../../components/FilterFields';
import { Money } from '../../components/Money';
import { Pager } from '../../components/Pager';
import { Spinner } from '../../components/Spinner';
import { PostedStatusBadge } from '../../components/StatusBadges';
import { useToast } from '../../components/Toast';
import { VoidRecordDialog } from '../../components/VoidRecordDialog';
import { useTransfers, useVoidTransfer } from '../../api/transfers';
import { PAGE_SIZE } from '../../lib/constants';
import { notifyCashWarnings } from '../../lib/cashWarnings';
import { formatLKR } from '../../lib/format';
import type { PostedStatus } from '../../types/api';
import type { CashBook } from '../../types/cashbooks';
import type { Transfer, TransferQuery } from '../../types/transfers';
import { bookFundLabel, CashBookBadge, CashBookFilterSelect } from './BookFundFields';
import { TransferDialog } from './TransferDialog';

/** The transfers tab: filter bar, ledger-style list (From -> To) with total, pager, and the transfer / void dialogs. */
export function TransfersTab() {
  const toast = useToast();
  const voidMut = useVoidTransfer();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [book, setBook] = useState<'' | CashBook>('');
  const [status, setStatus] = useState<'' | PostedStatus>('');
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<Transfer | null>(null);

  useEffect(() => { setPage(0); }, [from, to, book, status]);

  const query: TransferQuery = {
    from: from || undefined, to: to || undefined, book: book || undefined, status: status || undefined,
    limit: PAGE_SIZE, offset: page * PAGE_SIZE,
  };
  const list = useTransfers(query);
  const filtered = Boolean(from || to || book || status);

  const columns: Column<Transfer>[] = [
    { key: 'date', header: 'Date', render: (t) => <span className="inline-flex flex-wrap items-center gap-2">{t.businessDate}{t.backdated && <Badge tone="amber">Backdated</Badge>}</span> },
    {
      key: 'move', header: 'From → To',
      render: (t) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          <CashBookBadge book={t.fromBook} fund={t.fromFund} />
          <ArrowRight size={14} className="text-slate-400" aria-label="to" />
          <CashBookBadge book={t.toBook} fund={t.toFund} />
        </span>
      ),
    },
    { key: 'amount', header: 'Amount (Rs.)', align: 'right', render: (t) => <Money cents={t.amountCents} /> },
    { key: 'note', header: 'Note', render: (t) => t.note || '—' },
    {
      key: 'status', header: 'Status',
      render: (t) => (<span><PostedStatusBadge status={t.status} />{t.status === 'void' && t.voidReason && <span className="mt-1 block text-xs text-slate-500">{t.voidReason}</span>}</span>),
    },
    {
      key: 'act', header: 'Actions',
      render: (t) => (t.status === 'posted' ? <Button variant="ghost" onClick={() => setVoiding(t)} aria-label={`Void transfer #${t.id}`}>Void</Button> : null),
    },
  ];

  return (
    <>
      <p className="mb-4 flex items-start gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-600">
        <Info size={18} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />
        <span>A transfer moves cash from one book to another, for example Telecom to Shop. It is not income or an expense and does not change profit.</span>
      </p>
      <Card title="Transfers between books" actions={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Transfer cash</Button>}>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <DateRangeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
          <CashBookFilterSelect value={book} onChange={setBook} />
          <PostedStatusFilterSelect value={status} onChange={setStatus} />
        </div>

        {list.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading transfers" /></div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 && !filtered ? (
          <EmptyState title="No transfers yet" hint="Record money you move between the Shop, Telecom and Ice Cream books."
            action={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Transfer cash</Button>} />
        ) : (
          <>
            <p className="mb-3 text-sm font-semibold text-slate-900">
              Total moved (posted): <span className="num">{formatLKR(list.data.totals.amountCents)}</span>
              <span className="font-normal text-slate-500"> for the transfers that match these filters; voided ones are not counted.</span>
            </p>
            <DataTable columns={columns} rows={list.data.items} rowKey={(t) => t.id} emptyTitle="No transfers match these filters" emptyHint="Try a different date range or clear a filter." />
            <Pager page={page} total={list.data.total} limit={PAGE_SIZE} noun="transfers" onPage={setPage} />
          </>
        )}
      </Card>
      {creating && <TransferDialog onClose={() => setCreating(false)} />}
      {voiding && (
        <VoidRecordDialog
          title={`Void transfer #${voiding.id}`}
          intro={`This cancels the ${formatLKR(voiding.amountCents)} transfer of ${voiding.businessDate}: the money goes back from ${bookFundLabel(voiding.toBook, voiding.toFund)} to ${bookFundLabel(voiding.fromBook, voiding.fromFund)}. It cannot be undone.`}
          submitLabel="Void transfer"
          pending={voidMut.isPending}
          run={(reason, cb) => voidMut.mutate({ id: voiding.id, reason }, { onSuccess: (r) => { notifyCashWarnings(toast, r.warnings); cb.onSuccess(); }, onError: cb.onError })}
          onDone={() => { toast.success('Transfer voided.'); setVoiding(null); }}
          onClose={() => setVoiding(null)}
        />
      )}
    </>
  );
}
