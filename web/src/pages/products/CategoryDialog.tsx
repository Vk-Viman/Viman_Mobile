/**
 * CategoryDialog: the "New category" and "Edit category" forms of Products > Categories.
 * API: POST /categories (name + book) and PUT /categories/:id (rename only; api/catalog.ts).
 * Rules (enforced by the server, explained here in plain words): a name is unique inside its book ignoring upper/lower
 * case (Shop and Telecom may both have "Accessories"); the book cannot change once the category has products;
 * default categories keep their name and book. Renaming never moves products: they stay in the category.
 */
import { useState } from 'react';
import { FormDialog } from '../../components/FormDialog';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { ApiError } from '../../api/client';
import { useCreateCategory, useUpdateCategory } from '../../api/catalog';
import { BOOK_LABEL } from '../../lib/constants';
import { errorBanner } from '../../lib/errors';
import type { Book, Category } from '../../types/api';
import { CategoryBookChoice } from './CategoryBookChoice';

/** Longest category name the server accepts. */
export const CATEGORY_NAME_MAX = 60;

/**
 * Add/edit form for one category. Mount only while open so each opening starts from fresh values.
 * @param category the category being edited, or null to create a new one.
 */
export function CategoryDialog({ category, onClose }: { category: Category | null; onClose: () => void }) {
  const editing = category !== null;
  const toast = useToast();
  const create = useCreateCategory();
  const update = useUpdateCategory();
  const [name, setName] = useState(category?.name ?? '');
  // '' = not chosen yet: the owner must pick Shop or Telecom on purpose.
  const [book, setBook] = useState<Book | ''>(category?.book ?? '');
  const [err, setErr] = useState<ApiError | Error | null>(null);

  const nameLocked = category?.isDefault ?? false;
  const trimmed = name.trim();
  const nameError = trimmed.length > CATEGORY_NAME_MAX ? `Name can be at most ${CATEGORY_NAME_MAX} characters.` : undefined;
  const valid = !nameError && (editing ? trimmed.length >= 1 : trimmed.length >= 1 && book !== '');
  const dirty = !editing || trimmed !== category.name;

  // The server's duplicate message goes under the Name box; everything else becomes one banner.
  const apiErr = err instanceof ApiError ? err : null;
  const serverName = apiErr?.fields.name ?? (apiErr?.code === 'DUPLICATE_NAME' ? apiErr.message : undefined);
  const banner = err && !serverName && !apiErr?.fields.book ? errorBanner(err) : null;

  const done = () => {
    toast.success(editing ? 'Category renamed.' : 'Category added.');
    onClose();
  };
  const submit = () => {
    setErr(null);
    if (category) update.mutate({ id: category.id, body: { name: trimmed } }, { onSuccess: done, onError: setErr });
    else if (book !== '') create.mutate({ name: trimmed, book }, { onSuccess: done, onError: setErr });
  };

  return (
    <FormDialog
      title={editing ? `Edit category: ${category.name}` : 'New category'}
      submitLabel={editing ? 'Save name' : 'Add category'}
      canSubmit={valid && dirty && !(editing && nameLocked)}
      loading={create.isPending || update.isPending}
      error={banner}
      onSubmit={submit}
      onClose={onClose}
    >
      {nameLocked && (
        <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
          Default category: the name is locked. You can still deactivate it from the category list.
        </p>
      )}
      {editing ? (
        // Book is shown but fixed: changing it would move existing stock between the Shop and Telecom books.
        <p className="text-sm text-slate-700">
          Business book: <strong>{BOOK_LABEL[category.book]}</strong>
          <span className="mt-1 block text-xs text-slate-500">
            The book cannot be changed once a category has products{category.productCount > 0 ? ' (this one has ' + category.productCount + ')' : ''}.
          </span>
        </p>
      ) : (
        <CategoryBookChoice label="Business book *" value={book} onChange={setBook} error={apiErr?.fields.book} hint="Choose where this category belongs. Products in it will be part of this book." />
      )}
      <TextField
        label="Category name *"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={nameLocked}
        error={nameError ?? serverName}
        hint={editing && category.productCount > 0 ? 'Products stay in this category when it is renamed.' : undefined}
        autoComplete="off"
      />
    </FormDialog>
  );
}
