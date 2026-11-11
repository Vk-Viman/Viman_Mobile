/**
 * SaleDetailDialog: read-only details of one sale (header, lines, returns) with the "Void sale" and "Return items"
 * actions. Opened from the History list.
 * API: GET /sales/:id (api/sales.ts); the actions open VoidSaleDialog / SaleReturnDialog.
 * Rules shown: a sale with returns cannot be voided (the server says HAS_RETURNS), a void sale accepts no actions
 * (ALREADY_VOID / SALE_VOID), and "Return items" is unavailable once everything has been returned. Unit cost is the
 * snapshot of the AUTOMATIC cost taken at sale time and never changes afterwards; C13 adds the extra cost the cashier
 * charged and the resulting charged cost (shown per line and in the header). All amounts are the server's integer cents.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import { Modal } from '../../components/Modal';
import { Money } from '../../components/Money';
import { Spinner } from '../../components/Spinner';
import { BookBadge, PostedStatusBadge } from '../../components/StatusBadges';
import { useSale } from '../../api/sales';
import { formatDateTime } from '../../lib/format';
import { SaleReturnDialog } from './SaleReturnDialog';
import { VoidSaleDialog } from './VoidSaleDialog';

/** @param id the sale to show. Mount only while open (parent keys it by id so switching sales reloads). */
export function SaleDetailDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const q = useSale(id);
  // Which action dialog is open on top of this one (null = none).
  const [sub, setSub] = useState<'void' | 'return' | null>(null);
  const s = q.data?.item;

  const hasReturns = (s?.returns.length ?? 0) > 0;
  const fullyReturned = s ? s.items.every((i) => i.qty - i.returnedQty <= 0) : true;

  return (
    <>
      {/* `paused` hands Esc/Tab to the action dialog while it is open on top of this one. */}
      <Modal title={`Sale #${id}`} onClose={onClose} paused={sub !== null} widthClass="max-w-4xl">
        {q.isPending ? (
          <div className="flex justify-center py-10"><Spinner label="Loading sale" /></div>
        ) : q.isError || !s ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <div className="space-y-5">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Row k="Business date" v={<>{s.businessDate} {s.backdated && <Badge tone="amber">Backdated</Badge>}</>} />
              <Row k="Posted (Colombo time)" v={formatDateTime(s.postedAt)} />
              <Row k="Book" v={<BookBadge book={s.book} />} />
              <Row k="Status" v={<PostedStatusBadge status={s.status} />} />
              <Row k="Total" v={<Money cents={s.totalCents} className="font-semibold" />} />
              <Row k="Cost" v={<Money cents={s.chargedCostCents} />} />
              {s.extraCostCents > 0 && (
                <Row k="Cost breakdown" v={<>automatic <Money cents={s.cogsCents} /> + extra <Money cents={s.extraCostCents} /></>} />
              )}
              <Row k="Profit (before returns)" v={<Money cents={s.grossProfitCents} />} />
              <Row k="Notes" v={s.notes || '—'} />
              {s.status === 'void' && (
                <>
                  <Row k="Voided (Colombo time)" v={formatDateTime(s.voidedAt)} />
                  <Row k="Void reason" v={s.voidReason ?? '—'} />
                </>
              )}
            </dl>

            <section>
              <h3 className="mb-2 text-sm font-semibold text-slate-900">Items</h3>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      <th scope="col" className="px-2 py-2 text-left">Product</th>
                      <th scope="col" className="px-2 py-2 text-right">Qty</th>
                      <th scope="col" className="px-2 py-2 text-right">Unit price</th>
                      <th scope="col" className="px-2 py-2 text-right">Unit cost (automatic)</th>
                      <th scope="col" className="px-2 py-2 text-right">Extra cost</th>
                      <th scope="col" className="px-2 py-2 text-right">Charged cost</th>
                      <th scope="col" className="px-2 py-2 text-right">Line total</th>
                      <th scope="col" className="px-2 py-2 text-right">Returned qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.items.map((it) => (
                      <tr key={it.id} className="border-b border-slate-100">
                        <td className="px-2 py-2">{it.productName}{it.productCode && <span className="ml-2 text-xs text-slate-500">{it.productCode}</span>}</td>
                        <td className="num px-2 py-2 text-right">{it.qty}</td>
                        <td className="px-2 py-2 text-right"><Money cents={it.unitPriceCents} /></td>
                        <td className="px-2 py-2 text-right"><Money cents={it.unitCostCents} /></td>
                        <td className="px-2 py-2 text-right"><Money cents={it.extraCostCents} /></td>
                        <td className="px-2 py-2 text-right"><Money cents={it.chargedCostCents} /></td>
                        <td className="px-2 py-2 text-right"><Money cents={it.revenueCents} /></td>
                        <td className="num px-2 py-2 text-right">{it.returnedQty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold text-slate-900">Returns</h3>
              {s.returns.length === 0 ? (
                <p className="text-sm text-slate-500">No returns.</p>
              ) : (
                <ul className="space-y-2">
                  {s.returns.map((r) => (
                    <li key={r.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          {r.businessDate} {r.backdated && <Badge tone="amber">Backdated</Badge>}
                          <span className="ml-2 text-xs text-slate-500">posted {formatDateTime(r.postedAt)}</span>
                        </span>
                        <span>
                          Refund <Money cents={r.refundCents} className="font-semibold" />
                          {r.extraCostReversedCents > 0 && <span className="ml-2 text-xs text-slate-500">(extra cost reversed <Money cents={r.extraCostReversedCents} />)</span>}
                        </span>
                      </div>
                      <ul className="mt-1 space-y-0.5 text-slate-600">
                        {r.items.map((i) => (
                          <li key={i.id} className="flex flex-wrap items-center gap-2">
                            <span>{i.productName}: {i.qty} unit(s), <Money cents={i.revenueCents} /></span>
                            <Badge tone={i.resalable ? 'brand' : 'red'}>{i.resalable ? 'Resalable' : 'Damaged'}</Badge>
                          </li>
                        ))}
                      </ul>
                      {r.note && <p className="mt-1 text-slate-500">Note: {r.note}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Actions: disabled according to the sale state (rules above) */}
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-4">
              {s.status === 'void' && <span className="mr-auto text-xs text-slate-500">This sale is void, so it accepts no further changes.</span>}
              {hasReturns && s.status === 'posted' && (
                <span className="mr-auto text-xs text-slate-500">This sale has returns, so it cannot be voided.</span>
              )}
              <Button variant="danger" disabled={s.status === 'void' || hasReturns} onClick={() => setSub('void')}>Void sale</Button>
              <Button disabled={s.status === 'void' || fullyReturned} onClick={() => setSub('return')}>Return items</Button>
              <Button variant="secondary" onClick={onClose}>Close</Button>
            </div>
          </div>
        )}
      </Modal>
      {s && sub === 'void' && <VoidSaleDialog sale={s} onClose={() => setSub(null)} />}
      {s && sub === 'return' && <SaleReturnDialog sale={s} onClose={() => setSub(null)} />}
    </>
  );
}

/** One "label: value" line of the details list. */
function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-40 shrink-0 text-slate-500">{k}</dt>
      <dd className="min-w-0 break-words text-slate-900">{v}</dd>
    </div>
  );
}
