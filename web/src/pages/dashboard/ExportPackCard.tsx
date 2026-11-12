/**
 * ExportPackCard: pick a period and download the Excel pack (GET /reports/export-pack). The default period is this month
 * (the 1st .. the dashboard date). The link is disabled with a message when the dates are impossible or longer than 3,660 days
 * (the server checks again and is the authority).
 */
import { Download } from 'lucide-react';
import { useState } from 'react';
import { Card } from '../../components/Card';
import { exportPackUrl } from '../../api/dashboard';

const MAX_DAYS = 3660;
const input = 'mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm';

/** @param asOf the dashboard date (YYYY-MM-DD); the default range is the 1st of its month up to it. */
export function ExportPackCard({ asOf }: { asOf: string }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const f = from || `${asOf.slice(0, 8)}01`;
  const t = to || asOf;
  const days = (Date.parse(t) - Date.parse(f)) / 86_400_000 + 1;
  const problem = !f || !t || Number.isNaN(days) ? 'Pick both dates.' : days < 1 ? 'The start date cannot be after the end date.' : days > MAX_DAYS ? `Pick at most ${MAX_DAYS} days.` : '';
  return (
    <Card title="Excel export pack">
      <p className="mb-3 text-sm text-slate-600">One Excel file with profit and loss, Ice Cream funds, cash books, stock, sales, purchases, drawings and printing for the period.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-slate-600">From<input type="date" className={input} value={f} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="text-sm text-slate-600">To<input type="date" className={input} value={t} onChange={(e) => setTo(e.target.value)} /></label>
        {problem ? (
          <span role="status" className="text-sm text-red-700">{problem}</span>
        ) : (
          <a href={exportPackUrl(f, t)} download
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
            <Download size={16} aria-hidden="true" /> Download Excel pack
          </a>
        )}
      </div>
    </Card>
  );
}
