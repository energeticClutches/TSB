/** Customer API client (docs/PHASE-7-API.md §2). Demo mode swaps in a local simulation. */
import type { CartLineInput, MenuSnapshot, OrderType } from '@slush/core';
import { env } from './env';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, any> = {},
    readonly status = 0,
  ) {
    super(message);
  }
}

export interface QrInfo {
  branch_slug: string;
  kind: 'table' | 'counter';
  table_label: string | null;
  menu_version: number;
}

export interface QuoteLine {
  line_id: string;
  name: string;
  variant: string;
  options: string[];
  qty: number;
  unit_price_paise: number;
  promo_discount_paise: number;
  line_total_paise: number;
  problems: string[];
}

export type Loyalty =
  | { running: false }
  | {
      running: true;
      /** Counted so far, before this order. */
      spend_paise: number;
      threshold_paise: number;
      /** What this order would add. */
      adds_paise: number;
      after_paise: number;
      remaining_paise: number;
      /** Their Lucky Draw number, once they have one. */
      token: string | null;
      tokens_left: number;
      earns_token: boolean;
    };

export interface Quote {
  quote_hash: string;
  lines: QuoteLine[];
  subtotal_paise: number;
  promo_discount_paise: number;
  order_discount_paise: number;
  delivery_fee_paise: number;
  tax_paise: number;
  total_paise: number;
  eta_minutes: number;
  problems: string[];
  ok: boolean;
  delivery: { in_area: boolean; distance_m: number; fee_paise: number; min_order_paise: number; radius_m: number } | null;
  ordering_open: boolean;
  next_open_at: string | null;
  coupon: { code: string | null; status: 'applied' | 'min_not_met' | 'invalid' | 'not_started' | 'expired' | 'exhausted' | 'used'; message: string; discount_paise?: number } | null;
  offer_label: string | null;
  offers_enabled: boolean;
  /** The Lucky Draw: what this order adds to the customer's spending, and whether it wins their entry. */
  loyalty: Loyalty;
}

export interface QuoteRequest {
  qr_slug?: string | undefined;
  branch_slug: string;
  order_type: OrderType;
  lines: CartLineInput[];
  mobile?: string | undefined;
  coupon_code?: string | undefined;
  delivery?: { lat: number; lng: number } | undefined;
  device_id: string;
}

export interface CheckoutRequest extends QuoteRequest {
  customer: { name: string; mobile: string };
  note: string;
  delivery_details?: { address: string; landmark: string } | undefined;
  quote_hash: string;
  'cf-turnstile-response': string;
}

export interface RazorpayOptions {
  key_id: string;
  order_id: string;
  amount: number;
  currency: 'INR';
  name: string;
  prefill: { contact: string; name: string };
}

export interface CheckoutResponse {
  public_token: string;
  total_paise: number;
  /** Null when there is nothing to pay. */
  razorpay: RazorpayOptions | null;
}

export type OrderStatus =
  | 'awaiting_payment'
  | 'payment_expired'
  | 'pending'
  | 'confirmed'
  | 'preparing'
  | 'ready'
  | 'out_for_delivery'
  | 'completed'
  | 'delivered'
  | 'rejected'
  | 'cancelled'
  | 'refunded';

export interface PublicOrder {
  order_number: string | null;
  pickup_number: number | null;
  order_type: OrderType;
  table_label: string | null;
  status: OrderStatus;
  on_hold: boolean;
  payment_status: 'pending' | 'expired' | 'successful' | 'refunded' | 'partially_refunded' | 'disputed';
  total_paise: number;
  subtotal_paise: number;
  discount_paise: number;
  delivery_fee_paise: number;
  tax_paise: number;
  customer: { name: string; mobile_masked: string };
  items: { name: string; variant: string; qty: number; line_total_paise: number; options: string[] }[];
  timeline: { status: OrderStatus; at: string }[];
  eta_minutes: number | null;
  can_cancel: boolean;
  placed_at: string | null;
  payment_expires_at: string;
  refund: { status: string; amount_paise: number } | null;
  razorpay_order_id: string | null;
  reject_reason: string | null;
  /** After completion: where this customer stands in the Lucky Draw. */
  loyalty?: { spend_paise: number; threshold_paise: number; earned_paise: number; token: string | null; tokens_left: number } | null;
}

