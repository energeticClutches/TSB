import type { SupabaseClient } from '@supabase/supabase-js';
import { type ErrorCode, isErrorCode } from '@slush/core';
import { env } from './env';
import { ApiError, fromPostgrest } from './errors';

/** Call a database function (Phase 7 §6). */
export async function rpc<T>(db: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw fromPostgrest(error);
  return data as T;
}

/** Read rows through row-level security. */
export async function select<T>(query: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>): Promise<T> {
  const { data, error } = await query;
  if (error) throw fromPostgrest(error);
  return data as T;
}

/**
 * Call our Edge API at /v1/* (same origin; proxied to Supabase Edge Functions).
 * `credentials: 'include'` sends the HttpOnly shop-device cookie.
 */
export async function edge<T>(path: string, init: { method?: string; body?: unknown; token?: string | undefined } = {}): Promise<T> {
  const request = {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  };
  const res = __DEMO__
    ? await (await import('../demo/backend')).backend().then((b) => b.fetch(path, request))
    : await fetch(`/v1${path}`, { ...request, credentials: 'include', signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    // e.g. an HTML error page from a proxy: treated as a generic server error below
  }
  // Errors come with an `error` envelope; NEEDS_OWNER_APPROVAL is one even though it's a 202.
  const envelope = json as { error?: unknown } | null;
  if (!res.ok || (envelope && typeof envelope === 'object' && 'error' in envelope)) {
    const err = (json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
    const code: ErrorCode = err?.code && isErrorCode(err.code) ? err.code : 'INTERNAL';
    throw new ApiError(code, err?.message ?? 'Something went wrong. Please try again.', err?.details ?? {});
  }
  return json as T;
}
