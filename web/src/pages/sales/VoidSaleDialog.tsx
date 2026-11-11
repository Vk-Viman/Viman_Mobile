/**
 * VoidSaleDialog: asks for a reason and the word VOID, then cancels a whole sale.
 * Opened from SaleDetailDialog. API: POST /sales/:id/void (api/sales.ts).
 * Built on the shared VoidRecordDialog so every void in the app behaves identically. The server refuses a void when
 * the sale has returns (HAS_RETURNS) or is already void (ALREADY_VOID); its message appears in the dialog banner.
 */
import { VoidRecordDialog } from '../../components/VoidRecordDialog';
import { useToast } from '../../components/Toast';
import { useVoidSale } from '../../api/sales';
import { BOOK_LABEL } from '../../lib/constants';
import type { Sale } from '../../types/api';

/** @param sale the sale to void. Mount only while open. */
export function VoidSaleDialog({ sale, onClose }: { sale: Sale; onClose: () => void }) {
  const toast = useToast();
  const voidMut = useVoidSale();

  return (
    <VoidRecordDialog
      title={`Void sale #${sale.id}`}
      intro={`This puts the sold items back into stock at their original cost and takes the money out of the ${BOOK_LABEL[sale.book]} cash book. It cannot be undone.`}
      submitLabel="Void sale"
      pending={voidMut.isPending}
      run={(reason, cb) => voidMut.mutate({ id: sale.id, body: { reason } }, cb)}
      onDone={() => { toast.success('Sale voided.'); onClose(); }}
      onClose={onClose}
    />
  );
}
