// Phase 19 audit, part D: ORDERING and EDGE CASES of the closed-day protection (BUSINESS_RULES section 8, R9, R-FD, R-RD; API_CONTRACTS validation order).
//   D1 validation order: schema -> R-FD / date validity -> lookups / R-RD -> (clientRef replay) -> closed-day checks -> other rules
//   D2 clientRef replay after the day was closed later
//   D3 closing out of order, with and without a count variance, zero-difference counts
//   D4 reopening the latest vs an earlier closed day; reopened and re-closed days
//   D5 closed days in different books and multi-book precedence
//   D6 same-millisecond close / reopen / write cycles
//   D7 month / year boundaries, leap day, invalid dates, future dates, far past
//   D8 concurrent requests (parallel injects): no write may land in a closed day
// Every refusal is checked with fullSnapshot (all tables, audit_logs included): nothing written.

import { afterEach, describe, expect, it } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { get, post } from './helpers/catalog.ts';
import { apiBase, daysAgo, daysAhead, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { err, num, sql } from './helpers/phase4.ts';
import { cl, returnNew, rl, sellNew, sellOk } from './helpers/phase5.ts';
import { closeNew, countNew, countVoid, openNew, reopenNew } from './helpers/phase8.ts';
import { capNew, drawCash, tr } from './helpers/phase9.ts';
import { dayNew, moveNew, payNew } from './helpers/phase10.ts';
import { importFile, xlsx } from './helpers/phase13.ts';
import { typeIdOf } from './helpers/phase7.ts';
import { voidReturnNew } from './helpers/phase17.ts';
import { lossNew, drawNew } from './helpers/phase4.ts';
import {
  C, E, L, M, OLD, backdateBody, balAsOf, closeBooks, closedSnapshotViolations, dayClosedBody, fixture, fullSnapshot, must, ok,
} from './helpers/phase19cd.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });
const fresh = async () => { const s = await apiBase(await env.build()); return { s, fx: await fixture(s, { returns: 2 }) }; };

// =============================================================================================
describe('D1 validation order', () => {
  it('schema errors beat closed days; impossible dates and R-FD beat closed days (the closed day is even TODAY)', async () => {
    const { s } = await fresh();
    await closeBooks(s, ['shop'], today());
    const snap = fullSnapshot(s);
    // schema: a missing clientRef on a closed day is a 400 VALIDATION_ERROR, not DAY_CLOSED
    const bad = await post(s.app, '/drawings', { kind: 'cash', businessDate: today(), book: 'shop', amountCents: 100 });
    expect(bad.status).toBe(400);
    expect(err(bad).code).toBe('VALIDATION_ERROR');
    // impossible calendar dates are VALIDATION_ERROR with fields.businessDate
    for (const d of ['2023-02-29', '2024-02-30', '2024-13-01', '2024-00-10', '2024-04-31']) {
      const r = await drawCash(s, { businessDate: d });
      expect(r.status, d).toBe(400);
      expect(err(r).code, d).toBe('VALIDATION_ERROR');
      expect(err(r).fields.businessDate, d).toBeTruthy();
    }
    // future dates (tomorrow) are FUTURE_DATE_NOT_ALLOWED even though today is closed
    const f = await drawCash(s, { businessDate: daysAhead(1) });
    expect(f.status).toBe(400);
    expect(err(f).code).toBe('FUTURE_DATE_NOT_ALLOWED');
    // today is closed: DAY_CLOSED
    expect(err(await drawCash(s, { businessDate: today() }))).toEqual(dayClosedBody('shop', today()));
    expect(fullSnapshot(s)).toEqual(snap);
  });

  it('closed-day checks beat the other business rules (stock, quantities, statuses): nothing is reported about stock on a closed day', async () => {
    const { s, fx } = await fresh();
    const sale = (await sellOk(s, [cl(fx.shopP.id, 5, 3000)], { businessDate: OLD() })).sales[0];
    const lossE = must(await lossNew(s, fx.shopP.id, 1, { businessDate: E() }));
    const voided = must(await drawCash(s, { businessDate: C() }));
    await post(s.app, `/drawings/${voided.body.item.id}/void`, { reason: 'void before closing' }); // a voided record dated C
    await closeBooks(s, ['shop'], C());
    const snap = fullSnapshot(s);
    // INSUFFICIENT_STOCK would apply: 999999 units
    expect(err(await lossNew(s, fx.shopP.id, 999999, { businessDate: C() })).code).toBe('DAY_CLOSED');
    expect(err(await lossNew(s, fx.shopP.id, 999999, { businessDate: E() })).code).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    expect(err(await drawNew(s, fx.shopP.id, 999999, { businessDate: E() })).code).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    expect(err(await sellNew(s, [cl(fx.shopP.id, 999999, 3000)], { businessDate: E() })).code).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    expect(err(await sellNew(s, [cl(fx.shopP.id, 999999, 3000)], { businessDate: C() })).code).toBe('DAY_CLOSED');
    // return quantity above what was sold, dated before / on the closed day
    const item = sale.items[0].id;
    expect(err(await returnNew(s, sale.id, [rl(item, 99, true)], { businessDate: E() })).code).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    expect(err(await returnNew(s, sale.id, [rl(item, 99, true)], { businessDate: C() })).code).toBe('DAY_CLOSED');
    // R-RD (before the sale's own date) and a missing sale come first
    expect(err(await returnNew(s, sale.id, [rl(item, 1, true)], { businessDate: daysAgo(20) })).code).toBe('RETURN_BEFORE_ORIGINAL_DATE');
    expect((await returnNew(s, 999999, [rl(item, 1, true)], { businessDate: E() })).status).toBe(404);
    // a void of an ALREADY VOIDED record on a closed day: the contract says DAY_CLOSED is checked right after the lookup, before ALREADY_VOID
    expect(err(await post(s.app, `/drawings/${voided.body.item.id}/void`, { reason: 'again' }))).toEqual(dayClosedBody('shop', C()));
    expect(fullSnapshot(s)).toEqual(snap);
    expect(lossE.status).toBe(201);
  });

  it('void of a sales RETURN: ALREADY_VOID and RETURN_NOT_NEWEST are reported BEFORE the closed-day checks (documented order of R-VR; differs from every other void)', async () => {
    const { s, fx } = await fresh();
    const sale = fx.sales[0]!.shop[0];
    const item = sale.items[0].id;
    const r1 = must(await returnNew(s, sale.id, [rl(item, 1, true)], { businessDate: E() })).body.item;
    const r2 = must(await returnNew(s, sale.id, [rl(item, 1, true)], { businessDate: M() })).body.item;
    await closeBooks(s, ['shop'], C());
    const snap = fullSnapshot(s);
    // r1 is not the newest return of the item: RETURN_NOT_NEWEST wins over BACKDATE
    expect(err(await voidReturnNew(s, sale.id, r1.id)).code).toBe('RETURN_NOT_NEWEST');
    // r2 is the newest: BACKDATE (dated M, latest closed C)
    expect(err(await voidReturnNew(s, sale.id, r2.id))).toEqual(backdateBody('shop', C(), M()));
    expect(fullSnapshot(s)).toEqual(snap);
  });

  it('unknown product / unknown record: lookup errors are reported (the book is unknown), never a closed-day verdict about the wrong book', async () => {
    const { s } = await fresh();
    await closeBooks(s, ['shop', 'telecom', 'icecream'], C());
    const snap = fullSnapshot(s);
    const a = await post(s.app, '/purchases', { businessDate: C(), items: [{ productId: 999999, packs: 1, packSize: 1, lineTotalCents: 1 }], clientRef: ref() });
    expect([400, 404, 422]).toContain(a.status);
    expect((await post(s.app, '/expenses/999999/void', { reason: 'x' })).status).toBe(404);
    expect((await post(s.app, '/cash-transfers/999999/void', { reason: 'x' })).status).toBe(404);
    expect((await post(s.app, `/icecream/days/${C()}/void`, { reason: 'x' })).status).toBe(404);
    expect(fullSnapshot(s)).toEqual(snap);
  });
});

// =============================================================================================
describe('D2 clientRef replay after the day was closed later', () => {
  it('a retry of a saved request returns the original (200) and writes nothing, whatever the day is now', async () => {
    const { s, fx } = await fresh();
    const typeId = await typeIdOf(s, 'BW_1S');
    const k = (n: string) => `replay-${n}-001`;
    const bodies: Array<[string, string, (d: string) => any]> = [
      ['purchase', '/purchases', (d) => ({ businessDate: d, items: [{ productId: fx.shopP.id, packs: 1, packSize: 2, lineTotalCents: 2000 }], clientRef: k('purchase') })],
      ['sale', '/sales', (d) => ({ businessDate: d, items: [cl(fx.shopP.id, 1, 3000)], clientRef: k('sale') })],
      ['expense', '/expenses', (d) => ({ businessDate: d, book: 'shop', category: 'rent', amountCents: 100, description: 'x', clientRef: k('expense') })],
      ['capital', '/capital', (d) => ({ businessDate: d, book: 'shop', amountCents: 100, clientRef: k('capital') })],
      ['cash drawing', '/drawings', (d) => ({ kind: 'cash', businessDate: d, book: 'shop', amountCents: 100, clientRef: k('cashdraw') })],
      ['goods drawing', '/drawings', (d) => ({ kind: 'goods', businessDate: d, productId: fx.shopP.id, qty: 1, clientRef: k('goodsdraw') })],
      ['stock loss', '/stock-losses', (d) => ({ businessDate: d, productId: fx.shopP.id, qty: 1, reason: 'damaged', clientRef: k('loss') })],
      ['transfer', '/cash-transfers', (d) => ({ businessDate: d, fromBook: 'shop', toBook: 'telecom', amountCents: 100, clientRef: k('transfer') })],
      ['reload', '/reload-sales', (d) => ({ businessDate: d, providerId: fx.prov.Dialog, salesCents: 10000, clientRef: k('reload') })],
      ['ezcash', '/ezcash-sales', (d) => ({ businessDate: d, billTotalCents: 10000, clientRef: k('ezcash') })],
      ['wallet top-up', '/telecom/topups', (d) => ({ businessDate: d, kind: 'wallet_topup', amountCents: 1000, clientRef: k('topup') })],
      ['print sale', '/print-sales', (d) => ({ businessDate: d, serviceTypeId: typeId, qty: 2, clientRef: k('print') })],
      ['printing supplies', '/printing-supplies', (d) => ({ businessDate: d, amountCents: 500, description: 'paper', clientRef: k('supply') })],
      ['opening stock', '/opening-stock', (d) => ({ businessDate: d, items: [{ productId: fx.osShop.id, qty: 1, unitCostCents: 1000 }], clientRef: k('ostock') })],
      ['opening balance', '/cashbooks/shop/opening', (d) => ({ businessDate: d, amountCents: 5000, clientRef: k('openbal') })],
      ['cash count', '/cash-counts', (d) => ({ businessDate: d, book: 'shop', countedCents: 777, note: 'replay', clientRef: k('count') })],
      ['ice day', '/icecream/days', (d) => ({ businessDate: d, salesCents: 1000, costAllocCents: 600, electricityAllocCents: 100, clientRef: k('iceday') })],
      ['ice payment', '/icecream/payments', (d) => ({ businessDate: d, kind: 'materials', fund: 'cost', amountCents: 500, description: 'x', clientRef: k('icepay') })],
      ['ice fund move', '/icecream/fund-moves', (d) => ({ businessDate: d, fromFund: 'cost', toFund: 'electricity', amountCents: 100, clientRef: k('icemove') })],
    ];
    const first: Record<string, any> = {};
    for (const [name, path, body] of bodies) {
      const r = await post(s.app, path, body(E()));
      expect(r.status, `${name}: ${JSON.stringify(r.body)}`).toBe(201);
      first[name] = r.body;
    }
    await closeBooks(s, ['shop', 'telecom', 'icecream'], C());
    const snap = fullSnapshot(s);
    for (const [name, path, body] of bodies) {
      // same body, same date (E is now BEFORE a closed day): the retry still answers with the original record
      const again = await post(s.app, path, body(E()));
      expect(again.status, `${name} replay: ${JSON.stringify(again.body)}`).toBe(200);
      // same clientRef with a DIFFERENT date that is closed: never a second record; the answer is an idempotent 200 or a refusal (409)
      const other = await post(s.app, path, body(C()));
      expect([200, 409], `${name} replay with another date: ${other.status} ${JSON.stringify(other.body)}`).toContain(other.status);
    }
    expect(fullSnapshot(s)).toEqual(snap);
  });

  it('a retry of an Excel opening-stock import (same clientRef) after the day was closed returns the batch (200); a NEW file on that date is refused', async () => {
    const { s, fx } = await fresh();
    const file = await xlsx([[fx.osShop.code, fx.osShop.name, 1, 10, null, 'replay-file']]);
    const cr = 'replay-excel-0001';
    const a = await importFile(s, file, { date: E(), clientRef: cr });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    await closeBooks(s, ['shop'], C());
    const snap = fullSnapshot(s);
    const b = await importFile(s, file, { date: E(), clientRef: cr });
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    const c = await importFile(s, await xlsx([[fx.osShop.code, fx.osShop.name, 1, 10, null, 'new-file']]), { date: E() });
    expect(c.status).toBe(409);
    expect(err(c)).toEqual(backdateBody('shop', C(), E()));
    expect(fullSnapshot(s)).toEqual(snap);
  });

  it('Excel import with BAD rows dated in a closed period: row validation runs first (422) and an import_runs audit row is written (observation S-3, Low; no business record)', async () => {
    const { s, fx } = await fresh();
    await closeBooks(s, ['shop'], C());
    const before = fullSnapshot(s);
    const r = await importFile(s, await xlsx([['NO-SUCH-SKU', 'ghost', 1, 10, null, 'bad']]), { date: C() });
    expect(r.status).toBe(422);
    expect(err(r).code).toBe('IMPORT_HAS_ERRORS');
    const after = fullSnapshot(s);
    const changed = Object.keys(after).filter((t) => after[t] !== before[t]).sort();
    expect(changed).toEqual(['import_issues', 'import_runs', 'sqlite_sequence']);
    // a GOOD file on the same closed date is DAY_CLOSED and writes nothing at all
    const snap = fullSnapshot(s);
    const g = await importFile(s, await xlsx([[fx.osShop.code, fx.osShop.name, 1, 10, null, 'good']]), { date: C() });
    expect(err(g)).toEqual(dayClosedBody('shop', C()));
    expect(fullSnapshot(s)).toEqual(snap);
  });
});

// =============================================================================================
describe('D3 closing out of order and counts', () => {
  it('a day can be closed AFTER a later day was closed (no count, no cash entry); the later closing is not touched', async () => {
    const { s } = await fresh();
    must(await drawCash(s, { businessDate: E(), amountCents: 300 }));
    const late = (await closeNew(s, 'shop', C())).body.item;
    const early = await closeNew(s, 'shop', M());
    expect(early.status, JSON.stringify(early.body)).toBe(201);
    const row = sql(s, 'SELECT * FROM daily_closings WHERE id = ?', late.id)[0]!;
    expect(row.expected_cents).toBe(late.expectedCents);
    expect(closedSnapshotViolations(s)).toEqual([]);
  });

  it('closing an earlier day WITH a variance count is refused when a later day is closed (the adjustment would change it); the count and closing are not written', async () => {
    const { s } = await fresh();
    await closeBooks(s, ['shop'], C());
    const snap = fullSnapshot(s);
    const r = await closeNew(s, 'shop', M(), { countedCents: balAsOf(s, 'shop', M()) + 500, note: 'short' });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(err(r)).toEqual(backdateBody('shop', C(), M()));
    expect(fullSnapshot(s)).toEqual(snap);
  });

  it('closing an earlier day with a MATCHING count (zero difference, no cash entry) is allowed even though a later day is closed', async () => {
    const { s } = await fresh();
    await closeBooks(s, ['shop'], C());
    const r = await closeNew(s, 'shop', M(), { countedCents: balAsOf(s, 'shop', M()) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.item.overShortCents).toBe(0);
    expect(closedSnapshotViolations(s)).toEqual([]);
  });

  it('closing the LATEST day with a variance: the adjustment lands on that day, the snapshot (counted) equals the ledger, and the day is then protected', async () => {
    const { s } = await fresh();
    must(await drawCash(s, { businessDate: E(), amountCents: 300 }));
    const r = await closeNew(s, 'shop', C(), { countedCents: balAsOf(s, 'shop', C()) + 700, note: 'over by 7' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.item.overShortCents).toBe(700);
    expect(closedSnapshotViolations(s)).toEqual([]);
    expect(err(await drawCash(s, { businessDate: C() }))).toEqual(dayClosedBody('shop', C()));
    // a later variance close on a LATER day is fine and independent
    const r2 = await closeNew(s, 'shop', L(), { countedCents: balAsOf(s, 'shop', L()) - 100, note: 'short 1' });
    expect(r2.status).toBe(201);
    expect(closedSnapshotViolations(s)).toEqual([]);
  });

  it('zero-difference counts: allowed before a later closed day (no money moves), refused on the closed day itself; their void follows the same two rules', async () => {
    const { s } = await fresh();
    must(await drawCash(s, { businessDate: E(), amountCents: 300 }));
    const zeroE = must(await countNew(s, 'shop', balAsOf(s, 'shop', E()), { businessDate: E() })).body.item;
    const zeroM = must(await countNew(s, 'shop', balAsOf(s, 'shop', M()), { businessDate: M() })).body.item;
    await closeBooks(s, ['shop'], C());
    await closeBooks(s, ['shop'], M());
    // before the latest closed day: allowed (no cash entry)
    const okCount = await countNew(s, 'shop', balAsOf(s, 'shop', E()), { businessDate: E() });
    expect(ok(okCount), JSON.stringify(okCount.body)).toBe(true);
    // a count with a variance before it: refused
    expect(err(await countNew(s, 'shop', balAsOf(s, 'shop', E()) + 1, { businessDate: E(), note: 'x' })).code).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    // exactly on a closed day: refused even for zero difference
    expect(err(await countNew(s, 'shop', balAsOf(s, 'shop', C()), { businessDate: C() }))).toEqual(dayClosedBody('shop', C()));
    // voids: zero-difference count before a closed day -> allowed; on the closed day M -> DAY_CLOSED
    expect(ok(await countVoid(s, zeroE.id))).toBe(true);
    expect(err(await countVoid(s, zeroM.id))).toEqual(dayClosedBody('shop', M()));
    expect(closedSnapshotViolations(s)).toEqual([]);
  });
});

// =============================================================================================
describe('D4 reopening the latest vs an earlier closed day', () => {
  it('closed C1 < C2 < C3: reopening the middle one changes nothing for the latest; reopening the latest makes the NEXT latest the reference; reopened days are not DAY_CLOSED but still BACKDATE below a later closed day', async () => {
    const { s } = await fresh();
    const c1 = (await closeNew(s, 'shop', daysAgo(5))).body.item;
    const c2 = (await closeNew(s, 'shop', daysAgo(4))).body.item;
    const c3 = (await closeNew(s, 'shop', daysAgo(2))).body.item;
    const dated = (d: string) => drawCash(s, { businessDate: d, amountCents: 100 });
    expect(err(await dated(daysAgo(6)))).toEqual(backdateBody('shop', daysAgo(2), daysAgo(6)));
    must(await reopenNew(s, c2.id, 'reopen the middle day'));                // C3 stays the latest
    expect(err(await dated(daysAgo(4)))).toEqual(backdateBody('shop', daysAgo(2), daysAgo(4))); // reopened but earlier than C3
    expect(err(await dated(daysAgo(3)))).toEqual(backdateBody('shop', daysAgo(2), daysAgo(3)));
    must(await reopenNew(s, c3.id, 'reopen the latest day'));                // C1 is the latest now
    expect(err(await dated(daysAgo(6)))).toEqual(backdateBody('shop', daysAgo(5), daysAgo(6)));
    expect(err(await dated(daysAgo(5)))).toEqual(dayClosedBody('shop', daysAgo(5)));
    expect(ok(await dated(daysAgo(4)))).toBe(true);                          // after the latest closed day: fine
    expect(ok(await dated(daysAgo(2)))).toBe(true);
    must(await reopenNew(s, c1.id, 'reopen the first day'));
    expect(ok(await dated(daysAgo(6)))).toBe(true);
    // double reopen
    expect(err(await reopenNew(s, c1.id, 'again')).code).toBe('DAY_NOT_CLOSED');
    // re-closing the three days restores the protection and keeps the row ids
    for (const [id, d] of [[c1.id, daysAgo(5)], [c2.id, daysAgo(4)], [c3.id, daysAgo(2)]] as Array<[number, string]>) {
      const r = await closeNew(s, 'shop', d);
      expect(r.status).toBe(201);
      expect(r.body.item.id).toBe(id);
    }
    expect(err(await dated(daysAgo(6))).code).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    expect(closedSnapshotViolations(s)).toEqual([]);
  });

  it('a day reopened, changed and re-closed: the closing is re-computed (expected = new balance), audit keeps close and reopen, closed_at is later than reopened_at', async () => {
    const { s } = await fresh();
    must(await drawCash(s, { businessDate: C(), amountCents: 100 }));
    const first = (await closeNew(s, 'shop', C())).body.item;
    const balanceBefore = balAsOf(s, 'shop', C());
    expect(first.expectedCents).toBe(balanceBefore);
    const reopened = must(await reopenNew(s, first.id, 'forgot an entry')).body.item;
    must(await drawCash(s, { businessDate: C(), amountCents: 250 }));
    const second = must(await closeNew(s, 'shop', C())).body.item;
    expect(second.id).toBe(first.id);
    expect(second.expectedCents).toBe(balanceBefore - 250);
    expect(second.closedAt > reopened.reopenedAt).toBe(true);
    expect(sql(s, "SELECT action FROM audit_logs WHERE entity = 'daily_closing' ORDER BY id").map((r) => r.action)).toEqual(['close', 'reopen', 'close']);
    expect(closedSnapshotViolations(s)).toEqual([]);
  });

  it('closing and reopening validation: DAY_ALREADY_CLOSED, DAY_NOT_CLOSED, reason length, unknown id, future date', async () => {
    const { s } = await fresh();
    const c = (await closeNew(s, 'shop', C())).body.item;
    expect(err(await closeNew(s, 'shop', C())).code).toBe('DAY_ALREADY_CLOSED');
    expect(err(await reopenNew(s, c.id, 'x')).code).toBe('VALIDATION_ERROR');
    expect(err(await reopenNew(s, 999999, 'long enough')).code).toBe('NOT_FOUND');
    expect(err(await closeNew(s, 'shop', daysAhead(1))).code).toBe('FUTURE_DATE_NOT_ALLOWED');
    expect(err(await closeNew(s, 'shop', '2024-02-30')).code).toBe('VALIDATION_ERROR');
    must(await reopenNew(s, c.id, 'valid reason'));
    expect(err(await reopenNew(s, c.id, 'valid reason')).code).toBe('DAY_NOT_CLOSED');
  });
});

// =============================================================================================
describe('D5 closed days in different books', () => {
  it('Shop closed on C, Telecom closed on a LATER day: a transfer between them is judged per book; DAY_CLOSED beats BACKDATE in any book; the first book in shop, telecom, icecream order is named within a kind', async () => {
    const { s } = await fresh();
    await closeBooks(s, ['shop'], daysAgo(5));      // Shop latest = D5
    await closeBooks(s, ['telecom'], daysAgo(2));   // Telecom latest = D2
    const t = (d: string, from: any = 'shop', to: any = 'telecom') => tr(s, from, to, 100, { businessDate: d });
    // dated D4: after the Shop closed day, but Telecom closed LATER (D2) -> BACKDATE naming Telecom
    expect(err(await t(daysAgo(4)))).toEqual(backdateBody('telecom', daysAgo(2), daysAgo(4)));
    // dated D6: both books have a later closed day -> BACKDATE naming the FIRST book (shop)
    expect(err(await t(daysAgo(6)))).toEqual(backdateBody('shop', daysAgo(5), daysAgo(6)));
    // dated D5: Shop DAY_CLOSED (Telecom would be BACKDATE): DAY_CLOSED wins
    expect(err(await t(daysAgo(5)))).toEqual(dayClosedBody('shop', daysAgo(5)));
    // dated D2: Telecom DAY_CLOSED
    expect(err(await t(daysAgo(2)))).toEqual(dayClosedBody('telecom', daysAgo(2)));
    // dated D1 (after both): fine
    expect(ok(await t(daysAgo(1)))).toBe(true);
    // Ice Cream is not touched by a Shop -> Telecom transfer even when closed on every day
    await closeBooks(s, ['icecream'], daysAgo(1));
    expect(ok(await t(today()))).toBe(true);
    // precedence across kinds: Telecom -> Ice Cream dated D2: Telecom DAY_CLOSED, Ice Cream BACKDATE (latest closed D1) -> DAY_CLOSED wins
    expect(err(await tr(s, 'telecom', 'icecream', 100, { businessDate: daysAgo(2), toFund: 'profit' }))).toEqual(dayClosedBody('telecom', daysAgo(2)));
    // a Shop line and a Telecom line in one cart: only Telecom has a later closed day
    const cart = await sellNew(s, [cl(fixtureShop(s), 1, 3000)], { businessDate: daysAgo(4) });
    expect(cart.status).toBe(201); // shop-only cart dated D4 > D5: accepted
  });

  it('a sale cart with Shop and Telecom lines is refused whole when only one of the books has a closed day (nothing of the other book is written)', async () => {
    const { s, fx } = await fresh();
    await closeBooks(s, ['telecom'], C());
    const snap = fullSnapshot(s);
    const r = await sellNew(s, [cl(fx.shopP.id, 1, 3000), cl(fx.telP.id, 1, 3000)], { businessDate: E() });
    expect(r.status).toBe(409);
    expect(err(r)).toEqual(backdateBody('telecom', C(), E()));
    expect(fullSnapshot(s)).toEqual(snap);
    expect(ok(await sellNew(s, [cl(fx.shopP.id, 1, 3000)], { businessDate: E() }))).toBe(true); // Shop alone is fine
  });
});

function fixtureShop(s: ApiBase): number {
  return Number((sql(s, "SELECT id FROM products WHERE book = 'shop' AND kind = 'stock' AND qty_on_hand > 0 ORDER BY id LIMIT 1")[0] as any).id);
}

// =============================================================================================
describe('D6 same-millisecond cycles', () => {
  it('close -> refused write -> reopen -> accepted write -> re-close, repeated back to back: the state always follows the last action', async () => {
    const { s } = await fresh();
    const first = (await closeNew(s, 'shop', C())).body.item;
    for (let i = 0; i < 25; i++) {
      expect(err(await drawCash(s, { businessDate: C() })).code, `cycle ${i}`).toBe('DAY_CLOSED');
      const re = await reopenNew(s, first.id, 'cycle reopen');
      expect(re.status, `cycle ${i}`).toBe(200);
      expect(ok(await drawCash(s, { businessDate: C(), amountCents: 100 })), `cycle ${i}`).toBe(true);
      const cl2 = await closeNew(s, 'shop', C());
      expect(cl2.status, `cycle ${i}`).toBe(201);
      expect(cl2.body.item.isClosed).toBe(true);
      expect(cl2.body.item.closedAt > re.body.item.reopenedAt, `closedAt after reopenedAt, cycle ${i}`).toBe(true);
    }
    expect(closedSnapshotViolations(s)).toEqual([]);
    const st = await get(s.app, `/daily-closings/status?book=shop&businessDate=${C()}`);
    expect(st.body.isClosed).toBe(true);
  });

  it('reopening in the very same millisecond as the closing still opens the day (reopened_at is never earlier than closed_at)', async () => {
    const { s } = await fresh();
    const conn = s.ctx.database.conn;
    for (let i = 0; i < 20; i++) {
      const d = daysAgo(10 + i);
      const c = (await closeNew(s, 'icecream', d)).body.item;
      const [a, b] = await Promise.all([reopenNew(s, c.id, 'same ms reopen'), Promise.resolve(0)]);
      expect(a.status).toBe(200);
      const row = conn.prepare('SELECT closed_at, reopened_at FROM daily_closings WHERE id = ?').get(c.id) as unknown as { closed_at: string; reopened_at: string };
      expect(row.reopened_at >= row.closed_at).toBe(true);
      expect(b).toBe(0);
      const open = await get(s.app, `/daily-closings/status?book=icecream&businessDate=${d}`);
      expect(open.body.isClosed).toBe(false);
    }
  });
});

// =============================================================================================
describe('D7 calendar boundaries, leap day, far past, future', () => {
  const cases: Array<[string, string, string]> = [
    ['leap day: close 2024-03-01, write 2024-02-29', '2024-03-01', '2024-02-29'],
    ['leap day eve: close 2024-02-29, write 2024-02-28', '2024-02-29', '2024-02-28'],
    ['non-leap year: close 2025-03-01, write 2025-02-28', '2025-03-01', '2025-02-28'],
    ['year boundary: close 2024-01-01, write 2023-12-31', '2024-01-01', '2023-12-31'],
    ['month boundary: close 2025-05-01, write 2025-04-30', '2025-05-01', '2025-04-30'],
    ['far past: close 2000-01-01, write 1999-12-31', '2000-01-01', '1999-12-31'],
    ['far past 1900', '1900-01-02', '1900-01-01'],
  ];
  it.each(cases)('%s', async (_n, closed, before) => {
    const { s } = await fresh();
    must(await closeNew(s, 'shop', closed));
    expect(err(await drawCash(s, { businessDate: before }))).toEqual(backdateBody('shop', closed, before));
    expect(err(await drawCash(s, { businessDate: closed }))).toEqual(dayClosedBody('shop', closed));
    // the next calendar day is accepted (string comparison of ISO dates is chronological across the boundary)
    const next = new Date(Date.parse(`${closed}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    expect(ok(await drawCash(s, { businessDate: next })), next).toBe(true);
  });

  it('a closed day TODAY: today is DAY_CLOSED, yesterday BACKDATE, tomorrow FUTURE_DATE_NOT_ALLOWED; closing tomorrow is refused', async () => {
    const { s } = await fresh();
    must(await closeNew(s, 'telecom', today()));
    const w = (d: string) => post(s.app, '/telecom/topups', { businessDate: d, kind: 'wallet_topup', amountCents: 100, clientRef: ref() });
    expect(err(await w(today()))).toEqual(dayClosedBody('telecom', today()));
    expect(err(await w(daysAgo(1)))).toEqual(backdateBody('telecom', today(), daysAgo(1)));
    expect(err(await w(daysAhead(1))).code).toBe('FUTURE_DATE_NOT_ALLOWED');
    expect(err(await w('9999-12-31')).code).toBe('FUTURE_DATE_NOT_ALLOWED');
    expect(err(await closeNew(s, 'telecom', daysAhead(1))).code).toBe('FUTURE_DATE_NOT_ALLOWED');
  });

  it('malformed date strings never reach the closed-day logic', async () => {
    const { s } = await fresh();
    await closeBooks(s, ['shop'], C());
    const snap = fullSnapshot(s);
    for (const d of ['2024-2-9', '24-02-09', '2024/02/09', '20240209', '', ' 2024-02-09', '2024-02-09 ', '2024-02-09T00:00:00Z', 'yesterday', '١٤٤٤-٠١-٠١']) {
      const r = await drawCash(s, { businessDate: d });
      expect(r.status, JSON.stringify(d)).toBe(400);
      expect(err(r).code, JSON.stringify(d)).toBe('VALIDATION_ERROR');
    }
    expect(fullSnapshot(s)).toEqual(snap);
  });
});

// =============================================================================================
describe('D8 concurrent requests: no write may land in a closed day', () => {
  it('a close racing 60 writes dated C / E / L: every accepted write dated <= C was posted BEFORE the closing, and the snapshot equals the ledger', async () => {
    for (let round = 0; round < 3; round++) {
      const s = await apiBase(await env.build());
      const reqs: Array<Promise<any>> = [];
      const meta: string[] = [];
      let closeIdx = -1;
      for (let i = 0; i < 20; i++) {
        for (const d of [C(), E(), L()]) {
          if (reqs.length === 30 + round * 7) { closeIdx = reqs.length; meta.push('close'); reqs.push(closeNew(s, 'shop', C())); }
          meta.push(d);
          reqs.push(drawCash(s, { businessDate: d, amountCents: 100 + i }));
        }
      }
      const results = await Promise.all(reqs);
      const closing = results[closeIdx]!;
      expect(closing.status, JSON.stringify(closing.body)).toBe(201);
      const closedAt = closing.body.item.closedAt as string;
      const rows = results.map((r, i) => ({ r, d: meta[i]! })).filter((x, i) => i !== closeIdx);
      const accepted = rows.filter((x) => x.r.status === 201);
      for (const x of rows.filter((y) => y.r.status !== 201)) {
        expect(x.r.status).toBe(409);
        expect(['DAY_CLOSED', 'BACKDATE_BEFORE_CLOSED_DAY']).toContain(err(x.r).code);
      }
      // the race is real: some writes dated <= C were accepted (before the close) and some refused (after it)
      expect(accepted.filter((x) => x.d !== L()).length).toBeGreaterThan(0);
      expect(rows.filter((x) => x.d !== L() && x.r.status === 409).length).toBeGreaterThan(0);
      // dated L is always accepted (later than the closed day)
      expect(accepted.filter((x) => x.d === L()).length).toBe(20);
      // nothing dated <= C was posted after the closing
      const late = num(s, "SELECT COUNT(*) FROM cash_entries WHERE book = 'shop' AND business_date <= ? AND posted_at > ?", C(), closedAt);
      expect(late).toBe(0);
      expect(closedSnapshotViolations(s)).toEqual([]);
    }
  });

  it('two parallel closes of the same day: exactly one wins; two parallel reopens: exactly one wins', async () => {
    const s = await apiBase(await env.build());
    const [a, b] = await Promise.all([closeNew(s, 'shop', C()), closeNew(s, 'shop', C())]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a, b].find((x) => x.status === 409)!.body.error.code).toBe('DAY_ALREADY_CLOSED');
    const id = (a.status === 201 ? a : b).body.item.id;
    const [r1, r2] = await Promise.all([reopenNew(s, id, 'parallel reopen'), reopenNew(s, id, 'parallel reopen')]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(sql(s, "SELECT COUNT(*) AS n FROM audit_logs WHERE entity = 'daily_closing' AND action = 'reopen'")[0]!.n).toBe(1);
  });

  it('reopen racing writes on the closed day, then a re-close: whatever was accepted is inside the new snapshot', async () => {
    const s = await apiBase(await env.build());
    must(await drawCash(s, { businessDate: C(), amountCents: 50 }));
    const closing = (await closeNew(s, 'shop', C())).body.item;
    const writes = Array.from({ length: 10 }, (_, i) => drawCash(s, { businessDate: C(), amountCents: 10 + i }));
    const [re, ...rs] = await Promise.all([reopenNew(s, closing.id, 'race reopen'), ...writes]);
    expect(re.status).toBe(200);
    for (const r of rs) expect(r.status === 201 || err(r).code === 'DAY_CLOSED').toBe(true);
    // the request order here is: writes were dispatched first -> all refused; the reopen is the first to run after them. Either order is legal;
    // what must hold is that after re-closing the snapshot equals the ledger.
    expect((await closeNew(s, 'shop', C())).status).toBe(201);
    expect(closedSnapshotViolations(s)).toEqual([]);
  });

  it('writes in two books and a transfer racing the closings of both books: balances as of the closed days equal the snapshots', async () => {
    const s = await apiBase(await env.build());
    const calls: Array<Promise<any>> = [];
    for (let i = 0; i < 15; i++) {
      calls.push(capNew(s, { businessDate: C(), book: 'shop', amountCents: 1000 + i }));
      calls.push(capNew(s, { businessDate: C(), book: 'telecom', amountCents: 2000 + i }));
      calls.push(tr(s, 'shop', 'telecom', 10 + i, { businessDate: C() }));
      calls.push(dayNew(s, { businessDate: daysAgo(20 + i) }));
      calls.push(payNew(s, 'materials', 100, { businessDate: C() }));
      calls.push(moveNew(s, 'cost', 'electricity', 50, { businessDate: C() }));
      if (i === 7) { calls.push(closeNew(s, 'shop', C())); calls.push(closeNew(s, 'telecom', C())); calls.push(closeNew(s, 'icecream', C())); }
    }
    const res = await Promise.all(calls);
    for (const r of res) expect([200, 201, 409, 422]).toContain(r.status);
    for (const r of res.filter((x) => x.status === 409)) expect(['DAY_CLOSED', 'BACKDATE_BEFORE_CLOSED_DAY', 'DAY_ALREADY_CLOSED']).toContain(err(r).code);
    for (const book of ['shop', 'telecom', 'icecream']) {
      const closedAt = sql(s, 'SELECT closed_at FROM daily_closings WHERE book = ? AND business_date = ?', book, C())[0]!.closed_at as string;
      expect(num(s, 'SELECT COUNT(*) FROM cash_entries WHERE book = ? AND business_date <= ? AND posted_at > ?', book, C(), closedAt), book).toBe(0);
    }
    // Ice Cream records dated <= C: none posted after the closing
    const iceClosedAt = sql(s, "SELECT closed_at FROM daily_closings WHERE book = 'icecream'")[0]!.closed_at as string;
    expect(num(s, 'SELECT COUNT(*) FROM icecream_payments WHERE business_date <= ? AND posted_at > ?', C(), iceClosedAt)).toBe(0);
    expect(num(s, 'SELECT COUNT(*) FROM icecream_fund_moves WHERE business_date <= ? AND posted_at > ?', C(), iceClosedAt)).toBe(0);
    expect(closedSnapshotViolations(s)).toEqual([]);
  });
});
void openNew; void M;
