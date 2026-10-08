/**
 * A tiny stand-in for the Supabase JS client, backed by the in-browser demo database. It covers
 * exactly what the admin app uses: `rpc`, `from().select()` reads (with PostgREST-style embedded
 * relations), realtime channels (fired by demo data changes) and storage (disabled).
 * Every call runs as the signed-in demo role, so row-level security applies as in production.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Backend, DemoRole } from './backend';

type PgError = { message: string; detail?: string; hint?: string; code?: string };
type Result = { data: unknown; error: { message: string; details: string | null; hint: string | null; code: string } | null };

const toError = (e: unknown): Result['error'] => {
  const err = e as PgError;
  return { message: err.message ?? 'Demo database error', details: err.detail ?? null, hint: err.hint ?? null, code: err.code ?? 'XX000' };
};

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Bad identifier: ${s}`);
  return `"${s}"`;
};

/** PostgREST sends arrays of plain values as Postgres arrays and objects as JSON. */
function param(v: unknown): unknown {
  if (v === undefined) return null;
  if (Array.isArray(v) && v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x))) {
    return `{${v.map((x) => (x === null ? 'NULL' : `"${String(x).replace(/["\\]/g, '\\$&')}"`)).join(',')}}`;
  }
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

// ---------------------------------------------------------------------------- foreign keys
interface Fk {
  name: string;
  src: string;
  dst: string;
  srcCol: string;
  dstCol: string;
}
let fks: Promise<Fk[]> | null = null;
const loadFks = (b: Backend) =>
  (fks ??= b.pg
    .query<Fk>(
      `select con.conname as name, cl.relname as src, cf.relname as dst, a.attname as "srcCol", af.attname as "dstCol"
         from pg_constraint con
         join pg_class cl on cl.oid = con.conrelid
         join pg_class cf on cf.oid = con.confrelid
         join pg_namespace n on n.oid = cl.relnamespace and n.nspname = 'public'
         join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
         join pg_attribute af on af.attrelid = con.confrelid and af.attnum = con.confkey[1]
        where con.contype = 'f'`,
    )
    .then((r) => r.rows));

