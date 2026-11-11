/**
 * ProductFilter: "filter by product" control for the sales History filter bar.
 * The sales API filters by product id (not by text), so this is a two-step control: type part of a name or code,
 * then pick the product from the matches. Picking "All products" clears the filter.
 * API: GET /products?q=&limit= (api/catalog.ts). Inactive and service products are included on purpose: old sales
 * may involve products that are no longer sold.
 */
import { useState } from 'react';
import { SearchField } from '../../components/SearchField';
import { SelectField } from '../../components/SelectField';
import { useProducts } from '../../api/catalog';
import { useDebounced } from '../../hooks/useDebounced';

interface Props {
  /** Selected product id as text; '' = all products. */
  value: string;
  onChange: (productId: string) => void;
}

/** Two stacked fields: a search box and a drop-down of the matching products. */
export function ProductFilter({ value, onChange }: Props) {
  const [text, setText] = useState('');
  const q = useDebounced(text.trim());
  const list = useProducts({ q: q || undefined, limit: 30 });
  const items = list.data?.items ?? [];

  return (
    <div className="space-y-2">
      <SearchField label="Find product" placeholder="Name or code" value={text} onChange={setText} />
      <SelectField label="Product" hideLabel value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All products</option>
        {/* Keep the chosen product selectable even if a later search no longer lists it. */}
        {value && !items.some((p) => String(p.id) === value) && <option value={value}>Selected product #{value}</option>}
        {items.map((p) => <option key={p.id} value={String(p.id)}>{p.name}{p.code ? ` (${p.code})` : ''}</option>)}
      </SelectField>
    </div>
  );
}
