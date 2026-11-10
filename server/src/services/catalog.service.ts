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

export type Book = 'shop' | 'telecom';
export type Kind = 'stock' | 'service';
type Fields = Record<string, string>;

export type Category = CategoryRow;
export type Supplier = SupplierRow;
export interface Product {
  id: number; code: string | null; name: string; description: string;
  categoryId: number; categoryName: string; kind: Kind; book: Book;
  sellPriceCents: number; minPriceCents: number; reorderLevel: number; active: boolean;
  qtyOnHand: number; stockValueCents: number; avgUnitCostCents: number | null; lowStock: boolean;
  createdAt: string; updatedAt: string;
}

const MAX_CENTS = 999999999;

// ---------- shared helpers ----------

function validationError(fields: Fields): AppError {
  return new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', fields);
}

function notFound(what: string): AppError {
  return new AppError(404, 'NOT_FOUND', `${what} not found.`);
}

/** Checks a required trimmed string; records the message in `fields` and returns the trimmed value. */
function reqText(fields: Fields, key: string, label: string, value: string, max: number): string {
  const v = value.trim();
  if (v.length < 1) fields[key] = `${label} is required.`;
  else if (v.length > max) fields[key] = `${label} must be at most ${max} characters.`;
  return v;
}

function optText(fields: Fields, key: string, label: string, value: string, max: number): string {
  const v = value.trim();
  if (v.length > max) fields[key] = `${label} must be at most ${max} characters.`;
  return v;
}

function checkCents(fields: Fields, key: string, label: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0 || v > MAX_CENTS) {
    fields[key] = `${label} must be a whole number of cents between 0 and ${MAX_CENTS}.`;
  }
}

function dupName(noun: string): AppError {
  const message = `Another ${noun} already uses this name.`;
  return new AppError(409, 'DUPLICATE_NAME', message, { name: message });
}

function dupCode(noun: string): AppError {
  const message = `Another ${noun} already uses this code.`;
  return new AppError(409, 'DUPLICATE_CODE', message, { code: message });
}

/** Maps a SQLite UNIQUE abort (e.g. a lost race) to the contract's duplicate errors. */
function mapUniqueAbort(err: unknown): never {
  const msg = err instanceof Error ? err.message : '';
  const m = /UNIQUE constraint failed: (categories|products|suppliers)\.(name|code)/.exec(msg);
  if (m) {
    const noun = m[1] === 'categories' ? 'category' : m[1] === 'products' ? 'product' : 'supplier';
    throw m[2] === 'name' ? dupName(noun) : dupCode(noun);
  }
  throw err;
}

function runWrite<T>(ctx: AppContext, fn: (conn: DatabaseSync) => T): T {
  try {
    return ctx.database.tx(fn);
  } catch (err) {
    return mapUniqueAbort(err);
  }
}

// ---------- categories ----------

export function listCategoryItems(ctx: AppContext, q: { active?: boolean; book?: Book }): { items: Category[] } {
  return { items: listCategories(ctx.database.conn, q) };
}

export function createCategory(ctx: AppContext, body: { name: string; book: Book }): Category {
  const fields: Fields = {};
  const name = reqText(fields, 'name', 'Name', body.name, 60);
  if (Object.keys(fields).length > 0) throw validationError(fields);
  return runWrite(ctx, (conn) => {
    if (findCategoryByName(conn, name)) throw dupName('category');
    const id = insertCategory(conn, { name, book: body.book });
    const after = getCategory(conn, id)!;
    logAudit(conn, 'category', String(id), 'create', null, after);
    return after;
  });
}

