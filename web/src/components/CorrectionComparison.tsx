/**
 * CorrectionComparison: the "original against replacement" block of a correction preview/result, for every type.
 * The server's `comparison` has a different shape per type (API_CONTRACTS.md, Correction contract Phase 1 and 2); this component
 * tells them apart by their fields and draws the matching table. Sales keep their own SaleComparisonTable (Phase 1, unchanged).
 * Figures are the server's integer cents; the only arithmetic here is subtracting two server figures where no difference is sent.
 */
import type { ReactNode } from 'react';
import { Money } from './Money';
import { SaleComparisonTable } from './SaleComparisonTable';
import type { AnyComparison, CommissionComparison, GoodsComparison, PrintComparison, PurchaseComparison, SaleComparison } from '../api/corrections';
import { rateLabel } from '../pages/telecom/shared';

const HEAD = 'border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500';
const HILITE = 'bg-amber-100 font-semibold text-amber-900';

/** One money row with a highlighted difference. */
function Row({ label, original, replacement, diff }: { label: string; original: number; replacement: number; diff: number }) {
  return (
    <tr className="border-b border-slate-100">
      <th scope="row" className="px-2 py-2 text-left font-medium text-slate-700">{label}</th>
      <td className="px-2 py-2 text-right"><Money cents={original} /></td>
      <td className="px-2 py-2 text-right"><Money cents={replacement} /></td>
      <td className={`px-2 py-2 text-right ${diff === 0 ? 'text-slate-600' : HILITE}`}>{diff > 0 ? '+' : ''}<Money cents={diff} /></td>
    </tr>
  );
}

function Shell({ children, note, amber = false }: { children: ReactNode; note?: string; amber?: boolean }) {
  return (
    <section aria-label="Original against replacement" className="space-y-2">
      <h3 className="text-sm font-semibold text-slate-900">Original against replacement</h3>
      <div className="overflow-x-auto">{children}</div>
      {note && <p className={`rounded-lg p-3 text-sm ${amber ? 'bg-amber-50 text-amber-900' : 'bg-slate-50 text-slate-600'}`}>{note}</p>}
    </section>
  );
}

function MoneyHead() {
  return (
    <thead>
      <tr className={HEAD}>
        <th scope="col" className="px-2 py-2 text-left">Figure</th>
        <th scope="col" className="px-2 py-2 text-right">Original</th>
        <th scope="col" className="px-2 py-2 text-right">Replacement</th>
        <th scope="col" className="px-2 py-2 text-right">Difference</th>
      </tr>
    </thead>
  );
}

