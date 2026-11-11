/**
 * lib/limits.ts - size limits that more than one part of the server must agree on.
 *
 * Layer: shared library. Kept in one place so the limit configured on the upload parser (`app.ts`) and the
 * message shown to the owner (`app.ts` error handler and `routes/backups.ts`) can never drift apart.
 */

/** Largest backup file accepted for a restore upload: 200 MB (a shop database is far smaller). */
export const MAX_UPLOAD_MB = 200;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/** Owner-facing text of the 413 FILE_TOO_LARGE error. */
export const FILE_TOO_LARGE_MESSAGE = `The file is too large (limit is ${MAX_UPLOAD_MB} MB).`;
