import { z } from 'zod';

/**
 * Every configurable business rule (Phase 4 §2.1 + Revision 2 §9.3), with its schema and default.
 * The database has a matching CHECK on the key list; values are validated here in the admin app
 * and again server-side before `update_setting` stores them.
 */
const paise = z.number().int().min(0);
const basisPoints = z.number().int().min(0).max(10_000);
const minutes = z.number().int().min(0).max(24 * 60);
const positiveInt = z.number().int().min(1);

export const settingSchemas = {
  // Ordering
  last_order_buffer_min: minutes.max(120),
  late_order_alert_min: minutes.min(1).max(60),
  // Delivery
  delivery_enabled: z.boolean(),
  delivery_radius_m: z.number().int().min(0).max(50_000),
  delivery_fee_paise: paise,
  delivery_min_order_paise: paise,
  // Lucky Draw loyalty
  loyalty_threshold_paise: paise.min(100),
  lucky_draw_token_limit: positiveInt.max(10_000),
  // Tax & receipts
  gst_enabled: z.boolean(),
  gst_rate_bp: basisPoints,
  gst_inclusive: z.boolean(),
  gstin: z
    .string()
    .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Not a valid GSTIN')
    .nullable(),
  legal_name: z.string().trim().max(120).nullable(),
  receipt_header: z.string().max(200),
  receipt_footer: z.string().max(200),
  // Payments & offers
  payment_mode: z.enum(['test', 'live']),
  offers_enabled: z.boolean(),
  // Fraud limits (Revision 2)
  refund_owner_approval_above_paise: paise,
  refund_daily_limit_per_staff: positiveInt.max(100),
  manual_loyalty_adjust_daily_cap: z.number().int().min(0).max(100),
  coupon_owner_approval_above_bp: basisPoints,
  price_drop_owner_approval_bp: basisPoints,
  max_paid_orders_per_mobile_per_day: positiveInt.max(200),
  first_order_offer_requires_otp: z.boolean(),
} as const;

export type SettingKey = keyof typeof settingSchemas;
export type SettingValue<K extends SettingKey> = z.infer<(typeof settingSchemas)[K]>;
export type Settings = { [K in SettingKey]: SettingValue<K> };

export const SETTING_KEYS = Object.keys(settingSchemas) as SettingKey[];

export const DEFAULT_SETTINGS: Settings = {
  last_order_buffer_min: 15,
  late_order_alert_min: 5,
  delivery_enabled: false,
  delivery_radius_m: 0,
  delivery_fee_paise: 0,
  delivery_min_order_paise: 0,
  loyalty_threshold_paise: 200_000,
  lucky_draw_token_limit: 500,
  gst_enabled: false,
  gst_rate_bp: 500,
  gst_inclusive: false,
  gstin: null,
  legal_name: null,
  receipt_header: 'THE SLUSH BAR',
  receipt_footer: 'Cool down. Sip. Smile. Repeat.',
  payment_mode: 'test',
  offers_enabled: false,
  refund_owner_approval_above_paise: 50_000,
  refund_daily_limit_per_staff: 5,
  manual_loyalty_adjust_daily_cap: 3,
  coupon_owner_approval_above_bp: 3_000,
  price_drop_owner_approval_bp: 5_000,
  max_paid_orders_per_mobile_per_day: 10,
  first_order_offer_requires_otp: true,
};

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(settingSchemas, key);
}

export type SettingParseResult<K extends SettingKey> =
  | { ok: true; value: SettingValue<K> }
  | { ok: false; message: string };

export function parseSetting<K extends SettingKey>(key: K, value: unknown): SettingParseResult<K> {
  const result = settingSchemas[key].safeParse(value);
  if (result.success) return { ok: true, value: result.data as SettingValue<K> };
  return { ok: false, message: result.error.issues[0]?.message ?? 'Invalid value' };
}

export interface CrossCheck {
  /** Block saving. */
  errors: string[];
  /** Saving is allowed, but a feature stays unavailable until fixed. */
  warnings: string[];
}

/** Rules that depend on each other (e.g. GST needs a GSTIN and legal name before it can be on). */
export function crossCheckSettings(s: Settings): CrossCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (s.gst_enabled && (!s.gstin || !s.legal_name)) {
    errors.push('Turning on GST needs a GSTIN and a legal name.');
  }
  if (s.delivery_enabled && s.delivery_radius_m === 0) {
    errors.push('Set a delivery radius before turning on delivery.');
  }
  return { errors, warnings };
}
