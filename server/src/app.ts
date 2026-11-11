/**
 * app.ts - builds the web server (Fastify) and wires every layer together.
 *
 * Layer: composition root. It opens the database, runs the migrations, registers the HTTP routes under
 * `/api/v1`, serves the built web app, and turns every error into the JSON envelope documented in
 * API_CONTRACTS.md (`{ error: { code, message, fields? } }`). `index.ts` calls `buildApp` for the real server;
 * the tests call it with a temporary data folder, so nothing here may depend on global state.
 *
 * Request flow: route (validates JSON) -> service (business rules, transaction, audit) -> repository (SQL)
 * -> database.
 */
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppDatabase } from './db/db.ts';
import { migrate } from './db/migrate.ts';
import { AppError } from './lib/errors.ts';
import { FILE_TOO_LARGE_MESSAGE, MAX_UPLOAD_BYTES } from './lib/limits.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerAuditLogRoutes } from './routes/audit-logs.ts';
import { registerBackupRoutes } from './routes/backups.ts';
import { registerCategoryRoutes } from './routes/categories.ts';
import { registerProductRoutes } from './routes/products.ts';
import { registerSupplierRoutes } from './routes/suppliers.ts';
import { registerPurchaseRoutes } from './routes/purchases.ts';
import { registerInventoryRoutes } from './routes/inventory.ts';
import { registerStocktakeRoutes } from './routes/stocktakes.ts';
import { registerStockLossRoutes } from './routes/stock-losses.ts';
import { registerDrawingRoutes } from './routes/drawings.ts';
import { registerSaleRoutes } from './routes/sales.ts';

/** Options of `buildApp`. */
export interface AppOptions {
  /** Folder holding `viman.db` and the `backups/` folder (env `VIMAN_DATA_DIR` in production). */
  dataDir: string;
  /** Folder of the built web app to serve; null/omitted = API only (tests). */
  webDistDir?: string | null;
  /** Turn on Fastify's request logging (off by default; the shop PC has no use for it). */
  logger?: boolean;
}

/**
 * Shared state handed to every route and service (one per running server).
 * `isRestoring` is true while a backup restore swaps the database file: during that time every /api request
 * is refused with 503 so nothing can write to a half-swapped database.
 */
export interface AppContext {
  database: AppDatabase;
  dataDir: string;
  backupsDir: string;
  dbPath: string;
  appVersion: string;
  isRestoring: boolean;
}

/** One problem reported by Fastify's JSON-schema validator (ajv). Only the fields we use are listed. */
interface ValidationIssue {
  instancePath?: string;
  keyword?: string;
  message?: string;
  params?: Record<string, unknown>;
}

/** Reads the version from `server/package.json` (shown by /health); '0.0.0' if it cannot be read. */
function readAppVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Converts ajv validation issues into the API's `fields` map (field path -> message).
 * Paths use dots (`items.0.productId`). A missing/unknown property is reported against that property's own
 * name, and the first message for a path wins. Problems with the body itself are reported under `body`.
 */
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

/** The JSON error body: `{ error: { code, message, fields?, ...extra } }`. `extra` never overrides the base keys. */
function errorEnvelope(
  code: string, message: string, fields?: Record<string, string>, extra?: Record<string, unknown>,
) {
  const base = fields ? { code, message, fields } : { code, message };
  return { error: extra ? { ...extra, ...base } : base };
}

/** Matches `/api` and `/api/...` (also with a query string) - the only paths that must never fall back to HTML. */
const API_PATH_RE = /^\/api(?:[/?]|$)/;

/** A mapped error: the HTTP status and the JSON body to send. */
interface ErrorResponse { status: number; body: ReturnType<typeof errorEnvelope> }

/**
 * Decides how an error is shown to the client. Order matters: our own `AppError`s first, then schema
 * validation, then known Fastify/multipart failures; anything else is a bug and becomes a generic 500 whose
 * details are only written to the console (never sent to the browser).
 */
