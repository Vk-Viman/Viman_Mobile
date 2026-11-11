import { useMemo, useState } from 'react';
import { FormDialog } from '../../components/FormDialog';
import { MoneyInput } from '../../components/MoneyInput';
import { SelectField } from '../../components/SelectField';
import { TextField, inputClass } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { ApiError } from '../../api/client';
import { useCategories, useCreateProduct, useUpdateProduct } from '../../api/catalog';
import { centsToRupees, rupeesToCents } from '../../lib/units';
import type { Category, Product, ProductCreate, ProductKind, ProductUpdate } from '../../types/api';
import { BOOK_LABEL, CHECKBOX_CLASS } from './shared';

const MAX_CENTS = 999999999;
const KNOWN_FIELDS = ['name', 'code', 'categoryId', 'kind', 'description', 'sellPriceCents', 'minPriceCents', 'reorderLevel', 'active'];

interface Props {
  product: Product | null; // null = create
  onClose: () => void;
}

export function ProductDialog({ product, onClose }: Props) {
  const editing = product !== null;
  const toast = useToast();
  const create = useCreateProduct();
  const update = useUpdateProduct();
  const cats = useCategories({ active: true });

  const [name, setName] = useState(product?.name ?? '');
  const [code, setCode] = useState(product?.code ?? '');
  const [categoryId, setCategoryId] = useState(product ? String(product.categoryId) : '');
  const [kind, setKind] = useState<ProductKind>(product?.kind ?? 'stock');
  const [description, setDescription] = useState(product?.description ?? '');
  const [sell, setSell] = useState(product ? centsToRupees(product.sellPriceCents) : '');
  const [min, setMin] = useState(product ? centsToRupees(product.minPriceCents) : '');
  const [reorder, setReorder] = useState(product ? String(product.reorderLevel) : '0');
  const [active, setActive] = useState(product?.active ?? true);
  const [serverErr, setServerErr] = useState<ApiError | Error | null>(null);

  const isService = kind === 'service';

  // Categories on offer: active ones; when editing, only the same book (plus the current one, even if inactive).
  const options = useMemo(() => {
    const list: Category[] = (cats.data?.items ?? []).filter((c) => !product || c.book === product.book);
    return list;
  }, [cats.data, product]);
  const currentMissing = product && cats.data && !options.some((c) => c.id === product.categoryId);

  const errors = useMemo(() => {
    const e: Record<string, string> = {};
    const n = name.trim();
    if (n.length < 1) e.name = 'Enter a product name.';
    else if (n.length > 120) e.name = 'Name can be at most 120 characters.';
    if (code.trim().length > 30) e.code = 'Code can be at most 30 characters.';
    if (description.length > 500) e.description = 'Description can be at most 500 characters.';
    if (!categoryId) e.categoryId = 'Choose a category.';
    const sc = rupeesToCents(sell);
    const mc = rupeesToCents(min);
    if (sc === null || sc > MAX_CENTS) e.sellPriceCents = 'Enter a valid selling price (up to 2 decimals).';
    if (mc === null || mc > MAX_CENTS) e.minPriceCents = 'Enter a valid minimum price (up to 2 decimals).';
    if (sc !== null && mc !== null && !e.sellPriceCents && !e.minPriceCents && mc > sc) {
      e.minPriceCents = 'Minimum price cannot be higher than the selling price.';
    }
    if (!isService && (!/^\d{1,9}$/.test(reorder.trim()))) e.reorderLevel = 'Enter a whole number, 0 or more.';
    return e;
  }, [name, code, description, categoryId, sell, min, reorder, isService]);

  const body = useMemo<ProductUpdate>(() => {
    if (!product) return {};
    const b: ProductUpdate = {};
    const sc = rupeesToCents(sell);
    const mc = rupeesToCents(min);
    if (name.trim() !== product.name) b.name = name.trim();
    if (code.trim() !== (product.code ?? '')) b.code = code.trim() === '' ? null : code.trim();
    if (description !== product.description) b.description = description;
    if (Number(categoryId) !== product.categoryId && categoryId) b.categoryId = Number(categoryId);
    if (sc !== null && sc !== product.sellPriceCents) b.sellPriceCents = sc;
    if (mc !== null && mc !== product.minPriceCents) b.minPriceCents = mc;
    if (!isService && /^\d{1,9}$/.test(reorder.trim()) && Number(reorder) !== product.reorderLevel) b.reorderLevel = Number(reorder);
    if (active !== product.active) b.active = active;
    return b;
  }, [product, name, code, description, categoryId, sell, min, reorder, active, isService]);

  const valid = Object.keys(errors).length === 0;
  const dirty = !editing || Object.keys(body).length > 0;
  const pending = create.isPending || update.isPending;

  const fieldErr = (k: string): string | undefined => {
    // Empty required fields are not flagged up front; Save stays disabled until they are filled.
    const quiet = (k === 'name' && name.trim() === '') || (k === 'categoryId' && !categoryId) || (k === 'sellPriceCents' && sell.trim() === '') || (k === 'minPriceCents' && min.trim() === '');
    if (errors[k] && !quiet) return errors[k];
    return serverErr instanceof ApiError ? serverErr.fields[k] : undefined;
  };
  const bannerMsg =
    serverErr && !(serverErr instanceof ApiError && Object.keys(serverErr.fields).some((k) => KNOWN_FIELDS.includes(k)))
      ? serverErr.message
      : null;

  const onSuccess = () => {
    toast.success(editing ? 'Product updated.' : 'Product added.');
    onClose();
  };

  const submit = () => {
    setServerErr(null);
    if (product) {
      update.mutate({ id: product.id, body }, { onSuccess, onError: (e) => setServerErr(e) });
      return;
    }
    const payload: ProductCreate = {
      name: name.trim(),
      categoryId: Number(categoryId),
      kind,
      sellPriceCents: rupeesToCents(sell) ?? 0,
      minPriceCents: rupeesToCents(min) ?? 0,
      reorderLevel: isService ? 0 : Number(reorder),
    };
    if (code.trim()) payload.code = code.trim();
    if (description) payload.description = description;
    create.mutate(payload, { onSuccess, onError: (e) => setServerErr(e) });
  };

  const grouped = (['shop', 'telecom'] as const).map((b) => ({ book: b, items: options.filter((c) => c.book === b) }));

  return (
    <FormDialog
      title={editing ? `Edit product: ${product.name}` : 'New product'}
      submitLabel={editing ? 'Save changes' : 'Add product'}
      canSubmit={valid && dirty}
      loading={pending}
      error={bannerMsg}
      onSubmit={submit}
      onClose={onClose}
    >
      <TextField label="Name *" value={name} onChange={(e) => setName(e.target.value)} error={fieldErr('name')} maxLength={200} autoComplete="off" />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Code" value={code} onChange={(e) => setCode(e.target.value)} error={fieldErr('code')} hint="Optional. Must be unique." autoComplete="off" />
        <SelectField
          label="Kind *"
          value={kind}
          onChange={(e) => {
            const k = e.target.value as ProductKind;
            setKind(k);
            if (k === 'service') setReorder('0');
          }}
          disabled={editing}
          error={fieldErr('kind')}
          hint={editing ? 'Kind cannot be changed after the product is created.' : undefined}
        >
          <option value="stock">Stock item</option>
          <option value="service">Service</option>
        </SelectField>
      </div>
      <SelectField
        label="Category *"
        value={categoryId}
        onChange={(e) => setCategoryId(e.target.value)}
        error={fieldErr('categoryId')}
        hint={editing ? `Only ${BOOK_LABEL[product.book]} categories can be chosen.` : undefined}
      >
        <option value="">Choose a category…</option>
        {currentMissing && product && <option value={String(product.categoryId)}>{product.categoryName} (inactive)</option>}
        {grouped.map((g) =>
          g.items.length === 0 ? null : (
            <optgroup key={g.book} label={`${BOOK_LABEL[g.book]} book`}>
              {g.items.map((c) => (
                <option key={c.id} value={String(c.id)}>{c.name} ({BOOK_LABEL[c.book]})</option>
              ))}
            </optgroup>
          ),
        )}
      </SelectField>
      <div>
        <label htmlFor="product-desc" className="mb-1 block text-sm font-medium text-slate-700">Description</label>
        <textarea
          id="product-desc"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={inputClass(fieldErr('description'))}
        />
        {fieldErr('description') && <p className="mt-1 text-sm text-red-600">{fieldErr('description')}</p>}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <MoneyInput label="Selling price (Rs.) *" value={sell} onChange={setSell} error={fieldErr('sellPriceCents')} />
        <MoneyInput label="Minimum selling price (Rs.) *" value={min} onChange={setMin} error={fieldErr('minPriceCents')} />
        <TextField
          label="Reorder level"
          inputMode="numeric"
          value={isService ? '0' : reorder}
          onChange={(e) => setReorder(e.target.value)}
          disabled={isService}
          error={fieldErr('reorderLevel')}
          hint={isService ? 'Services do not hold stock.' : undefined}
        />
      </div>
      {editing && (
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" className={CHECKBOX_CLASS} checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active
        </label>
      )}
    </FormDialog>
  );
}
