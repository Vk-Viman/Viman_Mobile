// Phase 19 audit, part D (ordering of void checks): API_CONTRACTS "Voids check DAY_CLOSED right after the record lookup, before ALREADY_VOID".
// For every operation that has a void: create a record dated on day C, void it while C is open, CLOSE C, void it AGAIN -> the answer must be
// DAY_CLOSED (closed-day check before ALREADY_VOID). Documented exceptions are pinned explicitly:
//   - sales-return void (R-VR order): ALREADY_VOID comes first; stocktake void (only a COMPLETED stocktake is judged): ALREADY_VOID first;
//   - Ice Cream daily entry void is addressed by DATE, and a voided entry no longer exists as "the posted entry of that date": 404 NOT_FOUND.
// Also: the same on a date EARLIER than a closed day (BACKDATE_BEFORE_CLOSED_DAY before ALREADY_VOID) and nothing is written.

import { afterEach, describe, expect, it } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { err } from './helpers/phase4.ts';
import { C, E, allOps, backdateBody, closeBooks, dayClosedBody, fullSnapshot, must, setupFx } from './helpers/phase19cd.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

const ops = allOps().filter((o) => o.void && !o.single);

describe.each(ops)('void order - $key', (op) => {
  it('second void on a closed day -> DAY_CLOSED, on an earlier day -> BACKDATE_BEFORE_CLOSED_DAY (before ALREADY_VOID)', async () => {
    const book = op.books[0]!;
    const fx = await setupFx(env, op);
    const s = fx.s;
    const recC = must(await op.create(fx, C()));
    const recE = must(await op.create(fx, E()));
    must(await op.void!(fx, recC, C(), book));
    must(await op.void!(fx, recE, E(), book));
    await closeBooks(s, [book], C());
    const snap = fullSnapshot(s, op.omit ?? []);
    const again = await op.void!(fx, recC, C(), book);
    const againE = await op.void!(fx, recE, E(), book);
    expect(again.status, JSON.stringify(again.body)).toBeGreaterThanOrEqual(400);
    if (op.key.startsWith('sale return') || op.key.startsWith('stocktake')) {
      // sales-return void: documented R-VR order (ALREADY_VOID first). Stocktake void (observation S-4, Low): the closed-day check runs only for a
      // COMPLETED stocktake, so a stocktake that is already void answers ALREADY_VOID on a closed day (nothing is written either way)
      expect(err(again).code).toBe('ALREADY_VOID');
      expect(err(againE).code).toBe('ALREADY_VOID');
    } else if (op.key === 'ice cream daily entry (create)') {
      expect(err(again).code).toBe('NOT_FOUND');
    } else {
      expect(err(again)).toEqual(dayClosedBody(book, C()));
      expect(err(againE)).toEqual(backdateBody(book, C(), E()));
    }
    expect(fullSnapshot(s, op.omit ?? [])).toEqual(snap);
  });
});
