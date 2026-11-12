/**
 * CategoryProductPicker: category-first product selection shared by Purchases, Opening Stock, POS and stock screens.
 * Step 1 a Category drop-down (active categories of `book`); step 2 a searchable Product drop-down that lists only
 * ACTIVE stock products of that category (server filtered: categoryId, active, kind=stock, q).
 * Rules: choosing/changing the category clears the selected product; with `requireCategory` the product box stays
 * disabled until a category is chosen, otherwise "All categories" is offered (POS keeps its fast search); products of
 * another book than `book` are never listed. Presentation only: no stock, price or accounting logic lives here.
 * Keyboard: type to search, Up/Down to move, Enter to choose, Esc to close (ARIA combobox + listbox).
 * API: GET /categories?active=true, GET /products (api/catalog.ts).
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Plus } from 'lucide-react';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { SelectField } from './SelectField';
import { Spinner } from './Spinner';
import { BookBadge } from './StatusBadges';
import { inputClass } from './TextField';
import { useCategories, useProductsByCategory } from '../api/catalog';
import { useDebounced } from '../hooks/useDebounced';
import { BOOK_LABEL } from '../lib/constants';
import type { Book, Product } from '../types/api';

/** Rows fetched per search; the owner narrows by typing, so the list stays small even with 200+ products. */
const LIST_LIMIT = 50;

/** Props (see API_CONTRACTS.md, "Category management and category-first selection"). */
export interface CategoryProductPickerProps {
  /** Book to work in; null = both books (categories then carry a Shop/Telecom tag). */
  book: Book | null;
  /** Selected product, or null. */
  value: Product | null;
  onChange: (p: Product | null) => void;
  /** Selected category id, or null (= none / "All categories"). */
  categoryId: number | null;
  onCategoryChange: (id: number | null) => void;
  /** True: pick a category before any product (purchases, opening stock). False: "All categories" is allowed. */
  requireCategory?: boolean;
  /** Products already used elsewhere on the screen; hidden from the list. */
  excludeProductIds?: number[];
  /** Default true: stock items only (services are never stocked or bought). */
  stockOnly?: boolean;
  /** When given, the empty-category state and the list footer offer a "New product" button. */
  onCreateProduct?: (ctx: { book: Book | null; categoryId: number | null }) => void;
  disabled?: boolean;
}

