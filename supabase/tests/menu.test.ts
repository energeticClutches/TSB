import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Claims, type TestDb, apiError, createTestDb, makeManager, makeOwner, pinSession } from './harness';

let db: TestDb;
let owner: Awaited<ReturnType<typeof makeOwner>>;
let manager: Claims;
let cashier: Claims;
let kitchen: Claims;

beforeAll(async () => {
  db = await createTestDb();
  owner = await makeOwner(db);
  manager = (await makeManager(db)).claims();
  const mk = async (name: string, role: 'cashier' | 'kitchen', pin: string) => {
    const [{ id }] = (await db.as<{ id: string }>('authenticated', owner.claims(), 'select public.create_pin_staff($1, $2::public.staff_role, $3) as id', [name, role, pin])) as [{ id: string }];
    return (await pinSession(db, owner.claims(), { staffId: id, pin, role })).claims;
  };
  cashier = await mk('Karan', 'cashier', '6173');
  kitchen = await mk('Neha', 'kitchen', '3906');
});

const rpc = <T = unknown>(claims: Claims, fn: string, arg: unknown) =>
  db.as<{ r: T }>('authenticated', claims, `select public.${fn}($1::jsonb) as r`, [JSON.stringify(arg)]).then((rows) => rows[0]!.r);
const version = async () => (await db.admin<{ v: string }>(`select menu_version::text as v from public.branches where id = $1`, [db.branchId]))[0]!.v;

describe('categories', () => {
  it('lets Managers create, rename and reorder; names are unique', async () => {
    const before = await version();
    const slushes = await rpc<string>(manager, 'upsert_category', { name: 'Slushes' });
    const shakes = await rpc<string>(manager, 'upsert_category', { name: 'Shakes' });
    expect(Number(await version())).toBeGreaterThan(Number(before));
    expect((await apiError(rpc(manager, 'upsert_category', { name: 'slushes' }))).detail).toBe('A category with that name already exists.');
    await rpc(manager, 'upsert_category', { id: shakes, name: 'Thick Shakes' });
    await db.as('authenticated', manager, 'select public.reorder_categories($1::uuid[])', [`{${shakes},${slushes}}`]);
    const rows = await db.as<{ name: string }>('authenticated', manager, 'select name from public.categories order by sort_order');
    expect(rows.map((r) => r.name)).toEqual(['Thick Shakes', 'Slushes']);
  });

  it('refuses cashiers, kitchen staff and empty names', async () => {
    expect((await apiError(rpc(cashier, 'upsert_category', { name: 'X' }))).code).toBe('FORBIDDEN');
    expect((await apiError(rpc(kitchen, 'upsert_category', { name: 'X' }))).code).toBe('FORBIDDEN');
    expect((await apiError(rpc(manager, 'upsert_category', { name: '  ' }))).code).toBe('VALIDATION_FAILED');
  });
});

