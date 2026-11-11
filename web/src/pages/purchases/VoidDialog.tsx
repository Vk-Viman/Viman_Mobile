/**
 * VoidDialog: asks for a reason and the word VOID, then cancels a whole purchase.
 * Opened from PurchaseDetailDialog. API: POST /purchases/:id/void (api/purchases.ts).
 * Built on the shared VoidRecordDialog (reason + typed confirmation + double-click guard) so every void in the
 * app behaves identically. The server (rule R1) refuses to void a purchase that already has returns.
 */
import { VoidRecordDialog } from '../../components/VoidRecordDialog';
import { useVoidPurchase } from '../../api/purchases';
import { useToast } from '../../components/Toast';
import { BOOK_LABEL } from '../../lib/constants';
import type { Purchase } from '../../types/api';

/** @param purchase the purchase to void. Mount only while open. */
export function VoidDialog({ purchase, onClose }: { purchase: Purchase; onClose: () => void }) {
  const toast = useToast();
  const voidMut = useVoidPurchase();

  return (
    <VoidRecordDialog
      title={`Void purchase #${purchase.id}`}
      intro={`This removes the stock that was bought and puts the money back into the ${BOOK_LABEL[purchase.book]} cash book. It cannot be undone.`}
      submitLabel="Void purchase"
      pending={voidMut.isPending}
      run={(reason, cb) => voidMut.mutate({ id: purchase.id, body: { reason } }, cb)}
      onDone={() => { toast.success('Purchase voided.'); onClose(); }}
      onClose={onClose}
    />
  );
}
