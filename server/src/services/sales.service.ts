/**
 * services/sales.service.ts - POS sales (cart -> one sale per book), sales history and sale voids.
 *
 * Layer: service (route -> SERVICE -> repository -> database). Business rules implemented here:
 *  - Section 4: a cart is split by the product's book into one sale per book (Shop first, then Telecom); lines
 *         keep their cart order inside each sale. Shop lines are type `goods`, Telecom lines `card`.
 *  - Section 3 / C5: every line removes stock at the weighted average of the pool AT THAT MOMENT, in cart order,
 *         so the same product on two lines is checked cumulatively. The value removed is the line's frozen
 *         `cogsCents`; the unit cost is only a display snapshot. Later purchases never change an old sale.
 *  - Section 2: one cash-in entry per sale with a total above zero (`sale_goods` Shop / `card_sale` Telecom).
 *  - C13: a cart line may carry `unitCostCents` (cost per unit to charge, never below the automatic cost). The
 *         extra above the automatic cost is stored on the line; stock, movements and cash ignore it.
 *  - R13: a low price never blocks the sale; it produces warnings (PRICE_BELOW_MINIMUM, PRICE_BELOW_COST,
 *         ZERO_COST) that carry the cart position of the line.
 *  - R1 / C6: a void never edits or deletes; the stock movements are exactly negated, the cash entry is cancelled
 *         by a reversing entry that keeps the sale's business date, and the sale is only marked `void`.
 *         A sale that has returns cannot be voided.
 *  - R-FD: no future-dated sales. Section 12: `clientRef` makes a repeated cart return the saved sales; every
 *         write is audited with its business date and backdated flag.
 * A whole cart (both books) is saved in ONE database transaction: sales, lines, stock movements, cash, audit.
 * Sales returns live in `sales-returns.service.ts` and are re-exported from here.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { findCashEntriesByRef, insertCashEntry } from '../repositories/cash-entries.repo.ts';
import { getProduct } from '../repositories/products.repo.ts';
import type { ProductRow } from '../repositories/products.repo.ts';
import { listMovementsByRef } from '../repositories/stock-movements.repo.ts';
import {
  getSale as getSaleRow, getSaleByClientRef, insertSale, insertSaleItem, listSaleReturns, listSales as listSaleRows,
  markSaleVoid,
} from '../repositories/sales.repo.ts';
import type { SaleBook, SaleStatus, SalesTotals } from '../repositories/sales.repo.ts';
import { logAudit } from './audit.service.ts';
import { issueStock, reverseMovements } from './inventory.service.ts';
import {
  BOOK_ORDER, LINE_TYPE, SALE_CASH_TYPE, extraCostFor, loadSale, runSalesWrite, toSale, unitCostOf,
} from './sales-common.ts';
import type { Sale } from './sales-common.ts';
import {
  NOTE_MAX_LENGTH, REASON_MAX_LENGTH, alreadyVoid, assertNoFieldErrors, checkBusinessDate, isBackdatedToday,
  notFound, trimmed, validationError,
} from './validation.ts';
import type { Fields } from './validation.ts';

export type { Sale, SaleItem, SaleReturn, SaleReturnLine } from './sales-common.ts';
export { createSaleReturn } from './sales-returns.service.ts';
export type { SaleReturnCreate } from './sales-returns.service.ts';

/** One line of the cart as sent by the browser. */
export interface SaleCartLine { productId: number; qty: number; unitPriceCents: number; unitCostCents?: number }
/** Body of `POST /sales`. */
export interface SaleCreate { businessDate: string; items: SaleCartLine[]; notes?: string; clientRef: string }

/** R13 warning codes. They never block a sale. */
export type SaleWarningCode = 'PRICE_BELOW_MINIMUM' | 'PRICE_BELOW_COST' | 'ZERO_COST';
/** A non-blocking notice about one cart line; `lineIndex` is the line's position in the submitted cart (0-based). */
export interface SaleWarning { code: SaleWarningCode; message: string; lineIndex: number }

/** A cart line after product lookup: its cart position, the product row and the exact revenue. */
interface CartLine { index: number; line: SaleCartLine; product: ProductRow; revenueCents: number }
/** A sale header that has been inserted and is receiving lines. */
interface OpenSale { id: number; book: SaleBook; nextLineNo: number }

// ---------- reads ----------