describe('products', () => {
  let categoryId: string;
  let groupId: string;
  beforeAll(async () => {
    categoryId = await rpc<string>(manager, 'upsert_category', { name: 'Signature' });
    groupId = await rpc<string>(manager, 'upsert_modifier_group', {
      name: 'Toppings',
      kind: 'paid_addon',
      min_select: 0,
      max_select: 2,
      options: [
        { name: 'Popping boba', price_paise: 3000 },
        { name: 'Jelly', price_paise: 2000 },
      ],
    });
  });

  const strawberry = (extra: Record<string, unknown> = {}) => ({
    category_id: categoryId,
    name: 'Strawberry Splash',
    description: 'Hill strawberries',
    accent_color: '#FF1744',
    variants: [
      { name: 'Regular 350 ml', price_paise: 14900 },
      { name: 'Mega 500 ml', price_paise: 18900 },
    ],
    modifier_group_ids: [groupId],
    ...extra,
  });

  it('creates an item with sizes; the first size becomes the default', async () => {
    const r = await rpc<{ product_id: string; pending_approvals: unknown[] }>(manager, 'upsert_product', strawberry());
    expect(r.pending_approvals).toEqual([]);
    const variants = await db.as<{ name: string; is_default: boolean; price_paise: string }>(
      'authenticated',
      manager,
      'select name, is_default, price_paise::text from public.product_variants where product_id = $1 order by sort_order',
      [r.product_id],
    );
    expect(variants).toEqual([
      { name: 'Regular 350 ml', is_default: true, price_paise: '14900' },
      { name: 'Mega 500 ml', is_default: false, price_paise: '18900' },
    ]);
  });

  it('validates sizes, names, colours and categories', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ variants: [] }, 'Add at least one size with a price (up to 10).'],
      [{ variants: [{ name: 'A', price_paise: 100 }, { name: 'a', price_paise: 200 }] }, 'Each size needs a different name.'],
      [{ variants: [{ name: 'A', price_paise: -1 }] }, 'Every size needs a price between ₹0 and ₹1,00,000.'],
      [{ variants: [{ name: 'A', price_paise: 1, is_default: true }, { name: 'B', price_paise: 1, is_default: true }] }, 'Only one size can be the default.'],
      [{ category_id: crypto.randomUUID() }, 'Choose a category.'],
      [{ name: '' }, 'Name is required.'],
    ];
    for (const [patch, message] of cases) {
      const err = await apiError(rpc(manager, 'upsert_product', strawberry(patch)));
      expect(err, JSON.stringify(patch)).toMatchObject({ code: 'VALIDATION_FAILED', detail: message });
    }
    await expect(rpc(manager, 'upsert_product', strawberry({ accent_color: 'pink' }))).rejects.toThrow(/check constraint/);
  });

  it('audits price changes and keeps removed sizes archived, not deleted', async () => {
    const { product_id } = await rpc<{ product_id: string }>(manager, 'upsert_product', strawberry({ name: 'Mango Mania' }));
    const [regular] = await db.admin<{ id: string }>(`select id from public.product_variants where product_id = $1 and sort_order = 1`, [product_id]);
    await rpc(manager, 'upsert_product', {
      ...strawberry({ name: 'Mango Mania' }),
      id: product_id,
      variants: [{ id: regular!.id, name: 'Regular 350 ml', price_paise: 15900 }],
    });
    const [audit] = await db.admin<{ before: unknown; after: unknown }>(
      `select before, after from public.audit_logs where action = 'product.price_changed' and entity_id = $1`,
      [regular!.id],
    );
    expect(audit).toEqual({ before: { price_paise: 14900 }, after: { price_paise: 15900 } });
    const [{ n }] = (await db.admin<{ n: number }>(`select count(*)::int n from public.product_variants where product_id = $1 and archived_at is not null`, [product_id])) as [{ n: number }];
    expect(n).toBe(1);
  });

  it('sends large price drops by a Manager to the Owner, and keeps the old price meanwhile', async () => {
    const { product_id } = await rpc<{ product_id: string }>(manager, 'upsert_product', strawberry({ name: 'Kiwi Kick' }));
    const vars = await db.admin<{ id: string; name: string; price_paise: string }>(
      `select id, name, price_paise::text from public.product_variants where product_id = $1 order by sort_order`,
      [product_id],
    );
    const r = await rpc<{ pending_approvals: { approval_id: string }[] }>(manager, 'upsert_product', {
      ...strawberry({ name: 'Kiwi Kick' }),
      id: product_id,
      variants: [
        { id: vars[0]!.id, name: vars[0]!.name, price_paise: 1490 }, // ₹149 → ₹14.90 (typo!)
        { id: vars[1]!.id, name: vars[1]!.name, price_paise: 17900 }, // small drop: fine
      ],
    });
    expect(r.pending_approvals).toHaveLength(1);
    const now = await db.admin<{ price_paise: string }>(`select price_paise::text from public.product_variants where product_id = $1 order by sort_order`, [product_id]);
    expect(now.map((x) => x.price_paise)).toEqual(['14900', '17900']);

    const approvalId = r.pending_approvals[0]!.approval_id;
    // The Manager can see their own request but can't decide it; only the Owner can.
    expect(await db.as('authenticated', manager, 'select id from public.approval_requests')).toHaveLength(1);
    expect((await apiError(db.as('authenticated', manager, 'select public.decide_approval($1, true)', [approvalId]))).code).toBe('FORBIDDEN');
    const [{ r: result }] = (await db.as<{ r: string }>('authenticated', owner.claims(), 'select public.decide_approval($1, true, $2) as r', [approvalId, 'Happy hour test'])) as [{ r: string }];
    expect(result).toBe('approved');
    const [after] = await db.admin<{ price_paise: string }>(`select price_paise::text from public.product_variants where id = $1`, [vars[0]!.id]);
    expect(after!.price_paise).toBe('1490');
    expect((await apiError(db.as('authenticated', owner.claims(), 'select public.decide_approval($1, true)', [approvalId]))).code).toBe('INVALID_TRANSITION');
  });

  it('lets the Owner cut prices directly (still audited)', async () => {
    const { product_id } = await rpc<{ product_id: string }>(owner.claims(), 'upsert_product', strawberry({ name: 'Jamun Twist' }));
    const [v] = await db.admin<{ id: string }>(`select id from public.product_variants where product_id = $1 and sort_order = 1`, [product_id]);
    const r = await rpc<{ pending_approvals: unknown[] }>(owner.claims(), 'upsert_product', {
      ...strawberry({ name: 'Jamun Twist' }),
      id: product_id,
      variants: [{ id: v!.id, name: 'Regular 350 ml', price_paise: 100 }],
    });
    expect(r.pending_approvals).toEqual([]);
  });

  it('expires an approval if the price changed in the meantime', async () => {
    const { product_id } = await rpc<{ product_id: string }>(manager, 'upsert_product', strawberry({ name: 'Blue Lagoon' }));
    const [v] = await db.admin<{ id: string }>(`select id from public.product_variants where product_id = $1 and sort_order = 1`, [product_id]);
    const r = await rpc<{ pending_approvals: { approval_id: string }[] }>(manager, 'upsert_product', {
      ...strawberry({ name: 'Blue Lagoon' }),
      id: product_id,
      variants: [{ id: v!.id, name: 'Regular 350 ml', price_paise: 100 }],
    });
    await rpc(owner.claims(), 'upsert_product', { ...strawberry({ name: 'Blue Lagoon' }), id: product_id, variants: [{ id: v!.id, name: 'Regular 350 ml', price_paise: 13900 }] });
    const [{ r: result }] = (await db.as<{ r: string }>('authenticated', owner.claims(), 'select public.decide_approval($1, true) as r', [r.pending_approvals[0]!.approval_id])) as [{ r: string }];
    expect(result).toBe('expired');
  });

  it('lets cashiers mark items sold out, but not kitchen staff', async () => {
    const { product_id } = await rpc<{ product_id: string }>(manager, 'upsert_product', strawberry({ name: 'Sold Out Test' }));
    await db.as('authenticated', cashier, 'select public.set_product_sold_out($1, true)', [product_id]);
    const [row] = await db.admin<{ is_sold_out: boolean }>('select is_sold_out from public.products where id = $1', [product_id]);
    expect(row!.is_sold_out).toBe(true);
    expect((await apiError(db.as('authenticated', kitchen, 'select public.set_product_sold_out($1, false)', [product_id]))).code).toBe('FORBIDDEN');
    expect((await apiError(rpc(cashier, 'upsert_product', strawberry({ name: 'Nope' })))).code).toBe('FORBIDDEN');
  });

  it('archives items and blocks archiving a category that still has items', async () => {
    const cat = await rpc<string>(manager, 'upsert_category', { name: 'Temp' });
    const { product_id } = await rpc<{ product_id: string }>(manager, 'upsert_product', strawberry({ name: 'Temp item', category_id: cat }));
    expect((await apiError(db.as('authenticated', manager, 'select public.archive_category($1)', [cat]))).code).toBe('VALIDATION_FAILED');
    await db.as('authenticated', manager, 'select public.archive_product($1)', [product_id]);
    await db.as('authenticated', manager, 'select public.archive_category($1)', [cat]);
    const [{ n }] = (await db.admin<{ n: number }>('select count(*)::int n from public.products where id = $1', [product_id])) as [{ n: number }];
    expect(n).toBe(1); // archived, not deleted
  });

  it('builds combos only from regular items', async () => {
    const a = await rpc<{ product_id: string }>(manager, 'upsert_product', strawberry({ name: 'Combo part A' }));
    const b = await rpc<{ product_id: string }>(manager, 'upsert_product', strawberry({ name: 'Combo part B' }));
    const combo = await rpc<{ product_id: string }>(manager, 'upsert_product', {
      category_id: categoryId,
      kind: 'combo',
      name: 'Pizza + Slush',
      variants: [{ name: 'Combo', price_paise: 34900 }],
      combo_components: [{ product_id: a.product_id }, { product_id: b.product_id, qty: 1 }],
    });
    expect((await apiError(rpc(manager, 'upsert_product', { category_id: categoryId, kind: 'combo', name: 'Bad', variants: [{ name: 'C', price_paise: 1 }], combo_components: [{ product_id: a.product_id }] }))).detail).toBe('A combo needs at least two items.');
    expect(
      (await apiError(rpc(manager, 'upsert_product', { category_id: categoryId, kind: 'combo', name: 'Nested', variants: [{ name: 'C', price_paise: 1 }], combo_components: [{ product_id: a.product_id }, { product_id: combo.product_id }] }))).detail,
    ).toBe('Combos can only contain regular menu items.');
  });
});

