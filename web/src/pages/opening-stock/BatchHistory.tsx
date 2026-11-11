/**
 * BatchHistory: the list of opening stock batches (manual and Excel) with a details window and a void action.
 * Shown under both tabs of the Opening Stock screen.
 * API: GET /opening-stock, GET /opening-stock/:id, POST /opening-stock/:id/void (api/openingStock.ts).
 * Rules: a void reverses the whole batch (R1) and is refused by the server with OPENING_BATCH_IN_USE when some of
 * that stock has already been sold or used; the refusal text is shown in the void dialog.
 */
import { useState } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { ErrorState } from '../../components/ErrorState';
import { Modal } from '../../components/Modal';
import { Money } from '../../components/Money';
import { Pager } from '../../components/Pager';
import { Spinner } from '../../components/Spinner';
import { PostedStatusBadge } from '../../components/StatusBadges';
import { useToast } from '../../components/Toast';
import { VoidRecordDialog } from '../../components/VoidRecordDialog';
import { useOpeningBatch, useOpeningBatches, useVoidOpeningBatch } from '../../api/openingStock';
import { formatDateTime } from '../../lib/format';
import { PAGE_SIZE } from '../../lib/constants';
import type { OpeningBatch, OpeningLine } from '../../types/openingStock';

/** Details of one batch: header facts, its lines, and the "Void batch" button while it is posted. */
function BatchDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const q = useOpeningBatch(id);
  const [voiding, setVoiding] = useState(false);
  const voidMut = useVoidOpeningBatch();
  const toast = useToast();
  const b = q.data?.item;

  const lineColumns: Column<OpeningLine>[] = [
    { key: 'sku', header: 'SKU', render: (l) => l.productCode ?? '—' },
    { key: 'name', header: 'Product', render: (l) => l.productName },
    { key: 'qty', header: 'Quantity', align: 'right', render: (l) => l.qty },
    { key: 'unit', header: 'Unit cost (Rs.)', align: 'right', render: (l) => <Money cents={l.unitCostCents} /> },
    { key: 'value', header: 'Value (Rs.)', align: 'right', render: (l) => <Money cents={l.valueCents} /> },
  ];

  return (
    <>
      <Modal title={`Opening stock batch #${id}`} onClose={onClose} paused={voiding}>
        {q.isPending ? (
          <div className="flex justify-center py-10"><Spinner label="Loading batch" /></div>
        ) : q.isError || !b ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <div className="space-y-5">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div><dt className="inline text-slate-500">Business date: </dt><dd className="inline">{b.businessDate} {b.backdated && <Badge tone="amber">Backdated</Badge>}</dd></div>
              <div><dt className="inline text-slate-500">Posted (Colombo time): </dt><dd className="inline">{formatDateTime(b.postedAt)}</dd></div>
              <div><dt className="inline text-slate-500">Source: </dt><dd className="inline">{b.source === 'excel' ? `Excel (${b.fileName ?? ''})` : 'Manual entry'}</dd></div>
              <div><dt className="inline text-slate-500">Status: </dt><dd className="inline"><PostedStatusBadge status={b.status} /></dd></div>
              <div><dt className="inline text-slate-500">Total value: </dt><dd className="inline"><Money cents={b.totalValueCents} className="font-semibold" /></dd></div>
              <div><dt className="inline text-slate-500">Notes: </dt><dd className="inline">{b.notes || '—'}</dd></div>
              {b.status === 'void' && (
                <>
                  <div><dt className="inline text-slate-500">Voided (Colombo time): </dt><dd className="inline">{formatDateTime(b.voidedAt)}</dd></div>
                  <div><dt className="inline text-slate-500">Void reason: </dt><dd className="inline">{b.voidReason ?? '—'}</dd></div>
                </>
              )}
            </dl>
            <DataTable columns={lineColumns} rows={b.items} rowKey={(l) => l.productId} />
            {b.status === 'posted' && (
              <div className="flex justify-end">
                <Button variant="danger" onClick={() => setVoiding(true)}>Void batch</Button>
              </div>
            )}
          </div>
        )}
      </Modal>
      {voiding && (
        <VoidRecordDialog
          title={`Void opening stock batch #${id}`}
          intro="This takes the whole batch back out of stock. It is refused if some of that stock has already been sold or used. No cash is involved. It cannot be undone."
          submitLabel="Void batch"
          pending={voidMut.isPending}
          run={(reason, cb) => voidMut.mutate({ id, reason }, cb)}
          onDone={() => { toast.success('Opening stock batch voided.'); setVoiding(false); }}
          onClose={() => setVoiding(false)}
        />
      )}
    </>
  );
}

/** Paged list of batches, newest first; clicking a date opens the details. */
export function BatchHistory() {
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);
  const list = useOpeningBatches({ limit: PAGE_SIZE, offset: page * PAGE_SIZE });

  const columns: Column<OpeningBatch>[] = [
    {
      key: 'date',
      header: 'Date',
      render: (b) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          {/* A real button so keyboard users can open details (row click is mouse-only). */}
          <button type="button" className="font-medium text-brand-700 underline-offset-2 hover:underline" onClick={(e) => { e.stopPropagation(); setOpenId(b.id); }}>
            {b.businessDate}
          </button>
          {b.backdated && <Badge tone="amber">Backdated</Badge>}
        </span>
      ),
    },
    { key: 'source', header: 'Source', render: (b) => (b.source === 'excel' ? `Excel${b.fileName ? ` (${b.fileName})` : ''}` : 'Manual') },
    { key: 'lines', header: 'Products', align: 'right', render: (b) => b.rowCount },
    { key: 'value', header: 'Value (Rs.)', align: 'right', render: (b) => <Money cents={b.totalValueCents} /> },
    { key: 'status', header: 'Status', render: (b) => <PostedStatusBadge status={b.status} /> },
  ];

  return (
    <>
      <Card title="Opening stock batches" className="mt-6">
        {list.isPending ? (
          <div className="flex justify-center py-8"><Spinner label="Loading batches" /></div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={list.data.items}
              rowKey={(b) => b.id}
              emptyTitle="No opening stock entered yet"
              emptyHint="Batches you save here are listed with their date and value."
              onRowClick={(b) => setOpenId(b.id)}
            />
            <Pager page={page} total={list.data.total} limit={PAGE_SIZE} noun="batches" onPage={setPage} />
            {list.data.total > 0 && (
              <p className="mt-2 text-sm text-slate-600">Total value of posted batches: <Money cents={list.data.totals.valueCents} className="font-semibold" /></p>
            )}
          </>
        )}
      </Card>
      {openId !== null && <BatchDialog key={openId} id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}
