/**
 * Products > Categories tab (route "/products/categories"): the owner's category management screen.
 * Table of categories with book, product count, status and created date; filters by book and "show inactive";
 * New category / Rename / Activate / Deactivate. There is deliberately NO delete: a category is retired by
 * deactivating it, so old products and history keep their category.
 * API: GET /categories, POST /categories, PUT /categories/:id (api/catalog.ts). Dialogs: CategoryDialog.tsx.
 */
import { useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { ErrorState } from '../../components/ErrorState';
import { SelectField } from '../../components/SelectField';
import { Spinner } from '../../components/Spinner';
import { ActiveBadge, BookBadge } from '../../components/StatusBadges';
import { useToast } from '../../components/Toast';
import { useCategories, useUpdateCategory } from '../../api/catalog';
import { CHECKBOX_CLASS } from '../../lib/constants';
import { errorBanner, errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import type { Book, Category } from '../../types/api';
import { CategoryDialog } from './CategoryDialog';

/** The tab: filters, category table and the dialogs it opens. */
export function CategoriesTab() {
  const toast = useToast();
  const update = useUpdateCategory();
  const [bookFilter, setBookFilter] = useState<Book | ''>('');
  const [showInactive, setShowInactive] = useState(false);
  // One list is fetched (all statuses of the chosen book) and the toggle filters it locally: toggling is instant.
  const cats = useCategories({ book: bookFilter || undefined });
  // null = no dialog; { category: null } = "new category"; { category: c } = renaming c.
  const [dialog, setDialog] = useState<{ category: Category | null } | null>(null);
  const [deactivating, setDeactivating] = useState<Category | null>(null);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);

  const rows = (cats.data?.items ?? []).filter((c) => showInactive || c.active);
  const hiddenInactive = (cats.data?.items ?? []).length - rows.length;

  const activate = (c: Category) =>
    update.mutate({ id: c.id, body: { active: true } }, {
      onSuccess: () => toast.success(`${c.name} is active again.`),
      onError: (e) => toast.error(errorMessage(e)),
    });
  const confirmDeactivate = () => {
    if (!deactivating) return;
    setDeactivateError(null);
    update.mutate({ id: deactivating.id, body: { active: false } }, {
      onSuccess: () => { toast.success(`${deactivating.name} deactivated.`); setDeactivating(null); },
      onError: (e) => setDeactivateError(errorBanner(e)),
    });
  };

  const columns: Column<Category>[] = [
    {
      key: 'name',
      header: 'Category name',
      render: (c) => (
        <span className="font-medium text-slate-900">
          {c.name} {c.isDefault && <span className="ml-1 align-middle"><Badge tone="neutral">Default</Badge></span>}
        </span>
      ),
    },
    { key: 'book', header: 'Business book', render: (c) => <BookBadge book={c.book} /> },
    { key: 'count', header: 'Number of products', align: 'right', render: (c) => c.productCount },
    { key: 'status', header: 'Status', render: (c) => <ActiveBadge active={c.active} /> },
    // Date only: the server timestamp's time part is noise for the owner here.
    { key: 'created', header: 'Created', render: (c) => formatDateTime(c.createdAt).split(',')[0] },
    {
      key: 'actions',
      header: 'Actions',
      render: (c) => (
        <div className="flex flex-wrap gap-1">
          <Button variant="ghost" className="!min-h-8 !px-2" aria-label={`Edit name of ${c.name}`} onClick={() => setDialog({ category: c })}>
            <Pencil size={16} aria-hidden="true" /> Edit name
          </Button>
          {c.active ? (
            <Button variant="ghost" className="!min-h-8 !px-2" aria-label={`Deactivate ${c.name}`} onClick={() => { setDeactivateError(null); setDeactivating(c); }}>
              Deactivate
            </Button>
          ) : (
            <Button variant="ghost" className="!min-h-8 !px-2" aria-label={`Activate ${c.name}`} disabled={update.isPending} onClick={() => activate(c)}>
              Activate
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <Card
        title="Categories"
        actions={<Button onClick={() => setDialog({ category: null })}><Plus size={16} aria-hidden="true" /> New category</Button>}
      >
        <div className="mb-4 flex flex-wrap items-end gap-4">
          <SelectField label="Business book" value={bookFilter} onChange={(e) => setBookFilter(e.target.value as Book | '')} className="w-full sm:w-48">
            <option value="">Shop and Telecom</option>
            <option value="shop">Shop only</option>
            <option value="telecom">Telecom only</option>
          </SelectField>
          <label className="flex min-h-10 items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" className={CHECKBOX_CLASS} checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive categories
          </label>
        </div>
        {cats.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading categories" /></div>
        ) : cats.isError ? (
          <ErrorState error={cats.error} onRetry={() => void cats.refetch()} />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(c) => c.id}
              emptyTitle="No categories to show"
              emptyHint={hiddenInactive > 0 ? 'Only inactive categories match. Tick "Show inactive categories" to see them.' : 'Use "New category" to add one.'}
            />
            {hiddenInactive > 0 && rows.length > 0 && (
              <p className="mt-3 text-xs text-slate-500">{hiddenInactive} inactive {hiddenInactive === 1 ? 'category is' : 'categories are'} hidden.</p>
            )}
          </>
        )}
      </Card>
      {/* Mounted only while open (with a key per category) so the form always starts with fresh values. */}
      {dialog && <CategoryDialog key={dialog.category?.id ?? 'new'} category={dialog.category} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={deactivating !== null}
        title={`Deactivate ${deactivating?.name ?? ''}?`}
        confirmLabel="Deactivate"
        danger
        loading={update.isPending}
        error={deactivateError}
        onConfirm={confirmDeactivate}
        onClose={() => setDeactivating(null)}
      >
        <p>
          Its {deactivating?.productCount ?? 0} product(s) keep working: they stay in this category, can still be sold and
          stocked, and old records are unchanged.
        </p>
        <p>The category will no longer be offered when adding a new product. You can activate it again at any time.</p>
      </ConfirmDialog>
    </>
  );
}
