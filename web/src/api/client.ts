/**
 * Low-level HTTP client for the Viman shop API.
 *
 * Every screen talks to the server through the helpers here (apiGet / apiPost / apiPut / apiPostForm), never
 * through raw fetch. Centralising it means:
 *  - all calls go to the same versioned base path (`/api/v1`);
 *  - every failure, whatever its cause, reaches the UI as one error type (`ApiError`) with a readable message;
 *  - the server's standard error envelope `{ error: { code, message, fields? } }` (see API_CONTRACTS.md) is
 *    decoded in exactly one place.
 *
 * In development Vite proxies `/api` to the server (see vite.config.ts); in production the server itself serves
 * this web app, so the same relative URL works in both.
 */
import type { ApiErrorBody } from '../types/api';

/** Versioned prefix of every endpoint. Paths passed to the helpers below are relative to it. */
const BASE = '/api/v1';

/**
 * The single error type thrown by the API helpers.
 *
 * - `status`: HTTP status (0 means the server could not be reached at all).
 * - `code`: stable machine code from the server, e.g. FUTURE_DATE_NOT_ALLOWED, or NETWORK_ERROR / HTTP_ERROR.
 * - `message`: human-readable text that is safe to show to the owner.
 * - `fields`: per-field messages for validation errors (field name -> message); empty object when none.
 */
export class ApiError extends Error {
  status: number;
  code: string;
  fields: Record<string, string>;
  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields ?? {};
  }
}

/**
 * Performs one HTTP call and returns the parsed JSON body.
 *
 * @param method HTTP verb.
 * @param path   Endpoint path relative to `/api/v1`.
 * @param body   Already-serialised body (JSON string or FormData), or nothing.
 * @param json   True when `body` is JSON, so the Content-Type header is added. For FormData it must stay false:
 *               the browser then sets the multipart header (with its boundary) itself.
 * @throws ApiError for network failures and for any non-2xx answer.
 */
async function request<T>(method: string, path: string, body?: BodyInit | null, json = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: json ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body ?? undefined,
    });
  } catch {
    // fetch only rejects when the server is unreachable (not running, firewall...). Give a friendly message.
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the shop server. Check that it is running.');
  }
  // Read as text first so an empty body (e.g. 204) or a non-JSON error page cannot crash the JSON parser.
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    // Prefer the server's own error envelope; fall back to a generic message for unexpected replies.
    const env = (data as ApiErrorBody | null)?.error;
    if (env && typeof env.code === 'string') {
      throw new ApiError(res.status, env.code, env.message ?? 'Request failed', env.fields);
    }
    throw new ApiError(res.status, 'HTTP_ERROR', `Request failed (HTTP ${res.status})`);
  }
  return data as T;
}

/** GET `path` and return the parsed JSON as T. */
export const apiGet = <T>(path: string) => request<T>('GET', path);

/** PUT a JSON `body` to `path` (used for updates) and return the parsed JSON as T. */
export const apiPut = <T>(path: string, body: unknown) => request<T>('PUT', path, JSON.stringify(body), true);

/** POST to `path`, optionally with a JSON `body` (actions such as "void" may have none), and return JSON as T. */
export const apiPost = <T>(path: string, body?: unknown) =>
  request<T>('POST', path, body === undefined ? undefined : JSON.stringify(body), body !== undefined);

/** POST a multipart form (file upload, e.g. restoring a backup file) and return the parsed JSON as T. */
export const apiPostForm = <T>(path: string, form: FormData) => request<T>('POST', path, form);
