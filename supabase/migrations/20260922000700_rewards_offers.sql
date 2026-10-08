-- ============================================================================
-- M5 Lucky Draw loyalty & offers.
--
-- The Lucky Draw (approved rules):
--   * A customer is their verified mobile number.
--   * Every successful order adds its value EXCLUDING GST (and excluding the delivery
--     fee) to that mobile's cumulative loyalty spend. Spend is never reset.
--   * The moment cumulative spend reaches the threshold (₹2,000 — i.e. more than
--     ₹1,999), the customer is issued ONE Lucky Draw token, automatically.
--   * ONE token per mobile per campaign, for ever: later orders keep adding to the
--     loyalty spend but can never earn a second token. The database enforces this
--     with a unique constraint, not the front end.
--   * The campaign has a fixed number of tokens (500), numbered SLB-001 … SLB-500.
--     When they run out, loyalty spend still accumulates but no token is issued.
--   * Tokens are lucky-draw entries. They are never spent, never discount an order
--     and never expire inside the campaign.
--
-- Also here: a hash-chained loyalty ledger, manual spend corrections with a daily
-- cap, customer freeze, coupons (locked slots) and happy-hour promotions.
-- Design: docs/PHASE-4-DATABASE.md §2.5, §2.6, §2.10, §4, Revision 2 (§8–§12);
-- docs/PHASE-2-USER-FLOWS.md §1.5, §2.5; docs/PHASE-7-API.md §2.4–2.5, §6.2–6.3.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Customers: freeze (Revision 2 R6). Loyalty spend itself lives in loyalty_accounts,
-- so it is always scoped to one campaign and can never drift from the ledger.
-- ----------------------------------------------------------------------------
alter table public.customers
  add column is_frozen     boolean not null default false,
  add column frozen_reason text check (length(frozen_reason) <= 200);

-- ----------------------------------------------------------------------------
-- Campaign
-- ----------------------------------------------------------------------------
create table public.campaigns (
  id               uuid primary key default app.uuid_v7(),
  branch_id        uuid not null references public.branches (id),
  name             text not null check (length(btrim(name)) between 1 and 60),
  prefix           text not null default 'SLB' check (prefix ~ '^[A-Z]{2,6}$'),
  threshold_paise  bigint not null check (threshold_paise >= 100),
  token_limit      int not null check (token_limit between 1 and 10000),
  tokens_issued    int not null default 0 check (tokens_issued >= 0),
  starts_on        date,
  ends_on          date,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (tokens_issued <= token_limit),
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);
-- One campaign runs at a time per branch: two would make "one token per mobile" meaningless.
create unique index campaigns_active_idx on public.campaigns (branch_id) where is_active;
create trigger campaigns_updated_at before update on public.campaigns for each row execute function app.touch_updated_at();