/** Split "a, b(c, d), e" on top-level commas. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function columnsSql(b: Backend, table: string, alias: string, cols: string, depth = 0): Promise<string> {
  const parts: string[] = [];
  for (const item of splitTop(cols.replace(/\s+/g, ' '))) {
    if (item === '*') {
      parts.push(`${alias}.*`);
      continue;
    }
    const m = /^([a-z_]+)(?:!([a-z_]+))?\((.*)\)$/s.exec(item);
    if (!m) {
      parts.push(`${alias}.${ident(item)}`);
      continue;
    }
    const [, rel, hint, inner] = m as unknown as [string, string, string | undefined, string];
    const all = await loadFks(b);
    const inner_alias = `e${depth}`;
    const child = all.find((f) => f.src === rel && f.dst === table && (!hint || f.name === hint));
    const parent = all.find((f) => f.src === table && f.dst === rel && (!hint || f.name === hint));
    const sub = await columnsSql(b, rel, inner_alias, inner, depth + 1);
    if (child) {
      parts.push(
        `(select coalesce(json_agg(row_to_json(z)), '[]'::json) from (select ${sub} from public.${ident(rel)} ${inner_alias} where ${inner_alias}.${ident(child.srcCol)} = ${alias}.${ident(child.dstCol)}) z) as ${ident(rel)}`,
      );
    } else if (parent) {
      parts.push(
        `(select row_to_json(z) from (select ${sub} from public.${ident(rel)} ${inner_alias} where ${inner_alias}.${ident(parent.dstCol)} = ${alias}.${ident(parent.srcCol)}) z) as ${ident(rel)}`,
      );
    } else {
      throw new Error(`Demo client: no relation ${table} → ${rel}`);
    }
  }
  return parts.join(', ');
}

class Query implements PromiseLike<Result> {
  private cols = '*';
  private where: string[] = [];
  private params: unknown[] = [];
  private orders: string[] = [];
  private max: number | null = null;
  private mode: 'many' | 'single' | 'maybe' = 'many';

  constructor(
    private b: Backend,
    private role: DemoRole,
    private table: string,
  ) {}

  select(cols = '*') {
    this.cols = cols;
    return this;
  }
  private add(op: string, col: string, v: unknown) {
    this.params.push(param(v));
    this.where.push(`x.${ident(col)} ${op} $${this.params.length}`);
    return this;
  }
  eq(col: string, v: unknown) {
    return this.add('=', col, v);
  }
  neq(col: string, v: unknown) {
    return this.add('<>', col, v);
  }
  gte(col: string, v: unknown) {
    return this.add('>=', col, v);
  }
  lte(col: string, v: unknown) {
    return this.add('<=', col, v);
  }
  is(col: string, v: null | boolean) {
    this.where.push(`x.${ident(col)} is ${v === null ? 'null' : v ? 'true' : 'false'}`);
    return this;
  }
  order(col: string, opts: { ascending?: boolean } = {}) {
    this.orders.push(`x.${ident(col)} ${opts.ascending === false ? 'desc' : 'asc'}`);
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  single() {
    this.mode = 'single';
    return this;
  }
  maybeSingle() {
    this.mode = 'maybe';
    return this;
  }

  private async run(): Promise<Result> {
    try {
      const cols = await columnsSql(this.b, this.table, 'x', this.cols);
      const sql = `select ${cols} from public.${ident(this.table)} x${this.where.length ? ` where ${this.where.join(' and ')}` : ''}${
        this.orders.length ? ` order by ${this.orders.join(', ')}` : ''
      }${this.max !== null ? ` limit ${Math.floor(this.max)}` : ''}`;
      const rows = await this.b.as<Record<string, unknown>>(this.role, sql, this.params);
      if (this.mode === 'many') return { data: rows, error: null };
      if (rows.length > 1 || (this.mode === 'single' && rows.length === 0)) {
        return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', details: null, hint: null, code: 'PGRST116' } };
      }
      return { data: rows[0] ?? null, error: null };
    } catch (e) {
      return { data: null, error: toError(e) };
    }
  }

  then<A = Result, B = never>(ok?: ((r: Result) => A | PromiseLike<A>) | null, fail?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return this.run().then(ok, fail);
  }
}

/** In the demo, "realtime" is a browser event fired whenever the demo backend changes data. */
export const DEMO_CHANGE = 'slush-demo-change';
export const announceChange = () => window.dispatchEvent(new Event(DEMO_CHANGE));

// Read-only functions don't announce changes (they'd make screens reload in a loop).
const READS = new Set(['live_orders', 'kitchen_orders', 'order_detail', 'order_history', 'refund_queue', 'staff_alerts', 'order_receipt', 'list_qr_codes']);

function demoChannel() {
  const handlers: (() => void)[] = [];
  const fire = () => handlers.forEach((h) => h());
  const channel = {
    on(_type: string, _filter: unknown, cb: () => void) {
      handlers.push(cb);
      return channel;
    },
    subscribe(cb?: (status: string) => void) {
      window.addEventListener(DEMO_CHANGE, fire);
      cb?.('SUBSCRIBED');
      return channel;
    },
    unsubscribe() {
      window.removeEventListener(DEMO_CHANGE, fire);
    },
  };
  return channel;
}

export function demoClient(b: Backend, role: DemoRole): SupabaseClient {
  const client = {
    async rpc(fn: string, args: Record<string, unknown> = {}): Promise<Result> {
      try {
        const keys = Object.keys(args);
        const call = `public.${ident(fn)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ')})`;
        const rows = await b.as<{ r: unknown }>(role, `select ${call} as r`, keys.map((k) => param(args[k])));
        if (!READS.has(fn)) announceChange();
        return { data: rows[0]?.r ?? null, error: null };
      } catch (e) {
        return { data: null, error: toError(e) };
      }
    },
    from: (table: string) => new Query(b, role, table),
    channel: () => demoChannel(),
    removeChannel: async (ch: { unsubscribe(): void }) => {
      ch.unsubscribe();
      return 'ok';
    },
    storage: {
      from: () => ({
        upload: async () => ({ data: null, error: { message: 'Photo upload is switched off in the demo.' } }),
      }),
    },
  };
  return client as unknown as SupabaseClient;
}
