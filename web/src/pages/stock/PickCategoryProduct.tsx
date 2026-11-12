/**
 * PickCategoryProduct: category-first product selection for the stock-loss and personal-use dialogs.
 * Step 1 Category (both books, tagged Shop/Telecom), step 2 only that category's stock products, step 3 optional search inside it.
 * Why local and not the shared CategoryProductPicker: BUSINESS_RULES §13A decision 6 and the server allow stock losses and
 * personal use of INACTIVE products, while the shared picker lists active products only. This variant uses the same rules
 * (category first, product cleared when the category changes, stock items only, no services) but keeps inactive products
 * (marked "(inactive)"), exactly as these dialogs did before. Presentation only: no stock or accounting logic here.
 * API: GET /categories, GET /products?categoryId=&q=&kind=stock (api/catalog.ts).
 */
import { useState } from 'react';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { useCategories, useProducts } from '../../api/catalog';
import { useDebounced } from '../../hooks/useDebounced';
import { BOOK_LABEL } from '../../lib/constants';
import type { Product } from '../../types/api';

/** Products loaded for one category; the search box narrows further. */
const LIMIT = 500;

interface Props {
  value: Product | null;
  onChange: (p: Product | null) => void;
  /** Server/validation message for the product box. */
  error?: string;
}

export function PickCategoryProduct({ value, onChange, error }: Props) {
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());

  const cats = useCategories({});
  const categories = cats.data?.items ?? [];

  const list = useProducts({ categoryId: categoryId ?? undefined, q: q || undefined, kind: 'stock', limit: LIMIT });
  // Client guard: never offer a product of another category (the list may be the previous one while a new one loads) or a service.
  const items = categoryId === null ? [] : (list.data?.items ?? []).filter((p) => p.kind === 'stock' && p.categoryId === categoryId);
  // Keep the chosen product in the options even if the search text hides it.
  const options = value && value.categoryId === categoryId && !items.some((p) => p.id === value.id) ? [value, ...items] : items;

  const empty = categoryId !== null && list.isSuccess && !list.isFetching && options.length === 0;

  return (
    <>
      <SelectField
        label="Category"
        value={categoryId === null ? '' : String(categoryId)}
        disabled={cats.isPending}
        onChange={(e) => {
          // Changing the category always clears the product and the search: the product may belong to the old category.
          setCategoryId(e.target.value === '' ? null : Number(e.target.value));
          onChange(null);
          setSearch('');
        }}
        error={cats.isError ? 'Could not load categories.' : undefined}
      >
        <option value="">Choose a category…</option>
        {categories.map((c) => (
          <option key={c.id} value={String(c.id)}>{c.name} ({BOOK_LABEL[c.book]}){c.active ? '' : ' (inactive)'}</option>
        ))}
      </SelectField>
      <TextField
        label="Find product"
        placeholder={categoryId === null ? 'Choose a category first' : 'Type a name or code'}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        disabled={categoryId === null}
        autoComplete="off"
      />
      <SelectField
        label="Product"
        value={value ? String(value.id) : ''}
        disabled={categoryId === null}
        onChange={(e) => onChange(options.find((p) => String(p.id) === e.target.value) ?? null)}
        error={error}
        hint={
          value
            ? `${BOOK_LABEL[value.book]} book — ${value.qtyOnHand} in stock now`
            : categoryId === null
              ? 'Products are shown after you choose a category.'
              : empty
                ? q ? 'No product in this category matches your search.' : 'This category has no stock products yet.'
                : undefined
        }
      >
        <option value="">Select a product</option>
        {options.map((p) => (
          <option key={p.id} value={String(p.id)}>
            {p.name}{p.code ? ` (${p.code})` : ''} — {p.qtyOnHand} in stock{p.active ? '' : ' (inactive)'}
          </option>
        ))}
      </SelectField>
    </>
  );
}
