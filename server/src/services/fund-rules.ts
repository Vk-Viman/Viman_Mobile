/**
 * services/fund-rules.ts - the "which Ice Cream fund?" rule shared by the Phase 9 money writes.
 *
 * Layer: service helper (no database access). BUSINESS_RULES 10.2: every Ice Cream money movement names exactly one
 * fund (Cost, Electricity or Profit) and the other books never have funds. A transfer has TWO sides, so the field
 * the message belongs to (`fund`, `fromFund`, `toFund`) is a parameter.
 */
import { AppError } from '../lib/errors.ts';
import type { CashBook, IceFund } from '../repositories/cash-entries.repo.ts';

/**
 * 10.2: the Ice Cream book REQUIRES a fund, the other books FORBID one.
 *
 * @param field Name of the request field the error is attached to (`fund`, `fromFund`, `toFund`).
 * @throws AppError 400 FUND_REQUIRED / FUND_NOT_ALLOWED with `fields[field]`.
 */
export function assertFundMatchesBook(book: CashBook, fund: IceFund | undefined, field: string = 'fund'): void {
  if (book === 'icecream' && fund === undefined) {
    throw new AppError(400, 'FUND_REQUIRED',
      'Choose which Ice Cream fund this money belongs to (Cost, Electricity or Profit).', { [field]: 'Choose a fund.' });
  }
  if (book !== 'icecream' && fund !== undefined) {
    throw new AppError(400, 'FUND_NOT_ALLOWED', 'Only the Ice Cream book has funds.', { [field]: 'Funds exist only for the Ice Cream book.' });
  }
}
