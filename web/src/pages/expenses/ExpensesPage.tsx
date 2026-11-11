/**
 * ExpensesPage (route "/expenses"): record and review Shop and Telecom expenses.
 * API: GET /expenses (filters, totals, paging), POST /expenses, POST /expenses/:id/void (api/expenses.ts).
 *
 * An expense is money paid OUT of the Shop or the Telecom cash book and is a cost of that book (BUSINESS_RULES section 7).
 * There is no Electricity category: the whole shop's electricity is paid from the Ice Cream book, and the screen says so.
 * Voiding never deletes: the server keeps the expense (shown as "Void") and posts a reversing cash entry (R1). A day that was
 * closed in the cash book refuses new or voided expenses until it is reopened (R9); the server's message says so and is shown
 * as it comes. Totals count POSTED expenses only. All figures are calculated by the server.
 */
import { useEffect, useState } from 'react';
import { Info, Plus } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { BookFilterSelect, DateRangeFields, PostedStatusFilterSelect } from '../../components/FilterFields';
import { Money } from '../../components/Money';
import { PageHeader } from '../../components/PageHeader';
import { Pager } from '../../components/Pager';
import { SelectField } from '../../components/SelectField';
import { Spinner } from '../../components/Spinner';
import { BookBadge, PostedStatusBadge } from '../../components/StatusBadges';
import { useToast } from '../../components/Toast';
import { VoidRecordDialog } from '../../components/VoidRecordDialog';
import { useExpenseCategories, useExpenses, useVoidExpense } from '../../api/expenses';
import { PAGE_SIZE } from '../../lib/constants';
import { formatLKR } from '../../lib/format';
import type { Book, PostedStatus } from '../../types/api';
import type { Expense, ExpenseQuery } from '../../types/cashbooks';
import { ELECTRICITY_NOTE, ExpenseDialog } from './ExpenseDialog';

/** The expenses screen. */
export function ExpensesPage() {
  const toast = useToast();
  const voidMut = useVoidExpense();
  const categories = useExpenseCategories();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [book, setBook] = useState<'' | Book>('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState<'' | PostedStatus>('');
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<Expense | null>(null);

  // A new filter always starts at the first page.
  useEffect(() => { setPage(0); }, [from, to, book, category, status]);

  const query: ExpenseQuery = {
    from: from || undefined, to: to || undefined, book: book || undefined, category: category || undefined,
    status: status || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE,
  };
  const list = useExpenses(query);
  const filtered = Boolean(from || to || book || category || status);
  const labelOf = (value: string) => categories.data?.items.find((c) => c.value === value)?.label ?? value;

  const columns: Column<Expense>[] = [
    { key: 'date', header: 'Date', render: (e) => <span className="inline-flex flex-wrap items-center gap-2">{e.businessDate}{e.backdated && <Badge tone="amber">Backdated</Badge>}</span> },
    { key: 'book', header: 'Book', render: (e) => <BookBadge book={e.book} /> },
    { key: 'cat', header: 'Category', render: (e) => labelOf(e.category) },
    {
      key: 'desc', header: 'What for',
      render: (e) => (<span><span className="font-medium text-slate-900">{e.description}</span>{e.notes && <span className="mt-0.5 block text-xs text-slate-500">{e.notes}</span>}</span>),
    },
    { key: 'amount', header: 'Amount (Rs.)', align: 'right', render: (e) => <Money cents={e.amountCents} /> },
    {
      key: 'status', header: 'Status',
      render: (e) => (<span><PostedStatusBadge status={e.status} />{e.status === 'void' && e.voidReason && <span className="mt-1 block text-xs text-slate-500">{e.voidReason}</span>}</span>),
    },
    {
      key: 'act', header: 'Actions',
      render: (e) => (e.status === 'posted' ? <Button variant="ghost" onClick={() => setVoiding(e)} aria-label={`Void expense #${e.id}`}>Void</Button> : null),
    },
  ];

  return (
    <>
      <PageHeader title="Expenses" subtitle="Money paid out of the Shop or Telecom cash book" />
      <p className="mb-4 flex items-start gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-600">
        <Info size={18} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />
        <span>{ELECTRICITY_NOTE} Ice Cream costs are recorded under Ice Cream, not here.</span>
      </p>
      <Card title="Expenses" actions={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Add expense</Button>}>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <DateRangeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
          <BookFilterSelect value={book} onChange={setBook} />
          <SelectField label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {(categories.data?.items ?? []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </SelectField>
          <PostedStatusFilterSelect value={status} onChange={setStatus} />
        </div>

        {list.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading expenses" /></div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 && !filtered ? (
          <EmptyState title="No expenses yet" hint="Record rent, water, internet and other costs as you pay them."
            action={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Add expense</Button>} />
        ) : (
          <>
            <p className="mb-3 text-sm font-semibold text-slate-900">
              Total (posted): <span className="num">{formatLKR(list.data.totals.amountCents)}</span>
              <span className="font-normal text-slate-500"> for the expenses that match these filters; voided ones are not counted.</span>
            </p>
            <DataTable columns={columns} rows={list.data.items} rowKey={(e) => e.id} emptyTitle="No expenses match these filters" emptyHint="Try a different date range or clear a filter." />
            <Pager page={page} total={list.data.total} limit={PAGE_SIZE} noun="expenses" onPage={setPage} />
          </>
        )}
      </Card>
      {creating && <ExpenseDialog onClose={() => setCreating(false)} />}
      {voiding && (
        <VoidRecordDialog
          title={`Void expense #${voiding.id}`}
          intro={`This cancels the ${formatLKR(voiding.amountCents)} expense of ${voiding.businessDate} (${voiding.description}): the money goes back into the ${voiding.book === 'shop' ? 'Shop' : 'Telecom'} cash book. It cannot be undone.`}
          submitLabel="Void expense"
          pending={voidMut.isPending}
          run={(reason, cb) => voidMut.mutate({ id: voiding.id, reason }, cb)}
          onDone={() => { toast.success('Expense voided.'); setVoiding(null); }}
          onClose={() => setVoiding(null)}
        />
      )}
    </>
  );
}
