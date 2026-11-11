/**
 * db/db.ts - opens the SQLite database and provides the transaction helper.
 *
 * Layer: database (the bottom of route -> service -> repository -> database). Repositories receive the raw
 * connection from `AppDatabase.conn`; services wrap every multi-row financial write in `AppDatabase.tx()` so
 * that a sale/purchase/void either happens completely or not at all (BUSINESS_RULES section 3: "every change
 * writes exactly one stock_movements row in the same transaction as the cache update").
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { codedError } from '../lib/errors.ts';

/**
 * Opens (creating the folder and file if needed) a SQLite database and applies the safety settings.
 *
 * @param filePath Path of the `.db` file, or `':memory:'` for a throw-away test database.
 * @returns An open connection with WAL, foreign keys, a busy timeout and full durability switched on.
 */
export function openDatabase(filePath: string): DatabaseSync {
  if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
  const conn = new DatabaseSync(filePath);
  try {
    // WAL = write-ahead log: readers never block the writer and a crash cannot corrupt the file.
    conn.exec('PRAGMA journal_mode = WAL');
    // SQLite ignores FOREIGN KEY declarations unless this is switched on for every connection.
    conn.exec('PRAGMA foreign_keys = ON');
    // If another process briefly holds the file (e.g. an antivirus scan on Windows), wait up to 5 s
    // instead of failing immediately with "database is locked".
    conn.exec('PRAGMA busy_timeout = 5000');
    // FULL: every COMMIT is flushed to disk. With NORMAL a power cut could silently lose the
    // last few committed sales/cash entries (the DB stays consistent, but data is gone).
    conn.exec('PRAGMA synchronous = FULL');
  } catch (err) {
    try { conn.close(); } catch { /* ignore */ }
    throw err;
  }
  return conn;
}

/**
 * Owns the single database connection of the running server.
 *
 * Why a wrapper instead of a bare connection: restoring a backup has to close the file, swap it and open it
 * again while the server keeps running (`reopen`), and every transaction must go through one helper so the
 * BEGIN/COMMIT/ROLLBACK logic exists in exactly one place.
 */
export class AppDatabase {
  readonly filePath: string;
  // `#` fields are truly private (erasable-syntax friendly: no TypeScript-only `private` keyword needed).
  #conn: DatabaseSync | null = null;
  /** How many `tx()` calls are currently open on top of each other (0 = no transaction). */
  #depth = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.#conn = openDatabase(filePath);
  }

  /**
   * The live connection to hand to repositories.
   * @throws Error with `code = 'DB_CLOSED'` when the database was closed (e.g. during a restore).
   */
  get conn(): DatabaseSync {
    if (this.#conn === null) throw codedError('Database is closed', 'DB_CLOSED');
    return this.#conn;
  }

  get isOpen(): boolean {
    return this.#conn !== null;
  }

  /**
   * Runs `fn` as one all-or-nothing transaction and returns its result.
   *
   * - The outermost call uses `BEGIN IMMEDIATE`, which takes the write lock up front so two writers can never
   *   deadlock halfway through; nested calls become SAVEPOINTs, so an inner failure rolls back only the inner
   *   part while an outer caller may still catch it.
   * - If `fn` throws, everything it wrote is rolled back and the error is re-thrown unchanged.
   * - `fn` must be synchronous: a transaction cannot stay open across an `await`, so a Promise result is
   *   refused (and rolled back) as a programming error.
   *
   * @param fn Work to do; receives the connection.
   */
  tx<T>(fn: (conn: DatabaseSync) => T): T {
    const conn = this.conn;
    const nested = this.#depth > 0;
    const sp = `sp_${this.#depth}`;
    conn.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE');
    this.#depth++;
    let result: T;
    try {
      result = fn(conn);
      if (result !== null && (typeof result === 'object' || typeof result === 'function')
        && typeof (result as { then?: unknown }).then === 'function') {
        throw new Error('AppDatabase.tx does not support async functions');
      }
    } catch (err) {
      this.#depth--;
      try {
        if (nested) conn.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
        else conn.exec('ROLLBACK');
      } catch { /* transaction may already be gone */ }
      throw err;
    }
    this.#depth--;
    try {
      conn.exec(nested ? `RELEASE ${sp}` : 'COMMIT');
    } catch (err) {
      // COMMIT itself can fail (e.g. a deferred constraint); make sure no half-open transaction is left behind.
      if (!nested) { try { conn.exec('ROLLBACK'); } catch { /* ignore */ } }
      throw err;
    }
    return result;
  }

  /** Closes the connection. Safe to call twice. Folds the WAL file back into the main file first. */
  close(): void {
    const conn = this.#conn;
    if (conn === null) return;
    this.#conn = null;
    this.#depth = 0;
    try {
      // TRUNCATE empties viman.db-wal so that, afterwards, viman.db alone is a complete copy
      // (a restore or manual file copy then cannot miss recent commits sitting in the -wal file).
      try { conn.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
    } finally {
      conn.close();
    }
  }

  /** Closes and opens the same file again (used after a backup restore replaced the file on disk). */
  reopen(): void {
    this.close();
    this.#conn = openDatabase(this.filePath);
    this.#depth = 0;
  }
}
