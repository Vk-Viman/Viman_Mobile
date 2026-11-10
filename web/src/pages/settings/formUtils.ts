import { ApiError } from '../../api/client';

/** Pick server field errors under a path prefix (e.g. "shop") and strip it. */
export function serverFields(err: unknown, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!(err instanceof ApiError)) return out;
  const p = prefix + '.';
  for (const [k, v] of Object.entries(err.fields)) {
    if (k.startsWith(p)) out[k.slice(p.length)] = v;
  }
  return out;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}