describe('option groups', () => {
  it('validates choice limits and free-option prices', async () => {
    const bad = [
      [{ name: 'Ice', kind: 'free_option', min_select: 1, max_select: 1, options: [{ name: 'Light', price_paise: 500 }] }, 'Free options (like ice level) can’t have a price.'],
      [{ name: 'Ice', kind: 'free_option', min_select: 2, max_select: 1, options: [{ name: 'A' }, { name: 'B' }] }, 'Minimum and maximum choices must fit the number of options.'],
      [{ name: 'Ice', kind: 'free_option', min_select: 1, max_select: 1, options: [] }, 'Add between 1 and 20 options.'],
      [{ name: 'Ice', kind: 'free_option', min_select: 0, max_select: 1, options: [{ name: 'A', is_default: true }, { name: 'B', is_default: true }] }, 'More options are pre-selected than customers may choose.'],
    ] as const;
    for (const [arg, message] of bad) expect((await apiError(rpc(manager, 'upsert_modifier_group', arg))).detail).toBe(message);
  });

  it('archives removed options instead of deleting them', async () => {
    const id = await rpc<string>(manager, 'upsert_modifier_group', { name: 'Sweetness', kind: 'free_option', min_select: 1, max_select: 1, options: [{ name: '50%' }, { name: '100%', is_default: true }] });
    const opts = await db.admin<{ id: string; name: string }>('select id, name from public.modifier_options where group_id = $1 order by sort_order', [id]);
    await rpc(manager, 'upsert_modifier_group', { id, name: 'Sweetness', kind: 'free_option', min_select: 1, max_select: 1, options: [{ id: opts[1]!.id, name: '100%', is_default: true }] });
    const live = await db.admin<{ name: string }>('select name from public.modifier_options where group_id = $1 and archived_at is null', [id]);
    expect(live.map((o) => o.name)).toEqual(['100%']);
  });
});

