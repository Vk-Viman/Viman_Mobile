/**
 * services/printing.service.ts - print/photocopy service types, print sales and printing supplies (Phase 7).
 *
 * Layer: service (route -> SERVICE -> repository -> database). Business rules (BUSINESS_RULES sections 1, 2, 6, 12):
 *  - R12  a print sale SNAPSHOTS the service type's standard cost per page at the moment of sale. Revenue =
 *         qty x unit price; standard cost (COGS) = qty x unit cost; gross profit = revenue - cost. Later price or
 *         cost changes never touch old sales. The unit price may be changed for one sale (e.g. a custom job); the
 *         cost snapshot is always the type's current standard cost.
 *  - Sec 2 a print sale puts +revenue into the SHOP cash book (type `sale_service`); a paper/toner purchase takes
 *         -amount out of the SHOP book (type `printing_supplies`) with NO profit effect: it is compared with the
 *         standard cost only in the later variance report.
 *  - R13  warnings never block: price below standard cost (`PRICE_BELOW_COST`), cash-out that leaves the shop
 *         book negative (`NEGATIVE_CASH_BALANCE`).
 *  - R-FD no future dates. Sec 12: idempotent by `clientRef`; every write is audited with its business date and
 *         `backdated` flag; one database transaction holds the business row, its cash entry and its audit row.
 *  - R1   a void never edits or deletes: a reversing cash entry (`reverses_entry_id`) is added and the record is
 *         marked `void`. A zero-revenue print sale has no cash entry, so it has nothing to reverse.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { mulDivRound } from '../lib/money.ts';
import { cashBalance, findCashEntriesByRef, insertCashEntry } from '../repositories/cash-entries.repo.ts';
import {
  getPrintSale as getPrintSaleRow, getPrintSaleByClientRef, getServiceType as getServiceTypeRow, getServiceTypeByCode,
  getSupply as getSupplyRow, getSupplyByClientRef, insertPrintSale, insertServiceType, insertSupply,
  listPrintSales as listPrintSaleRows, listServiceTypes as listServiceTypeRows, listSupplies as listSupplyRows,
  markPrintSaleVoid, markSupplyVoid, updateServiceType as updateServiceTypeRow,
} from '../repositories/printing.repo.ts';
import type { PrintSaleRow, PrintStatus, ServiceTypeRow, SupplyRow } from '../repositories/printing.repo.ts';
import { logAudit } from './audit.service.ts';
import { runWrite } from './stock-common.ts';
import {
  NOTE_MAX_LENGTH, REASON_MAX_LENGTH, alreadyVoid, assertNoFieldErrors, checkBusinessDate, isBackdated,
  isBackdatedToday, notFound, trimmed, validationError,
} from './validation.ts';
import type { Fields } from './validation.ts';

/** Longest service type name / supply description. */
export const NAME_MAX_LENGTH = 100;
/** The code of a service type: capital letters, digits and underscore, 2-20 characters. */
const CODE_RE = /^[A-Z0-9_]{2,20}$/;

/** R13 warning codes returned (never blocking) by the create endpoints. */
export type PrintWarning = 'PRICE_BELOW_COST' | 'NEGATIVE_CASH_BALANCE';

// ---------------------------------------------------------------------------------------------
// pure math (unit-tested with hand-calculated values)
// ---------------------------------------------------------------------------------------------

/**
 * Revenue, standard cost and gross profit of a print sale (R12), in cents. Exact integer multiplication (routed
 * through `mulDivRound` so an absurd amount is refused instead of silently losing precision).
 *
 * @param qty            Pages / copies sold (whole number).
 * @param unitPriceCents Selling price per page.
 * @param unitCostCents  Standard cost per page (the snapshot).
 * @throws RangeError when an input is not a safe integer or a result is too large to be exact.
 */
export function printAmounts(qty: number, unitPriceCents: number, unitCostCents: number): {
  revenueCents: number; cogsCents: number; grossProfitCents: number;
} {
  const revenueCents = mulDivRound(qty, unitPriceCents, 1);
  const cogsCents = mulDivRound(qty, unitCostCents, 1);
  return { revenueCents, cogsCents, grossProfitCents: revenueCents - cogsCents };
}

// ---------------------------------------------------------------------------------------------
// service types
// ---------------------------------------------------------------------------------------------

/** A service type as returned by the API. */
export type ServiceType = ServiceTypeRow;

/** All service types in display order; `active` limits the list to active (true) or inactive (false) ones. */
export function listServiceTypes(ctx: AppContext, active?: boolean): { items: ServiceType[] } {
  return { items: listServiceTypeRows(ctx.database.conn, active) };
}

