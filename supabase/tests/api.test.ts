import { beforeAll, describe, expect, it } from 'vitest';
import { type Deps, handle } from '../functions/api/handler.ts';
import { signJwt, verifyJwt } from '../functions/api/jwt.ts';
import { makeApi } from './apiHarness';
import { type TestDb, createTestDb, makeManager, makeOwner } from './harness';

let db: TestDb;
let deps: Deps;
let owner: Awaited<ReturnType<typeof makeOwner>>;
let publicJwk: JsonWebKey;
const invited: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
  owner = await makeOwner(db);
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const privateJwk = { ...(await crypto.subtle.exportKey('jwk', pair.privateKey)), kid: 'test-key' } as JsonWebKey;
  publicJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'test-key' } as JsonWebKey;
  deps = makeApi(db, {
    signingKey: { kid: 'test-key', privateJwk },
    verifyKeys: [publicJwk],
    now: () => new Date(),
    inviteUser: async (email) => {
      const id = crypto.randomUUID();
      await db.admin('insert into auth.users (id, email) values ($1, $2)', [id, email]);
      invited.push(email);
      return { id };
    },
  }).deps;
});

const call = async (method: string, path: string, opts: { body?: unknown; cookie?: string; token?: string; ip?: string } = {}) => {
  const res = await handle(
    new Request(`https://x.supabase.co/functions/v1/api${path}`, {
      method,
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.cookie ? { Cookie: opts.cookie } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        'cf-connecting-ip': opts.ip ?? '203.0.113.7',
      },
      ...(opts.body !== undefined ? { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) } : {}),
    }),
    deps,
  );
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? (JSON.parse(text) as Record<string, any>) : null };
};

async function pairDevice(roles = '{cashier}') {
  const [row] = await db.as<{ d: { pairing_code: string } }>('authenticated', owner.claims(), `select public.create_device('Counter', $1::public.staff_role[]) as d`, [roles]);
  const res = await call('POST', '/v1/auth/device/pair', { body: { pairing_code: row!.d.pairing_code }, ip: crypto.randomUUID() });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie')!;
  return setCookie.split(';')[0]!; // "__Host-sb_device=…"
}

