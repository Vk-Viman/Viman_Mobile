/**
 * ProductDialog: the add / edit form for one product (Products > Products, and any screen that needs a new product).
 * API: POST /products (create; with `newCategory` the category is created in the same request) and
 * PUT /products/:id (edit, sending only changed fields), plus GET /categories?active=true (api/catalog.ts).
 * Category-first: the owner picks Shop or Telecom, then a category of THAT book (or "+ Create new category…"), then
 * the details, so a Shop product can never land in a Telecom category by accident. Switching the book clears the
 * chosen category. Reusable: other screens (Purchases, POS, stock) mount it with `defaultBook`, `defaultCategoryId`
 * and `onCreated` (see ProductDialogProps).
 * Prices are typed in rupees and converted to integer cents with rupeesToCents() so no floating-point money is
 * ever sent. All checks here are quick feedback only: the server validates everything again and is authoritative.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/Button';
import { FormDialog } from '../../components/FormDialog';
import { MoneyInput } from '../../components/MoneyInput';
import { SelectField } from '../../components/SelectField';
import { TextField, inputClass } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { ApiError } from '../../api/client';
import { useCategories, useCreateProduct, useUpdateProduct } from '../../api/catalog';
import { BOOK_LABEL, CHECKBOX_CLASS } from '../../lib/constants';
import { centsToRupees, rupeesToCents } from '../../lib/units';
import type { Book, Category, Product, ProductCreate, ProductKind, ProductUpdate } from '../../types/api';
import { CategoryBookChoice } from './CategoryBookChoice';
import { CATEGORY_NAME_MAX } from './CategoryDialog';

/** Largest price accepted (in cents), so an accidental extra digit is caught before it reaches the server. */
const MAX_CENTS = 999999999;
/** Field length limits, matching the server's validation. */
const MAX_NAME = 120;
const MAX_CODE = 30;
const MAX_DESCRIPTION = 500;
/** Whole-number pattern for the reorder level (up to 9 digits). */
const REORDER_RE = /^\d{1,9}$/;
/** Server field names this dialog shows under their inputs; any other server error becomes the banner. */
const KNOWN_FIELDS = ['name', 'code', 'categoryId', 'kind', 'description', 'sellPriceCents', 'minPriceCents', 'reorderLevel', 'active'];
/** Value of the category drop-down that means "create a new category in this book". */
const NEW_CATEGORY = '__new';

/** Props of the reusable product dialog. Mount it only while open. */
export interface ProductDialogProps {
  /** The product to edit, or null/omitted to create one. */
  product?: Product | null;
  /** Create mode: pre-select this book (the screen already knows it). The owner can still change it. */
  defaultBook?: Book;
  /** Create mode: pre-select this category (its book is used when `defaultBook` is not given). */
  defaultCategoryId?: number;
  /** Called with the product the server created, right before `onClose` (so callers can select it). */
  onCreated?: (product: Product) => void;
  onClose: () => void;
}

