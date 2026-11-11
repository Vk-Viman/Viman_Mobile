/**
 * routes/health.ts - `GET /health`: a tiny "is the server alive?" check.
 *
 * Layer: route. Returns the app version, the database schema version (the highest applied migration), the
 * server time and today's business date in Colombo, so the web app and the launcher script can confirm the
 * server is up and talking to the expected database.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { currentVersion } from '../db/migrate.ts';
import { nowIso, todayBusinessDate } from '../lib/dates.ts';

/** Registers the health endpoint under the `/api/v1` prefix. */
export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/health', async () => ({
    status: 'ok',
    appVersion: ctx.appVersion,
    schemaVersion: currentVersion(ctx.database.conn),
    time: nowIso(),
    today: todayBusinessDate(),
  }));
}
