import { DEFAULT_SETTINGS, SETTING_KEYS, checkPin, parseSetting, type SettingKey } from '@slush/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, apiError, createTestDb, makeManager, makeOwner } from './harness';

let db: TestDb;
let owner: Awaited<ReturnType<typeof makeOwner>>;

beforeAll(async () => {
  db = await createTestDb();
  owner = await makeOwner(db);
});

interface Def {
  key: SettingKey;
  value_type: string;
  nullable: boolean;
  min_value: string | null;
  max_value: string | null;
  default_value: unknown;
}

describe('database settings stay in sync with @slush/core', () => {
  it('has exactly the same keys and defaults', async () => {
    const defs = await db.admin<Def>('select * from public.setting_definitions order by key');
    expect(defs.map((d) => d.key).sort()).toEqual([...SETTING_KEYS].sort());
    for (const d of defs) expect(d.default_value, d.key).toEqual(DEFAULT_SETTINGS[d.key]);
  });

  it('accepts and rejects the same values', async () => {
    const defs = await db.admin<Def>('select * from public.setting_definitions');
    for (const d of defs) {
      const samples: unknown[] = [DEFAULT_SETTINGS[d.key], null, 'text', true, 1.5, -1, 0, 7, 'free_item', 'live'];
      if (d.min_value !== null) samples.push(Number(d.min_value), Number(d.min_value) - 1);
      if (d.max_value !== null) samples.push(Number(d.max_value), Number(d.max_value) + 1);
      if (d.key === 'gstin') samples.push('06ABCDE1234F1Z5', '06abcde1234f1z5');
      if (d.key === 'legal_name') samples.push('x'.repeat(121));
      for (const value of samples) {
        const core = parseSetting(d.key, value).ok;
        const [row] = await db.admin<{ problem: string | null }>(
          `select app.validate_setting(d, $2::jsonb) as problem from public.setting_definitions d where key = $1`,
          [d.key, JSON.stringify(value)],
        );
        expect(row!.problem === null, `${d.key} = ${JSON.stringify(value)}`).toBe(core);
      }
    }
  });

  it('applies the same PIN rules as the apps', async () => {
    const pins = ['0000', '1234', '8901', '4321', '1098', '1987', '2026', '2580', '1212', '4821', '9315', '0472', '1949', '2036', '12a4', '123'];
    for (const pin of pins) {
      const [row] = await db.admin<{ p: string | null }>('select app.pin_problem($1) as p', [pin]);
      expect(row!.p, pin).toBe(checkPin(pin));
    }
  });
});

describe('update_settings', () => {
  const call = (claims: Record<string, unknown>, changes: unknown) =>
    db.as<{ s: Record<string, unknown> }>('authenticated', claims, 'select public.update_settings($1::jsonb) as s', [
      JSON.stringify(changes),
    ]);

  it('lets the Owner change a rule and records it in the audit log', async () => {
    const [row] = await call(owner.claims(), { last_order_buffer_min: 20 });
    expect(row!.s.last_order_buffer_min).toBe(20);
    const audit = await db.admin<{ action: string; entity_id: string; before: unknown; after: unknown; staff_id: string }>(
      `select action, entity_id, before, after, staff_id from public.audit_logs where action = 'settings.updated' order by id desc limit 1`,
    );
    expect(audit[0]).toMatchObject({
      entity_id: 'last_order_buffer_min',
      before: { value: 15 },
      after: { value: 20 },
      staff_id: owner.staffId,
    });
  });

  it('asks for the 2FA code again when the last one is older than 15 minutes', async () => {
    const err = await apiError(call(owner.claims(20 * 60), { last_order_buffer_min: 10 }));
    expect(err).toMatchObject({ code: 'FORBIDDEN', hint: { reason: 'step_up_required' } });
  });

  it('refuses an Owner session without 2FA at all', async () => {
    expect((await apiError(call(owner.claims(null), { last_order_buffer_min: 10 }))).code).toBe('UNAUTHENTICATED');
  });

  it('refuses Managers', async () => {
    const manager = await makeManager(db);
    expect((await apiError(call(manager.claims(), { last_order_buffer_min: 10 }))).code).toBe('FORBIDDEN');
  });

  it('reports every invalid field', async () => {
    const err = await apiError(call(owner.claims(), { lucky_draw_token_limit: 0, gst_rate_bp: 'five', nope: 1 }));
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.hint).toEqual({
      fields: { lucky_draw_token_limit: 'Must be at least 1.', gst_rate_bp: 'Must be a whole number.', nope: 'Unknown setting.' },
    });
  });

  it('checks rules that depend on each other', async () => {
    expect((await apiError(call(owner.claims(), { gst_enabled: true }))).detail).toBe(
      'Turning on GST needs a GSTIN and a legal name.',
    );
    const [ok] = await call(owner.claims(), { gst_enabled: true, gstin: '06ABCDE1234F1Z5', legal_name: 'The Slush Bar' });
    expect(ok!.s.gst_enabled).toBe(true);
    await call(owner.claims(), { gst_enabled: false });
    expect((await apiError(call(owner.claims(), { delivery_enabled: true }))).code).toBe('VALIDATION_FAILED');
  });

  it('rejects an empty change', async () => {
    expect((await apiError(call(owner.claims(), {}))).code).toBe('VALIDATION_FAILED');
  });
});

describe('business hours and closures', () => {
  it('lets the Owner replace opening hours', async () => {
    const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '11:00', closes: '23:30' }));
    await db.as('authenticated', owner.claims(), 'select public.set_business_hours($1::jsonb)', [JSON.stringify(hours)]);
    const rows = await db.as<{ closes_at: string }>('authenticated', owner.claims(), 'select closes_at::text from public.business_hours');
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.closes_at === '23:30:00')).toBe(true);
  });

  it('rejects malformed windows', async () => {
    for (const bad of [[{ weekday: 7, opens: '11:00', closes: '23:00' }], [{ weekday: 1, opens: '9:00', closes: '23:00' }], [{ weekday: 1, opens: '11:00', closes: '11:00' }], { not: 'a list' }]) {
      const err = await apiError(
        db.as('authenticated', owner.claims(), 'select public.set_business_hours($1::jsonb)', [JSON.stringify(bad)]),
      );
      expect(err.code, JSON.stringify(bad)).toBe('VALIDATION_FAILED');
    }
  });

  it('lets a Manager add and remove an emergency closure', async () => {
    const manager = await makeManager(db, 'Asha');
    const [row] = await db.as<{ id: string }>(
      'authenticated',
      manager.claims(),
      `select public.add_store_closure(now(), now() + interval '2 hours', 'Power cut') as id`,
    );
    await db.as('authenticated', manager.claims(), 'select public.remove_store_closure($1)', [row!.id]);
    expect((await apiError(db.as('authenticated', manager.claims(), 'select public.remove_store_closure($1)', [row!.id]))).code).toBe('NOT_FOUND');
    expect(
      (await apiError(db.as('authenticated', manager.claims(), `select public.add_store_closure(now(), now() - interval '1 hour', 'x')`))).code,
    ).toBe('VALIDATION_FAILED');
    expect(
      (await apiError(db.as('authenticated', manager.claims(), `select public.add_store_closure(now(), now() + interval '1 hour', '  ')`))).code,
    ).toBe('VALIDATION_FAILED');
  });
});
