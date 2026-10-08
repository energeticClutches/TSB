/**
 * Supabase Edge Function entry point (Deno). Wires real dependencies into handler.ts.
 *
 * Secrets (supabase secrets set …): never commit these.
 *   PIN_JWT_PRIVATE_JWK       ES256 private JWK that is ALSO imported as the project's JWT signing key, incl. "kid"
 *   RAZORPAY_KEY_ID           rzp_test_… (staging) / rzp_live_… (production, only after the go-live checklist)
 *   RAZORPAY_KEY_SECRET
 *   RAZORPAY_WEBHOOK_SECRET   different from the key secret (Phase 8 §3.3)
 *   IDENTITY_PEPPER           random 32+ bytes; hashes UPI IDs/devices/IPs. Never rotate casually
 *   JOB_SECRET                random 32+ bytes; shared with pg_cron
 *   TURNSTILE_SECRET          Cloudflare Turnstile secret key
 * Provided by Supabase: SUPABASE_URL, SUPABASE_DB_URL, SUPABASE_SERVICE_ROLE_KEY.
 */
import postgres from 'npm:postgres@3.4.7';
import { type Db, type Deps, handle } from './handler.ts';
import { razorpayClient } from './razorpay.ts';

const env = (name: string): string => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
};

const supabaseUrl = env('SUPABASE_URL');
const privateJwk = JSON.parse(env('PIN_JWT_PRIVATE_JWK')) as JsonWebKey & { kid: string };
const sql = postgres(env('SUPABASE_DB_URL'), { max: 3, prepare: false, idle_timeout: 20 });
const razorpay = razorpayClient(env('RAZORPAY_KEY_ID'), env('RAZORPAY_KEY_SECRET'));

const db: Db = {
  query: (text, params = []) => sql.unsafe(text, params as never[]) as never,
  transaction: (fn) => sql.begin((tx) => fn({ query: (text, params = []) => tx.unsafe(text, params as never[]) as never })) as never,
};

let jwksCache: { keys: JsonWebKey[]; at: number } | null = null;
async function verifyKeys(): Promise<JsonWebKey[]> {
  if (jwksCache && Date.now() - jwksCache.at < 10 * 60_000) return jwksCache.keys;
  const res = await fetch(`${supabaseUrl}/auth/v1/.well-known/jwks.json`);
  const body = (await res.json()) as { keys: JsonWebKey[] };
  jwksCache = { keys: body.keys, at: Date.now() };
  return body.keys;
}

async function inviteUser(email: string): Promise<{ id: string }> {
  const res = await fetch(`${supabaseUrl}/auth/v1/invite`, {
    method: 'POST',
    headers: {
      apikey: env('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(`Invite failed with status ${res.status}`);
  return { id: ((await res.json()) as { id: string }).id };
}

async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  if (!token) return false;
  const form = new FormData();
  form.set('secret', env('TURNSTILE_SECRET'));
  form.set('response', token);
  form.set('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form, signal: AbortSignal.timeout(5000) });
    return ((await res.json()) as { success?: boolean }).success === true;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  const deps: Deps = {
    db,
    supabaseUrl,
    signingKey: { kid: privateJwk.kid, privateJwk },
    verifyKeys: await verifyKeys(),
    inviteUser,
    razorpay,
    secrets: {
      razorpayKeySecret: env('RAZORPAY_KEY_SECRET'),
      razorpayWebhookSecret: env('RAZORPAY_WEBHOOK_SECRET'),
      identityPepper: env('IDENTITY_PEPPER'),
      jobSecret: env('JOB_SECRET'),
    },
    verifyTurnstile,
    now: () => new Date(),
    // Structured logs without personal data (Phase 8 §3.6).
    log: (event, data) => console.log(JSON.stringify({ event, ...data })),
  };
  return handle(req, deps);
});
