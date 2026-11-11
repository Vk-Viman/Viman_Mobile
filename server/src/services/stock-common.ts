/**
 * services/stock-common.ts - helpers shared by the Phase 4 write services (stocktakes, stock losses, goods
 * drawings).
 *
 * Layer: service. The generic checks (`validationError`, `notFound`, `checkBusinessDate`, `isBackdated`,
 * `trimmed`) are defined once in `validation.ts` and re-exported here so these services keep one import.
 * What is specific to this file is `runWrite`: one transaction plus the translation of database trigger
 * aborts into API errors for the stock-related tables (migration 004/005 triggers).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { futureDateError, validationError } from './validation.ts';

export {
  checkBusinessDate, futureDateError, isBackdated, notFound, trimmed, validationError,
} from './validation.ts';
export type { Fields } from './validation.ts';

/**
 * Safety net: maps database trigger / constraint aborts and arithmetic overflow to the contract's envelopes.
 * The services check every rule first, so these only fire when a check was missed (or lost a race); the
 * database remains the final guard and the user still gets a clean message instead of a 500.
 */
function mapDbAbort(err: unknown): never {
  const msg = err instanceof Error ? err.message : '';
  if (msg.includes('FUTURE_DATE_NOT_ALLOWED')) throw futureDateError(); // R-FD trigger
  if (msg.includes('PRODUCT_NOT_IN_BOOK')) {
    throw new AppError(400, 'PRODUCT_NOT_IN_BOOK', 'A product does not belong to this stocktake\'s book.');
  }
  if (msg.includes('STOCKTAKE_NOT_DRAFT') || msg.includes('STOCKTAKE_TRANSITION')) {
    throw new AppError(409, 'NOT_DRAFT', 'Only a draft stocktake can be changed or completed.');
  }
  // A stock movement that would make quantity or value negative (or leave value in an empty pool).
  if (msg.includes('STOCK_VALUE_WITHOUT_QTY') || /CHECK constraint failed: .*(qty_on_hand|stock_value_cents)/.test(msg)) {
    throw new AppError(422, 'INSUFFICIENT_STOCK', 'Not enough stock for this operation.');
  }
  // mulDivRound / assertInt throw RangeError for absurdly large amounts.
  if (err instanceof RangeError) throw validationError({ body: 'An amount or quantity is too large.' });
  throw err;
}

/**
 * Runs `fn` in ONE database transaction (all-or-nothing). `AppError`s thrown by the service pass through
 * untouched (and roll the transaction back); raw database aborts are translated by `mapDbAbort`.
 */
export function runWrite<T>(ctx: AppContext, fn: (conn: DatabaseSync) => T): T {
  try {
    return ctx.database.tx(fn);
  } catch (err) {
    if (err instanceof AppError) throw err;
    return mapDbAbort(err);
  }
}
