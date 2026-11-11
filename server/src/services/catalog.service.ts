/**
 * services/catalog.service.ts - categories, products and suppliers (the "catalog").
 *
 * Layer: service (route -> SERVICE -> repository -> database). Holds the rules for what may be created or
 * changed; the repositories only run SQL, and the database triggers of migration 003 are the backstop.
 *
 * Business rules implemented here:
 *  - Segments are disjoint (section 0/1): a product's book is ALWAYS its category's book, and it can never
 *    change afterwards (a product can only move to another category of the same book).
 *  - Default categories (e.g. "Scratch Cards", telecom) cannot be renamed or moved to another book.
 *  - C12: the selling price is an owner-entered field, never derived from the average cost.
 *  - Services (printing...) hold no stock, so their reorder level must be 0.
 *  - Names are unique ignoring upper/lower case; codes likewise. Nothing is deleted, only made inactive (section 12).
 *  - Money is whole cents (section 0); the average unit cost shown on a product is for DISPLAY only (section 3).
 * Every create/update is written to the audit log inside the same transaction (section 12).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { mulDivRound } from '../lib/money.ts';
import {
  findCategoryByName, getCategory, insertCategory, listCategories, updateCategory,
} from '../repositories/categories.repo.ts';
import type { CategoryRow } from '../repositories/categories.repo.ts';
import {
  findProductByCode, findProductByName, getProduct, insertProduct, listProducts, updateProduct,
} from '../repositories/products.repo.ts';
import type { ProductRow } from '../repositories/products.repo.ts';
import {
  findSupplierByName, getSupplier, insertSupplier, listSuppliers, updateSupplier,
} from '../repositories/suppliers.repo.ts';
import type { SupplierRow } from '../repositories/suppliers.repo.ts';
import { logAudit } from './audit.service.ts';
import {
  NOTE_MAX_LENGTH, assertNoFieldErrors, notFound, trimmed, validationError,
} from './validation.ts';
import type { Fields } from './validation.ts';

/** The two stock-holding books. (Ice Cream has no products; it is handled by its own records, section 10.) */
export type Book = 'shop' | 'telecom';
/** `stock` items are counted; `service` items (printing...) are not. */
export type Kind = 'stock' | 'service';

export type Category = CategoryRow;
export type Supplier = SupplierRow;
/** A product as returned by the API: the stored fields plus two derived display values. */
export interface Product {
  id: number; code: string | null; name: string; description: string;
  categoryId: number; categoryName: string; kind: Kind; book: Book;
  sellPriceCents: number; minPriceCents: number; reorderLevel: number; active: boolean;
  qtyOnHand: number; stockValueCents: number; avgUnitCostCents: number | null; lowStock: boolean;
  createdAt: string; updatedAt: string;
}

// ---------- limits (shared by the checks below) ----------

/** Largest accepted price / reorder level in cents (Rs 9,999,999.99) - keeps later sums inside safe integers. */
const MAX_CENTS = 999999999;
const CATEGORY_NAME_MAX = 60;
const PRODUCT_NAME_MAX = 120;
const SUPPLIER_NAME_MAX = 120;
const PRODUCT_CODE_MAX = 30;
const PRODUCT_DESCRIPTION_MAX = 500;
const SUPPLIER_PHONE_MAX = 30;

// ---------- shared helpers ----------

/** A required text field: trimmed, 1..max characters. Problems are recorded in `fields`. */
function reqText(fields: Fields, key: string, label: string, value: string, max: number): string {
  return trimmed(fields, key, label, value, 1, max);
}

/** An optional text field: trimmed, 0..max characters. */
function optText(fields: Fields, key: string, label: string, value: string, max: number): string {
  return trimmed(fields, key, label, value, 0, max);
}

/** Checks that a money amount is a whole number of cents between 0 and MAX_CENTS. */
function checkCents(fields: Fields, key: string, label: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0 || v > MAX_CENTS) {
    fields[key] = `${label} must be a whole number of cents between 0 and ${MAX_CENTS}.`;
  }
}

