// Phase 19 audit, part B: the closed-day matrix over EVERY financial write of API_CONTRACTS (BUSINESS_RULES section 8 + R9; migration 016).
// Own script (not the phase 16 one). For each operation of the registry (helpers/phase19cd.ts), per book it touches:
//   world:  a record dated E (open, earlier) and one dated C exist; M and C are then CLOSED in the book (the other books of a transfer / cart stay open)
//   1. create dated E  -> 409 BACKDATE_BEFORE_CLOSED_DAY (error.book, error.closedDate = C = the LATEST closed day, error.businessDate = E, exact message)
//   2. create dated M and C -> 409 DAY_CLOSED (error.book, error.businessDate)
//   3. void of the record dated E -> BACKDATE; void of the record dated C -> DAY_CLOSED (the reversal would copy that date)
//   4. every refusal wrote NOTHING: fullSnapshot (all tables incl. audit_logs, hashed rows) is identical before and after
//   5. create dated L (later) is accepted and so is its void
//   6. reopen: E and C accepted again (creates and voids); re-close: refused again (same row re-closed)
// and a second script: closed days in the OTHER books never block the operation.

import { afterEach, describe, expect, it } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { err } from './helpers/phase4.ts';
import {
  C, E, L, M, ALL_BOOKS, allOps, backdateBody, closeBooks, dayClosedBody, fullSnapshot, must, ok, recloseAll, reopenAll, setupFx,
} from './helpers/phase19cd.ts';
import type { Book, Fx, Op } from './helpers/phase19cd.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

const ops = allOps();

/** Voids through the registry (a few operations vote for the book they void). */
const voidIt = (op: Op, fx: Fx, rec: any, date: string, focus: Book) => op.void!(fx, rec, date, focus);

describe.each(ops)('closed-day matrix - $key', (op) => {
  const snap = (s: Fx['s']) => ({
    ...fullSnapshot(s, op.omit ?? []),
    // a stocktake DRAFT may be saved (it posts nothing); every OTHER audit row must be unchanged
    ...(op.omit ? { auditOther: String(s.ctx.database.conn.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE NOT (entity = 'stocktake' AND action = 'create')").get()!.n) } : {}),
  });
  it.each(op.books)('closed book = %s: BACKDATE before the latest closed day, DAY_CLOSED on closed days, later dates fine, reopen / re-close', async (closedBook) => {
    const fx = await setupFx(env, op);
    const s = fx.s;
    // records that exist BEFORE anything is closed
    const recE = must(await op.create(fx, E()));
    const recC = op.single ? undefined : must(await op.create(fx, C()));

    // M (earlier) then C (the latest) get closed in the book under test
    const closeM = await closeBooks(s, [closedBook], M());
    const closeC = await closeBooks(s, [closedBook], C());

    const before = snap(s);

    // 1. dated E: earlier than the latest closed day C
    const r1 = await op.create(fx, E());
    expect(r1.status, JSON.stringify(r1.body)).toBe(409);
    expect(err(r1)).toEqual(backdateBody(closedBook, C(), E()));
    expect(snap(s)).toEqual(before);

    // 2. exactly on a closed day: DAY_CLOSED (both closed days)
    for (const d of [M(), C()]) {
      const r = await op.create(fx, d);
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(err(r)).toEqual(dayClosedBody(closedBook, d));
    }
    expect(snap(s)).toEqual(before);

    // 3. voids judged on the record's own date
    if (op.void) {
      const vE = await voidIt(op, fx, recE, E(), closedBook);
      expect(vE.status, JSON.stringify(vE.body)).toBe(409);
      expect(err(vE)).toEqual(backdateBody(closedBook, C(), E()));
      if (recC) {
        const vC = await voidIt(op, fx, recC, C(), closedBook);
        expect(vC.status, JSON.stringify(vC.body)).toBe(409);
        expect(err(vC)).toEqual(dayClosedBody(closedBook, C()));
      }
      expect(snap(s)).toEqual(before);
    }

    // 5. a later date is accepted, and its void too (a record after every closed day changes no closed day)
    if (!op.single) {
      const recL = must(await op.create(fx, L()));
      if (op.void) must(await voidIt(op, fx, recL, L(), closedBook));
    }

    // 6a. reopening both closed days: E and C are plain open days again
    await reopenAll(s, { ...closeC, M: closeM[closedBook] });
    if (op.void) {
      must(await voidIt(op, fx, recE, E(), closedBook));
      if (recC) must(await voidIt(op, fx, recC, C(), closedBook));
    }
    const newE = must(await op.create(fx, E()));
    const newC = op.single ? undefined : must(await op.create(fx, C()));

    // 6b. closing again protects E and C again (the re-close reuses the closing rows)
    await recloseAll(s, closeC, C());
    await recloseAll(s, { [closedBook]: closeM[closedBook] }, M());
    const before2 = snap(s);
    const b = await op.create(fx, E());
    expect(b.status, JSON.stringify(b.body)).toBe(409);
    expect(err(b)).toEqual(backdateBody(closedBook, C(), E()));
    if (!op.single) expect(err(await op.create(fx, C()))).toEqual(dayClosedBody(closedBook, C()));
    if (op.void) {
      const v = await voidIt(op, fx, newE, E(), closedBook);
      expect(err(v)).toEqual(backdateBody(closedBook, C(), E()));
      if (newC) expect(err(await voidIt(op, fx, newC, C(), closedBook))).toEqual(dayClosedBody(closedBook, C()));
    }
    expect(snap(s)).toEqual(before2);
  });

  it('closed days of books the operation does NOT touch never block it', async () => {
    const fx = await setupFx(env, op);
    const s = fx.s;
    const others = ALL_BOOKS.filter((b) => !op.books.includes(b));
    expect(others.length).toBeGreaterThan(0);
    await closeBooks(s, others, M());
    await closeBooks(s, others, C());
    const recE = must(await op.create(fx, E()));
    const recC = op.single ? undefined : must(await op.create(fx, C()));
    const recM = op.single || op.perDate ? undefined : must(await op.create(fx, M()));
    if (!op.single) must(await op.create(fx, L()));
    if (op.void) {
      must(await op.void(fx, recE, E(), op.books[0]!));
      if (recC) must(await op.void(fx, recC, C(), op.books[0]!));
      if (recM) must(await op.void(fx, recM, M(), op.books[0]!));
    }
    // the closed days really are closed (other books still refuse their own writes - sanity)
    const closed = await s.app.inject({ method: 'GET', url: `/api/v1/daily-closings/status?book=${others[0]}&businessDate=${C()}` });
    expect(closed.json().isClosed).toBe(true);
    expect(ok(recE)).toBe(true);
  });
});
