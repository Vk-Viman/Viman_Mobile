// Package I (1/3): a valid database with real Telecom segments passes the whole validation, including the new `segments` check.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestEnv } from './helpers/tmp.ts';
import { apiBase, ref, today } from './helpers/inventory.ts';
import { post } from './helpers/catalog.ts';
import { buildSegWorld, removeFolder, workFolder } from './helpers/phase26i.ts';
import { createBackup } from '../services/backup.service.ts';
import { CHECK_CODES, validateDatabase } from '../services/database-validation.ts';
import { checkSegments } from '../services/database-validation-invariants.ts';
import { latestVersion, migrate } from '../db/migrate.ts';

const env = new TestEnv();
let work = '';
let base = '';

beforeAll(async () => {
  const s = await apiBase(await env.build());
  await buildSegWorld(s);
  work = workFolder();
  base = join(work, 'base.db');
  copyFileSync(join(s.ctx.backupsDir, createBackup(s.ctx, 'manual').name), base);
  await s.app.close();
}, 240000);
afterAll(async () => { await env.cleanup(); removeFolder(work); });

describe('a current-schema backup with real segment data', () => {
  it('passes every check, and `segments` is one of them', () => {
    const db = new DatabaseSync(base);
    try {
      const r = validateDatabase(db);
      expect(r.failures).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.schemaVersion).toBe(latestVersion());
      expect(CHECK_CODES).toContain('segments');
      expect(r.checks.find((c) => c.code === 'segments')?.status).toBe('passed');
      expect(r.checks.every((c) => c.status === 'passed')).toBe(true);
    } finally { db.close(); }
  });

  it('the world really uses many segments and every kind of record', () => {
    const db = new DatabaseSync(base, { readOnly: true });
    try {
      const n = (sql: string): number => Number(Object.values(db.prepare(sql).get() as Record<string, unknown>)[0]);
      expect(n("SELECT COUNT(DISTINCT segment) FROM cash_entries WHERE book = 'telecom'")).toBeGreaterThanOrEqual(7);
      expect(n("SELECT COUNT(*) FROM cash_entries WHERE segment = 'legacy'")).toBe(0);
      expect(n('SELECT COUNT(DISTINCT segment) FROM sales WHERE segment IS NOT NULL')).toBe(3);
      for (const t of ['purchases', 'stock_losses', 'stocktakes', 'reload_sales', 'ezcash_sales', 'telecom_topups', 'capital_entries', 'owner_drawings', 'expenses', 'cash_counts', 'daily_closings']) {
        expect(n(`SELECT COUNT(*) FROM ${t} WHERE segment IS NOT NULL`), t).toBeGreaterThan(0);
      }
      expect(n('SELECT COUNT(*) FROM cash_transfers WHERE from_segment IS NOT NULL AND to_segment IS NOT NULL')).toBe(1);
      expect(n("SELECT COUNT(*) FROM cash_entries WHERE reverses_entry_id IS NOT NULL AND segment IS NOT NULL")).toBeGreaterThan(5);
      expect(n("SELECT COUNT(*) FROM sales_returns")).toBeGreaterThanOrEqual(2);
    } finally { db.close(); }
  });

  it('checkSegments alone returns nothing on it', () => {
    const db = new DatabaseSync(base, { readOnly: true });
    try { expect(checkSegments(db)).toEqual([]); } finally { db.close(); }
  });
});

describe('other valid databases', () => {
  it('a fresh empty database passes, including `segments`', () => {
    const db = new DatabaseSync(join(work, 'fresh.db'));
    try {
      migrate(db);
      const r = validateDatabase(db);
      expect(r.failures).toEqual([]);
      expect(r.checks.find((c) => c.code === 'segments')?.status).toBe('passed');
    } finally { db.close(); }
  });

  it('the frozen schema-23 fixture passes as it is (older schema, upgraded on a trial copy) and after the real upgrade; every old Telecom row is legacy', () => {
    const fixture = join(import.meta.dirname, 'fixtures', 'schema23-world.db');
    const asIs = join(work, 'fixture-asis.db');
    copyFileSync(fixture, asIs);
    const a = new DatabaseSync(asIs);
    try {
      const r = validateDatabase(a);
      expect(r.failures).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.schemaVersion).toBe(23);
      expect(r.checks.find((c) => c.code === 'segments')?.status).toBe('passed');
    } finally { a.close(); }

    const up = join(work, 'fixture-up.db');
    copyFileSync(fixture, up);
    const b = new DatabaseSync(up);
    try {
      b.exec('PRAGMA foreign_keys = ON');
      migrate(b);
      const r = validateDatabase(b);
      expect(r.failures).toEqual([]);
      expect(r.schemaVersion).toBe(latestVersion());
      expect(checkSegments(b)).toEqual([]);
      const n = (sql: string): number => Number(Object.values(b.prepare(sql).get() as Record<string, unknown>)[0]);
      expect(n("SELECT COUNT(*) FROM cash_entries WHERE book = 'telecom' AND segment <> 'legacy'")).toBe(0);
      expect(n("SELECT COUNT(*) FROM cash_entries WHERE book = 'telecom' AND segment = 'legacy'")).toBeGreaterThan(0);
    } finally { b.close(); }
  });

  it('a legacy database that then took a new real-segment posting through the API still validates (legacy and real segments side by side)', async () => {
    const dataDir = env.newDir();
    copyFileSync(join(import.meta.dirname, 'fixtures', 'schema23-world.db'), join(dataDir, 'viman.db'));
    const s = await apiBase(await env.build({ dataDir }));
    try {
      const r = await post(s.app, '/expenses', { businessDate: today(), book: 'telecom', segment: 'hutch_cards', category: 'internet', amountCents: 1234, description: 'after upgrade', clientRef: ref() });
      expect(r.status).toBe(201);
      // voiding a legacy record writes a reversal that stays legacy (the only way a new legacy row can appear)
      const legacyRow = s.ctx.database.conn.prepare("SELECT id, business_date d FROM reload_sales WHERE status = 'posted' AND segment = 'legacy' ORDER BY id DESC LIMIT 1").get() as { id: number; d: string } | undefined;
      expect(legacyRow).toBeDefined();
      const closing = s.ctx.database.conn.prepare("SELECT id FROM daily_closings WHERE book = 'telecom' AND segment = 'legacy' AND business_date >= ? AND reopened_at IS NULL ORDER BY business_date LIMIT 1").get(legacyRow!.d) as { id: number } | undefined;
      if (closing) expect((await post(s.app, `/daily-closings/${closing.id}/reopen`, { reason: 'legacy fix' })).status).toBe(200);
      const v = await post(s.app, `/reload-sales/${legacyRow!.id}/void`, { reason: 'legacy void' });
      expect(v.status, JSON.stringify(v.body)).toBe(200);
      const file = join(work, 'legacy-plus.db');
      copyFileSync(join(s.ctx.backupsDir, createBackup(s.ctx, 'manual').name), file);
      const c = new DatabaseSync(file);
      try {
        expect(validateDatabase(c).failures).toEqual([]);
        expect(Number(Object.values(c.prepare("SELECT COUNT(*) FROM cash_entries WHERE segment = 'legacy'").get() as Record<string, unknown>)[0])).toBeGreaterThan(0);
        expect(Number(Object.values(c.prepare("SELECT COUNT(*) FROM cash_entries WHERE segment = 'hutch_cards'").get() as Record<string, unknown>)[0])).toBe(1);
      } finally { c.close(); }
    } finally { await s.app.close(); }
  }, 120000);
});