/**
 * Adds a service type (active). The code is permanent and unique.
 *
 * @throws AppError 400 VALIDATION_ERROR (code shape, empty name), 409 DUPLICATE_CODE.
 */
export function createServiceType(ctx: AppContext, body: { code: string; name: string; priceCents: number; costCents: number }): ServiceType {
  const fields: Fields = {};
  if (!CODE_RE.test(body.code)) fields.code = 'Use 2-20 capital letters, digits or underscores (for example POSTER_A3).';
  const name = trimmed(fields, 'name', 'Name', body.name, 1, NAME_MAX_LENGTH);
  assertNoFieldErrors(fields);

  return runWrite(ctx, (conn) => {
    if (getServiceTypeByCode(conn, body.code)) {
      throw new AppError(409, 'DUPLICATE_CODE', `The code ${body.code} is already used by another service type.`,
        { code: 'This code is already used.' });
    }
    const id = insertServiceType(conn, { code: body.code, name, priceCents: body.priceCents, costCents: body.costCents });
    const item = loadType(conn, id);
    logAudit(conn, 'print_service_type', String(id), 'create', null, item);
    return item;
  });
}

/**
 * Edits a service type's name, price, standard cost and active flag. Past sales keep the price and cost they were
 * sold with (R12 snapshot); the code never changes. Nothing is written (and nothing audited) when nothing changed.
 *
 * @throws AppError 400 VALIDATION_ERROR, 404 NOT_FOUND.
 */
export function updateServiceType(
  ctx: AppContext, id: number, body: { name: string; priceCents: number; costCents: number; active: boolean },
): ServiceType {
  const fields: Fields = {};
  const name = trimmed(fields, 'name', 'Name', body.name, 1, NAME_MAX_LENGTH);
  assertNoFieldErrors(fields);

  return runWrite(ctx, (conn) => {
    const before = getServiceTypeRow(conn, id);
    if (!before) throw notFound('Service type');
    if (before.name === name && before.priceCents === body.priceCents && before.costCents === body.costCents && before.active === body.active) {
      return before;
    }
    updateServiceTypeRow(conn, id, { name, priceCents: body.priceCents, costCents: body.costCents, active: body.active });
    const after = loadType(conn, id);
    logAudit(conn, 'print_service_type', String(id), 'update', before, after);
    return after;
  });
}

function loadType(conn: DatabaseSync, id: number): ServiceType {
  const t = getServiceTypeRow(conn, id);
  if (!t) throw notFound('Service type');
  return t;
}

// ---------------------------------------------------------------------------------------------
// print sales
// ---------------------------------------------------------------------------------------------

/** A print sale as returned by the API (adds `grossProfitCents` and the `backdated` flag). */
export interface PrintSale {
  id: number; businessDate: string; postedAt: string; backdated: boolean; serviceTypeId: number; serviceTypeCode: string;
  description: string; qty: number; unitPriceCents: number; unitCostCents: number; revenueCents: number; cogsCents: number;
  grossProfitCents: number; status: PrintStatus; voidedAt: string | null; voidReason: string | null; notes: string;
  clientRef: string;
}

function toPrintSale(r: PrintSaleRow): PrintSale {
  return {
    id: r.id, businessDate: r.businessDate, postedAt: r.postedAt, backdated: isBackdated(r.businessDate, r.postedAt),
    serviceTypeId: r.serviceTypeId, serviceTypeCode: r.serviceTypeCode, description: r.description, qty: r.qty,
    unitPriceCents: r.unitPriceCents, unitCostCents: r.unitCostCents, revenueCents: r.revenueCents, cogsCents: r.cogsCents,
    grossProfitCents: r.revenueCents - r.cogsCents, status: r.status, voidedAt: r.voidedAt, voidReason: r.voidReason,
    notes: r.notes, clientRef: r.clientRef,
  };
}

function loadPrintSale(conn: DatabaseSync, id: number): PrintSale {
  const r = getPrintSaleRow(conn, id);
  if (!r) throw notFound('Print sale');
  return toPrintSale(r);
}

/** One print sale by id. @throws AppError 404 NOT_FOUND. */
export function getPrintSale(ctx: AppContext, id: number): PrintSale {
  return loadPrintSale(ctx.database.conn, id);
}

/** Lists print sales, newest first; `totals` sum only POSTED sales that match the filters. */
export function listPrintSales(ctx: AppContext, q: {
  from?: string; to?: string; serviceTypeId?: number; status?: PrintStatus; limit: number; offset: number;
}): { items: PrintSale[]; total: number; totals: { revenueCents: number; cogsCents: number; grossProfitCents: number } } {
  const r = listPrintSaleRows(ctx.database.conn, q);
  return {
    items: r.items.map(toPrintSale), total: r.total,
    totals: { revenueCents: r.revenueCents, cogsCents: r.cogsCents, grossProfitCents: r.revenueCents - r.cogsCents },
  };
}

