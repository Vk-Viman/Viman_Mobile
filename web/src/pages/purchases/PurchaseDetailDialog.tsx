/**
 * PurchaseDetailDialog: read-only details of one purchase (header, items, returns) with the "Void purchase" and
 * "Return items" actions. Opened from the Purchases list.
 * API: GET /purchases/:id (api/purchases.ts); the actions open VoidDialog / ReturnDialog.
 * Rules shown: a purchase with returns cannot be voided (R1), a voided purchase accepts no actions, and "Return
 * items" is unavailable once everything has been returned. The server enforces these too.
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
import { usePurchase } from '../../api/purchases';
import { formatDateTime } from '../../lib/format';
import { ReturnDialog } from './ReturnDialog';
import { VoidDialog } from './VoidDialog';

/** @param id the purchase to show. Mount only while open (parent keys it by id so switching purchases reloads). */
export function PurchaseDetailDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const q = usePurchase(id);
  // Which action dialog is open on top of this one (null = none).
  const [sub, setSub] = useState<'void' | 'return' | null>(null);
  const p = q.data?.item;

  const hasReturns = (p?.returns.length ?? 0) > 0;
  const fullyReturned = p ? p.items.every((i) => i.units - i.returnedUnits <= 0) : true;

  return (
    <>
      {/* `paused` hands Esc/Tab to the action dialog while it is open on top of this one. */}
      <Modal title={`Purchase #${id}`} onClose={onClose} paused={sub !== null}>
        {q.isPending ? (
          <div className="flex justify-center py-10"><Spinner label="Loading purchase" /></div>
        ) : q.isError || !p ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <div className="space-y-5">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Row k="Business date" v={<>{p.businessDate} {p.backdated && <Badge tone="amber">Backdated</Badge>}</>} />
              <Row k="Posted (Colombo time)" v={formatDateTime(p.postedAt)} />
              <Row k="Bill no" v={p.billNo || '—'} />
              <Row k="Supplier" v={p.supplierName ?? '—'} />
              <Row k="Book" v={<BookBadge book={p.book} />} />
              <Row k="Status" v={<PostedStatusBadge status={p.status} />} />
              <Row k="Total paid" v={<Money cents={p.totalCents} className="font-semibold" />} />
              <Row k="Notes" v={p.notes || '—'} />
              {p.status === 'void' && (
                <>
                  <Row k="Voided (Colombo time)" v={formatDateTime(p.voidedAt)} />
                  <Row k="Void reason" v={p.voidReason ?? '—'} />
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
                      <th scope="col" className="px-2 py-2 text-right">Packs × size</th>
                      <th scope="col" className="px-2 py-2 text-right">Units</th>
                      <th scope="col" className="px-2 py-2 text-right">Line total</th>
                      <th scope="col" className="px-2 py-2 text-right">Unit cost</th>
                      <th scope="col" className="px-2 py-2 text-right">Returned units</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.items.map((it) => (
                      <tr key={it.id} className="border-b border-slate-100">
                        <td className="px-2 py-2">{it.productName}</td>
                        <td className="num px-2 py-2 text-right">{it.packs} × {it.packSize}</td>
                        <td className="num px-2 py-2 text-right">{it.units}</td>
                        <td className="px-2 py-2 text-right"><Money cents={it.lineTotalCents} /></td>
                        <td className="px-2 py-2 text-right"><Money cents={it.unitCostCents} /></td>
                        <td className="num px-2 py-2 text-right">{it.returnedUnits}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold text-slate-900">Returns</h3>
              {p.returns.length === 0 ? (
                <p className="text-sm text-slate-500">No returns.</p>
              ) : (
                <ul className="space-y-2">
                  {p.returns.map((r) => (
                    <li key={r.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          {r.businessDate} {r.backdated && <Badge tone="amber">Backdated</Badge>}
                          <span className="ml-2 text-xs text-slate-500">posted {formatDateTime(r.postedAt)}</span>
                        </span>
                        <span>Refund <Money cents={r.refundCents} className="font-semibold" /></span>
                      </div>
                      <ul className="mt-1 text-slate-600">
                        {r.items.map((i) => (
                          <li key={i.id}>{i.productName}: {i.units} unit(s), <Money cents={i.valueCents} /></li>
                        ))}
                      </ul>
                      {r.note && <p className="mt-1 text-slate-500">Note: {r.note}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Actions: disabled according to the purchase state (void/return rules above) */}
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-4">
              {hasReturns && p.status === 'posted' && (
                <span className="mr-auto text-xs text-slate-500">A purchase with returns cannot be voided.</span>
              )}
              <Button variant="danger" disabled={p.status === 'void' || hasReturns} onClick={() => setSub('void')}>Void purchase</Button>
              <Button disabled={p.status === 'void' || fullyReturned} onClick={() => setSub('return')}>Return items</Button>
              <Button variant="secondary" onClick={onClose}>Close</Button>
            </div>
          </div>
        )}
      </Modal>
      {p && sub === 'void' && <VoidDialog purchase={p} onClose={() => setSub(null)} />}
      {p && sub === 'return' && <ReturnDialog purchase={p} onClose={() => setSub(null)} />}
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
