// Package I (3/3): the RESTORE FLOW end to end with segment data, through the real HTTP API (pattern of phase22-restore-flow).
// A backup whose Telecom segments were corrupted is refused 422 RESTORE_INVALID, the live database does not change (except one audit row
// `restore_refused`), while valid backups (a current-schema backup with real segments, the frozen schema-23 fixture) still restore.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, ref, today } from './helpers/inventory.ts';
import type { ApiBase } from './helpers/inventory.ts';
import { call, get } from './helpers/catalog.ts';
import { buildMultipart } from './helpers/multipart.ts';
import type { Part } from './helpers/multipart.ts';
import { diffSnapshots, snapshotAll } from './helpers/phase14.ts';
import { damagedCopy, diffExceptRefusalAudit, refusalRows, strayTempFiles } from './helpers/phase22rs.ts';
import { buildSegWorld, removeFolder, workFolder } from './helpers/phase26i.ts';
import type { SegWorld } from './helpers/phase26i.ts';
import { createBackup } from '../services/backup.service.ts';
import { validateDatabase } from '../services/database-validation.ts';
import { latestVersion } from '../db/migrate.ts';

const env = new TestEnv();
let s: ApiBase;
let work = '';
let goodName = '';
let goodPath = '';
let goodSnap: Record<string, string> = {};
let world: SegWorld;
let seq = 0;

const upload = (app: FastifyInstance, content: Buffer, name = 'candidate.db') => {
  const parts: Part[] = [{ name: 'confirm', value: 'RESTORE' }, { name: 'file', filename: name, content }];
  const { payload, headers } = buildMultipart(parts);
  return app.inject({ method: 'POST', url: '/api/v1/backups/restore', payload, headers });
};
const restoreByName = (app: FastifyInstance, name: string) => app.inject({ method: 'POST', url: '/api/v1/backups/restore', payload: { name, confirm: 'RESTORE' } });
const safetyCopies = (): string[] => readdirSync(s.ctx.backupsDir).filter((n) => /-pre-restore/.test(n)).sort();
const damaged = (fn: (db: DatabaseSync) => void): string => damagedCopy(goodPath, join(work, `x${++seq}.db`), fn);
const addExpense = async (amountCents: number, segment = 'dialog_reloads') => call(s.app, 'POST', '/expenses', {
  businessDate: today(), book: 'telecom', segment, category: 'internet', amountCents, description: 'p26i marker', clientRef: ref(),
});
const sumExpenses = (): number => Number((s.ctx.database.conn.prepare('SELECT COALESCE(SUM(amount_cents),0) AS t FROM expenses').get() as { t: number }).t);
const checkpoint = (): void => { s.ctx.database.conn.exec('PRAGMA wal_checkpoint(TRUNCATE)'); };

beforeAll(async () => {
  s = await apiBase(await env.build());
  world = await buildSegWorld(s);
  work = workFolder('viman-p26if-');
  goodName = createBackup(s.ctx, 'manual', new Date('2026-03-01T00:00:00Z')).name;
  goodPath = join(s.ctx.backupsDir, goodName);
  goodSnap = snapshotAll(s.ctx);
}, 240000);
afterEach(async () => { await new Promise((r) => setTimeout(r, 0)); });
afterAll(async () => { await env.cleanup(); removeFolder(work); });

