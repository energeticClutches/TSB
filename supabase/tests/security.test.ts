import { beforeAll, describe, expect, it } from 'vitest';
import { type Claims, type TestDb, apiError, createTestDb, makeManager, makeOwner, pinSession } from './harness';

let db: TestDb;
let owner: Awaited<ReturnType<typeof makeOwner>>;
let managerClaims: Claims;
let cashier: Claims;
let kitchen: Claims;

beforeAll(async () => {
  db = await createTestDb();
  owner = await makeOwner(db);
  managerClaims = (await makeManager(db)).claims();
  const make = async (name: string, role: 'cashier' | 'kitchen', pin: string) => {
    const [{ id }] = (await db.as<{ id: string }>('authenticated', owner.claims(), 'select public.create_pin_staff($1, $2::public.staff_role, $3) as id', [name, role, pin])) as [{ id: string }];
    return (await pinSession(db, owner.claims(), { staffId: id, pin, role })).claims;
  };
  cashier = await make('Karan', 'cashier', '6173');
  kitchen = await make('Neha', 'kitchen', '3906');
});

const count = async (claims: Claims, table: string, role: 'authenticated' | 'anon' = 'authenticated') =>
  (await db.as<{ n: number }>(role, claims, `select count(*)::int as n from ${table}`))[0]!.n;

describe('row-level security by role', () => {
  it('anonymous visitors can read nothing', async () => {
    for (const table of ['public.branches', 'public.settings', 'public.staff_branch_roles', 'public.audit_logs']) {
      await expect(count({}, table, 'anon'), table).rejects.toThrow(/permission denied/);
    }
  });

  it('a signed-out authenticated token sees no rows', async () => {
    expect(await count({}, 'public.settings')).toBe(0);
    expect(await count({}, 'public.branches')).toBe(0);
  });

  it('every staff role can read the shop settings and hours', async () => {
    for (const claims of [owner.claims(), managerClaims, cashier, kitchen]) {
      expect(await count(claims, 'public.settings')).toBe(24);
      expect(await count(claims, 'public.business_hours')).toBe(7);
      expect(await count(claims, 'public.branches')).toBe(1);
    }
  });

  it('only Owner and Manager see the team; others see only themselves', async () => {
    expect(await count(owner.claims(), 'public.staff')).toBe(4);
    expect(await count(managerClaims, 'public.staff')).toBe(4);
    expect(await count(cashier, 'public.staff')).toBe(1);
    expect(await count(kitchen, 'public.staff')).toBe(1);
  });

  it('only the Owner sees devices and the audit log', async () => {
    expect(await count(owner.claims(), 'public.devices')).toBeGreaterThan(0);
    expect(await count(owner.claims(), 'public.audit_logs')).toBeGreaterThan(0);
    for (const claims of [managerClaims, cashier, kitchen]) {
      expect(await count(claims, 'public.devices')).toBe(0);
      expect(await count(claims, 'public.audit_logs')).toBe(0);
    }
  });

  it('PIN hashes, pairing codes and sessions are never readable over the API', async () => {
    await expect(db.as('authenticated', owner.claims(), 'select pin_hash from public.staff')).rejects.toThrow(/permission denied/);
    await expect(db.as('authenticated', owner.claims(), 'select failed_pin_count from public.staff')).rejects.toThrow(/permission denied/);
    await expect(db.as('authenticated', owner.claims(), 'select secret_hash from public.devices')).rejects.toThrow(/permission denied/);
    await expect(db.as('authenticated', owner.claims(), 'select pairing_code_hash from public.devices')).rejects.toThrow(/permission denied/);
    await expect(db.as('authenticated', owner.claims(), 'select * from public.staff_sessions')).rejects.toThrow(/permission denied/);
  });

  it('nobody can write to tables directly, even the Owner', async () => {
    const attempts = [
      `update public.settings set value = '1' where key = 'loyalty_threshold_paise'`,
      `insert into public.business_hours (branch_id, weekday, opens_at, closes_at) values ('${db.branchId}', 1, '01:00', '02:00')`,
      `delete from public.store_closures`,
      `update public.staff set is_active = true`,
      `insert into public.audit_logs (id, actor_type, action, created_at, row_hash) values (1, 'system', 'x.y', now(), '\\x00')`,
    ];
    for (const sql of attempts) {
      await expect(db.as('authenticated', owner.claims(), sql), sql).rejects.toThrow(/permission denied/);
    }
  });

  it('service-only functions can’t be called from the API', async () => {
    for (const sql of [
      `select app.pin_login('x', gen_random_uuid(), '1111')`,
      `select app.bootstrap_owner(gen_random_uuid(), 'x', 'x@x.com', gen_random_uuid())`,
      `select app.audit('x.y', null, null)`,
      `select app.hit_rate_limit('x', 1, 60)`,
    ]) {
      await expect(db.as('authenticated', owner.claims(), sql), sql).rejects.toThrow(/permission denied/);
    }
  });

  it('kitchen and cashier can’t use Owner functions', async () => {
    for (const claims of [cashier, kitchen, managerClaims]) {
      expect((await apiError(db.as('authenticated', claims, `select public.create_device('x', '{cashier}')`))).code).toBe('FORBIDDEN');
      expect((await apiError(db.as('authenticated', claims, `select public.update_settings('{"gst_enabled": false}')`))).code).toBe('FORBIDDEN');
    }
  });
});

