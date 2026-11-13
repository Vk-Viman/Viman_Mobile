// Phase 13, database level: migration 011 (opening_stock_batches, import_runs, import_issues) - raw SQL on in-memory SQLite.
// Protects R-FD (no future-dated batch), R1 (a batch is never deleted or edited, only posted -> void), section 12 (client_ref
// uniqueness, append-only import audit) and section 3 (opening movements use the engine and update the cache).
// Organised as: migration present, CHECK constraints, future date, immutability, no delete, import tables append-only,
// the ledger/cache link for `opening` movements.

import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { loadMigrations } from '../db/migrate.ts';
import { memDb, pool, scalar, sqlProduct } from './helpers/inventory.ts';
import { receiveStock } from '../services/inventory.service.ts';

const conns: DatabaseSync[] = [];
afterEach(() => { for (const c of conns.splice(0)) c.close(); });
const db = () => memDb(conns);

let n = 0;
const uniq = () => `p13-${n++}-${Math.random().toString(36).slice(2, 8)}`;
const colombo = (offsetDays = 0) => new Date(Date.now() + 330 * 60000 + offsetDays * 86400000).toISOString().slice(0, 10);

/** Inserts a batch by raw SQL (manual unless o.source = 'excel'). */
function batch(c: DatabaseSync, o: Record<string, any> = {}): number {
  const source = o.source ?? 'manual';
  return Number(c.prepare(
    `INSERT INTO opening_stock_batches (business_date, source, file_name, row_count, total_value_cents, status, voided_at, void_reason, notes, client_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.date ?? colombo(), source, 'file' in o ? o.file : (source === 'excel' ? 'f.xlsx' : null), o.rows ?? 1, o.total ?? 1000,
    o.status ?? 'posted', o.voidedAt ?? null, o.voidReason ?? null, o.notes ?? '', o.ref ?? uniq()).lastInsertRowid);
}
function run(c: DatabaseSync, o: Record<string, any> = {}): number {
  return Number(c.prepare(
    `INSERT INTO import_runs (kind, file_name, file_sha256, business_date, mode, status, rows_total, rows_ok, rows_failed, batch_id)
     VALUES ('opening_stock', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.file ?? 'f.xlsx', o.sha ?? 'a'.repeat(64), o.date ?? colombo(), o.mode ?? 'preview', o.status ?? 'previewed',
    o.total ?? 2, o.ok ?? 2, o.failed ?? 0, o.batch ?? null).lastInsertRowid);
}
const msg = (fn: () => unknown): string => { try { fn(); } catch (e) { return (e as Error).message; } throw new Error('expected throw'); };

describe('migration 011', () => {
  it('exists as 011_opening_stock_import.sql and creates the three tables and their triggers', () => {
    expect(loadMigrations().some((m) => m.name === '011_opening_stock_import.sql')).toBe(true);
    const c = db();
    const tables = (c.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['opening_stock_batches', 'import_runs', 'import_issues']));
    const triggers = (c.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'trg_opening_stock%' OR name LIKE 'trg_import_%')").all() as any[]).map((r) => r.name);
    expect(triggers.sort()).toEqual([
      'trg_import_issues_no_delete', 'trg_import_issues_no_update', 'trg_import_runs_no_delete', 'trg_import_runs_no_update',
      'trg_import_runs_valid_date',
      'trg_opening_stock_batches_business_date_immutable', 'trg_opening_stock_batches_day_closed', 'trg_opening_stock_batches_day_closed_void',
      'trg_opening_stock_batches_future_date',
      'trg_opening_stock_batches_immutable', 'trg_opening_stock_batches_no_delete',
      'trg_opening_stock_batches_posted_at_immutable', 'trg_opening_stock_batches_valid_date',
    ]);
  });
  it('creates no cash entry and no purchase by itself (opening stock has no cash/P&L side)', () => {
    const c = db();
    batch(c);
    expect(scalar(c, 'SELECT COUNT(*) FROM cash_entries')).toBe(0);
    expect(scalar(c, 'SELECT COUNT(*) FROM purchases')).toBe(0);
  });
});

