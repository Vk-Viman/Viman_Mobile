// Phase 19 audit, part A: INVENTORY of writes.
//  1. Every POST / PUT route registered in server/src/routes is read from the source and must appear in the classification table below
//     (financial = judged by the closed-day rules; nonfinancial / preview / admin = must NOT be blocked). A new endpoint added later fails
//     this test until it is classified (and, if financial, added to the matrix of phase19-closedday-matrix.test.ts).
//  2. Every financial endpoint names the registry operations (helpers/phase19cd.ts) that exercise it; the names must exist.
//  3. With EVERY book closed on a day, the non-financial writes (catalog, settings, providers, service types, backups, previews) are
//     still accepted, and a stocktake DRAFT can be saved/edited/cancelled (it posts nothing; only its completion is judged).

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { post, put } from './helpers/catalog.ts';
import { apiBase, daysAgo, mkProduct } from './helpers/inventory.ts';
import { err, stNew, stPut } from './helpers/phase4.ts';
import { xlsx, previewFile } from './helpers/phase13.ts';
import { C, E, ALL_BOOKS, allOps, closeBooks, fixture, fullSnapshot, ok } from './helpers/phase19cd.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

type Kind = 'financial' | 'closing' | 'nonfinancial' | 'preview' | 'admin';
/** key = "METHOD path" exactly as registered; ops = names (prefix match) of registry operations that exercise it. */
const TABLE: Record<string, { kind: Kind; ops?: string[]; note?: string }> = {
  // --- purchases / stock
  'POST /purchases': { kind: 'financial', ops: ['purchase (shop)', 'purchase (telecom)'] },
  'POST /purchases/:id/void': { kind: 'financial', ops: ['purchase (shop)', 'purchase (telecom)'] },
  'POST /purchases/:id/returns': { kind: 'financial', ops: ['purchase return (shop)', 'purchase return (telecom)'] },
  'POST /stock-losses': { kind: 'financial', ops: ['stock loss (shop)', 'stock loss (telecom)'] },
  'POST /stock-losses/:id/void': { kind: 'financial', ops: ['stock loss (shop)'] },
  'POST /stocktakes': { kind: 'nonfinancial', note: 'draft: no stock effect, not judged (finding S-2)' },
  'PUT /stocktakes/:id': { kind: 'nonfinancial', note: 'draft edit: no stock effect' },
  'POST /stocktakes/:id/complete': { kind: 'financial', ops: ['stocktake complete (shop)', 'stocktake complete (telecom)'] },
  'POST /stocktakes/:id/void': { kind: 'financial', ops: ['stocktake complete (shop)', 'stocktake complete (telecom)'] },
  'POST /drawings': { kind: 'financial', ops: ['goods drawing (shop)', 'goods drawing (telecom)', 'cash drawing (shop)', 'cash drawing (telecom)', 'cash drawing (icecream)'] },
  'POST /drawings/:id/void': { kind: 'financial', ops: ['goods drawing (shop)', 'cash drawing (shop)'] },
  'POST /opening-stock': { kind: 'financial', ops: ['opening stock manual (shop)', 'opening stock manual (telecom)', 'opening stock batch with a Shop and a Telecom product'] },
  'POST /opening-stock/:id/void': { kind: 'financial', ops: ['opening stock manual (shop)'] },
  'POST /excel/opening-stock/import': { kind: 'financial', ops: ['opening stock excel (shop)', 'opening stock excel (telecom)'] },
  'POST /excel/opening-stock/preview': { kind: 'preview' },
  // --- sales
  'POST /sales': { kind: 'financial', ops: ['sale (shop)', 'sale (telecom)', 'sale cart with a Shop and a Telecom line'] },
  'POST /sales/:id/void': { kind: 'financial', ops: ['sale (shop)', 'sale (telecom)'] },
  'POST /sales/:id/returns': { kind: 'financial', ops: ['sale return (shop)', 'sale return damaged (shop)', 'sale return (telecom)'] },
  'POST /sales/:id/returns/:returnId/void': { kind: 'financial', ops: ['sale return (shop)', 'sale return damaged (telecom)'] },
  // --- telecom / printing / expenses
  'POST /reload-sales': { kind: 'financial', ops: ['reload sale'] },
  'POST /reload-sales/:id/void': { kind: 'financial', ops: ['reload sale'] },
  'POST /ezcash-sales': { kind: 'financial', ops: ['EZCash bill'] },
  'POST /ezcash-sales/:id/void': { kind: 'financial', ops: ['EZCash bill'] },
  'POST /telecom/topups': { kind: 'financial', ops: ['provider top-up', 'wallet top-up'] },
  'POST /telecom/topups/:id/void': { kind: 'financial', ops: ['provider top-up', 'wallet top-up'] },
  'POST /print-sales': { kind: 'financial', ops: ['print sale'] },
  'POST /print-sales/:id/void': { kind: 'financial', ops: ['print sale'] },
  'POST /printing-supplies': { kind: 'financial', ops: ['printing supplies'] },
  'POST /printing-supplies/:id/void': { kind: 'financial', ops: ['printing supplies'] },
  'POST /expenses': { kind: 'financial', ops: ['expense (shop)', 'expense (telecom)'] },
  'POST /expenses/:id/void': { kind: 'financial', ops: ['expense (shop)', 'expense (telecom)'] },
  // --- cash books
  'POST /cashbooks/:book/opening': { kind: 'financial', ops: ['opening balance (shop)', 'opening balance (telecom)', 'opening balance (icecream)'] },
  'POST /capital': { kind: 'financial', ops: ['capital (shop)', 'capital (telecom)', 'capital (icecream)'] },
  'POST /capital-entries/:id/void': { kind: 'financial', ops: ['capital (shop)', 'opening balance (shop)'] },
  'POST /cash-counts': { kind: 'financial', ops: ['cash count with adjustment (shop)', 'cash count with adjustment (telecom)', 'cash count with adjustment (icecream)'] },
  'POST /cash-counts/:id/void': { kind: 'financial', ops: ['cash count with adjustment (shop)'] },
  'POST /cash-transfers': { kind: 'financial', ops: ['transfer shop -> telecom', 'transfer telecom -> shop', 'transfer shop -> icecream', 'transfer icecream -> shop', 'transfer telecom -> icecream', 'transfer icecream -> telecom'] },
  'POST /cash-transfers/:id/void': { kind: 'financial', ops: ['transfer shop -> telecom'] },
  'POST /daily-closings': { kind: 'closing', note: 'creates the lock; its optional count follows the count rules' },
  'POST /daily-closings/:id/reopen': { kind: 'closing' },
  // --- ice cream
  'POST /icecream/days': { kind: 'financial', ops: ['ice cream daily entry (create)'] },
  'PUT /icecream/days/:date': { kind: 'financial', ops: ['ice cream daily entry (replace)'] },
  'POST /icecream/days/:date/void': { kind: 'financial', ops: ['ice cream daily entry (create)'] },
  'POST /icecream/payments': { kind: 'financial', ops: ['ice cream payment (materials)', 'ice cream payment (electricity bill)', 'ice cream payment (other cost)'] },
  'POST /icecream/payments/:id/void': { kind: 'financial', ops: ['ice cream payment (materials)'] },
  'POST /icecream/fund-moves': { kind: 'financial', ops: ['ice cream fund move'] },
  'POST /icecream/fund-moves/:id/void': { kind: 'financial', ops: ['ice cream fund move'] },
  'POST /icecream/fund-moves/preview': { kind: 'preview' },
  // --- not financial
  'POST /categories': { kind: 'nonfinancial' }, 'PUT /categories/:id': { kind: 'nonfinancial' },
  'POST /products': { kind: 'nonfinancial' }, 'PUT /products/:id': { kind: 'nonfinancial' },
  'POST /suppliers': { kind: 'nonfinancial' }, 'PUT /suppliers/:id': { kind: 'nonfinancial' },
  'PUT /settings': { kind: 'nonfinancial' },
  'PUT /reload-providers/:id': { kind: 'nonfinancial' },
  'POST /print-service-types': { kind: 'nonfinancial' }, 'PUT /print-service-types/:id': { kind: 'nonfinancial' },
  'POST /backups': { kind: 'admin' }, 'PUT /backups/external': { kind: 'admin' }, 'POST /backups/external/copy': { kind: 'admin' },
  'POST /backups/restore': { kind: 'admin', note: 'replaces the whole database (closings included); not a record write' },
};

