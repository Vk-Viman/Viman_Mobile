/**
 * repositories/settings.repo.ts - SQL for the `settings` table.
 *
 * Layer: repository. Settings are stored as one JSON document per section (`shop`, `rates`, `printDefaults`),
 * keyed by name. The allowed keys and valid-JSON rule are enforced by CHECK constraints (migration 001).
 * Defaults, validation and auditing live in `settings.service.ts`.
 */
import type { DatabaseSync } from 'node:sqlite';
import { SQL_NOW_UTC } from './sql-helpers.ts';

/** One stored settings section; `valueJson` is the JSON text, `updatedAt` an ISO UTC timestamp. */
export interface SettingsRow { key: string; valueJson: string; updatedAt: string }

interface RawSettings { key: string; value_json: string; updated_at: string }

function map(r: RawSettings): SettingsRow {
  return { key: r.key, valueJson: r.value_json, updatedAt: r.updated_at };
}

/** Every stored section (a section never saved is simply absent; the service fills in defaults). */
export function getAllSettings(conn: DatabaseSync): SettingsRow[] {
  const rows = conn.prepare('SELECT key, value_json, updated_at FROM settings ORDER BY key').all() as unknown as RawSettings[];
  return rows.map(map);
}

/** One section by key, or undefined when it was never saved. */
export function getSetting(conn: DatabaseSync, key: string): SettingsRow | undefined {
  const r = conn.prepare('SELECT key, value_json, updated_at FROM settings WHERE key = ?').get(key) as unknown as RawSettings | undefined;
  return r ? map(r) : undefined;
}

/** Saves a section, creating the row or replacing its value (and refreshing `updated_at`). */
export function upsertSetting(conn: DatabaseSync, key: string, valueJson: string): void {
  conn.prepare(
    `INSERT INTO settings (key, value_json) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
       updated_at = ${SQL_NOW_UTC}`,
  ).run(key, valueJson);
}