describe('opening_stock_batches constraints', () => {
  it('accepts a valid manual and a valid excel batch; posted_at is set by the database', () => {
    const c = db();
    const a = batch(c);
    const b = batch(c, { source: 'excel' });
    expect(a).not.toBe(b);
    const row = c.prepare('SELECT posted_at, status FROM opening_stock_batches WHERE id = ?').get(a) as any;
    expect(row.status).toBe('posted');
    expect(row.posted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it('client_ref is unique', () => {
    const c = db();
    batch(c, { ref: 'same-ref-1' });
    expect(msg(() => batch(c, { ref: 'same-ref-1' }))).toMatch(/UNIQUE/);
  });
  it.each([
    ['bad source', { source: 'csv' as any }],
    ['bad date text', { date: '2026-13-40' }],
    ['date not strict', { date: '2026-1-5' }],
    ['negative row count', { rows: -1 }],
    ['negative total', { total: -1 }],
    ['bad status', { status: 'draft' }],
    ['void without reason', { status: 'void', voidedAt: '2026-01-01T00:00:00Z' }],
    ['void without time', { status: 'void', voidReason: 'x' }],
    ['posted with void reason', { voidReason: 'x' }],
    ['posted with void time', { voidedAt: '2026-01-01T00:00:00Z' }],
    ['manual with a file name', { source: 'manual', file: 'x.xlsx' }],
    ['excel without a file name', { source: 'excel', file: null }],
  ])('rejects %s', (_name, o) => {
    const c = db();
    expect(() => batch(c, o as any)).toThrow();
  });
  it('accepts a void with both time and reason', () => {
    const c = db();
    expect(() => batch(c, { status: 'void', voidedAt: '2026-01-01T00:00:00Z', voidReason: 'oops' })).not.toThrow();
  });
});

describe('R-FD on batches', () => {
  it('rejects tomorrow with FUTURE_DATE_NOT_ALLOWED; allows today and the past', () => {
    const c = db();
    expect(msg(() => batch(c, { date: colombo(1) }))).toContain('FUTURE_DATE_NOT_ALLOWED');
    expect(() => batch(c, { date: colombo(0) })).not.toThrow();
    expect(() => batch(c, { date: colombo(-400) })).not.toThrow();
  });
});

describe('immutability (R1)', () => {
  it('only posted -> void may change, and never back', () => {
    const c = db();
    const id = batch(c);
    for (const set of ['business_date', "notes", 'total_value_cents', 'row_count', "client_ref", 'source']) {
      const val = set === 'business_date' ? `'${colombo(-1)}'` : set === 'notes' || set === 'client_ref' ? "'changed'" : set === 'source' ? "'excel'" : '99999';
      expect(() => c.exec(`UPDATE opening_stock_batches SET ${set} = ${val} WHERE id = ${id}`), set).toThrow();
    }
    expect(msg(() => c.exec(`UPDATE opening_stock_batches SET business_date = '${colombo(-1)}' WHERE id = ${id}`))).toContain('BUSINESS_DATE_IMMUTABLE');
    expect(msg(() => c.exec(`UPDATE opening_stock_batches SET posted_at = '2020-01-01T00:00:00.000Z' WHERE id = ${id}`))).toContain('POSTED_AT_IMMUTABLE');
    expect(msg(() => c.exec(`UPDATE opening_stock_batches SET total_value_cents = 5 WHERE id = ${id}`))).toContain('OPENING_STOCK_BATCHES_IMMUTABLE');
    // void it
    c.exec(`UPDATE opening_stock_batches SET status = 'void', voided_at = '2026-01-01T00:00:00Z', void_reason = 'r' WHERE id = ${id}`);
    // never back to posted, never a changed reason
    expect(() => c.exec(`UPDATE opening_stock_batches SET status = 'posted', voided_at = NULL, void_reason = NULL WHERE id = ${id}`)).toThrow();
    expect(msg(() => c.exec(`UPDATE opening_stock_batches SET void_reason = 'other' WHERE id = ${id}`))).toContain('OPENING_STOCK_BATCHES_IMMUTABLE');
  });
  it('a hard delete is forbidden (RECORD_DELETE_FORBIDDEN)', () => {
    const c = db();
    const id = batch(c);
    expect(msg(() => c.exec(`DELETE FROM opening_stock_batches WHERE id = ${id}`))).toContain('RECORD_DELETE_FORBIDDEN');
    expect(scalar(c, 'SELECT COUNT(*) FROM opening_stock_batches')).toBe(1);
  });
});

describe('import_runs / import_issues are append-only', () => {
  it('accepts a preview run, a committed run (with its batch) and a rejected run', () => {
    const c = db();
    const b = batch(c, { source: 'excel' });
    expect(() => run(c)).not.toThrow();
    expect(() => run(c, { mode: 'commit', status: 'committed', batch: b, total: 3, ok: 3, failed: 0 })).not.toThrow();
    expect(() => run(c, { mode: 'commit', status: 'rejected', total: 3, ok: 2, failed: 1 })).not.toThrow();
  });
  it.each([
    ['bad kind-mode combination: preview committed', { mode: 'preview', status: 'committed' }],
    ['commit but previewed', { mode: 'commit', status: 'previewed' }],
    ['committed without a batch', { mode: 'commit', status: 'committed' }],
    ['committed with failed rows', { mode: 'commit', status: 'committed', total: 2, ok: 1, failed: 1, batch: 1 }],
    ['rejected with a batch', { mode: 'commit', status: 'rejected', batch: 1 }],
    ['counts that do not add up', { total: 5, ok: 2, failed: 1 }],
    ['short sha', { sha: 'abc' }],
    ['bad date', { date: 'nope' }],
    ['negative counts', { total: -1, ok: -1, failed: 0 }],
  ])('rejects %s', (_n, o) => {
    const c = db();
    batch(c, { source: 'excel' });
    expect(() => run(c, o as any)).toThrow();
  });
  it('a run may carry any business date (including a future one, as an audit of a refused attempt) but never an unreal one', () => {
    const c = db();
    expect(() => run(c, { date: colombo(5), mode: 'commit', status: 'rejected' })).not.toThrow();
  });
  it('UPDATE and DELETE are blocked on runs and on issues', () => {
    const c = db();
    const r = run(c);
    c.prepare("INSERT INTO import_issues (import_run_id, row_no, column_name, code, message) VALUES (?, 2, 'SKU', 'UNKNOWN_SKU', 'm')").run(r);
    expect(msg(() => c.exec(`UPDATE import_runs SET rows_ok = 0 WHERE id = ${r}`))).toContain('append-only');
    expect(msg(() => c.exec(`DELETE FROM import_runs WHERE id = ${r}`))).toContain('append-only');
    expect(msg(() => c.exec('UPDATE import_issues SET message = \'x\'' ))).toContain('append-only');
    expect(msg(() => c.exec('DELETE FROM import_issues'))).toContain('append-only');
    expect(scalar(c, 'SELECT COUNT(*) FROM import_runs')).toBe(1);
    expect(scalar(c, 'SELECT COUNT(*) FROM import_issues')).toBe(1);
  });
  it('an issue must belong to an existing run (foreign key)', () => {
    const c = db();
    expect(() => c.prepare("INSERT INTO import_issues (import_run_id, row_no, column_name, code, message) VALUES (999, 1, '', 'X', 'm')").run()).toThrow();
  });
});

describe('opening movements and the products cache', () => {
  it('an `opening` movement through the engine updates qty and value and writes one ledger row, with no cash entry', () => {
    const c = db();
    const p = sqlProduct(c);
    const b = batch(c);
    c.exec('BEGIN');
    receiveStock(c, { productId: p, businessDate: colombo(), type: 'opening', qty: 7, valueCents: 12345, refTable: 'opening_stock_batches', refId: b, reason: 'x' });
    c.exec('COMMIT');
    expect(pool(c, p)).toEqual({ qty: 7, value: 12345 });
    expect(scalar(c, "SELECT COUNT(*) FROM stock_movements WHERE type = 'opening' AND ref_table = 'opening_stock_batches' AND ref_id = ?", b)).toBe(1);
    expect(scalar(c, 'SELECT COUNT(*) FROM cash_entries')).toBe(0);
  });
  it('an opening movement dated in the future is refused by the stock ledger trigger (R-FD)', () => {
    const c = db();
    const p = sqlProduct(c);
    expect(msg(() => receiveStock(c, { productId: p, businessDate: colombo(1), type: 'opening', qty: 1, valueCents: 1, refTable: null, refId: null, reason: 'x' })))
      .toContain('FUTURE_DATE_NOT_ALLOWED');
  });
});
