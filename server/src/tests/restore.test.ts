// Restore from backup (POST /backups/restore) - API level with real temp databases and files.
// Protects the most dangerous owner action: replacing live shop data with a backup. Rules covered: an explicit
// confirm word is required; the file must be a valid SQLite database with the expected tables and a schema version this
// app understands (older ones are upgraded, newer ones refused); a safety backup of the CURRENT data is always taken
// first; the audit log records the restore; if anything fails after the swap the previous data is put back (RESTORE_FAILED);
// while a restore runs every other /api request gets 503. Names are checked so a path like ../x can never escape the
// backups folder.
// Organised as: restore by name, older-version backup, restore by upload, rollback on failure, restore in progress.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { TestEnv } from './helpers/tmp.ts';
import { buildMultipart } from './helpers/multipart.ts';
import type { Part } from './helpers/multipart.ts';
import { createBackup } from '../services/backup.service.ts';
import { latestVersion, migrate, MIGRATIONS_DIR } from '../db/migrate.ts';

const env = new TestEnv();
afterEach(() => env.cleanup());

// Settings body that sets the two commission rates; rates are used as an easy visible "marker" of which data is live.
const rates = (a: number, b: number) => ({ rates: { reloadCommissionBp: a, ezcashCommissionBp: b } });
const putSettings = (app: FastifyInstance, body: unknown) =>
  app.inject({ method: 'PUT', url: '/api/v1/settings', payload: body as object });
const getSettings = async (app: FastifyInstance) =>
  (await app.inject({ method: 'GET', url: '/api/v1/settings' })).json();
const restoreJson = (app: FastifyInstance, body: unknown) =>
  app.inject({ method: 'POST', url: '/api/v1/backups/restore', payload: body as object });
const restoreUpload = (app: FastifyInstance, parts: Part[]) => {
  const { payload, headers } = buildMultipart(parts);
  return app.inject({ method: 'POST', url: '/api/v1/backups/restore', payload, headers });
};
// Lists temp files a restore must never leave behind (candidate, upload and rollback files).
const leftovers = (dataDir: string) =>
  readdirSync(dataDir).filter((f) => f.startsWith('restore-candidate') || f.startsWith('upload-') || f.startsWith('viman.db.rollback'));

// (Marker idea: backup = rates 111/11, live data = 222/22, so after a restore the rates tell us which data we have.)
/** App with live rates 222/22, plus a manual backup that holds rates 111/11. */
async function setup() {
  const b = await env.build();
  await putSettings(b.app, rates(111, 11));
  const backup = createBackup(b.ctx, 'manual', new Date('2026-03-01T00:00:00Z'));
  await putSettings(b.app, rates(222, 22));
  return { ...b, backup, backupPath: join(b.dataDir, 'backups', backup.name) };
}

// Creates a standalone SQLite file for upload tests (valid, corrupt or incomplete, depending on setupFn).
function makeDbFile(dir: string, name: string, setupFn: (db: DatabaseSync) => void): string {
  const p = join(dir, name);
  const db = new DatabaseSync(p);
  try { setupFn(db); } finally { db.close(); }
  return p;
}