describe('a backup whose segments were corrupted is refused', () => {
  /** Each corruption is reported by the `segments` check (the refusal is due to the new validator; a ledger or total failure may accompany it). */
  const cases: [string, (db: DatabaseSync) => void, RegExp][] = [
    ['a cash entry moved to another segment than its record', (db) => db.exec(`UPDATE cash_entries SET segment = 'hutch_cards' WHERE ref_table = 'expenses' AND ref_id = ${world.records.expenseAirtel} AND reverses_entry_id IS NULL`),
      /cash entries whose segment differs from the record they belong to \(1 record\)/],
    ['a reload record in another provider\'s segment', (db) => db.exec(`UPDATE reload_sales SET segment = 'airtel_reloads' WHERE id = ${world.records.reloadDialog}`),
      /reload, EZCash or top-up records whose segment is not their provider's/],
    ['a sale whose segment differs from its cards', (db) => db.exec(`UPDATE sales SET segment = 'mobitel_cards' WHERE id = ${world.sales.airtelVoided}`),
      /records whose segment differs from the segment of the products on them \(1 record\)/],
  ];

  it.each(cases)('%s: 422 RESTORE_INVALID listing the failed check in plain words; the live database is unchanged except ONE audit row', async (_n, fn, message) => {
    const bad = damaged(fn);
    await addExpense(1234 + seq);
    checkpoint();
    const before = snapshotAll(s.ctx);
    const safetyBefore = safetyCopies();
    const rowsBefore = refusalRows(s.ctx).length;
    const sumBefore = sumExpenses();
    const r = await upload(s.app, readFileSync(bad), 'bad-segments.db');
    expect(r.statusCode).toBe(422);
    const e = r.json().error;
    expect(e.code).toBe('RESTORE_INVALID');
    expect(e.message).toBe('This backup was not restored because it failed its safety checks. Your current data was not changed.');
    const codes = [...new Set((e.failures as { code: string }[]).map((f) => f.code))];
    expect(codes).toContain('segments');
    const msgs = (e.failures as { code: string; message: string }[]).filter((x) => x.code === 'segments').map((x) => x.message);
    for (const m of msgs) expect(m).toMatch(/^The Telecom segments in the file are inconsistent: /);
    expect(msgs.some((m) => message.test(m)), JSON.stringify(msgs)).toBe(true);
    expect(JSON.stringify(e)).not.toMatch(/node:|\.ts:|SQLITE_|stack/);
    // nothing changed
    expect(diffExceptRefusalAudit(before, s.ctx)).toEqual([]);
    expect(sumExpenses()).toBe(sumBefore);
    expect(safetyCopies()).toEqual(safetyBefore);
    expect(strayTempFiles(s.ctx.dataDir)).toEqual([]);
    expect(s.ctx.isRestoring).toBe(false);
    // audit row restore_refused with the failed check codes
    const audit = refusalRows(s.ctx);
    expect(audit.length).toBe(rowsBefore + 1);
    const after = JSON.parse(audit.at(-1)!.after_json);
    expect(after.errorCode).toBe('RESTORE_INVALID');
    expect(after.failedChecks).toContain('segments');
    expect(audit.at(-1)!.entity_id).toBe('upload:bad-segments.db');
  });

  it('a Telecom row without a segment (a table CHECK also sees it) is refused as well and changes nothing', async () => {
    const bad = damaged((db) => db.exec('UPDATE daily_closings SET segment = NULL WHERE id = (SELECT MIN(id) FROM daily_closings WHERE book = \'telecom\')'));
    checkpoint();
    const before = snapshotAll(s.ctx);
    const r = await upload(s.app, readFileSync(bad), 'no-segment.db');
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('RESTORE_INVALID');
    expect(diffExceptRefusalAudit(before, s.ctx)).toEqual([]);
  });

  it('the same refusal for a named backup in the backups folder, and the app stays fully usable afterwards', async () => {
    const name = 'viman-20250101-000000-manual.db';
    copyFileSync(damaged((db) => db.exec(`UPDATE reload_sales SET segment = 'airtel_reloads' WHERE id = ${world.records.reloadHutch}`)), join(s.ctx.backupsDir, name));
    const r = await restoreByName(s.app, name);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('RESTORE_INVALID');
    expect(refusalRows(s.ctx).at(-1)!.entity_id).toBe(name);
    expect((await addExpense(4321, 'mobitel_cards')).status).toBe(201);
    expect((await get(s.app, '/dashboard')).status).toBe(200);
    expect(validateDatabase(s.ctx.database.conn).failures).toEqual([]);
  });
});

describe('valid backups still restore', () => {
  it('a current-schema backup with real segments restores by name with the same figures, then the live database validates', async () => {
    await addExpense(999, 'hutch_cards');
    const r = await restoreByName(s.app, goodName);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().schemaVersion).toBe(latestVersion());
    expect(diffSnapshots(goodSnap, snapshotAll(s.ctx))).toEqual(['audit_logs']);
    expect(validateDatabase(s.ctx.database.conn).failures).toEqual([]);
    expect(strayTempFiles(s.ctx.dataDir)).toEqual([]);
  });

  it('after a refused attempt the same good file restores fine', async () => {
    const bad = damaged((db) => db.exec(`UPDATE ezcash_sales SET segment = 'mobitel_reloads' WHERE id = ${world.records.ezcash}`));
    expect((await upload(s.app, readFileSync(bad), 'bad.db')).statusCode).toBe(422);
    const r = await upload(s.app, readFileSync(goodPath), 'good.db');
    expect(r.statusCode, r.body).toBe(200);
    expect(diffSnapshots(goodSnap, snapshotAll(s.ctx))).toEqual(['audit_logs']);
  });

  it('the frozen schema-23 fixture (legacy Telecom) is upgraded by the restore: legacy rows kept, the validation passes, new segment work is possible', async () => {
    const r = await upload(s.app, readFileSync(join(import.meta.dirname, 'fixtures', 'schema23-world.db')), 'schema23.db');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().schemaVersion).toBe(latestVersion());
    const conn = s.ctx.database.conn;
    const n = (sql: string): number => Number(Object.values(conn.prepare(sql).get() as Record<string, unknown>)[0]);
    expect(n("SELECT COUNT(*) FROM cash_entries WHERE book = 'telecom' AND segment = 'legacy'")).toBeGreaterThan(0);
    expect(n("SELECT COUNT(*) FROM cash_entries WHERE book = 'telecom' AND segment <> 'legacy'")).toBe(0);
    expect(validateDatabase(conn).failures).toEqual([]);
    expect((await addExpense(500, 'dialog_cards')).status).toBe(201);
    expect(validateDatabase(conn).failures).toEqual([]);
    // put the world back
    expect((await restoreByName(s.app, goodName)).statusCode).toBe(200);
  });
});
