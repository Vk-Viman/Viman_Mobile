/**
 * CapitalTab (route "/drawings/capital"): money the owner put into the business.
 * API: GET /capital (kind, book, dates, status, totals, paging), POST /capital, POST /capital-entries/:id/void (api/transfers.ts).
 *
 * Capital is cash IN to a book (for Ice Cream, into a named fund) and is never revenue or profit (BUSINESS_RULES sections 8, 9, 10.4).
 * Opening balances are listed in the same table for completeness but are set and voided under Cash Books. Voiding a capital
 * entry never deletes it: the server keeps it (shown as "Void") and posts a reversing cash entry (R1); the answer may carry a
 * warning if the book or fund then goes below zero (R13). A closed day refuses new or voided entries until reopened (R9).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Info, Plus } from 'lucide-react';
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
import { SelectField } from '../../components/SelectField';
import { Spinner } from '../../components/Spinner';
import { PostedStatusBadge } from '../../components/StatusBadges';
import { useToast } from '../../components/Toast';
import { VoidRecordDialog } from '../../components/VoidRecordDialog';
import { useCapital, useVoidCapital } from '../../api/transfers';
import { PAGE_SIZE } from '../../lib/constants';
import { notifyCashWarnings } from '../../lib/cashWarnings';
import { formatLKR } from '../../lib/format';
import type { PostedStatus } from '../../types/api';
import type { CapitalEntry, CashBook } from '../../types/cashbooks';
import type { CapitalQuery } from '../../types/transfers';
import { bookFundLabel, CashBookBadge, CashBookFilterSelect } from './BookFundFields';
import { CapitalDialog } from './CapitalDialog';

/** The capital tab: filter bar, list with total, pager, and the add / void dialogs. */
export function CapitalTab() {
  const toast = useToast();
  const voidMut = useVoidCapital();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [book, setBook] = useState<'' | CashBook>('');
  const [kind, setKind] = useState<'' | 'capital' | 'opening_balance'>('');
  const [status, setStatus] = useState<'' | PostedStatus>('');
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<CapitalEntry | null>(null);

  useEffect(() => { setPage(0); }, [from, to, book, kind, status]);

  const query: CapitalQuery = {
    from: from || undefined, to: to || undefined, book: book || undefined, kind: kind || undefined, status: status || undefined,
    limit: PAGE_SIZE, offset: page * PAGE_SIZE,
  };
  const list = useCapital(query);
  const filtered = Boolean(from || to || book || kind || status);

  const columns: Column<CapitalEntry>[] = [
    { key: 'date', header: 'Date', render: (e) => <span className="inline-flex flex-wrap items-center gap-2">{e.businessDate}{e.backdated && <Badge tone="amber">Backdated</Badge>}</span> },
    { key: 'kind', header: 'Kind', render: (e) => <Badge tone={e.kind === 'capital' ? 'brand' : 'neutral'}>{e.kind === 'capital' ? 'Capital' : 'Opening balance'}</Badge> },
    { key: 'book', header: 'Book', render: (e) => <CashBookBadge book={e.book} fund={e.fund} /> },
    { key: 'note', header: 'Note', render: (e) => e.note || '—' },
    { key: 'amount', header: 'Amount (Rs.)', align: 'right', render: (e) => <Money cents={e.amountCents} /> },
    {
      key: 'status', header: 'Status',
      render: (e) => (<span><PostedStatusBadge status={e.status} />{e.status === 'void' && e.voidReason && <span className="mt-1 block text-xs text-slate-500">{e.voidReason}</span>}</span>),
    },
    {
      key: 'act', header: 'Actions',
      render: (e) => {
        if (e.kind === 'opening_balance') return <Link to="/cashbooks" className="text-sm text-brand-700 hover:underline">Manage in Cash Books</Link>;
        return e.status === 'posted' ? <Button variant="ghost" onClick={() => setVoiding(e)} aria-label={`Void capital #${e.id}`}>Void</Button> : null;
      },
    },
  ];

  return (
    <>
      <p className="mb-4 flex items-start gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-600">
        <Info size={18} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />
        <span>Capital is your own money put into the business. It is not income and never counts as profit. For Ice Cream you choose the fund it goes into.</span>
      </p>
      <Card title="Capital introduced" actions={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Add capital</Button>}>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <DateRangeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
          <CashBookFilterSelect value={book} onChange={setBook} />
          <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value as '' | 'capital' | 'opening_balance')}>
            <option value="">Capital and opening balances</option>
            <option value="capital">Capital only</option>
            <option value="opening_balance">Opening balances only</option>
          </SelectField>
          <PostedStatusFilterSelect value={status} onChange={setStatus} />
        </div>

        {list.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading capital" /></div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 && !filtered ? (
          <EmptyState title="No capital recorded yet" hint="Record money you put into the Shop, Telecom or Ice Cream book."
            action={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Add capital</Button>} />
        ) : (
          <>
            <p className="mb-3 text-sm font-semibold text-slate-900">
              Total (posted): <span className="num">{formatLKR(list.data.totals.amountCents)}</span>
              <span className="font-normal text-slate-500"> for the entries that match these filters; voided ones are not counted.</span>
            </p>
            <DataTable columns={columns} rows={list.data.items} rowKey={(e) => e.id} emptyTitle="No entries match these filters" emptyHint="Try a different date range or clear a filter." />
            <Pager page={page} total={list.data.total} limit={PAGE_SIZE} noun="entries" onPage={setPage} />
          </>
        )}
      </Card>
      {creating && <CapitalDialog onClose={() => setCreating(false)} />}
      {voiding && (
        <VoidRecordDialog
          title={`Void capital #${voiding.id}`}
          intro={`This cancels the ${formatLKR(voiding.amountCents)} of capital dated ${voiding.businessDate}: the money leaves the ${bookFundLabel(voiding.book, voiding.fund)} cash book again. It cannot be undone.`}
          submitLabel="Void capital"
          pending={voidMut.isPending}
          run={(reason, cb) => voidMut.mutate({ id: voiding.id, reason }, { onSuccess: (r) => { notifyCashWarnings(toast, r.warnings); cb.onSuccess(); }, onError: cb.onError })}
          onDone={() => { toast.success('Capital voided.'); setVoiding(null); }}
          onClose={() => setVoiding(null)}
        />
      )}
    </>
  );
}
