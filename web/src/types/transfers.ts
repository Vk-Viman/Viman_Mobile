/**
 * Types of the Phase 9 API: cash transfers between books, cash drawings (and the goods drawings listed beside them) and capital.
 * Mirrors API_CONTRACTS.md "Wave 3 contracts - Phase 9". Money is always integer cents; the server calculates every total
 * and the screens only display them. The Phase 8 shapes (`CashBook`, `IceFund`, `CashWarning`, `CapitalEntry`) are reused.
 */
import type { PostedStatus } from './api';
import type { CapitalEntry, CashBook, CashWarning, IceFund } from './cashbooks';

// ---- Cash transfers ----

/** One transfer: money moved from one book to another. A fund is set exactly on the Ice Cream side(s). */
export interface Transfer {
  id: number; businessDate: string; postedAt: string; backdated: boolean; fromBook: CashBook; toBook: CashBook;
  fromFund: IceFund | null; toFund: IceFund | null; amountCents: number; note: string; status: PostedStatus;
  voidedAt: string | null; voidReason: string | null; clientRef: string;
}
export interface TransferCreate {
  businessDate: string; fromBook: CashBook; toBook: CashBook; fromFund?: IceFund; toFund?: IceFund; amountCents: number;
  note?: string; clientRef: string;
}
/** `book` matches either side of the transfer. */
export interface TransferQuery { from?: string; to?: string; book?: CashBook; status?: PostedStatus; limit?: number; offset?: number }
export interface TransferList { items: Transfer[]; total: number; totals: { amountCents: number } }
export interface TransferResult { item: Transfer; warnings: CashWarning[] }

// ---- Drawings (cash and goods) ----

/** A drawing of either kind. Cash: `book` (+ `fund` for Ice Cream) and no product. Goods: product and quantity, valued at cost. */
export interface OwnerDrawing {
  id: number; businessDate: string; postedAt: string; backdated: boolean; book: CashBook; fund: IceFund | null;
  kind: 'goods' | 'cash'; amountCents: number; productId: number | null; productName: string | null; qty: number | null;
  note: string; status: PostedStatus; voidedAt: string | null; voidReason: string | null; clientRef: string;
}
export interface OwnerDrawingQuery {
  kind?: 'goods' | 'cash'; from?: string; to?: string; book?: CashBook; status?: PostedStatus; limit?: number; offset?: number;
}
/** `totals` split the posted sum: goods = stock cost taken, cash = money taken out of a book. */
export interface OwnerDrawingList {
  items: OwnerDrawing[]; total: number; totalAmountCents: number; totals: { amountCents: number; goodsCents: number; cashCents: number };
}
export interface CashDrawingCreate {
  kind: 'cash'; businessDate: string; book: CashBook; fund?: IceFund; amountCents: number; note?: string; clientRef: string;
}
export interface CashDrawingResult { item: OwnerDrawing; warnings: CashWarning[] }
export interface CashDrawingVoided { item: OwnerDrawing }

// ---- Capital ----

/** `kind` defaults to every kind (capital and opening balances) on the server. */
export interface CapitalQuery {
  kind?: 'capital' | 'opening_balance' | 'all'; book?: CashBook; from?: string; to?: string; status?: PostedStatus; limit?: number; offset?: number;
}
export interface CapitalList { items: CapitalEntry[]; total: number; totals: { amountCents: number } }
export interface CapitalCreate { businessDate: string; book: CashBook; fund?: IceFund; amountCents: number; note?: string; clientRef: string }
export interface CapitalVoidResult { item: CapitalEntry; warnings: CashWarning[] }