function toErrorResponse(error: unknown): ErrorResponse | null {
  if (error instanceof AppError) {
    return { status: error.statusCode, body: errorEnvelope(error.code, error.message, error.fields, error.extra) };
  }
  const e = error as { validation?: ValidationIssue[]; code?: string; statusCode?: number; message?: string };
  if (Array.isArray(e.validation)) {
    return { status: 400, body: errorEnvelope('VALIDATION_ERROR', 'Some fields are invalid.', validationFields(e.validation)) };
  }
  if (e.code === 'FST_REQ_FILE_TOO_LARGE' || e.statusCode === 413) {
    return { status: 413, body: errorEnvelope('FILE_TOO_LARGE', FILE_TOO_LARGE_MESSAGE) };
  }
  // FST_ERR_CTP_* = content-type-parser problems (missing/empty/oversized body); other FST_* 400s are malformed requests.
  if (typeof e.code === 'string' && e.code.startsWith('FST_ERR_CTP_') && e.statusCode === 400) {
    return { status: 400, body: errorEnvelope('VALIDATION_ERROR', 'The request body is missing or not valid JSON.') };
  }
  if (typeof e.code === 'string' && e.code.startsWith('FST_') && e.statusCode === 400) {
    return { status: 400, body: errorEnvelope('VALIDATION_ERROR', 'The request is not valid.') };
  }
  return null;
}

/**
 * Creates the server: opens the database (creating the data folder), applies migrations, registers the
 * routes, the error handling and (when present) the web app.
 *
 * @param opts See `AppOptions`.
 * @returns The Fastify instance (not yet listening) and the shared context.
 * @throws The migration error (code `MIGRATION_DB_TOO_NEW` / `MIGRATION_CHECKSUM_MISMATCH` ...) after closing
 *   the database, so `index.ts` can print a friendly message.
 */
export async function buildApp(opts: AppOptions): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const dataDir = resolve(opts.dataDir);
  const backupsDir = join(dataDir, 'backups');
  mkdirSync(backupsDir, { recursive: true });
  const dbPath = join(dataDir, 'viman.db');
  const database = new AppDatabase(dbPath);
  try {
    migrate(database.conn);
  } catch (err) {
    // Do not leave the file open (it would stay locked on Windows) when start-up fails.
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

  // Backup restore uploads: one file, a few small text fields, capped at MAX_UPLOAD_BYTES.
  await app.register(fastifyMultipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 },
  });

  // While a restore is swapping the database file, refuse API calls (503) instead of touching a closed database.
  app.addHook('onRequest', async (request, reply) => {
    if (ctx.isRestoring && API_PATH_RE.test(request.url)) {
      return reply.code(503).send(errorEnvelope('RESTORE_IN_PROGRESS',
        'A restore is in progress. Please wait a moment and try again.'));
    }
    return undefined;
  });

  // Closing the server also closes the database (folds the WAL file back into viman.db).
  app.addHook('onClose', async () => {
    database.close();
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = toErrorResponse(error);
    if (mapped) return reply.code(mapped.status).send(mapped.body);
    console.error('Unexpected error handling', request.method, request.url, error);
    return reply.code(500).send(errorEnvelope('INTERNAL_ERROR', 'Something went wrong. Please try again.'));
  });

  await app.register(async (api) => {
    registerHealthRoutes(api, ctx);
    registerSettingsRoutes(api, ctx);
    registerAuditLogRoutes(api, ctx);
    registerBackupRoutes(api, ctx);
    registerCategoryRoutes(api, ctx);
    registerProductRoutes(api, ctx);
    registerSupplierRoutes(api, ctx);
    registerPurchaseRoutes(api, ctx);
    registerInventoryRoutes(api, ctx);
    registerStocktakeRoutes(api, ctx);
    registerStockLossRoutes(api, ctx);
    registerDrawingRoutes(api, ctx);
    registerSaleRoutes(api, ctx);
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
