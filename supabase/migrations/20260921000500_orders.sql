-- ============================================================================
-- M3 Orders & payments: tables/QR codes, customers, orders (+ items, events),
-- Razorpay payments, refunds, webhook log, fraud flags, numbering, status rules.
-- Design: docs/PHASE-4-DATABASE.md §2.3, §2.6–2.9, Revision 2; docs/PHASE-2-USER-FLOWS.md §3.
--
-- Money flow in one sentence: an order exists for staff ONLY after a verified capture
-- (webhook or server-side check); before that it is a hidden `awaiting_payment` row.
-- ============================================================================

create type public.qr_kind as enum ('table', 'counter');
create type public.order_type as enum ('dine_in', 'takeaway', 'delivery');
create type public.order_status as enum (
  'awaiting_payment', 'payment_expired', 'pending', 'confirmed', 'preparing', 'ready',
  'out_for_delivery', 'completed', 'delivered', 'rejected', 'cancelled', 'refunded');
create type public.payment_status as enum ('successful', 'failed', 'partially_refunded', 'refunded', 'disputed');
create type public.refund_kind as enum ('full', 'partial');
create type public.refund_status as enum ('requested', 'approved', 'declined', 'processing', 'processed', 'failed');
create type public.actor_kind as enum ('customer', 'staff', 'system');
create type public.flag_severity as enum ('info', 'warn', 'block');
create type public.flag_status as enum ('open', 'cleared', 'confirmed');

