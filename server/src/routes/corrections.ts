/**
 * routes/corrections.ts - read access to the correction links (migration 022) plus the shared request-body shape of every
 * "correct this entry" endpoint.
 *
 *   GET /corrections?entity=expenses&ids=1,2,3   the links where any of these records is the original or the replacement
 *                                                 (History uses it for the "Corrected by #n" / "Corrects #n" badges)
 *
 * The per-type endpoints live in each type's own route file and all have the same three shapes:
 *   GET  /<resource>/:id/correct-check     eligibility: { eligible: true } or { eligible: false, code, message } (nothing saved)
 *   POST /<resource>/:id/correct-preview   dry run of the whole correction: what the replacement would be (nothing saved)
 *   POST /<resource>/:id/correct           the real correction (201; 200 when the same replacement clientRef was already applied)
 * Body of the two POSTs: { reason, replacement: <the normal create body of that type> }.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { listCorrectionLinks } from '../services/correction.ts';
import type { CorrectionEntity } from '../services/correction.ts';

const ENTITIES: CorrectionEntity[] = [
  'sales', 'expenses', 'cash_transfers', 'capital_entries', 'owner_drawings', 'telecom_topups', 'printing_supplies',
  'icecream_payments', 'icecream_fund_moves', 'stock_losses', 'purchases', 'print_sales', 'reload_sales', 'ezcash_sales',
];

/** JSON schema of the body of correct / correct-preview, given the schema of the type's normal create body. */
export function correctionBodySchema(replacementSchema: object): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['reason', 'replacement'],
    properties: { reason: { type: 'string' }, replacement: replacementSchema },
  };
}

const querySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['entity', 'ids'],
  properties: {
    entity: { type: 'string', enum: ENTITIES },
    ids: { type: 'string', pattern: '^[0-9]+(,[0-9]+){0,199}$' },
  },
} as const;

export function registerCorrectionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/corrections', { schema: { querystring: querySchema } }, async (request) => {
    const q = request.query as { entity: CorrectionEntity; ids: string };
    return { items: listCorrectionLinks(ctx, q.entity, q.ids.split(',').map(Number)) };
  });
}
