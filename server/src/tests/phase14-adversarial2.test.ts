// Phase 14 adversarial tests, part 2: the Excel opening-stock import (all-or-nothing, hostile cells), daily closings (atomic close-with-count, reopen rules),
// and opening balances / capital edge cases. Every refusal is checked for the documented code and for "nothing written" (whole-database fingerprint).

import { describe, it, expect, afterEach } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, buy, daysAgo, mkProduct, ref } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { get, post } from './helpers/catalog.ts';
import { assertGlobalInvariants, diffSnapshots, must, rows, snapshotAll } from './helpers/phase14.ts';
import { importFile, mkSku, previewFile, xlsx } from './helpers/phase13.ts';
import { cl, sellOk } from './helpers/phase5.ts';
import { closeNew, openNew, reopenNew } from './helpers/phase8.ts';
import { capNew, tr } from './helpers/phase9.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const D = (n: number) => daysAgo(n);

async function unchanged(s: ApiBase, f: () => Promise<{ status: number; body: any }>): Promise<{ status: number; body: any }> {
  const before = snapshotAll(s.ctx);
  const r = await f();
  expect(diffSnapshots(before, snapshotAll(s.ctx)), `${r.status} ${JSON.stringify(r.body).slice(0, 200)}: a refused request changed tables`).toEqual([]);
  return r;
}