describe('public menu snapshot', () => {
  it('contains the demo menu, hides archived/inactive items and exposes nothing private', async () => {
    const fresh = await createTestDb();
    await fresh.pg.exec(readFileSync(join(import.meta.dirname, '..', 'seed', 'demo_menu.sql'), 'utf8'));
    const [{ m }] = (await fresh.as<{ m: any }>('service_role', {}, `select app.menu_snapshot('bahadurgarh-s6') as m`)) as [{ m: any }];
    expect(m.categories.map((c: { name: string }) => c.name)).toEqual(['Slushes', 'Shakes', 'Pizzas', 'Mocktails']);
    expect(m.categories[2].windows).toEqual([{ days_mask: 127, start: '16:00', end: '23:00' }]);
    const strawberry = m.products.find((p: { name: string }) => p.name === 'Strawberry Splash');
    expect(strawberry.variants).toEqual([
      expect.objectContaining({ name: 'Regular 350 ml', price_paise: 14900, default: true }),
      expect.objectContaining({ name: 'Mega 500 ml', price_paise: 18900, default: false }),
    ]);
    expect(strawberry.modifier_groups.map((g: { name: string }) => g.name)).toEqual(['Ice level', 'Sweetness', 'Toppings']);
    expect(m.branch.hours).toHaveLength(7);
    expect(m.branch.last_order_buffer_min).toBe(15);

    await fresh.admin(`update public.products set archived_at = now() where name = 'Kiwi Kick'`);
    await fresh.admin(`update public.products set is_active = false where name = 'Jamun Twist'`);
    const [{ m: m2 }] = (await fresh.as<{ m: any }>('service_role', {}, `select app.menu_snapshot('bahadurgarh-s6') as m`)) as [{ m: any }];
    const names = m2.products.map((p: { name: string }) => p.name);
    expect(names).not.toContain('Kiwi Kick');
    expect(names).not.toContain('Jamun Twist');
    const json = JSON.stringify(m2);
    for (const secret of ['pin_hash', 'staff', 'email', 'gstin', 'refund']) expect(json).not.toContain(secret);
  });

  it('returns null for an unknown branch and isn’t callable from the browser', async () => {
    const [{ m }] = (await db.as<{ m: unknown }>('service_role', {}, `select app.menu_snapshot('nope') as m`)) as [{ m: unknown }];
    expect(m).toBeNull();
    await expect(db.as('anon', {}, `select app.menu_snapshot('bahadurgarh-s6')`)).rejects.toThrow(/permission denied/);
  });
});