// Restoring one of the backups already in the backups folder.
describe('restore by name', () => {
  // After restore the old marker rates are back, a pre-restore safety copy of the replaced data exists, and one audit row records it.
  it('restores the named backup, writes a safety backup and an audit row', async () => {
    const { app, ctx, dataDir, backup } = await setup();
    const res = await restoreJson(app, { name: backup.name, confirm: 'RESTORE' });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.restoredFrom).toBe(backup.name);
    expect(b.schemaVersion).toBe(latestVersion());
    expect(b.safetyBackup).toMatch(/-pre-restore(-\d+)?\.db$/);
    const safetyPath = join(dataDir, 'backups', b.safetyBackup);
    expect(existsSync(safetyPath)).toBe(true);

    expect((await getSettings(app)).rates).toEqual({ reloadCommissionBp: 111, ezcashCommissionBp: 11 });

    // safety backup holds the pre-restore (222/22) values
    const sdb = new DatabaseSync(safetyPath, { readOnly: true });
    try {
      const row = sdb.prepare("SELECT value_json FROM settings WHERE key='rates'").get() as { value_json: string };
      expect(JSON.parse(row.value_json)).toEqual({ reloadCommissionBp: 222, ezcashCommissionBp: 22 });
    } finally { sdb.close(); }

    // listed as pre-restore
    const list = (await app.inject({ method: 'GET', url: '/api/v1/backups' })).json().items;
    expect(list.find((i: { name: string }) => i.name === b.safetyBackup).reason).toBe('pre-restore');

    // audit row
    const audit = (await app.inject({ method: 'GET', url: '/api/v1/audit-logs?entity=backup' })).json().items;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entity: 'backup', action: 'restore', entityId: backup.name });
    expect(audit[0].after).toMatchObject({ restoredFrom: backup.name, safetyBackup: b.safetyBackup, schemaVersion: latestVersion() });

    expect(ctx.isRestoring).toBe(false);
    expect(leftovers(dataDir)).toEqual([]);
  });

  // The database file was swapped underneath the app; the connection must be reopened so new saves work and persist.
  it('writes work after a restore (connection reopened) and survive another rebuild', async () => {
    const { app, dataDir, backup } = await setup();
    expect((await restoreJson(app, { name: backup.name, confirm: 'RESTORE' })).statusCode).toBe(200);
    const res = await putSettings(app, rates(333, 33));
    expect(res.statusCode).toBe(200);
    expect(res.json().rates).toEqual({ reloadCommissionBp: 333, ezcashCommissionBp: 33 });
    expect((await app.inject({ method: 'POST', url: '/api/v1/backups' })).statusCode).toBe(201);
    await app.close();
    const again = await env.build({ dataDir });
    expect((await getSettings(again.app)).rates).toEqual({ reloadCommissionBp: 333, ezcashCommissionBp: 33 });
  });

  // The word RESTORE must be sent exactly; a missing, wrong, empty or non-text confirmation is refused and live data stays unchanged.
  it.each([
    ['confirm missing', (n: string) => ({ name: n })],
    ['confirm wrong', (n: string) => ({ name: n, confirm: 'restore' })],
    ['confirm empty', (n: string) => ({ name: n, confirm: '' })],
    ['confirm not a string', (n: string) => ({ name: n, confirm: true })],
  ])('400 RESTORE_CONFIRM_REQUIRED: %s (live data unchanged)', async (_l, mk) => {
    const { app, dataDir, backup } = await setup();
    const res = await restoreJson(app, mk(backup.name));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('RESTORE_CONFIRM_REQUIRED');
    expect((await getSettings(app)).rates).toEqual({ reloadCommissionBp: 222, ezcashCommissionBp: 22 });
    expect(leftovers(dataDir)).toEqual([]);
    expect(readdirSync(join(dataDir, 'backups')).filter((f) => f.includes('pre-restore'))).toEqual([]);
  });

  it.each(['../x', '..\\x', 'viman-20260101-000000-manual.db/../../x', 'nope.db', '', 'C:\\x.db'])(
    '400 VALIDATION_ERROR for bad name %j', async (name) => {
      const { app, dataDir } = await setup();
      const res = await restoreJson(app, { name, confirm: 'RESTORE' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect(Object.keys(res.json().error.fields)).toContain('name');
      expect((await getSettings(app)).rates).toEqual({ reloadCommissionBp: 222, ezcashCommissionBp: 22 });
      expect(leftovers(dataDir)).toEqual([]);
    });

  it('400 VALIDATION_ERROR when name is missing or body is absent', async () => {
    const { app } = await setup();
    const r1 = await restoreJson(app, { confirm: 'RESTORE' });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error.code).toBe('VALIDATION_ERROR');
    const r2 = await app.inject({ method: 'POST', url: '/api/v1/backups/restore' });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('404 BACKUP_NOT_FOUND for a well-formed unknown name', async () => {
    const { app, dataDir } = await setup();
    const res = await restoreJson(app, { name: 'viman-20200101-000000-manual.db', confirm: 'RESTORE' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('BACKUP_NOT_FOUND');
    expect((await getSettings(app)).rates).toEqual({ reloadCommissionBp: 222, ezcashCommissionBp: 22 });
    expect(leftovers(dataDir)).toEqual([]);
  });
});

// Old backups must stay usable after the app is upgraded.
describe('restore of an older (version 1) backup', () => {
  function v1Backup(): string {
    const dir = env.newDir();
    const mdir = env.newDir();
    writeFileSync(join(mdir, '001_foundation.sql'), readFileSync(join(MIGRATIONS_DIR, '001_foundation.sql'), 'utf8'));
    return makeDbFile(dir, 'v1.db', (db) => {
      expect(migrate(db, mdir).version).toBe(1);
      db.prepare("INSERT INTO settings (key, value_json) VALUES ('rates', ?)")
        .run(JSON.stringify({ reloadCommissionBp: 444, ezcashCommissionBp: 44 }));
    });
  }
  const triggers = (ctx: { database: { conn: DatabaseSync } }) =>
    (ctx.database.conn.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]).map((t) => t.name);

  it('upload: succeeds, upgraded to latest, data kept, triggers present, no temp files', async () => {
    const { app, ctx, dataDir } = await setup();
    const res = await restoreUpload(app, [
      { name: 'confirm', value: 'RESTORE' },
      { name: 'file', filename: 'v1.db', content: readFileSync(v1Backup()) },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json().schemaVersion).toBe(latestVersion());
    expect((await getSettings(app)).rates).toEqual({ reloadCommissionBp: 444, ezcashCommissionBp: 44 });
    expect(triggers(ctx)).toEqual(expect.arrayContaining(['audit_logs_no_update', 'audit_logs_no_delete']));
    expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).json().schemaVersion).toBe(latestVersion());
    expect(leftovers(dataDir)).toEqual([]);
    expect((await putSettings(app, rates(1, 2))).statusCode).toBe(200);
  });

  it('named: a v1 file placed in backups restores to latest', async () => {
    const { app, dataDir } = await setup();
    const name = 'viman-20250101-000000-manual.db';
    copyFileSync(v1Backup(), join(dataDir, 'backups', name));
    const res = await restoreJson(app, { name, confirm: 'RESTORE' });
    expect(res.statusCode).toBe(200);
    expect(res.json().schemaVersion).toBe(latestVersion());
    expect((await getSettings(app)).rates).toEqual({ reloadCommissionBp: 444, ezcashCommissionBp: 44 });
    expect(leftovers(dataDir)).toEqual([]);
  });
});

// Restoring from a file the owner picks (e.g. from a USB stick); every kind of bad file must be refused safely.
describe('restore by upload', () => {
  it('valid uploaded backup restores; restoredFrom is upload:<filename>', async () => {
    const { app, dataDir, backupPath } = await setup();
    const res = await restoreUpload(app, [
      { name: 'confirm', value: 'RESTORE' },
      { name: 'file', filename: 'my-shop.db', content: readFileSync(backupPath) },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json().restoredFrom).toBe('upload:my-shop.db');
    expect(res.json().schemaVersion).toBe(latestVersion());
    expect(res.json().safetyBackup).toMatch(/-pre-restore/);
    expect((await getSettings(app)).rates).toEqual({ reloadCommissionBp: 111, ezcashCommissionBp: 11 });
    expect(leftovers(dataDir)).toEqual([]);
    const audit = (await app.inject({ method: 'GET', url: '/api/v1/audit-logs?entity=backup' })).json().items;
    expect(audit[0].entityId).toBe('upload:my-shop.db');
  });

  it('file part before confirm part also works', async () => {
    const { app, backupPath } = await setup();
    const res = await restoreUpload(app, [
      { name: 'file', filename: 'b.db', content: readFileSync(backupPath) },
      { name: 'confirm', value: 'RESTORE' },
    ]);
    expect(res.statusCode).toBe(200);
  });

  async function expectRejected(parts: Part[], status: number, codes: string[]) {
    const { app, dataDir } = await setup();
    const res = await restoreUpload(app, parts);
    expect(res.statusCode).toBe(status);
    expect(codes).toContain(res.json().error.code);
    expect((await getSettings(app)).rates).toEqual({ reloadCommissionBp: 222, ezcashCommissionBp: 22 });
    expect(leftovers(dataDir)).toEqual([]);
    expect(readdirSync(join(dataDir, 'backups')).filter((f) => f.includes('pre-restore'))).toEqual([]);
    // live DB still writable
    expect((await putSettings(app, rates(5, 5))).statusCode).toBe(200);
    return res;
  }

  // A non-database file is refused before touching live data.
  it('junk text file -> 422 RESTORE_INVALID_FILE', async () => {
    await expectRejected([
      { name: 'confirm', value: 'RESTORE' },
      { name: 'file', filename: 'notes.db', content: Buffer.from('this is definitely not sqlite, just text '.repeat(50)) },
    ], 422, ['RESTORE_INVALID_FILE']);
  });

  it('short file (< 16 bytes) -> 422 RESTORE_INVALID_FILE', async () => {
    await expectRejected([
      { name: 'confirm', value: 'RESTORE' },
      { name: 'file', filename: 'tiny.db', content: Buffer.from('SQLite') },
    ], 422, ['RESTORE_INVALID_FILE']);
  });

  // A file that looks like SQLite but is damaged inside fails the integrity check and is refused.
  it('valid header but corrupted pages -> 422 integrity/invalid', async () => {
    const { app, dataDir, backupPath } = await setup();
    const good = readFileSync(backupPath);
    const bad = Buffer.from(good);
    // keep page 1 (header + schema) but trash everything after it
    bad.fill(0xab, Math.min(4096, bad.length - 1) + 16, bad.length);
    expect(bad.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\u0000');
    const res = await restoreUpload(app, [
      { name: 'confirm', value: 'RESTORE' },
      { name: 'file', filename: 'corrupt.db', content: bad },
    ]);
    expect(res.statusCode).toBe(422);
    expect(['RESTORE_INTEGRITY_FAILED', 'RESTORE_INVALID_FILE']).toContain(res.json().error.code);
    expect((await getSettings(app)).rates).toEqual({ reloadCommissionBp: 222, ezcashCommissionBp: 22 });
    expect(leftovers(dataDir)).toEqual([]);
  });

  it('valid header, middle bytes overwritten -> 422 integrity/invalid', async () => {
    const { app, dataDir, backupPath } = await setup();
    const bad = Buffer.from(readFileSync(backupPath));
    const mid = Math.floor(bad.length / 2);
    bad.fill(0x00, mid - 200, mid + 200);
    const res = await restoreUpload(app, [
      { name: 'confirm', value: 'RESTORE' },
      { name: 'file', filename: 'corrupt2.db', content: bad },
    ]);
    // A zeroed region may land on an unused page; only assert the outcome is safe either way.
    if (res.statusCode === 422) {
      expect(['RESTORE_INTEGRITY_FAILED', 'RESTORE_INVALID_FILE']).toContain(res.json().error.code);
      expect((await getSettings(app)).rates).toEqual({ reloadCommissionBp: 222, ezcashCommissionBp: 22 });
    } else {
      expect(res.statusCode).toBe(200);
    }
    expect(leftovers(dataDir)).toEqual([]);
  });

  it('SQLite db without the required tables -> 422 RESTORE_SCHEMA_MISSING', async () => {
    const tmp = env.newDir();
    const p = makeDbFile(tmp, 'other.db', (db) => db.exec('CREATE TABLE foo (id INTEGER); INSERT INTO foo VALUES (1);'));
    await expectRejected([
      { name: 'confirm', value: 'RESTORE' },
      { name: 'file', filename: 'other.db', content: readFileSync(p) },
    ], 422, ['RESTORE_SCHEMA_MISSING']);
  });

  it('db with schema_migrations but missing settings/audit tables -> RESTORE_SCHEMA_MISSING', async () => {
    const tmp = env.newDir();
    const p = makeDbFile(tmp, 'partial.db', (db) => db.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at TEXT);'
      + "INSERT INTO schema_migrations VALUES (1,'x','y','z');"));
    await expectRejected([
      { name: 'confirm', value: 'RESTORE' },
      { name: 'file', filename: 'partial.db', content: readFileSync(p) },
    ], 422, ['RESTORE_SCHEMA_MISSING']);
  });

  // A backup from a future app version is refused (cannot be understood safely).
  it('all required tables but schema version 999 -> 422 RESTORE_SCHEMA_TOO_NEW', async () => {
    const tmp = env.newDir();
    const p = makeDbFile(tmp, 'future.db', (db) => {
      migrate(db);
      db.exec("INSERT INTO schema_migrations (version, name, checksum) VALUES (999, '999_future.sql', 'x')");
    });
    await expectRejected([
      { name: 'confirm', value: 'RESTORE' },
      { name: 'file', filename: 'future.db', content: readFileSync(p) },
    ], 422, ['RESTORE_SCHEMA_TOO_NEW']);
  });

  it('missing file part -> 400 VALIDATION_ERROR', async () => {
    await expectRejected([{ name: 'confirm', value: 'RESTORE' }], 400, ['VALIDATION_ERROR']);
  });

  it('empty file -> 400 VALIDATION_ERROR', async () => {
    await expectRejected([
      { name: 'confirm', value: 'RESTORE' },
      { name: 'file', filename: 'empty.db', content: Buffer.alloc(0) },
    ], 400, ['VALIDATION_ERROR']);
  });

  it('file under the wrong field name -> 400 VALIDATION_ERROR', async () => {
    const p = join(env.newDir(), 'x.db');
    const { backupPath } = await setup();
    copyFileSync(backupPath, p);
    await expectRejected([
      { name: 'confirm', value: 'RESTORE' },
      { name: 'upload', filename: 'x.db', content: readFileSync(p) },
    ], 400, ['VALIDATION_ERROR']);
  });

  it('confirm missing -> 400 RESTORE_CONFIRM_REQUIRED', async () => {
    const { backupPath } = await setup();
    await expectRejected([
      { name: 'file', filename: 'b.db', content: readFileSync(backupPath) },
    ], 400, ['RESTORE_CONFIRM_REQUIRED']);
  });

  it('confirm wrong -> 400 RESTORE_CONFIRM_REQUIRED', async () => {
    const { backupPath } = await setup();
    await expectRejected([
      { name: 'confirm', value: 'yes' },
      { name: 'file', filename: 'b.db', content: readFileSync(backupPath) },
    ], 400, ['RESTORE_CONFIRM_REQUIRED']);
  });
});

// If the restore fails after the files were swapped, the previous data must be put back.
// M7: the old way of provoking this (a backup whose migration checksum was edited) is now refused BEFORE the swap by the
// validation (422 RESTORE_INVALID, see the first test below), so the post-swap failure is provoked differently: the first
// re-opening of the database after the swap fails (vi.spyOn on the real connection holder), the real rollback then runs.
describe('restore rollback (RESTORE_FAILED)', () => {
  /** A valid backup; the first `reopen()` after the swap throws once, so the swap has already happened when the restore fails. */
  async function failingSetup() {
    const s = await setup();
    const good = createBackup(s.ctx, 'manual', new Date('2026-03-02T00:00:00Z'));
    const path = join(s.dataDir, 'backups', good.name);
    const realReopen = s.ctx.database.reopen.bind(s.ctx.database);
    let calls = 0;
    vi.spyOn(s.ctx.database, 'reopen').mockImplementation(() => {
      calls += 1;
      if (calls === 1) throw new Error('simulated failure right after the swap');
      realReopen();
    });
    return { ...s, tampered: good, tamperedPath: path };
  }
  afterEach(() => { vi.restoreAllMocks(); });

  async function expectRolledBack(app: FastifyInstance, dataDir: string, res: { statusCode: number; json(): { error: { code: string } } }) {
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('RESTORE_FAILED');
    expect((await getSettings(app)).rates).toEqual({ reloadCommissionBp: 222, ezcashCommissionBp: 22 });
    expect(leftovers(dataDir)).toEqual([]);
    expect(readdirSync(join(dataDir, 'backups')).filter((f) => f.includes('pre-restore')).length).toBe(1);
    // connection was reopened: writes work and persist
    const put = await putSettings(app, rates(9, 9));
    expect(put.statusCode).toBe(200);
    expect((await getSettings(app)).rates).toEqual({ reloadCommissionBp: 9, ezcashCommissionBp: 9 });
    expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(200);
  }

  it('a backup with an edited migration checksum is refused BEFORE anything is touched (422 RESTORE_INVALID, no safety copy)', async () => {
    const s = await setup();
    const tampered = createBackup(s.ctx, 'manual', new Date('2026-03-02T00:00:00Z'));
    const path = join(s.dataDir, 'backups', tampered.name);
    const db = new DatabaseSync(path);
    try { db.exec("UPDATE schema_migrations SET checksum = 'wrong' WHERE version = 1"); } finally { db.close(); }
    const res = await restoreJson(s.app, { name: tampered.name, confirm: 'RESTORE' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('RESTORE_INVALID');
    expect(res.json().error.failures.map((f: { code: string }) => f.code)).toContain('migration_records');
    expect((await getSettings(s.app)).rates).toEqual({ reloadCommissionBp: 222, ezcashCommissionBp: 22 });
    expect(leftovers(s.dataDir)).toEqual([]);
    expect(readdirSync(join(s.dataDir, 'backups')).filter((f) => f.includes('pre-restore'))).toEqual([]);
  });

  it('named restore: 500 RESTORE_FAILED, previous data put back', async () => {
    const { app, ctx, dataDir, tampered } = await failingSetup();
    const res = await restoreJson(app, { name: tampered.name, confirm: 'RESTORE' });
    expect(ctx.isRestoring).toBe(false);
    await expectRolledBack(app, dataDir, res);
  });

  it('upload restore: 500 RESTORE_FAILED, previous data put back', async () => {
    const { app, ctx, dataDir, tamperedPath } = await failingSetup();
    const res = await restoreUpload(app, [
      { name: 'confirm', value: 'RESTORE' },
      { name: 'file', filename: 'tampered.db', content: readFileSync(tamperedPath) },
    ]);
    expect(ctx.isRestoring).toBe(false);
    await expectRolledBack(app, dataDir, res);
  });

  it('the safety backup from a failed restore holds the pre-restore values', async () => {
    const { app, dataDir, tampered } = await failingSetup();
    await restoreJson(app, { name: tampered.name, confirm: 'RESTORE' });
    const safety = readdirSync(join(dataDir, 'backups')).find((f) => f.includes('pre-restore'))!;
    const db = new DatabaseSync(join(dataDir, 'backups', safety), { readOnly: true });
    try {
      const row = db.prepare("SELECT value_json FROM settings WHERE key='rates'").get() as { value_json: string };
      expect(JSON.parse(row.value_json)).toEqual({ reloadCommissionBp: 222, ezcashCommissionBp: 22 });
    } finally { db.close(); }
  });
});

// While files are being swapped, normal requests must not touch the database.
describe('restore in progress', () => {
  it('any /api request -> 503 RESTORE_IN_PROGRESS while ctx.isRestoring', async () => {
    const { app, ctx } = await setup();
    ctx.isRestoring = true;
    try {
      for (const [method, url] of [
        ['GET', '/api/v1/health'], ['GET', '/api/v1/settings'], ['PUT', '/api/v1/settings'],
        ['GET', '/api/v1/backups'], ['POST', '/api/v1/backups'], ['GET', '/api/v1/nope'],
      ] as const) {
        const res = await app.inject({ method, url, payload: method === 'PUT' ? rates(1, 1) : undefined });
        expect(res.statusCode, `${method} ${url}`).toBe(503);
        expect(res.json().error.code).toBe('RESTORE_IN_PROGRESS');
      }
    } finally {
      ctx.isRestoring = false;
    }
    expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(200);
    expect((await getSettings(app)).rates).toEqual({ reloadCommissionBp: 222, ezcashCommissionBp: 22 });
  });

  it('non-/api paths are not blocked while restoring', async () => {
    const { app, ctx } = await setup();
    ctx.isRestoring = true;
    try {
      const res = await app.inject({ method: 'GET', url: '/something' });
      expect(res.statusCode).toBe(404);
    } finally {
      ctx.isRestoring = false;
    }
  });

  it('a second restore started while ctx.isRestoring is refused with 503 (API gate)', async () => {
    const { app, ctx, backup } = await setup();
    ctx.isRestoring = true;
    try {
      const res = await restoreJson(app, { name: backup.name, confirm: 'RESTORE' });
      expect(res.statusCode).toBe(503);
    } finally {
      ctx.isRestoring = false;
    }
  });
});

// keep writeFileSync import used for potential future fixtures
void writeFileSync;
