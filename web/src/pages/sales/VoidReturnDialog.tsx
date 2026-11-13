/**
 * VoidReturnDialog: asks for a reason and the word VOID, then takes ONE sales return back (rule R-VR).
 * Opened from SaleDetailDialog. API: POST /sales/:saleId/returns/:returnId/void (api/sales.ts).
 * Built on the shared VoidRecordDialog. The intro states the consequences; the server's refusal (a newer return exists,
 * the returned units are no longer in stock, the day is closed) appears in the dialog banner in the server's own words.
 */
import { VoidRecordDialog } from '../../components/VoidRecordDialog';
import { useToast } from '../../components/Toast';
import { useVoidSaleReturn } from '../../api/sales';
import { notifyCashWarnings } from '../../lib/cashWarnings';
import { BOOK_LABEL } from '../../lib/constants';
import type { Sale, SaleReturn } from '../../types/api';

/** @param sale the sale; @param ret the return to void. Mount only while open. */
export function VoidReturnDialog({ sale, ret, onClose }: { sale: Sale; ret: SaleReturn; onClose: () => void }) {
  const toast = useToast();
  const voidMut = useVoidSaleReturn();
  const hasStock = ret.items.some((i) => i.resalable);

  return (
    <VoidRecordDialog
      title={`Void return #${ret.id}`}
      intro={
        `This cancels the return of ${ret.businessDate}. `
        + (hasStock ? 'The returned units leave stock again. ' : 'The damaged units were never put back into stock, so stock does not change; their write-off is cancelled. ')
        + `The refund is paid back into the ${BOOK_LABEL[sale.book]} cash book. The sale's revenue, cost and extra cost stand again in full, `
        + 'as if the return had never been made. The original return stays in the history. It cannot be undone. '
        + 'It is refused if the returned units are no longer in stock, if a newer return of the same item exists, or if that day is closed.'
      }
      submitLabel="Void return"
      pending={voidMut.isPending}
      run={(reason, cb) => voidMut.mutate(
        { saleId: sale.id, returnId: ret.id, body: { reason } },
        { onSuccess: (r) => { notifyCashWarnings(toast, r.warnings); cb.onSuccess(); }, onError: cb.onError },
      )}
      onDone={() => { toast.success('Return voided.'); onClose(); }}
      onClose={onClose}
    />
  );
}
