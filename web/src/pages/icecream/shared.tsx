/**
 * Labels, small pure helpers and tiny shared components of the Ice Cream screens (pages/icecream/*).
 * Display and input convenience only: the server calculates every figure and enforces every rule (BUSINESS_RULES section 10).
 */
import { SelectField } from '../../components/SelectField';
import { FUNDS, FUND_LABEL } from '../cashbooks/shared';
import type { IceFund } from '../../types/cashbooks';
import type { FundEntryKind, IceWarning, MoveKind, PaymentKind } from '../../types/icecream';

export { FUNDS, FUND_LABEL };

/** The toast API this needs (kept tiny so the helpers need no React). */
interface WarningToast { warning: (message: string) => void }

/** One amber toast per warning (negative cash / fund balance R13, 10.2, and the excess-cost warning D3), in the server's own words. */
export function notifyIceWarnings(toast: WarningToast, warnings: IceWarning[] | undefined): void {
  for (const w of warnings ?? []) toast.warning(w.message);
}

/** Owner-facing names of the payment kinds. */
export const PAYMENT_KIND_LABEL: Record<PaymentKind, string> = {
  materials: 'Materials', electricity_bill: 'Electricity bill', other_cost: 'Other cost',
};
/** The payment kinds in display order. */
export const PAYMENT_KINDS: readonly PaymentKind[] = ['materials', 'electricity_bill', 'other_cost'];

/** The fund each kind is normally paid from (BUSINESS_RULES 10.2). A preset only: the owner chooses the fund every time. */
export const PRESET_FUND: Record<PaymentKind, IceFund> = { materials: 'cost', electricity_bill: 'electricity', other_cost: 'cost' };

/** What a fund move is, in words. */
export const MOVE_KIND_LABEL: Record<MoveKind, string> = {
  release: 'Release to Profit', reallocation: 'Charged back from Profit', relabel: 'Cost / Electricity re-label',
};

/** Plain-English label of a fund ledger row kind. */
export const FUND_ENTRY_LABEL: Record<FundEntryKind, string> = {
  daily_allocation: 'Daily entry', payment: 'Payment', fund_move: 'Fund move', drawing: 'Cash drawing', transfer_out: 'Transfer out',
  transfer_in: 'Transfer in', opening_balance: 'Opening balance', capital: 'Capital', cash_over_short: 'Cash over / short', reversal: 'Reversal (void)',
};

/**
 * The profit share the entry form previews while the owner types: sales - cost - electricity (10.2). The server computes the real
 * figure and refuses an unconfirmed negative one; this only lets the owner see it before saving.
 */
export function profitSharePreview(salesCents: number, costCents: number, electricityCents: number): number {
  return salesCents - costCents - electricityCents;
}

/** Fund drop-down shared by the payment and move forms. */
export function FundSelect({ label, value, onChange, error, exclude }: {
  label: string; value: IceFund; onChange: (f: IceFund) => void; error?: string; exclude?: IceFund;
}) {
  return (
    <SelectField label={label} value={value} onChange={(e) => onChange(e.target.value as IceFund)} error={error}>
      {FUNDS.filter((f) => f !== exclude).map((f) => <option key={f} value={f}>{FUND_LABEL[f]} fund</option>)}
    </SelectField>
  );
}

/** The sentence the owner approved for the electricity rule (E1-E4), shown where payments are recorded. */
export const ELECTRICITY_NOTE = 'The whole shop\'s electricity bill is paid from the Ice Cream book. Record it here as an "Electricity bill"; it settles the electricity already charged in the daily entries and is never counted as an expense.';
