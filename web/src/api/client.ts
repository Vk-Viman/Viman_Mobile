import type { ApiErrorBody } from '../types/api';

const BASE = '/api/v1';

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

async function request<T>(method: string, path: string, body?: BodyInit | null, json = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: json ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body ?? undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the shop server. Check that it is running.');
  }
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
    const env = (data as ApiErrorBody | null)?.error;
    if (env && typeof env.code === 'string') {
      throw new ApiError(res.status, env.code, env.message ?? 'Request failed', env.fields);
    }
    throw new ApiError(res.status, 'HTTP_ERROR', `Request failed (HTTP ${res.status})`);
  }
  return data as T;
}

export const apiGet = <T>(path: string) => request<T>('GET', path);
export const apiPut = <T>(path: string, body: unknown) => request<T>('PUT', path, JSON.stringify(body), true);
export const apiPost = <T>(path: string, body?: unknown) =>
  request<T>('POST', path, body === undefined ? undefined : JSON.stringify(body), body !== undefined);
export const apiPostForm = <T>(path: string, form: FormData) => request<T>('POST', path, form);
