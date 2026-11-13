// Phase 19 audit (A, backups): POST /backups and POST /backups/restore are not record writes and are not judged by closed days, but a RESTORE
// replaces the whole database, closings included. Characterization:
//   - a backup taken BEFORE a day was closed brings that day back OPEN after the restore (the closing disappears together with every record
//     made after the backup: the books stay consistent with each other; the restore itself is audited and a pre-restore safety copy is kept);
//   - a backup taken AFTER the closing brings the closed day back CLOSED, and the protection applies again at once (BACKDATE / DAY_CLOSED);
//   - a closed day does not block creating a backup, and a backup of a closed day is unaffected by later writes.

import { afterEach, describe, expect, it } from 'vitest';
import { TestEnv } from './helpers/tmp.ts';
import { post } from './helpers/catalog.ts';
import { apiBase } from './helpers/inventory.ts';
import { err, sql } from './helpers/phase4.ts';
import { drawCash } from './helpers/phase9.ts';
import { C, E, L, backdateBody, closeBooks, closedSnapshotViolations, dayClosedBody, must } from './helpers/phase19cd.ts';

const env = new TestEnv();
afterEach(async () => { await env.cleanup(); });

describe('restore and closed days', () => {
  it('an older backup (taken before the closing) restores the day as OPEN; the restore is audited; books stay consistent', async () => {
    const s = await apiBase(await env.build());
    must(await drawCash(s, { businessDate: E(), amountCents: 100 }));
    const b1 = await post(s.app, '/backups', {});
    expect(b1.status).toBe(201);
    await closeBooks(s, ['shop'], C());
    expect(err(await drawCash(s, { businessDate: E() })).code).toBe('BACKDATE_BEFORE_CLOSED_DAY');
    // a closed day does not block creating a backup
    expect((await post(s.app, '/backups', {})).status).toBe(201);

    const r = await post(s.app, '/backups/restore', { name: b1.body.item.name, confirm: 'RESTORE' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(sql(s, 'SELECT COUNT(*) AS n FROM daily_closings')[0]!.n).toBe(0);
    expect(sql(s, "SELECT COUNT(*) AS n FROM audit_logs WHERE entity = 'backup' AND action = 'restore'")[0]!.n).toBe(1);
    // the old closing is gone: E and C are open days again
    expect((await drawCash(s, { businessDate: E() })).status).toBe(201);
    expect((await drawCash(s, { businessDate: C() })).status).toBe(201);
    expect(closedSnapshotViolations(s)).toEqual([]);
  });

  it('a newer backup (taken after the closing) restores the day as CLOSED and the protection applies at once', async () => {
    const s = await apiBase(await env.build());
    must(await drawCash(s, { businessDate: E(), amountCents: 100 }));
    await closeBooks(s, ['shop'], C());
    const b = await post(s.app, '/backups', {});
    expect(b.status).toBe(201);
    // after the backup the day is reopened and written to
    const closing = sql(s, 'SELECT id FROM daily_closings')[0]!;
    must(await post(s.app, `/daily-closings/${closing.id}/reopen`, { reason: 'after backup' }));
    must(await drawCash(s, { businessDate: C(), amountCents: 500 }));
    const r = await post(s.app, '/backups/restore', { name: b.body.item.name, confirm: 'RESTORE' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(err(await drawCash(s, { businessDate: C() }))).toEqual(dayClosedBody('shop', C()));
    expect(err(await drawCash(s, { businessDate: E() }))).toEqual(backdateBody('shop', C(), E()));
    expect((await drawCash(s, { businessDate: L() })).status).toBe(201);
    expect(closedSnapshotViolations(s)).toEqual([]);
  });
});
