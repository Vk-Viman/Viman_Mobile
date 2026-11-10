import { useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { ErrorState } from '../../components/ErrorState';
import { FormDialog } from '../../components/FormDialog';
import { SelectField } from '../../components/SelectField';
import { Spinner } from '../../components/Spinner';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { ApiError } from '../../api/client';
import { useCategories, useCreateCategory, useUpdateCategory } from '../../api/catalog';
import type { Book, Category, CategoryUpdate } from '../../types/api';
import { BOOK_LABEL, CHECKBOX_CLASS } from './shared';

export function CategoriesTab() {
  const cats = useCategories();
  const [dialog, setDialog] = useState<{ category: Category | null } | null>(null);

  const columns: Column<Category>[] = [
    { key: 'name', header: 'Name', render: (c) => <span className="font-medium text-slate-900">{c.name}</span> },
    { key: 'book', header: 'Book', render: (c) => <Badge tone={c.book === 'shop' ? 'brand' : 'neutral'}>{BOOK_LABEL[c.book]}</Badge> },
    { key: 'default', header: 'Default', render: (c) => (c.isDefault ? <Badge tone="neutral">Built-in</Badge> : '—') },
    { key: 'count', header: 'Products', align: 'right', render: (c) => c.productCount },
    { key: 'status', header: 'Status', render: (c) => <Badge tone={c.active ? 'brand' : 'neutral'}>{c.active ? 'Active' : 'Inactive'}</Badge> },
    {
      key: 'actions',
      header: 'Actions',
      render: (c) => (
        <Button variant="ghost" className="!min-h-8 !px-2" aria-label={`Edit ${c.name}`} onClick={(e) => { e.stopPropagation(); setDialog({ category: c }); }}>
          <Pencil size={16} aria-hidden="true" /> Edit
        </Button>
      ),
    },
  ];

  return (
    <>
      <Card
        title="Categories"
        actions={<Button onClick={() => setDialog({ category: null })}><Plus size={16} aria-hidden="true" /> New category</Button>}
      >
        {cats.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading categories" /></div>
        ) : cats.isError ? (
          <ErrorState error={cats.error} onRetry={() => void cats.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            rows={cats.data.items}
            rowKey={(c) => c.id}
            emptyTitle="No categories yet"
            onRowClick={(c) => setDialog({ category: c })}
          />
        )}
      </Card>
      {dialog && <CategoryDialog key={dialog.category?.id ?? 'new'} category={dialog.category} onClose={() => setDialog(null)} />}
    </>
  );
}

function CategoryDialog({ category, onClose }: { category: Category | null; onClose: () => void }) {
  const editing = category !== null;
  const toast = useToast();
  const create = useCreateCategory();
  const update = useUpdateCategory();
  const [name, setName] = useState(category?.name ?? '');
  const [book, setBook] = useState<Book>(category?.book ?? 'shop');
  const [active, setActive] = useState(category?.active ?? true);
  const [err, setErr] = useState<ApiError | Error | null>(null);

  const nameLocked = category?.isDefault ?? false;
  const bookLocked = nameLocked || (category?.productCount ?? 0) > 0;

  const trimmed = name.trim();
  let nameError: string | undefined;
  if (trimmed.length > 60) nameError = 'Name can be at most 60 characters.';

  const body: CategoryUpdate = {};
  if (category) {
    if (!nameLocked && trimmed !== category.name) body.name = trimmed;
    if (!bookLocked && book !== category.book) body.book = book;
    if (active !== category.active) body.active = active;
  }
  const valid = trimmed.length >= 1 && !nameError;
  const dirty = !editing || Object.keys(body).length > 0;

  const apiErr = err instanceof ApiError ? err : null;
  const serverName = apiErr?.fields.name ?? (apiErr?.code === 'DUPLICATE_NAME' ? apiErr.message : undefined);
  const lockedMsg =
    apiErr?.code === 'DEFAULT_CATEGORY_LOCKED'
      ? 'Built-in category — name and book cannot be changed.'
      : apiErr?.code === 'CATEGORY_HAS_PRODUCTS'
        ? 'The book cannot be changed while this category has products.'
        : null;
  const banner = err && !serverName && !apiErr?.fields.book ? (lockedMsg ?? err.message) : null;

  const done = () => {
    toast.success(editing ? 'Category updated.' : 'Category added.');
    onClose();
  };
  const submit = () => {
    setErr(null);
    if (category) update.mutate({ id: category.id, body }, { onSuccess: done, onError: setErr });
    else create.mutate({ name: trimmed, book }, { onSuccess: done, onError: setErr });
  };

  return (
    <FormDialog
      title={editing ? `Edit category: ${category.name}` : 'New category'}
      submitLabel={editing ? 'Save changes' : 'Add category'}
      canSubmit={valid && dirty}
      loading={create.isPending || update.isPending}
      error={banner}
      onSubmit={submit}
      onClose={onClose}
    >
      {nameLocked && (
        <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">Built-in category — name and book cannot be changed. You can still deactivate it.</p>
      )}
      <TextField
        label="Name *"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={nameLocked}
        error={nameError ?? serverName}
        autoComplete="off"
      />
      <SelectField
        label="Book *"
        value={book}
        onChange={(e) => setBook(e.target.value as Book)}
        disabled={bookLocked}
        error={apiErr?.fields.book}
        hint={!nameLocked && bookLocked ? 'The book cannot be changed while this category has products.' : undefined}
      >
        <option value="shop">Shop</option>
        <option value="telecom">Telecom</option>
      </SelectField>
      {editing && (
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" className={CHECKBOX_CLASS} checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active
        </label>
      )}
    </FormDialog>
  );
}