export function updateCategoryItem(
  ctx: AppContext, id: number, body: { name?: string; book?: Book; active?: boolean },
): Category {
  return runWrite(ctx, (conn) => {
    const before = getCategory(conn, id);
    if (!before) throw notFound('Category');
    const fields: Fields = {};
    const name = body.name === undefined ? undefined : reqText(fields, 'name', 'Name', body.name, 60);
    if (Object.keys(fields).length > 0) throw validationError(fields);

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

export function listProductItems(ctx: AppContext, q: ProductListQuery): { items: Product[]; total: number } {
  const r = listProducts(ctx.database.conn, q);
  return { items: r.items.map(toProduct), total: r.total };
}

export function getProductItem(ctx: AppContext, id: number): Product {
  const row = getProduct(ctx.database.conn, id);
  if (!row) throw notFound('Product');
  return toProduct(row);
}

function normCode(fields: Fields, code: string | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  const v = code.trim();
  if (v === '') return null;
  if (v.length > 30) fields.code = 'Code must be at most 30 characters.';
  return v;
}

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

function chooseCategory(conn: DatabaseSync, categoryId: number): CategoryRow {
  const cat = getCategory(conn, categoryId);
  if (!cat) throw validationError({ categoryId: 'Choose a category.' });
  return cat;
}

function inactiveCategory(): AppError {
  const message = 'This category is inactive. Choose an active category.';
  return new AppError(400, 'CATEGORY_INACTIVE', message, { categoryId: message });
}

export interface ProductCreate {
  code?: string; name: string; description?: string; categoryId: number; kind: Kind;
  sellPriceCents: number; minPriceCents: number; reorderLevel?: number;
}

export function createProduct(ctx: AppContext, body: ProductCreate): Product {
  const fields: Fields = {};
  const name = reqText(fields, 'name', 'Name', body.name, 120);
  const code = normCode(fields, body.code);
  const description = optText(fields, 'description', 'Description', body.description ?? '', 500);
  const reorder = body.reorderLevel ?? 0;
  checkPrices(fields, body.sellPriceCents, body.minPriceCents, body.kind, reorder);
  if (Object.keys(fields).length > 0) throw validationError(fields);

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

export function updateProductItem(ctx: AppContext, id: number, body: ProductUpdate): Product {
  return runWrite(ctx, (conn) => {
    const row = getProduct(conn, id);
    if (!row) throw notFound('Product');
    const before = toProduct(row);

    const fields: Fields = {};
    const name = body.name === undefined ? before.name : reqText(fields, 'name', 'Name', body.name, 120);
    const code = body.code === undefined ? before.code : normCode(fields, body.code);
    const description = body.description === undefined
      ? before.description : optText(fields, 'description', 'Description', body.description, 500);
    const sell = body.sellPriceCents ?? before.sellPriceCents;
    const min = body.minPriceCents ?? before.minPriceCents;
    const reorder = body.reorderLevel ?? before.reorderLevel;
    checkPrices(fields, sell, min, before.kind, reorder);
    if (Object.keys(fields).length > 0) throw validationError(fields);

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

export function listSupplierItems(ctx: AppContext, q: { q?: string; active?: boolean }): { items: Supplier[] } {
  return { items: listSuppliers(ctx.database.conn, q) };
}

export function createSupplier(ctx: AppContext, body: { name: string; phone?: string; notes?: string }): Supplier {
  const fields: Fields = {};
  const name = reqText(fields, 'name', 'Name', body.name, 120);
  const phone = optText(fields, 'phone', 'Phone', body.phone ?? '', 30);
  const notes = optText(fields, 'notes', 'Notes', body.notes ?? '', 500);
  if (Object.keys(fields).length > 0) throw validationError(fields);
  return runWrite(ctx, (conn) => {
    if (findSupplierByName(conn, name)) throw dupName('supplier');
    const id = insertSupplier(conn, { name, phone, notes });
    const after = getSupplier(conn, id)!;
    logAudit(conn, 'supplier', String(id), 'create', null, after);
    return after;
  });
}

export function updateSupplierItem(
  ctx: AppContext, id: number, body: { name?: string; phone?: string; notes?: string; active?: boolean },
): Supplier {
  return runWrite(ctx, (conn) => {
    const before = getSupplier(conn, id);
    if (!before) throw notFound('Supplier');
    const fields: Fields = {};
    const name = body.name === undefined ? before.name : reqText(fields, 'name', 'Name', body.name, 120);
    const phone = body.phone === undefined ? before.phone : optText(fields, 'phone', 'Phone', body.phone, 30);
    const notes = body.notes === undefined ? before.notes : optText(fields, 'notes', 'Notes', body.notes, 500);
    if (Object.keys(fields).length > 0) throw validationError(fields);

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
