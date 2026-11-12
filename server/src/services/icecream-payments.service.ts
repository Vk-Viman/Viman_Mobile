/**
 * services/icecream-payments.service.ts - Ice Cream payments: materials, the shop's electricity bill, other costs (Phase 10).
 *
 * Layer: service (route -> SERVICE -> repository -> database). Business rules (BUSINESS_RULES sections 2, 7, 10, 12):
 *  - 10.2  every payment is cash OUT of the Ice Cream book and names exactly ONE fund, chosen by the owner each time (the
 *          defaults Cost for materials, Electricity for the bill are only UI presets). A fund may go negative: warning, never
 *          a block (R13).
 *  - E1/E4 the WHOLE shop's electricity bill is paid here as kind `electricity_bill` (cash type
 *          `icecream_electricity_payment`) and is a SETTLEMENT, never an expense in any segment. The category of a payment
 *          can never be "electricity" (any case/spacing): `400 ELECTRICITY_NOT_ALLOWED`; migration 014 repeats it as a CHECK.
 *  - 10.3  the P&L treatment is DERIVED, never chosen: an expense only for `other_cost` paid from the Profit fund (recognized
 *          profit - amount); every other payment is a settlement of allocations already charged (profit unchanged).
 *  - 10.4  `materials` settles the Materials line, `electricity_bill` the Electricity line, `other_cost` from the Cost fund
 *          Materials, from the Electricity fund Electricity (it lowers that line's Unspent; never a separate expense).
 *  - R9/R-FD/R1/section 12  closed days refuse create and void; no future dates; a void is a reversal (cash + fund row);
 *          idempotent by `clientRef`; audited with business date and `backdated`; one transaction.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import type { IceFund } from '../repositories/cash-entries.repo.ts';
import {
  getPayment, getPaymentByClientRef, insertPayment, listPayments as listPaymentRows, markPaymentVoid,
} from '../repositories/icecream.repo.ts';
import type { IceStatus, PaymentRow } from '../repositories/icecream.repo.ts';
import { logAudit } from './audit.service.ts';
import { postCash } from './cash-posting.ts';
import { assertDayOpen } from './day-closing.ts';
import { reverseRefCash } from './icecream-days.service.ts';
import { pnlTreatment } from './icecream-rules.ts';
import type { PaymentKind } from './icecream-rules.ts';
import { DESCRIPTION_MAX_LENGTH, writeExtras } from './icecream.service.ts';
import type { FundsSummary, IceWarning } from './icecream.service.ts';
import { runWrite } from './stock-common.ts';
import {
  REASON_MAX_LENGTH, alreadyVoid, assertNoFieldErrors, checkBusinessDate, isBackdated, isBackdatedToday, notFound, trimmed,
} from './validation.ts';
import type { Fields } from './validation.ts';

/** Longest payment category. */
export const CATEGORY_MAX_LENGTH = 60;

/** The exact owner-approved wording of the electricity refusal (E2/E4), shared with expenses. */
export const ICE_ELECTRICITY_MESSAGE = 'Electricity is paid from the Ice Cream book - record the bill as an "Electricity bill" payment, not as a category.';

/** Cash-entry type of each payment kind (DATABASE_SCHEMA Phase 10). */
export const PAYMENT_CASH_TYPE: Record<PaymentKind, string> = {
  materials: 'icecream_materials_payment', electricity_bill: 'icecream_electricity_payment', other_cost: 'icecream_other_cost',
};

/** A payment as returned by the API (adds `backdated` and the derived `pnlTreatment`). */
export interface IcePayment {
  id: number; businessDate: string; postedAt: string; backdated: boolean; kind: PaymentKind; fund: IceFund; amountCents: number;
  category: string | null; description: string; pnlTreatment: 'settlement' | 'expense'; status: IceStatus; voidedAt: string | null;
  voidReason: string | null; clientRef: string;
}

function toPayment(r: PaymentRow): IcePayment {
  return {
    id: r.id, businessDate: r.businessDate, postedAt: r.postedAt, backdated: isBackdated(r.businessDate, r.postedAt), kind: r.kind,
    fund: r.fund, amountCents: r.amountCents, category: r.category, description: r.description,
    pnlTreatment: pnlTreatment(r.kind, r.fund), status: r.status, voidedAt: r.voidedAt, voidReason: r.voidReason, clientRef: r.clientRef,
  };
}

function loadPayment(conn: DatabaseSync, id: number): IcePayment {
  const r = getPayment(conn, id);
  if (!r) throw notFound('Payment');
  return toPayment(r);
}

/** Request body of a payment. `fund` is required in the API (the UI presets are not defaults of the server). */
export interface IcePaymentCreate {
  businessDate: string; kind: PaymentKind; fund: IceFund; amountCents: number; category?: string; description: string; clientRef: string;
}

