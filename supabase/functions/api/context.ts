/** Shared types and helpers for every route module. */
import { HttpError, DEVICE_COOKIE, readCookie, sha256Hex } from './http.ts';
import { type SigningKey, verifyJwt } from './jwt.ts';
import type { Razorpay } from './razorpay.ts';

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}
export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

export interface Deps {
  db: Db;
  supabaseUrl: string;
  signingKey: SigningKey;
  /** Public keys that Supabase Auth may use to sign staff tokens. */
  verifyKeys: JsonWebKey[];
  /** Supabase Auth admin: invite a user by email, returning the new auth user id. */
  inviteUser(email: string): Promise<{ id: string }>;
  razorpay: Razorpay;
  secrets: {
    razorpayKeySecret: string;
    razorpayWebhookSecret: string;
    /** Pepper for hashing personal identifiers (UPI IDs, device ids, IPs). */
    identityPepper: string;
    jobSecret: string;
  };
  /** Cloudflare Turnstile server-side check. */
  verifyTurnstile(token: string, ip: string): Promise<boolean>;
  now(): Date;
  log(event: string, data: Record<string, unknown>): void;
}

export interface RouteContext {
  req: Request;
  deps: Deps;
  params: Record<string, string>;
  url: URL;
}
export type Handler = (ctx: RouteContext) => Promise<Response>;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function limit(db: Queryable, bucket: string, max: number, windowSeconds: number): Promise<void> {
  const [row] = await db.query<{ ok: boolean }>('select app.hit_rate_limit($1, $2, $3) as ok', [bucket, max, windowSeconds]);
  if (!row!.ok) {
    throw new HttpError('RATE_LIMITED', 'Too many attempts. Please wait a few minutes.', undefined, { 'Retry-After': String(windowSeconds) });
  }
}

export async function deviceSecretHash(req: Request): Promise<string> {
  const secret = readCookie(req, DEVICE_COOKIE);
  if (!secret) throw new HttpError('DEVICE_NOT_REGISTERED', 'This device isn’t set up for staff sign-in.');
  return sha256Hex(secret);
}

export type Claims = Record<string, unknown>;

export async function requireStaffToken(req: Request, deps: Deps): Promise<Claims> {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const claims = token ? await verifyJwt(token, deps.verifyKeys, Math.floor(deps.now().getTime() / 1000)) : null;
  if (!claims) throw new HttpError('UNAUTHENTICATED', 'Please sign in again.');
  return claims;
}

/** Keyed hash for personal identifiers, so raw values never sit in the database (Phase 8 §3.5). */
export async function identityHash(deps: Deps, kind: string, value: string): Promise<string> {
  return sha256Hex(`${deps.secrets.identityPepper}:${kind}:${value.trim().toLowerCase()}`);
}

const DB_CODES = new Set([
  'UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_FAILED', 'NOT_FOUND', 'INVALID_TRANSITION', 'IDEMPOTENCY_CONFLICT',
  'VERSION_CONFLICT', 'ORDER_ON_HOLD', 'TOKENS_UNAVAILABLE', 'COUPON_EXHAUSTED', 'NEEDS_OWNER_APPROVAL', 'COUPON_INVALID',
  'TOO_MANY_TOKENS', 'RATE_LIMITED',
]);

/** Database functions raise MESSAGE = our error code, DETAIL = human text, HINT = JSON details. */
export function dbError(e: unknown): HttpError {
  const err = e as { message?: string; detail?: string; hint?: string };
  if (err.message && DB_CODES.has(err.message)) {
    let details: Record<string, unknown> | undefined;
    try {
      details = err.hint ? (JSON.parse(err.hint) as Record<string, unknown>) : undefined;
    } catch {
      details = undefined;
    }
    return new HttpError(err.message, err.detail ?? 'Not allowed.', details);
  }
  throw e;
}

/** Run a database call, turning our raised error codes into HTTP errors. */
export async function viaDb<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw dbError(e);
  }
}