function registeredWrites(): string[] {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'routes');
  const out: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(/app\.(post|put|patch|delete)\(\s*'([^']+)'/g)) out.push(`${m[1]!.toUpperCase()} ${m[2]}`);
  }
  return out.sort();
}

describe('inventory of writes (every registered POST/PUT is classified)', () => {
  it('the route sources and the classification table agree exactly (no PATCH/DELETE exists)', () => {
    const found = registeredWrites();
    expect(found.filter((r) => r.startsWith('DELETE') || r.startsWith('PATCH'))).toEqual([]);
    expect(found).toEqual(Object.keys(TABLE).sort());
  });

  it('every financial endpoint names registry operations that exist', () => {
    const keys = allOps().map((o) => o.key);
    for (const [route, v] of Object.entries(TABLE)) {
      if (v.kind !== 'financial') continue;
      expect(v.ops?.length, route).toBeGreaterThan(0);
      for (const name of v.ops!) expect(keys.some((k) => k === name), `${route} -> ${name}`).toBe(true);
    }
  });

  it('counts: 62 write routes, of which the financial ones are covered by the matrix', () => {
    const kinds = Object.values(TABLE).reduce<Record<string, number>>((a, v) => ({ ...a, [v.kind]: (a[v.kind] ?? 0) + 1 }), {});
    expect(Object.keys(TABLE).length).toBe(62);
    expect(kinds.financial).toBe(42);
  });
});

