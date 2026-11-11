import { AppError } from '../lib/errors.ts';

// Shared helpers for the catalog routes: query params arrive as strings (no type coercion).
export const idParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', pattern: '^[0-9]{1,9}$' } },
} as const;

export const intQuery = { type: 'string', pattern: '^[0-9]{1,9}$' } as const;
export const boolQuery = { type: 'string', enum: ['true', 'false'] } as const;
export const bookQuery = { type: 'string', enum: ['shop', 'telecom'] } as const;

export function parseId(params: unknown): number {
  return Number((params as { id: string }).id);
}

export function parseBool(v: string | undefined): boolean | undefined {
  return v === undefined ? undefined : v === 'true';
}

export function fail(fields: Record<string, string>): never {
  throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', fields);
}
