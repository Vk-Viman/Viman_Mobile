/**
 * Products > Categories tab (route "/products/categories"): list, add and edit product categories.
 * API: GET /categories, POST /categories, PUT /categories/:id (api/catalog.ts).
 * Rules shown here (enforced by the server): built-in categories cannot be renamed or moved to another book, and a
 * category's book cannot change once it has products (it would move their stock between the Shop and Telecom books).
 */
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
import { ActiveBadge, BookBadge } from '../../components/StatusBadges';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { ApiError } from '../../api/client';
import { useCategories, useCreateCategory, useUpdateCategory } from '../../api/catalog';
import { CHECKBOX_CLASS } from '../../lib/constants';
import type { Book, Category, CategoryUpdate } from '../../types/api';

/** Longest category name the server accepts. */
const MAX_NAME_LENGTH = 60;

/** The tab: category table with an "Add" button and click-to-edit rows. */
export function CategoriesTab() {
  const cats = useCategories();
  // null = no dialog; { category: null } = "new category"; { category: c } = editing c.
  const [dialog, setDialog] = useState<{ category: Category | null } | null>(null);

  const columns: Column<Category>[] = [
    { key: 'name', header: 'Name', render: (c) => <span className="font-medium text-slate-900">{c.name}</span> },
    { key: 'book', header: 'Book', render: (c) => <BookBadge book={c.book} /> },
    { key: 'default', header: 'Default', render: (c) => (c.isDefault ? <Badge tone="neutral">Built-in</Badge> : '—') },
    { key: 'count', header: 'Products', align: 'right', render: (c) => c.productCount },
    { key: 'status', header: 'Status', render: (c) => <ActiveBadge active={c.active} /> },
    {
      key: 'actions',
      header: 'Actions',
      render: (c) => (
        // stopPropagation: the whole row is also clickable; this keeps the click from firing twice.
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
      {/* Mounted only while open (with a key per category) so the form always starts with fresh values. */}
      {dialog && <CategoryDialog key={dialog.category?.id ?? 'new'} category={dialog.category} onClose={() => setDialog(null)} />}
    </>
  );
}

/**
 * Add/edit form for one category.
 * @param category the category being edited, or null to create a new one.
 */
function CategoryDialog({ category, onClose }: { category: Category | null; onClose: () => void }) {
  const editing = category !== null;
  const toast = useToast();
  const create = useCreateCategory();
  const update = useUpdateCategory();
  const [name, setName] = useState(category?.name ?? '');
  const [book, setBook] = useState<Book>(category?.book ?? 'shop');
  const [active, setActive] = useState(category?.active ?? true);
  const [err, setErr] = useState<ApiError | Error | null>(null);

  // Built-in categories: name and book are fixed. Categories that already hold products: book is fixed.
  const nameLocked = category?.isDefault ?? false;
  const bookLocked = nameLocked || (category?.productCount ?? 0) > 0;

  const trimmed = name.trim();
  let nameError: string | undefined;
  if (trimmed.length > MAX_NAME_LENGTH) nameError = `Name can be at most ${MAX_NAME_LENGTH} characters.`;

  // When editing, send only the fields that actually changed (a partial update).
  const body: CategoryUpdate = {};
  if (category) {
    if (!nameLocked && trimmed !== category.name) body.name = trimmed;
    if (!bookLocked && book !== category.book) body.book = book;
    if (active !== category.active) body.active = active;
  }
  const valid = trimmed.length >= 1 && !nameError;
  // "dirty": creating is always submittable; editing needs at least one change.
  const dirty = !editing || Object.keys(body).length > 0;

  // Map server answers onto the form: duplicate-name goes under the Name box; other refusals become one banner.
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
