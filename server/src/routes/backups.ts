import type { FastifyInstance } from 'fastify';
import { createWriteStream, existsSync, rmSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import {
  BACKUP_NAME_RE, createBackup, listBackups, restoreFromFile,
} from '../services/backup.service.ts';

function confirmRequired(): AppError {
  return new AppError(400, 'RESTORE_CONFIRM_REQUIRED',
    'Please confirm the restore by sending confirm = "RESTORE".');
}

export function registerBackupRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/backups', async () => ({ items: listBackups(ctx) }));

  app.post('/backups', async (_request, reply) => {
    const item = createBackup(ctx, 'manual');
    return reply.code(201).send({ item });
  });

  app.post('/backups/restore', async (request) => {
    if (request.isMultipart()) {
      const uploadPath = join(ctx.dataDir, `upload-${Date.now()}.tmp.db`);
      let confirm: string | undefined;
      let filename: string | undefined;
      let gotFile = false;
      try {
        for await (const part of request.parts()) {
          if (part.type === 'file') {
            if (part.fieldname !== 'file' || gotFile) {
              part.file.resume();
              continue;
            }
            gotFile = true;
            filename = part.filename;
            await pipeline(part.file, createWriteStream(uploadPath));
            if (part.file.truncated) {
              throw new AppError(413, 'FILE_TOO_LARGE', 'The file is too large (limit is 200 MB).');
            }
          } else if (part.fieldname === 'confirm') {
            confirm = typeof part.value === 'string' ? part.value : undefined;
          }
        }
        if (confirm !== 'RESTORE') throw confirmRequired();
        if (!gotFile || !existsSync(uploadPath) || statSync(uploadPath).size === 0) {
          throw new AppError(400, 'VALIDATION_ERROR', 'Please choose a backup file to restore.',
            { file: 'A file is required.' });
        }
        return restoreFromFile(ctx, uploadPath, `upload:${filename ?? 'unknown'}`);
      } finally {
        rmSync(uploadPath, { force: true });
      }
    }

    const body = request.body as { name?: unknown; confirm?: unknown } | undefined | null;
    if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'The request body is missing.', { name: 'A backup name is required.' });
    }
    if (body.confirm !== 'RESTORE') throw confirmRequired();
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
