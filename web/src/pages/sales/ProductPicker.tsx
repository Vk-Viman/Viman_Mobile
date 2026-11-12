/**
 * ProductPicker: the left half of the POS. Category-first selection of sellable products:
 *   1. optional book filter (All / Shop / Telecom), 2. category (or "All categories"), 3. the list shows only the
 *   ACTIVE stock products of that category/book, 4. a search box narrows inside that list, 5. click (or Enter) adds one unit.
 * Where: Sales > POS. API: GET /categories?active=true, GET /products (via useCategories / useProductsByCategory in api/catalog.ts,
 * the same hooks and rules as the shared CategoryProductPicker; the POS needs a list presentation, so the panel is local).
 * Rules: inactive and service products are never listed (server filter active=true, kind=stock, plus a client guard against a
 * stale list of the previous category); stock on hand and price are shown as read from the server. Presentation only:
 * the cart, costs, stock checks and book split stay exactly as before (PosTab / cart.ts).
 * Keyboard: Enter in the search box adds the first match of the current list. A barcode scanner types a code and presses Enter:
 * when the code is not in the current category/book, it is looked up across ALL categories and books (exact code match).
 */
import { useEffect, useState } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { Money } from '../../components/Money';
import { SearchField } from '../../components/SearchField';
import { SelectField } from '../../components/SelectField';
import { Spinner } from '../../components/Spinner';
import { BookBadge } from '../../components/StatusBadges';
import { apiGet } from '../../api/client';
import { qs } from '../../api/queryString';
import { useCategories, useProductsByCategory } from '../../api/catalog';
import { useDebounced } from '../../hooks/useDebounced';
import { BOOK_LABEL } from '../../lib/constants';
import type { Book, Product, ProductList } from '../../types/api';

/** How many matches to fetch for the picker; a cashier narrows by typing rather than paging. */
const PICKER_LIMIT = 30;

