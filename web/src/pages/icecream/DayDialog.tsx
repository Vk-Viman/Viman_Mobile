/**
 * DayDialog: the Ice Cream daily entry form - a NEW entry or the REPLACEMENT of a saved one (void-and-replace).
 * API: POST /icecream/days, PUT /icecream/days/:date (api/icecream.ts).
 *
 * Rules reflected here (the server is authoritative, BUSINESS_RULES 10.2, 10.3, C9, D2, R9, R-FD):
 *  - the owner enters the day's sales S, the cost allocation C and the electricity allocation E; the PROFIT SHARE S - C - E is
 *    shown live while typing and calculated again by the server (the client never sends it);
 *  - a NEGATIVE profit share is only saved after an explicit confirmation (`confirmNegativeProfit`, 10.3);
 *  - optional item lines (what was sold) - when used they define the sales total, so they always add up (ITEMS_TOTAL_MISMATCH);
 *  - a replacement keeps the date of the entry it replaces, voids the old entry and writes the new one in one step; the server
 *    refuses it (VOID_BREAKS_RELEASE) when profit already released depends on the old allocations (D2);
 *  - a closed day (R9) and a second entry for the same date (DAY_EXISTS) are refused with the server's own message;
 *  - the date picker stops at today (R-FD); backdating is allowed and audited; `clientRef` per opening (duplicate-submission guard).
 * Mount only while open so each opening has a fresh form and a fresh clientRef.
 */
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/Button';
import { FormDialog } from '../../components/FormDialog';
import { Money } from '../../components/Money';
import { MoneyInput } from '../../components/MoneyInput';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useCreateDay, useReplaceDay } from '../../api/icecream';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { useClientRef } from '../../hooks/useClientRef';
import { MAX_CENTS, MAX_NOTE, parseMoney } from '../../lib/amounts';
import { errorBanner, fieldError } from '../../lib/errors';
import { centsToRupees } from '../../lib/units';
import { CHECKBOX_CLASS } from '../../lib/constants';
import type { DayItemInput, IceDay } from '../../types/icecream';
import { notifyIceWarnings, profitSharePreview } from './shared';

/** One item row while typing (text, so the owner can type freely). */
interface ItemRow { name: string; qty: string; price: string }

const MAX_ITEM_NAME = 100;
const blankRow = (): ItemRow => ({ name: '', qty: '1', price: '' });

/** Whole number of units >= 1 (up to 1,000,000), or null. */
function parseQty(text: string): number | null {
  return /^\d{1,7}$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= 1_000_000 ? Number(text) : null;
}

/**
 * The daily entry form. Pass `replacing` to edit a saved entry (its date is fixed); omit it for a new entry.
 */