/** The two linked drop-downs. State of the open list and search text is local; the chosen values are the parent's. */
export function CategoryProductPicker({
  book, value, onChange, categoryId, onCategoryChange, requireCategory = false, excludeProductIds, stockOnly = true, onCreateProduct, disabled,
}: CategoryProductPickerProps) {
  const uid = useId();
  const listId = `${uid}-list`;
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [hi, setHi] = useState(0); // highlighted row
  const q = useDebounced(text.trim());

  const cats = useCategories({ active: true, book: book ?? undefined });
  const categories = cats.data?.items ?? [];

  // Drop a category or product that no longer fits the book (the screen switched book): never show the wrong book.
  useEffect(() => {
    if (!cats.data) return;
    if (categoryId !== null && !cats.data.items.some((c) => c.id === categoryId)) {
      onCategoryChange(null);
      onChange(null);
    } else if (value && book && value.book !== book) {
      onChange(null);
    }
    // Callbacks are the parent's and change identity each render; react only to data/book/selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cats.data, book, categoryId, value]);

  const blocked = requireCategory && categoryId === null;
  const list = useProductsByCategory({ book: book ?? undefined, categoryId, q, stockOnly, limit: LIST_LIMIT, enabled: open && !blocked });
  const exclude = new Set(excludeProductIds ?? []);
  const items = (list.data?.items ?? []).filter((p) => !exclude.has(p.id) && (!book || p.book === book));
  const total = list.data?.total ?? 0;

  // Close when focus/click leaves the whole picker.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const choose = (p: Product) => {
    onChange(p);
    setOpen(false);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      else setHi((h) => Math.min(h + 1, Math.max(items.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter' && open) {
      e.preventDefault(); // never submit a surrounding form from the search box
      const p = items[hi];
      if (p) choose(p);
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation(); // close the list, not the dialog the picker may sit in
      setOpen(false);
    }
  };

  const catHint =
    cats.isSuccess && categories.length === 0
      ? `No active ${book ? BOOK_LABEL[book] + ' ' : ''}categories yet. Add one in Products > Categories${onCreateProduct ? ' or create a product with a new category' : ''}.`
      : undefined;
  const newProductButton = onCreateProduct && (
    <Button variant="secondary" className="mt-2" onClick={() => { setOpen(false); onCreateProduct({ book, categoryId }); }}>
      <Plus size={16} aria-hidden="true" /> New product
    </Button>
  );

  return (
    <div ref={root} className="grid gap-4 sm:grid-cols-2">
      <div>
        <SelectField
          label="Category"
          value={categoryId === null ? '' : String(categoryId)}
          disabled={disabled || cats.isPending}
          onChange={(e) => {
            // Changing the category always clears the product: it may belong to the old one.
            onCategoryChange(e.target.value === '' ? null : Number(e.target.value));
            onChange(null);
            setText('');
          }}
          error={cats.isError ? 'Could not load categories.' : undefined}
          hint={catHint}
        >
          <option value="">{requireCategory ? 'Choose a category…' : 'All categories'}</option>
          {categories.map((c) => (
            <option key={c.id} value={String(c.id)}>{book ? c.name : `${c.name} (${BOOK_LABEL[c.book]})`}</option>
          ))}
        </SelectField>
        {cats.isError && <Button variant="ghost" className="!min-h-8 !px-2" onClick={() => void cats.refetch()}>Retry</Button>}
      </div>

      <div className="relative">
        <label htmlFor={`${uid}-product`} className="mb-1 block text-sm font-medium text-slate-700">Product</label>
        <input
          id={`${uid}-product`}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && items[hi] ? `${uid}-opt-${items[hi].id}` : undefined}
          autoComplete="off"
          className={inputClass()}
          disabled={disabled || blocked}
          placeholder={blocked ? 'Choose a category first' : value ? value.name : 'Search by name or code…'}
          // Shows the chosen product when closed; while searching it is the search text.
          value={open ? text : (value?.name ?? '')}
          onFocus={() => { setOpen(true); setHi(0); }}
          onChange={(e) => { setText(e.target.value); setOpen(true); setHi(0); }}
          onKeyDown={onKeyDown}
        />
        {blocked && <p className="mt-1 text-xs text-slate-500">Products are shown after you choose a category.</p>}
        {open && !blocked && (
          <div className="absolute left-0 right-0 z-30 mt-1 max-h-72 overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
            {list.isPending ? (
              <div className="flex justify-center py-6"><Spinner label="Loading products" /></div>
            ) : list.isError ? (
              <div className="p-3 text-sm text-red-600" role="alert">
                Could not load products. <Button variant="ghost" className="!min-h-8 !px-2" onClick={() => void list.refetch()}>Retry</Button>
              </div>
            ) : items.length === 0 ? (
              <div>
                <EmptyState
                  title={q ? 'No product matches your search' : categoryId !== null ? 'No active products in this category yet' : 'No products found'}
                  hint={q ? 'Try another name or code.' : onCreateProduct ? 'Create the first product for it below.' : 'Add products in Products > Products.'}
                  action={newProductButton}
                />
              </div>
            ) : (
              <>
                <ul id={listId} role="listbox" aria-label="Products">
                  {items.map((p, i) => (
                    <li
                      key={p.id}
                      id={`${uid}-opt-${p.id}`}
                      role="option"
                      aria-selected={value?.id === p.id}
                      // mouseDown (not click) so the choice happens before the input loses focus.
                      onMouseDown={(e) => { e.preventDefault(); choose(p); }}
                      onMouseEnter={() => setHi(i)}
                      className={`flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm ${i === hi ? 'bg-brand-50' : ''}`}
                    >
                      <span>
                        <span className="font-medium text-slate-900">{p.name}</span>
                        {p.code && <span className="ml-2 text-xs text-slate-500">{p.code}</span>}
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-xs text-slate-500">
                        {!book && <BookBadge book={p.book} />}
                        In stock: {p.qtyOnHand}
                      </span>
                    </li>
                  ))}
                </ul>
                {total > items.length && <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">Showing {items.length} of {total}. Type to narrow the list.</p>}
                {onCreateProduct && <div className="border-t border-slate-100 px-3 pb-2">{newProductButton}</div>}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