/** One sale with lines and returns. @throws AppError 404 NOT_FOUND. */
export function getSale(ctx: AppContext, id: number): Sale {
  return loadSale(ctx.database.conn, id);
}

/**
 * Lists sales newest business date first. `totals` cover the POSTED sales that match the filter (voided sales are
 * listed but never summed); `cogsCents` is the automatic cost, `extraCostCents` the C13 extra, `costCents` their
 * sum, `refundsCents` the sum of their returns' refunds.
 */
export function listSales(ctx: AppContext, q: {
  from?: string; to?: string; book?: SaleBook; status?: SaleStatus; productId?: number; limit: number; offset: number;
}): { items: Sale[]; total: number; totals: SalesTotals } {
  const conn = ctx.database.conn;
  const { items, total, totals } = listSaleRows(conn, q);
  return { items: items.map((h) => toSale(conn, h)), total, totals };
}

// ---------- create: validation helpers ----------

/**
 * Looks up every cart product and refuses what cannot be sold (in this order, each as one error for all lines):
 * unknown product (400 VALIDATION_ERROR), service product (400 PRODUCT_NOT_SELLABLE_YET - services arrive in
 * Phase 7), inactive product (400 PRODUCT_INACTIVE).
 */
function resolveSellableProducts(conn: DatabaseSync, items: SaleCartLine[]): ProductRow[] {
  const missing: Fields = {};
  const found = items.map((line, i) => {
    const p = getProduct(conn, line.productId);
    if (!p) missing[`items.${i}.productId`] = 'Product not found.';
    return p;
  });
  assertNoFieldErrors(missing);
  const products = found as ProductRow[];

  const services: Fields = {};
  const inactive: Fields = {};
  products.forEach((p, i) => {
    if (p.kind !== 'stock') services[`items.${i}.productId`] = `${p.name} is a service and cannot be sold here yet.`;
    else if (!p.active) inactive[`items.${i}.productId`] = `${p.name} is inactive.`;
  });
  if (Object.keys(services).length > 0) {
    throw new AppError(400, 'PRODUCT_NOT_SELLABLE_YET', 'Service products cannot be sold yet.', services);
  }
  if (Object.keys(inactive).length > 0) {
    throw new AppError(400, 'PRODUCT_INACTIVE', 'An inactive product cannot be sold.', inactive);
  }
  return products;
}

/**
 * Pairs each cart line with its product and computes the exact revenue (`qty x unitPrice`, no rounding).
 * Every sale total is checked to be a safe integer so no later sum can silently lose cents.
 */
function priceCart(items: SaleCartLine[], products: ProductRow[]): CartLine[] {
  const totals: Record<SaleBook, number> = { shop: 0, telecom: 0 };
  const lines = items.map((line, index): CartLine => {
    const product = products[index] as ProductRow;
    const revenueCents = line.qty * line.unitPriceCents;
    if (!Number.isSafeInteger(revenueCents)) {
      throw validationError({ [`items.${index}.unitPriceCents`]: 'This line total is too large.' });
    }
    totals[product.book] += revenueCents;
    return { index, line, product, revenueCents };
  });
  for (const book of BOOK_ORDER) {
    if (!Number.isSafeInteger(totals[book])) throw validationError({ items: 'The sale total is too large.' });
  }
  return lines;
}

/** The sales already saved for this cart reference (one per book at most), Shop first. */
function findSalesByClientRef(conn: DatabaseSync, clientRef: string) {
  const found = [];
  for (const book of BOOK_ORDER) {
    const row = getSaleByClientRef(conn, clientRef, book);
    if (row) found.push(row);
  }
  return found;
}

// ---------- create: writing ----------

/**
 * Inserts one sale header per book present in the cart (Shop first). Headers come first because the stock
 * movements and lines refer to the sale id; the total is known up front because revenue is exactly qty x price.
 */
function openSales(conn: DatabaseSync, body: SaleCreate, notes: string, lines: CartLine[]): Map<SaleBook, OpenSale> {
  const open = new Map<SaleBook, OpenSale>();
  for (const book of BOOK_ORDER) {
    const own = lines.filter((l) => l.product.book === book);
    if (own.length === 0) continue;
    const totalCents = own.reduce((sum, l) => sum + l.revenueCents, 0);
    const id = insertSale(conn, { businessDate: body.businessDate, book, totalCents, notes, clientRef: body.clientRef });
    open.set(book, { id, book, nextLineNo: 1 });
  }
  return open;
}

