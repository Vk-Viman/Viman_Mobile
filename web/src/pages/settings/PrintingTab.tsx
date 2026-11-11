/**
 * Settings > Printing defaults tab (route "/settings/printing"): the default price and cost of each print type
 * (e.g. A4 black-and-white copy), later used to set up print services.
 * API: GET /settings and PUT /settings with only `printDefaults` (the whole list is replaced on save).
 * Prices and costs are typed in rupees and sent as integer cents (lib/units.ts), never as decimals.
 */
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Card } from '../../components/Card';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { MoneyInput } from '../../components/MoneyInput';
import { Spinner } from '../../components/Spinner';
import { ErrorState } from '../../components/ErrorState';
import { useToast } from '../../components/Toast';
import { useSettings, useUpdateSettings } from '../../api/settings';
import type { PrintDefault } from '../../types/api';
import { centsToRupees, rupeesToCents } from '../../lib/units';
import { errorMessage } from './formUtils';
import { ApiError } from '../../api/client';

/**
 * One editable table row. `id` is a local React key only (never sent to the server); `existing` rows come from
 * the server and their code is locked (the code identifies the print type); new rows may choose a code.
 * Amounts stay as the typed text until Save.
 */
interface Row { id: number; existing: boolean; code: string; name: string; price: string; cost: string }
type RowErrors = Partial<Record<'code' | 'name' | 'price' | 'cost', string>>;

/** Limits matching the server's validation (the server re-checks all of them). */
const MAX_CENTS = 100000000;
const CODE_RE = /^[A-Z0-9_]{1,20}$/;
const MAX_ROWS = 30;
const MAX_NAME_LENGTH = 60;
/** Local ids for new rows start high so they can never collide with the ids given to loaded rows (0..n). */
const FIRST_NEW_ROW_ID = 1000;

/** Converts the saved list into editable rows (cents become typed-style rupee text). */
function toRows(items: PrintDefault[], startId: number): Row[] {
  return items.map((p, i) => ({ id: startId + i, existing: true, code: p.code, name: p.name, price: centsToRupees(p.priceCents), cost: centsToRupees(p.costCents) }));
}
/** A fingerprint of the editable content, used to tell whether anything changed ("dirty" check). */
const sig = (rows: Row[]) => JSON.stringify(rows.map((r) => [r.code, r.name, r.price.trim(), r.cost.trim()]));

/** Error message for a typed rupee amount, or undefined when valid. */
function money(s: string): string | undefined {
  const c = rupeesToCents(s);
  if (c === null) return 'Enter an amount like 15 or 15.50.';
  if (c > MAX_CENTS) return 'Too large.';
  return undefined;
}

/** Validates every row (plus the row count); returns per-row messages and an optional message for the whole table. */
function validate(rows: Row[]): { rows: RowErrors[]; top?: string } {
  const out: RowErrors[] = rows.map((r) => {
    const e: RowErrors = {};
    if (!CODE_RE.test(r.code)) e.code = 'Use A-Z, 0-9 and _ (1-20 characters).';
    const n = r.name.trim();
    if (n.length < 1 || n.length > MAX_NAME_LENGTH) e.name = `Name must be 1-${MAX_NAME_LENGTH} characters.`;
    const p = money(r.price); if (p) e.price = p;
    const c = money(r.cost); if (c) e.cost = c;
    return e;
  });
  // Codes must be unique: flag the second and later occurrences.
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    if (seen.has(r.code)) { const e = out[i]; if (e && !e.code) e.code = 'Code must be unique.'; }
    seen.add(r.code);
  });
  let top: string | undefined;
  if (rows.length < 1) top = 'Keep at least one row.';
  else if (rows.length > MAX_ROWS) top = `No more than ${MAX_ROWS} rows.`;
  return { rows: out, top };
}