-- A branch always has its Lucky Draw campaign, built from the branch's own settings.
create or replace function app.ensure_branch_settings(p_branch_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.settings (branch_id, key, value)
  select p_branch_id, d.key, d.default_value from public.setting_definitions d
  on conflict do nothing;

  insert into public.campaigns (branch_id, name, threshold_paise, token_limit)
  select p_branch_id, 'Lucky Draw',
         coalesce((select (value #>> '{}')::bigint from public.settings where branch_id = p_branch_id and key = 'loyalty_threshold_paise'), 200000),
         coalesce((select (value #>> '{}')::int    from public.settings where branch_id = p_branch_id and key = 'lucky_draw_token_limit'), 500)
  where not exists (select 1 from public.campaigns c where c.branch_id = p_branch_id);
end $$;

create function app.active_campaign(p_branch_id uuid) returns public.campaigns
language sql stable security definer set search_path = '' as $$
  select * from public.campaigns
   where branch_id = p_branch_id and is_active
     and (starts_on is null or starts_on <= (now() at time zone 'Asia/Kolkata')::date)
     and (ends_on is null or ends_on >= (now() at time zone 'Asia/Kolkata')::date)
   limit 1
$$;

-- ----------------------------------------------------------------------------
-- Loyalty accounts and Lucky Draw tokens
-- ----------------------------------------------------------------------------
create table public.loyalty_accounts (
  campaign_id  uuid not null references public.campaigns (id),
  customer_id  uuid not null references public.customers (id),
  spend_paise  bigint not null default 0 check (spend_paise >= 0),
  updated_at   timestamptz not null default now(),
  primary key (campaign_id, customer_id)
);
create index loyalty_accounts_spend_idx on public.loyalty_accounts (campaign_id, spend_paise desc);

create type public.lucky_token_status as enum ('issued', 'void');

create table public.lucky_draw_tokens (
  id                    uuid primary key default app.uuid_v7(),
  campaign_id           uuid not null references public.campaigns (id),
  customer_id           uuid not null references public.customers (id),
  serial                int not null check (serial > 0),
  code                  text not null unique check (code ~ '^[A-Z]{2,6}-[0-9]{3,5}$'),
  status                public.lucky_token_status not null default 'issued',
  issued_at             timestamptz not null default now(),
  trigger_order_id      uuid references public.orders (id),
  spend_at_issue_paise  bigint not null,
  voided_at             timestamptz,
  voided_by             uuid references public.staff (id),
  void_reason           text check (length(void_reason) <= 200),
  -- THE rule: one mobile (= one customer) can hold at most one token in a campaign.
  unique (campaign_id, customer_id),
  unique (campaign_id, serial)
);
create index lucky_draw_tokens_campaign_idx on public.lucky_draw_tokens (campaign_id, serial);
create index lucky_draw_tokens_customer_idx on public.lucky_draw_tokens (customer_id);

-- ----------------------------------------------------------------------------
-- Append-only, hash-chained history of every change to a customer's loyalty (R7).
-- ----------------------------------------------------------------------------
create type public.ledger_entry as enum (
  'loyalty_earned', 'loyalty_reversed', 'token_issued', 'token_voided', 'manual_loyalty_adjust');

create sequence app.token_ledger_id_seq;
create table public.token_ledger (
  id                bigint primary key default nextval('app.token_ledger_id_seq'),
  campaign_id       uuid not null references public.campaigns (id),
  customer_id       uuid not null references public.customers (id),
  entry_type        public.ledger_entry not null,
  spend_delta_paise bigint not null default 0,
  spend_after_paise bigint not null,
  order_id          uuid,
  token_id          uuid,
  staff_id          uuid,
  reason            text,
  created_at        timestamptz not null,
  prev_hash         bytea,
  row_hash          bytea not null,
  check (entry_type <> 'manual_loyalty_adjust' or length(btrim(reason)) >= 3)
);
create index token_ledger_customer_idx on public.token_ledger (customer_id, id);
create index token_ledger_order_idx on public.token_ledger (order_id) where order_id is not null;

create function app.block_ledger_changes() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = 'FORBIDDEN', detail = 'The loyalty history is append-only.';
end $$;
create trigger token_ledger_no_update before update or delete on public.token_ledger
  for each row execute function app.block_ledger_changes();
create trigger token_ledger_no_truncate before truncate on public.token_ledger
  for each statement execute function app.block_ledger_changes();
insert into app.hash_chains (name) values ('token_ledger');

create function app.ledger_payload(r public.token_ledger) returns bytea
language sql immutable set search_path = '' as $$
  select convert_to(jsonb_build_object(
    'id', r.id, 'campaign_id', r.campaign_id, 'customer_id', r.customer_id, 'entry_type', r.entry_type,
    'spend_delta', r.spend_delta_paise, 'spend_after', r.spend_after_paise, 'order_id', r.order_id,
    'token_id', r.token_id, 'staff_id', r.staff_id, 'reason', r.reason,
    'created_us', (extract(epoch from r.created_at) * 1000000)::bigint
  )::text, 'UTF8')
$$;

/**
 * The ONLY way loyalty spend changes. Moves the account balance and appends one
 * chained ledger row, so the balance and its history can never disagree.
 */
create function app.ledger(
  p_campaign uuid, p_customer uuid, p_type public.ledger_entry, p_spend_delta bigint,
  p_order uuid default null, p_token uuid default null, p_reason text default null
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  ctx     app.staff_context := app.current_staff();
  v_after bigint;
  v_prev  bytea;
  r       public.token_ledger;
begin
  insert into public.loyalty_accounts (campaign_id, customer_id, spend_paise)
  values (p_campaign, p_customer, greatest(0, p_spend_delta))
  on conflict (campaign_id, customer_id)
  do update set spend_paise = greatest(0, public.loyalty_accounts.spend_paise + p_spend_delta), updated_at = now()
  returning spend_paise into v_after;

  select last_hash into v_prev from app.hash_chains where name = 'token_ledger' for update;
  r.id := nextval('app.token_ledger_id_seq');
  r.campaign_id := p_campaign;
  r.customer_id := p_customer;
  r.entry_type := p_type;
  r.spend_delta_paise := p_spend_delta;
  r.spend_after_paise := v_after;
  r.order_id := p_order;
  r.token_id := p_token;
  r.staff_id := ctx.staff_id;
  r.reason := p_reason;
  r.created_at := date_trunc('microseconds', clock_timestamp());
  r.prev_hash := v_prev;
  r.row_hash := extensions.digest(coalesce(v_prev, ''::bytea) || app.ledger_payload(r), 'sha256');
  insert into public.token_ledger select r.*;
  update app.hash_chains set last_id = r.id, last_hash = r.row_hash where name = 'token_ledger';
  return v_after;
end $$;

-- Null if the chain is intact, else the first bad row id (0 = newest rows removed).
create function app.verify_ledger_chain() returns bigint
language plpgsql stable security definer set search_path = '' as $$
declare
  r      public.token_ledger;
  v_prev bytea := null;
begin
  for r in select * from public.token_ledger order by id loop
    if r.prev_hash is distinct from v_prev
       or r.row_hash <> extensions.digest(coalesce(v_prev, ''::bytea) || app.ledger_payload(r), 'sha256') then
      return r.id;
    end if;
    v_prev := r.row_hash;
  end loop;
  if (select last_hash from app.hash_chains where name = 'token_ledger') is distinct from v_prev then return 0; end if;
  return null;
end $$;

create function app.setting_int(p_branch_id uuid, p_key text, p_default bigint) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce((select case when jsonb_typeof(value) = 'number' then (value #>> '{}')::bigint end
                   from public.settings where branch_id = p_branch_id and key = p_key), p_default)
$$;

/**
 * Issue this customer's one Lucky Draw token, if they have earned it and one is left.
 * The campaign row is locked first, so two orders paid at the same instant can never take
 * the same number or push the campaign past its limit (Phase 4 §4). Returns the token row
 * or nothing: every reason for "no token" is a normal outcome, not an error.
 */
create function app.issue_lucky_draw_token(p_campaign uuid, p_customer uuid, p_order uuid)
returns public.lucky_draw_tokens
language plpgsql security definer set search_path = '' as $$
declare
  k       public.campaigns;
  v_spend bigint;
  t       public.lucky_draw_tokens;
begin
  select * into k from public.campaigns where id = p_campaign for update;   -- serialises issuance
  if k.tokens_issued >= k.token_limit then
    return t;                                                               -- campaign sold out
  end if;
  select spend_paise into v_spend from public.loyalty_accounts where campaign_id = k.id and customer_id = p_customer;
  if coalesce(v_spend, 0) < k.threshold_paise then
    return t;
  end if;
  if exists (select 1 from public.lucky_draw_tokens where campaign_id = k.id and customer_id = p_customer) then
    return t;                                                               -- already has their one token
  end if;

  insert into public.lucky_draw_tokens (campaign_id, customer_id, serial, code, trigger_order_id, spend_at_issue_paise)
  values (k.id, p_customer, k.tokens_issued + 1,
          k.prefix || '-' || lpad((k.tokens_issued + 1)::text, greatest(3, length(k.token_limit::text)), '0'),
          p_order, v_spend)
  returning * into t;
  update public.campaigns set tokens_issued = tokens_issued + 1 where id = k.id;
  perform app.ledger(k.id, p_customer, 'token_issued', 0, p_order, t.id);
  return t;
end $$;

/**
 * A successful order adds its pre-GST value to the customer's loyalty spend, then the
 * token is issued if that crossed the threshold. Runs once per order (the ledger is the guard).
 */
create function app.earn_loyalty(p_order_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  o          public.orders;
  c          public.customers;
  k          public.campaigns := null;
  v_refunded bigint;
  v_amount   bigint;
begin
  select * into o from public.orders where id = p_order_id;
  if exists (select 1 from public.token_ledger where order_id = o.id and entry_type = 'loyalty_earned') then return; end if;
  select * into k from app.active_campaign(o.branch_id);
  if k.id is null then return; end if;                    -- no campaign running: nothing accrues
  select * into c from public.customers where id = o.customer_id for update;
  if c.is_frozen then return; end if;                     -- frozen: can order, can't earn (R6)

  v_refunded := coalesce((select sum(p.refunded_paise) from public.payments p where p.order_id = o.id and not p.is_duplicate), 0);
  v_amount := greatest(0, o.loyalty_eligible_paise - v_refunded);
  if v_amount = 0 then return; end if;
  perform app.ledger(k.id, c.id, 'loyalty_earned', v_amount, o.id);

  if o.confirmed_at is not null and now() - o.confirmed_at < interval '60 seconds' then
    perform app.flag('FAST_COMPLETE', 'info', o.id, jsonb_build_object('seconds', extract(epoch from now() - o.confirmed_at)::int));
  end if;

  perform app.issue_lucky_draw_token(k.id, c.id, o.id);
end $$;

/**
 * A refund takes its money back out of the loyalty spend (C12). An already-issued token is
 * never taken away automatically — it is the customer's draw entry and the rules promise it
 * is permanent — but if the refund drops them back under the threshold the token is flagged
 * so a manager can look at it and, if it was a trick, void it by hand.
 */
create function app.reverse_loyalty(p_campaign uuid, p_customer uuid, p_amount bigint, p_order uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  k       public.campaigns;
  v_after bigint;
  t       public.lucky_draw_tokens;
begin
  if p_amount <= 0 then return; end if;
  v_after := app.ledger(p_campaign, p_customer, 'loyalty_reversed', -p_amount, p_order, null, p_reason);
  select * into k from public.campaigns where id = p_campaign;
  select * into t from public.lucky_draw_tokens where campaign_id = p_campaign and customer_id = p_customer and status = 'issued';
  if t.id is not null and v_after < k.threshold_paise then
    perform app.flag('TOKEN_AFTER_REFUND', 'warn', p_order,
                     jsonb_build_object('token', t.code, 'spend_paise', v_after, 'threshold_paise', k.threshold_paise));
  end if;
end $$;

-- Order failed/cancelled/rejected: give its coupon slot back.
create function app.release_order_holds(p_order_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  cr record;
begin
  for cr in delete from public.coupon_redemptions where order_id = p_order_id returning coupon_id loop
    update public.coupons set used_count = greatest(0, used_count - 1) where id = cr.coupon_id;
  end loop;
end $$;

-- A payment that arrived after expiry revives the order: take the coupon slot back if possible (P2).
create function app.retake_order_holds(p_order_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  o public.orders;
begin
  select * into o from public.orders where id = p_order_id;
  if o.coupon_id is not null then
    begin
      perform app.take_coupon(o.coupon_id, o.id, o.customer_id, o.order_discount_paise);
    exception when others then
      perform app.flag('LATE_PAYMENT_COUPON', 'warn', o.id, jsonb_build_object('coupon_id', o.coupon_id));
    end;
  end if;
end $$;

-- Every status change → the right loyalty/offer bookkeeping, in the same transaction.
create function app.order_rewards() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status is not distinct from old.status then return null; end if;
  if new.status in ('payment_expired', 'cancelled', 'rejected') then
    perform app.release_order_holds(new.id);
  elsif old.status = 'payment_expired' and new.status = 'pending' then
    perform app.retake_order_holds(new.id);
  elsif new.status in ('completed', 'delivered') then
    perform app.earn_loyalty(new.id);
  end if;
  return null;
end $$;

-- ----------------------------------------------------------------------------
-- Offers
-- ----------------------------------------------------------------------------
create type public.discount_type as enum ('percent', 'flat');
create type public.promotion_kind as enum ('happy_hour', 'first_order');

create table public.coupons (
  id                        uuid primary key default app.uuid_v7(),
  branch_id                 uuid not null references public.branches (id),
  code                      extensions.citext not null check (code ~ '^[A-Za-z0-9]{3,20}$'),
  description               text check (length(description) <= 120),
  discount_type             public.discount_type not null,
  value                     int not null check (value > 0),
  min_order_paise           bigint check (min_order_paise >= 0),
  max_discount_paise        bigint check (max_discount_paise > 0),
  starts_at                 timestamptz,
  ends_at                   timestamptz,
  usage_limit_total         int check (usage_limit_total > 0),
  usage_limit_per_customer  int check (usage_limit_per_customer > 0),
  used_count                int not null default 0 check (used_count >= 0),
  is_active                 boolean not null default false,
  created_by                uuid references public.staff (id),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (branch_id, code),
  check (discount_type <> 'percent' or value <= 10000),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create trigger coupons_updated_at before update on public.coupons for each row execute function app.touch_updated_at();

create table public.coupon_redemptions (
  id              uuid primary key default app.uuid_v7(),
  coupon_id       uuid not null references public.coupons (id),
  order_id        uuid not null unique references public.orders (id),
  customer_id     uuid not null references public.customers (id),
  discount_paise  bigint not null check (discount_paise >= 0),
  created_at      timestamptz not null default now()
);
create index coupon_redemptions_customer_idx on public.coupon_redemptions (coupon_id, customer_id);

create table public.promotions (
  id                  uuid primary key default app.uuid_v7(),
  branch_id           uuid not null references public.branches (id),
  kind                public.promotion_kind not null,
  name                text not null check (length(btrim(name)) between 1 and 60),
  discount_type       public.discount_type not null,
  value               int not null check (value > 0),
  max_discount_paise  bigint check (max_discount_paise > 0),
  min_order_paise     bigint check (min_order_paise >= 0),
  days_mask           smallint not null default 127 check (days_mask between 1 and 127),
  start_time          time,
  end_time            time,
  starts_on           date,
  ends_on             date,
  is_active           boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (discount_type <> 'percent' or value <= 10000),
  check (kind <> 'happy_hour' or (start_time is not null and end_time is not null)),
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);
create trigger promotions_updated_at before update on public.promotions for each row execute function app.touch_updated_at();

create table public.promotion_targets (
  promotion_id  uuid not null references public.promotions (id) on delete cascade,
  category_id   uuid references public.categories (id),
  product_id    uuid references public.products (id),
  check ((category_id is null) <> (product_id is null))
);
create index promotion_targets_idx on public.promotion_targets (promotion_id);

-- Lock a coupon slot for an order (C10: the row lock stops two people taking the last slot).
create function app.take_coupon(p_coupon uuid, p_order uuid, p_customer uuid, p_discount bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
  k public.coupons;
begin
  select * into k from public.coupons where id = p_coupon for update;
  if k.id is null or not k.is_active or (k.starts_at is not null and k.starts_at > now()) or (k.ends_at is not null and k.ends_at <= now()) then
    perform app.raise('COUPON_INVALID', 'That coupon isn’t valid any more.');
  end if;
  if k.usage_limit_total is not null and k.used_count >= k.usage_limit_total then
    perform app.raise('COUPON_EXHAUSTED', 'That coupon has been fully used. Please remove it and try again.');
  end if;
  if k.usage_limit_per_customer is not null
     and (select count(*) from public.coupon_redemptions where coupon_id = k.id and customer_id = p_customer) >= k.usage_limit_per_customer then
    perform app.raise('COUPON_EXHAUSTED', 'You’ve already used this coupon.');
  end if;
  insert into public.coupon_redemptions (coupon_id, order_id, customer_id, discount_paise) values (k.id, p_order, p_customer, p_discount);
  update public.coupons set used_count = used_count + 1 where id = k.id;
end $$;

create function app.promotion_json(p public.promotions) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'kind', p.kind, 'label', p.name, 'discount_type', p.discount_type, 'value', p.value,
    'max_discount_paise', p.max_discount_paise, 'min_order_paise', p.min_order_paise,
    'windows', case when p.start_time is null then '[]'::jsonb
                    else jsonb_build_array(jsonb_build_object('days_mask', p.days_mask, 'start', to_char(p.start_time, 'HH24:MI'),
                                                              'end', to_char(p.end_time, 'HH24:MI'))) end,
    'category_ids', coalesce((select jsonb_agg(t.category_id) from public.promotion_targets t where t.promotion_id = p.id and t.category_id is not null), '[]'),
    'product_ids', coalesce((select jsonb_agg(t.product_id) from public.promotion_targets t where t.promotion_id = p.id and t.product_id is not null), '[]'))
$$;

-- Live, in-date promotions of a kind (the time-of-day window is checked by the pricing engine).
create function app.active_promotions(p_branch_id uuid, p_kind public.promotion_kind) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(app.promotion_json(p) order by p.created_at), '[]')
  from public.promotions p
  where p.branch_id = p_branch_id and p.kind = p_kind and p.is_active
    and coalesce((select (value #>> '{}')::boolean from public.settings where branch_id = p_branch_id and key = 'offers_enabled'), false)
    and (p.starts_on is null or p.starts_on <= (now() at time zone 'Asia/Kolkata')::date)
    and (p.ends_on is null or p.ends_on >= (now() at time zone 'Asia/Kolkata')::date)
$$;

/**
 * Everything checkout needs about offers and tokens for one mobile, in one call (service role).
 * Never returns names or codes: token counts only (Phase 7 §2.4).
 */
create function app.offer_context(p_branch_id uuid, p_mobile text, p_coupon_code text, p_device_hash text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s        jsonb := app.branch_settings(p_branch_id);
  v_offers boolean := coalesce((s ->> 'offers_enabled')::boolean, false);
  c        public.customers;
  k        public.coupons;
  cmp      public.campaigns;
  v_spend  bigint := 0;
  v_status text := 'none';
  v_first  jsonb;
  v_eligible boolean := false;
begin
  if p_mobile is not null and p_mobile <> '' then
    select * into c from public.customers where mobile = p_mobile;
  end if;
  select * into cmp from app.active_campaign(p_branch_id);
  if c.id is not null and cmp.id is not null then
    select coalesce(a.spend_paise, 0) into v_spend from public.loyalty_accounts a
     where a.campaign_id = cmp.id and a.customer_id = c.id;
  end if;

  if nullif(btrim(coalesce(p_coupon_code, '')), '') is not null then
    select * into k from public.coupons where branch_id = p_branch_id and code::text = upper(btrim(p_coupon_code));
    v_status := case
      when not v_offers or k.id is null or not k.is_active then 'invalid'
      when k.starts_at is not null and k.starts_at > now() then 'not_started'
      when k.ends_at is not null and k.ends_at <= now() then 'expired'
      when k.usage_limit_total is not null and k.used_count >= k.usage_limit_total then 'exhausted'
      when k.usage_limit_per_customer is not null and c.id is not null
           and (select count(*) from public.coupon_redemptions r where r.coupon_id = k.id and r.customer_id = c.id) >= k.usage_limit_per_customer then 'used'
      else 'valid' end;
  end if;

  -- First-order offer: off while it needs OTP (R3); otherwise new mobile AND new device only (C14).
  select app.promotion_json(p) into v_first from public.promotions p
   where p.branch_id = p_branch_id and p.kind = 'first_order' and p.is_active
     and (p.starts_on is null or p.starts_on <= (now() at time zone 'Asia/Kolkata')::date)
     and (p.ends_on is null or p.ends_on >= (now() at time zone 'Asia/Kolkata')::date)
   limit 1;
  v_eligible := v_offers and v_first is not null and not coalesce((s ->> 'first_order_offer_requires_otp')::boolean, true)
    and coalesce(c.order_count, 0) = 0
    and not exists (select 1 from public.orders o where o.device_id_hash = p_device_hash and o.paid_at is not null);

  return jsonb_build_object(
    'offers_enabled', v_offers,
    'happy_hours', app.active_promotions(p_branch_id, 'happy_hour'),
    'first_order', jsonb_build_object('eligible', v_eligible, 'promotion', case when v_eligible then v_first end),
    'coupon', case when k.id is null then jsonb_build_object('status', v_status)
                   else jsonb_build_object('status', v_status, 'id', k.id, 'code', k.code, 'discount_type', k.discount_type, 'value', k.value,
                                           'min_order_paise', k.min_order_paise, 'max_discount_paise', k.max_discount_paise) end,
    -- Lucky Draw: shown at checkout so the customer knows how close they are. Never spendable.
    'loyalty', case when cmp.id is null then jsonb_build_object('running', false)
                    else jsonb_build_object(
                      'running', true,
                      'spend_paise', coalesce(v_spend, 0),
                      'threshold_paise', cmp.threshold_paise,
                      'tokens_left', greatest(0, cmp.token_limit - cmp.tokens_issued),
                      'token', (select t.code from public.lucky_draw_tokens t
                                 where t.campaign_id = cmp.id and t.customer_id = c.id and t.status = 'issued'),
                      'frozen', coalesce(c.is_frozen, false)) end);
end $$;

-- ----------------------------------------------------------------------------
-- Checkout: create_order also takes the coupon slot, in the same transaction.
-- ----------------------------------------------------------------------------
create or replace function app.create_order(p jsonb) returns jsonb
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

  -- The coupon slot is taken in the same transaction: if it fails, no order is created (Phase 4 §4).
  if nullif(p ->> 'coupon_id', '') is not null then
    perform app.take_coupon((p ->> 'coupon_id')::uuid, v_order, v_customer, (p ->> 'order_discount_paise')::bigint);
  end if;

  return jsonb_build_object('order_id', v_order, 'public_token', v_token,
                            'total_paise', (select total_paise from public.orders where id = v_order), 'existing', false);
end $$;

-- ₹0 orders (a 100%-off coupon) skip Razorpay and go straight to the counter.
create function app.confirm_free_order(p_order_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o         public.orders;
  v_numbers record;
begin
  select * into o from public.orders where id = p_order_id for update;
  if o.id is null or o.total_paise <> 0 then perform app.raise('VALIDATION_FAILED', 'This order needs a payment.'); end if;
  if o.status <> 'awaiting_payment' then
    return jsonb_build_object('order_number', o.order_number, 'pickup_number', o.pickup_number);
  end if;
  select * into v_numbers from app.assign_numbers(o.branch_id);
  perform set_config('app.actor', 'system', true);
  update public.orders
     set status = 'pending', paid_at = now(), order_number = v_numbers.order_number, pickup_number = v_numbers.pickup_number
   where id = o.id;
  update public.customers
     set order_count = order_count + 1, last_order_at = now(), first_order_at = coalesce(first_order_at, now())
   where id = o.customer_id;
  return jsonb_build_object('order_number', v_numbers.order_number, 'pickup_number', v_numbers.pickup_number);
end $$;

-- The trigger is created after the functions it calls exist.
create trigger orders_rewards after update of status on public.orders
  for each row execute function app.order_rewards();

-- ----------------------------------------------------------------------------
-- Refunds now also take back loyalty spend (C12)
-- ----------------------------------------------------------------------------
create or replace function app.apply_refund_event(p_provider_refund_id text, p_payment_id text, p_amount bigint, p_processed boolean, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.refunds;
  p public.payments;
  o public.orders;
  v_total_refunded bigint;
  v_earned bigint;
  v_campaign uuid;
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
  update public.order_items i set refunded_qty = least(i.qty, i.refunded_qty + ri.qty)
    from public.refund_items ri where ri.refund_id = r.id and ri.order_item_id = i.id;
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
    -- Loyalty spend this order earned (net of earlier reversals) comes back out, up to the refund.
    select l.campaign_id, sum(l.spend_delta_paise) into v_campaign, v_earned from public.token_ledger l
     where l.order_id = o.id and l.entry_type in ('loyalty_earned', 'loyalty_reversed') group by l.campaign_id;
    if coalesce(v_earned, 0) > 0 then
      perform app.reverse_loyalty(v_campaign, o.customer_id, least(v_earned, r.amount_paise), o.id, 'Refund ' || r.id);
    end if;
    if v_total_refunded >= p.amount_paise and o.status <> 'refunded'
       and exists (select 1 from app.order_transitions where from_status = o.status and to_status = 'refunded') then
      perform set_config('app.actor', 'system', true);
      update public.orders set status = 'refunded' where id = o.id;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'status', 'processed', 'order_id', r.order_id);
end $$;

-- ----------------------------------------------------------------------------
-- Customer tracker: Lucky Draw progress once the order is done (Phase 7 §2.7)
-- ----------------------------------------------------------------------------
create function app.order_rewards_public(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when o.status in ('completed', 'delivered') and not c.is_frozen and k.id is not null then
    jsonb_build_object(
      'spend_paise', coalesce(a.spend_paise, 0),
      'threshold_paise', k.threshold_paise,
      'earned_paise', coalesce((select sum(l.spend_delta_paise) from public.token_ledger l
                                 where l.order_id = o.id and l.entry_type = 'loyalty_earned'), 0),
      'token', (select t.code from public.lucky_draw_tokens t
                 where t.campaign_id = k.id and t.customer_id = c.id and t.status = 'issued'),
      'tokens_left', greatest(0, k.token_limit - k.tokens_issued))
  end
  from public.orders o
  join public.customers c on c.id = o.customer_id
  left join lateral (select * from app.active_campaign(o.branch_id)) k on true
  left join public.loyalty_accounts a on a.campaign_id = k.id and a.customer_id = c.id
  where o.public_token = p_token
$$;

-- ----------------------------------------------------------------------------
-- Staff: the Lucky Draw screen, token lookup, manual corrections, freeze
-- ----------------------------------------------------------------------------

/** Campaign totals for the Lucky Draw screen and the dashboard. */
create function public.lucky_draw_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager', 'cashier');
  k   public.campaigns;
begin
  select * into k from public.campaigns where branch_id = ctx.branch_id and is_active limit 1;
  if k.id is null then return jsonb_build_object('campaign', null); end if;
  return jsonb_build_object(
    'campaign', jsonb_build_object('id', k.id, 'name', k.name, 'threshold_paise', k.threshold_paise,
                                   'starts_on', k.starts_on, 'ends_on', k.ends_on),
    'token_limit', k.token_limit,
    'tokens_issued', k.tokens_issued,
    'tokens_left', greatest(0, k.token_limit - k.tokens_issued),
    'tokens_void', (select count(*) from public.lucky_draw_tokens t where t.campaign_id = k.id and t.status = 'void'),
    'customers_with_tokens', (select count(*) from public.lucky_draw_tokens t where t.campaign_id = k.id and t.status = 'issued'),
    -- "Nearly there": at least a quarter of the way, but not yet over the line.
    'customers_close', (select count(*) from public.loyalty_accounts a
                         where a.campaign_id = k.id and a.spend_paise < k.threshold_paise
                           and a.spend_paise >= k.threshold_paise / 4),
    'loyalty_customers', (select count(*) from public.loyalty_accounts a where a.campaign_id = k.id and a.spend_paise > 0),
    'loyalty_spend_paise', (select coalesce(sum(a.spend_paise), 0) from public.loyalty_accounts a where a.campaign_id = k.id),
    'last_issued_at', (select max(t.issued_at) from public.lucky_draw_tokens t where t.campaign_id = k.id));
end $$;

/** The issued tokens, newest first — the list the draw is run from. */
create function public.lucky_draw_tokens_list(p_q text default null, p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  ctx      app.staff_context := app.require_role('owner', 'manager', 'cashier');
  v_q      text := upper(btrim(coalesce(p_q, '')));
  v_digits text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g');
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
            'id', t.id, 'code', t.code, 'serial', t.serial, 'status', t.status,
            'customer_id', c.id, 'customer_name', c.name, 'mobile_masked', app.mask_mobile(c.mobile),
            'issued_at', t.issued_at, 'spend_at_issue_paise', t.spend_at_issue_paise,
            'spend_paise', coalesce(a.spend_paise, 0), 'frozen', c.is_frozen,
            'order_number', (select o.order_number from public.orders o where o.id = t.trigger_order_id),
            'void_reason', t.void_reason) order by t.serial desc)
          from public.lucky_draw_tokens t
          join public.campaigns k on k.id = t.campaign_id and k.branch_id = ctx.branch_id and k.is_active
          join public.customers c on c.id = t.customer_id
          left join public.loyalty_accounts a on a.campaign_id = k.id and a.customer_id = c.id
         where v_q = ''
            or t.code = v_q
            or (length(v_digits) = 10 and c.mobile = '+91' || v_digits)
            or c.name ilike '%' || replace(replace(btrim(coalesce(p_q, '')), '%', ''), '_', '') || '%'
         limit greatest(1, least(coalesce(p_limit, 100), 500))), '[]');
end $$;

/** Customers closest to earning their token — who to tell "₹250 more". */
create function public.loyalty_leaderboard(p_limit int default 20) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager', 'cashier');
  k   public.campaigns;
begin
  select * into k from public.campaigns where branch_id = ctx.branch_id and is_active limit 1;
  if k.id is null then return '[]'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
            'customer_id', c.id, 'customer_name', c.name, 'mobile_masked', app.mask_mobile(c.mobile),
            'spend_paise', a.spend_paise, 'threshold_paise', k.threshold_paise,
            'remaining_paise', greatest(0, k.threshold_paise - a.spend_paise),
            'order_count', c.order_count, 'last_order_at', c.last_order_at, 'frozen', c.is_frozen)
            order by a.spend_paise desc)
          from public.loyalty_accounts a
          join public.customers c on c.id = a.customer_id
         where a.campaign_id = k.id and a.spend_paise > 0
           and not exists (select 1 from public.lucky_draw_tokens t where t.campaign_id = k.id and t.customer_id = c.id)
         limit greatest(1, least(coalesce(p_limit, 20), 100))), '[]');
end $$;

/** Counter lookup of a Lucky Draw number. Rate-limited per staff member (C6). */
create function public.verify_token(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager', 'cashier');
  t   public.lucky_draw_tokens;
  c   public.customers;
begin
  if not app.hit_rate_limit('token_verify:' || ctx.staff_id, 30, 600) then
    perform app.raise('RATE_LIMITED', 'Too many lookups. Please wait a few minutes.');
  end if;
  select * into t from public.lucky_draw_tokens t2
   join public.campaigns k on k.id = t2.campaign_id and k.branch_id = ctx.branch_id
   where t2.code = upper(btrim(coalesce(p_code, '')));
  if t.id is null then return jsonb_build_object('valid', false); end if;
  select * into c from public.customers where id = t.customer_id;
  return jsonb_build_object('valid', t.status = 'issued', 'status', t.status::text, 'code', t.code,
                            'issued_at', t.issued_at, 'void_reason', t.void_reason,
                            'customer', jsonb_build_object('id', c.id, 'name', c.name, 'mobile_masked', app.mask_mobile(c.mobile)));
end $$;

/**
 * Void a token (a manager only, always with a reason). The number is retired, never reissued,
 * so the printed list of entries stays honest. The customer still can't earn another one.
 */
create function public.void_lucky_draw_token(p_token_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager');
  t   public.lucky_draw_tokens;
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    perform app.raise('VALIDATION_FAILED', 'Give a reason (at least 3 characters).', jsonb_build_object('fields', jsonb_build_object('reason', 'required')));
  end if;
  select t2.* into t from public.lucky_draw_tokens t2
   join public.campaigns k on k.id = t2.campaign_id and k.branch_id = ctx.branch_id
   where t2.id = p_token_id for update of t2;
  if t.id is null then perform app.raise('NOT_FOUND', 'That Lucky Draw token doesn’t exist.'); end if;
  if t.status <> 'issued' then perform app.raise('INVALID_TRANSITION', 'That token was already voided.'); end if;
  update public.lucky_draw_tokens
     set status = 'void', voided_at = now(), voided_by = ctx.staff_id, void_reason = left(btrim(p_reason), 200)
   where id = t.id;
  perform app.ledger(t.campaign_id, t.customer_id, 'token_voided', 0, null, t.id, btrim(p_reason));
  perform app.audit('lucky_draw.void', 'lucky_draw_token', t.id::text,
                    jsonb_build_object('code', t.code, 'status', 'issued'), jsonb_build_object('status', 'void'), p_reason);
end $$;

-- Loyalty corrections made today in this branch (for the daily cap, R2).
create function app.manual_loyalty_today(p_branch_id uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(count(*), 0) from public.audit_logs a
   where a.branch_id = p_branch_id and a.action = 'loyalty.manual_adjust'
     and a.created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'
$$;

create function app.apply_manual_adjust(p_customer uuid, p_branch_id uuid, p_spend_delta bigint, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k       public.campaigns;
  v_after bigint;
  t       public.lucky_draw_tokens;
begin
  select * into k from app.active_campaign(p_branch_id);
  if k.id is null then perform app.raise('VALIDATION_FAILED', 'No Lucky Draw campaign is running.'); end if;
  v_after := app.ledger(k.id, p_customer, 'manual_loyalty_adjust', p_spend_delta, null, null, p_reason);
  perform app.audit('loyalty.manual_adjust', 'customer', p_customer::text, null,
                    jsonb_build_object('spend_delta_paise', p_spend_delta, 'spend_after_paise', v_after), p_reason, p_branch_id);
  -- A correction upwards can carry the customer over the line, exactly like an order would.
  if p_spend_delta > 0 then
    select * into t from app.issue_lucky_draw_token(k.id, p_customer, null);
  end if;
  return jsonb_build_object('spend_paise', v_after, 'token', t.code);
end $$;

/** Correct a customer's loyalty spend by hand (Owner/Manager, reason required, daily cap). */
create function public.adjust_loyalty(p_customer_id uuid, p_spend_delta bigint, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ctx      app.staff_context := app.require_role('owner', 'manager');
  v_reason text := btrim(coalesce(p_reason, ''));
  v_cap    bigint := app.setting_int(ctx.branch_id, 'manual_loyalty_adjust_daily_cap', 3);
  v_req    uuid;
begin
  if length(v_reason) < 3 then
    perform app.raise('VALIDATION_FAILED', 'Give a reason (at least 3 characters).', jsonb_build_object('fields', jsonb_build_object('reason', 'required')));
  end if;
  if coalesce(p_spend_delta, 0) = 0 then
    perform app.raise('VALIDATION_FAILED', 'Nothing to change.');
  end if;
  if abs(p_spend_delta) > 10000000 then
    perform app.raise('VALIDATION_FAILED', 'That correction is too large.');
  end if;
  if not exists (select 1 from public.customers where id = p_customer_id) then perform app.raise('NOT_FOUND', 'Customer not found.'); end if;

  -- Adding spend by hand beyond the daily cap needs the Owner (S1, R2).
  if p_spend_delta > 0 and app.manual_loyalty_today(ctx.branch_id) >= v_cap then
    if ctx.role <> 'owner' then
      insert into public.approval_requests (branch_id, kind, payload, summary, requested_by)
      values (ctx.branch_id, 'manual_loyalty_over_cap',
              jsonb_build_object('customer_id', p_customer_id, 'spend_delta', p_spend_delta, 'reason', v_reason),
              format('Add ₹%s of loyalty spend for %s (%s)', rtrim(rtrim(to_char(p_spend_delta / 100.0, 'FM99999990.99'), '0'), '.'),
                     (select coalesce(name, 'customer') from public.customers where id = p_customer_id), left(v_reason, 60)),
              ctx.staff_id)
      returning id into v_req;
      perform app.audit('approval.requested', 'approval_request', v_req::text, null, jsonb_build_object('kind', 'manual_loyalty_over_cap'), v_reason);
      return jsonb_build_object('status', 'needs_owner', 'approval_id', v_req);
    end if;
    perform app.require_recent_mfa();
  end if;
  return jsonb_build_object('status', 'done') || app.apply_manual_adjust(p_customer_id, ctx.branch_id, p_spend_delta, v_reason);
end $$;

create function public.set_customer_frozen(p_customer_id uuid, p_frozen boolean, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager');
  c   public.customers;
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    perform app.raise('VALIDATION_FAILED', 'Give a reason (at least 3 characters).', jsonb_build_object('fields', jsonb_build_object('reason', 'required')));
  end if;
  select * into c from public.customers where id = p_customer_id for update;
  if c.id is null then perform app.raise('NOT_FOUND', 'Customer not found.'); end if;
  update public.customers set is_frozen = p_frozen, frozen_reason = case when p_frozen then left(btrim(p_reason), 200) end where id = c.id;
  perform app.audit(case when p_frozen then 'customer.freeze' else 'customer.unfreeze' end, 'customer', c.id::text,
                    jsonb_build_object('frozen', c.is_frozen), jsonb_build_object('frozen', p_frozen), p_reason);
end $$;

create function public.customer_search(p_q text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  ctx      app.staff_context := app.require_role('owner', 'manager', 'cashier');
  v_q      text := btrim(coalesce(p_q, ''));
  v_digits text := regexp_replace(v_q, '\D', '', 'g');
  k        public.campaigns;
begin
  if length(v_q) < 2 then return '[]'; end if;
  select * into k from public.campaigns where branch_id = ctx.branch_id and is_active limit 1;
  return coalesce((select jsonb_agg(x order by x ->> 'last_order_at' desc nulls last) from (
    select jsonb_build_object('id', c.id, 'name', c.name, 'mobile_masked', app.mask_mobile(c.mobile), 'order_count', c.order_count,
                              'last_order_at', c.last_order_at, 'frozen', c.is_frozen,
                              'loyalty_spend_paise', coalesce((select a.spend_paise from public.loyalty_accounts a
                                                                where a.campaign_id = k.id and a.customer_id = c.id), 0),
                              'token', (select t.code from public.lucky_draw_tokens t
                                         where t.campaign_id = k.id and t.customer_id = c.id and t.status = 'issued')) as x
      from public.customers c
     where (length(v_digits) = 10 and c.mobile = '+91' || v_digits)
        or (length(v_digits) < 10 and c.name ilike '%' || replace(replace(v_q, '%', ''), '_', '') || '%')
     limit 20) s), '[]');
end $$;

create function public.customer_detail(p_customer_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  ctx       app.staff_context := app.require_role('owner', 'manager', 'cashier');
  c         public.customers;
  k         public.campaigns;
  v_manager boolean := ctx.role in ('owner', 'manager');
begin
  select * into c from public.customers where id = p_customer_id;
  if c.id is null then perform app.raise('NOT_FOUND', 'Customer not found.'); end if;
  select * into k from public.campaigns where branch_id = ctx.branch_id and is_active limit 1;
  return jsonb_build_object(
    'id', c.id, 'name', c.name, 'mobile_masked', app.mask_mobile(c.mobile), 'first_order_at', c.first_order_at,
    'last_order_at', c.last_order_at, 'order_count', c.order_count, 'total_spent_paise', c.total_spent_paise,
    'loyalty_spend_paise', coalesce((select a.spend_paise from public.loyalty_accounts a
                                      where a.campaign_id = k.id and a.customer_id = c.id), 0),
    'threshold_paise', k.threshold_paise,
    'tokens_left', greatest(0, k.token_limit - k.tokens_issued),
    'token', (select jsonb_build_object('id', t.id, 'code', t.code, 'status', t.status, 'issued_at', t.issued_at,
                                        'spend_at_issue_paise', t.spend_at_issue_paise, 'void_reason', t.void_reason)
                from public.lucky_draw_tokens t where t.campaign_id = k.id and t.customer_id = c.id),
    'frozen', c.is_frozen, 'frozen_reason', c.frozen_reason,
    'ledger', case when v_manager then coalesce((select jsonb_agg(jsonb_build_object(
                  'id', l.id, 'type', l.entry_type, 'spend_delta_paise', l.spend_delta_paise,
                  'spend_after_paise', l.spend_after_paise,
                  'order_number', (select order_number from public.orders where id = l.order_id),
                  'staff', (select name from public.staff where id = l.staff_id), 'reason', l.reason, 'at', l.created_at) order by l.id desc)
                from (select * from public.token_ledger where customer_id = c.id order by id desc limit 100) l), '[]') end,
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'order_number', o.order_number, 'status', o.status,
                                                              'total_paise', o.total_paise, 'paid_at', o.paid_at) order by o.paid_at desc)
                        from (select * from public.orders where customer_id = c.id and branch_id = ctx.branch_id and paid_at is not null
                              order by paid_at desc limit 20) o), '[]'),
    'flags', case when v_manager then coalesce((select jsonb_agg(jsonb_build_object('rule', f.rule, 'severity', f.severity, 'status', f.status, 'at', f.created_at)
                                                                 order by f.id desc)
                                                from public.fraud_flags f where f.customer_id = c.id), '[]') end);
end $$;

-- ----------------------------------------------------------------------------
-- Offers admin (Manager+; big coupons need the Owner, R2)
-- ----------------------------------------------------------------------------
create function app.coupon_is_big(k public.coupons, p_branch_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select k.usage_limit_total is null
      or (k.discount_type = 'percent' and k.value > app.setting_int(p_branch_id, 'coupon_owner_approval_above_bp', 3000))
$$;

create function public.upsert_coupon(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ctx      app.staff_context := app.require_role('owner', 'manager');
  v_id     uuid := nullif(p ->> 'id', '')::uuid;
  v_code   text := upper(btrim(coalesce(p ->> 'code', '')));
  v_active boolean := coalesce((p ->> 'is_active')::boolean, false);
  k        public.coupons;
  v_before public.coupons;
  v_req    uuid;
begin
  if v_code !~ '^[A-Z0-9]{3,20}$' then
    perform app.raise('VALIDATION_FAILED', 'Code: 3–20 letters or numbers, no spaces.', jsonb_build_object('fields', jsonb_build_object('code', 'invalid')));
  end if;
  if (p ->> 'discount_type') not in ('percent', 'flat') or coalesce((p ->> 'value')::int, 0) <= 0
     or ((p ->> 'discount_type') = 'percent' and (p ->> 'value')::int > 10000) then
    perform app.raise('VALIDATION_FAILED', 'Enter a discount: a percentage up to 100%, or an amount.', jsonb_build_object('fields', jsonb_build_object('value', 'invalid')));
  end if;
  if v_id is not null then
    select * into v_before from public.coupons where id = v_id and branch_id = ctx.branch_id for update;
    if v_before.id is null then perform app.raise('NOT_FOUND', 'Coupon not found.'); end if;
  end if;
  begin
    insert into public.coupons (id, branch_id, code, description, discount_type, value, min_order_paise, max_discount_paise, starts_at, ends_at,
                                usage_limit_total, usage_limit_per_customer, is_active, created_by)
    values (coalesce(v_id, app.uuid_v7()), ctx.branch_id, v_code, nullif(btrim(p ->> 'description'), ''), (p ->> 'discount_type')::public.discount_type,
            (p ->> 'value')::int, (p ->> 'min_order_paise')::bigint, (p ->> 'max_discount_paise')::bigint,
            (p ->> 'starts_at')::timestamptz, (p ->> 'ends_at')::timestamptz,
            (p ->> 'usage_limit_total')::int, (p ->> 'usage_limit_per_customer')::int, false, ctx.staff_id)
    on conflict (id) do update set code = excluded.code, description = excluded.description, discount_type = excluded.discount_type,
      value = excluded.value, min_order_paise = excluded.min_order_paise, max_discount_paise = excluded.max_discount_paise,
      starts_at = excluded.starts_at, ends_at = excluded.ends_at, usage_limit_total = excluded.usage_limit_total,
      usage_limit_per_customer = excluded.usage_limit_per_customer, is_active = false
    returning * into k;
  exception when unique_violation then
    perform app.raise('VALIDATION_FAILED', 'Another coupon already uses that code.', jsonb_build_object('fields', jsonb_build_object('code', 'taken')));
  end;

  perform app.audit(case when v_before.id is null then 'coupon.created' else 'coupon.updated' end, 'coupon', k.id::text,
                    case when v_before.id is not null then to_jsonb(v_before) - 'used_count' - 'updated_at' end,
                    to_jsonb(k) - 'used_count' - 'updated_at', null);
  if v_active then
    return jsonb_build_object('id', k.id) || public.set_coupon_active(k.id, true);
  end if;
  return jsonb_build_object('id', k.id, 'status', 'saved');
end $$;

create function public.set_coupon_active(p_coupon_id uuid, p_active boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ctx   app.staff_context := app.require_role('owner', 'manager');
  k     public.coupons;
  v_req uuid;
begin
  select * into k from public.coupons where id = p_coupon_id and branch_id = ctx.branch_id for update;
  if k.id is null then perform app.raise('NOT_FOUND', 'Coupon not found.'); end if;
  if p_active and app.coupon_is_big(k, ctx.branch_id) then
    if ctx.role <> 'owner' then
      insert into public.approval_requests (branch_id, kind, payload, summary, requested_by)
      values (ctx.branch_id, 'coupon_high_value', jsonb_build_object('coupon_id', k.id, 'updated_at', k.updated_at),
              format('Switch on coupon %s (%s%s)', k.code,
                     case when k.discount_type = 'percent' then rtrim(rtrim(to_char(k.value / 100.0, 'FM999990.99'), '0'), '.') || '% off'
                          else '₹' || rtrim(rtrim(to_char(k.value / 100.0, 'FM99999990.99'), '0'), '.') || ' off' end,
                     case when k.usage_limit_total is null then ', no usage limit' else '' end),
              ctx.staff_id)
      returning id into v_req;
      return jsonb_build_object('status', 'needs_owner', 'approval_id', v_req);
    end if;
    perform app.require_recent_mfa();
  end if;
  update public.coupons set is_active = p_active where id = k.id;
  perform app.audit(case when p_active then 'coupon.activated' else 'coupon.deactivated' end, 'coupon', k.id::text,
                    jsonb_build_object('is_active', k.is_active), jsonb_build_object('is_active', p_active), null);
  return jsonb_build_object('status', case when p_active then 'active' else 'inactive' end);
end $$;

create function public.upsert_promotion(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ctx      app.staff_context := app.require_role('owner', 'manager');
  v_id     uuid := nullif(p ->> 'id', '')::uuid;
  v_kind   public.promotion_kind := (p ->> 'kind')::public.promotion_kind;
  v_active boolean := coalesce((p ->> 'is_active')::boolean, false);
  v_before public.promotions;
  pr       public.promotions;
  t        jsonb;
begin
  if v_kind = 'first_order' and v_active and coalesce((app.setting(ctx.branch_id, 'first_order_offer_requires_otp') #>> '{}')::boolean, true) then
    perform app.raise('INVALID_TRANSITION', 'The first-order offer stays off until SMS OTP is set up (it’s too easy to abuse without it).');
  end if;
  if length(btrim(coalesce(p ->> 'name', ''))) = 0 then
    perform app.raise('VALIDATION_FAILED', 'Give the offer a name.', jsonb_build_object('fields', jsonb_build_object('name', 'required')));
  end if;
  if (p ->> 'discount_type') not in ('percent', 'flat') or coalesce((p ->> 'value')::int, 0) <= 0
     or ((p ->> 'discount_type') = 'percent' and (p ->> 'value')::int > 10000) then
    perform app.raise('VALIDATION_FAILED', 'Enter a discount: a percentage up to 100%, or an amount.', jsonb_build_object('fields', jsonb_build_object('value', 'invalid')));
  end if;
  if v_kind = 'happy_hour' and (nullif(p ->> 'start_time', '') is null or nullif(p ->> 'end_time', '') is null) then
    perform app.raise('VALIDATION_FAILED', 'Set the happy-hour start and end times.', jsonb_build_object('fields', jsonb_build_object('time', 'required')));
  end if;
  if v_id is not null then
    select * into v_before from public.promotions where id = v_id and branch_id = ctx.branch_id for update;
    if v_before.id is null then perform app.raise('NOT_FOUND', 'Offer not found.'); end if;
  end if;
  insert into public.promotions (id, branch_id, kind, name, discount_type, value, max_discount_paise, min_order_paise, days_mask,
                                 start_time, end_time, starts_on, ends_on, is_active)
  values (coalesce(v_id, app.uuid_v7()), ctx.branch_id, v_kind, btrim(p ->> 'name'), (p ->> 'discount_type')::public.discount_type, (p ->> 'value')::int,
          (p ->> 'max_discount_paise')::bigint, (p ->> 'min_order_paise')::bigint, coalesce((p ->> 'days_mask')::smallint, 127),
          nullif(p ->> 'start_time', '')::time, nullif(p ->> 'end_time', '')::time, nullif(p ->> 'starts_on', '')::date, nullif(p ->> 'ends_on', '')::date,
          v_active)
  on conflict (id) do update set name = excluded.name, discount_type = excluded.discount_type, value = excluded.value,
    max_discount_paise = excluded.max_discount_paise, min_order_paise = excluded.min_order_paise, days_mask = excluded.days_mask,
    start_time = excluded.start_time, end_time = excluded.end_time, starts_on = excluded.starts_on, ends_on = excluded.ends_on,
    is_active = excluded.is_active
  returning * into pr;
  delete from public.promotion_targets where promotion_id = pr.id;
  for t in select * from jsonb_array_elements(coalesce(p -> 'category_ids', '[]')) loop
    insert into public.promotion_targets (promotion_id, category_id) values (pr.id, (t #>> '{}')::uuid);
  end loop;
  for t in select * from jsonb_array_elements(coalesce(p -> 'product_ids', '[]')) loop
    insert into public.promotion_targets (promotion_id, product_id) values (pr.id, (t #>> '{}')::uuid);
  end loop;
  perform app.bump_menu_version(ctx.branch_id);  -- happy hours are shown on the menu
  perform app.audit(case when v_before.id is null then 'promotion.created' else 'promotion.updated' end, 'promotion', pr.id::text,
                    case when v_before.id is not null then to_jsonb(v_before) end, to_jsonb(pr), null);
  return jsonb_build_object('id', pr.id);
end $$;

create function public.set_promotion_active(p_promotion_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager');
  pr  public.promotions;
begin
  select * into pr from public.promotions where id = p_promotion_id and branch_id = ctx.branch_id for update;
  if pr.id is null then perform app.raise('NOT_FOUND', 'Offer not found.'); end if;
  if pr.kind = 'first_order' and p_active and coalesce((app.setting(ctx.branch_id, 'first_order_offer_requires_otp') #>> '{}')::boolean, true) then
    perform app.raise('INVALID_TRANSITION', 'The first-order offer stays off until SMS OTP is set up (it’s too easy to abuse without it).');
  end if;
  update public.promotions set is_active = p_active where id = pr.id;
  perform app.bump_menu_version(ctx.branch_id);
  perform app.audit(case when p_active then 'promotion.activated' else 'promotion.deactivated' end, 'promotion', pr.id::text,
                    jsonb_build_object('is_active', pr.is_active), jsonb_build_object('is_active', p_active), null);
end $$;

-- Owner approvals now also cover big coupons and manual tokens over the cap.
create or replace function public.decide_approval(p_id uuid, p_approve boolean, p_note text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  ctx  app.staff_context := app.require_role('owner');
  r    public.approval_requests;
  v_current bigint;
  k    public.coupons;
begin
  perform app.require_recent_mfa();
  select * into r from public.approval_requests where id = p_id and branch_id = ctx.branch_id for update;
  if r.id is null then perform app.raise('NOT_FOUND', 'That request doesn’t exist.'); end if;
  if r.status <> 'pending' then perform app.raise('INVALID_TRANSITION', 'That request was already decided.'); end if;
  if r.requested_by = ctx.staff_id then perform app.raise('FORBIDDEN', 'You can’t approve your own request.'); end if;
  if r.expires_at <= now() then
    update public.approval_requests set status = 'expired' where id = r.id;
    return 'expired';
  end if;

  if p_approve and r.kind = 'price_drop_large' then
    select price_paise into v_current from public.product_variants
     where id = (r.payload ->> 'variant_id')::uuid and archived_at is null for update;
    if v_current is null or v_current <> (r.payload ->> 'old_price_paise')::bigint then
      update public.approval_requests set status = 'expired', decided_by = ctx.staff_id, decided_at = now(),
             decision_note = 'The price changed in the meantime.' where id = r.id;
      return 'expired';
    end if;
    update public.product_variants set price_paise = (r.payload ->> 'new_price_paise')::bigint where id = (r.payload ->> 'variant_id')::uuid;
    perform app.audit('product.price_changed', 'product_variant', r.payload ->> 'variant_id',
                      jsonb_build_object('price_paise', v_current), jsonb_build_object('price_paise', (r.payload ->> 'new_price_paise')::bigint),
                      format('Approved request %s', r.id));
    perform app.bump_menu_version(ctx.branch_id);
  elsif p_approve and r.kind = 'coupon_high_value' then
    -- The Owner approves exactly the coupon they were shown: any later edit voids the request.
    select * into k from public.coupons where id = (r.payload ->> 'coupon_id')::uuid for update;
    if k.id is null or k.updated_at <> (r.payload ->> 'updated_at')::timestamptz then
      update public.approval_requests set status = 'expired', decided_by = ctx.staff_id, decided_at = now(),
             decision_note = 'The coupon was edited in the meantime.' where id = r.id;
      return 'expired';
    end if;
    update public.coupons set is_active = true where id = k.id;
    perform app.audit('coupon.activated', 'coupon', k.id::text, null, jsonb_build_object('is_active', true), format('Approved request %s', r.id));
  elsif p_approve and r.kind = 'manual_loyalty_over_cap' then
    perform app.apply_manual_adjust((r.payload ->> 'customer_id')::uuid, ctx.branch_id,
                                    (r.payload ->> 'spend_delta')::bigint, r.payload ->> 'reason');
  end if;

  update public.approval_requests
     set status = case when p_approve then 'approved'::public.approval_status else 'declined'::public.approval_status end,
         decided_by = ctx.staff_id, decided_at = now(), decision_note = p_note
   where id = r.id;
  perform app.audit(case when p_approve then 'approval.approved' else 'approval.declined' end, 'approval_request', r.id::text,
                    null, jsonb_build_object('kind', r.kind, 'summary', r.summary), p_note);
  return case when p_approve then 'approved' else 'declined' end;
end $$;

-- ----------------------------------------------------------------------------
-- Board / alerts
-- ----------------------------------------------------------------------------
create or replace function public.staff_alerts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager', 'cashier', 'kitchen');
begin
  return jsonb_build_object(
    'refund_requests', case when ctx.role in ('owner', 'manager') then
        (select count(*) from public.refunds r join public.orders o on o.id = r.order_id
          where o.branch_id = ctx.branch_id and r.status = 'requested'
            and (ctx.role = 'owner' or not r.needs_owner)) end,
    'refund_failures', case when ctx.role in ('owner', 'manager') then
        (select count(*) from public.refunds r join public.orders o on o.id = r.order_id
          where o.branch_id = ctx.branch_id and r.status = 'failed') end,
    'held_orders', (select count(*) from public.orders where branch_id = ctx.branch_id and on_hold
                      and status in ('pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery')),
    'approvals', case when ctx.role = 'owner' then
        (select count(*) from public.approval_requests where branch_id = ctx.branch_id and status = 'pending') end,
    'fraud_flags', case when ctx.role in ('owner', 'manager') then
        (select count(*) from public.fraud_flags where branch_id = ctx.branch_id and status = 'open') end);
end $$;

-- ----------------------------------------------------------------------------
-- RLS & privileges
-- ----------------------------------------------------------------------------
alter table public.campaigns enable row level security;
alter table public.loyalty_accounts enable row level security;
alter table public.lucky_draw_tokens enable row level security;
alter table public.token_ledger enable row level security;
alter table public.coupons enable row level security;
alter table public.coupon_redemptions enable row level security;
alter table public.promotions enable row level security;
alter table public.promotion_targets enable row level security;

-- Loyalty accounts, tokens and the ledger are read through the functions above (mobile numbers
-- masked). The campaign itself is public to staff: it is only the rules of the draw.
create policy campaigns_read on public.campaigns for select to authenticated
  using (branch_id = (select app.current_branch_id()));
create policy coupons_read on public.coupons for select to authenticated
  using (branch_id = (select app.current_branch_id()) and (select app.current_role()) in ('owner', 'manager'));
create policy promotions_read on public.promotions for select to authenticated
  using (branch_id = (select app.current_branch_id()) and (select app.current_role()) in ('owner', 'manager'));
create policy promotion_targets_read on public.promotion_targets for select to authenticated
  using (exists (select 1 from public.promotions p where p.id = promotion_id));

revoke all on public.campaigns, public.loyalty_accounts, public.lucky_draw_tokens, public.token_ledger, public.coupons,
  public.coupon_redemptions, public.promotions, public.promotion_targets from anon, authenticated;
grant select on public.campaigns, public.coupons, public.promotions, public.promotion_targets to authenticated;
grant select (is_frozen, frozen_reason) on public.customers to authenticated;

revoke execute on function
  app.block_ledger_changes(), app.ledger_payload(public.token_ledger),
  app.ledger(uuid, uuid, public.ledger_entry, bigint, uuid, uuid, text), app.verify_ledger_chain(),
  app.setting_int(uuid, text, bigint), app.active_campaign(uuid), app.ensure_branch_settings(uuid),
  app.issue_lucky_draw_token(uuid, uuid, uuid), app.earn_loyalty(uuid), app.reverse_loyalty(uuid, uuid, bigint, uuid, text),
  app.release_order_holds(uuid), app.retake_order_holds(uuid), app.order_rewards(),
  app.take_coupon(uuid, uuid, uuid, bigint), app.promotion_json(public.promotions), app.active_promotions(uuid, public.promotion_kind),
  app.offer_context(uuid, text, text, text), app.confirm_free_order(uuid), app.order_rewards_public(text),
  app.manual_loyalty_today(uuid), app.apply_manual_adjust(uuid, uuid, bigint, text),
  app.coupon_is_big(public.coupons, uuid),
  public.lucky_draw_overview(), public.lucky_draw_tokens_list(text, int), public.loyalty_leaderboard(int),
  public.verify_token(text), public.void_lucky_draw_token(uuid, text),
  public.adjust_loyalty(uuid, bigint, text), public.set_customer_frozen(uuid, boolean, text), public.customer_search(text),
  public.customer_detail(uuid), public.upsert_coupon(jsonb), public.set_coupon_active(uuid, boolean), public.upsert_promotion(jsonb),
  public.set_promotion_active(uuid, boolean)
  from public, anon, authenticated;
grant execute on function
  public.lucky_draw_overview(), public.lucky_draw_tokens_list(text, int), public.loyalty_leaderboard(int),
  public.verify_token(text), public.void_lucky_draw_token(uuid, text),
  public.adjust_loyalty(uuid, bigint, text), public.set_customer_frozen(uuid, boolean, text), public.customer_search(text),
  public.customer_detail(uuid), public.upsert_coupon(jsonb), public.set_coupon_active(uuid, boolean), public.upsert_promotion(jsonb),
  public.set_promotion_active(uuid, boolean)
  to authenticated;
grant execute on function
  app.offer_context(uuid, text, text, text), app.active_promotions(uuid, public.promotion_kind), app.confirm_free_order(uuid),
  app.order_rewards_public(text), app.verify_ledger_chain()
  to service_role;
