/**
 * Reports > Backdated tab: every record whose business date is earlier than the day (Sri Lanka time) it was saved
 * (BUSINESS_RULES 12), with the record type, amount, both dates and the audit entry number. Filters: period (business
 * dates) and book; the list is paged by the server. Read-only.
 */
import { useState } from 'react';
import { Card } from '../../components/Card';
import { Pager } from '../../components/Pager';
import { SelectField } from '../../components/SelectField';
import { useBackdatedReport } from '../../api/reportsOperational';
import type { OpsBook } from '../../types/reportsOperational';
import { OpsDownload, OpsFilters, OpsHeadline, OpsResult } from './opsParts';
import { ReportTableView, ReportToolbar, useReportPeriod } from './shared';

const PAGE = 50;

/** The Backdated entries tab. */
export function BackdatedReportTab() {
  const { period, set } = useReportPeriod();
  const [book, setBook] = useState<'' | OpsBook>('');
  const [page, setPage] = useState(0);
  const query = { from: period.from, to: period.to, book };
  const report = useBackdatedReport({ ...query, limit: PAGE, offset: page * PAGE }, period.ready);
  return (
    <div>
      <ReportToolbar period={period} set={(p) => { setPage(0); set(p); }} showGranularity={false} />
      <OpsFilters>
        <SelectField label="Book" value={book} onChange={(e) => { setPage(0); setBook(e.target.value as '' | OpsBook); }}>
          <option value="">All</option><option value="shop">Shop</option><option value="telecom">Telecom</option><option value="icecream">Ice Cream</option>
        </SelectField>
        <div className="pb-0.5"><OpsDownload path="/reports/backdated" query={query} /></div>
      </OpsFilters>
      <OpsResult query={report}>
        {(r) => (
          <>
            <OpsHeadline>
              {r.total} backdated entr{r.total === 1 ? 'y' : 'ies'}{r.byType.length > 0 && ': '}{r.byType.map((t) => `${t.recordLabel} ${t.count}`).join(', ')}
            </OpsHeadline>
            <Card><ReportTableView table={r.table} /></Card>
            <Pager page={page} total={r.total} limit={PAGE} noun="entries" onPage={setPage} />
          </>
        )}
      </OpsResult>
    </div>
  );
}
