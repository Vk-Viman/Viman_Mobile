/**
 * Settings > Printing defaults tab (route "/settings/printing"): READ-ONLY reference.
 *
 * Nothing in the app reads `settings.printDefaults`: the real print prices and standard costs live in
 * Services > Service types (route "/services/types"). This tab therefore says so, links there, and shows the stored
 * initial list as plain text, labelled as kept for reference only. The settings API and the stored data are untouched.
 * API: GET /settings (api/settings.ts).
 */
import { Link } from 'react-router';
import { Card } from '../../components/Card';
import { Money } from '../../components/Money';
import { Spinner } from '../../components/Spinner';
import { ErrorState } from '../../components/ErrorState';
import { useSettings } from '../../api/settings';
import type { PrintDefault } from '../../types/api';

/** The stored list as a read-only table. */
function ReferenceList({ items }: { items: PrintDefault[] }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-slate-900">Initial price list (kept for reference; not used for sales)</h3>
      {items.length === 0 ? (
        <p className="text-sm text-slate-500">The stored list is empty.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <th scope="col" className="px-2 py-2 text-left font-semibold">Code</th>
                <th scope="col" className="px-2 py-2 text-left font-semibold">Name</th>
                <th scope="col" className="px-2 py-2 text-right font-semibold">Price</th>
                <th scope="col" className="px-2 py-2 text-right font-semibold">Cost</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.code} className="border-b border-slate-100">
                  <td className="px-2 py-2 font-mono text-xs text-slate-700">{p.code}</td>
                  <td className="px-2 py-2 text-slate-700">{p.name}</td>
                  <td className="px-2 py-2 text-right"><Money cents={p.priceCents} /></td>
                  <td className="px-2 py-2 text-right"><Money cents={p.costCents} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** The tab: where print prices really live, then the stored list (loading spinner / error with retry first). */
export function PrintingTab() {
  const q = useSettings();
  return (
    <Card title="Printing defaults">
      <p className="mb-4 text-sm text-slate-700">
        Service prices and standard costs are managed under{' '}
        <Link to="/services/types" className="font-medium text-blue-700 underline">Services &rarr; Service types</Link>.
        Changing the list below does nothing, so it cannot be edited here.
      </p>
      {q.isPending ? <Spinner label="Loading" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
        <ReferenceList items={q.data.printDefaults} />
      )}
    </Card>
  );
}
