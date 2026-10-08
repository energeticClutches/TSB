/**
 * Minimal Razorpay client (Orders, Payments, Refunds APIs) + signature checks.
 * https://razorpay.com/docs/api/ — amounts are in paise, like everything else here.
 * Secrets never leave the server (Phase 8 §3.7).
 */
export interface RzpPayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  method?: string;
  vpa?: string | null;
  error_description?: string | null;
}

export interface Razorpay {
  keyId: string;
  createOrder(input: { amount_paise: number; receipt: string; notes: Record<string, string> }): Promise<{ id: string }>;
  fetchOrderPayments(orderId: string): Promise<RzpPayment[]>;
  /** Every payment Razorpay saw between two moments (seconds since the epoch), for reconciliation. */
  fetchPayments(fromSeconds: number, toSeconds: number): Promise<RzpPayment[]>;
  refund(input: { payment_id: string; amount_paise: number; receipt: string; notes: Record<string, string> }): Promise<{ id: string }>;
}

export class RazorpayUnavailable extends Error {}

export function razorpayClient(keyId: string, keySecret: string, fetchImpl: typeof fetch = fetch): Razorpay {
  const auth = `Basic ${btoa(`${keyId}:${keySecret}`)}`;
  const call = async <T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> => {
    let res: Response;
    try {
      res = await fetchImpl(`https://api.razorpay.com/v1${path}`, {
        method,
        headers: {
          Authorization: auth,
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'X-Razorpay-Idempotency-Key': idempotencyKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new RazorpayUnavailable(e instanceof Error ? e.message : 'network error');
    }
    if (res.status >= 500) throw new RazorpayUnavailable(`Razorpay ${res.status}`);
    const json = (await res.json()) as T & { error?: { description?: string } };
    if (!res.ok) throw new Error(`Razorpay ${res.status}: ${json.error?.description ?? 'request failed'}`);
    return json;
  };
  return {
    keyId,
    createOrder: ({ amount_paise, receipt, notes }) =>
      call('POST', '/orders', { amount: amount_paise, currency: 'INR', receipt, notes, payment_capture: 1 }),
    fetchOrderPayments: async (orderId) => (await call<{ items: RzpPayment[] }>('GET', `/orders/${encodeURIComponent(orderId)}/payments`)).items,
    fetchPayments: async (from, to) => {
      const out: RzpPayment[] = [];
      for (let skip = 0; skip < 1000; skip += 100) {
        const page = await call<{ items: RzpPayment[] }>('GET', `/payments?from=${from}&to=${to}&count=100&skip=${skip}`);
        out.push(...page.items);
        if (page.items.length < 100) break;
      }
      return out;
    },
    refund: ({ payment_id, amount_paise, receipt, notes }) =>
      call('POST', `/payments/${encodeURIComponent(payment_id)}/refund`, { amount: amount_paise, receipt, notes, speed: 'normal' }, receipt),
  };
}

const enc = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Webhooks: HMAC-SHA256 of the RAW body with the webhook secret (Phase 7 §3). */
export async function verifyWebhookSignature(rawBody: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature) return false;
  return safeEqual(await hmacHex(secret, rawBody), signature);
}

/** Checkout handler: HMAC-SHA256 of "order_id|payment_id" with the key secret. */
export async function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string, keySecret: string): Promise<boolean> {
  return safeEqual(await hmacHex(keySecret, `${orderId}|${paymentId}`), signature);
}

export { hmacHex };
