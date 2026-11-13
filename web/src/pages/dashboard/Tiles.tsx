/**
 * Dashboard tiles: today / this month (sales and profit per segment), cash per book, stock, closings and backup.
 * Presentation only: every figure is shown exactly as the server sent it (integer cents); nothing is calculated here.
 * Negative values are red (the Money component) and also carry a minus sign, so a loss never relies on colour alone.
 */
import { ExternalBackupStatus } from './ExternalBackupStatus';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Card } from '../../components/Card';
import { Money } from '../../components/Money';
import { formatDateTime } from '../../lib/format';
import type { Dashboard, PeriodTile } from '../../types/dashboard';
import { COMBINED_COLOR, SEGMENTS, SEGMENT_COLOR, SEGMENT_LABEL } from './segments';

/** A coloured dot + name (colour is never the only cue: the name is written). */
function SegmentName({ color, name }: { color: string; name: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
      {name}
    </span>
  );
}

/** "Today" or "This month": sales and profit for the business and for each segment. */
export function PeriodCard({ title, subtitle, tile }: { title: string; subtitle: string; tile: PeriodTile }) {
  return (
    <Card title={title}>
      <p className="-mt-2 mb-3 text-xs text-slate-500">{subtitle}</p>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <caption className="sr-only">{title}: sales and profit</caption>
          <thead>
            <tr className="border-b border-slate-200 text-slate-500">
              <th scope="col" className="py-2 pr-3 text-left font-medium">Segment</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Sales</th>
              <th scope="col" className="py-2 pl-3 text-right font-medium">Profit</th>
            </tr>
          </thead>
          <tbody>
            {SEGMENTS.map((s) => (
              <tr key={s} className="border-b border-slate-100">
                <th scope="row" className="py-2 pr-3 text-left font-normal"><SegmentName color={SEGMENT_COLOR[s]} name={SEGMENT_LABEL[s]} /></th>
                <td className="px-3 py-2 text-right"><Money cents={tile.bySegment[s].salesCents} /></td>
                <td className="py-2 pl-3 text-right"><Money cents={tile.bySegment[s].profitCents} /></td>
              </tr>
            ))}
            <tr className="font-semibold">
              <th scope="row" className="py-2 pr-3 text-left"><SegmentName color={COMBINED_COLOR} name="Combined" /></th>
              <td className="px-3 py-2 text-right"><Money cents={tile.salesCents} /></td>
              <td className="py-2 pl-3 text-right"><Money cents={tile.profitCents} /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** Cash per book; the Ice Cream funds are listed apart, with an "= book" check. */
export function CashCard({ cash }: { cash: Dashboard['cash'] }) {
  return (
    <Card title="Cash in each book">
      <dl className="text-sm">
        {cash.books.map((b) => (
          <div key={b.book} className="border-b border-slate-100 py-2 last:border-0">
            <div className="flex items-center justify-between gap-3">
              <dt><SegmentName color={SEGMENT_COLOR[b.book]} name={SEGMENT_LABEL[b.book]} /></dt>
              <dd className="font-medium"><Money cents={b.balanceCents} /></dd>
            </div>
            {b.funds && (
              <div className="mt-1 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                <p className="mb-1 font-medium text-slate-700">Ice Cream funds (not profit)</p>
                <ul className="space-y-0.5">
                  <li className="flex justify-between"><span>Cost</span><Money cents={b.funds.cost} /></li>
                  <li className="flex justify-between"><span>Electricity</span><Money cents={b.funds.electricity} /></li>
                  <li className="flex justify-between"><span>Profit fund</span><Money cents={b.funds.profit} /></li>
                </ul>
                <p className="mt-1.5">
                  {b.fundsMatchBook
                    ? <Badge tone="brand">Funds add up to the book</Badge>
                    : <Badge tone="red">Funds do not match the book</Badge>}
                </p>
              </div>
            )}
          </div>
        ))}
        <div className="flex items-center justify-between pt-2 font-semibold"><dt>All books</dt><dd><Money cents={cash.totalCents} /></dd></div>
      </dl>
    </Card>
  );
}

/** Stock value and the products at or below their minimum. */
export function StockCard({ stock }: { stock: Dashboard['stock'] }) {
  return (
    <Card title="Stock">
      <p className="text-sm text-slate-500">Stock value</p>
      <p className="text-2xl font-semibold"><Money cents={stock.valueCents} /></p>
      <p className="mt-3 text-sm">
        {stock.lowStockCount === 0
          ? <Badge tone="brand">No low-stock products</Badge>
          : <Badge tone="amber">{stock.lowStockCount} low-stock {stock.lowStockCount === 1 ? 'product' : 'products'}</Badge>}
      </p>
      {stock.lowStock.length > 0 && (
        <ul className="mt-2 divide-y divide-slate-100 text-sm">
          {stock.lowStock.map((p) => (
            <li key={p.productId} className="flex items-center justify-between gap-3 py-1.5">
              <span className="truncate">{p.name}</span>
              <span className="num whitespace-nowrap text-slate-600">{p.qty} left (min {p.reorderLevel})</span>
            </li>
          ))}
        </ul>
      )}
      {stock.negativeOrWarning.map((w) => (
        <p key={w.code} className="mt-2 flex items-start gap-2 text-xs text-amber-800"><AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />{w.message}</p>
      ))}
    </Card>
  );
}

/** Last closed day per book and the recent days still waiting to be closed. */
export function ClosingsCard({ closings }: { closings: Dashboard['closings'] }) {
  const behind = closings.openDaysBehind.reduce((n, b) => n + b.dates.length, 0);
  return (
    <Card title="Daily closings">
      {behind === 0 ? (
        <p className="mb-2 flex items-center gap-2 text-sm text-brand-700"><CheckCircle2 size={16} aria-hidden="true" />No recent days waiting to be closed.</p>
      ) : (
        <p className="mb-2 text-sm text-amber-800">{behind} {behind === 1 ? 'day is' : 'days are'} not closed yet.</p>
      )}
      <dl className="text-sm">
        {closings.openDaysBehind.map((b) => (
          <div key={b.book} className="border-b border-slate-100 py-2 last:border-0">
            <div className="flex items-center justify-between gap-3">
              <dt><SegmentName color={SEGMENT_COLOR[b.book]} name={SEGMENT_LABEL[b.book]} /></dt>
              <dd className="num text-slate-600">Last closed: {closings.lastClosedByBook[b.book] ?? 'never'}</dd>
            </div>
            {b.dates.length > 0 && <p className="mt-1 text-xs text-amber-800">Not closed: <span className="num">{b.dates.join(', ')}</span></p>}
          </div>
        ))}
      </dl>
    </Card>
  );
}

/** Newest backup and how old it is. */
export function BackupCard({ backup }: { backup: Dashboard['backup'] }) {
  return (
    <Card title="Backup">
      {backup.status === 'none' ? (
        <p className="flex items-center gap-2 text-sm text-amber-800"><AlertTriangle size={16} aria-hidden="true" />No backup has been made yet.</p>
      ) : (
        <>
          <p>{backup.status === 'ok' ? <Badge tone="brand">Up to date</Badge> : <Badge tone="amber">Old backup</Badge>}</p>
          <p className="mt-2 text-sm text-slate-700">Newest backup: <span className="num">{formatDateTime(backup.latestAt)}</span></p>
          <p className="text-xs text-slate-500">{backup.ageHours === null ? '' : `${backup.ageHours} hours ago`}</p>
        </>
      )}
      <ExternalBackupStatus external={backup.external} />
    </Card>
  );
}