/** 409 DUPLICATE_NAME for a category/product/supplier ("Another product already uses this name."). */
function dupName(noun: string): AppError {
  const message = `Another ${noun} already uses this name.`;
  return new AppError(409, 'DUPLICATE_NAME', message, { name: message });
}

/** 409 DUPLICATE_CODE for a product. */
function dupCode(noun: string): AppError {
  const message = `Another ${noun} already uses this code.`;
  return new AppError(409, 'DUPLICATE_CODE', message, { code: message });
}

/**
 * Maps a SQLite UNIQUE abort to the contract's duplicate errors. The services check for duplicates first; this
 * only fires if two requests raced (the database UNIQUE constraint is the final guard).
 */
function mapUniqueAbort(err: unknown): never {
  const msg = err instanceof Error ? err.message : '';
  const m = /UNIQUE constraint failed: (categories|products|suppliers)\.(name|code)/.exec(msg);
  if (m) {
    const noun = m[1] === 'categories' ? 'category' : m[1] === 'products' ? 'product' : 'supplier';
    throw m[2] === 'name' ? dupName(noun) : dupCode(noun);
  }
  throw err;
}

/** One database transaction; a UNIQUE-constraint abort becomes DUPLICATE_NAME / DUPLICATE_CODE. */
function runWrite<T>(ctx: AppContext, fn: (conn: DatabaseSync) => T): T {
  try {
    return ctx.database.tx(fn);
  } catch (err) {
    return mapUniqueAbort(err);
  }
}

// ---------- categories ----------

/** Lists categories (shop first, then telecom), optionally filtered by active flag and book. */
export function listCategoryItems(ctx: AppContext, q: { active?: boolean; book?: Book }): { items: Category[] } {
  return { items: listCategories(ctx.database.conn, q) };
}

/**
 * Creates a category.
 *
 * @throws AppError 400 VALIDATION_ERROR (empty/too long name), 409 DUPLICATE_NAME.
 */
export function createCategory(ctx: AppContext, body: { name: string; book: Book }): Category {
  const fields: Fields = {};
  const name = reqText(fields, 'name', 'Name', body.name, CATEGORY_NAME_MAX);
  assertNoFieldErrors(fields);
  return runWrite(ctx, (conn) => {
    if (findCategoryByName(conn, name)) throw dupName('category');
    const id = insertCategory(conn, { name, book: body.book });
    const after = getCategory(conn, id)!;
    logAudit(conn, 'category', String(id), 'create', null, after);
    return after;
  });
}

/**
 * Renames, moves to another book, or (de)activates a category. Nothing is written when nothing changed.
 *
 * @throws AppError 404 NOT_FOUND; 409 DEFAULT_CATEGORY_LOCKED (name/book of a built-in category);
 *   409 CATEGORY_HAS_PRODUCTS (book change while products use it); 409 DUPLICATE_NAME; 400 VALIDATION_ERROR.
 */
export function updateCategoryItem(
  ctx: AppContext, id: number, body: { name?: string; book?: Book; active?: boolean },
): Category {
  return runWrite(ctx, (conn) => {
    const before = getCategory(conn, id);
    if (!before) throw notFound('Category');
    const fields: Fields = {};
    const name = body.name === undefined ? undefined : reqText(fields, 'name', 'Name', body.name, CATEGORY_NAME_MAX);
    assertNoFieldErrors(fields);

    // Build a patch of only the values that really differ from what is stored.
    const patch: { name?: string; book?: Book; active?: boolean } = {};
    if (name !== undefined && name !== before.name) patch.name = name;
    if (body.book !== undefined && body.book !== before.book) patch.book = body.book;
    if (body.active !== undefined && body.active !== before.active) patch.active = body.active;
    if (Object.keys(patch).length === 0) return before;

    if (before.isDefault && (patch.name !== undefined || patch.book !== undefined)) {
      throw new AppError(409, 'DEFAULT_CATEGORY_LOCKED', 'The name and book of a default category cannot be changed.');
    }
    if (patch.name !== undefined) {
      const other = findCategoryByName(conn, patch.name);
      if (other && other.id !== id) throw dupName('category');
    }
    if (patch.book !== undefined && before.productCount > 0) {
      throw new AppError(409, 'CATEGORY_HAS_PRODUCTS',
        'The book of a category that has products cannot be changed.');
    }
    updateCategory(conn, id, patch);
    const after = getCategory(conn, id)!;
    logAudit(conn, 'category', String(id), 'update', before, after);
    return after;
  });
}

