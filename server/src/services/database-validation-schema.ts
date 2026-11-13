/**
 * services/database-validation-schema.ts - schema part of the backup validation (hardening finding M7).
 *
 * Builds a REFERENCE database in memory by applying the program's own migration files 1..N to an empty database,
 * and compares which tables (with their columns), indexes and triggers it has with those of a candidate backup.
 * A missing append-only trigger or unique index would silently remove a protection, so each missing, unexpected or
 * altered object is reported in plain words. Pure: it only reads the candidate connection.
 */
import { DatabaseSync } from 'node:sqlite';
import type { MigrationFile } from '../db/migrate.ts';

/** What one database contains, by object kind. Tables map to their column names; indexes/triggers to normalised SQL. */
export interface SchemaSnapshot {
  tables: Map<string, string[]>;
  indexes: Map<string, string>;
  triggers: Map<string, string>;
}

/** One difference between a candidate and the reference schema. */
export interface SchemaDifference {
  kind: 'table' | 'index' | 'trigger' | 'column';
  issue: 'missing' | 'unexpected' | 'altered';
  name: string;
}

const normalise = (sql: unknown): string => String(sql ?? '').replace(/\s+/g, ' ').trim().replace(/;$/, '').toLowerCase();

/** Reads the tables, indexes and triggers of an open database (SQLite's own internal objects are ignored). */
export function readSchema(conn: DatabaseSync): SchemaSnapshot {
  const snap: SchemaSnapshot = { tables: new Map(), indexes: new Map(), triggers: new Map() };
  const objects = conn.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as unknown as
    { type: string; name: string; sql: string | null }[];
  for (const o of objects) {
    if (o.type === 'table') {
      const cols = conn.prepare(`PRAGMA table_info("${o.name.replaceAll('"', '""')}")`).all() as unknown as { name: string }[];
      snap.tables.set(o.name, cols.map((c) => c.name).sort());
    } else if (o.type === 'index') snap.indexes.set(o.name, normalise(o.sql));
    else if (o.type === 'trigger') snap.triggers.set(o.name, normalise(o.sql));
  }
  return snap;
}

const referenceCache = new Map<string, SchemaSnapshot>();

/**
 * The schema a database of `version` must have: migration files 1..version applied to an empty in-memory database.
 * The result is cached per version + file checksums (the files never change while the program runs).
 */
export function referenceSchema(files: MigrationFile[], version: number): SchemaSnapshot {
  const used = files.filter((f) => f.version <= version);
  const key = `${version}:${used.map((f) => f.checksum).join(',')}`;
  const cached = referenceCache.get(key);
  if (cached) return cached;
  const ref = new DatabaseSync(':memory:');
  try {
    for (const f of used) ref.exec(f.sql);
    const snap = readSchema(ref);
    referenceCache.set(key, snap);
    return snap;
  } finally {
    ref.close();
  }
}

/** Every difference between the candidate and the reference schema, in a stable order. */
export function diffSchemas(actual: SchemaSnapshot, expected: SchemaSnapshot): SchemaDifference[] {
  const out: SchemaDifference[] = [];
  const sqlMaps = [['index', 'indexes'], ['trigger', 'triggers']] as const;
  for (const name of expected.tables.keys()) {
    const cols = actual.tables.get(name);
    if (!cols) { out.push({ kind: 'table', issue: 'missing', name }); continue; }
    const want = expected.tables.get(name)!;
    for (const c of want) if (!cols.includes(c)) out.push({ kind: 'column', issue: 'missing', name: `${name}.${c}` });
    for (const c of cols) if (!want.includes(c)) out.push({ kind: 'column', issue: 'unexpected', name: `${name}.${c}` });
  }
  for (const name of actual.tables.keys()) if (!expected.tables.has(name)) out.push({ kind: 'table', issue: 'unexpected', name });
  for (const [kind, prop] of sqlMaps) {
    for (const [name, sql] of expected[prop]) {
      const have = actual[prop].get(name);
      if (have === undefined) out.push({ kind, issue: 'missing', name });
      else if (have !== sql) out.push({ kind, issue: 'altered', name });
    }
    for (const name of actual[prop].keys()) if (!expected[prop].has(name)) out.push({ kind, issue: 'unexpected', name });
  }
  return out;
}

/** Plain-language sentence for one schema difference (a shop owner reads this). */
export function describeDifference(d: SchemaDifference): string {
  const what = d.kind === 'trigger' ? 'safety rule (trigger)' : d.kind === 'index' ? 'index' : d.kind;
  if (d.issue === 'missing') return `A required part of the database is missing: ${what} ${d.name}.`;
  if (d.issue === 'unexpected') return `The database contains a part that does not belong to it: ${what} ${d.name}.`;
  return `A part of the database has been changed from its original form: ${what} ${d.name}.`;
}
