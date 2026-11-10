import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { currentVersion } from '../db/migrate.ts';
import { nowIso, todayBusinessDate } from '../lib/dates.ts';

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/health', async () => ({
    status: 'ok',
    appVersion: ctx.appVersion,
    schemaVersion: currentVersion(ctx.database.conn),
    time: nowIso(),
    today: todayBusinessDate(),
  }));
}