describe('non-financial writes are NOT blocked by closed days', () => {
  it('with Shop, Telecom and Ice Cream all closed on C (and a later day closed), catalog / settings / providers / service types / backups / previews work', async () => {
    const s = await apiBase(await env.build());
    const fx = await fixture(s);
    await closeBooks(s, ALL_BOOKS, C());
    await closeBooks(s, ALL_BOOKS, daysAgo(1));
    const out: Record<string, number> = {};
    const hit = async (name: string, r: { status: number; body: any }, want: number[]) => {
      out[name] = r.status;
      expect(want, `${name}: ${r.status} ${JSON.stringify(r.body)}`).toContain(r.status);
    };
    await hit('POST /categories', await post(s.app, '/categories', { name: 'Audit cat', book: 'shop' }), [201]);
    const cat = (await post(s.app, '/categories', { name: 'Audit cat 2', book: 'telecom' })).body.item;
    await hit('PUT /categories/:id', await put(s.app, `/categories/${cat.id}`, { name: 'Audit cat 3' }), [200]);
    const p = await mkProduct(s, { name: 'Audit product' });
    await hit('PUT /products/:id', await put(s.app, `/products/${p.id}`, { sellPriceCents: 120000 }), [200]);
    const sup = await post(s.app, '/suppliers', { name: 'Audit supplier' });
    await hit('POST /suppliers', sup, [201]);
    await hit('PUT /suppliers/:id', await put(s.app, `/suppliers/${sup.body.item.id}`, { phone: '0711111111' }), [200]);
    await hit('PUT /settings', await put(s.app, '/settings', { rates: { reloadCommissionBp: 600, ezcashCommissionBp: 80 } }), [200]);
    await hit('PUT /reload-providers/:id', await put(s.app, `/reload-providers/${fx.prov.Dialog}`, { commissionBp: 500, active: true }), [200]);
    await hit('POST /print-service-types', await post(s.app, '/print-service-types', { code: 'AUDIT_T', name: 'Audit type', priceCents: 1000, costCents: 100 }), [201]);
    await hit('POST /backups', await post(s.app, '/backups', {}), [201]);
    await hit('PUT /backups/external', await put(s.app, '/backups/external', { folder: null }), [200]);
    await hit('POST /icecream/fund-moves/preview', await post(s.app, '/icecream/fund-moves/preview', { fromFund: 'cost', toFund: 'profit', amountCents: 100 }), [200]);
    const file = await xlsx([[fx.osShop.code, fx.osShop.name, 1, 10, null, 'n']]);
    await hit('POST /excel/opening-stock/preview (closed date)', await previewFile(s, file, { date: C() }), [200]);
    expect(Object.keys(out).length).toBeGreaterThan(10);
  });

  it('a stocktake DRAFT dated on a closed day can be saved, edited and cancelled (nothing posted); completing it is DAY_CLOSED', async () => {
    const s = await apiBase(await env.build());
    const fx = await fixture(s);
    await closeBooks(s, ['shop'], C());
    const before = fullSnapshot(s, ['stocktakes', 'stocktake_items', 'audit_logs', 'sqlite_sequence']);
    const live = 2000;
    const d = await stNew(s, { businessDate: C(), items: [{ productId: fx.shopP.id, countedQty: live - 1 }] });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    const id = d.body.item.id;
    expect((await stPut(s, id, { notes: 'edited in a closed day' })).status).toBe(200);
    const e = await stNew(s, { businessDate: E(), items: [{ productId: fx.shopP.id, countedQty: live - 1 }] });
    expect(e.status).toBe(201); // earlier than the closed day: a draft is still allowed
    expect(fullSnapshot(s, ['stocktakes', 'stocktake_items', 'audit_logs', 'sqlite_sequence'])).toEqual(before); // no stock, no cash
    const done = await post(s.app, `/stocktakes/${id}/complete`, {});
    expect(done.status).toBe(409);
    expect(err(done).code).toBe('DAY_CLOSED');
    const doneE = await post(s.app, `/stocktakes/${e.body.item.id}/complete`, {});
    expect(err(doneE).code).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    // cancelling a draft needs no open day
    const v = await post(s.app, `/stocktakes/${id}/void`, { reason: 'cancel draft' });
    expect(ok(v)).toBe(true);
    expect(fullSnapshot(s, ['stocktakes', 'stocktake_items', 'audit_logs', 'sqlite_sequence'])).toEqual(before);
  });
});
