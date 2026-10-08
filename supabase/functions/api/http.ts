/** Response helpers shared by every endpoint (error envelope: docs/PHASE-7-API.md §1.5). */
import { ERROR_STATUS } from '@slush/core';

export const STATUS: Record<string, number> = { ...ERROR_STATUS, DEVICE_NOT_REGISTERED: 403, RATE_LIMITED: 429 };

export class HttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function errorResponse(err: HttpError, requestId: string): Response {
  return json(
    { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}), request_id: requestId } },
    STATUS[err.code] ?? 500,
    { ...err.headers, 'X-Request-Id': requestId },
  );
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export const DEVICE_COOKIE = '__Host-sb_device';

/** HttpOnly, first-party, never sent cross-site (Phase 7 §1.3). ~400 days. */
export function deviceCookie(secret: string): string {
  return `${DEVICE_COOKIE}=${encodeURIComponent(secret)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=34560000`;
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await req.json()) as unknown;
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new HttpError('BAD_REQUEST', 'The request body must be a JSON object.');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}