/** Turns the pool's "not enough stock" into the contract's per-line error (`items.N.qty`, `onHand`). */
function shortageForLine(err: unknown, cart: CartLine): unknown {
  if (!(err instanceof AppError) || err.code !== 'INSUFFICIENT_STOCK') return err;
  const onHand = typeof err.extra?.onHand === 'number' ? err.extra.onHand : 0;
  return new AppError(422, 'INSUFFICIENT_STOCK',
    `Not enough stock for ${cart.product.name}: ${onHand} on hand, ${cart.line.qty} needed.`,
    { [`items.${cart.index}.qty`]: `Only ${onHand} in stock.` }, { onHand, productId: cart.product.id });
}

/**
 * Sells one cart line: removes the stock at the live weighted average (this is the line's COGS) and stores the
 * line with its frozen price and cost. If the cashier entered a cost per unit (C13) it is checked against the
 * automatic cost AFTER the stock was removed (the automatic cost is only known then); a refusal throws and the
 * whole cart's transaction rolls back. Because it runs in cart order against the live pool, the same product on
 * several lines is checked cumulatively.
 *
 * @returns The frozen automatic unit cost and COGS (needed for the R13 warnings, which ignore the extra).
 */
function sellLine(conn: DatabaseSync, sale: OpenSale, cart: CartLine, businessDate: string) {
  let removed;
  try {
    removed = issueStock(conn, {
      productId: cart.product.id, businessDate, type: 'sale', qty: cart.line.qty,
      refTable: 'sales', refId: sale.id, reason: `Sale #${sale.id}`,
    });
  } catch (err) {
    throw shortageForLine(err, cart);
  }
  const cogsCents = removed.valueRemovedCents;
  const unitCostCents = unitCostOf(cogsCents, cart.line.qty);
  const entered = cart.line.unitCostCents;
  const extraCostCents = entered === undefined
    ? 0
    : extraCostFor(cogsCents, cart.line.qty, entered, `items.${cart.index}.unitCostCents`);
  insertSaleItem(conn, {
    saleId: sale.id, lineNo: sale.nextLineNo++, lineType: LINE_TYPE[sale.book], productId: cart.product.id,
    description: cart.product.name, qty: cart.line.qty, unitPriceCents: cart.line.unitPriceCents,
    unitCostCents, revenueCents: cart.revenueCents, cogsCents, extraCostCents,
  });
  return { cogsCents, unitCostCents };
}

/** R13: advisory notices for one line. They are returned to the cashier and never block the sale. */
function lineWarnings(cart: CartLine, sold: { cogsCents: number; unitCostCents: number }): SaleWarning[] {
  const name = cart.product.name;
  const price = cart.line.unitPriceCents;
  const out: SaleWarning[] = [];
  if (price < cart.product.minPriceCents) {
    out.push({ code: 'PRICE_BELOW_MINIMUM', lineIndex: cart.index, message: `${name} is priced below its minimum price.` });
  }
  if (price < sold.unitCostCents) {
    out.push({ code: 'PRICE_BELOW_COST', lineIndex: cart.index, message: `${name} is priced below its cost.` });
  }
  if (sold.cogsCents === 0) {
    out.push({ code: 'ZERO_COST', lineIndex: cart.index, message: `${name} has no recorded cost, so this sale shows full profit.` });
  }
  return out;
}

/**
 * Saves a cart: one sale per book, a stock outflow per line (cart order), one cash-in entry per sale with a
 * total above zero, and an audit row per sale - all in one transaction (a failed line rolls everything back).
 *
 * Idempotent by `clientRef`: if sales with this reference exist (one per book) ALL of them are returned with
 * `created: false`, no warnings, and nothing is written (protects against double clicks and retries).
 *
 * @throws AppError 400 VALIDATION_ERROR (fields, unknown product, totals too large), 400 FUTURE_DATE_NOT_ALLOWED
 *   (R-FD), 400 PRODUCT_NOT_SELLABLE_YET (service product), 400 PRODUCT_INACTIVE, 422 INSUFFICIENT_STOCK
 *   (`fields["items.N.qty"]`, `onHand`), 422 COST_BELOW_AUTOMATIC (C13, `fields["items.N.unitCostCents"]`,
 *   `minUnitCostCents`).
 * @returns The sales (Shop first), the R13 warnings and whether the sales were newly created.
 */