// ---------- products ----------

/**
 * Adds the two derived display fields to a stored product.
 * - `avgUnitCostCents` = stock value / quantity, rounded with the one money helper (section 3); null when
 *   nothing is in stock. It is for display only: selling prices are never derived from it (C12).
 * - `lowStock` = an active stock item with a reorder level set and quantity at or below it.
 */
function toProduct(r: ProductRow): Product {
  return {
    id: r.id, code: r.code, name: r.name, description: r.description,
    categoryId: r.categoryId, categoryName: r.categoryName, kind: r.kind, book: r.book,
    sellPriceCents: r.sellPriceCents, minPriceCents: r.minPriceCents, reorderLevel: r.reorderLevel,
    active: r.active, qtyOnHand: r.qtyOnHand, stockValueCents: r.stockValueCents,
    avgUnitCostCents: r.qtyOnHand > 0 ? mulDivRound(r.stockValueCents, 1, r.qtyOnHand) : null,
    lowStock: r.kind === 'stock' && r.active && r.reorderLevel > 0 && r.qtyOnHand <= r.reorderLevel,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

export interface ProductListQuery {
  q?: string; book?: Book; categoryId?: number; lowStock?: boolean; active?: boolean; limit: number; offset: number;
}

/** Lists products A-Z with the total match count; filters as in `ProductListQuery`. */
export function listProductItems(ctx: AppContext, q: ProductListQuery): { items: Product[]; total: number } {
  const r = listProducts(ctx.database.conn, q);
  return { items: r.items.map(toProduct), total: r.total };
}

/** One product by id. @throws AppError 404 NOT_FOUND. */
export function getProductItem(ctx: AppContext, id: number): Product {
  const row = getProduct(ctx.database.conn, id);
  if (!row) throw notFound('Product');
  return toProduct(row);
}

/** Normalises an optional product code: blank means "no code" (null); too long is recorded in `fields`. */
function normCode(fields: Fields, code: string | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  const v = code.trim();
  if (v === '') return null;
  if (v.length > PRODUCT_CODE_MAX) fields.code = `Code must be at most ${PRODUCT_CODE_MAX} characters.`;
  return v;
}

/**
 * Checks selling price, minimum price and reorder level (problems go into `fields`).
 * The "minimum is not above selling" comparison is skipped when either price is already invalid, so one
 * mistake does not produce two confusing messages. (The table has the same CHECK as a backstop.)
 */
function checkPrices(fields: Fields, sell: number, min: number, kind: Kind, reorder: number): void {
  checkCents(fields, 'sellPriceCents', 'Selling price', sell);
  checkCents(fields, 'minPriceCents', 'Minimum price', min);
  if (!fields.sellPriceCents && !fields.minPriceCents && min > sell) {
    fields.minPriceCents = 'Minimum price cannot be higher than the selling price.';
  }
  if (!Number.isSafeInteger(reorder) || reorder < 0 || reorder > MAX_CENTS) {
    fields.reorderLevel = `Reorder level must be a whole number between 0 and ${MAX_CENTS}.`;
  } else if (kind === 'service' && reorder !== 0) {
    fields.reorderLevel = 'Services do not hold stock, so the reorder level must be 0.';
  }
}

/** Loads the chosen category or fails with a field error on `categoryId`. */
function chooseCategory(conn: DatabaseSync, categoryId: number): CategoryRow {
  const cat = getCategory(conn, categoryId);
  if (!cat) throw validationError({ categoryId: 'Choose a category.' });
  return cat;
}

/** 400 CATEGORY_INACTIVE: new products and moves may only target an active category. */
function inactiveCategory(): AppError {
  const message = 'This category is inactive. Choose an active category.';
  return new AppError(400, 'CATEGORY_INACTIVE', message, { categoryId: message });
}

export interface ProductCreate {
  code?: string; name: string; description?: string; categoryId: number; kind: Kind;
  sellPriceCents: number; minPriceCents: number; reorderLevel?: number;
}

/**
 * Creates a product with zero stock. Its book is taken from its category (the client cannot choose it),
 * which is how the "segments are disjoint" rule is guaranteed. Stock only ever arrives through stock movements.
 *
 * @throws AppError 400 VALIDATION_ERROR / CATEGORY_INACTIVE, 409 DUPLICATE_NAME / DUPLICATE_CODE.
 */
export function createProduct(ctx: AppContext, body: ProductCreate): Product {
  const fields: Fields = {};
  const name = reqText(fields, 'name', 'Name', body.name, PRODUCT_NAME_MAX);
  const code = normCode(fields, body.code);
  const description = optText(fields, 'description', 'Description', body.description ?? '', PRODUCT_DESCRIPTION_MAX);
  const reorder = body.reorderLevel ?? 0;
  checkPrices(fields, body.sellPriceCents, body.minPriceCents, body.kind, reorder);
  assertNoFieldErrors(fields);

  return runWrite(ctx, (conn) => {
    const cat = chooseCategory(conn, body.categoryId);
    if (!cat.active) throw inactiveCategory();
    if (findProductByName(conn, name)) throw dupName('product');
    if (code !== null && findProductByCode(conn, code)) throw dupCode('product');
    const id = insertProduct(conn, {
      code, name, description, categoryId: cat.id, kind: body.kind, book: cat.book,
      sellPriceCents: body.sellPriceCents, minPriceCents: body.minPriceCents, reorderLevel: reorder,
    });
    const after = toProduct(getProduct(conn, id)!);
    logAudit(conn, 'product', String(id), 'create', null, after);
    return after;
  });
}

export interface ProductUpdate {
  code?: string | null; name?: string; description?: string; categoryId?: number;
  sellPriceCents?: number; minPriceCents?: number; reorderLevel?: number; active?: boolean;
}

/**
 * Edits a product. Only changed values are written; if nothing changed the stored product is returned and no
 * audit entry is made. Kind and book never change; a category move must stay inside the same book.
 *
 * @throws AppError 404 NOT_FOUND; 400 VALIDATION_ERROR / CATEGORY_BOOK_MISMATCH / CATEGORY_INACTIVE;
 *   409 DUPLICATE_NAME / DUPLICATE_CODE.
 */
export function updateProductItem(ctx: AppContext, id: number, body: ProductUpdate): Product {
  return runWrite(ctx, (conn) => {
    const row = getProduct(conn, id);
    if (!row) throw notFound('Product');
    const before = toProduct(row);

    // Start from the stored values and overlay what the request supplied, then validate the final state.
    const fields: Fields = {};
    const name = body.name === undefined ? before.name : reqText(fields, 'name', 'Name', body.name, PRODUCT_NAME_MAX);
    const code = body.code === undefined ? before.code : normCode(fields, body.code);
    const description = body.description === undefined
      ? before.description : optText(fields, 'description', 'Description', body.description, PRODUCT_DESCRIPTION_MAX);
    const sell = body.sellPriceCents ?? before.sellPriceCents;
    const min = body.minPriceCents ?? before.minPriceCents;
    const reorder = body.reorderLevel ?? before.reorderLevel;
    checkPrices(fields, sell, min, before.kind, reorder);
    assertNoFieldErrors(fields);

    const categoryId = body.categoryId ?? before.categoryId;
    const active = body.active ?? before.active;
    const patch: Parameters<typeof updateProduct>[2] = {};
    if (name !== before.name) patch.name = name;
    if (code !== before.code) patch.code = code;
    if (description !== before.description) patch.description = description;
    if (sell !== before.sellPriceCents) patch.sellPriceCents = sell;
    if (min !== before.minPriceCents) patch.minPriceCents = min;
    if (reorder !== before.reorderLevel) patch.reorderLevel = reorder;
    if (active !== before.active) patch.active = active;
    if (categoryId !== before.categoryId) {
      const cat = chooseCategory(conn, categoryId);
      if (cat.book !== before.book) {
        const message = 'A product can only move to a category in the same book.';
        throw new AppError(400, 'CATEGORY_BOOK_MISMATCH', message, { categoryId: message });
      }
      if (!cat.active) throw inactiveCategory();
      patch.categoryId = categoryId;
    }
    if (Object.keys(patch).length === 0) return before;

    if (patch.name !== undefined) {
      const other = findProductByName(conn, patch.name);
      if (other && other.id !== id) throw dupName('product');
    }
    if (patch.code !== undefined && patch.code !== null) {
      const other = findProductByCode(conn, patch.code);
      if (other && other.id !== id) throw dupCode('product');
    }
    // A product's book never changes (same-book moves only), so `book` is not patched.
    updateProduct(conn, id, patch);
    const after = toProduct(getProduct(conn, id)!);
    logAudit(conn, 'product', String(id), 'update', before, after);
    return after;
  });
}

// ---------- suppliers ----------

/** Lists suppliers A-Z; `q` searches name and phone. */
export function listSupplierItems(ctx: AppContext, q: { q?: string; active?: boolean }): { items: Supplier[] } {
  return { items: listSuppliers(ctx.database.conn, q) };
}

/**
 * Creates a supplier.
 *
 * @throws AppError 400 VALIDATION_ERROR, 409 DUPLICATE_NAME.
 */
export function createSupplier(ctx: AppContext, body: { name: string; phone?: string; notes?: string }): Supplier {
  const fields: Fields = {};
  const name = reqText(fields, 'name', 'Name', body.name, SUPPLIER_NAME_MAX);
  const phone = optText(fields, 'phone', 'Phone', body.phone ?? '', SUPPLIER_PHONE_MAX);
  const notes = optText(fields, 'notes', 'Notes', body.notes ?? '', NOTE_MAX_LENGTH);
  assertNoFieldErrors(fields);
  return runWrite(ctx, (conn) => {
    if (findSupplierByName(conn, name)) throw dupName('supplier');
    const id = insertSupplier(conn, { name, phone, notes });
    const after = getSupplier(conn, id)!;
    logAudit(conn, 'supplier', String(id), 'create', null, after);
    return after;
  });
}

/**
 * Edits or (de)activates a supplier; nothing is written when nothing changed.
 *
 * @throws AppError 404 NOT_FOUND, 400 VALIDATION_ERROR, 409 DUPLICATE_NAME.
 */
export function updateSupplierItem(
  ctx: AppContext, id: number, body: { name?: string; phone?: string; notes?: string; active?: boolean },
): Supplier {
  return runWrite(ctx, (conn) => {
    const before = getSupplier(conn, id);
    if (!before) throw notFound('Supplier');
    const fields: Fields = {};
    const name = body.name === undefined ? before.name : reqText(fields, 'name', 'Name', body.name, SUPPLIER_NAME_MAX);
    const phone = body.phone === undefined
      ? before.phone : optText(fields, 'phone', 'Phone', body.phone, SUPPLIER_PHONE_MAX);
    const notes = body.notes === undefined
      ? before.notes : optText(fields, 'notes', 'Notes', body.notes, NOTE_MAX_LENGTH);
    assertNoFieldErrors(fields);

    const patch: { name?: string; phone?: string; notes?: string; active?: boolean } = {};
    if (name !== before.name) patch.name = name;
    if (phone !== before.phone) patch.phone = phone;
    if (notes !== before.notes) patch.notes = notes;
    if (body.active !== undefined && body.active !== before.active) patch.active = body.active;
    if (Object.keys(patch).length === 0) return before;

    if (patch.name !== undefined) {
      const other = findSupplierByName(conn, patch.name);
      if (other && other.id !== id) throw dupName('supplier');
    }
    updateSupplier(conn, id, patch);
    const after = getSupplier(conn, id)!;
    logAudit(conn, 'supplier', String(id), 'update', before, after);
    return after;
  });
}
