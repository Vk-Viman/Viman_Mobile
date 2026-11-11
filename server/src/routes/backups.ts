/**
 * routes/backups.ts - HTTP endpoints to list, create and restore database backups.
 *
 * Layer: route (thin) -> `backup.service.ts`, which holds the real safety logic (validation gates, safety
 * copy, atomic swap, automatic rollback; see ARCHITECTURE.md "Backup / restore").
 *
 *   GET  /backups           list backups, newest first
 *   POST /backups           make a manual backup now (201)
 *   POST /backups/restore   restore from a named backup (JSON body) or an uploaded file (multipart form)
 *
 * A restore replaces ALL shop data, so it must be confirmed explicitly: the request must carry the word
 * "RESTORE" (error RESTORE_CONFIRM_REQUIRED otherwise), which protects against an accidental click or a script.
 */
import type { FastifyInstance } from 'fastify';
import { createWriteStream, existsSync, rmSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { FILE_TOO_LARGE_MESSAGE } from '../lib/limits.ts';
import {
  BACKUP_NAME_RE, createBackup, listBackups, restoreFromFile,
} from '../services/backup.service.ts';

/** The exact word the owner must send to confirm a restore. */
const RESTORE_CONFIRM_WORD = 'RESTORE';

function confirmRequired(): AppError {
  return new AppError(400, 'RESTORE_CONFIRM_REQUIRED',
    `Please confirm the restore by sending confirm = "${RESTORE_CONFIRM_WORD}".`);
}

/** Registers the backup endpoints under the `/api/v1` prefix. */
export function registerBackupRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/backups', async () => ({ items: listBackups(ctx) }));

  app.post('/backups', async (_request, reply) => {
    const item = createBackup(ctx, 'manual');
    return reply.code(201).send({ item });
  });

  app.post('/backups/restore', async (request) => {
    // Variant 1: the owner uploads a backup file (multipart form: field "file" + field "confirm").
    if (request.isMultipart()) {
      const uploadPath = join(ctx.dataDir, `upload-${Date.now()}.tmp.db`);
      let confirm: string | undefined;
      let filename: string | undefined;
      let gotFile = false;
      try {
        for await (const part of request.parts()) {
          if (part.type === 'file') {
            // Only the first file in the field named "file" is used; anything else is drained and ignored.
            if (part.fieldname !== 'file' || gotFile) {
              part.file.resume();
              continue;
            }
            gotFile = true;
            filename = part.filename;
            await pipeline(part.file, createWriteStream(uploadPath));
            if (part.file.truncated) {
              throw new AppError(413, 'FILE_TOO_LARGE', FILE_TOO_LARGE_MESSAGE);
            }
          } else if (part.fieldname === 'confirm') {
            confirm = typeof part.value === 'string' ? part.value : undefined;
          }
        }
        if (confirm !== RESTORE_CONFIRM_WORD) throw confirmRequired();
        if (!gotFile || !existsSync(uploadPath) || statSync(uploadPath).size === 0) {
          throw new AppError(400, 'VALIDATION_ERROR', 'Please choose a backup file to restore.',
            { file: 'A file is required.' });
        }
        return restoreFromFile(ctx, uploadPath, `upload:${filename ?? 'unknown'}`);
      } finally {
        // The temporary upload is always removed, whatever happened.
        rmSync(uploadPath, { force: true });
      }
    }

    // Variant 2: restore one of the backups already in the backups folder (JSON body: name + confirm).
    const body = request.body as { name?: unknown; confirm?: unknown } | undefined | null;
    if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'The request body is missing.', { name: 'A backup name is required.' });
    }
    if (body.confirm !== RESTORE_CONFIRM_WORD) throw confirmRequired();
    // The name must match the backup-file pattern exactly: this is what stops "../" style paths.
    if (typeof body.name !== 'string' || !BACKUP_NAME_RE.test(body.name)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'That is not a valid backup name.', { name: 'Invalid backup name.' });
    }
    const path = join(ctx.backupsDir, body.name);
    if (!existsSync(path)) {
      throw new AppError(404, 'BACKUP_NOT_FOUND', 'That backup could not be found.');
    }
    return restoreFromFile(ctx, path, body.name);
  });
}