describe('Excel opening-stock import: all or nothing, hostile files', () => {
  it('any bad row fails the WHOLE import (422 IMPORT_HAS_ERRORS) and writes nothing - not even the good rows; the preview never writes stock', async () => {
    const s = await apiBase(await env.build());
    const a = await mkSku(s, 'AAA'); const b = await mkSku(s, 'BBB');
    void a; void b;
    const file = await xlsx([['AAA', '', 5, 100, '', ''], ['BBB', '', 3, '', 600, ''], ['NOPE', '', 1, 1, '', '']]);
    const before = snapshotAll(s.ctx);
    const pv = await previewFile(s, file);
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body.summary).toMatchObject({ total: 3, ok: 2, failed: 1 });
    expect(pv.body.rows[2].issues.map((x: any) => x.code)).toContain('UNKNOWN_SKU');
    // a preview may record an import_runs row but must not touch stock, cash or products
    const mid = snapshotAll(s.ctx);
    expect(diffSnapshots(before, mid).filter((t) => !['import_runs', 'import_issues', 'audit_logs'].includes(t))).toEqual([]);
    const r = await importFile(s, file);
    expect([r.status, r.body.error?.code]).toEqual([422, 'IMPORT_HAS_ERRORS']);
    const after = snapshotAll(s.ctx);
    expect(diffSnapshots(mid, after).filter((t) => !['import_runs', 'import_issues', 'audit_logs'].includes(t))).toEqual([]);
    expect(Number(rows(s.ctx, 'SELECT COUNT(*) n FROM stock_movements')[0]!.n)).toBe(0);
    await assertGlobalInvariants(s);
  });

  it('hostile cells: formula, text number, negative / fractional / zero / huge quantity, negative cost, both cost and total, no cost, duplicate SKU, blank SKU - each row flagged, import refused', async () => {
    const s = await apiBase(await env.build());
    for (const c of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']) await mkSku(s, c);
    const file = await xlsx([
      ['S1', '', { formula: '1+1', result: 2 }, 100, '', ''], ['S2', '', 'abc', 100, '', ''], ['S3', '', -4, 100, '', ''], ['S4', '', 1.5, 100, '', ''], ['S5', '', 0, 100, '', ''],
      ['S6', '', 1, -100, '', ''], ['S7', '', 2, 100, 999, ''], ['S8', '', 2, '', '', ''], ['S9', '', 1, 1, '', ''], ['S9', '', 1, 1, '', ''], ['', '', 1, 1, '', ''],
      ['S1', '', 99999999999, 99999999999, '', ''],
    ]);
    const pv = await previewFile(s, file);
    expect(pv.status).toBe(200);
    const bad = pv.body.rows.filter((r: any) => r.status === 'error').length;
    expect(bad, JSON.stringify(pv.body.rows.map((r: any) => [r.rowNo, r.status, r.issues.map((i: any) => i.code)]))).toBeGreaterThanOrEqual(9);
    const r = await importFile(s, file);
    expect([r.status, r.body.error?.code]).toEqual([422, 'IMPORT_HAS_ERRORS']);
    expect(Number(rows(s.ctx, 'SELECT COUNT(*) n FROM stock_movements')[0]!.n)).toBe(0);
  });

  it('wrong file types (text, empty, zip bomb-ish junk, .xls name), wrong headers, missing sheet, a missing file field and a future date are refused; no row is written', async () => {
    const s = await apiBase(await env.build());
    await mkSku(s, 'OK1');
    const good = await xlsx([['OK1', '', 1, 100, '', '']]);
    const cases: Array<[string, () => Promise<{ status: number; body: any }>]> = [
      ['text file', () => importFile(s, Buffer.from('SKU,Qty\nOK1,1'), { name: 'stock.xlsx' })],
      ['empty file', () => importFile(s, Buffer.alloc(0))],
      ['zip header only', () => importFile(s, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))],
      ['.csv extension', () => importFile(s, good, { name: 'stock.csv' })],
      ['wrong headers', async () => importFile(s, await xlsx([['OK1', '', 1, 100, '', '']], { headers: ['A', 'B', 'C', 'D', 'E', 'F'] }))],
      ['wrong sheet', async () => importFile(s, await xlsx([['OK1', '', 1, 100, '', '']], { sheet: 'Sheet9' }))],
      ['future date', () => importFile(s, good, { date: D(-2) })],
    ];
    for (const [label, f] of cases) {
      const before = snapshotAll(s.ctx);
      const r = await f();
      expect([400, 413, 415, 422], `${label}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`).toContain(r.status);
      expect(r.status, label).not.toBe(500);
      expect(diffSnapshots(before, snapshotAll(s.ctx)).filter((t) => !['import_runs', 'import_issues', 'audit_logs'].includes(t)), label).toEqual([]);
    }
    // the PREVIEW of a future-dated file is a 200 whose rows carry the documented per-row code (it never writes stock)
    const pf = await previewFile(s, good, { date: D(-2) });
    expect(pf.status).toBe(200);
    expect(pf.body.summary.failed).toBe(pf.body.summary.total);
    expect(pf.body.rows[0].issues.map((i: any) => i.code)).toContain('FUTURE_DATE_NOT_ALLOWED');
    const noFile = await unchanged(s, async () => {
      const mp = (await import('./helpers/multipart.ts')).buildMultipart([{ name: 'businessDate', value: D(1) }, { name: 'clientRef', value: ref() }]);
      const res = await s.app.inject({ method: 'POST', url: '/api/v1/excel/opening-stock/import', payload: mp.payload, headers: mp.headers });
      return { status: res.statusCode, body: res.json() };
    });
    expect(noFile.status).toBe(400);
    expect(Number(rows(s.ctx, 'SELECT COUNT(*) n FROM stock_movements')[0]!.n)).toBe(0);
  });

  it('a good file imports once; the same file again is IMPORT_ALREADY_COMMITTED; a hostile product note is stored verbatim; the batch can be voided only while its stock is on hand', async () => {
    const s = await apiBase(await env.build());
    const p = await mkSku(s, 'GOOD1');
    const file = await xlsx([['GOOD1', '', 7, 123.45, '', "=HYPERLINK(\"http://evil\")'; DROP TABLE products;--"]]);
    const r = await importFile(s, file, { date: D(3) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const prod = (await get(s.app, `/products/${p.id}`)).body.item;
    expect([prod.qtyOnHand, prod.stockValueCents]).toEqual([7, 7 * 12345]);
    const again = await unchanged(s, () => importFile(s, file, { date: D(3) }));
    expect([again.status, again.body.error?.code]).toEqual([409, 'IMPORT_ALREADY_COMMITTED']);
    await sellOk(s, [cl(p.id, 3, 1000)], { businessDate: D(1) });
    const v = await unchanged(s, () => post(s.app, `/opening-stock/${r.body.batch.id}/void`, { reason: 'x' }));
    expect([v.status, v.body.error?.code]).toEqual([409, 'OPENING_BATCH_IN_USE']);
    await assertGlobalInvariants(s);
  });
});

describe('daily closings and opening balances', () => {
  it('closing with a counted amount posts the count AND closes the day atomically; a missing note refuses BOTH; reopen twice is DAY_NOT_CLOSED; the reopen reason is required', async () => {
    const s = await apiBase(await env.build());
    await must(await openNew(s, 'shop', { businessDate: D(5), amountCents: 100000 }), 'open');
    // difference without a note: refused, nothing closed, no count
    const bad = await unchanged(s, () => post(s.app, '/daily-closings', { book: 'shop', businessDate: D(4), countedCents: 99000, clientRef: ref() }));
    expect([bad.status, bad.body.error?.code]).toEqual([400, 'NOTE_REQUIRED']);
    expect(Number(rows(s.ctx, 'SELECT COUNT(*) n FROM daily_closings')[0]!.n)).toBe(0);
    const ok = await post(s.app, '/daily-closings', { book: 'shop', businessDate: D(4), countedCents: 99000, note: 'short by 10', clientRef: ref() });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(Number(rows(s.ctx, "SELECT COUNT(*) n FROM cash_counts WHERE status='posted'")[0]!.n)).toBe(1);
    expect(Number(rows(s.ctx, "SELECT COALESCE(SUM(amount_cents),0) t FROM cash_entries WHERE book='shop'")[0]!.t)).toBe(99000);
    const id = ok.body.item.id;
    const shortReason = await unchanged(s, () => post(s.app, `/daily-closings/${id}/reopen`, { reason: 'x' }));
    expect(shortReason.status).toBe(400);
    expect((await reopenNew(s, id, 'because I must fix it')).status).toBe(200);
    const twice = await unchanged(s, () => reopenNew(s, id, 'again and again'));
    expect([twice.status, twice.body.error?.code]).toEqual([409, 'DAY_NOT_CLOSED']);
    const unknown = await unchanged(s, () => reopenNew(s, 99999, 'no such closing'));
    expect(unknown.status).toBe(404);
    await assertGlobalInvariants(s);
  });

  it('a closing and its day status: closing a future date is refused; closing a day does not block the day after (the day before is protected by the ordering rule); each book closes separately', async () => {
    const s = await apiBase(await env.build());
    await must(await openNew(s, 'shop', { businessDate: D(8), amountCents: 100 }), 'open');
    const f = await unchanged(s, () => closeNew(s, 'shop', D(-1)));
    expect([f.status, f.body.error?.code]).toEqual([400, 'FUTURE_DATE_NOT_ALLOWED']);
    await must(await closeNew(s, 'shop', D(3)), 'close');
    expect((await get(s.app, `/daily-closings/status?book=shop&businessDate=${D(3)}`)).body.isClosed).toBe(true);
    expect((await get(s.app, `/daily-closings/status?book=telecom&businessDate=${D(3)}`)).body.isClosed).toBe(false);
    // section 8 (migration 016): the day before the closed day D(3) is protected; before 016 this was accepted (201)
    const before = await unchanged(s, () => post(s.app, '/capital', { businessDate: D(4), book: 'shop', amountCents: 1, clientRef: ref() }));
    expect([before.status, before.body.error?.code]).toEqual([409, 'BACKDATE_BEFORE_CLOSED_DAY']);
    expect((await post(s.app, '/capital', { businessDate: D(2), book: 'shop', amountCents: 1, clientRef: ref() })).status).toBe(201);
    expect((await post(s.app, '/capital', { businessDate: D(3), book: 'telecom', amountCents: 1, clientRef: ref() })).status).toBe(201);
    const c = await unchanged(s, () => capNew(s, { businessDate: D(3), book: 'shop', amountCents: 1 }));
    expect([c.status, c.body.error?.code]).toEqual([409, 'DAY_CLOSED']);
    // a TRANSFER touching a closed book on either side is refused, whichever side
    const t1 = await unchanged(s, () => tr(s, 'telecom', 'shop', 100, { businessDate: D(3) }));
    const t2 = await unchanged(s, () => tr(s, 'shop', 'telecom', 100, { businessDate: D(3) }));
    expect([t1.body.error?.code, t2.body.error?.code]).toEqual(['DAY_CLOSED', 'DAY_CLOSED']);
    expect(t1.body.error.book).toBe('shop');
  });

  it('opening balance: second one for the same book is OPENING_BALANCE_EXISTS; Ice Cream needs a fund per entry; a voided opening can be entered again; capital never becomes profit', async () => {
    const s = await apiBase(await env.build());
    const a = await must(await openNew(s, 'shop', { businessDate: D(5), amountCents: 5000 }), 'first');
    const dup = await unchanged(s, () => openNew(s, 'shop', { businessDate: D(5), amountCents: 7000 }));
    expect([dup.status, dup.body.error?.code]).toEqual([409, 'OPENING_BALANCE_EXISTS']);
    const nf = await unchanged(s, () => post(s.app, '/cashbooks/icecream/opening', { businessDate: D(5), amountCents: 100, clientRef: ref() }));
    expect([nf.status, nf.body.error?.code]).toEqual([400, 'FUND_REQUIRED']);
    const wf = await unchanged(s, () => post(s.app, '/cashbooks/shop/opening', { businessDate: D(5), amountCents: 100, fund: 'cost', clientRef: ref() }));
    expect([wf.status, wf.body.error?.code]).toEqual([400, 'FUND_NOT_ALLOWED']);
    const badBook = await unchanged(s, () => post(s.app, '/cashbooks/vault/opening', { businessDate: D(5), amountCents: 100, clientRef: ref() }));
    expect([400, 404]).toContain(badBook.status);
    expect((await post(s.app, `/capital-entries/${a.item.id}/void`, { reason: 'wrong amount' })).status).toBe(200);
    expect((await openNew(s, 'shop', { businessDate: D(5), amountCents: 7000 })).status).toBe(201);
    // capital and opening balances never reach P&L
    await post(s.app, '/capital', { businessDate: D(4), book: 'shop', amountCents: 123456, clientRef: ref() });
    const p = (await get(s.app, `/reports/pnl/shop?from=${D(10)}&to=${D(0)}&granularity=month`)).body;
    expect(p.totals.netProfitCents).toBe(0);
    expect(p.totals.grossProfitCents).toBe(0);
    const dash = (await get(s.app, '/dashboard')).body;
    expect(dash.month.profitCents).toBe(0);
    expect(dash.cash.books[0].balanceCents).toBe(7000 + 123456);
    await assertGlobalInvariants(s);
  });
});

void buy; void mkProduct;
