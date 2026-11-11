/**
 * StocktakeSheet: the count-sheet page for one stocktake (route "/stock/stocktake/:id").
 * It loads the stocktake (GET /stocktakes/:id) and shows either:
 *  - the editable sheet while it is a draft (StocktakeDraftSheet), or
 *  - a read-only view with a "Void stocktake" button once it is completed or void (ReadOnlySheet below).
 * Voiding a completed stocktake reverses the stock gains/losses it posted; the server does the reversal.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { Money } from '../../components/Money';
import { Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { VoidRecordDialog } from '../../components/VoidRecordDialog';
import { useStocktake, useVoidStocktake } from '../../api/stock';
import type { Stocktake, StocktakeItem } from '../../types/api';
import { DraftSheet } from './StocktakeDraftSheet';
import { Diff, SheetHeader } from './StocktakeSheetParts';

/** Read-only view of a completed or voided stocktake: its lines and, for completed ones, the Void button. */
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

/**
 * Route component. Reads `:id` from the URL, validates it as a whole number (anything else shows "not found"
 * without calling the API) and renders the right view for the stocktake's status.
 */
export function StocktakeSheet() {
  const { id } = useParams();
  const n = id && /^\d+$/.test(id) ? Number(id) : null;
  const q = useStocktake(n);

  if (n === null) return <EmptyState title="Stocktake not found" action={<Link to="/stock/stocktake" className="text-brand-700 hover:underline">Back to stocktakes</Link>} />;
  if (q.isPending) return <div className="flex justify-center py-12"><Spinner label="Loading stocktake" /></div>;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const st = q.data.item;
  // key = stocktake id: switching to another draft re-creates the sheet so typed counts never leak between sheets.
  return st.status === 'draft' ? <DraftSheet key={st.id} st={st} /> : <ReadOnlySheet st={st} />;
}
