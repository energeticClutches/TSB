/**
 * Admin DEMO MODE backend. Runs the real database (every migration, rule, trigger and
 * row-level-security policy) inside the browser with PGlite, saved in IndexedDB, plus the real
 * Edge API with a fake Razorpay. Lets the owner click through every staff screen before any
 * Supabase / Razorpay account exists. Only downloaded when demo mode is on.
 */
import { type MenuSnapshot, productAvailability } from '@slush/core';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { handle } from '../../../../supabase/functions/api/handler.ts';
import type { Db, Deps } from '../../../../supabase/functions/api/handler.ts';
import { signJwt } from '../../../../supabase/functions/api/jwt.ts';
import type { Razorpay, RzpPayment } from '../../../../supabase/functions/api/razorpay.ts';
import shim from '../../../../supabase/dev/supabase-shim.sql?raw';
import seed from '../../../../supabase/seed/seed.sql?raw';
import demoMenu from '../../../../supabase/seed/demo_menu.sql?raw';
import { announceChange } from './client';

const migrations = import.meta.glob('../../../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const MIGRATION_NAMES = Object.keys(migrations).sort();
/** Any change to the migrations or seed (even an edit) means a fresh demo database. */
function fingerprint(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
const SCHEMA_VERSION = fingerprint(MIGRATION_NAMES.map((n) => migrations[n]).join('|') + seed + demoMenu + 'demo-v2');
const DB_NAME = 'slush-admin-demo';

export type DemoRole = 'owner' | 'manager' | 'cashier' | 'kitchen';
export const DEMO_PEOPLE: Record<DemoRole, { name: string; pin?: string }> = {
  owner: { name: 'Vikram (Owner)' },
  manager: { name: 'Meera (Manager)' },
  cashier: { name: 'Karan', pin: '6173' },
  kitchen: { name: 'Neha', pin: '3906' },
};

interface State {
  schema: string;
  branchId: string;
  owner: { authId: string; staffId: string };
  manager: { authId: string; staffId: string };
  cashier: { staffId: string };
  kitchen: { staffId: string };
  deviceSecret: string;
  sessions: Partial<Record<'cashier' | 'kitchen', { sessionId: string; deviceId: string }>>;
}

type Claims = Record<string, unknown>;

// ---------------------------------------------------------------------------- boot
let booting: Promise<Backend> | null = null;

export function backend(): Promise<Backend> {
  booting ??= boot();
  return booting;
}

async function open() {
  return PGlite.create(`idb://${DB_NAME}`, { extensions: { pgcrypto, citext }, relaxedDurability: true });
}

async function boot(): Promise<Backend> {
  let pg = await open();
  let state = await readState(pg);
  if (!state || state.schema !== SCHEMA_VERSION) {
    await pg.close();
    await deleteIdb(`/pglite/${DB_NAME}`);
    pg = await open();
    state = await build(pg);
  }
  const b = new Backend(pg, state, await makeKeys());
  await b.refreshPinSessions();
  return b;
}

async function readState(pg: PGlite): Promise<State | null> {
  try {
    const { rows } = await pg.query<{ v: State }>(`select v from demo.state where k = 'state'`);
    return rows[0]?.v ?? null;
  } catch {
    return null;
  }
}

function deleteIdb(name: string) {
  return new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
}

export async function resetDemo() {
  const b = await backend();
  await b.pg.close();
  await deleteIdb(`/pglite/${DB_NAME}`);
  booting = null;
}

const sha256Hex = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((x) => x.toString(16).padStart(2, '0')).join('');

async function build(pg: PGlite): Promise<State> {
  await pg.exec(shim);
  for (const name of MIGRATION_NAMES) await pg.exec(migrations[name]!);
  await pg.exec(seed);
  await pg.exec(demoMenu);
  // Demo shop never closes, so orders can be tried at any hour.
  await pg.exec(`update public.business_hours set opens_at = '00:00', closes_at = '00:00'`);

  const q = async <T>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows;
  const as = <T>(claims: Claims, sql: string, params: unknown[] = []) => runAs<T>(pg, claims, sql, params);
  const [{ id: branchId }] = (await q<{ id: string }>(`select id from public.branches where slug = 'bahadurgarh-s6'`)) as [{ id: string }];

  const ownerAuth = crypto.randomUUID();
  const managerAuth = crypto.randomUUID();
  await q(`insert into auth.users (id, email) values ($1, 'owner@demo.local'), ($2, 'manager@demo.local')`, [ownerAuth, managerAuth]);
  const [{ id: ownerId }] = (await q<{ id: string }>(`select app.bootstrap_owner($1, $2, 'owner@demo.local', $3) as id`, [ownerAuth, DEMO_PEOPLE.owner.name, branchId])) as [{ id: string }];
  const [{ id: managerId }] = (await q<{ id: string }>(`select app.create_login_staff($1, $2, 'manager@demo.local', 'manager', $3) as id`, [managerAuth, DEMO_PEOPLE.manager.name, branchId])) as [{ id: string }];
  const owner = emailClaims(ownerAuth, ownerId, branchId, 'owner');
  const pinStaff = async (role: 'cashier' | 'kitchen') =>
    ((await as<{ id: string }>(owner, `select public.create_pin_staff($1, $2::public.staff_role, $3) as id`, [DEMO_PEOPLE[role].name, role, DEMO_PEOPLE[role].pin])) as [{ id: string }])[0].id;
  const cashierId = await pinStaff('cashier');
  const kitchenId = await pinStaff('kitchen');

  // One counter tablet, paired, that both PIN staff may use.
  const [{ d }] = (await as<{ d: { pairing_code: string } }>(owner, `select public.create_device('Counter tablet (demo)', '{cashier,kitchen}') as d`)) as [{ d: { pairing_code: string } }];
  const deviceSecret = await sha256Hex(crypto.randomUUID());
  await q(`select app.pair_device($1, $2)`, [d.pairing_code, deviceSecret]);

  for (const label of ['01', '02', '03', '04']) await as(owner, `select public.create_qr('table', $1)`, [label]);
  await as(owner, `select public.create_qr('counter', null)`);

  // Demo-only business decisions so offers can be tried (the real shop decides in Settings).
  await pg.exec(`update public.settings set value = 'true' where key = 'offers_enabled';`);
  await as(owner, `select public.upsert_coupon($1::jsonb)`, [
    JSON.stringify({ code: 'SLUSH10', description: 'Demo coupon', discount_type: 'percent', value: 1000, max_discount_paise: 5000, min_order_paise: 20000, usage_limit_total: 100, usage_limit_per_customer: 1, is_active: true }),
  ]);
  const [{ id: slushes }] = (await q<{ id: string }>(`select id from public.categories where name = 'Slushes'`)) as [{ id: string }];
  await as(owner, `select public.upsert_promotion($1::jsonb)`, [
    JSON.stringify({ kind: 'happy_hour', name: 'Happy hour: 20% off slushes, 3–6 PM', discount_type: 'percent', value: 2000, start_time: '15:00', end_time: '18:00', category_ids: [slushes], is_active: true }),
  ]);

  const state: State = {
    schema: SCHEMA_VERSION,
    branchId,
    owner: { authId: ownerAuth, staffId: ownerId },
    manager: { authId: managerAuth, staffId: managerId },
    cashier: { staffId: cashierId },
    kitchen: { staffId: kitchenId },
    deviceSecret,
    sessions: {},
  };
  await pg.exec(`create schema demo; create table demo.state (k text primary key, v jsonb not null);`);
  await q(`insert into demo.state values ('state', $1)`, [JSON.stringify(state)]);
  return state;
}

function runAs<T>(pg: PGlite, claims: Claims, sql: string, params: unknown[] = []): Promise<T[]> {
  return pg.transaction(async (tx: Transaction) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await tx.exec('set local role authenticated');
    return (await tx.query<T>(sql, params)).rows;
  });
}

function emailClaims(authId: string, staffId: string, branchId: string, role: 'owner' | 'manager'): Claims {
  const now = Math.floor(Date.now() / 1000);
  // A just-completed 2FA check, so step-up prompts don't appear in the demo.
  return {
    sub: authId,
    role: 'authenticated',
    aal: 'aal2',
    amr: [{ method: 'password', timestamp: now - 60 }, { method: 'totp', timestamp: now - 30 }],
    staff_id: staffId,
    branch_id: branchId,
    staff_role: role,
    exp: now + 3600,
  };
}

async function makeKeys() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return {
    signingKey: { kid: 'demo', privateJwk: { ...(await crypto.subtle.exportKey('jwk', pair.privateKey)), kid: 'demo' } as JsonWebKey },
    publicJwk: { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'demo' } as JsonWebKey,
  };
}