export function DayDialog({ replacing, onClose }: { replacing?: IceDay; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateDay();
  const replace = useReplaceDay();
  const clientRef = useClientRef();
  const { today, date, setDate } = useBusinessDate();
  const [sales, setSales] = useState(replacing ? centsToRupees(replacing.salesCents) : '');
  const [cost, setCost] = useState(replacing ? centsToRupees(replacing.costAllocCents) : '');
  const [elec, setElec] = useState(replacing ? centsToRupees(replacing.electricityAllocCents) : '');
  const [rows, setRows] = useState<ItemRow[]>(
    replacing ? replacing.items.map((i) => ({ name: i.itemName, qty: String(i.qty), price: centsToRupees(i.unitPriceCents) })) : [],
  );
  const [notes, setNotes] = useState(replacing?.notes ?? '');
  const [reason, setReason] = useState('');
  const [confirmNegative, setConfirmNegative] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  const mutation = replacing ? replace : create;
  const useItems = rows.length > 0;

  // Item lines, parsed. When items are used their total IS the sales total.
  const parsedItems = rows.map((r) => ({ name: r.name.trim(), qty: parseQty(r.qty), price: parseMoney(r.price, 0) }));
  const itemsOk = parsedItems.every((i) => i.name.length >= 1 && i.name.length <= MAX_ITEM_NAME && i.qty !== null && i.price !== null);
  const itemsTotal = parsedItems.reduce((t, i) => t + (i.qty ?? 0) * (i.price ?? 0), 0);

  const salesCents = useItems ? (itemsOk && itemsTotal <= MAX_CENTS ? itemsTotal : null) : parseMoney(sales, 0);
  const costCents = parseMoney(cost, 0);
  const elecCents = parseMoney(elec, 0);
  const allParsed = salesCents !== null && costCents !== null && elecCents !== null;
  const profitCents = allParsed ? profitSharePreview(salesCents, costCents, elecCents) : null;
  const negative = profitCents !== null && profitCents < 0;
  const dateValue = replacing ? replacing.businessDate : date;
  const canSubmit = Boolean(dateValue) && allParsed && (!useItems || itemsOk) && (!negative || confirmNegative) && notes.length <= MAX_NOTE && !mutation.isPending;

  const submit = () => {
    if (!canSubmit || salesCents === null || costCents === null || elecCents === null) { setShowErrors(true); return; }
    const items: DayItemInput[] | undefined = useItems
      ? parsedItems.map((i) => ({ itemName: i.name, qty: i.qty as number, unitPriceCents: i.price as number }))
      : undefined;
    const body = {
      salesCents, costAllocCents: costCents, electricityAllocCents: elecCents, items, notes: notes.trim() || undefined,
      confirmNegativeProfit: negative ? true : undefined, clientRef,
    };
    const done = (r: { warnings: Parameters<typeof notifyIceWarnings>[1] }) => {
      toast.success(replacing ? 'Daily entry replaced.' : 'Daily entry saved.');
      notifyIceWarnings(toast, r.warnings);
      onClose();
    };
    if (replacing) replace.mutate({ date: replacing.businessDate, body: { ...body, reason: reason.trim() || undefined } }, { onSuccess: done });
    else create.mutate({ ...body, businessDate: date }, { onSuccess: done });
  };

  const setRow = (i: number, patch: Partial<ItemRow>) => setRows((l) => l.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const err = mutation.error;
  const bad = (v: number | null) => (showErrors && v === null ? 'Enter an amount (0 or more), such as 2500 or 2500.50.' : undefined);

  return (
    <FormDialog title={replacing ? `Replace the daily entry of ${replacing.businessDate}` : 'Add daily entry'} submitLabel={replacing ? 'Replace entry' : 'Save entry'}
      canSubmit={canSubmit} loading={mutation.isPending} widthClass="max-w-2xl"
      error={errorBanner(err, ['businessDate', 'salesCents', 'costAllocCents', 'electricityAllocCents', 'notes', 'reason', 'confirmNegativeProfit'])}
      onSubmit={submit} onClose={onClose}>
      <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
        Enter the day&apos;s sales and how much of it is set aside for materials (Cost) and for electricity. The rest is the day&apos;s profit share.
        {replacing && ' Saving cancels the old entry and records this one in its place; the old one stays in the history as void.'}
      </p>
      {replacing ? (
        <TextField label="Date" type="date" value={replacing.businessDate} disabled readOnly />
      ) : (
        <TextField label="Date" type="date" value={date} max={today || undefined} onChange={(e) => setDate(e.target.value)} error={fieldError(err, 'businessDate')} />
      )}

      {useItems ? (
        <div>
          <p className="mb-1 text-sm font-medium text-slate-700">What was sold</p>
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_5rem_7rem_auto] items-end gap-2">
                <TextField label={`Item ${i + 1}`} hideLabel placeholder="Item, e.g. Cone" value={r.name} maxLength={MAX_ITEM_NAME} onChange={(e) => setRow(i, { name: e.target.value })}
                  error={fieldError(err, `items.${i}.itemName`) ?? (showErrors && parsedItems[i]!.name === '' ? 'Name the item.' : undefined)} />
                <TextField label={`Quantity ${i + 1}`} hideLabel inputMode="numeric" placeholder="Qty" value={r.qty} onChange={(e) => setRow(i, { qty: e.target.value })}
                  error={fieldError(err, `items.${i}.qty`) ?? (showErrors && parsedItems[i]!.qty === null ? 'Whole number.' : undefined)} />
                <MoneyInput label={`Price each ${i + 1}`} hideLabel value={r.price} onChange={(v) => setRow(i, { price: v })}
                  error={fieldError(err, `items.${i}.unitPriceCents`) ?? (showErrors && parsedItems[i]!.price === null ? 'Price.' : undefined)} />
                <Button variant="ghost" aria-label={`Remove item ${i + 1}`} onClick={() => setRows((l) => l.filter((_, j) => j !== i))}><Trash2 size={16} aria-hidden="true" /></Button>
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <Button variant="secondary" onClick={() => setRows((l) => [...l, blankRow()])}><Plus size={16} aria-hidden="true" /> Add item</Button>
            <p className="text-sm text-slate-700">Sales total from the items: <Money cents={itemsOk ? itemsTotal : 0} className="font-semibold" /></p>
          </div>
        </div>
      ) : (
        <>
          <MoneyInput label="Total sales (Rs.)" value={sales} onChange={setSales} error={fieldError(err, 'salesCents') ?? bad(salesCents)} />
          <Button variant="secondary" onClick={() => setRows([blankRow()])}><Plus size={16} aria-hidden="true" /> List the items sold (optional)</Button>
        </>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <MoneyInput label="Set aside for materials - Cost (Rs.)" value={cost} onChange={setCost} error={fieldError(err, 'costAllocCents') ?? bad(costCents)} />
        <MoneyInput label="Set aside for electricity (Rs.)" value={elec} onChange={setElec} error={fieldError(err, 'electricityAllocCents') ?? bad(elecCents)} />
      </div>

      <div className={`rounded-lg border p-3 text-sm ${negative ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-slate-50'}`} aria-live="polite">
        <p className="text-slate-700">
          Profit share of the day (sales - cost - electricity):{' '}
          {profitCents === null ? <span className="text-slate-500">enter the amounts above</span> : <Money cents={profitCents} className="text-base font-semibold" />}
        </p>
        {negative && (
          <label className="mt-2 flex items-start gap-2 text-red-800">
            <input type="checkbox" className={`${CHECKBOX_CLASS} mt-0.5`} checked={confirmNegative} onChange={(e) => setConfirmNegative(e.target.checked)} />
            <span>The amounts set aside are more than the sales, so this day&apos;s profit is negative. I confirm that this is correct.</span>
          </label>
        )}
        {fieldError(err, 'confirmNegativeProfit') && <p className="mt-1 text-red-700">{fieldError(err, 'confirmNegativeProfit')}</p>}
      </div>

      <TextField label="Notes (optional)" value={notes} maxLength={MAX_NOTE} onChange={(e) => setNotes(e.target.value)} autoComplete="off" error={fieldError(err, 'notes')} />
      {replacing && <TextField label="Why is it replaced? (optional)" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} autoComplete="off" error={fieldError(err, 'reason')} />}
    </FormDialog>
  );
}
