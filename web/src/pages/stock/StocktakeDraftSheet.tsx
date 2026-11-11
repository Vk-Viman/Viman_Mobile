/**
 * StocktakeDraftSheet: the editable count sheet for a stocktake that is still a DRAFT
 * (route "/stock/stocktake/:id" while status = draft; chosen by StocktakeSheet).
 *
 * The owner types the quantity counted per product; the screen shows the difference from the system quantity.
 * Buttons: Save draft, Complete stocktake (posts the differences as stock gains/losses at average cost), Cancel.
 * API: GET /products (rows), PUT /stocktakes/:id (save), POST /stocktakes/:id/complete, POST /stocktakes/:id/void
 * (api/stock.ts).
 *
 * Why the server stays authoritative: the differences shown here are only a preview (system quantity is live and
 * may change while counting). On completion the server recomputes expected quantities and values at that moment.
 * Rule C10: a counted surplus of a product with no average cost needs a unit cost typed by the owner
 * (error UNIT_COST_REQUIRED if missing).
 */
import { useMemo, useState } from 'react';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { Spinner } from '../../components/Spinner';
import { TextField, inputClass } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { VoidRecordDialog } from '../../components/VoidRecordDialog';
import { ApiError } from '../../api/client';
import { useProducts } from '../../api/catalog';
import { useCompleteStocktake, useUpdateStocktake, useVoidStocktake } from '../../api/stock';
import { errorBanner } from '../../lib/errors';
import { centsToRupees, rupeesToCents } from '../../lib/units';
import type { Stocktake, StocktakeItemInput } from '../../types/api';
import { parseIntStrict } from '../purchases/helpers';
import { Diff, SheetHeader } from './StocktakeSheetParts';

/** Limits matching the server's validation. */
const MAX_QTY = 1_000_000_000;
const MAX_CENTS = 99_999_999_999;
const MAX_NOTES = 500;
/** How many products the sheet loads (one row per active stock product of the book). */
const SHEET_PRODUCT_LIMIT = 500;

/**
 * One row of the count sheet. `system` = quantity the system believes is on the shelf. `noAvg` = the product has
 * no average cost (no stock or no value), so a counted surplus needs a manually entered unit cost.
 */
interface Row { productId: number; code: string | null; name: string; system: number; noAvg: boolean }

