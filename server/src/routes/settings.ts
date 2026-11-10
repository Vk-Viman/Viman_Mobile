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

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/settings', async () => getSettings(ctx));

  app.put('/settings', { schema: { body: bodySchema } }, async (request) =>
    updateSettings(ctx, request.body as SettingsPatch));
}