/** Add/edit product form. Mount only while open so every opening starts from the product's saved values. */
export function ProductDialog({ product = null, defaultBook, defaultCategoryId, onCreated, onClose }: ProductDialogProps) {
  const editing = product !== null;
  const toast = useToast();
  const create = useCreateProduct();
  const update = useUpdateProduct();
  const cats = useCategories({ active: true });

  // ---- Form fields, held as text exactly as typed ----
  const [name, setName] = useState(product?.name ?? '');
  const [code, setCode] = useState(product?.code ?? '');
  // '' = not chosen yet: no default, so the owner must choose Shop or Telecom on purpose.
  const [book, setBookState] = useState<Book | ''>(product?.book ?? defaultBook ?? '');
  // '' = none, NEW_CATEGORY = "create new", otherwise a category id as text.
  const [categoryId, setCategoryId] = useState(product ? String(product.categoryId) : defaultCategoryId ? String(defaultCategoryId) : '');
  const [newCategoryName, setNewCategoryName] = useState('');
  // Whether the last submit carried `newCategory`, to tell a category-name clash from a product-name clash.
  const [sentNewCategory, setSentNewCategory] = useState(false);
  const [kind, setKind] = useState<ProductKind>(product?.kind ?? 'stock');
  const [description, setDescription] = useState(product?.description ?? '');
  const [sell, setSell] = useState(product ? centsToRupees(product.sellPriceCents) : '');
  const [min, setMin] = useState(product ? centsToRupees(product.minPriceCents) : '');
  const [reorder, setReorder] = useState(product ? String(product.reorderLevel) : '0');
  const [active, setActive] = useState(product?.active ?? true);
  const [serverErr, setServerErr] = useState<ApiError | Error | null>(null);

  const isService = kind === 'service';
  const creatingCategory = categoryId === NEW_CATEGORY;

  // Only a default CATEGORY was given: take its book as soon as the category list arrives.
  useEffect(() => {
    if (book !== '' || !defaultCategoryId || !cats.data) return;
    const c = cats.data.items.find((x) => x.id === defaultCategoryId);
    if (c) setBookState(c.book);
  }, [book, defaultCategoryId, cats.data]);

  /** Switching the book clears the category (and any typed new name): a category belongs to exactly one book. */
  const setBook = (b: Book) => {
    if (b === book) return;
    setBookState(b);
    setCategoryId('');
    setNewCategoryName('');
    setServerErr(null);
  };

  // Categories on offer: ACTIVE ones of the chosen book only.
  const options = useMemo<Category[]>(() => (cats.data?.items ?? []).filter((c) => c.book === book), [cats.data, book]);
  // When editing, the current category may be inactive and so missing from the list; it is then added back.
  const currentMissing = product && cats.data && book === product.book && !options.some((c) => c.id === product.categoryId);

  // Local validation messages by field. Recomputed only when an input changes (useMemo).
  const errors = useMemo(() => {
    const e: Record<string, string> = {};
    const n = name.trim();
    if (n.length < 1) e.name = 'Enter a product name.';
    else if (n.length > MAX_NAME) e.name = `Name can be at most ${MAX_NAME} characters.`;
    if (code.trim().length > MAX_CODE) e.code = `Code can be at most ${MAX_CODE} characters.`;
    if (description.length > MAX_DESCRIPTION) e.description = `Description can be at most ${MAX_DESCRIPTION} characters.`;
    if (!book) e.book = 'Choose Shop or Telecom.';
    if (!categoryId) e.categoryId = 'Choose a category.';
    if (creatingCategory) {
      const cn = newCategoryName.trim();
      if (cn.length < 1) e.newCategory = 'Enter the new category name.';
      else if (cn.length > CATEGORY_NAME_MAX) e.newCategory = `Name can be at most ${CATEGORY_NAME_MAX} characters.`;
    }
    const sc = rupeesToCents(sell);
    const mc = rupeesToCents(min);
    if (sc === null || sc > MAX_CENTS) e.sellPriceCents = 'Enter a valid selling price (up to 2 decimals).';
    if (mc === null || mc > MAX_CENTS) e.minPriceCents = 'Enter a valid minimum price (up to 2 decimals).';
    // Cross-field rule: the floor price may not exceed the normal selling price.
    if (sc !== null && mc !== null && !e.sellPriceCents && !e.minPriceCents && mc > sc) {
      e.minPriceCents = 'Minimum price cannot be higher than the selling price.';
    }
    if (!isService && (!REORDER_RE.test(reorder.trim()))) e.reorderLevel = 'Enter a whole number, 0 or more.';
    return e;
  }, [name, code, description, book, categoryId, creatingCategory, newCategoryName, sell, min, reorder, isService]);

  // When editing: the partial update containing ONLY the fields that differ from the saved product.
  const body = useMemo<ProductUpdate>(() => {
    if (!product) return {};
    const b: ProductUpdate = {};
    const sc = rupeesToCents(sell);
    const mc = rupeesToCents(min);
    if (name.trim() !== product.name) b.name = name.trim();
    // An emptied code box means "remove the code" (null), not an empty-string code.
    if (code.trim() !== (product.code ?? '')) b.code = code.trim() === '' ? null : code.trim();
    if (description !== product.description) b.description = description;
    if (Number(categoryId) !== product.categoryId && categoryId && !creatingCategory) b.categoryId = Number(categoryId);
    if (sc !== null && sc !== product.sellPriceCents) b.sellPriceCents = sc;
    if (mc !== null && mc !== product.minPriceCents) b.minPriceCents = mc;
    if (!isService && REORDER_RE.test(reorder.trim()) && Number(reorder) !== product.reorderLevel) b.reorderLevel = Number(reorder);
    if (active !== product.active) b.active = active;
    return b;
  }, [product, name, code, description, categoryId, creatingCategory, sell, min, reorder, active, isService]);

  const valid = Object.keys(errors).length === 0;
  // "dirty": creating is always submittable; editing needs at least one change.
  const dirty = !editing || Object.keys(body).length > 0;
  const pending = create.isPending || update.isPending;

  // A "name already used" answer to a request that carried `newCategory` is about the CATEGORY name (the product
  // duplicate message says "product"); it is shown under the new-category box with a way to reuse the existing one.
  const categoryClash =
    sentNewCategory && serverErr instanceof ApiError && serverErr.code === 'DUPLICATE_NAME' && !/product/i.test(serverErr.message);
  // The server also returns `existingCategoryId`, but the shared API client does not expose extra error keys, so the
  // existing category is found in the (active) category list by book + name instead.
  const existingCategory = categoryClash
    ? (cats.data?.items ?? []).find((c) => c.book === book && c.name.toLowerCase() === newCategoryName.trim().toLowerCase())
    : undefined;

  const fieldErr = (k: string): string | undefined => {
    if (k === 'name' && categoryClash) return undefined;
    // Empty required fields are not flagged up front; Save stays disabled until they are filled.
    const quiet =
      (k === 'name' && name.trim() === '') || (k === 'categoryId' && !categoryId) || k === 'book' ||
      (k === 'newCategory' && newCategoryName.trim() === '') ||
      (k === 'sellPriceCents' && sell.trim() === '') || (k === 'minPriceCents' && min.trim() === '');
    if (errors[k] && !quiet) return errors[k];
    return serverErr instanceof ApiError ? serverErr.fields[k] : undefined;
  };
  // Server errors about fields we do not display (or no fields at all) go into one banner.
  const bannerMsg =
    serverErr && !categoryClash && !(serverErr instanceof ApiError && Object.keys(serverErr.fields).some((k) => KNOWN_FIELDS.includes(k)))
      ? serverErr.message
      : null;

  const submit = () => {
    setServerErr(null);
    if (product) {
      update.mutate({ id: product.id, body }, {
        onSuccess: () => { toast.success('Product updated.'); onClose(); },
        onError: (e) => setServerErr(e),
      });
      return;
    }
    // The text was validated above, so the conversions to cents cannot be null here ("?? 0" only satisfies the type).
    const payload: ProductCreate = {
      name: name.trim(),
      kind,
      sellPriceCents: rupeesToCents(sell) ?? 0,
      minPriceCents: rupeesToCents(min) ?? 0,
      reorderLevel: isService ? 0 : Number(reorder),
    };
    // Exactly one of categoryId / newCategory (the new category is created in the same transaction).
    if (creatingCategory && book !== '') payload.newCategory = { name: newCategoryName.trim(), book };
    else payload.categoryId = Number(categoryId);
    if (code.trim()) payload.code = code.trim();
    if (description) payload.description = description;
    setSentNewCategory(creatingCategory);
    create.mutate(payload, {
      onSuccess: (res) => {
        toast.success(creatingCategory ? 'Product and category added.' : 'Product added.');
        onCreated?.(res.item);
        onClose();
      },
      onError: (e) => setServerErr(e),
    });
  };

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
      {/* Step 1: the book. Fixed (shown, not editable) when editing: moving a product between books is not allowed. */}
      <CategoryBookChoice
        label="1. Business book *"
        value={book}
        onChange={setBook}
        disabled={editing}
        hint={editing ? 'The book of an existing product cannot be changed.' : 'Choose Shop or Telecom first. Then only categories of that book are offered.'}
      />
      {/* Step 2: the category, limited to the chosen book. */}
      <div>
        <SelectField
          label="2. Category *"
          value={categoryId}
          onChange={(e) => { setCategoryId(e.target.value); setServerErr(null); }}
          disabled={book === ''}
          error={fieldErr('categoryId')}
          hint={book === '' ? 'Choose the business book first.' : editing ? `Only ${BOOK_LABEL[product.book]} categories can be chosen.` : undefined}
        >
          <option value="">{book === '' ? 'Choose the book first…' : 'Choose a category…'}</option>
          {currentMissing && product && <option value={String(product.categoryId)}>{product.categoryName} (inactive)</option>}
          {options.map((c) => (
            <option key={c.id} value={String(c.id)}>{c.name}</option>
          ))}
          {!editing && book !== '' && <option value={NEW_CATEGORY}>+ Create new category…</option>}
        </SelectField>
        {cats.isError && (
          <p role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-sm text-red-600">
            Could not load categories.
            <Button variant="ghost" className="!min-h-8 !px-2" onClick={() => void cats.refetch()}>Retry</Button>
          </p>
        )}
        {book !== '' && cats.isSuccess && options.length === 0 && !creatingCategory && (
          <p className="mt-1 text-xs text-slate-500">There is no active {BOOK_LABEL[book]} category yet. Choose “+ Create new category…”.</p>
        )}
      </div>
      {creatingCategory && book !== '' && (
        <div className="rounded-lg border border-brand-200 bg-brand-50 p-3">
          <TextField
            label={`New ${BOOK_LABEL[book]} category name *`}
            value={newCategoryName}
            onChange={(e) => { setNewCategoryName(e.target.value); setServerErr(null); }}
            error={fieldErr('newCategory') ?? (categoryClash && serverErr ? serverErr.message : undefined)}
            hint={`The new category is added to the ${BOOK_LABEL[book]} book together with this product.`}
            maxLength={CATEGORY_NAME_MAX + 20}
            autoComplete="off"
          />
          {existingCategory && (
            <Button
              variant="secondary"
              className="mt-2"
              onClick={() => { setCategoryId(String(existingCategory.id)); setNewCategoryName(''); setServerErr(null); }}
            >
              Use the existing category “{existingCategory.name}”
            </Button>
          )}
        </div>
      )}
      {/* Step 3: the details. */}
      <TextField label="3. Product name *" value={name} onChange={(e) => setName(e.target.value)} error={fieldErr('name')} maxLength={200} autoComplete="off" />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Code" value={code} onChange={(e) => setCode(e.target.value)} error={fieldErr('code')} hint="Optional. Must be unique." autoComplete="off" />
        <SelectField
          label="Kind *"
          value={kind}
          onChange={(e) => {
            const k = e.target.value as ProductKind;
            setKind(k);
            // Services hold no stock, so their reorder level is forced to 0.
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
