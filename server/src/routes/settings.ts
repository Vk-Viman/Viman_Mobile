/**
 * routes/settings.ts - HTTP endpoints for shop settings.
 *
 *   GET /settings    read all settings (defaults fill anything never saved)
 *   PUT /settings    change one or more sections: `shop`, `rates`, `printDefaults`
 *
 * Layer: route (thin) -> `settings.service.ts`. The JSON schema below enforces the numeric limits: C11 says
 * every commission rate must be 0..10000 basis points; print prices/costs are non-negative cents.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { getSettings, updateSettings } from '../services/settings.service.ts';
import type { SettingsPatch } from '../services/settings.service.ts';

const bodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    shop: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 100 },
        address: { type: 'string', maxLength: 200 },
        phone: { type: 'string', maxLength: 30 },
        email: { type: 'string', maxLength: 100 },
      },
    },
    rates: {
      type: 'object',
      additionalProperties: false,
      required: ['reloadCommissionBp', 'ezcashCommissionBp'],
      properties: {
        // C11: 0 <= rate <= 10000 basis points (0 % to 100 %).
        reloadCommissionBp: { type: 'integer', minimum: 0, maximum: 10000 },
        ezcashCommissionBp: { type: 'integer', minimum: 0, maximum: 10000 },
      },
    },
    printDefaults: {
      type: 'array',
      minItems: 1,
      maxItems: 30,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'name', 'priceCents', 'costCents'],
        properties: {
          code: { type: 'string', pattern: '^[A-Z0-9_]{1,20}$' },
          name: { type: 'string', minLength: 1, maxLength: 60 },
          priceCents: { type: 'integer', minimum: 0, maximum: 100000000 },
          costCents: { type: 'integer', minimum: 0, maximum: 100000000 },
        },
      },
    },
  },
} as const;

/** Registers the settings endpoints under the `/api/v1` prefix. */
export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/settings', async () => getSettings(ctx));

  app.put('/settings', { schema: { body: bodySchema } }, async (request) =>
    updateSettings(ctx, request.body as SettingsPatch));
}
