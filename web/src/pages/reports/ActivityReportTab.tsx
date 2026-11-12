/**
 * Reports > Activity tab: Sales, Purchases, Drawings and Printing variance as sub-sections. They share the period
 * toolbar (from / to / day-or-month rows, kept in the URL) and each has its own Excel download.
 * Figures come from the server (BUSINESS_RULES 4, 6, 9, C13): revenue is net of returns dated in the period, cost =
 * automatic + extra, drawings and capital are never profit, printing supplies are never profit (variance only).
 */
import { useState } from 'react';
import { BookFilterSelect } from '../../components/FilterFields';
import { SelectField } from '../../components/SelectField';
import { formatLKR } from '../../lib/format';
import { useDrawingsReport, usePrintingReport, usePurchasesReport, useSalesReport } from '../../api/reportsOperational';
import type { PeriodQuery, StockBook } from '../../types/reportsOperational';
import { OpsDownload, OpsFilters, OpsHeadline, OpsResult, OpsTables, SectionPills, useOpsSection } from './opsParts';
import { ReportToolbar, useReportPeriod } from './shared';

const SECTIONS = ['sales', 'purchases', 'drawings', 'printing'] as const;
type Section = typeof SECTIONS[number];
const ITEMS: Array<{ key: Section; label: string }> = [
  { key: 'sales', label: 'Sales' }, { key: 'purchases', label: 'Purchases' }, { key: 'drawings', label: 'Drawings' }, { key: 'printing', label: 'Printing variance' },
];

/** Sales per period and book. */
function SalesSection({ q }: { q: PeriodQuery & { ready: boolean } }) {
  const [book, setBook] = useState<'' | StockBook>('');
  const query = { from: q.from, to: q.to, granularity: q.granularity, book };
  const report = useSalesReport(query, q.ready);
  return (
    <>
      <OpsFilters><BookFilterSelect value={book} onChange={(v) => setBook(v as '' | StockBook)} /><div className="pb-0.5"><OpsDownload path="/reports/sales" query={query} /></div></OpsFilters>
      <OpsResult query={report}>
        {(r) => (
          <>
            <OpsHeadline>Revenue {formatLKR(r.totals.revenueCents)} (after returns), cost {formatLKR(r.totals.costCents)} (automatic + extra), gross profit {formatLKR(r.totals.grossProfitCents)}.</OpsHeadline>
            <OpsTables report={r} />
          </>
        )}
      </OpsResult>
    </>
  );
}

/** Purchases per period, supplier and product, net of purchase returns. */
function PurchasesSection({ q }: { q: PeriodQuery & { ready: boolean } }) {
  const [book, setBook] = useState<'' | StockBook>('');
  const query = { from: q.from, to: q.to, granularity: q.granularity, book };
  const report = usePurchasesReport(query, q.ready);
  return (
    <>
      <OpsFilters><BookFilterSelect value={book} onChange={(v) => setBook(v as '' | StockBook)} /><div className="pb-0.5"><OpsDownload path="/reports/purchases" query={query} /></div></OpsFilters>
      <OpsResult query={report}>
        {(r) => (
          <>
            <OpsHeadline>Bought {formatLKR(r.totals.purchasesCents)}, returned {formatLKR(r.totals.returnsCents)}, net {formatLKR(r.totals.netCents)}.</OpsHeadline>
            <OpsTables report={r} />
          </>
        )}
      </OpsResult>
    </>
  );
}

/** Cash and goods drawings, with capital and transfers shown separately. */
function DrawingsSection({ q }: { q: PeriodQuery & { ready: boolean } }) {
  const [book, setBook] = useState('');
  const query = { from: q.from, to: q.to, granularity: q.granularity, book };
  const report = useDrawingsReport(query, q.ready);
  return (
    <>
      <OpsFilters>
        <SelectField label="Book" value={book} onChange={(e) => setBook(e.target.value)}>
          <option value="">All</option><option value="shop">Shop</option><option value="telecom">Telecom</option><option value="icecream">Ice Cream</option>
        </SelectField>
        <div className="pb-0.5"><OpsDownload path="/reports/drawings" query={query} /></div>
      </OpsFilters>
      <OpsResult query={report}>
        {(r) => (
          <>
            <OpsHeadline>
              Drawings {formatLKR(r.totals.totalCents)} (cash {formatLKR(r.totals.cashCents)}, goods {formatLKR(r.totals.goodsCents)}). Memo: capital in {formatLKR(r.totals.capitalCents)}, transfers {formatLKR(r.totals.transfersCents)}. None of these is profit.
            </OpsHeadline>
            <OpsTables report={r} />
          </>
        )}
      </OpsResult>
    </>
  );
}

/** Standard cost charged vs supplies spent, plus revenue and profit by service type. */
function PrintingSection({ q }: { q: PeriodQuery & { ready: boolean } }) {
  const query = { from: q.from, to: q.to, granularity: q.granularity };
  const report = usePrintingReport(query, q.ready);
  return (
    <>
      <OpsFilters><div className="pb-0.5"><OpsDownload path="/reports/printing-variance" query={query} /></div></OpsFilters>
      <OpsResult query={report}>
        {(r) => (
          <>
            <OpsHeadline>
              Standard cost charged {formatLKR(r.totals.standardCostChargedCents)}, supplies spent {formatLKR(r.totals.suppliesSpentCents)}, variance {formatLKR(r.totals.varianceCents)}. Supplies are not part of profit.
            </OpsHeadline>
            <OpsTables report={r} />
          </>
        )}
      </OpsResult>
    </>
  );
}

/** The Activity reports tab. */
export function ActivityReportTab() {
  const { period, set } = useReportPeriod();
  const [section, setSection] = useOpsSection<Section>(SECTIONS);
  const q = { from: period.from, to: period.to, granularity: period.granularity, ready: period.ready };
  return (
    <div>
      <SectionPills items={ITEMS} value={section} onChange={setSection} />
      <ReportToolbar period={period} set={set} />
      {section === 'sales' && <SalesSection q={q} />}
      {section === 'purchases' && <PurchasesSection q={q} />}
      {section === 'drawings' && <DrawingsSection q={q} />}
      {section === 'printing' && <PrintingSection q={q} />}
    </div>
  );
}
