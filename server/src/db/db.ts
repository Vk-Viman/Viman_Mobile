import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

export function openDatabase(filePath: string): DatabaseSync {
  if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
  const conn = new DatabaseSync(filePath);
  try {
    conn.exec('PRAGMA journal_mode = WAL');
    conn.exec('PRAGMA foreign_keys = ON');
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

export class AppDatabase {
  readonly filePath: string;
  #conn: DatabaseSync | null = null;
  #depth = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.#conn = openDatabase(filePath);
  }

  get conn(): DatabaseSync {
    if (this.#conn === null) throw codedError('Database is closed', 'DB_CLOSED');
    return this.#conn;
  }

  get isOpen(): boolean {
    return this.#conn !== null;
  }

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
      if (!nested) { try { conn.exec('ROLLBACK'); } catch { /* ignore */ } }
      throw err;
    }
    return result;
  }

  close(): void {
    const conn = this.#conn;
    if (conn === null) return;
    this.#conn = null;
    this.#depth = 0;
    try {
      try { conn.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
    } finally {
      conn.close();
    }
  }

  reopen(): void {
    this.close();
    this.#conn = openDatabase(this.filePath);
    this.#depth = 0;
  }
}