/** The receipt as issued when the shop accepted the order (frozen; never changes). */
export interface PublicReceipt {
  receipt_number: string;
  is_tax_invoice: boolean;
  issued_at: string;
  refunded_paise: number;
  snapshot: {
    shop: { header: string; legal_name: string | null; address: string; pincode: string | null; phone: string | null; gstin: string | null };
    order: { order_number: string; pickup_number: number; order_type: OrderType; table_label: string | null; customer_name: string; paid_at: string };
    items: { name: string; variant: string; qty: number; line_total_paise: number; options: { name: string }[] }[];
    totals: {
      subtotal_paise: number;
      promo_discount_paise: number;
      order_discount_paise: number;
      delivery_fee_paise: number;
      tax_paise: number;
      tax_included_paise: number;
      total_paise: number;
      gst_rate_bp: number | null;
    };
    payment: { method: string | null; vpa_masked: string | null; reference: string | null };
    footer: string | null;
  };
}

export interface OrderingApi {
  demo: boolean;
  menu(branchSlug: string): Promise<MenuSnapshot>;
  qr(slug: string): Promise<QrInfo>;
  quote(req: QuoteRequest): Promise<Quote>;
  checkout(req: CheckoutRequest, idempotencyKey: string): Promise<CheckoutResponse>;
  order(token: string): Promise<PublicOrder>;
  paymentCheck(token: string): Promise<{ payment_status: string; order_status: OrderStatus; order_number: string | null }>;
  cancel(token: string, reason: string): Promise<{ status: OrderStatus }>;
  receipt(token: string): Promise<PublicReceipt>;
  find(mobile: string, orderNumber: string, turnstileToken: string): Promise<{ public_token: string }>;
}

async function request<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/v1${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApiError('NETWORK', 'No connection. Check your internet and try again.');
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const err = json?.error;
    throw new ApiError(err?.code ?? 'INTERNAL', err?.message ?? 'Something went wrong. Please try again.', err?.details ?? {}, res.status);
  }
  return json as T;
}

const httpApi: OrderingApi = {
  demo: false,
  menu: (branch) => request(`/menu?branch=${encodeURIComponent(branch)}`),
  qr: (slug) => request(`/qr/${encodeURIComponent(slug)}`),
  quote: (req) => request('/cart/quote', { body: req }),
  checkout: (req, key) => {
    const { delivery_details, ...rest } = req;
    return request('/checkout', { body: { ...rest, ...(delivery_details ? { delivery: { ...req.delivery, ...delivery_details } } : {}) }, headers: { 'Idempotency-Key': key } });
  },
  order: (token) => request(`/orders/${encodeURIComponent(token)}`),
  paymentCheck: (token) => request(`/orders/${encodeURIComponent(token)}/payment-check`, { body: {} }),
  cancel: (token, reason) => request(`/orders/${encodeURIComponent(token)}/cancel`, { body: { reason } }),
  receipt: (token) => request(`/orders/${encodeURIComponent(token)}/receipt`),
  find: (mobile, order_number, token) => request('/orders/find', { body: { mobile, order_number, 'cf-turnstile-response': token } }),
};

let apiPromise: Promise<OrderingApi> | null = null;
/** The API for this build. Demo code is only downloaded in demo mode. */
export function getApi(): Promise<OrderingApi> {
  apiPromise ??= env.demo ? import('../demo/demoApi').then((m) => m.demoApi) : Promise.resolve(httpApi);
  return apiPromise;
}
