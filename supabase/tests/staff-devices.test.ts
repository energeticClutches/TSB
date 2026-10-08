import { beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, apiError, createTestDb, makeManager, makeOwner, pinSession, sha256Hex } from './harness';

let db: TestDb;
let owner: Awaited<ReturnType<typeof makeOwner>>;

beforeAll(async () => {
  db = await createTestDb();
  owner = await makeOwner(db);
});

const createPinStaff = (claims: Record<string, unknown>, name: string, role: string, pin: string) =>
  db.as<{ id: string }>('authenticated', claims, 'select public.create_pin_staff($1, $2::public.staff_role, $3) as id', [name, role, pin]);

describe('creating PIN staff', () => {
  it('creates a cashier and audits it without the PIN', async () => {
    const [row] = await createPinStaff(owner.claims(), 'Simran', 'cashier', '4821');
    const [audit] = await db.admin<{ after: Record<string, unknown> }>(
      `select after from public.audit_logs where action = 'staff.created' and entity_id = $1`,
      [row!.id],
    );
    expect(audit!.after).toEqual({ name: 'Simran', role: 'cashier' });
    expect(JSON.stringify(audit)).not.toContain('4821');
  });

  it('refuses weak PINs with a helpful message', async () => {
    const err = await apiError(createPinStaff(owner.claims(), 'Ravi', 'cashier', '1234'));
    expect(err).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'PIN can’t be a sequence like 1234 or 4321.' });
  });

  it('refuses a PIN another active colleague already uses', async () => {
    const err = await apiError(createPinStaff(owner.claims(), 'Ravi', 'kitchen', '4821'));
    expect(err).toMatchObject({ code: 'VALIDATION_FAILED', hint: { fields: { pin: 'taken' } } });
  });

  it('only allows cashier/kitchen roles, a name, and only the Owner', async () => {
    expect((await apiError(createPinStaff(owner.claims(), 'Ravi', 'manager', '9315'))).code).toBe('VALIDATION_FAILED');
    expect((await apiError(createPinStaff(owner.claims(), '   ', 'kitchen', '9315'))).code).toBe('VALIDATION_FAILED');
    const manager = await makeManager(db);
    expect((await apiError(createPinStaff(manager.claims(), 'Ravi', 'kitchen', '9315'))).code).toBe('FORBIDDEN');
    expect((await apiError(createPinStaff({}, 'Ravi', 'kitchen', '9315'))).code).toBe('UNAUTHENTICATED');
  });
});

describe('device pairing', () => {
  it('pairs once with a one-time 6-digit code', async () => {
    const [row] = await db.as<{ d: { device_id: string; pairing_code: string } }>(
      'authenticated',
      owner.claims(),
      `select public.create_device('Kitchen screen', array['kitchen']::public.staff_role[]) as d`,
    );
    expect(row!.d.pairing_code).toMatch(/^\d{6}$/);
    const secret = await sha256Hex('device-secret-1');
    const pair = (code: string) =>
      db.as<{ r: Record<string, unknown> }>('service_role', {}, 'select app.pair_device($1, $2) as r', [code, secret]);

    const wrong = row!.d.pairing_code === '000000' ? '000001' : '000000';
    expect((await pair(wrong))[0]!.r).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect((await pair(row!.d.pairing_code))[0]!.r).toMatchObject({ ok: true, device_name: 'Kitchen screen' });
    expect((await pair(row!.d.pairing_code))[0]!.r).toEqual({ ok: false, code: 'NOT_FOUND' }); // used up
  });

  it('rejects expired codes and caps failed attempts', async () => {
    const [row] = await db.as<{ d: { device_id: string; pairing_code: string } }>(
      'authenticated',
      owner.claims(),
      `select public.create_device('Old tablet', array['cashier']::public.staff_role[]) as d`,
    );
    await db.admin(`update public.devices set pairing_expires_at = now() - interval '1 second' where id = $1`, [row!.d.device_id]);
    const secret = await sha256Hex('device-secret-2');
    const [r] = await db.as<{ r: Record<string, unknown> }>('service_role', {}, 'select app.pair_device($1, $2) as r', [row!.d.pairing_code, secret]);
    expect(r!.r).toEqual({ ok: false, code: 'NOT_FOUND' });

    let last: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) {
      [{ r: last }] = (await db.as<{ r: Record<string, unknown> }>('service_role', {}, 'select app.pair_device($1, $2) as r', ['999999', secret])) as [{ r: Record<string, unknown> }];
    }
    expect(last).toEqual({ ok: false, code: 'RATE_LIMITED' });
  });

  it('validates the device name, roles and secret', async () => {
    const make = (name: string, roles: string) =>
      db.as('authenticated', owner.claims(), `select public.create_device($1, $2::public.staff_role[])`, [name, roles]);
    expect((await apiError(make('', '{cashier}'))).code).toBe('VALIDATION_FAILED');
    expect((await apiError(make('Tablet', '{owner}'))).code).toBe('VALIDATION_FAILED');
    expect((await apiError(make('Tablet', '{}'))).code).toBe('VALIDATION_FAILED');
    expect((await apiError(db.as('service_role', {}, `select app.pair_device('123456', 'not-a-hash')`))).code).toBe('BAD_REQUEST');
  });
});

