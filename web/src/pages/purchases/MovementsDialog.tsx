/**
 * MovementsDialog: read-only "Stock history" pop-up for one product, listing every change in its quantity
 * (purchases, returns, sales, losses, stocktakes...), newest first, with paging.
 * Opened from Products > Products ("History" button). API: GET /products/:id/movements (api/purchases.ts).
 * Quantity and value changes are the server's ledger rows (signed integers / integer cents), only formatted here.
 */
import { useState } from 'react';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { ErrorState } from '../../components/ErrorState';
import { Modal } from '../../components/Modal';
import { Money } from '../../components/Money';
import { Pager } from '../../components/Pager';
import { Spinner } from '../../components/Spinner';
import { useProductMovements } from '../../api/purchases';
import { formatDateTime } from '../../lib/format';
import { PAGE_SIZE } from '../../lib/constants';
import type { MovementType, Product, StockMovement } from '../../types/api';

/** Owner-friendly name for each kind of stock movement. */
const MOVEMENT_LABEL: Record<MovementType, string> = {
  opening: 'Opening stock',
  purchase: 'Purchase',
  purchase_return: 'Purchase return',
  purchase_void: 'Purchase voided',
  sale: 'Sale',
  sale_return: 'Sale return',
  sale_void: 'Sale voided',
  personal_use: 'Personal use',
  loss: 'Loss',
  stocktake_gain: 'Stocktake gain',
  stocktake_loss: 'Stocktake loss',
  adjustment: 'Adjustment',
};

/** Shows an explicit "+" for increases so gains and losses are easy to tell apart: 5 -> "+5", -3 -> "-3". */
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/**
 * @param product the product whose history is shown (its name and, until the reply arrives, its figures).
 * Mount only while open; closing is handled by the parent through `onClose`.
 */
export function MovementsDialog({ product, onClose }: { product: Product; onClose: () => void }) {
  const [page, setPage] = useState(0);
  const q = useProductMovements(product.id, { limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  // Prefer the fresh product figures from the reply (they include the latest stock); fall back to the row we opened from.
  const cur = q.data?.product ?? product;

  const columns: Column<StockMovement>[] = [
    { key: 'date', header: 'Date', render: (m) => m.businessDate },
    { key: 'posted', header: 'Posted (Colombo)', render: (m) => <span className="whitespace-nowrap">{formatDateTime(m.postedAt)}</span> },
    { key: 'type', header: 'Type', render: (m) => MOVEMENT_LABEL[m.type] ?? m.type },
    { key: 'qty', header: 'Qty change', align: 'right', render: (m) => <span className={m.qtyDelta < 0 ? 'text-red-700' : ''}>{signed(m.qtyDelta)}</span> },
    { key: 'val', header: 'Value change', align: 'right', render: (m) => <Money cents={m.valueDeltaCents} /> },
    { key: 'cost', header: 'Unit cost', align: 'right', render: (m) => (m.unitCostCents === null ? '—' : <Money cents={m.unitCostCents} />) },
    { key: 'reason', header: 'Reason', render: (m) => m.reason || '—' },
  ];

  return (
    <Modal title={`Stock history — ${product.name}`} onClose={onClose} widthClass="max-w-5xl">
      {/* Current position of the product: quantity, value and average cost (all from the server) */}
      <dl className="mb-4 grid gap-3 text-sm sm:grid-cols-3">
        <div><dt className="text-slate-500">Stock</dt><dd className="num font-semibold">{cur.qtyOnHand}</dd></div>
        <div><dt className="text-slate-500">Value</dt><dd><Money cents={cur.stockValueCents} className="font-semibold" /></dd></div>
        <div><dt className="text-slate-500">Avg cost</dt><dd>{cur.avgUnitCostCents === null ? '—' : <Money cents={cur.avgUnitCostCents} className="font-semibold" />}</dd></div>
      </dl>
      {q.isPending ? (
        <div className="flex justify-center py-10"><Spinner label="Loading history" /></div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <DataTable columns={columns} rows={q.data.items} rowKey={(m) => m.id} emptyTitle="No stock movements yet" emptyHint="Purchases and other stock changes will appear here." />
          <Pager page={page} total={q.data.total} limit={PAGE_SIZE} noun="movements" onPage={setPage} />
        </>
      )}
    </Modal>
  );
}
