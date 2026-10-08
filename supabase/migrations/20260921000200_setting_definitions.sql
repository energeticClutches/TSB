-- Every configurable business rule. Must match packages/core/src/settings.ts
-- (supabase/tests/settings.test.ts fails if the two drift apart).
insert into public.setting_definitions
  (key, value_type, nullable, min_value, max_value, allowed, pattern, max_length, default_value, description)
values
  ('last_order_buffer_min',        'integer', false, 0, 120,    null, null, null, '15',    'Stop taking orders this many minutes before closing'),
  ('late_order_alert_min',         'integer', false, 1, 60,     null, null, null, '5',     'Highlight orders waiting longer than this (minutes)'),
  ('delivery_enabled',             'boolean', false, null, null, null, null, null, 'false', 'Accept delivery orders'),
  ('delivery_radius_m',            'integer', false, 0, 50000,  null, null, null, '0',     'Delivery radius from the shop (metres, straight line)'),
  ('delivery_fee_paise',           'integer', false, 0, null,   null, null, null, '0',     'Flat delivery fee'),
  ('delivery_min_order_paise',     'integer', false, 0, null,   null, null, null, '0',     'Minimum order value for delivery'),
  ('loyalty_threshold_paise',      'integer', false, 100, null, null, null, null, '200000', 'Lifetime spend (before GST) that earns the Lucky Draw token'),
  ('lucky_draw_token_limit',       'integer', false, 1, 10000,  null, null, null, '500',   'Lucky Draw tokens in the campaign, in total'),
  ('gst_enabled',                  'boolean', false, null, null, null, null, null, 'false', 'Charge GST and issue tax invoices'),
  ('gst_rate_bp',                  'integer', false, 0, 10000,  null, null, null, '500',   'GST rate in basis points (500 = 5%)'),
  ('gst_inclusive',                'boolean', false, null, null, null, null, null, 'false', 'Menu prices already include GST'),
  ('gstin',                        'string',  true,  null, null, null, '^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$', 15, 'null', 'GST registration number'),
  ('legal_name',                   'string',  true,  null, null, null, null, 120, 'null',  'Registered business name for receipts'),
  ('receipt_header',               'string',  false, null, null, null, null, 200, '"THE SLUSH BAR"', 'Top line of printed receipts'),
  ('receipt_footer',               'string',  false, null, null, null, null, 200, '"Cool down. Sip. Smile. Repeat."', 'Bottom line of printed receipts'),
  ('payment_mode',                 'enum',    false, null, null, array['test', 'live'], null, null, '"test"', 'Razorpay test or live keys'),
  ('offers_enabled',               'boolean', false, null, null, null, null, null, 'false', 'Master switch for coupons, combos and happy hour'),
  ('refund_owner_approval_above_paise',  'integer', false, 0, null, null, null, null, '50000', 'Refunds above this need the Owner'),
  ('refund_daily_limit_per_staff',       'integer', false, 1, 100,  null, null, null, '5',     'Refund requests per staff member per day before a flag'),
  ('manual_loyalty_adjust_daily_cap',    'integer', false, 0, 100,  null, null, null, '3',     'Manual loyalty-spend corrections per day before Owner approval'),
  ('coupon_owner_approval_above_bp',     'integer', false, 0, 10000, null, null, null, '3000', 'Coupons above this % off need the Owner'),
  ('price_drop_owner_approval_bp',       'integer', false, 0, 10000, null, null, null, '5000', 'Price drops above this % need the Owner'),
  ('max_paid_orders_per_mobile_per_day', 'integer', false, 1, 200,  null, null, null, '10',    'Anti-abuse cap per mobile'),
  ('first_order_offer_requires_otp',     'boolean', false, null, null, null, null, null, 'true', 'Keep the first-order offer off until SMS OTP exists');
