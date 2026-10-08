/** Staff sign-in: device pairing, PIN login, manager invites (docs/PHASE-7-API.md §4). */
import { type Handler, UUID, deviceSecretHash, limit, requireStaffToken, viaDb } from '../context.ts';
import { HttpError, clientIp, deviceCookie, json, randomToken, readJson, sha256Hex } from '../http.ts';
import { signJwt } from '../jwt.ts';

const PIN_SESSION_HOURS = 12;

interface PinLoginResult {
  ok: boolean;
  code?: string;
  attempts_left?: number;
  until?: string;
  session_id?: string;
  staff_id?: string;
  staff_name?: string;
  branch_id?: string;
  role?: string;
  device_id?: string;
  expires_at?: string;
}

// A new shop device sends the one-time code; we give it a random secret in an HttpOnly cookie.
export const pairDevice: Handler = async ({ req, deps: { db } }) => {
  await limit(db, `pair_ip:${await sha256Hex(clientIp(req))}`, 10, 600);
  const body = await readJson(req);
  const code = typeof body.pairing_code === 'string' ? body.pairing_code : '';
  if (!/^\d{6}$/.test(code)) throw new HttpError('VALIDATION_FAILED', 'Enter the 6-digit code.');
  const secret = randomToken(32);
  const [row] = await db.query<{ r: { ok: boolean; code?: string; device_name?: string } }>('select app.pair_device($1, $2) as r', [
    code,
    await sha256Hex(secret),
  ]);
  const r = row!.r;
  if (!r.ok) {
    if (r.code === 'RATE_LIMITED') throw new HttpError('RATE_LIMITED', 'Too many wrong codes. Wait 10 minutes.', undefined, { 'Retry-After': '600' });
    throw new HttpError('NOT_FOUND', 'That code is wrong or has expired.');
  }
  return json({ device_name: r.device_name }, 200, { 'Set-Cookie': deviceCookie(secret) });
};

export const deviceStaff: Handler = async ({ req, deps: { db } }) => {
  const [row] = await db.query<{ r: { ok: boolean; device_name?: string; staff?: unknown[] } }>('select app.device_staff($1) as r', [
    await deviceSecretHash(req),
  ]);
  if (!row!.r.ok) throw new HttpError('DEVICE_NOT_REGISTERED', 'This device isn’t set up for staff sign-in.');
  return json({ device_name: row!.r.device_name, staff: row!.r.staff });
};

export const pinLogin: Handler = async ({ req, deps }) => {
  const secretHash = await deviceSecretHash(req);
  await limit(deps.db, `pin_device:${secretHash}`, 30, 600);
  const body = await readJson(req);
  const staffId = typeof body.staff_id === 'string' && UUID.test(body.staff_id) ? body.staff_id : null;
  const pin = typeof body.pin === 'string' && /^\d{4}$/.test(body.pin) ? body.pin : null;
  if (!staffId || !pin) throw new HttpError('VALIDATION_FAILED', 'Choose your name and enter your 4-digit PIN.');

  const [row] = await deps.db.query<{ r: PinLoginResult }>('select app.pin_login($1, $2, $3, $4) as r', [secretHash, staffId, pin, PIN_SESSION_HOURS]);
  const r = row!.r;
  if (!r.ok) {
    if (r.code === 'UNAUTHENTICATED') throw new HttpError('UNAUTHENTICATED', 'Wrong PIN.', { attempts_left: r.attempts_left });
    if (r.code === 'ACCOUNT_LOCKED') throw new HttpError('ACCOUNT_LOCKED', 'Too many wrong PINs. Try again in 15 minutes.', { until: r.until });
    if (r.code === 'DEVICE_NOT_REGISTERED') throw new HttpError('DEVICE_NOT_REGISTERED', 'This device isn’t set up for staff sign-in.');
    throw new HttpError('FORBIDDEN', 'You can’t sign in on this device.');
  }

  const iat = Math.floor(deps.now().getTime() / 1000);
  const exp = Math.floor(new Date(r.expires_at!).getTime() / 1000);
  const token = await signJwt(
    {
      iss: `${deps.supabaseUrl}/auth/v1`,
      aud: 'authenticated',
      role: 'authenticated',
      sub: r.staff_id,
      iat,
      exp,
      aal: 'aal1',
      staff_id: r.staff_id,
      branch_id: r.branch_id,
      staff_role: r.role,
      pin_session_id: r.session_id,
      device_id: r.device_id,
    },
    deps.signingKey,
  );
  deps.log('pin_login', { staff_id: r.staff_id, device_id: r.device_id });
  return json({ access_token: token, expires_at: r.expires_at, staff_name: r.staff_name, role: r.role });
};

// Owner invites a Manager by email (Supabase Auth sends the invitation).
export const inviteManager: Handler = async ({ req, deps }) => {
  const claims = await requireStaffToken(req, deps);
  const body = await readJson(req);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (body.role !== 'manager') throw new HttpError('VALIDATION_FAILED', 'Only managers are invited by email.');
  const fields: Record<string, string> = {};
  if (name.length < 1 || name.length > 60) fields.name = 'Enter a name (up to 60 characters).';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) fields.email = 'Enter a valid email address.';
  if (Object.keys(fields).length) throw new HttpError('VALIDATION_FAILED', Object.values(fields)[0]!, { fields });

  // Check the caller is an Owner who confirmed 2FA recently, using the database's own rules.
  const branchId = await deps.db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    return viaDb(async () => {
      const [ctx] = await tx.query<{ branch_id: string }>(`select (app.require_role('owner')).branch_id as branch_id`);
      await tx.query('select app.require_recent_mfa()');
      return ctx!.branch_id;
    });
  });
  const [existing] = await deps.db.query('select 1 from public.staff where email = $1', [email]);
  if (existing) throw new HttpError('VALIDATION_FAILED', 'Someone with that email is already on the team.', { fields: { email: 'taken' } });

  const user = await deps.inviteUser(email);
  const [row] = await deps.db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    return tx.query<{ id: string }>(`select app.create_login_staff($1, $2, $3, 'manager', $4) as id`, [user.id, name, email, branchId]);
  });
  return json({ staff_id: row!.id }, 201);
};