// ---------------------------------------------------------------------------- fake Razorpay
class DemoRazorpay implements Razorpay {
  keyId = 'rzp_test_demo';
  private orders = new Map<string, number>();
  private payments = new Map<string, RzpPayment[]>();
  private n = 0;
  private uid = () => `${Date.now().toString(36)}${(++this.n).toString(36)}`;
  /** Called a few seconds after a refund, like Razorpay's `refund.processed` webhook. */
  onRefundProcessed: (refundId: string, paymentId: string, amount: number) => void = () => undefined;
  async createOrder(input: { amount_paise: number }) {
    const id = `order_DEMO${this.uid()}`;
    this.orders.set(id, input.amount_paise);
    return { id };
  }
  async fetchOrderPayments(orderId: string) {
    return this.payments.get(orderId) ?? [];
  }
  /** Everything "captured" in the demo, for the reconciliation job. */
  async fetchPayments() {
    return [...this.payments.values()].flat();
  }
  async refund(input: { payment_id: string; amount_paise: number }) {
    const id = `rfnd_DEMO${this.uid()}`;
    window.setTimeout(() => this.onRefundProcessed(id, input.payment_id, input.amount_paise), 4000);
    return { id };
  }
  pay(orderId: string, vpa: string) {
    const p: RzpPayment = { id: `pay_DEMO${this.uid()}`, order_id: orderId, amount: this.orders.get(orderId) ?? 0, currency: 'INR', status: 'captured', method: 'upi', vpa };
    this.payments.set(orderId, [p]);
  }
}

