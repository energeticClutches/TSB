/**
 * ES256 JWTs using only WebCrypto (works in Deno Edge Functions and Node tests).
 * The private key is the project's imported signing key (Supabase → Auth → JWT Signing Keys),
 * so PostgREST accepts PIN-session tokens exactly like Supabase Auth tokens.
 */
const enc = new TextEncoder();

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export interface SigningKey {
  kid: string;
  privateJwk: JsonWebKey;
}

export async function signJwt(payload: Record<string, unknown>, key: SigningKey): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: key.kid }));
  const body = b64url(JSON.stringify(payload));
  const cryptoKey = await crypto.subtle.importKey('jwk', key.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto returns the raw r||s form that JWS ES256 expects.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, cryptoKey, enc.encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(new Uint8Array(sig))}`;
}

/** Verify an ES256 token against public keys; returns the payload or null. Checks `exp`. */
export async function verifyJwt(token: string, publicJwks: JsonWebKey[], nowSeconds: number): Promise<Record<string, unknown> | null> {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64url(h))) as typeof header;
    payload = JSON.parse(new TextDecoder().decode(fromB64url(p))) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (header.alg !== 'ES256') return null;
  const jwk = publicJwks.find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64url(s), enc.encode(`${h}.${p}`));
  if (!ok) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) return null;
  return payload;
}
