/**
 * ImportTab: Excel opening stock import (route "/opening-stock/import").
 * Steps: 1) download the template, 2) fill it in and choose the file and date, 3) check it (a row-by-row preview that
 * saves nothing), 4) confirm. The confirm button stays disabled until the preview has zero problems.
 * API: GET /excel/opening-stock-template (plain download link), POST /excel/opening-stock/preview,
 * POST /excel/opening-stock/import (api/openingStock.ts).
 *
 * Rules reflected here (the server enforces all of them and is authoritative):
 *  - The import is ALL-OR-NOTHING: one bad row rejects the whole file, so nothing is half-imported.
 *  - The same file cannot be imported twice (the preview warns; the server refuses with IMPORT_ALREADY_COMMITTED).
 *  - R-FD: the date cannot be in the future (picker max = today); the server marks every row if it is.
 *  - Money is read exactly (Rs with up to 2 decimals); opening stock creates no purchase and no cash entry.
 */
import { useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Money } from '../../components/Money';
import { BOOK_LABEL } from '../../lib/constants';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { ApiError } from '../../api/client';
import { OPENING_TEMPLATE_URL, useImportOpeningStock, usePreviewOpeningImport } from '../../api/openingStock';
import { useBusinessDate } from '../../hooks/useBusinessDate';
import { errorBanner } from '../../lib/errors';
import { formatBytes } from '../../lib/format';
import type { ImportPreview, ImportResult } from '../../types/openingStock';
import { BatchHistory } from './BatchHistory';
import { OpeningNotice } from './OpeningNotice';

/** Same limit as the server (5 MB); checked here only to save a pointless upload. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Rows drawn in the preview table at once (a go-live file is a few hundred rows; the server limit is 5000). */
const MAX_ROWS_SHOWN = 500;