// ---------------------------------------------------------------------------- backend
export class Backend {
  private deps: Deps;
  private razorpay = new DemoRazorpay();

  constructor(
    readonly pg: PGlite,
    private state: State,
    private keys: Awaited<ReturnType<typeof makeKeys>>,
  ) {
    const db: Db = {
      query: async (text, params = []) => (await pg.query(text, params)).rows as never,
      transaction: (fn) => pg.transaction((tx) => fn({ query: async (t, p = []) => (await tx.query(t, p)).rows as never })),
    };
    this.deps = {
      db,
      supabaseUrl: 'https://demo.local',
      signingKey: keys.signingKey,
      verifyKeys: [keys.publicJwk],
      inviteUser: async (email) => {
        const id = crypto.randomUUID();
        await pg.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
        return { id };
      },
      razorpay: this.razorpay,
      secrets: { razorpayKeySecret: 'demo', razorpayWebhookSecret: 'demo', identityPepper: 'demo-pepper', jobSecret: 'demo' },
      verifyTurnstile: async () => true,
      now: () => new Date(),
      log: (event, data) => console.info('[demo api]', event, data),
    };
    this.wireRefunds();
  }

  private wireRefunds() {
    this.razorpay.onRefundProcessed = (id, paymentId, amount) =>
      void this.pg.query('select app.apply_refund_event($1, $2, $3, true, null)', [id, paymentId, amount]).then(announceChange, (e: unknown) => console.warn('[demo] refund webhook', e));
  }

  get branchId() {
    return this.state.branchId;
  }

  /** PIN sessions last 12 hours; log the demo cashier/kitchen in again on every start. */
  async refreshPinSessions() {
    for (const role of ['cashier', 'kitchen'] as const) {
      const { rows } = await this.pg.query<{ r: { ok: boolean; session_id: string; device_id: string } }>(`select app.pin_login($1, $2, $3) as r`, [
        this.state.deviceSecret,
        this.state[role].staffId,
        DEMO_PEOPLE[role].pin,
      ]);
      const r = rows[0]!.r;
      if (r.ok) this.state.sessions[role] = { sessionId: r.session_id, deviceId: r.device_id };
    }
  }

  claims(role: DemoRole): Claims {
    const s = this.state;
    if (role === 'owner') return emailClaims(s.owner.authId, s.owner.staffId, s.branchId, 'owner');
    if (role === 'manager') return emailClaims(s.manager.authId, s.manager.staffId, s.branchId, 'manager');
    const session = s.sessions[role];
    return {
      sub: s[role].staffId,
      role: 'authenticated',
      aal: 'aal1',
      staff_id: s[role].staffId,
      branch_id: s.branchId,
      staff_role: role,
      pin_session_id: session?.sessionId,
      device_id: session?.deviceId,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    };
  }

  token(role: DemoRole) {
    return signJwt(this.claims(role), this.keys.signingKey);
  }

  as<T>(role: DemoRole, sql: string, params: unknown[] = []) {
    return runAs<T>(this.pg, this.claims(role), sql, params);
  }