/** @param onAdd called with the chosen product (one unit is added; the cart increments an existing line). */
export function ProductPicker({ onAdd }: { onAdd: (p: Product) => void }) {
  const [book, setBook] = useState<Book | null>(null);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [text, setText] = useState('');
  const q = useDebounced(text.trim());
  // Enter pressed before the debounced search caught up: remember it and add once the fresh results arrive.
  const [enterPending, setEnterPending] = useState(false);

  const cats = useCategories({ active: true, book: book ?? undefined });
  const categories = cats.data?.items ?? [];
  const category = categories.find((c) => c.id === categoryId) ?? null;

  const list = useProductsByCategory({ book: book ?? undefined, categoryId, q, limit: PICKER_LIMIT });
  // The server already filters (active, stock, category, book); the client guard also drops a stale list kept on screen
  // while the next category loads, so a product of the previous category can never be clicked.
  const items = (list.data?.items ?? []).filter(
    (p) => p.active && p.kind === 'stock' && (categoryId === null || p.categoryId === categoryId) && (!book || p.book === book),
  );
  // "Settled" = the results on screen belong to exactly what is typed and chosen.
  const settled = text.trim() === q && !list.isFetching && !list.isPlaceholderData && list.data !== undefined;

  const add = (p: Product) => {
    onAdd(p);
    setText('');
  };

  /** Scanner fallback: the typed text matched nothing here, so look for an exact code in every category and book. */
  const scanAnywhere = async (code: string) => {
    try {
      const r = await apiGet<ProductList>(`/products${qs({ q: code, active: true, kind: 'stock', limit: 10 })}`);
      const hit = r.items.find((p) => p.active && p.kind === 'stock' && p.code !== null && p.code.toLowerCase() === code.toLowerCase());
      if (hit) add(hit);
    } catch {
      /* the list shows its own error state; a failed scan lookup just adds nothing */
    }
  };

  const enter = () => {
    const first = items[0];
    if (first) add(first);
    else if (text.trim() && (categoryId !== null || book !== null)) void scanAnywhere(text.trim());
  };

  useEffect(() => {
    if (enterPending && settled) {
      setEnterPending(false);
      enter();
    }
    // `enter` changes every render; the effect must react only to the search settling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enterPending, settled]);

  // Changing book or category resets the search and any pending Enter so nothing from the old selection lingers.
  const changeBook = (b: Book | null) => {
    setBook(b);
    setCategoryId(null);
    setText('');
    setEnterPending(false);
  };
  const changeCategory = (id: number | null) => {
    setCategoryId(id);
    setText('');
    setEnterPending(false);
  };

  const scope = category ? category.name : book ? `${BOOK_LABEL[book]} products` : 'all categories';

  return (
    <Card title="Products">
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Book"
          value={book ?? ''}
          onChange={(e) => changeBook(e.target.value === '' ? null : (e.target.value as Book))}
        >
          <option value="">All (Shop + Telecom)</option>
          <option value="shop">{BOOK_LABEL.shop}</option>
          <option value="telecom">{BOOK_LABEL.telecom}</option>
        </SelectField>
        <SelectField
          label="Category"
          value={categoryId === null ? '' : String(categoryId)}
          disabled={cats.isPending}
          onChange={(e) => changeCategory(e.target.value === '' ? null : Number(e.target.value))}
          error={cats.isError ? 'Could not load categories.' : undefined}
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={String(c.id)}>{book ? c.name : `${c.name} (${BOOK_LABEL[c.book]})`}</option>
          ))}
        </SelectField>
      </div>
      {category && (
        <p className="mt-2 flex items-center justify-between gap-2 text-sm text-slate-600">
          <span>Showing: <span className="font-medium text-slate-900">{category.name}</span> <span className="text-xs">({BOOK_LABEL[category.book]})</span></span>
          <Button variant="ghost" className="!min-h-8 !px-2" onClick={() => changeCategory(null)}>Change category</Button>
        </p>
      )}

      <div className="mt-3">
        <SearchField
          label="Find product"
          placeholder={category ? `Search in ${category.name}, Enter adds` : 'Type a name or code, press Enter to add'}
          value={text}
          onChange={setText}
          autoFocus
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (settled) enter();
            else if (text.trim()) setEnterPending(true);
          }}
        />
      </div>
      <div className="mt-3">
        {list.isPending || (list.isPlaceholderData && list.isFetching && items.length === 0) ? (
          <div className="flex justify-center py-8"><Spinner label="Loading products" /></div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            title={q ? 'No product matches your search' : category ? `No active products in ${category.name} yet` : 'No products found'}
            hint={
              q
                ? `Nothing in ${scope} matches. Try another name or code${category || book ? ', or change the category' : ''}.`
                : category
                  ? 'Add products to this category in Products, or choose another category.'
                  : 'Only active stock products can be sold here.'
            }
            action={category ? <Button variant="secondary" onClick={() => changeCategory(null)}>Change category</Button> : undefined}
          />
        ) : (
          <div className="max-h-[28rem] overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <th scope="col" className="px-2 py-2 text-left">Code</th>
                  <th scope="col" className="px-2 py-2 text-left">Name</th>
                  <th scope="col" className="px-2 py-2 text-left">Book</th>
                  <th scope="col" className="px-2 py-2 text-right">In stock</th>
                  <th scope="col" className="px-2 py-2 text-right">Price</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p, i) => (
                  <tr key={p.id} className="cursor-pointer border-b border-slate-100 hover:bg-slate-50" onClick={() => add(p)}>
                    <td className="px-2 py-2 text-slate-600">{p.code ?? '—'}</td>
                    <td className="px-2 py-2">
                      {/* A real button so keyboard users can add with Tab + Enter/Space, not only by mouse. */}
                      <button
                        type="button"
                        className="text-left font-medium text-brand-700 underline-offset-2 hover:underline"
                        onClick={(e) => { e.stopPropagation(); add(p); }}
                      >
                        {p.name}
                      </button>
                      {i === 0 && q && <span className="ml-2 text-xs text-slate-400">(Enter adds this)</span>}
                    </td>
                    <td className="px-2 py-2"><BookBadge book={p.book} /></td>
                    <td className="num px-2 py-2 text-right">
                      {p.qtyOnHand <= 0 ? <Badge tone="red">Out of stock</Badge> : p.qtyOnHand}
                    </td>
                    <td className="px-2 py-2 text-right"><Money cents={p.sellPriceCents} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