/** The Excel import tab. */
export function ImportTab() {
  const toast = useToast();
  const preview = usePreviewOpeningImport();
  const importMut = useImportOpeningStock();
  const { today, date: effDate, setDate } = useBusinessDate();

  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportPreview | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<Error | null>(null);
  // One reference per chosen file: a retried confirm is recognised by the server and cannot import twice.
  const [clientRef, setClientRef] = useState(() => crypto.randomUUID());

  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(effDate) && (!today || effDate <= today);

  /** Forgets the preview: it only describes the file and date it was made for. */
  const resetPreview = () => { setResult(null); setImportError(null); preview.reset(); };

  const onFile = (f: File | null) => {
    resetPreview();
    setFileError(null);
    setClientRef(crypto.randomUUID());
    if (f && !/\.xlsx$/i.test(f.name)) { setFile(null); setFileError('Only Excel .xlsx files can be imported. Use the template.'); return; }
    if (f && f.size > MAX_FILE_BYTES) { setFile(null); setFileError(`The file is too large (${formatBytes(f.size)}). The limit is 5 MB.`); return; }
    setFile(f);
  };

  const check = () => {
    if (!file || !dateOk) return;
    setImportError(null);
    preview.mutate({ file, businessDate: effDate }, { onSuccess: setResult });
  };

  const confirm = () => {
    if (!file || !result) return;
    setImportError(null);
    importMut.mutate({ file, businessDate: effDate, clientRef }, {
      onSuccess: (r) => {
        toast.success('Opening stock imported.');
        setConfirming(false);
        setDone(r);
        setResult(null);
        setFile(null);
        if (fileInput.current) fileInput.current.value = '';
      },
      onError: (e) => {
        setImportError(e);
        // The server found a problem the preview did not (e.g. the catalogue changed): show the fresh result.
        if (e instanceof ApiError && e.code === 'IMPORT_HAS_ERRORS') { setConfirming(false); check(); }
      },
    });
  };

  const startAnother = () => { setDone(null); resetPreview(); setFile(null); setClientRef(crypto.randomUUID()); if (fileInput.current) fileInput.current.value = ''; };

  const clean = result !== null && result.summary.failed === 0 && result.summary.total > 0 && !result.alreadyCommitted;
  const rows = result ? (onlyProblems ? result.rows.filter((r) => r.status === 'error') : result.rows) : [];
  const shownRows = rows.slice(0, MAX_ROWS_SHOWN);
  const dateError = preview.error instanceof ApiError ? preview.error.fields.businessDate : undefined;

  return (
    <>
      <OpeningNotice />

      {done ? (
        <Card title="Import finished">
          <div className="space-y-3 text-sm">
            <p className="rounded-lg bg-brand-50 p-3 text-brand-900" role="status">
              Imported <strong>{done.summary.ok}</strong> product{done.summary.ok === 1 ? '' : 's'} with a total stock value of{' '}
              <Money cents={done.summary.totalValueCents} className="font-semibold" />, dated {done.batch.businessDate} (batch #{done.batch.id}).
            </p>
            <p className="text-slate-600">No purchase and no cash payment was recorded. You can see the batch below, and void it there if it was a mistake.</p>
            <Button onClick={startAnother}>Import another file</Button>
          </div>
        </Card>
      ) : (
        <Card title="Import from Excel">
          <ol className="space-y-5 text-sm text-slate-700">
            <li>
              <p className="mb-2 font-medium text-slate-900">1. Download the template</p>
              <p className="mb-2 text-slate-600">
                It lists every active stock product (SKU and name) on the "Products" sheet. Fill in one row per product on
                the "Opening stock" sheet: SKU, Quantity, and either the Unit cost or the Total value. Delete the example row.
              </p>
              {/* A plain link: the server answers with a file attachment, so the browser downloads it. */}
              <a
                href={OPENING_TEMPLATE_URL}
                download
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50"
              >
                <Download size={16} aria-hidden="true" /> Download template (.xlsx)
              </a>
            </li>
            <li>
              <p className="mb-2 font-medium text-slate-900">2. Choose your file and the date</p>
              <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="opening-file" className="mb-1 block text-sm font-medium text-slate-700">Excel file (.xlsx, up to 5 MB)</label>
                  <input
                    id="opening-file"
                    ref={fileInput}
                    type="file"
                    accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-4 file:py-2 file:text-sm file:font-medium"
                    onChange={(e) => onFile(e.target.files?.[0] ?? null)}
                  />
                  {fileError && <p role="alert" className="mt-1 text-sm text-red-600">{fileError}</p>}
                </div>
                <TextField label="Date" type="date" value={effDate} max={today || undefined}
                  onChange={(e) => { setDate(e.target.value); resetPreview(); }} error={dateError} hint="Usually the day you start using the system. Not later than today." />
              </div>
            </li>
            <li>
              <p className="mb-2 font-medium text-slate-900">3. Check the file</p>
              <Button onClick={check} disabled={!file || !dateOk} loading={preview.isPending}>Check file</Button>
              <span className="ml-3 text-slate-500">Nothing is saved until you confirm in step 4.</span>
              {preview.isError && !dateError && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-red-700">{errorBanner(preview.error)}</p>}
            </li>

            {result && (
              <li>
                <p className="mb-2 font-medium text-slate-900">4. Review and confirm</p>
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <Badge tone="neutral">{result.summary.total} rows</Badge>
                  <Badge tone="brand">{result.summary.ok} ok</Badge>
                  <Badge tone={result.summary.failed > 0 ? 'red' : 'neutral'}>{result.summary.failed} with problems</Badge>
                  <span>Value of ok rows: <Money cents={result.summary.totalValueCents} className="font-semibold" /></span>
                  <label className="ml-auto inline-flex items-center gap-2">
                    <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
                    Show only rows with problems
                  </label>
                </div>
                {result.alreadyCommitted && (
                  <p role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-red-700">
                    This exact file has already been imported. To import it again, void the earlier batch first (see the list below).
                  </p>
                )}
                {result.summary.failed > 0 && (
                  <p role="alert" className="mb-3 rounded-lg bg-amber-50 p-3 text-amber-900">
                    The import is all-or-nothing: fix the rows below in your Excel file, save it, and choose it again. Nothing has been saved.
                  </p>
                )}
                <div className="max-h-[28rem] overflow-auto rounded-lg border border-slate-200">
                  <table className="w-full min-w-[44rem] border-collapse text-sm">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr className="border-b border-slate-200 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        <th scope="col" className="px-3 py-2 text-left">Row</th>
                        <th scope="col" className="px-3 py-2 text-left">SKU</th>
                        <th scope="col" className="px-3 py-2 text-left">Product</th>
                        <th scope="col" className="px-3 py-2 text-left">Category</th>
                        <th scope="col" className="px-3 py-2 text-left">Book</th>
                        <th scope="col" className="px-3 py-2 text-right">Qty</th>
                        <th scope="col" className="px-3 py-2 text-right">Unit cost</th>
                        <th scope="col" className="px-3 py-2 text-right">Value</th>
                        <th scope="col" className="px-3 py-2 text-left">Check</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownRows.map((r) => (
                        <tr key={r.rowNo} className={`border-b border-slate-100 align-top ${r.status === 'error' ? 'bg-red-50/60' : ''}`}>
                          <td className="num px-3 py-2">{r.rowNo}</td>
                          <td className="px-3 py-2">{r.sku || '—'}</td>
                          <td className="px-3 py-2">{r.productName || '—'}</td>
                          <td className="px-3 py-2">{r.categoryName || '—'}</td>
                          <td className="px-3 py-2">{r.book ? BOOK_LABEL[r.book] : '—'}</td>
                          <td className="num px-3 py-2 text-right">{r.qty ?? '—'}</td>
                          <td className="px-3 py-2 text-right">{r.unitCostCents !== null ? <Money cents={r.unitCostCents} /> : '—'}</td>
                          <td className="px-3 py-2 text-right">{r.totalValueCents !== null ? <Money cents={r.totalValueCents} /> : '—'}</td>
                          <td className="px-3 py-2">
                            {r.status === 'ok' ? <Badge tone="brand">OK</Badge> : (
                              <ul className="space-y-1">
                                {r.issues.map((i, k) => <li key={k} className="text-red-700">{i.message}</li>)}
                              </ul>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {rows.length > MAX_ROWS_SHOWN && (
                  <p className="mt-2 text-xs text-slate-500">Showing the first {MAX_ROWS_SHOWN} of {rows.length} rows. Tick "Show only rows with problems" to see what needs fixing.</p>
                )}
                <div className="mt-4 flex justify-end">
                  <Button onClick={() => setConfirming(true)} disabled={!clean}>Import {result.summary.ok} product{result.summary.ok === 1 ? '' : 's'}</Button>
                </div>
              </li>
            )}
          </ol>
        </Card>
      )}

      <ConfirmDialog
        open={confirming}
        title="Import this opening stock?"
        confirmLabel="Import opening stock"
        loading={importMut.isPending}
        error={errorBanner(importError)}
        onConfirm={confirm}
        onClose={() => { if (!importMut.isPending) { setConfirming(false); setImportError(null); } }}
      >
        <p>
          {result?.summary.ok ?? 0} product{result?.summary.ok === 1 ? '' : 's'}, total value <Money cents={result?.summary.totalValueCents ?? 0} className="font-semibold" />, dated {effDate}.
        </p>
        <p>This adds stock only. No purchase and no cash payment is recorded. The whole file is imported together or not at all.</p>
      </ConfirmDialog>

      <BatchHistory />
    </>
  );
}