/** @param st the draft stocktake. The parent keys this component by stocktake id so a different sheet starts fresh. */
export function DraftSheet({ st }: { st: Stocktake }) {
  const toast = useToast();
  const update = useUpdateStocktake();
  const complete = useCompleteStocktake();
  const cancelMut = useVoidStocktake();
  const products = useProducts({ book: st.book, active: true, limit: SHEET_PRODUCT_LIMIT });

  // Typed counts and costs by product id, kept as text exactly as typed. Seeded from the saved draft lines.
  const [counts, setCounts] = useState<Record<number, string>>(() =>
    Object.fromEntries(st.items.map((i) => [i.productId, String(i.countedQty)])));
  const [costs, setCosts] = useState<Record<number, string>>(() =>
    Object.fromEntries(st.items.filter((i) => i.gainUnitCostCents !== null).map((i) => [i.productId, centsToRupees(i.gainUnitCostCents as number)])));
  const [notes, setNotes] = useState(st.notes);
  // Server messages about specific unit-cost boxes, by product id.
  const [costErrs, setCostErrs] = useState<Record<number, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // True while the two-step "save then complete" sequence runs.
  const [busy, setBusy] = useState(false);

  const rows = useMemo<Row[]>(() => {
    const list: Row[] = (products.data?.items ?? [])
      .filter((p) => p.kind === 'stock')
      .map((p) => ({ productId: p.id, code: p.code, name: p.name, system: p.qtyOnHand, noAvg: p.qtyOnHand <= 0 || p.stockValueCents <= 0 }));
    const seen = new Set(list.map((r) => r.productId));
    // Products already on the draft but no longer in the active list stay on the sheet so a save never drops them.
    for (const i of st.items) {
      if (!seen.has(i.productId)) list.push({ productId: i.productId, code: i.productCode, name: i.productName, system: i.expectedQty, noAvg: false });
    }
    return list;
  }, [products.data, st.items]);

  /** Parses one row's counted quantity: the number (null when empty/invalid), an error message, and the difference. */
  const calc = (r: Row) => {
    const raw = (counts[r.productId] ?? '').trim();
    if (raw === '') return { counted: null as number | null, countErr: undefined as string | undefined, diff: null as number | null };
    const n = parseIntStrict(raw);
    if (n === null || n > MAX_QTY) return { counted: null, countErr: 'Whole number, 0 or more.', diff: null };
    return { counted: n, countErr: undefined, diff: n - r.system };
  };

  /**
   * State of one row's unit-cost box: whether to show it (surplus without an average cost, or a server error to
   * display), the parsed cents (integer, via rupeesToCents) and any error.
   */
  const costState = (r: Row, diff: number | null) => {
    const raw = (costs[r.productId] ?? '').trim();
    const show = (diff !== null && diff > 0 && r.noAvg) || costErrs[r.productId] !== undefined;
    let cents: number | null = null;
    let err: string | undefined = costErrs[r.productId];
    if (raw !== '') {
      cents = rupeesToCents(raw);
      if (cents === null || cents > MAX_CENTS) { err = 'Enter a valid amount, e.g. 120.50'; cents = null; }
    }
    return { show, cents, err, raw };
  };

  // Overall state: any invalid input blocks Save/Complete; `counted` = rows that have a count.
  let invalid = false;
  let counted = 0;
  for (const r of rows) {
    const c = calc(r);
    if (c.countErr) invalid = true;
    if (c.counted !== null) {
      counted++;
      const cs = costState(r, c.diff);
      if (cs.raw !== '' && cs.cents === null) invalid = true;
    }
  }
  const pending = update.isPending || complete.isPending || busy;

  /** Items to save, in order, plus the product id behind each index (for server field errors). */
  const buildItems = () => {
    const items: StocktakeItemInput[] = [];
    const order: number[] = [];
    for (const r of rows) {
      const c = calc(r);
      if (c.counted === null) continue; // left empty = not counted = unchanged
      const item: StocktakeItemInput = { productId: r.productId, countedQty: c.counted };
      const cs = costState(r, c.diff);
      // A unit cost is only meaningful for a surplus.
      if (cs.cents !== null && c.diff !== null && c.diff > 0) item.gainUnitCostCents = cs.cents;
      items.push(item);
      order.push(r.productId);
    }
    return { items, order };
  };

  /**
   * Shows a failed save/complete: server errors addressed as "items.N.gainUnitCostCents" are mapped back to the
   * product's unit-cost box (N = position in the submitted list, see `order`); the rest becomes the banner.
   */
  const mapErrors = (e: unknown, order: number[]) => {
    const errs: Record<number, string> = {};
    if (e instanceof ApiError) {
      for (const [k, m] of Object.entries(e.fields)) {
        const match = /^items\.(\d+)\.gainUnitCostCents$/.exec(k);
        const pid = match ? order[Number(match[1])] : undefined;
        if (pid !== undefined) errs[pid] = m;
      }
    }
    setCostErrs(errs);
    const skip = Object.keys(errs).length ? Object.keys((e as ApiError).fields).filter((k) => /gainUnitCostCents$/.test(k)) : [];
    const msg = e instanceof ApiError && e.code === 'UNIT_COST_REQUIRED'
      ? 'Enter the unit cost for the highlighted rows (no average cost is available for them).'
      : errorBanner(e, skip);
    setBanner(msg);
    if (e instanceof ApiError && e.code === 'NOT_DRAFT') void update.reset();
  };

  /** Saves the counts and notes to the draft (PUT /stocktakes/:id). */
  const save = async (order: number[], items: StocktakeItemInput[]) => {
    await update.mutateAsync({ id: st.id, body: { notes: notes.trim(), items } });
    return order;
  };

  const onSave = async () => {
    const { items, order } = buildItems();
    setBanner(null);
    setCostErrs({});
    try {
      await save(order, items);
      toast.success('Draft saved.');
    } catch (e) {
      mapErrors(e, order);
    }
  };

  /** Completing = save the latest counts first, then ask the server to complete; both must succeed. */
  const onComplete = async () => {
    const { items, order } = buildItems();
    setBanner(null);
    setCostErrs({});
    setBusy(true);
    try {
      await save(order, items);
      await complete.mutateAsync(st.id);
      setConfirming(false);
      toast.success('Stocktake completed. Stock has been updated.');
    } catch (e) {
      mapErrors(e, order);
      // Missing unit costs are fixed on the sheet itself, so close the confirmation to reveal the highlighted rows.
      if (e instanceof ApiError && e.code === 'UNIT_COST_REQUIRED') setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  // While the confirmation is open, errors appear inside it; otherwise in the banner above the table.
  const confirmError = confirming ? banner : null;

  return (
    <>
      <SheetHeader st={st} />
      <Card>
        <p className="mb-4 text-sm text-slate-600">
          Enter the quantity you counted for each product. Leave a row empty if you did not count it — it will not change. System quantities are live and may change while you count.
        </p>
        <TextField label="Notes (optional)" value={notes} maxLength={MAX_NOTES} onChange={(e) => setNotes(e.target.value)} autoComplete="off" className="mb-4 max-w-xl" />
        {banner && !confirming && <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{banner}</p>}

        {products.isPending ? (
          <div className="flex justify-center py-12"><Spinner label="Loading products" /></div>
        ) : products.isError ? (
          <ErrorState error={products.error} onRetry={() => void products.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title="No stock products in this book" hint="Add stock products in the Products section first." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th scope="col" className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Code</th>
                  <th scope="col" className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Name</th>
                  <th scope="col" className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">System qty</th>
                  <th scope="col" className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">Counted qty</th>
                  <th scope="col" className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">Difference</th>
                  <th scope="col" className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Unit cost for gain (Rs.)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const c = calc(r);
                  const cs = costState(r, c.diff);
                  return (
                    <tr key={r.productId} className="border-b border-slate-100 align-top hover:bg-slate-50/60">
                      <td className="px-3 py-2.5">{r.code ?? '—'}</td>
                      <td className="px-3 py-2.5 font-medium text-slate-900">{r.name}</td>
                      <td className="num px-3 py-2.5 text-right">{r.system}</td>
                      <td className="px-3 py-2.5 text-right">
                        <input
                          aria-label={`Counted qty for ${r.name}`}
                          aria-invalid={c.countErr ? true : undefined}
                          inputMode="numeric"
                          autoComplete="off"
                          value={counts[r.productId] ?? ''}
                          onChange={(e) => setCounts((m) => ({ ...m, [r.productId]: e.target.value }))}
                          className={`${inputClass(c.countErr)} num ml-auto w-28 text-right`}
                        />
                        {c.countErr && <p className="mt-1 text-xs text-red-600">{c.countErr}</p>}
                      </td>
                      <td className="px-3 py-2.5 text-right">{c.diff === null ? <span className="text-slate-400">—</span> : <Diff n={c.diff} />}</td>
                      <td className="px-3 py-2.5">
                        {cs.show && (
                          <div className="max-w-56">
                            <input
                              aria-label={`Unit cost for gain (Rs.) for ${r.name}`}
                              aria-invalid={cs.err ? true : undefined}
                              inputMode="decimal"
                              autoComplete="off"
                              placeholder="0.00"
                              value={costs[r.productId] ?? ''}
                              onChange={(e) => {
                                setCosts((m) => ({ ...m, [r.productId]: e.target.value }));
                                // Editing the box clears its old server error.
                                setCostErrs((m) => { const n = { ...m }; delete n[r.productId]; return n; });
                              }}
                              className={`${inputClass(cs.err)} num text-right`}
                            />
                            {cs.err ? (
                              <p className="mt-1 text-xs text-red-600">{cs.err}</p>
                            ) : (
                              <p className="mt-1 text-xs text-slate-500">No average cost available — enter the cost per unit (C10)</p>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
          <span className="text-sm text-slate-600">{counted} product(s) counted</span>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setCancelling(true)} disabled={pending}>Cancel stocktake</Button>
            <Button variant="secondary" onClick={() => void onSave()} disabled={invalid || pending} loading={update.isPending && !busy}>Save draft</Button>
            <Button onClick={() => { setBanner(null); setConfirming(true); }} disabled={invalid || counted === 0 || pending}>Complete stocktake</Button>
          </div>
        </div>
      </Card>

      <ConfirmDialog
        open={confirming}
        title="Complete this stocktake?"
        confirmLabel="Complete stocktake"
        loading={busy}
        error={confirmError}
        onConfirm={() => void onComplete()}
        onClose={() => { if (!busy) setConfirming(false); }}
      >
        <p>Differences will be posted to stock as stocktake gains/losses at the average cost; this cannot be edited afterwards, only voided.</p>
        <p>{counted} product(s) counted. Products you left empty are not changed.</p>
      </ConfirmDialog>

      {cancelling && (
        <VoidRecordDialog
          title={`Cancel stocktake #${st.id}`}
          intro="This draft will be cancelled. No stock is changed."
          submitLabel="Cancel stocktake"
          typedConfirm={false}
          pending={cancelMut.isPending}
          run={(reason, cb) => cancelMut.mutate({ id: st.id, reason }, cb)}
          onDone={() => { toast.success('Stocktake cancelled.'); setCancelling(false); }}
          onClose={() => setCancelling(false)}
        />
      )}
    </>
  );
}