function PurchaseTable({ c, names }: { c: PurchaseComparison; names: Record<number, string> }) {
  return (
    <Shell note="The weighted-average cost of each product changes from the moment you save. Earlier sales keep the cost they were made at.">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Purchase lines, original against replacement</caption>
        <thead>
          <tr className={HEAD}>
            <th scope="col" className="px-2 py-2 text-left">Product</th>
            <th scope="col" className="px-2 py-2 text-right">Units (original)</th>
            <th scope="col" className="px-2 py-2 text-right">Units (new)</th>
            <th scope="col" className="px-2 py-2 text-right">Line total (original)</th>
            <th scope="col" className="px-2 py-2 text-right">Line total (new)</th>
          </tr>
        </thead>
        <tbody>
          {c.lines.map((l, i) => (
            <tr key={`${l.productId}-${i}`} className="border-b border-slate-100">
              <th scope="row" className="px-2 py-2 text-left font-medium text-slate-700">{names[l.productId] ?? `Product #${l.productId}`}</th>
              <td className="num px-2 py-2 text-right">{l.originalQty}</td>
              <td className={`num px-2 py-2 text-right ${l.originalQty !== l.replacementQty ? HILITE : ''}`}>{l.replacementQty}</td>
              <td className="px-2 py-2 text-right"><Money cents={l.originalLineTotalCents} /></td>
              <td className={`px-2 py-2 text-right ${l.originalLineTotalCents !== l.replacementLineTotalCents ? HILITE : ''}`}><Money cents={l.replacementLineTotalCents} /></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-slate-300 font-semibold">
            <th scope="row" className="px-2 py-2 text-left">Total paid</th>
            <td colSpan={2} />
            <td className="px-2 py-2 text-right"><Money cents={c.originalTotalCents} /></td>
            <td className="px-2 py-2 text-right">
              <Money cents={c.replacementTotalCents} />{' '}
              <span className="text-xs font-normal text-slate-500">({c.differenceTotalCents > 0 ? '+' : ''}<Money cents={c.differenceTotalCents} />)</span>
            </td>
          </tr>
        </tfoot>
      </table>
    </Shell>
  );
}

function GoodsTable({ c }: { c: GoodsComparison }) {
  return (
    <Shell
      note="The goods leave stock at the weighted-average cost at the moment you save, so the cost can differ from the original even when the quantity is the same."
      amber={c.differenceCents !== 0}>
      <table className="w-full border-collapse text-sm">
        <MoneyHead />
        <tbody><Row label="Cost of the goods taken" original={c.originalCostCents} replacement={c.replacementCostCents} diff={c.differenceCents} /></tbody>
      </table>
    </Shell>
  );
}

function PrintTable({ c }: { c: PrintComparison }) {
  const rows: Array<{ label: string; o: number; r: number; d: number }> = [];
  if (c.originalRevenueCents !== undefined && c.replacementRevenueCents !== undefined) {
    rows.push({ label: 'Revenue', o: c.originalRevenueCents, r: c.replacementRevenueCents, d: c.revenueDifferenceCents ?? c.replacementRevenueCents - c.originalRevenueCents });
  }
  const oc = c.originalCostCents ?? c.originalCogsCents;
  const rc = c.replacementCostCents ?? c.replacementCogsCents;
  if (oc !== undefined && rc !== undefined) {
    rows.push({ label: 'Standard cost', o: oc, r: rc, d: c.costDifferenceCents ?? c.cogsDifferenceCents ?? rc - oc });
  }
  if (rows.length === 0) return null;
  const costChanged = rows.some((x) => x.label === 'Standard cost' && x.d !== 0);
  return (
    <Shell note="The standard cost per page is the service type's cost when you save, so it can differ from the original sale." amber={costChanged}>
      <table className="w-full border-collapse text-sm">
        <MoneyHead />
        <tbody>{rows.map((x) => <Row key={x.label} label={x.label} original={x.o} replacement={x.r} diff={x.d} />)}</tbody>
      </table>
    </Shell>
  );
}

function CommissionTable({ c }: { c: CommissionComparison }) {
  const rateChanged = c.originalCommissionBp !== c.replacementCommissionBp;
  return (
    <Shell
      note={c.rateRecalculated
        ? `The commission was recalculated at today's rate (${rateLabel(c.replacementCommissionBp)} instead of ${rateLabel(c.originalCommissionBp)}).`
        : `The original commission rate (${rateLabel(c.originalCommissionBp)}) is kept for the corrected entry.`}
      amber={c.rateRecalculated || rateChanged}>
      <table className="w-full border-collapse text-sm">
        <MoneyHead />
        <tbody>
          <tr className="border-b border-slate-100">
            <th scope="row" className="px-2 py-2 text-left font-medium text-slate-700">Commission rate</th>
            <td className="num px-2 py-2 text-right">{rateLabel(c.originalCommissionBp)}</td>
            <td className="num px-2 py-2 text-right">{rateLabel(c.replacementCommissionBp)}</td>
            <td className={`px-2 py-2 text-right ${rateChanged ? HILITE : 'text-slate-600'}`}>{rateChanged ? 'Changed' : 'Same'}</td>
          </tr>
          <Row label="Commission" original={c.originalCommissionCents} replacement={c.replacementCommissionCents} diff={c.replacementCommissionCents - c.originalCommissionCents} />
        </tbody>
      </table>
    </Shell>
  );
}

/** @param names product names by id (purchases: the lines of the comparison only carry product ids). */
export function CorrectionComparison({ c, names = {} }: { c: AnyComparison; names?: Record<number, string> }) {
  if ('originalCommissionBp' in c) return <CommissionTable c={c} />;
  if ('originalTotalCents' in c) return <PurchaseTable c={c} names={names} />;
  if ('differenceCents' in c) return <GoodsTable c={c} />;
  if ('lines' in c && 'originalExtraCostCents' in c) return <SaleComparisonTable c={c as SaleComparison} />;
  return <PrintTable c={c as PrintComparison} />;
}
