import { useState } from 'react';
import { Button } from '../../components/Button';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { ErrorState } from '../../components/ErrorState';
import { Modal } from '../../components/Modal';
import { Money } from '../../components/Money';
import { Spinner } from '../../components/Spinner';
import { useProductMovements } from '../../api/purchases';
import { formatDateTime } from '../../lib/format';
import type { MovementType, Product, StockMovement } from '../../types/api';

const LIMIT = 50;

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

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

export function MovementsDialog({ product, onClose }: { product: Product; onClose: () => void }) {
  const [page, setPage] = useState(0);
  const q = useProductMovements(product.id, { limit: LIMIT, offset: page * LIMIT });
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

  const total = q.data?.total ?? 0;
  const first = total === 0 ? 0 : page * LIMIT + 1;
  const last = Math.min(total, (page + 1) * LIMIT);

  return (
    <Modal title={`Stock history — ${product.name}`} onClose={onClose} widthClass="max-w-5xl">
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
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
            <span>{total === 0 ? '0 movements' : `Showing ${first}–${last} of ${total} movements`}</span>
            <div className="flex gap-2">
              <Button variant="secondary" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Previous</Button>
              <Button variant="secondary" disabled={last >= total} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
