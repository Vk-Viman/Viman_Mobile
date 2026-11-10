import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { AppDatabase } from '../db/db.ts';
import { TestEnv } from './helpers/tmp.ts';

const env = new TestEnv();
const dbs: AppDatabase[] = [];
afterEach(async () => {
  for (const d of dbs) d.close();
  dbs.length = 0;
  await env.cleanup();
});

function open(): AppDatabase {
  const d = new AppDatabase(join(env.newDir(), 'x.db'));
  dbs.push(d);
  d.conn.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  return d;
}
const count = (d: AppDatabase) => (d.conn.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c;

describe('AppDatabase', () => {
  it('uses WAL and foreign keys', () => {
    const d = open();
    expect((d.conn.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    expect((d.conn.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
  });

  it('uses synchronous = FULL (2)', () => {
    const d = open();
    expect((d.conn.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous).toBe(2);
  });

  it('tx commits and returns the value', () => {
    const d = open();
    const r = d.tx((c) => { c.exec("INSERT INTO t (v) VALUES ('a')"); return 42; });
    expect(r).toBe(42);
    expect(count(d)).toBe(1);
  });

  it('tx rolls back on throw and rethrows', () => {
    const d = open();
    expect(() => d.tx((c) => { c.exec("INSERT INTO t (v) VALUES ('a')"); throw new Error('boom'); })).toThrow('boom');
    expect(count(d)).toBe(0);
    d.tx((c) => c.exec("INSERT INTO t (v) VALUES ('b')"));
    expect(count(d)).toBe(1);
  });

  it('nested tx: inner throw rolls back only inner work', () => {
    const d = open();
    d.tx((c) => {
      c.exec("INSERT INTO t (v) VALUES ('outer')");
      expect(() => d.tx((c2) => { c2.exec("INSERT INTO t (v) VALUES ('inner')"); throw new Error('inner'); })).toThrow('inner');
    });
    const rows = d.conn.prepare('SELECT v FROM t').all() as { v: string }[];
    expect(rows.map((r) => r.v)).toEqual(['outer']);
  });

  it('nested tx: inner success commits with outer; outer throw rolls back both', () => {
    const d = open();
    expect(() => d.tx((c) => {
      c.exec("INSERT INTO t (v) VALUES ('outer')");
      d.tx((c2) => c2.exec("INSERT INTO t (v) VALUES ('inner')"));
      throw new Error('outer');
    })).toThrow('outer');
    expect(count(d)).toBe(0);
  });

  it('rejects an async function and the connection stays usable', () => {
    const d = open();
    let caught: unknown;
    try {
      d.tx((async (c: { exec(s: string): void }) => { c.exec("INSERT INTO t (v) VALUES ('a')"); }) as never);
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect(count(d)).toBe(0);
    d.tx((c) => c.exec("INSERT INTO t (v) VALUES ('ok')"));
    expect(count(d)).toBe(1);
  });

  it('close() is idempotent; conn after close throws DB_CLOSED', () => {
    const d = open();
    expect(d.isOpen).toBe(true);
    d.close();
    expect(() => d.close()).not.toThrow();
    expect(d.isOpen).toBe(false);
    let code: string | undefined;
    try { void d.conn; } catch (e) { code = (e as { code?: string }).code; }
    expect(code).toBe('DB_CLOSED');
  });

  it('reopen() keeps data, also when already closed', () => {
    const d = open();
    d.tx((c) => c.exec("INSERT INTO t (v) VALUES ('keep')"));
    d.reopen();
    expect(d.isOpen).toBe(true);
    expect(count(d)).toBe(1);
    d.close();
    d.reopen();
    expect(count(d)).toBe(1);
  });
});
