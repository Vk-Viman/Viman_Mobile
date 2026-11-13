/**
 * Stock > Stocktake tab (route "/stock/stocktake"): list of stocktakes (physical counts of what is on the shelf)
 * with filters, paging and "New stocktake". Each date links to its count sheet ("/stock/stocktake/:id").
 * API: GET /stocktakes, POST /stocktakes (api/stock.ts). Creating a stocktake makes a DRAFT; stock only changes
 * when the draft is completed on the count sheet (StocktakeSheet).
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Plus } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { BookFilterSelect, DateRangeFields } from '../../components/FilterFields';
import { FormDialog } from '../../components/FormDialog';
import { Pager } from '../../components/Pager';
import { SelectField } from '../../components/SelectField';
import { Spinner } from '../../components/Spinner';
import { BookBadge } from '../../components/StatusBadges';
import { BackdatedNotice } from '../../components/BackdatedNotice';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useCreateStocktake, useStocktakes } from '../../api/stock';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { PAGE_SIZE } from '../../lib/constants';
import { errorBanner, fieldError } from '../../lib/errors';
import type { Book, Stocktake, StocktakeQuery, StocktakeStatus } from '../../types/api';
import { STATUS_LABEL, STATUS_TONE } from './shared';

const MAX_NOTES = 500;

/**
 * Small form that starts a new draft stocktake for one book on a date, then opens its count sheet.
 * R-FD: the date cannot be in the future (picker max = today); the server enforces it. Mount only while open.
 */
function NewStocktakeDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const create = useCreateStocktake();
  // Generated once per opening so a retried Save is recognised by the server and cannot create two drafts.
  const clientRef = useClientRef();
  const { today, date: effDate, setDate } = useBusinessDate();
  const [book, setBook] = useState<Book>('shop');
  const [notes, setNotes] = useState('');

  const canSubmit = Boolean(effDate) && !create.isPending;

  const submit = () => {
    create.mutate(
      { businessDate: effDate, book, notes: notes.trim() || undefined, clientRef },
      {
        onSuccess: (res) => {
          toast.success('Draft stocktake created. Enter your counts.');
          onClose();
          // Go straight to the new draft's count sheet.
          void navigate(`/stock/stocktake/${res.item.id}`);
        },
      },
    );
  };

  return (
    <FormDialog title="New stocktake" submitLabel="Create and open count sheet" canSubmit={canSubmit} loading={create.isPending} error={errorBanner(create.error, ['businessDate', 'book', 'notes'])} onSubmit={submit} onClose={onClose}>
      <div>
        <TextField label="Date" type="date" value={effDate} max={today || undefined} onChange={(e) => setDate(e.target.value)} error={fieldError(create.error, 'businessDate')} />
        <BackdatedNotice date={effDate} today={today} />
      </div>
      <SelectField label="Book" value={book} onChange={(e) => setBook(e.target.value as Book)} error={fieldError(create.error, 'book')} hint="Shop and Telecom stock are counted separately.">
        <option value="shop">Shop</option>
        <option value="telecom">Telecom</option>
      </SelectField>
      <TextField label="Notes (optional)" value={notes} maxLength={MAX_NOTES} onChange={(e) => setNotes(e.target.value)} autoComplete="off" error={fieldError(create.error, 'notes')} />
    </FormDialog>
  );
}

/** The tab: filter bar, stocktake table, pager and the "New stocktake" dialog. */
export function StocktakeTab() {
  // ---- Filter and paging state ("" means "no filter") ----
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [book, setBook] = useState<'' | Book>('');
  const [status, setStatus] = useState<'' | StocktakeStatus>('');
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  // Back to the first page whenever a filter changes.
  useEffect(() => { setPage(0); }, [from, to, book, status]);

  // Unset filters become undefined so the API helper leaves them out of the URL.
  const query: StocktakeQuery = {
    from: from || undefined,
    to: to || undefined,
    book: book || undefined,
    status: status || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const list = useStocktakes(query);
  // True when any filter is set; decides between "no stocktakes yet" and "no stocktakes match".
  const filtered = Boolean(from || to || book || status);

  const columns: Column<Stocktake>[] = [
    {
      key: 'date',
      header: 'Date',
      render: (s) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          <Link to={`/stock/stocktake/${s.id}`} className="font-medium text-brand-700 underline-offset-2 hover:underline">{s.businessDate}</Link>
          {s.backdated && <Badge tone="amber">Backdated</Badge>}
        </span>
      ),
    },
    { key: 'book', header: 'Book', render: (s) => <BookBadge book={s.book} /> },
    { key: 'status', header: 'Status', render: (s) => <Badge tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge> },
    { key: 'items', header: 'Items', align: 'right', render: (s) => s.items.length },
    { key: 'notes', header: 'Notes', render: (s) => s.notes || '—' },
  ];

  return (
    <>
      <Card
        title="Stocktakes"
        actions={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> New stocktake</Button>}
      >
        <p className="mb-4 text-sm text-slate-500">Count what is on the shelf, then complete the stocktake to correct the system stock. Differences are posted at the average cost.</p>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <DateRangeFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
          <BookFilterSelect value={book} onChange={setBook} />
          <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value as '' | StocktakeStatus)}>
            <option value="">All</option>
            <option value="draft">Draft</option>
            <option value="completed">Completed</option>
            <option value="void">Void</option>
          </SelectField>
        </div>
        {list.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading stocktakes" /></div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 && !filtered ? (
          <EmptyState
            title="No stocktakes yet"
            hint="Start a stocktake to compare your shelf count with the system."
            action={<Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> New stocktake</Button>}
          />
        ) : (
          <>
            <DataTable columns={columns} rows={list.data.items} rowKey={(s) => s.id} emptyTitle="No stocktakes match these filters" emptyHint="Try a different date range or clear a filter." />
            <Pager page={page} total={list.data.total} limit={PAGE_SIZE} noun="stocktakes" onPage={setPage} />
          </>
        )}
      </Card>
      {creating && <NewStocktakeDialog onClose={() => setCreating(false)} />}
    </>
  );
}