/** Request body of a print sale. */
export interface PrintSaleCreate {
  businessDate: string; serviceTypeId: number; qty: number; unitPriceCents?: number; notes?: string; clientRef: string;
}

/**
 * Records a print sale: snapshot cost, revenue = qty x price, +revenue in the shop cash book (`sale_service`).
 * Idempotent by `clientRef`: a repeat returns the saved sale with `created: false` and no warnings, even if the
 * type's price or active flag changed since.
 *
 * @throws AppError 400 VALIDATION_ERROR (unknown service type, notes) / FUTURE_DATE_NOT_ALLOWED (R-FD),
 *   409 SERVICE_TYPE_INACTIVE.
 */
export function createPrintSale(ctx: AppContext, body: PrintSaleCreate): { item: PrintSale; warnings: PrintWarning[]; created: boolean } {
  const fields: Fields = {};
  const notes = trimmed(fields, 'notes', 'Notes', body.notes, 0, NOTE_MAX_LENGTH);
  assertNoFieldErrors(fields);
  checkBusinessDate(body.businessDate); // schema -> real date -> R-FD

  return runWrite(ctx, (conn) => {
    const existing = getPrintSaleByClientRef(conn, body.clientRef);
    if (existing) return { item: toPrintSale(existing), warnings: [], created: false };

    const type = getServiceTypeRow(conn, body.serviceTypeId);
    if (!type) throw validationError({ serviceTypeId: 'Service type not found.' });
    if (!type.active) {
      throw new AppError(409, 'SERVICE_TYPE_INACTIVE', `${type.name} is switched off, so it cannot be sold. Turn it on in Service types first.`,
        { serviceTypeId: 'This service type is inactive.' });
    }

    const unitPriceCents = body.unitPriceCents ?? type.priceCents;
    const { revenueCents, cogsCents } = printAmounts(body.qty, unitPriceCents, type.costCents); // R12 snapshot cost
    const id = insertPrintSale(conn, {
      businessDate: body.businessDate, serviceTypeId: type.id, description: type.name, qty: body.qty, unitPriceCents,
      unitCostCents: type.costCents, revenueCents, cogsCents, notes, clientRef: body.clientRef,
    });
    // A free sale (price 0) moves no cash, so it has no cash entry (same as a zero-total POS sale).
    if (revenueCents > 0) {
      insertCashEntry(conn, {
        book: 'shop', businessDate: body.businessDate, type: 'sale_service', amountCents: revenueCents,
        refTable: 'print_sales', refId: id,
      });
    }
    const item = loadPrintSale(conn, id);
    logAudit(conn, 'print_sale', String(id), 'create', null, item, undefined,
      { businessDate: item.businessDate, backdated: item.backdated });
    // R13: advisory only.
    const warnings: PrintWarning[] = unitPriceCents < type.costCents ? ['PRICE_BELOW_COST'] : [];
    return { item, warnings, created: true };
  });
}

/**
 * Voids a print sale (R1): the cash-in is cancelled by a reversing entry that keeps the sale's business date,
 * and the sale is marked `void`. Nothing is edited or deleted.
 *
 * @throws AppError 400 VALIDATION_ERROR (reason), 404 NOT_FOUND, 409 ALREADY_VOID.
 */
export function voidPrintSale(ctx: AppContext, id: number, body: { reason: string }): PrintSale {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason, 1, REASON_MAX_LENGTH);
  assertNoFieldErrors(fields);

  return runWrite(ctx, (conn) => {
    const row = getPrintSaleRow(conn, id);
    if (!row) throw notFound('Print sale');
    if (row.status === 'void') throw alreadyVoid('print sale');
    const before = toPrintSale(row);

    if (row.revenueCents > 0) reverseCash(conn, 'print_sales', id, 'sale_service', row.businessDate, `Void of print sale #${id}`);
    markPrintSaleVoid(conn, id, reason);
    const after = loadPrintSale(conn, id);
    logAudit(conn, 'print_sale', String(id), 'void', before, after, reason,
      { businessDate: after.businessDate, backdated: isBackdatedToday(after.businessDate) });
    return after;
  });
}

/** Adds the negated twin of the record's original shop cash entry, pointing back at it (R1, C6). */
function reverseCash(conn: DatabaseSync, refTable: string, refId: number, type: string, businessDate: string, note: string): void {
  const original = findCashEntriesByRef(conn, refTable, refId).find((e) => e.type === type && e.reversesEntryId === null);
  if (!original) throw new Error(`${refTable} #${refId} has no cash entry to reverse`);
  insertCashEntry(conn, {
    book: 'shop', businessDate, type, amountCents: -original.amountCents, refTable, refId, reversesEntryId: original.id, note,
  });
}