  /** Our Edge API, called in-process instead of over the network. */
  async fetch(path: string, init: { method: string; body?: string; headers: Record<string, string> }) {
    const res = await handle(new Request(`https://demo.local/v1${path}`, init), this.deps);
    if (init.method !== 'GET') announceChange();
    return res;
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `demo-${crypto.randomUUID()}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json()) as T & { error?: { message: string } };
    if (!res.ok) throw new Error(json.error?.message ?? 'Demo order failed');
    return json;
  }

  /**
   * A customer scans a QR, orders and pays by UPI: through the real checkout API and the real
   * "did my payment go through?" check. The order lands on the board like a real one.
   */
  async simulateCustomerOrder(opts: { mobile?: string; name?: string; big?: boolean } = {}) {
    const menu = await this.api<MenuSnapshot>('GET', '/menu?branch=bahadurgarh-s6');
    const now = new Date();
    const products = menu.products.filter(
      (p) =>
        p.kind !== 'combo' &&
        productAvailability(p, menu.categories.find((c) => c.id === p.category_id), now) === 'available' &&
        p.modifier_groups.every((g) => g.options.filter((o) => o.default && !o.sold_out).length >= g.min),
    );
    if (!products.length) throw new Error('Nothing on the menu can be ordered right now.');
    const pick = () => products[Math.floor(Math.random() * products.length)]!;
    const lines: { line_id: string; product_id: string; variant_id: string; qty: number; option_ids: string[] }[] = Array.from({ length: opts.big ? 2 : 1 + Math.floor(Math.random() * 2) }, (_, i) => {
      const p = pick();
      return {
        line_id: `l${i}`,
        product_id: p.id,
        variant_id: (p.variants.find((v) => v.default) ?? p.variants[0]!).id,
        qty: opts.big ? 3 : 1 + Math.floor(Math.random() * 2),
        option_ids: p.modifier_groups.flatMap((g) => g.options.filter((o) => o.default && !o.sold_out).map((o) => o.id)),
      };
    });
    const { rows: qrs } = await this.pg.query<{ slug: string; kind: string }>(`select slug, kind from public.qr_codes where is_active order by random() limit 1`);
    const qr = qrs[0];
    const names = ['Aarav', 'Riya', 'Kabir', 'Ananya', 'Ishaan', 'Diya', 'Vihaan', 'Saanvi', 'Arjun', 'Myra'];
    const mobile = opts.mobile ?? `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
    const notes = ['', '', '', 'Less ice please', 'Kids at the table', 'Extra straws'];
    const checkout = await this.api<{ public_token: string; razorpay: { order_id: string } | null }>('POST', '/checkout', {
      ...(qr ? { qr_slug: qr.slug } : {}),
      order_type: qr?.kind === 'table' ? 'dine_in' : 'takeaway',
      lines,
      customer: { name: opts.name ?? names[Math.floor(Math.random() * names.length)], mobile },
      note: notes[Math.floor(Math.random() * notes.length)],
      device_id: crypto.randomUUID(),
      'cf-turnstile-response': 'demo',
    });
    if (checkout.razorpay) {
      this.razorpay.pay(checkout.razorpay.order_id, 'customer@okicici');
      await this.api('POST', `/orders/${checkout.public_token}/payment-check`, {});
    }
    return checkout.public_token;
  }

  /**
   * A regular: a few big paid orders on one number, each accepted, made and handed over by the
   * counter, so their spending crosses ₹2,000 and they earn a Lucky Draw number.
   */
  async simulateRegular() {
    const mobile = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
    const name = ['Meher', 'Advik', 'Tara', 'Reyansh'][Math.floor(Math.random() * 4)]!;
    for (let i = 0; i < 8; i++) {
      const token = await this.simulateCustomerOrder({ mobile, name, big: true });
      const { rows } = await this.pg.query<{ id: string; version: number; progress: number; threshold: number }>(
        `select o.id, o.version, coalesce(a.spend_paise, 0) as progress, k.threshold_paise as threshold
           from public.orders o
           join public.customers c on c.id = o.customer_id
           left join lateral (select * from app.active_campaign(o.branch_id)) k on true
           left join public.loyalty_accounts a on a.campaign_id = k.id and a.customer_id = c.id
          where o.public_token = $1`,
        [token],
      );
      const o = rows[0]!;
      await this.as('cashier', 'select public.accept_order($1, $2)', [o.id, o.version]);
      for (const to of ['preparing', 'ready', 'completed']) {
        const { rows: v } = await this.pg.query<{ version: number }>('select version from public.orders where id = $1', [o.id]);
        await this.as('cashier', 'select public.advance_order($1, $2, $3::public.order_status)', [o.id, v[0]!.version, to]);
      }
      const { rows: c } = await this.pg.query<{ n: number }>(
        `select count(*)::int as n from public.lucky_draw_tokens t join public.customers c on c.id = t.customer_id where c.mobile = $1`,
        [`+91${mobile}`],
      );
      if (c[0]!.n > 0) break;
    }
    announceChange();
  }
}