export function createSales(
  ctx: AppContext, body: SaleCreate,
): { sales: Sale[]; warnings: SaleWarning[]; created: boolean } {
  const fields: Fields = {};
  const notes = trimmed(fields, 'notes', 'Notes', body.notes, 0, NOTE_MAX_LENGTH);
  assertNoFieldErrors(fields);
  checkBusinessDate(body.businessDate); // schema -> real date -> R-FD

  return runSalesWrite(ctx, (conn) => {
    // Idempotency first: a retry must succeed even if prices, stock or products have changed since.
    const existing = findSalesByClientRef(conn, body.clientRef);
    if (existing.length > 0) return { sales: existing.map((h) => toSale(conn, h)), warnings: [], created: false };

    const lines = priceCart(body.items, resolveSellableProducts(conn, body.items));
    const open = openSales(conn, body, notes, lines);

    const warnings: SaleWarning[] = [];
    for (const cart of lines) {
      const sold = sellLine(conn, open.get(cart.product.book) as OpenSale, cart, body.businessDate);
      warnings.push(...lineWarnings(cart, sold));
    }

    const sales: Sale[] = [];
    for (const book of BOOK_ORDER) {
      const sale = open.get(book);
      if (!sale) continue;
      const item = loadSale(conn, sale.id);
      // A zero-total sale (everything free) moves no cash, so it has no cash entry.
      if (item.totalCents > 0) {
        insertCashEntry(conn, {
          book, businessDate: item.businessDate, type: SALE_CASH_TYPE[book], amountCents: item.totalCents,
          refTable: 'sales', refId: item.id,
        });
      }
      logAudit(conn, 'sale', String(item.id), 'create', null, item, undefined,
        { businessDate: item.businessDate, backdated: item.backdated });
      sales.push(item);
    }
    return { sales, warnings, created: true };
  });
}

// ---------- void ----------

/**
 * Voids a whole sale (R1, C6): its stock movements are exactly negated (stock and value return at the original
 * snapshot cost), its cash entry is cancelled by a reversing entry, and the sale is marked `void`. Nothing is
 * edited or deleted. Reversal rows keep the sale's business date so the correction lands in the same report
 * period (section 12); their posting time is now.
 *
 * @throws AppError 400 VALIDATION_ERROR (reason), 404 NOT_FOUND, 409 ALREADY_VOID, 409 HAS_RETURNS.
 */
export function voidSale(ctx: AppContext, id: number, body: { reason: string }): Sale {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason, 1, REASON_MAX_LENGTH);
  assertNoFieldErrors(fields);

  return runSalesWrite(ctx, (conn) => {
    const header = getSaleRow(conn, id);
    if (!header) throw notFound('Sale');
    if (header.status === 'void') throw alreadyVoid('sale');
    // A sale with returns is already partly undone; voiding it too would reverse the same goods twice.
    if (listSaleReturns(conn, id).length > 0) {
      throw new AppError(409, 'HAS_RETURNS', 'This sale has returns, so it cannot be voided.');
    }
    const before = toSale(conn, header);

    const movementIds = listMovementsByRef(conn, 'sales', id).map((m) => m.id);
    reverseMovements(conn, movementIds, `Void of sale #${id}`);
    reverseSaleCash(conn, before);

    markSaleVoid(conn, id, reason);
    const after = loadSale(conn, id);
    logAudit(conn, 'sale', String(id), 'void', before, after, reason,
      { businessDate: after.businessDate, backdated: isBackdatedToday(after.businessDate) });
    return after;
  });
}

/** Cancels the sale's cash-in entry with a negated entry of the same type that points back at it (R1, C6). */
function reverseSaleCash(conn: DatabaseSync, sale: Sale): void {
  if (sale.totalCents === 0) return; // a free sale never had a cash entry
  const type = SALE_CASH_TYPE[sale.book];
  const original = findCashEntriesByRef(conn, 'sales', sale.id)
    .find((e) => e.type === type && e.reversesEntryId === null);
  if (!original) throw new Error(`Sale #${sale.id} has no cash entry to reverse`);
  insertCashEntry(conn, {
    book: sale.book, businessDate: sale.businessDate, type, amountCents: -original.amountCents,
    refTable: 'sales', refId: sale.id, reversesEntryId: original.id, note: `Void of sale #${sale.id}`,
  });
}