// ---------------------------------------------------------------------------------------------
// printing supplies
// ---------------------------------------------------------------------------------------------

/** A paper/toner purchase as returned by the API. */
export interface PrintingSupply {
  id: number; businessDate: string; postedAt: string; backdated: boolean; amountCents: number; description: string;
  status: PrintStatus; voidedAt: string | null; voidReason: string | null; clientRef: string;
}

function toSupply(r: SupplyRow): PrintingSupply {
  return {
    id: r.id, businessDate: r.businessDate, postedAt: r.postedAt, backdated: isBackdated(r.businessDate, r.postedAt),
    amountCents: r.amountCents, description: r.description, status: r.status, voidedAt: r.voidedAt,
    voidReason: r.voidReason, clientRef: r.clientRef,
  };
}

function loadSupply(conn: DatabaseSync, id: number): PrintingSupply {
  const r = getSupplyRow(conn, id);
  if (!r) throw notFound('Printing supply');
  return toSupply(r);
}

/** One supplies purchase by id. @throws AppError 404 NOT_FOUND. */
export function getSupply(ctx: AppContext, id: number): PrintingSupply {
  return loadSupply(ctx.database.conn, id);
}

/** Lists supplies purchases, newest first; `totals.amountCents` sums only POSTED purchases that match the filters. */
export function listSupplies(ctx: AppContext, q: {
  from?: string; to?: string; status?: PrintStatus; limit: number; offset: number;
}): { items: PrintingSupply[]; total: number; totals: { amountCents: number } } {
  const r = listSupplyRows(ctx.database.conn, q);
  return { items: r.items.map(toSupply), total: r.total, totals: { amountCents: r.amountCents } };
}

/**
 * Records a paper/toner purchase: -amount from the shop cash book (`printing_supplies`), NO profit effect (R12).
 * Idempotent by `clientRef`. Warns (never blocks, R13) when the shop book goes negative.
 *
 * @throws AppError 400 VALIDATION_ERROR (description) / FUTURE_DATE_NOT_ALLOWED (R-FD).
 */
export function createSupply(
  ctx: AppContext, body: { businessDate: string; amountCents: number; description: string; clientRef: string },
): { item: PrintingSupply; warnings: PrintWarning[]; created: boolean } {
  const fields: Fields = {};
  const description = trimmed(fields, 'description', 'Description', body.description, 1, NAME_MAX_LENGTH);
  assertNoFieldErrors(fields);
  checkBusinessDate(body.businessDate);

  return runWrite(ctx, (conn) => {
    const existing = getSupplyByClientRef(conn, body.clientRef);
    if (existing) return { item: toSupply(existing), warnings: [], created: false };

    const id = insertSupply(conn, { businessDate: body.businessDate, amountCents: body.amountCents, description, clientRef: body.clientRef });
    insertCashEntry(conn, {
      book: 'shop', businessDate: body.businessDate, type: 'printing_supplies', amountCents: -body.amountCents,
      refTable: 'printing_supplies', refId: id,
    });
    const item = loadSupply(conn, id);
    logAudit(conn, 'printing_supply', String(id), 'create', null, item, undefined,
      { businessDate: item.businessDate, backdated: item.backdated });
    const warnings: PrintWarning[] = cashBalance(conn, 'shop') < 0 ? ['NEGATIVE_CASH_BALANCE'] : [];
    return { item, warnings, created: true };
  });
}

/**
 * Voids a supplies purchase (R1): the cash-out is cancelled by a reversing entry (the money is back in the shop
 * book) and the purchase is marked `void`.
 *
 * @throws AppError 400 VALIDATION_ERROR (reason), 404 NOT_FOUND, 409 ALREADY_VOID.
 */
export function voidSupply(ctx: AppContext, id: number, body: { reason: string }): PrintingSupply {
  const fields: Fields = {};
  const reason = trimmed(fields, 'reason', 'Reason', body.reason, 1, REASON_MAX_LENGTH);
  assertNoFieldErrors(fields);

  return runWrite(ctx, (conn) => {
    const row = getSupplyRow(conn, id);
    if (!row) throw notFound('Printing supply');
    if (row.status === 'void') throw alreadyVoid('supplies purchase');
    const before = toSupply(row);

    reverseCash(conn, 'printing_supplies', id, 'printing_supplies', row.businessDate, `Void of printing supplies #${id}`);
    markSupplyVoid(conn, id, reason);
    const after = loadSupply(conn, id);
    logAudit(conn, 'printing_supply', String(id), 'void', before, after, reason,
      { businessDate: after.businessDate, backdated: isBackdatedToday(after.businessDate) });
    return after;
  });
}