describe('PIN login', () => {
  let cashierId: string;
  let kitchenId: string;

  beforeAll(async () => {
    [{ id: cashierId }] = (await createPinStaff(owner.claims(), 'Karan', 'cashier', '6173')) as [{ id: string }];
    [{ id: kitchenId }] = (await createPinStaff(owner.claims(), 'Neha', 'kitchen', '3906')) as [{ id: string }];
  });

  const login = (secretHash: string, staffId: string, pin: string) =>
    db.as<{ r: Record<string, unknown> }>('service_role', {}, 'select app.pin_login($1, $2, $3) as r', [secretHash, staffId, pin]).then((r) => r[0]!.r);

  it('signs in and produces a working session', async () => {
    const s = await pinSession(db, owner.claims(), { staffId: cashierId, pin: '6173', role: 'cashier' });
    const [me] = await db.as<{ staff_id: string; role: string }>('authenticated', s.claims, 'select (c).staff_id, (c).role from (select app.current_staff() c) x');
    expect(me).toEqual({ staff_id: cashierId, role: 'cashier' });
  });

  it('only shows staff allowed on that device', async () => {
    const s = await pinSession(db, owner.claims(), { staffId: kitchenId, pin: '3906', role: 'kitchen' });
    const [r] = await db.as<{ r: { staff: { name: string }[] } }>('service_role', {}, 'select app.device_staff($1) as r', [s.secretHash]);
    expect(r!.r.staff.map((x) => x.name)).toEqual(['Neha']);
    expect((await db.as<{ r: unknown }>('service_role', {}, 'select app.device_staff($1) as r', ['nope']))[0]!.r).toEqual({
      ok: false,
      code: 'DEVICE_NOT_REGISTERED',
    });
  });

  it('refuses a cashier on a kitchen-only device, and unknown devices', async () => {
    const s = await pinSession(db, owner.claims(), { staffId: kitchenId, pin: '3906', role: 'kitchen' });
    expect(await login(s.secretHash, cashierId, '6173')).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(await login('f'.repeat(64), cashierId, '6173')).toEqual({ ok: false, code: 'DEVICE_NOT_REGISTERED' });
  });

  it('locks the account for 15 minutes after 5 wrong PINs, even for the right PIN', async () => {
    const s = await pinSession(db, owner.claims(), { staffId: cashierId, pin: '6173', role: 'cashier' });
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await login(s.secretHash, cashierId, '0001'));
    expect(results.slice(0, 4).map((r) => r.attempts_left)).toEqual([4, 3, 2, 1]);
    expect(results[4]).toMatchObject({ ok: false, code: 'ACCOUNT_LOCKED' });
    expect(await login(s.secretHash, cashierId, '6173')).toMatchObject({ ok: false, code: 'ACCOUNT_LOCKED' });
    const [audit] = await db.admin<{ n: number }>(`select count(*)::int n from public.audit_logs where action = 'staff.pin_locked'`);
    expect(audit!.n).toBe(1);

    await db.admin(`update public.staff set locked_until = now() - interval '1 second' where id = $1`, [cashierId]);
    expect(await login(s.secretHash, cashierId, '6173')).toMatchObject({ ok: true });
  });

  it('ends sessions when the device is revoked', async () => {
    const s = await pinSession(db, owner.claims(), { staffId: cashierId, pin: '6173', role: 'cashier' });
    await db.as('authenticated', owner.claims(), 'select public.revoke_device($1)', [s.deviceId]);
    const [me] = await db.as<{ id: string | null }>('authenticated', s.claims, 'select app.current_staff_id() as id');
    expect(me!.id).toBeNull();
    expect(await login(s.secretHash, cashierId, '6173')).toEqual({ ok: false, code: 'DEVICE_NOT_REGISTERED' });
    expect((await apiError(db.as('authenticated', owner.claims(), 'select public.revoke_device($1)', [s.deviceId]))).code).toBe('NOT_FOUND');
  });

  it('ends a session on sign-out', async () => {
    const s = await pinSession(db, owner.claims(), { staffId: cashierId, pin: '6173', role: 'cashier' });
    await db.as('authenticated', s.claims, 'select public.end_pin_session()');
    const [me] = await db.as<{ id: string | null }>('authenticated', s.claims, 'select app.current_staff_id() as id');
    expect(me!.id).toBeNull();
  });

  it('resets a PIN: old PIN stops working and sessions end', async () => {
    const s = await pinSession(db, owner.claims(), { staffId: kitchenId, pin: '3906', role: 'kitchen' });
    await db.as('authenticated', owner.claims(), 'select public.reset_staff_pin($1, $2)', [kitchenId, '5082']);
    expect(await login(s.secretHash, kitchenId, '3906')).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' });
    expect(await login(s.secretHash, kitchenId, '5082')).toMatchObject({ ok: true });
    expect((await db.as<{ id: string | null }>('authenticated', s.claims, 'select app.current_staff_id() as id'))[0]!.id).toBeNull();
    expect((await apiError(db.as('authenticated', owner.claims(), 'select public.reset_staff_pin($1, $2)', [owner.staffId, '5082']))).code).toBe('NOT_FOUND');
  });

  it('deactivation locks the person out immediately', async () => {
    const [{ id }] = (await createPinStaff(owner.claims(), 'Temp', 'cashier', '7392')) as [{ id: string }];
    const s = await pinSession(db, owner.claims(), { staffId: id, pin: '7392', role: 'cashier' });
    await db.as('authenticated', owner.claims(), 'select public.deactivate_staff($1, $2)', [id, 'Left the job']);
    expect((await db.as<{ id: string | null }>('authenticated', s.claims, 'select app.current_staff_id() as id'))[0]!.id).toBeNull();
    expect(await login(s.secretHash, id, '7392')).toEqual({ ok: false, code: 'FORBIDDEN' });
    // A deactivated person's PIN can be reused by someone else.
    await createPinStaff(owner.claims(), 'New', 'cashier', '7392');
  });

  it('the Owner can’t deactivate themselves or an unknown person', async () => {
    const self = await apiError(db.as('authenticated', owner.claims(), 'select public.deactivate_staff($1, $2)', [owner.staffId, 'x']));
    expect(self.code).toBe('FORBIDDEN');
    const unknown = await apiError(db.as('authenticated', owner.claims(), 'select public.deactivate_staff($1, $2)', [crypto.randomUUID(), 'x']));
    expect(unknown.code).toBe('NOT_FOUND');
  });
});

