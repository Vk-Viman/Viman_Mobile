import type { DatabaseSync } from 'node:sqlite';

export interface SettingsRow { key: string; valueJson: string; updatedAt: string }

interface RawSettings { key: string; value_json: string; updated_at: string }

function map(r: RawSettings): SettingsRow {
  return { key: r.key, valueJson: r.value_json, updatedAt: r.updated_at };
}

export function getAllSettings(conn: DatabaseSync): SettingsRow[] {
  const rows = conn.prepare('SELECT key, value_json, updated_at FROM settings ORDER BY key').all() as unknown as RawSettings[];
  return rows.map(map);
}

export function getSetting(conn: DatabaseSync, key: string): SettingsRow | undefined {
  const r = conn.prepare('SELECT key, value_json, updated_at FROM settings WHERE key = ?').get(key) as unknown as RawSettings | undefined;
  return r ? map(r) : undefined;
}

export function upsertSetting(conn: DatabaseSync, key: string, valueJson: string): void {
  conn.prepare(
    `INSERT INTO settings (key, value_json) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(key, valueJson);
}