-- ----------------------------------------------------------------------------
-- Tables & QR codes
-- ----------------------------------------------------------------------------
create table public.dining_tables (
  id          uuid primary key default app.uuid_v7(),
  branch_id   uuid not null references public.branches (id),
  label       text not null check (label ~ '^[A-Za-z0-9 -]{1,12}$'),
  seats       smallint check (seats between 1 and 30),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index dining_tables_label_idx on public.dining_tables (branch_id, lower(label)) where is_active;

create table public.qr_codes (
  id          uuid primary key default app.uuid_v7(),
  branch_id   uuid not null references public.branches (id),
  kind        public.qr_kind not null,
  table_id    uuid references public.dining_tables (id),
  -- Random, so nobody can "order from table 05" by editing a link (Phase 4 decision 9).
  slug        text not null unique default substr(replace(replace(encode(extensions.gen_random_bytes(9), 'base64'), '+', 'x'), '/', 'y'), 1, 10),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  check ((kind = 'table') = (table_id is not null))
);

-- ----------------------------------------------------------------------------
-- Customers (chain-wide, keyed by mobile)
-- ----------------------------------------------------------------------------
create table public.customers (
  id                 uuid primary key default app.uuid_v7(),
  mobile             text not null unique check (mobile ~ '^\+91[6-9]\d{9}$'),
  name               text check (length(name) <= 60),
  first_order_at     timestamptz,
  last_order_at      timestamptz,
  order_count        int not null default 0,
  total_spent_paise  bigint not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger customers_updated_at before update on public.customers for each row execute function app.touch_updated_at();

-- ----------------------------------------------------------------------------
-- Orders
-- ----------------------------------------------------------------------------
create table public.orders (
  id                    uuid primary key default app.uuid_v7(),
  branch_id             uuid not null references public.branches (id),
  public_token          text not null unique,
  order_number          text,
  pickup_number         smallint,
  source                text not null default 'qr' check (source in ('qr', 'counter')),
  order_type            public.order_type not null,
  status                public.order_status not null default 'awaiting_payment',
  qr_code_id            uuid references public.qr_codes (id),
  table_id              uuid references public.dining_tables (id),
  table_label           text,
  customer_id           uuid not null references public.customers (id),
  customer_name         text not null check (length(btrim(customer_name)) between 1 and 60),
  customer_mobile       text not null,
  note                  text check (length(note) <= 200),
  delivery_address      text check (length(delivery_address) <= 300),
  delivery_landmark     text check (length(delivery_landmark) <= 120),
  delivery_lat          numeric(9, 6),
  delivery_lng          numeric(9, 6),
  delivery_distance_m   int,
  subtotal_paise        bigint not null check (subtotal_paise >= 0),
  promo_discount_paise  bigint not null default 0 check (promo_discount_paise >= 0),
  order_discount_paise  bigint not null default 0 check (order_discount_paise >= 0),
  delivery_fee_paise    bigint not null default 0 check (delivery_fee_paise >= 0),
  tax_paise             bigint not null default 0 check (tax_paise >= 0),   -- added on top (GST exclusive)
  tax_included_paise    bigint not null default 0,                          -- informational (GST inclusive)
  -- Phase 4 O2: the total can never disagree with its parts.
  total_paise           bigint generated always as
                          (subtotal_paise - promo_discount_paise - order_discount_paise
                           + delivery_fee_paise + tax_paise) stored,
  -- What this order adds to the customer's Lucky Draw loyalty spend: drinks after discounts, before GST.
  loyalty_eligible_paise bigint not null default 0 check (loyalty_eligible_paise >= 0),
  coupon_id             uuid,
  promotion_id          uuid,
  eta_minutes           smallint,
  razorpay_order_id     text unique,
  reject_reason         text,
  cancel_reason         text,
  paid_at               timestamptz,
  confirmed_at          timestamptz,
  preparing_at          timestamptz,
  ready_at              timestamptz,
  completed_at          timestamptz,
  cancelled_at          timestamptz,
  payment_expires_at    timestamptz not null,
  idempotency_key       text not null unique check (length(idempotency_key) between 16 and 80),
  request_hash          text not null,
  device_id_hash        text,
  ip_hash               text,
  risk_score            smallint not null default 0,
  on_hold               boolean not null default false,
  hold_reason           text,
  late_payment          boolean not null default false,
  version               int not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (total_paise >= 0),
  check (order_type <> 'delivery' or delivery_address is not null),
  check (order_type <> 'dine_in' or table_label is not null)
);
create unique index orders_number_idx on public.orders (branch_id, order_number) where order_number is not null;
create index orders_live_idx on public.orders (branch_id, status, paid_at)
  where status in ('pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery');
create index orders_history_idx on public.orders (branch_id, paid_at desc) where paid_at is not null;
create index orders_customer_idx on public.orders (customer_id, paid_at desc);
create index orders_expiry_idx on public.orders (payment_expires_at) where status = 'awaiting_payment';
create trigger orders_updated_at before update on public.orders for each row execute function app.touch_updated_at();

create table public.order_items (
  id                    uuid primary key default app.uuid_v7(),
  order_id              uuid not null references public.orders (id),
  product_id            uuid references public.products (id),
  variant_id            uuid references public.product_variants (id),
  product_name          text not null,
  variant_name          text not null,
  unit_price_paise      bigint not null check (unit_price_paise >= 0),
  promo_discount_paise  bigint not null default 0 check (promo_discount_paise >= 0),
  qty                   smallint not null check (qty between 1 and 50),
  line_total_paise      bigint not null check (line_total_paise >= 0),
  prep_minutes          smallint not null default 0,
  note                  text check (length(note) <= 120),
  refunded_qty          smallint not null default 0,
  sort_order            smallint not null default 0,
  check (refunded_qty between 0 and qty),
  check (line_total_paise = unit_price_paise * qty)
);
create index order_items_order_idx on public.order_items (order_id);
create index order_items_product_idx on public.order_items (product_id);

create table public.order_item_modifiers (
  order_item_id       uuid not null references public.order_items (id),
  modifier_option_id  uuid references public.modifier_options (id),
  group_name          text not null,
  option_name         text not null,
  price_paise         bigint not null default 0 check (price_paise >= 0)
);
create index order_item_modifiers_item_idx on public.order_item_modifiers (order_item_id);

create table public.order_status_events (
  id           bigint generated always as identity primary key,
  order_id     uuid not null references public.orders (id),
  from_status  public.order_status,
  to_status    public.order_status not null,
  actor_type   public.actor_kind not null,
  staff_id     uuid references public.staff (id),
  device_id    uuid,
  reason       text,
  created_at   timestamptz not null default now()
);
create index order_status_events_order_idx on public.order_status_events (order_id, id);

create table app.order_counters (
  branch_id      uuid primary key references public.branches (id),
  last_number    int not null default 1000,
  pickup_date    date not null default (now() at time zone 'Asia/Kolkata')::date,
  last_pickup    smallint not null default 0
);

-- ----------------------------------------------------------------------------
-- Payments, refunds, webhooks, fraud flags
-- ----------------------------------------------------------------------------
create table public.payments (
  id                   uuid primary key default app.uuid_v7(),
  order_id             uuid not null references public.orders (id),
  provider             text not null default 'razorpay',
  provider_payment_id  text not null unique,
  provider_order_id    text not null,
  amount_paise         bigint not null check (amount_paise >= 0),
  currency             text not null default 'INR',
  status               public.payment_status not null,
  method               text,
  payer_vpa_hash       text,
  payer_vpa_masked     text,
  failure_reason       text,
  captured_at          timestamptz,
  refunded_paise       bigint not null default 0,
  is_duplicate         boolean not null default false,
  dispute_id           text,
  created_at           timestamptz not null default now(),
  check (refunded_paise between 0 and amount_paise)
);
create index payments_order_idx on public.payments (order_id);
-- Only one genuine (non-duplicate) successful capture per order.
create unique index payments_one_success_idx on public.payments (order_id)
  where status in ('successful', 'partially_refunded', 'refunded', 'disputed') and not is_duplicate;

create table public.refunds (
  id                  uuid primary key default app.uuid_v7(),
  order_id            uuid not null references public.orders (id),
  payment_id          uuid not null references public.payments (id),
  kind                public.refund_kind not null,
  amount_paise        bigint not null check (amount_paise > 0),
  reason              text not null check (length(reason) between 1 and 300),
  status              public.refund_status not null,
  is_automatic        boolean not null default false,
  requested_by        uuid references public.staff (id),
  decided_by          uuid references public.staff (id),
  decided_at          timestamptz,
  provider_refund_id  text unique,
  failure_reason      text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (decided_by is null or requested_by is null or decided_by <> requested_by)
);
create index refunds_order_idx on public.refunds (order_id);
create index refunds_queue_idx on public.refunds (status) where status in ('requested', 'approved', 'processing');
create trigger refunds_updated_at before update on public.refunds for each row execute function app.touch_updated_at();

create table public.refund_items (
  refund_id      uuid not null references public.refunds (id),
  order_item_id  uuid not null references public.order_items (id),
  qty            smallint not null check (qty > 0),
  amount_paise   bigint not null check (amount_paise >= 0),
  primary key (refund_id, order_item_id)
);

create table app.webhook_events (
  id               bigint generated always as identity primary key,
  provider         text not null,
  event_id         text not null,
  event_type       text not null,
  payload          jsonb not null,
  signature_valid  boolean not null,
  received_at      timestamptz not null default now(),
  processed_at     timestamptz,
  error            text,
  unique (provider, event_id)
);

create table public.fraud_flags (
  id            bigint generated always as identity primary key,
  branch_id     uuid references public.branches (id),
  rule          text not null,
  severity      public.flag_severity not null,
  customer_id   uuid references public.customers (id),
  order_id      uuid references public.orders (id),
  staff_id      uuid references public.staff (id),
  details       jsonb not null default '{}',
  status        public.flag_status not null default 'open',
  reviewed_by   uuid references public.staff (id),
  reviewed_at   timestamptz,
  review_note   text,
  created_at    timestamptz not null default now()
);
create index fraud_flags_open_idx on public.fraud_flags (branch_id, created_at desc) where status = 'open';

create function app.flag(p_rule text, p_severity public.flag_severity, p_order_id uuid, p_details jsonb default '{}') returns void
language sql security definer set search_path = '' as $$
  insert into public.fraud_flags (branch_id, rule, severity, order_id, customer_id, details)
  select o.branch_id, p_rule, p_severity, o.id, o.customer_id, coalesce(p_details, '{}') from public.orders o where o.id = p_order_id
$$;

-- ----------------------------------------------------------------------------
-- Order status rules: enforced by a trigger for EVERY update (Phase 2 §3.1).
-- ----------------------------------------------------------------------------
create table app.order_transitions (
  from_status public.order_status not null,
  to_status   public.order_status not null,
  primary key (from_status, to_status)
);
insert into app.order_transitions values
  ('awaiting_payment', 'pending'), ('awaiting_payment', 'payment_expired'), ('payment_expired', 'pending'),
  ('pending', 'confirmed'), ('pending', 'cancelled'), ('pending', 'rejected'),
  ('confirmed', 'preparing'), ('preparing', 'ready'),
  ('ready', 'completed'), ('ready', 'out_for_delivery'), ('out_for_delivery', 'delivered'),
  -- Manager "one step back" (Phase 2 decision 5)
  ('confirmed', 'pending'), ('preparing', 'confirmed'), ('ready', 'preparing'), ('out_for_delivery', 'ready'),
  -- Full refunds
  ('rejected', 'refunded'), ('cancelled', 'refunded'), ('confirmed', 'refunded'), ('preparing', 'refunded'),
  ('ready', 'refunded'), ('completed', 'refunded'), ('delivered', 'refunded'), ('out_for_delivery', 'refunded');

create function app.guard_order_status() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.current_staff();
begin
  if new.status is distinct from old.status then
    if not exists (select 1 from app.order_transitions where from_status = old.status and to_status = new.status) then
      raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION',
        detail = format('An order can’t go from %s to %s.', old.status, new.status);
    end if;
    new.version := old.version + 1;
    insert into public.order_status_events (order_id, from_status, to_status, actor_type, staff_id, device_id, reason)
    values (new.id, old.status, new.status,
            coalesce(nullif(current_setting('app.actor', true), ''),
                     case when ctx.staff_id is null then 'system' else 'staff' end)::public.actor_kind,
            ctx.staff_id, ctx.device_id, nullif(current_setting('app.reason', true), ''));
  end if;
  return new;
end $$;
create trigger orders_status_guard before update of status on public.orders
  for each row execute function app.guard_order_status();

-- Live updates (Supabase Realtime "broadcast from database"). Kitchen/board get ids only
-- (Phase 4 O5); the customer's channel is named by the unguessable public token.
create function app.broadcast_order() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return null;
  end if;
  if new.status in ('awaiting_payment', 'payment_expired') and old.status is not distinct from new.status then
    return null;
  end if;
  execute 'select realtime.send($1, $2, $3, $4)'
    using jsonb_build_object('order_id', new.id, 'status', new.status, 'version', new.version, 'on_hold', new.on_hold),
          'order', 'branch:' || new.branch_id || ':orders', true;
  execute 'select realtime.send($1, $2, $3, $4)'
    using jsonb_build_object('status', new.status, 'eta_minutes', new.eta_minutes, 'pickup_number', new.pickup_number),
          'status', 'order:' || new.public_token, false;
  return null;
end $$;
create trigger orders_broadcast after update on public.orders
  for each row execute function app.broadcast_order();

-- ----------------------------------------------------------------------------
-- Checkout (service role: called by the checkout Edge Function after pricing)
-- ----------------------------------------------------------------------------
create function app.qr_lookup(p_slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('qr_id', q.id, 'kind', q.kind, 'active', q.is_active and b.is_active and (t.id is null or t.is_active),
                            'branch_slug', b.slug, 'branch_id', b.id, 'table_id', t.id, 'table_label', t.label,
                            'menu_version', b.menu_version)
  from public.qr_codes q join public.branches b on b.id = q.branch_id
  left join public.dining_tables t on t.id = q.table_id
  where q.slug = p_slug
$$;

-- Everything the server needs to price and validate a checkout, in one round trip.
create function app.checkout_context(p_branch_slug text, p_mobile text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'branch_id', b.id,
    'menu', app.menu_snapshot(b.slug),
    'settings', app.branch_settings(b.id),
    'shop', jsonb_build_object('lat', b.lat, 'lng', b.lng),
    'customer', (select jsonb_build_object('id', c.id, 'order_count', c.order_count) from public.customers c where c.mobile = p_mobile),
    'paid_orders_today', (select count(*) from public.orders o join public.customers c on c.id = o.customer_id
                           where c.mobile = p_mobile and o.paid_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'))
  from public.branches b where b.slug = p_branch_slug and b.is_active
$$;

create function app.create_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing  public.orders;
  v_branch    uuid := (p ->> 'branch_id')::uuid;
  v_customer  uuid;
  v_order     uuid;
  v_item      uuid;
  v_token     text := 'ot_' || translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_');
  l           jsonb;
  o           jsonb;
  v_i         int := 0;
begin
  -- Idempotency (FR-18): the same key + same request returns the same order.
  select * into v_existing from public.orders where idempotency_key = p ->> 'idempotency_key';
  if v_existing.id is not null then
    if v_existing.request_hash <> p ->> 'request_hash' then
      perform app.raise('IDEMPOTENCY_CONFLICT', 'This checkout was already started with different items. Please try again.');
    end if;
    return jsonb_build_object('order_id', v_existing.id, 'public_token', v_existing.public_token, 'total_paise', v_existing.total_paise,
                              'razorpay_order_id', v_existing.razorpay_order_id, 'status', v_existing.status,
                              'payment_expires_at', v_existing.payment_expires_at, 'existing', true);
  end if;
  if jsonb_array_length(coalesce(p -> 'lines', '[]')) = 0 then
    perform app.raise('VALIDATION_FAILED', 'Your cart is empty.');
  end if;

  insert into public.customers (mobile, name) values (p ->> 'customer_mobile', p ->> 'customer_name')
  on conflict (mobile) do update set name = excluded.name
  returning id into v_customer;

  insert into public.orders (
    branch_id, public_token, order_type, qr_code_id, table_id, table_label, customer_id, customer_name, customer_mobile, note,
    delivery_address, delivery_landmark, delivery_lat, delivery_lng, delivery_distance_m,
    subtotal_paise, promo_discount_paise, order_discount_paise, delivery_fee_paise, tax_paise, tax_included_paise,
    loyalty_eligible_paise, coupon_id, promotion_id, eta_minutes,
    payment_expires_at, idempotency_key, request_hash, device_id_hash, ip_hash)
  values (
    v_branch, v_token, (p ->> 'order_type')::public.order_type, nullif(p ->> 'qr_code_id', '')::uuid, nullif(p ->> 'table_id', '')::uuid,
    nullif(p ->> 'table_label', ''), v_customer, p ->> 'customer_name', p ->> 'customer_mobile', nullif(p ->> 'note', ''),
    nullif(p ->> 'delivery_address', ''), nullif(p ->> 'delivery_landmark', ''), (p ->> 'delivery_lat')::numeric, (p ->> 'delivery_lng')::numeric,
    (p ->> 'delivery_distance_m')::int,
    (p ->> 'subtotal_paise')::bigint, (p ->> 'promo_discount_paise')::bigint, (p ->> 'order_discount_paise')::bigint,
    (p ->> 'delivery_fee_paise')::bigint, (p ->> 'tax_paise')::bigint,
    coalesce((p ->> 'tax_included_paise')::bigint, 0), (p ->> 'loyalty_eligible_paise')::bigint,
    nullif(p ->> 'coupon_id', '')::uuid, nullif(p ->> 'promotion_id', '')::uuid, (p ->> 'eta_minutes')::smallint,
    now() + make_interval(mins => coalesce((p ->> 'payment_window_min')::int, 30)),
    p ->> 'idempotency_key', p ->> 'request_hash', p ->> 'device_id_hash', p ->> 'ip_hash')
  returning id into v_order;

  for l in select * from jsonb_array_elements(p -> 'lines') loop
    v_i := v_i + 1;
    insert into public.order_items (order_id, product_id, variant_id, product_name, variant_name, unit_price_paise, promo_discount_paise,
                                    qty, line_total_paise, prep_minutes, note, sort_order)
    values (v_order, (l ->> 'product_id')::uuid, (l ->> 'variant_id')::uuid, l ->> 'product_name', l ->> 'variant_name',
            (l ->> 'unit_price_paise')::bigint, (l ->> 'promo_discount_paise')::bigint, (l ->> 'qty')::smallint,
            (l ->> 'line_total_paise')::bigint, (l ->> 'prep_minutes')::smallint,
            nullif(l ->> 'note', ''), v_i)
    returning id into v_item;
    for o in select * from jsonb_array_elements(coalesce(l -> 'options', '[]')) loop
      insert into public.order_item_modifiers (order_item_id, modifier_option_id, group_name, option_name, price_paise)
      values (v_item, (o ->> 'id')::uuid, o ->> 'group', o ->> 'name', (o ->> 'price_paise')::bigint);
    end loop;
  end loop;

  return jsonb_build_object('order_id', v_order, 'public_token', v_token,
                            'total_paise', (select total_paise from public.orders where id = v_order), 'existing', false);
end $$;

create function app.attach_razorpay_order(p_order_id uuid, p_razorpay_order_id text) returns void
language sql security definer set search_path = '' as $$
  update public.orders set razorpay_order_id = p_razorpay_order_id where id = p_order_id and razorpay_order_id is null
$$;

-- Assign SL-#### and a daily pickup number 1–99 (Phase 4 decision 4). Called with the order row locked.
create function app.assign_numbers(p_branch_id uuid, out order_number text, out pickup_number smallint)
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  c app.order_counters;
begin
  insert into app.order_counters (branch_id) values (p_branch_id) on conflict do nothing;
  select * into c from app.order_counters where branch_id = p_branch_id for update;
  if c.pickup_date <> v_today then
    c.pickup_date := v_today;
    c.last_pickup := 0;
  end if;
  c.last_number := c.last_number + 1;
  c.last_pickup := (c.last_pickup % 99) + 1;
  update app.order_counters set last_number = c.last_number, pickup_date = c.pickup_date, last_pickup = c.last_pickup
   where branch_id = p_branch_id;
  order_number := 'SL-' || c.last_number;
  pickup_number := c.last_pickup;
end $$;

-- A verified capture (webhook or server-to-Razorpay check). Idempotent.
create function app.apply_payment_captured(
  p_razorpay_order_id text, p_payment_id text, p_amount bigint, p_currency text,
  p_method text, p_vpa_hash text, p_vpa_masked text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o         public.orders;
  v_prev    public.payments;
  v_dup     boolean := false;
  v_numbers record;
  v_mismatch boolean;
begin
  select * into v_prev from public.payments where provider_payment_id = p_payment_id;
  select * into o from public.orders where razorpay_order_id = p_razorpay_order_id for update;
  if o.id is null then
    return jsonb_build_object('ok', false, 'code', 'UNKNOWN_ORDER');
  end if;
  if v_prev.id is not null then  -- already recorded: replay
    return jsonb_build_object('ok', true, 'replay', true, 'order_id', o.id, 'public_token', o.public_token,
                              'order_number', o.order_number, 'pickup_number', o.pickup_number, 'duplicate', v_prev.is_duplicate,
                              'refund_payment_id', case when v_prev.is_duplicate then v_prev.id end);
  end if;

  v_dup := exists (select 1 from public.payments where order_id = o.id and not is_duplicate
                   and status in ('successful', 'partially_refunded', 'refunded', 'disputed'));
  insert into public.payments (order_id, provider_payment_id, provider_order_id, amount_paise, currency, status, method,
                               payer_vpa_hash, payer_vpa_masked, captured_at, is_duplicate)
  values (o.id, p_payment_id, p_razorpay_order_id, p_amount, upper(p_currency), 'successful', p_method,
          p_vpa_hash, p_vpa_masked, now(), v_dup);

  if v_dup then
    perform app.flag('DUPLICATE_PAYMENT', 'info', o.id, jsonb_build_object('payment_id', p_payment_id, 'amount_paise', p_amount));
    return jsonb_build_object('ok', true, 'duplicate', true, 'order_id', o.id, 'public_token', o.public_token,
                              'refund_payment_id', (select id from public.payments where provider_payment_id = p_payment_id));
  end if;

  v_mismatch := p_amount <> o.total_paise or upper(p_currency) <> 'INR';
  select * into v_numbers from app.assign_numbers(o.branch_id);
  perform set_config('app.actor', 'system', true);
  update public.orders
     set status = 'pending', paid_at = now(), order_number = v_numbers.order_number, pickup_number = v_numbers.pickup_number,
         late_payment = (o.status = 'payment_expired'),
         on_hold = v_mismatch, hold_reason = case when v_mismatch then 'Payment amount doesn’t match the order total' end
   where id = o.id;
  update public.customers
     set order_count = order_count + 1, last_order_at = now(), first_order_at = coalesce(first_order_at, now()),
         total_spent_paise = total_spent_paise + p_amount
   where id = o.customer_id;

  if v_mismatch then
    perform app.flag('AMOUNT_MISMATCH', 'block', o.id, jsonb_build_object('expected', o.total_paise, 'captured', p_amount, 'currency', p_currency));
  end if;
  if o.status = 'payment_expired' then
    perform app.flag('LATE_PAYMENT', 'info', o.id, '{}');
  end if;
  return jsonb_build_object('ok', true, 'duplicate', false, 'order_id', o.id, 'public_token', o.public_token,
                            'order_number', v_numbers.order_number, 'pickup_number', v_numbers.pickup_number,
                            'on_hold', v_mismatch, 'late', o.status = 'payment_expired');
end $$;

create function app.apply_payment_failed(p_razorpay_order_id text, p_payment_id text, p_amount bigint, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_order uuid := (select id from public.orders where razorpay_order_id = p_razorpay_order_id);
begin
  if v_order is null then return; end if;
  insert into public.payments (order_id, provider_payment_id, provider_order_id, amount_paise, status, failure_reason)
  values (v_order, p_payment_id, p_razorpay_order_id, p_amount, 'failed', left(p_reason, 300))
  on conflict (provider_payment_id) do nothing;
end $$;

-- Job (every 5 min): unpaid checkouts expire. (Tokens/coupons are released here in M5.)
create function app.expire_unpaid_orders() returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  perform set_config('app.actor', 'system', true);
  update public.orders set status = 'payment_expired'
   where status = 'awaiting_payment' and payment_expires_at <= now();
  get diagnostics n = row_count;
  return n;
end $$;

-- ----------------------------------------------------------------------------
-- Customer-facing reads & actions (service role, behind the public API)
-- ----------------------------------------------------------------------------
create function app.order_public(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'order_number', o.order_number, 'pickup_number', o.pickup_number, 'order_type', o.order_type,
    'table_label', o.table_label, 'status', o.status, 'on_hold', o.on_hold,
    'payment_status', coalesce((select p.status::text from public.payments p where p.order_id = o.id and not p.is_duplicate
                                and p.status <> 'failed' order by p.created_at desc limit 1),
                               case when o.status = 'awaiting_payment' then 'pending' when o.status = 'payment_expired' then 'expired' else 'pending' end),
    'total_paise', o.total_paise, 'subtotal_paise', o.subtotal_paise,
    'discount_paise', o.promo_discount_paise + o.order_discount_paise,
    'delivery_fee_paise', o.delivery_fee_paise, 'tax_paise', o.tax_paise,
    'customer', jsonb_build_object('name', o.customer_name,
                                   'mobile_masked', substr(o.customer_mobile, 4, 2) || 'xxxxx' || substr(o.customer_mobile, 11, 3)),
    'items', (select jsonb_agg(jsonb_build_object(
                'name', i.product_name, 'variant', i.variant_name, 'qty', i.qty, 'line_total_paise', i.line_total_paise,
                'options', coalesce((select jsonb_agg(m.option_name) from public.order_item_modifiers m where m.order_item_id = i.id), '[]'))
                order by i.sort_order)
              from public.order_items i where i.order_id = o.id),
    'timeline', coalesce((select jsonb_agg(jsonb_build_object('status', e.to_status, 'at', e.created_at) order by e.id)
                          from public.order_status_events e where e.order_id = o.id), '[]'),
    'eta_minutes', o.eta_minutes,
    'can_cancel', o.status = 'pending',
    'placed_at', o.paid_at, 'payment_expires_at', o.payment_expires_at,
    'refund', (select jsonb_build_object('status', r.status, 'amount_paise', r.amount_paise)
               from public.refunds r where r.order_id = o.id order by r.created_at desc limit 1),
    'razorpay_order_id', case when o.status = 'awaiting_payment' then o.razorpay_order_id end,
    'reject_reason', o.reject_reason)
  from public.orders o where o.public_token = p_token
$$;

-- Customer cancels while the shop hasn't accepted yet → automatic full refund (FR-21).
create function app.cancel_by_customer(p_token text, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o public.orders;
  p public.payments;
  v_refund uuid;
begin
  select * into o from public.orders where public_token = p_token for update;
  if o.id is null then perform app.raise('NOT_FOUND', 'Order not found.'); end if;
  if o.status <> 'pending' then
    perform app.raise('INVALID_TRANSITION', 'The shop has already accepted your order. Please speak to the counter.');
  end if;
  select * into p from public.payments where order_id = o.id and status = 'successful' and not is_duplicate;
  perform set_config('app.actor', 'customer', true);
  perform set_config('app.reason', left(coalesce(nullif(btrim(p_reason), ''), 'Cancelled by customer'), 200), true);
  update public.orders set status = 'cancelled', cancelled_at = now(), cancel_reason = left(coalesce(nullif(btrim(p_reason), ''), 'Cancelled by customer'), 200)
   where id = o.id;
  if p.id is not null then
    insert into public.refunds (order_id, payment_id, kind, amount_paise, reason, status, is_automatic)
    values (o.id, p.id, 'full', p.amount_paise, 'Cancelled by customer before the shop accepted', 'approved', true)
    returning id into v_refund;
  end if;
  return jsonb_build_object('refund_id', v_refund, 'provider_payment_id', p.provider_payment_id, 'amount_paise', p.amount_paise);
end $$;

-- Automatic refund for a duplicate capture (Phase 4 decision 8).
create function app.create_duplicate_refund(p_payment_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p public.payments;
  v_refund uuid;
begin
  select * into p from public.payments where id = p_payment_id and is_duplicate for update;
  if p.id is null then perform app.raise('NOT_FOUND', 'Payment not found.'); end if;
  select id into v_refund from public.refunds where payment_id = p.id;
  if v_refund is null then
    insert into public.refunds (order_id, payment_id, kind, amount_paise, reason, status, is_automatic)
    values (p.order_id, p.id, 'full', p.amount_paise, 'Duplicate payment for the same order', 'approved', true)
    returning id into v_refund;
  end if;
  return jsonb_build_object('refund_id', v_refund, 'provider_payment_id', p.provider_payment_id, 'amount_paise', p.amount_paise);
end $$;

create function app.refund_submitted(p_refund_id uuid, p_provider_refund_id text) returns void
language sql security definer set search_path = '' as $$
  update public.refunds set status = 'processing', provider_refund_id = p_provider_refund_id
   where id = p_refund_id and status in ('approved', 'failed')
$$;

create function app.refund_submit_failed(p_refund_id uuid, p_reason text) returns void
language sql security definer set search_path = '' as $$
  update public.refunds set status = 'failed', failure_reason = left(p_reason, 300) where id = p_refund_id and status = 'approved'
$$;

-- refund.processed / refund.failed webhooks. Full refunds mark the order refunded.
create function app.apply_refund_event(p_provider_refund_id text, p_payment_id text, p_amount bigint, p_processed boolean, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.refunds;
  p public.payments;
  o public.orders;
  v_total_refunded bigint;
begin
  select * into r from public.refunds where provider_refund_id = p_provider_refund_id for update;
  if r.id is null then
    return jsonb_build_object('ok', false, 'code', 'UNKNOWN_REFUND');
  end if;
  if r.status in ('processed') then
    return jsonb_build_object('ok', true, 'replay', true);
  end if;
  if not p_processed then
    update public.refunds set status = 'failed', failure_reason = left(coalesce(p_reason, 'Refund failed'), 300) where id = r.id;
    perform app.flag('REFUND_FAILED', 'warn', r.order_id, jsonb_build_object('refund_id', r.id));
    return jsonb_build_object('ok', true, 'status', 'failed');
  end if;

  update public.refunds set status = 'processed' where id = r.id;
  select * into p from public.payments where id = r.payment_id for update;
  v_total_refunded := least(p.amount_paise, p.refunded_paise + r.amount_paise);
  update public.payments
     set refunded_paise = v_total_refunded,
         status = case when v_total_refunded >= p.amount_paise then 'refunded'::public.payment_status else 'partially_refunded'::public.payment_status end
   where id = p.id;
  if not p.is_duplicate then
    update public.customers c set total_spent_paise = greatest(0, c.total_spent_paise - r.amount_paise)
      from public.orders x where x.id = r.order_id and c.id = x.customer_id;
    select * into o from public.orders where id = r.order_id for update;
    if v_total_refunded >= p.amount_paise and o.status <> 'refunded'
       and exists (select 1 from app.order_transitions where from_status = o.status and to_status = 'refunded') then
      perform set_config('app.actor', 'system', true);
      update public.orders set status = 'refunded' where id = o.id;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'status', 'processed', 'order_id', r.order_id);
end $$;

create function app.find_order(p_mobile text, p_order_number text) returns text
language sql stable security definer set search_path = '' as $$
  select public_token from public.orders where customer_mobile = p_mobile and order_number = upper(p_order_number) and paid_at is not null
$$;

create function app.record_webhook(p_provider text, p_event_id text, p_type text, p_payload jsonb, p_valid boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  w app.webhook_events;
begin
  insert into app.webhook_events (provider, event_id, event_type, payload, signature_valid)
  values (p_provider, p_event_id, p_type, p_payload, p_valid)
  on conflict (provider, event_id) do nothing
  returning * into w;
  if w.id is null then
    select * into w from app.webhook_events where provider = p_provider and event_id = p_event_id;
  end if;
  return jsonb_build_object('id', w.id, 'processed', w.processed_at is not null);
end $$;

create function app.webhook_done(p_id bigint, p_error text) returns void
language sql security definer set search_path = '' as $$
  update app.webhook_events set processed_at = case when p_error is null then now() end, error = p_error where id = p_id
$$;

-- ----------------------------------------------------------------------------
-- RLS & privileges
-- ----------------------------------------------------------------------------
alter table public.dining_tables        enable row level security;
alter table public.qr_codes             enable row level security;
alter table public.customers            enable row level security;
alter table public.orders               enable row level security;
alter table public.order_items          enable row level security;
alter table public.order_item_modifiers enable row level security;
alter table public.order_status_events  enable row level security;
alter table public.payments             enable row level security;
alter table public.refunds              enable row level security;
alter table public.refund_items         enable row level security;
alter table public.fraud_flags          enable row level security;

-- Kitchen staff never read orders/customers/payments directly; they get a price- and
-- phone-free view in M4 (Phase 2 decision 6).
create policy dining_tables_read on public.dining_tables for select to authenticated
  using (branch_id = (select app.current_branch_id()));
create policy qr_codes_read on public.qr_codes for select to authenticated
  using (branch_id = (select app.current_branch_id()) and (select app.current_role()) in ('owner', 'manager'));
create policy customers_read on public.customers for select to authenticated
  using ((select app.current_role()) in ('owner', 'manager', 'cashier'));
create policy orders_read on public.orders for select to authenticated
  using (branch_id = (select app.current_branch_id()) and (select app.current_role()) in ('owner', 'manager', 'cashier')
         and status not in ('awaiting_payment', 'payment_expired'));
create policy order_items_read on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id));
create policy order_item_modifiers_read on public.order_item_modifiers for select to authenticated
  using (exists (select 1 from public.order_items i where i.id = order_item_id));
create policy order_events_read on public.order_status_events for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id));
create policy payments_read on public.payments for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id));
create policy refunds_read on public.refunds for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id));
create policy refund_items_read on public.refund_items for select to authenticated
  using (exists (select 1 from public.refunds r where r.id = refund_id));
create policy fraud_flags_read on public.fraud_flags for select to authenticated
  using (branch_id = (select app.current_branch_id()) and (select app.current_role()) in ('owner', 'manager'));

revoke all on public.dining_tables, public.qr_codes, public.customers, public.orders, public.order_items, public.order_item_modifiers,
  public.order_status_events, public.payments, public.refunds, public.refund_items, public.fraud_flags from anon, authenticated;
grant select on public.dining_tables, public.qr_codes, public.order_items, public.order_item_modifiers, public.order_status_events,
  public.refunds, public.refund_items, public.fraud_flags to authenticated;
-- Column-level: device/IP hashes and idempotency data stay server-side; the customer's
-- full mobile is revealed only through an audited function (Phase 6 D8).
grant select (id, branch_id, order_number, pickup_number, source, order_type, status, qr_code_id, table_id, table_label, customer_id,
  customer_name, note, delivery_address, delivery_landmark, delivery_distance_m, subtotal_paise, promo_discount_paise,
  order_discount_paise, delivery_fee_paise, tax_paise, total_paise, loyalty_eligible_paise, coupon_id,
  promotion_id, eta_minutes, reject_reason, cancel_reason,
  paid_at, confirmed_at, preparing_at, ready_at, completed_at, cancelled_at, risk_score, on_hold, hold_reason, late_payment, version,
  created_at, updated_at)
  on public.orders to authenticated;
grant select (id, name, first_order_at, last_order_at, order_count, total_spent_paise, created_at) on public.customers to authenticated;
grant select (id, order_id, provider, provider_payment_id, amount_paise, currency, status, method, payer_vpa_masked, failure_reason,
  captured_at, refunded_paise, is_duplicate, created_at) on public.payments to authenticated;

revoke execute on function
  app.flag(text, public.flag_severity, uuid, jsonb), app.guard_order_status(), app.broadcast_order(),
  app.qr_lookup(text), app.checkout_context(text, text), app.create_order(jsonb), app.attach_razorpay_order(uuid, text),
  app.assign_numbers(uuid), app.apply_payment_captured(text, text, bigint, text, text, text, text),
  app.apply_payment_failed(text, text, bigint, text), app.expire_unpaid_orders(), app.order_public(text),
  app.cancel_by_customer(text, text), app.create_duplicate_refund(uuid), app.refund_submitted(uuid, text),
  app.refund_submit_failed(uuid, text), app.apply_refund_event(text, text, bigint, boolean, text),
  app.find_order(text, text), app.record_webhook(text, text, text, jsonb, boolean), app.webhook_done(bigint, text)
  from public, anon, authenticated;
grant execute on function
  app.qr_lookup(text), app.checkout_context(text, text), app.create_order(jsonb), app.attach_razorpay_order(uuid, text),
  app.apply_payment_captured(text, text, bigint, text, text, text, text), app.apply_payment_failed(text, text, bigint, text),
  app.expire_unpaid_orders(), app.order_public(text), app.cancel_by_customer(text, text), app.create_duplicate_refund(uuid),
  app.refund_submitted(uuid, text), app.refund_submit_failed(uuid, text), app.apply_refund_event(text, text, bigint, boolean, text),
  app.find_order(text, text), app.record_webhook(text, text, text, jsonb, boolean), app.webhook_done(bigint, text)
  to service_role;
