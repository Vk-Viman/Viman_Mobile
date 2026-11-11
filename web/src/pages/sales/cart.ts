/**
 * Cart model and pure helpers for the POS (pages/sales/PosTab.tsx and its parts).
 *
 * Business rules shaping this file:
 *  - Money is INTEGER cents. The only arithmetic here is integer sums and qty x price products; the server
 *    recomputes everything and stays authoritative (BUSINESS_RULES §0, §4).
 *  - Qty and price are held as typed TEXT while editing (so "12." or "" are possible mid-edit) and parsed with the
 *    strict converters at the moment they are needed.
 *  - Minimum-price and stock-on-hand checks are WARNINGS only (R13): they never block saving.
 */
import { parseIntStrict } from '../purchases/helpers';
import { centsToRupees, rupeesToCents } from '../../lib/units';
import type { Book, Product } from '../../types/api';

/** Largest quantity the server accepts per line (API_CONTRACTS Phase 5). */
export const MAX_LINE_QTY = 1_000_000;
/** Largest unit price in cents the server accepts. */
export const MAX_UNIT_PRICE_CENTS = 999_999_999;
/** Maximum number of lines in one sale. */
export const MAX_CART_LINES = 100;

/** One cart line: a snapshot of the product facts the cashier needs, plus the editable qty and price text. */
export interface CartLine {
  productId: number;
  name: string;
  code: string | null;
  book: Book;
  /** Stock on hand when the product was added (hint only; the server checks the live pool). */
  onHand: number;
  /** Product's minimum price in cents (0 = none); below it we warn, never block. */
  minPriceCents: number;
  /** Typed quantity text. */
  qty: string;
  /** Typed unit price in rupees, prefilled from the product's selling price. */
  price: string;
}

/** Builds a new cart line (1 unit at the product's selling price) from a catalogue product. */
export function lineFromProduct(p: Product): CartLine {
  return {
    productId: p.id,
    name: p.name,
    code: p.code,
    book: p.book,
    onHand: p.qtyOnHand,
    minPriceCents: p.minPriceCents,
    qty: '1',
    price: centsToRupees(p.sellPriceCents),
  };
}

/** Quantity of a line as an integer within the server's limits, or null when invalid. */
export function lineQty(l: CartLine): number | null {
  const n = parseIntStrict(l.qty);
  return n !== null && n >= 1 && n <= MAX_LINE_QTY ? n : null;
}

/** Unit price of a line in cents within the server's limits, or null when invalid. */
export function linePriceCents(l: CartLine): number | null {
  const c = rupeesToCents(l.price);
  return c !== null && c <= MAX_UNIT_PRICE_CENTS ? c : null;
}

/** Line total = qty x unit price (exact integers), or null while either input is invalid. */
export function lineTotalCents(l: CartLine): number | null {
  const q = lineQty(l);
  const p = linePriceCents(l);
  return q === null || p === null ? null : q * p;
}

/** True when every line has a valid quantity and price (and there is at least one line). */
export function cartIsValid(lines: CartLine[]): boolean {
  return lines.length > 0 && lines.length <= MAX_CART_LINES && lines.every((l) => lineTotalCents(l) !== null);
}

/** Integer sum of the valid line totals of one book (invalid lines count as 0 until fixed). */
export function bookSubtotalCents(lines: CartLine[], book: Book): number {
  return lines.filter((l) => l.book === book).reduce((sum, l) => sum + (lineTotalCents(l) ?? 0), 0);
}
