/**
 * OpeningNotice: the warning shown at the top of both Opening Stock tabs.
 * Opening stock is for go-live only: it adds stock WITHOUT any cash payment or purchase record (BUSINESS_RULES
 * section 3), so it must never be used to enter goods that were bought from a supplier - those are Purchases.
 */
import { AlertTriangle } from 'lucide-react';

/** Amber notice explaining what opening stock is for and what it does not do. */
export function OpeningNotice() {
  return (
    <div className="mb-4 flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <AlertTriangle size={20} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="space-y-1">
        <p className="font-medium">Opening stock is for go-live only.</p>
        <p>
          Use it once, to enter the stock you already own when you start using this system. It adds stock without
          recording a purchase or any cash payment, and it is not profit or loss. Goods you buy from a supplier must be
          entered as a <strong>Purchase</strong> so the cash book stays correct - opening stock cannot be used to hide a purchase.
        </p>
        <p>A mistake can be corrected by voiding the batch (only while that stock has not been sold or used).</p>
      </div>
    </div>
  );
}
