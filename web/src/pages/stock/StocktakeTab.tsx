import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Plus } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { FormDialog } from '../../components/FormDialog';
import { SelectField } from '../../components/SelectField';
import { Spinner } from '../../components/Spinner';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useHealth } from '../../api/health';
import { useCreateStocktake, useStocktakes } from '../../api/stock';
import type { Book, Stocktake, StocktakeQuery, StocktakeStatus } from '../../types/api';
import { BOOK_LABEL } from '../products/shared';
import { Pager, errorBanner, fieldError } from './shared';

const LIMIT = 50;

export const STATUS_TONE: Record<StocktakeStatus, 'amber' | 'brand' | 'red'> = { draft: 'amber', completed: 'brand', void: 'red' };
export const STATUS_LABEL: Record<StocktakeStatus, string> = { draft: 'Draft', completed: 'Completed', void: 'Void' };

function NewStocktakeDialog({ onClose }: { onClose: () => void }) {
  const health = useHealth();
  const toast = useToast();
  const navigate = useNavigate();
  const create = useCreateStocktake();
  const clientRef = useRef(crypto.randomUUID());
  const [date, setDate] = useState('');
  const [book, setBook] = useState<Book>('shop');
  const [notes, setNotes] = useState('');

  const today = health.data?.today ?? '';
  const effDate = date || today;
  const canSubmit = Boolean(effDate) && !create.isPending;

  const submit = () => {
    create.mutate(
      { businessDate: effDate, book, notes: notes.trim() || undefined, clientRef: clientRef.current },
      {
        onSuccess: (res) => {
          toast.success('Draft stocktake created. Enter your counts.');
          onClose();
          void navigate(`/stock/stocktake/${res.item.id}`);
        },
      },
    );
  };

  return (
    <FormDialog title="New stocktake" submitLabel="Create and open count sheet" canSubmit={canSubmit} loading={create.isPending} error={errorBanner(create.error, ['businessDate', 'book', 'notes'])} onSubmit={submit} onClose={onClose}>
      <TextField label="Date" type="date" value={effDate} max={today || undefined} onChange={(e) => setDate(e.target.value)} error={fieldError(create.error, 'businessDate')} />
      <SelectField label="Book" value={book} onChange={(e) => setBook(e.target.value as Book)} error={fieldError(create.error, 'book')} hint="Shop and Telecom stock are counted separately.">
        <option value="shop">Shop</option>
        <option value="telecom">Telecom</option>
      </SelectField>
      <TextField label="Notes (optional)" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} autoComplete="off" error={fieldError(create.error, 'notes')} />
    </FormDialog>
  );
}

export function StocktakeTab() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [book, setBook] = useState<'' | Book>('');
  const [status, setStatus] = useState<'' | StocktakeStatus>('');
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  useEffect(() => { setPage(0); }, [from, to, book, status]);

  const query: StocktakeQuery = {
    from: from || undefined,
    to: to || undefined,
    book: book || undefined,
    status: status || undefined,
    limit: LIMIT,
    offset: page * LIMIT,
  };
  const list = useStocktakes(query);
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
    { key: 'book', header: 'Book', render: (s) => <Badge tone={s.book === 'shop' ? 'brand' : 'neutral'}>{BOOK_LABEL[s.book]}</Badge> },
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
          <TextField label="From date" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          <TextField label="To date" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          <SelectField label="Book" value={book} onChange={(e) => setBook(e.target.value as '' | Book)}>
            <option value="">All</option>
            <option value="shop">Shop</option>
            <option value="telecom">Telecom</option>
          </SelectField>
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
            <Pager page={page} total={list.data.total} limit={LIMIT} noun="stocktakes" onPage={setPage} />
          </>
        )}
      </Card>
      {creating && <NewStocktakeDialog onClose={() => setCreating(false)} />}
    </>
  );
}
