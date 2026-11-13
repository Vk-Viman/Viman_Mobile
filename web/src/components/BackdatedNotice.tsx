/**
 * BackdatedNotice: a short amber warning shown next to a business-date field when the chosen date is earlier than
 * today (owner decision 2026-11-13, BUSINESS_RULES 12 "Backdated inventory warning").
 * Where: every inventory-transaction form (purchases, returns, stock losses, personal use, stocktake, opening stock, POS).
 * It changes nothing: the server still accepts earlier dates, audits them and lists them in the Backdated report.
 */
import { AlertTriangle } from 'lucide-react';

/**
 * @param date  the business date the owner chose (YYYY-MM-DD) or '' while empty
 * @param today the server's business date (from GET /health, via useBusinessDate().today)
 * Renders nothing unless `date` is a real date earlier than `today`.
 */
export function BackdatedNotice({ date, today }: { date: string; today: string }) {
  if (!date || !today || date >= today) return null;
  return (
    <p role="status" className="mt-1 flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>
        <strong>Backdated entry ({date}).</strong> Stock costing follows the order entries are saved, so the cost already
        recorded on earlier sales is not recalculated. This entry is flagged and listed in the Backdated report.
      </span>
    </p>
  );
}
