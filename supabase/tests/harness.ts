/**
 * Runs the real migrations in an in-process Postgres (PGlite) with a small shim that
 * mimics what Supabase provides: the API roles, the `auth` schema and `request.jwt.claims`.
 * Lets every database rule (RLS, functions, triggers) be tested without Docker.
 *
 * Limitation: PGlite is a single connection, so true concurrency (row-lock races) is
 * tested separately against a real Postgres (staging), per docs/PHASE-9-TESTING.md §3.7.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const SUPABASE_DIR = join(import.meta.dirname, '..');

const SUPABASE_SHIM = readFileSync(join(SUPABASE_DIR, 'dev', 'supabase-shim.sql'), 'utf8');

export type ApiRole = 'anon' | 'authenticated' | 'service_role' | 'supabase_auth_admin';
export type Claims = Record<string, unknown>;

export interface TestDb {
  pg: PGlite;
  /** Run SQL as an API role with the given JWT claims (like a PostgREST request). */
  as<T = Record<string, unknown>>(role: ApiRole, claims: Claims, sql: string, params?: unknown[]): Promise<T[]>;
  /** Run SQL as the superuser (setup and tampering tests only). */
  admin<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  branchId: string;
}

export async function createTestDb(): Promise<TestDb> {
  const pg = await PGlite.create({ extensions: { pgcrypto, citext } });
  await pg.exec(SUPABASE_SHIM);

  const migrationsDir = join(SUPABASE_DIR, 'migrations');
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    await pg.exec(readFileSync(join(migrationsDir, file), 'utf8'));
  }
  await pg.exec(readFileSync(join(SUPABASE_DIR, 'seed', 'seed.sql'), 'utf8'));

  const admin = async <T>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows;

  const as = async <T>(role: ApiRole, claims: Claims, sql: string, params: unknown[] = []) =>
    pg.transaction(async (tx: Transaction) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      await tx.exec(`set local role ${role}`);
      return (await tx.query<T>(sql, params)).rows;
    });

  const [branch] = await admin<{ id: string }>(`select id from public.branches where slug = 'bahadurgarh-s6'`);
  return { pg, as, admin, branchId: branch!.id };
}

/** Claims for an Owner/Manager signed in with Supabase Auth (after the access-token hook). */
export function emailClaims(opts: {
  authUserId: string;
  staffId: string;
  branchId: string;
  role: 'owner' | 'manager';
  mfaSecondsAgo?: number | null;
}): Claims {
  const now = Math.floor(Date.now() / 1000);
  const mfa = opts.mfaSecondsAgo === null ? [] : [{ method: 'totp', timestamp: now - (opts.mfaSecondsAgo ?? 60) }];
  return {
    sub: opts.authUserId,
    role: 'authenticated',
    aal: mfa.length ? 'aal2' : 'aal1',
    amr: [{ method: 'password', timestamp: now - 600 }, ...mfa],
    staff_id: opts.staffId,
    branch_id: opts.branchId,
    staff_role: opts.role,
  };
}

/** Claims minted by the pin-login Edge Function. */
export function pinClaims(opts: { staffId: string; branchId: string; sessionId: string; deviceId: string; role: string }): Claims {
  return {
    sub: opts.staffId,
    role: 'authenticated',
    aal: 'aal1',
    staff_id: opts.staffId,
    branch_id: opts.branchId,
    staff_role: opts.role,
    pin_session_id: opts.sessionId,
    device_id: opts.deviceId,
  };
}

/** Assert a promise rejects with one of our API error codes (the Postgres MESSAGE). */
export async function apiError(promise: Promise<unknown>): Promise<{ code: string; detail?: string; hint?: unknown }> {
  try {
    await promise;
  } catch (e) {
    const err = e as { message: string; detail?: string; hint?: string };
    let hint: unknown = err.hint;
    try {
      hint = err.hint ? JSON.parse(err.hint) : undefined;
    } catch {
      /* hint is plain text */
    }
    return { code: err.message, ...(err.detail ? { detail: err.detail } : {}), hint };
  }
  throw new Error('Expected the call to fail, but it succeeded');
}

/** Create an Owner (with Supabase Auth user) and return ready-to-use claims. */
export async function makeOwner(db: TestDb, name = 'Vikram') {
  const authUserId = crypto.randomUUID();
  const email = `${name.toLowerCase()}@example.com`;
  await db.admin(`insert into auth.users (id, email) values ($1, $2)`, [authUserId, email]);
  const [row] = await db.as<{ id: string }>(
    'service_role',
    {},
    `select app.bootstrap_owner($1, $2, $3, $4) as id`,
    [authUserId, name, email, db.branchId],
  );
  const staffId = row!.id;
  return {
    staffId,
    authUserId,
    claims: (mfaSecondsAgo: number | null = 60) =>
      emailClaims({ authUserId, staffId, branchId: db.branchId, role: 'owner', mfaSecondsAgo }),
  };
}

export async function makeManager(db: TestDb, name = 'Meera') {
  const authUserId = crypto.randomUUID();
  const email = `${name.toLowerCase()}@example.com`;
  await db.admin(`insert into auth.users (id, email) values ($1, $2)`, [authUserId, email]);
  const [row] = await db.as<{ id: string }>(
    'service_role',
    {},
    `select app.create_login_staff($1, $2, $3, 'manager', $4) as id`,
    [authUserId, name, email, db.branchId],
  );
  const staffId = row!.id;
  return {
    staffId,
    claims: () => emailClaims({ authUserId, staffId, branchId: db.branchId, role: 'manager', mfaSecondsAgo: null }),
  };
}

export const sha256Hex = async (text: string) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex');

/** Pair a device and PIN-login a staff member; returns claims for that PIN session. */
export async function pinSession(
  db: TestDb,
  ownerClaims: Claims,
  opts: { staffId: string; pin: string; role: 'cashier' | 'kitchen'; allowedRoles?: string[] },
) {
  const [dev] = await db.as<{ d: { device_id: string; pairing_code: string } }>(
    'authenticated',
    ownerClaims,
    `select public.create_device('Counter tablet', $1::public.staff_role[]) as d`,
    [`{${(opts.allowedRoles ?? [opts.role]).join(',')}}`],
  );
  const secretHash = await sha256Hex(crypto.randomUUID());
  await db.as('service_role', {}, `select app.pair_device($1, $2)`, [dev!.d.pairing_code, secretHash]);
  const [login] = await db.as<{ r: { ok: boolean; session_id: string; device_id: string } }>(
    'service_role',
    {},
    `select app.pin_login($1, $2, $3) as r`,
    [secretHash, opts.staffId, opts.pin],
  );
  if (!login!.r.ok) throw new Error(`PIN login failed: ${JSON.stringify(login!.r)}`);
  return {
    secretHash,
    deviceId: login!.r.device_id,
    sessionId: login!.r.session_id,
    claims: pinClaims({
      staffId: opts.staffId,
      branchId: db.branchId,
      sessionId: login!.r.session_id,
      deviceId: login!.r.device_id,
      role: opts.role,
    }),
  };
}