/** Result of a payment write. */
export interface PaymentWrite { payment: IcePayment; funds: FundsSummary; warnings: IceWarning[]; created: boolean }

/**
 * E4: refuses a category that says "electricity" in any case or spacing. Runs as request validation (before R-FD),
 * like the expense rule of Phase 8.
 *
 * @throws AppError 400 ELECTRICITY_NOT_ALLOWED (`fields.category`).
 */
export function assertCategoryAllowed(category: string | undefined): void {
  if (category !== undefined && category.trim().toLowerCase() === 'electricity') {
    throw new AppError(400, 'ELECTRICITY_NOT_ALLOWED', ICE_ELECTRICITY_MESSAGE, { category: ICE_ELECTRICITY_MESSAGE });
  }
}

/**
 * Records a payment: cash OUT of the chosen fund (`icecream_materials_payment` / `icecream_electricity_payment` /
 * `icecream_other_cost`) with its fund row (kind `payment`), audited, in one transaction. Idempotent by `clientRef`.
 *
 * Validation order: schema -> category (E4) -> fields -> R-FD -> clientRef repeat -> DAY_CLOSED (R9).
 *
 * @throws AppError 400 VALIDATION_ERROR / ELECTRICITY_NOT_ALLOWED / FUTURE_DATE_NOT_ALLOWED, 409 DAY_CLOSED.
 */
export function createPayment(ctx: AppContext, body: IcePaymentCreate): PaymentWrite {
  assertCategoryAllowed(body.category);
  const fields: Fields = {};
  const description = trimmed(fields, 'description', 'Description', body.description, 1, DESCRIPTION_MAX_LENGTH);
  const category = trimmed(fields, 'category', 'Category', body.category, 0, CATEGORY_MAX_LENGTH);
  assertNoFieldErrors(fields);
  checkBusinessDate(body.businessDate);

  return runWrite(ctx, (conn) => {
    const existing = getPaymentByClientRef(conn, body.clientRef);
    if (existing) return { payment: toPayment(existing), ...writeExtras(conn, false), created: false };

    assertDayOpen(conn, ['icecream'], body.businessDate); // R9
    const id = insertPayment(conn, {
      businessDate: body.businessDate, kind: body.kind, fund: body.fund, amountCents: body.amountCents,
      category: category === '' ? null : category, description, clientRef: body.clientRef,
    });
    postCash(conn, {
      book: 'icecream', fund: body.fund, businessDate: body.businessDate, type: PAYMENT_CASH_TYPE[body.kind],
      amountCents: -body.amountCents, refTable: 'icecream_payments', refId: id, fundKind: 'payment', note: description,
    });
    const payment = loadPayment(conn, id);
    logAudit(conn, 'icecream_payment', String(id), 'create', null, payment, undefined,
      { businessDate: payment.businessDate, backdated: payment.backdated });
    return { payment, ...writeExtras(conn, true), created: true }; // R13: warn, never block
  });
}

/**
 * Voids a payment (R1): its cash-out and fund row are reversed (same business date) and it is marked `void`. A void only
 * loosens the 10.4 limits (Settled falls), so it is never blocked by the release guard.
 *
 * @throws AppError 400 VALIDATION_ERROR (reason), 404 NOT_FOUND, 409 DAY_CLOSED / ALREADY_VOID.
 */
export function voidPayment(ctx: AppContext, id: number, body: { reason: string }): { payment: IcePayment; funds: FundsSummary; warnings: IceWarning[] } {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason, 1, REASON_MAX_LENGTH);
  assertNoFieldErrors(fields);

  return runWrite(ctx, (conn) => {
    const row = getPayment(conn, id);
    if (!row) throw notFound('Payment');
    assertDayOpen(conn, ['icecream'], row.businessDate); // R9: judged on the payment's own date
    if (row.status === 'void') throw alreadyVoid('payment');
    const before = toPayment(row);
    reverseRefCash(conn, 'icecream_payments', id, `Void of Ice Cream payment #${id}`);
    markPaymentVoid(conn, id, reason);
    const payment = loadPayment(conn, id);
    logAudit(conn, 'icecream_payment', String(id), 'void', before, payment, reason,
      { businessDate: payment.businessDate, backdated: isBackdatedToday(payment.businessDate) });
    return { payment, ...writeExtras(conn, true) };
  });
}

/** Lists payments newest first; `totals.amountCents` sums only POSTED payments that match the filters. */
export function listIcePayments(ctx: AppContext, q: {
  from?: string; to?: string; kind?: PaymentKind; fund?: IceFund; status?: IceStatus; limit: number; offset: number;
}): { items: IcePayment[]; total: number; totals: { amountCents: number } } {
  const r = listPaymentRows(ctx.database.conn, q);
  return { items: r.items.map(toPayment), total: r.total, totals: { amountCents: r.amountCents } };
}