describe('audit log integrity', () => {
  it('is intact after normal use', async () => {
    const [r] = await db.as<{ bad: string | null }>('service_role', {}, 'select app.verify_audit_chain() as bad');
    expect(r!.bad).toBeNull();
  });

  it('blocks edits and deletes, even by the database superuser', async () => {
    await expect(db.admin(`update public.audit_logs set reason = 'x'`)).rejects.toThrow(/FORBIDDEN/);
    await expect(db.admin(`delete from public.audit_logs`)).rejects.toThrow(/FORBIDDEN/);
    await expect(db.admin(`truncate public.audit_logs`)).rejects.toThrow(/FORBIDDEN/);
  });

  it('detects tampering that bypasses the triggers', async () => {
    const tamper = async (sql: string) => {
      await db.admin('begin');
      await db.admin(`set local session_replication_role = replica`); // disables triggers
      await db.admin(sql);
      const [r] = await db.admin<{ bad: string | null }>('select app.verify_audit_chain()::text as bad');
      await db.admin('rollback');
      return r!.bad;
    };
    const [{ id: secondId }] = (await db.admin<{ id: string }>('select id::text from public.audit_logs order by id offset 1 limit 1')) as [{ id: string }];
    expect(await tamper(`update public.audit_logs set after = '{"value": 999}' where id = ${secondId}`)).toBe(secondId);
    expect(await tamper(`delete from public.audit_logs where id = ${secondId}`)).not.toBeNull();
    expect(await tamper(`delete from public.audit_logs where id = (select max(id) from public.audit_logs)`)).toBe('0');
  });
});

describe('utilities', () => {
  it('generates time-ordered version-7 UUIDs', async () => {
    const rows = await db.admin<{ id: string }>('select app.uuid_v7()::text as id from generate_series(1, 50)');
    for (const { id } of rows) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const prefixes = rows.map((r) => r.id.slice(0, 13));
    expect([...prefixes].sort()).toEqual(prefixes);
  });

  it('rate limits within a window', async () => {
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push((await db.as<{ ok: boolean }>('service_role', {}, `select app.hit_rate_limit('t', 3, 600) as ok`))[0]!.ok);
    }
    expect(results).toEqual([true, true, true, false]);
  });
});

/**
 * The automated part of the go-live security checklist (docs/PHASE-8-SECURITY.md §4): these
 * must hold for EVERY table and function, including ones added later.
 */
describe('go-live checks', () => {
  it('every public table has row-level security switched on', async () => {
    const bad = await db.admin<{ table_name: string }>(
      `select c.relname as table_name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(bad.map((b) => b.table_name)).toEqual([]);
  });

  it('the anonymous role can’t read or change any table', async () => {
    const granted = await db.admin<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
        where grantee = 'anon' and table_schema in ('public', 'app')`,
    );
    expect(granted).toEqual([]);
  });

  it('the anonymous and signed-in roles can’t call internal (app schema) functions', async () => {
    // Row-level-security policies run as the caller, so signed-in staff may read their OWN context.
    const CONTEXT_ONLY = ['claims', 'current_staff', 'current_staff_id', 'current_branch_id', 'current_role'];
    for (const [role, allowed] of [
      ['anon', []],
      ['authenticated', CONTEXT_ONLY],
    ] as const) {
      const callable = await db.admin<{ name: string }>(
        `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'app' and has_function_privilege($1, p.oid, 'execute')`,
        [role],
      );
      expect({ role, callable: callable.map((c) => c.name).sort() }).toEqual({ role, callable: [...allowed].sort() });
    }
  });

  it('the anonymous role can’t call the staff functions in public either', async () => {
    const callable = await db.admin<{ name: string }>(
      `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'execute')
          and p.proname <> 'custom_access_token_hook'`,
    );
    expect(callable.map((c) => c.name)).toEqual([]);
  });

  it('every staff function checks the caller’s role (no anonymous access through PostgREST)', async () => {
    // Sampled by calling each one with no claims: they must raise, never return data.
    const fns = await db.admin<{ name: string; args: string }>(
      `select p.proname as name, pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('authenticated', p.oid, 'execute')
          and p.pronargs = 0`,
    );
    expect(fns.length).toBeGreaterThan(3);
    // Signing out with no session is a harmless no-op, so it doesn't have to refuse.
    for (const fn of fns.filter((f) => f.name !== 'end_pin_session')) {
      const err = await apiError(db.as('authenticated', {}, `select public.${fn.name}()`));
      expect({ fn: fn.name, code: err.code }).toEqual({ fn: fn.name, code: 'UNAUTHENTICATED' });
    }
  });
});
