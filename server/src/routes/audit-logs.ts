import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { getAuditLogs } from '../services/audit.service.ts';

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

export function registerAuditLogRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/audit-logs', { schema: { querystring: querySchema } }, async (request) => {
    const raw = request.query as { entity?: string; limit?: string; beforeId?: string };
    const limit = raw.limit === undefined ? 50 : Number(raw.limit);
    const beforeId = raw.beforeId === undefined ? undefined : Number(raw.beforeId);
    const fields: Record<string, string> = {};
    if (limit < 1 || limit > 200) fields.limit = 'must be between 1 and 200';
    if (beforeId !== undefined && beforeId < 1) fields.beforeId = 'must be 1 or more';
    if (Object.keys(fields).length > 0) throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', fields);
    return getAuditLogs(ctx, { entity: raw.entity, limit, beforeId });
  });
}