describe('health & routing', () => {
  it('answers health checks and 404s unknown routes with the error envelope', async () => {
    expect(await call('GET', '/v1/health')).toMatchObject({ status: 200, body: { ok: true } });
    const res = await call('GET', '/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body!.error).toMatchObject({ code: 'NOT_FOUND', message: 'Not found.' });
    expect(res.body!.error.request_id).toMatch(/^req_/);
  });

  it('rejects non-JSON bodies', async () => {
    expect((await call('POST', '/v1/auth/device/pair', { body: 'not json' })).body!.error.code).toBe('BAD_REQUEST');
    expect((await call('POST', '/v1/auth/device/pair', { body: [1] })).body!.error.code).toBe('BAD_REQUEST');
  });
});

describe('public menu', () => {
  it('serves the menu with CDN caching and ETag revalidation', async () => {
    const res = await call('GET', '/v1/menu?branch=bahadurgarh-s6');
    expect(res.status).toBe(200);
    expect(res.body!.branch.name).toBe('The Slush Bar');
    expect(res.headers.get('cache-control')).toContain('s-maxage=30');
    const etag = res.headers.get('etag')!;
    const again = await handle(new Request('https://x/functions/v1/api/v1/menu?branch=bahadurgarh-s6', { headers: { 'If-None-Match': etag } }), deps);
    expect(again.status).toBe(304);
    expect((await call('GET', '/v1/menu?branch=nope')).status).toBe(404);
    expect((await call('GET', '/v1/menu?branch=../../etc')).status).toBe(404);
  });
});

describe('device pairing', () => {
  it('sets a first-party, HttpOnly device cookie', async () => {
    const [row] = await db.as<{ d: { pairing_code: string } }>('authenticated', owner.claims(), `select public.create_device('Counter', '{cashier}') as d`);
    const res = await call('POST', '/v1/auth/device/pair', { body: { pairing_code: row!.d.pairing_code } });
    expect(res.body).toEqual({ device_name: 'Counter' });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^__Host-sb_device=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict;/);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects bad and wrong codes', async () => {
    expect((await call('POST', '/v1/auth/device/pair', { body: { pairing_code: '12' }, ip: 'a' })).body!.error.code).toBe('VALIDATION_FAILED');
    expect((await call('POST', '/v1/auth/device/pair', { body: { pairing_code: '000000' }, ip: 'b' })).status).toBe(404);
  });

  it('limits pairing attempts per IP', async () => {
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await call('POST', '/v1/auth/device/pair', { body: { pairing_code: '000000' }, ip: 'flood' })).status);
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('PIN login', () => {
  let cashierId: string;
  let cookie: string;

  beforeAll(async () => {
    [{ id: cashierId }] = (await db.as<{ id: string }>('authenticated', owner.claims(), `select public.create_pin_staff('Simran', 'cashier', '4821') as id`)) as [{ id: string }];
    cookie = await pairDevice();
  });

  it('lists the staff allowed on this device', async () => {
    const res = await call('GET', '/v1/auth/device/staff', { cookie });
    expect(res.body).toEqual({ device_name: 'Counter', staff: [{ id: cashierId, name: 'Simran', role: 'cashier' }] });
    expect((await call('GET', '/v1/auth/device/staff')).body!.error.code).toBe('DEVICE_NOT_REGISTERED');
    expect((await call('GET', '/v1/auth/device/staff', { cookie: '__Host-sb_device=forged' })).body!.error.code).toBe('DEVICE_NOT_REGISTERED');
  });

  it('issues a signed token that the database accepts for exactly this person', async () => {
    const res = await call('POST', '/v1/auth/pin-login', { cookie, body: { staff_id: cashierId, pin: '4821' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ staff_name: 'Simran', role: 'cashier' });
    const claims = await verifyJwt(res.body!.access_token as string, [publicJwk], Math.floor(Date.now() / 1000));
    expect(claims).toMatchObject({ role: 'authenticated', aud: 'authenticated', sub: cashierId, staff_role: 'cashier' });
    expect((claims!.exp as number) - (claims!.iat as number)).toBeGreaterThan(11 * 3600);

    const [me] = await db.as<{ id: string; role: string }>('authenticated', claims!, `select (c).staff_id as id, (c).role from (select app.current_staff() c) x`);
    expect(me).toEqual({ id: cashierId, role: 'cashier' });
  });

  it('counts wrong PINs and locks after five', async () => {
    const [{ id }] = (await db.as<{ id: string }>('authenticated', owner.claims(), `select public.create_pin_staff('Ravi', 'cashier', '9315') as id`)) as [{ id: string }];
    const wrong = await call('POST', '/v1/auth/pin-login', { cookie, body: { staff_id: id, pin: '0001' } });
    expect(wrong.status).toBe(401);
    expect(wrong.body!.error).toMatchObject({ code: 'UNAUTHENTICATED', details: { attempts_left: 4 } });
    for (let i = 0; i < 3; i++) await call('POST', '/v1/auth/pin-login', { cookie, body: { staff_id: id, pin: '0001' } });
    const locked = await call('POST', '/v1/auth/pin-login', { cookie, body: { staff_id: id, pin: '0001' } });
    expect(locked.status).toBe(423);
    expect((await call('POST', '/v1/auth/pin-login', { cookie, body: { staff_id: id, pin: '9315' } })).status).toBe(423);
  });

  it('validates input and requires a paired device', async () => {
    expect((await call('POST', '/v1/auth/pin-login', { cookie, body: { staff_id: 'x', pin: '4821' } })).status).toBe(422);
    expect((await call('POST', '/v1/auth/pin-login', { cookie, body: { staff_id: cashierId, pin: '48211' } })).status).toBe(422);
    expect((await call('POST', '/v1/auth/pin-login', { body: { staff_id: cashierId, pin: '4821' } })).body!.error.code).toBe('DEVICE_NOT_REGISTERED');
  });

  it('refuses staff who aren’t allowed on the device', async () => {
    const kitchenCookie = await pairDevice('{kitchen}');
    const res = await call('POST', '/v1/auth/pin-login', { cookie: kitchenCookie, body: { staff_id: cashierId, pin: '4821' } });
    expect(res.body!.error.code).toBe('FORBIDDEN');
  });
});

describe('inviting a manager', () => {
  const ownerToken = async (mfaSecondsAgo: number | null = 60) =>
    signJwt({ ...owner.claims(mfaSecondsAgo), exp: Math.floor(Date.now() / 1000) + 3600 }, deps.signingKey);

  it('lets an Owner with recent 2FA invite a manager', async () => {
    const res = await call('POST', '/v1/admin/staff', { token: await ownerToken(), body: { name: 'Meera', email: 'Meera@Example.com', role: 'manager' } });
    expect(res.status).toBe(201);
    expect(invited).toContain('meera@example.com');
    const [row] = await db.admin<{ role: string }>(
      `select r.role from public.staff s join public.staff_branch_roles r on r.staff_id = s.id where s.email = 'meera@example.com'`,
    );
    expect(row!.role).toBe('manager');
    const [audit] = await db.admin<{ staff_id: string }>(`select staff_id from public.audit_logs where action = 'staff.created' order by id desc limit 1`);
    expect(audit!.staff_id).toBe(owner.staffId);
  });

  it('refuses a duplicate email', async () => {
    const res = await call('POST', '/v1/admin/staff', { token: await ownerToken(), body: { name: 'Meera', email: 'meera@example.com', role: 'manager' } });
    expect(res.body!.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { fields: { email: 'taken' } } });
  });

  it('requires recent 2FA, an Owner, and a genuine token', async () => {
    const stale = await call('POST', '/v1/admin/staff', { token: await ownerToken(3600), body: { name: 'A', email: 'a@example.com', role: 'manager' } });
    expect(stale.body!.error).toMatchObject({ code: 'FORBIDDEN', details: { reason: 'step_up_required' } });

    const manager = await makeManager(db, 'Asha');
    const managerToken = await signJwt({ ...manager.claims(), exp: Math.floor(Date.now() / 1000) + 3600 }, deps.signingKey);
    expect((await call('POST', '/v1/admin/staff', { token: managerToken, body: { name: 'B', email: 'b@example.com', role: 'manager' } })).body!.error.code).toBe('FORBIDDEN');

    expect((await call('POST', '/v1/admin/staff', { body: { name: 'C', email: 'c@example.com', role: 'manager' } })).status).toBe(401);
    const forged = (await ownerToken()).slice(0, -4) + 'AAAA';
    expect((await call('POST', '/v1/admin/staff', { token: forged, body: { name: 'C', email: 'c@example.com', role: 'manager' } })).status).toBe(401);
    const expired = await signJwt({ ...owner.claims(), exp: Math.floor(Date.now() / 1000) - 1 }, deps.signingKey);
    expect((await call('POST', '/v1/admin/staff', { token: expired, body: { name: 'C', email: 'c@example.com', role: 'manager' } })).status).toBe(401);
    expect(invited).not.toContain('a@example.com');
  });

  it('validates the invitation', async () => {
    const token = await ownerToken();
    const bad = await call('POST', '/v1/admin/staff', { token, body: { name: '', email: 'nope', role: 'manager' } });
    expect(bad.body!.error.details.fields).toEqual({ name: 'Enter a name (up to 60 characters).', email: 'Enter a valid email address.' });
    expect((await call('POST', '/v1/admin/staff', { token, body: { name: 'X', email: 'x@example.com', role: 'owner' } })).status).toBe(422);
  });
});
