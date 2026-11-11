/**
 * repositories/sql-helpers.ts - small pieces shared by all repositories.
 *
 * Layer: repository (SQL only, no business rules). These helpers existed as identical copies in several
 * repository files; they live here once so a fix applies everywhere.
 */

/**
 * The SQL expression for "now" as an ISO-8601 UTC timestamp, e.g. `2026-11-11T04:30:00.123Z`.
 * Interpolated into SQL text (it is a constant, never user input). Using the DATABASE clock for `voided_at`,
 * `completed_at` and `updated_at` keeps one single time source for posting order (BUSINESS_RULES section 12).
 */
export const SQL_NOW_UTC = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/**
 * Escapes the LIKE wildcards `%` and `_` (and the escape character `\` itself) in user search text so that
 * typing "50%" searches for the literal "50%". Must be paired with `ESCAPE '\'` in the SQL.
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Converts a nullable SQLite integer to a plain number or null. node:sqlite may hand integers back as
 * `bigint` for large values, so every numeric column is normalised with `Number(...)` in the row mappers.
 */
export function numberOrNull(v: number | bigint | null): number | null {
  return v === null ? null : Number(v);
}
