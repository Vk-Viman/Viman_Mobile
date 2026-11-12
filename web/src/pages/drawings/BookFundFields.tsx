/**
 * BookFundFields and small helpers shared by the three Drawings tabs (cash drawing, capital and transfer forms and lists).
 *
 * The Ice Cream book is divided into funds (Cost, Electricity, Profit; BUSINESS_RULES 10.2): every money movement in that book
 * must name one fund and the other books never have one. `BookFundFields` therefore shows the fund drop-down only when Ice Cream
 * is chosen. The server stays the authority (FUND_REQUIRED / FUND_NOT_ALLOWED); this only saves the owner a round trip.
 */
import { Badge } from '../../components/Badge';
import { SelectField } from '../../components/SelectField';
import type { CashBook, IceFund } from '../../types/cashbooks';
import { CASHBOOKS, CASHBOOK_LABEL, FUNDS, FUND_LABEL } from '../cashbooks/shared';

/** "Shop", "Telecom" or "Ice Cream - Cost" (a book with its fund). */
export function bookFundLabel(book: CashBook, fund: IceFund | null | undefined): string {
  return fund ? `${CASHBOOK_LABEL[book]} - ${FUND_LABEL[fund]}` : CASHBOOK_LABEL[book];
}

/** A pill with the book (and fund) name; Shop is green, the others grey, like the book badges elsewhere. */
export function CashBookBadge({ book, fund }: { book: CashBook; fund?: IceFund | null }) {
  return <Badge tone={book === 'shop' ? 'brand' : 'neutral'}>{bookFundLabel(book, fund)}</Badge>;
}

interface Props {
  /** Visible label of the book drop-down, e.g. "Book", "From book", "To book". */
  bookLabel: string;
  book: CashBook;
  fund: IceFund;
  onBook: (b: CashBook) => void;
  onFund: (f: IceFund) => void;
  /** Server messages for the two fields (e.g. `fieldError(err, 'fromFund')`). */
  bookError?: string | undefined;
  fundError?: string | undefined;
  /** Books that may not be chosen (a transfer cannot start and end in the same book); shown disabled. */
  disabledBook?: CashBook;
  /** Label of the fund drop-down (default "Fund"). */
  fundLabel?: string;
}

/** Book drop-down plus, for Ice Cream only, the fund drop-down. */
export function BookFundFields({ bookLabel, book, fund, onBook, onFund, bookError, fundError, disabledBook, fundLabel = 'Fund' }: Props) {
  return (
    <>
      <SelectField label={bookLabel} value={book} onChange={(e) => onBook(e.target.value as CashBook)} error={bookError}>
        {CASHBOOKS.map((b) => <option key={b} value={b} disabled={b === disabledBook}>{CASHBOOK_LABEL[b]}</option>)}
      </SelectField>
      {book === 'icecream' && (
        <SelectField label={fundLabel} value={fund} onChange={(e) => onFund(e.target.value as IceFund)} error={fundError}
          hint="Ice Cream money is kept in three funds. Choose the one this money belongs to.">
          {FUNDS.map((f) => <option key={f} value={f}>{FUND_LABEL[f]}</option>)}
        </SelectField>
      )}
    </>
  );
}

/** "All / Shop / Telecom / Ice Cream" drop-down for the list filters (the shared `BookFilterSelect` has no Ice Cream). */
export function CashBookFilterSelect({ value, onChange }: { value: '' | CashBook; onChange: (v: '' | CashBook) => void }) {
  return (
    <SelectField label="Book" value={value} onChange={(e) => onChange(e.target.value as '' | CashBook)}>
      <option value="">All</option>
      {CASHBOOKS.map((b) => <option key={b} value={b}>{CASHBOOK_LABEL[b]}</option>)}
    </SelectField>
  );
}

/** The fund to send for a book: the chosen fund for Ice Cream, nothing for the other books. */
export function fundFor(book: CashBook, fund: IceFund): { fund?: IceFund } {
  return book === 'icecream' ? { fund } : {};
}