describe('one owner per branch and the Supabase Auth hook', () => {
  it('bootstrap refuses a second owner', async () => {
    const err = await apiError(
      db.as('service_role', {}, 'select app.bootstrap_owner($1, $2, $3, $4)', [crypto.randomUUID(), 'X', 'x@example.com', db.branchId]),
    );
    expect(err.code).toBe('FORBIDDEN');
    expect((await apiError(db.as('service_role', {}, `select app.create_login_staff($1, 'X', 'y@example.com', 'cashier', $2)`, [crypto.randomUUID(), db.branchId]))).code).toBe('VALIDATION_FAILED');
  });

  it('adds staff claims for owners and managers only', async () => {
    const hook = (userId: string) =>
      db.as<{ e: { claims: Record<string, unknown> } }>('supabase_auth_admin', {}, 'select public.custom_access_token_hook($1::jsonb) as e', [
        JSON.stringify({ user_id: userId, claims: { sub: userId, role: 'authenticated' } }),
      ]);
    const [e] = await hook(owner.authUserId);
    expect(e!.e.claims).toMatchObject({ staff_id: owner.staffId, branch_id: db.branchId, staff_role: 'owner', role: 'authenticated' });
    const [none] = await hook(crypto.randomUUID());
    expect(none!.e.claims).toEqual(expect.not.objectContaining({ staff_id: expect.anything() }));
  });

  it('ignores forged or broken claims', async () => {
    const cases = [
      {},
      { staff_id: 'not-a-uuid', branch_id: db.branchId },
      { ...owner.claims(), sub: crypto.randomUUID() }, // someone else's token with the owner's staff_id
      { ...owner.claims(), branch_id: crypto.randomUUID() },
      { ...owner.claims(), pin_session_id: crypto.randomUUID() }, // owners can't use PIN sessions
    ];
    for (const claims of cases) {
      const [me] = await db.as<{ id: string | null }>('authenticated', claims, 'select app.current_staff_id() as id');
      expect(me!.id, JSON.stringify(claims)).toBeNull();
    }
  });
});
