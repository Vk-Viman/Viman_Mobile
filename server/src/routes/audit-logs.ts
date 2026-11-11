/**
 * routes/audit-logs.ts - HTTP endpoint to read the audit trail (BUSINESS_RULES section 12).
 *
 *   GET /audit-logs?entity=&limit=&beforeId=   newest first, paged by `beforeId`
 *
 * Layer: route (thin) -> `audit.service.ts`. Read-only: the audit log is append-only and written only by the
 * services as part of their own transactions.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { getAuditLogs } from '../services/audit.service.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Type coercion is disabled app-wide (so a JSON body can never turn null/"6" into a number),
// therefore numeric query params arrive as digit strings and are range-checked here.
const querySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    entity: { type: 'string', maxLength: 50 },
    limit: { type: 'string', pattern: '^[0-9]{1,4}$' },
    beforeId: { type: 'string', pattern: '^[0-9]{1,15}$' },
  },
} as const;

/** Registers the audit-log endpoint under the `/api/v1` prefix. */
export function registerAuditLogRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/audit-logs', { schema: { querystring: querySchema } }, async (request) => {
    const raw = request.query as { entity?: string; limit?: string; beforeId?: string };
    const limit = raw.limit === undefined ? DEFAULT_LIMIT : Number(raw.limit);
    const beforeId = raw.beforeId === undefined ? undefined : Number(raw.beforeId);
    const fields: Record<string, string> = {};
    if (limit < 1 || limit > MAX_LIMIT) fields.limit = `must be between 1 and ${MAX_LIMIT}`;
    if (beforeId !== undefined && beforeId < 1) fields.beforeId = 'must be 1 or more';
    if (Object.keys(fields).length > 0) throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', fields);
    return getAuditLogs(ctx, { entity: raw.entity, limit, beforeId });
  });
}
