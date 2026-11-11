/**
 * Settings > Audit log tab (route "/settings/audit"): a read-only history of every change made in the system
 * (who/what/when, with the values before and after). The server keeps this log append-only, so entries can never
 * be edited or deleted from here.
 * API: GET /audit-logs with cursor paging (api/auditLogs.ts). Times are shown in Asia/Colombo.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Card } from '../../components/Card';
import { Button } from '../../components/Button';
import { DataTable } from '../../components/DataTable';
import type { Column } from '../../components/DataTable';
import { Spinner } from '../../components/Spinner';
import { ErrorState } from '../../components/ErrorState';
import { TextField } from '../../components/TextField';
import { useAuditLogs } from '../../api/auditLogs';
import type { AuditLog } from '../../types/api';
import { formatDateTime } from '../../lib/format';

/** A titled, scrollable box showing a value as formatted JSON ("none" when there is no value). */
function Json({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      <pre className="max-h-72 overflow-auto rounded-lg border border-slate-200 bg-white p-3 text-xs">
        {value === null || value === undefined ? 'none' : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

/** The tab: entity filter, the log table with expandable before/after details, and a "Load more" button. */
export function AuditTab() {
  // `entityInput` is what is typed in the box; `entity` is the applied filter (changes only when Apply is pressed,
  // so a request is not sent on every keystroke).
  const [entityInput, setEntityInput] = useState('');
  const [entity, setEntity] = useState('');
  // Ids of the rows whose details are expanded.
  const [open, setOpen] = useState<Set<number>>(new Set());
  const q = useAuditLogs(entity);

  const toggle = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  // The infinite query returns pages; flatten them into one list for the table.
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];

  const columns: Column<AuditLog>[] = [
    {
      key: 'expand', header: '',
      render: (r) => (
        <button
          type="button"
          onClick={() => toggle(r.id)}
          aria-expanded={open.has(r.id)}
          aria-label={`${open.has(r.id) ? 'Hide' : 'Show'} details for entry ${r.id}`}
          className="rounded p-1 text-slate-500 hover:bg-slate-100"
        >
          {open.has(r.id) ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </button>
      ),
    },
    { key: 'at', header: 'Time (Colombo)', render: (r) => <span className="num whitespace-nowrap">{formatDateTime(r.at)}</span> },
    { key: 'entity', header: 'Entity', render: (r) => r.entity },
    { key: 'entityId', header: 'Entity ID', render: (r) => <span className="font-mono text-xs">{r.entityId}</span> },
    { key: 'action', header: 'Action', render: (r) => r.action },
    { key: 'note', header: 'Note', render: (r) => r.note ?? '—' },
  ];

  return (
    <Card title="Audit log">
      <form
        className="mb-4 flex flex-wrap items-end gap-2"
        onSubmit={(e) => { e.preventDefault(); setEntity(entityInput.trim()); setOpen(new Set()); }}
      >
        <TextField label="Filter by entity" placeholder="e.g. settings" value={entityInput} onChange={(e) => setEntityInput(e.target.value)} className="w-64" />
        <Button type="submit" variant="secondary">Apply</Button>
        {entity && <Button variant="ghost" onClick={() => { setEntityInput(''); setEntity(''); }}>Clear</Button>}
      </form>
      {q.isPending ? <Spinner label="Loading" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            emptyTitle="No audit entries"
            emptyHint={entity ? 'No entries match this entity.' : 'Changes you make will be listed here.'}
            renderExtra={(r) =>
              open.has(r.id) ? (
                <div className="grid gap-3 md:grid-cols-2">
                  <Json title="Before" value={r.before} />
                  <Json title="After" value={r.after} />
                </div>
              ) : null
            }
          />
          {q.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button variant="secondary" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Load more</Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
