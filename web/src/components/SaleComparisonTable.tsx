/**
 * SaleComparisonTable: the "original against replacement" table of a sale correction (shown in the preview step).
 * Figures are the server's integer cents (`comparison` of correct-preview); nothing is calculated here except the revenue difference,
 * a plain subtraction of two server figures. The cost can differ even when nothing was changed: the original sale's cost was frozen
 * when it was saved, while the replacement is costed at the weighted average of that moment (stock may have been bought or sold in
 * between). The screen says so, because the difference moves profit.
 */
import { Money } from './Money';
import type { SaleComparison } from '../api/corrections';

/** One comparison row: label, original, replacement and a highlighted difference. */
function Row({ label, original, replacement, diff }: { label: string; original: number; replacement: number; diff: number }) {
  const tone = diff === 0 ? 'text-slate-600' : 'bg-amber-100 font-semibold text-amber-900';
  return (
    <tr className="border-b border-slate-100">
      <th scope="row" className="px-2 py-2 text-left font-medium text-slate-700">{label}</th>
      <td className="px-2 py-2 text-right"><Money cents={original} /></td>
      <td className="px-2 py-2 text-right"><Money cents={replacement} /></td>
      <td className={`px-2 py-2 text-right ${tone}`}>{diff > 0 ? '+' : ''}<Money cents={diff} /></td>
    </tr>
  );
}

/** @param c the `comparison` object of a sale correction preview or result. */
export function SaleComparisonTable({ c }: { c: SaleComparison }) {
  const costChanged = c.lines.some((l) => l.originalUnitCostCents !== l.replacementUnitCostCents);
  return (
    <section aria-label="Original against replacement" className="space-y-2">
      <h3 className="text-sm font-semibold text-slate-900">Original against replacement</h3>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <th scope="col" className="px-2 py-2 text-left">Figure</th>
              <th scope="col" className="px-2 py-2 text-right">Original</th>
              <th scope="col" className="px-2 py-2 text-right">Replacement</th>
              <th scope="col" className="px-2 py-2 text-right">Difference</th>
            </tr>
          </thead>
          <tbody>
            <Row label="Revenue" original={c.originalRevenueCents} replacement={c.replacementRevenueCents} diff={c.replacementRevenueCents - c.originalRevenueCents} />
            <Row label="Automatic cost of goods sold" original={c.originalCogsCents} replacement={c.replacementCogsCents} diff={c.cogsDifferenceCents} />
            <Row label="Extra cost" original={c.originalExtraCostCents} replacement={c.replacementExtraCostCents} diff={c.extraCostDifferenceCents} />
          </tbody>
        </table>
      </div>
      <p className={`rounded-lg p-3 text-sm ${costChanged || c.cogsDifferenceCents !== 0 ? 'bg-amber-50 text-amber-900' : 'bg-slate-50 text-slate-600'}`}>
        The automatic cost of the replacement comes from weighted-average costing at the moment you save: the original sale is put back into stock first,
        then the replacement is costed at the average cost of that moment. If stock was bought or sold since the original sale, the cost, and so the
        profit, can differ even when quantities are unchanged.
      </p>
    </section>
  );
}
