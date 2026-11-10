import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppDatabase } from './db/db.ts';
import { migrate } from './db/migrate.ts';
import { AppError } from './lib/errors.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerAuditLogRoutes } from './routes/audit-logs.ts';
import { registerBackupRoutes } from './routes/backups.ts';

export interface AppOptions { dataDir: string; webDistDir?: string | null; logger?: boolean }
export interface AppContext {
  database: AppDatabase;
  dataDir: string;
  backupsDir: string;
  dbPath: string;
  appVersion: string;
  isRestoring: boolean;
}

interface ValidationIssue {
  instancePath?: string;
  keyword?: string;
  message?: string;
  params?: Record<string, unknown>;
}

function readAppVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function validationFields(issues: ValidationIssue[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    let path = (issue.instancePath ?? '').split('/').filter((s) => s !== '').join('.');
    const params = issue.params ?? {};
    if (issue.keyword === 'required' && typeof params.missingProperty === 'string') {
      path = path === '' ? params.missingProperty : `${path}.${params.missingProperty}`;
    } else if (issue.keyword === 'additionalProperties' && typeof params.additionalProperty === 'string') {
      path = path === '' ? params.additionalProperty : `${path}.${params.additionalProperty}`;
    }
    if (path === '') path = 'body';
    const message = issue.keyword === 'additionalProperties' ? 'Unknown field.' : (issue.message ?? 'Invalid value.');
    if (!(path in fields)) fields[path] = message;
  }
  return fields;
}

function errorEnvelope(code: string, message: string, fields?: Record<string, string>) {
  return { error: fields ? { code, message, fields } : { code, message } };
}

const API_PATH_RE = /^\/api(?:[/?]|$)/;

export async function buildApp(opts: AppOptions): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const dataDir = resolve(opts.dataDir);
  const backupsDir = join(dataDir, 'backups');
  mkdirSync(backupsDir, { recursive: true });
  const dbPath = join(dataDir, 'viman.db');
  const database = new AppDatabase(dbPath);
  try {
    migrate(database.conn);
  } catch (err) {
    database.close();
    throw err;
  }

  const ctx: AppContext = {
    database,
    dataDir,
    backupsDir,
    dbPath,
    appVersion: readAppVersion(),
    isRestoring: false,
  };

  const app = Fastify({
    logger: opts.logger ?? false,
    // Reject (rather than silently strip) unknown properties on bodies, and never coerce types:
    // with coercion a money field sent as null would silently become 0.
    ajv: { customOptions: { removeAdditional: false, allErrors: true, coerceTypes: false } },
  });

  // Lenient JSON parser: an empty body becomes undefined (so "POST with no body" works
  // even when a client sends a JSON content-type); malformed JSON is a 400.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') { done(null, undefined); return; }
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new AppError(400, 'VALIDATION_ERROR', 'The request body is not valid JSON.'));
    }
  });

  await app.register(fastifyMultipart, {
    limits: { fileSize: 200 * 1024 * 1024, files: 1, fields: 5 },
  });

  app.addHook('onRequest', async (request, reply) => {
    if (ctx.isRestoring && API_PATH_RE.test(request.url)) {
      return reply.code(503).send(errorEnvelope('RESTORE_IN_PROGRESS',
        'A restore is in progress. Please wait a moment and try again.'));
    }
    return undefined;
  });

  app.addHook('onClose', async () => {
    database.close();
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send(errorEnvelope(error.code, error.message, error.fields));
    }
    const e = error as { validation?: ValidationIssue[]; code?: string; statusCode?: number; message?: string };
    if (Array.isArray(e.validation)) {
      return reply.code(400).send(errorEnvelope('VALIDATION_ERROR',
        'Some fields are invalid.', validationFields(e.validation)));
    }
    if (e.code === 'FST_REQ_FILE_TOO_LARGE' || e.statusCode === 413) {
      return reply.code(413).send(errorEnvelope('FILE_TOO_LARGE', 'The file is too large (limit is 200 MB).'));
    }
    if (typeof e.code === 'string' && e.code.startsWith('FST_ERR_CTP_') && e.statusCode === 400) {
      return reply.code(400).send(errorEnvelope('VALIDATION_ERROR', 'The request body is missing or not valid JSON.'));
    }
    if (typeof e.code === 'string' && e.code.startsWith('FST_') && e.statusCode === 400) {
      return reply.code(400).send(errorEnvelope('VALIDATION_ERROR', 'The request is not valid.'));
    }
    console.error('Unexpected error handling', request.method, request.url, error);
    return reply.code(500).send(errorEnvelope('INTERNAL_ERROR', 'Something went wrong. Please try again.'));
  });

  await app.register(async (api) => {
    registerHealthRoutes(api, ctx);
    registerSettingsRoutes(api, ctx);
    registerAuditLogRoutes(api, ctx);
    registerBackupRoutes(api, ctx);
  }, { prefix: '/api/v1' });

  const webDistDir = opts.webDistDir ? resolve(opts.webDistDir) : null;
  const hasWeb = webDistDir !== null && existsSync(join(webDistDir, 'index.html'));
  if (hasWeb) {
    // wildcard (default) resolves files per request, so assets from a rebuild made while the
    // server runs are served too (wildcard:false only routes files present at startup).
    await app.register(fastifyStatic, { root: webDistDir });
  }

  app.setNotFoundHandler((request, reply) => {
    const isApi = API_PATH_RE.test(request.url);
    // Never answer a missing file (script, stylesheet, image…) with index.html: the browser would
    // try to run HTML as JavaScript and show a blank page. Only extension-less app routes fall back.
    const pathname = request.url.split('?')[0] ?? '';
    const looksLikeFile = pathname.startsWith('/assets/') || /\.[a-z0-9]{1,8}$/i.test(pathname);
    if (hasWeb && !isApi && !looksLikeFile && (request.method === 'GET' || request.method === 'HEAD')) {
      return reply.code(200).sendFile('index.html');
    }
    return reply.code(404).send(errorEnvelope('NOT_FOUND', 'Not found.'));
  });

  return { app, ctx };
}