/** The editable table form. `initial` is the saved list. */
function PrintForm({ initial }: { initial: PrintDefault[] }) {
  const nextId = useRef(FIRST_NEW_ROW_ID);
  const [rows, setRows] = useState<Row[]>(() => toRows(initial, 0));
  // Fingerprint of the rows as first loaded; compared with the current rows to enable/disable Save.
  const initSig = useRef(sig(rows)).current;
  // Errors are hidden until the first Save attempt.
  const [touched, setTouched] = useState(false);
  const update = useUpdateSettings();
  const toast = useToast();

  const dirty = sig(rows) !== initSig;
  const local = validate(rows);
  const srv = update.error instanceof ApiError ? update.error.fields : {};
  // Server field errors use the path "printDefaults.<row index>.<field>".
  const serverFor = (i: number, f: 'code' | 'name' | 'priceCents' | 'costCents') => srv[`printDefaults.${i}.${f}`];

  // Editing anything clears the previous server error.
  const patch = (id: number, p: Partial<Row>) => { update.reset(); setRows(rows.map((r) => (r.id === id ? { ...r, ...p } : r))); };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (local.top || local.rows.some((r) => Object.keys(r).length > 0)) return;
    // The text was validated above, so the conversions to cents cannot be null here ("?? 0" only satisfies the type).
    const body: PrintDefault[] = rows.map((r) => ({
      code: r.code,
      name: r.name.trim(),
      priceCents: rupeesToCents(r.price) ?? 0,
      costCents: rupeesToCents(r.cost) ?? 0,
    }));
    update.mutate({ printDefaults: body }, { onSuccess: () => toast.success('Printing defaults saved.'), onError: (er) => toast.error(errorMessage(er)) });
  };

  return (
    <form onSubmit={submit} noValidate>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <th scope="col" className="w-40 px-2 py-2 text-left font-semibold">Code</th>
              <th scope="col" className="px-2 py-2 text-left font-semibold">Name</th>
              <th scope="col" className="w-32 px-2 py-2 text-left font-semibold">Price (Rs)</th>
              <th scope="col" className="w-32 px-2 py-2 text-left font-semibold">Cost (Rs)</th>
              <th scope="col" className="w-12 px-2 py-2"><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const le = touched ? local.rows[i] ?? {} : {};
              return (
                <tr key={r.id} className="border-b border-slate-100 align-top">
                  <td className="px-2 py-2">
                    {r.existing ? (
                      <span className="inline-flex min-h-10 items-center font-mono text-xs text-slate-700">{r.code}</span>
                    ) : (
                      <TextField label={`Code, row ${i + 1}`} hideLabel value={r.code} onChange={(e) => patch(r.id, { code: e.target.value.toUpperCase() })} error={le.code ?? serverFor(i, 'code')} maxLength={20} />
                    )}
                  </td>
                  <td className="px-2 py-2"><TextField label={`Name, row ${i + 1}`} hideLabel value={r.name} onChange={(e) => patch(r.id, { name: e.target.value })} error={le.name ?? serverFor(i, 'name')} /></td>
                  <td className="px-2 py-2"><MoneyInput label={`Price, row ${i + 1}`} hideLabel value={r.price} onChange={(s) => patch(r.id, { price: s })} error={le.price ?? serverFor(i, 'priceCents')} /></td>
                  <td className="px-2 py-2"><MoneyInput label={`Cost, row ${i + 1}`} hideLabel value={r.cost} onChange={(s) => patch(r.id, { cost: s })} error={le.cost ?? serverFor(i, 'costCents')} /></td>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      aria-label={`Remove ${r.code || 'row ' + (i + 1)}`}
                      onClick={() => { update.reset(); setRows(rows.filter((x) => x.id !== r.id)); }}
                      className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 size={18} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {touched && local.top && <p role="alert" className="mt-2 text-sm text-red-600">{local.top}</p>}
      {/* A general server error (one with no field details) is shown here; field errors appear in their cells. */}
      {update.isError && !Object.keys(srv).length && <p role="alert" className="mt-2 text-sm text-red-600">{update.error.message}</p>}
      <div className="mt-4 flex items-center justify-between gap-3">
        <Button variant="secondary" disabled={rows.length >= MAX_ROWS} onClick={() => { update.reset(); setRows([...rows, { id: nextId.current++, existing: false, code: '', name: '', price: '', cost: '' }]); }}>
          <Plus size={16} aria-hidden="true" /> Add row
        </Button>
        <Button type="submit" disabled={!dirty} loading={update.isPending}>Save changes</Button>
      </div>
    </form>
  );
}

/** The tab: explanation, then loading spinner, error with retry, or the form (re-created after each save). */
export function PrintingTab() {
  const q = useSettings();
  return (
    <Card title="Printing defaults">
      <p className="mb-4 text-sm text-slate-500">Default prices and costs per print type. They are used in Phase 7 to set up print services.</p>
      {q.isPending ? <Spinner label="Loading" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
        <PrintForm key={q.data.updatedAt ?? 'none'} initial={q.data.printDefaults} />
      )}
    </Card>
  );
}
