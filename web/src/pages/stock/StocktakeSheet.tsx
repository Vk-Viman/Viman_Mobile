import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { Money } from '../../components/Money';
import { Spinner } from '../../components/Spinner';
import { TextField, inputClass } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { ApiError } from '../../api/client';
import { useProducts } from '../../api/catalog';
import { useCompleteStocktake, useStocktake, useUpdateStocktake, useVoidStocktake } from '../../api/stock';
import { rupeesToCents } from '../../lib/units';
import type { Stocktake, StocktakeItem, StocktakeItemInput } from '../../types/api';
import { BOOK_LABEL } from '../products/shared';
import { parseIntStrict } from '../purchases/helpers';
import { VoidRecordDialog, errorBanner } from './shared';
import { STATUS_LABEL, STATUS_TONE } from './StocktakeTab';

const MAX_QTY = 1_000_000_000;
const MAX_CENTS = 99_999_999_999;

interface Row { productId: number; code: string | null; name: string; system: number; noAvg: boolean }

function Diff({ n }: { n: number }) {
  if (n === 0) return <span className="num text-slate-600">0</span>;
  return <span className={`num font-medium ${n > 0 ? 'text-brand-700' : 'text-red-700'}`}>{n > 0 ? `+${n}` : n}</span>;
}

function SheetHeader({ st }: { st: Stocktake }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <Link to="/stock/stocktake" className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline">
        <ArrowLeft size={16} aria-hidden="true" /> All stocktakes
      </Link>
      <h2 className="text-lg font-semibold text-slate-900">Stocktake #{st.id} — {st.businessDate}</h2>
      <Badge tone={st.book === 'shop' ? 'brand' : 'neutral'}>{BOOK_LABEL[st.book]}</Badge>
      <Badge tone={STATUS_TONE[st.status]}>{STATUS_LABEL[st.status]}</Badge>
      {st.backdated && <Badge tone="amber">Backdated</Badge>}
    </div>
  );
}

function DraftSheet({ st }: { st: Stocktake }) {
  const toast = useToast();
  const update = useUpdateStocktake();
  const complete = useCompleteStocktake();
  const cancelMut = useVoidStocktake();
  const products = useProducts({ book: st.book, active: true, limit: 500 });

  const [counts, setCounts] = useState<Record<number, string>>(() =>
    Object.fromEntries(st.items.map((i) => [i.productId, String(i.countedQty)])));
  const [costs, setCosts] = useState<Record<number, string>>(() =>
    Object.fromEntries(st.items.filter((i) => i.gainUnitCostCents !== null).map((i) => [i.productId, ((i.gainUnitCostCents as number) / 100).toFixed(2)])));
  const [notes, setNotes] = useState(st.notes);
  const [costErrs, setCostErrs] = useState<Record<number, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
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

  const calc = (r: Row) => {
    const raw = (counts[r.productId] ?? '').trim();
    if (raw === '') return { counted: null as number | null, countErr: undefined as string | undefined, diff: null as number | null };
    const n = parseIntStrict(raw);
    if (n === null || n > MAX_QTY) return { counted: null, countErr: 'Whole number, 0 or more.', diff: null };
    return { counted: n, countErr: undefined, diff: n - r.system };
  };

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
      if (c.counted === null) continue;
      const item: StocktakeItemInput = { productId: r.productId, countedQty: c.counted };
      const cs = costState(r, c.diff);
      if (cs.cents !== null && c.diff !== null && c.diff > 0) item.gainUnitCostCents = cs.cents;
      items.push(item);
      order.push(r.productId);
    }
    return { items, order };
  };

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
      if (e instanceof ApiError && e.code === 'UNIT_COST_REQUIRED') setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const confirmError = confirming ? banner : null;

  return (
    <>
      <SheetHeader st={st} />
      <Card>
        <p className="mb-4 text-sm text-slate-600">
          Enter the quantity you counted for each product. Leave a row empty if you did not count it — it will not change. System quantities are live and may change while you count.
        </p>
        <TextField label="Notes (optional)" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} autoComplete="off" className="mb-4 max-w-xl" />
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

function ReadOnlySheet({ st }: { st: Stocktake }) {
  const toast = useToast();
  const voidMut = useVoidStocktake();
  const [voiding, setVoiding] = useState(false);

  const columns: Column<StocktakeItem>[] = [
    { key: 'code', header: 'Code', render: (i) => i.productCode ?? '—' },
    { key: 'name', header: 'Name', render: (i) => <span className="font-medium text-slate-900">{i.productName}</span> },
    { key: 'exp', header: 'Expected', align: 'right', render: (i) => i.expectedQty },
    { key: 'cnt', header: 'Counted', align: 'right', render: (i) => i.countedQty },
    { key: 'diff', header: 'Difference', align: 'right', render: (i) => <Diff n={i.differenceQty} /> },
    { key: 'val', header: 'Value change (Rs.)', align: 'right', render: (i) => (i.valueDeltaCents === null ? '—' : <Money cents={i.valueDeltaCents} />) },
  ];

  return (
    <>
      <SheetHeader st={st} />
      <Card>
        {st.notes && <p className="mb-3 text-sm text-slate-600">Notes: {st.notes}</p>}
        {st.status === 'void' && (
          <p className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">Voided{st.voidReason ? `: ${st.voidReason}` : ''}</p>
        )}
        <DataTable columns={columns} rows={st.items} rowKey={(i) => i.id} emptyTitle="No items" emptyHint="This stocktake has no counted products." />
        {st.status === 'completed' && (
          <div className="mt-5 flex justify-end border-t border-slate-100 pt-4">
            <Button variant="danger" onClick={() => setVoiding(true)}>Void stocktake</Button>
          </div>
        )}
      </Card>
      {voiding && (
        <VoidRecordDialog
          title={`Void stocktake #${st.id}`}
          intro="This reverses the stock gains and losses posted by this stocktake. It cannot be undone."
          submitLabel="Void stocktake"
          pending={voidMut.isPending}
          run={(reason, cb) => voidMut.mutate({ id: st.id, reason }, cb)}
          onDone={() => { toast.success('Stocktake voided.'); setVoiding(false); }}
          onClose={() => setVoiding(false)}
        />
      )}
    </>
  );
}

export function StocktakeSheet() {
  const { id } = useParams();
  const n = id && /^\d+$/.test(id) ? Number(id) : null;
  const q = useStocktake(n);

  if (n === null) return <EmptyState title="Stocktake not found" action={<Link to="/stock/stocktake" className="text-brand-700 hover:underline">Back to stocktakes</Link>} />;
  if (q.isPending) return <div className="flex justify-center py-12"><Spinner label="Loading stocktake" /></div>;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const st = q.data.item;
  return st.status === 'draft' ? <DraftSheet key={st.id} st={st} /> : <ReadOnlySheet st={st} />;
}
