-- ============================================================================
-- M6 Reports, dashboard, risk & reconciliation.
--   * Owner/Manager reports (sales, products, categories, hours, payments, tokens, customers)
--   * Today's dashboard figures
--   * Risk: blocked identities, chargebacks/disputes, the pattern fraud rules, flag review
--   * Reconciliation against Razorpay, and nightly housekeeping
-- Design: docs/PHASE-4-DATABASE.md §5, Revision 2 §9–§10; docs/PHASE-6-UI-UX.md A2/A12/A13;
-- docs/PHASE-7-API.md §6.4, §8.
-- ============================================================================

alter table public.payments add column disputed_at timestamptz;

-- ----------------------------------------------------------------------------
-- Blocked identities (Revision 2 §9.1): stops a known abuser by hash, never by raw value.
-- ----------------------------------------------------------------------------
create type public.identity_kind as enum ('mobile', 'vpa', 'device');
create type public.block_scope as enum ('all', 'offers', 'tokens');

create table public.blocked_identities (
  id          uuid primary key default app.uuid_v7(),
  branch_id   uuid not null references public.branches (id),
  kind        public.identity_kind not null,
  value_hash  text not null,
  masked      text,                                   -- e.g. "98xxxxx678" or "ra***@okicici", for the screen
  scope       public.block_scope not null default 'all',
  reason      text not null check (length(btrim(reason)) between 3 and 300),
  blocked_by  uuid references public.staff (id),
  expires_at  timestamptz,
  created_at  timestamptz not null default now(),
  unique (kind, value_hash)
);
create index blocked_identities_live_idx on public.blocked_identities (kind, value_hash) where expires_at is null;

-- Mobiles are hashed inside the database (the Edge hashes device ids and UPI ids with its pepper).
create function app.hash_mobile(p_mobile text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest('mobile:' || coalesce(p_mobile, ''), 'sha256'), 'hex')
$$;

/** The strictest live block for these identities, or null. */
create function app.block_scope_for(p_mobile text, p_device_hash text, p_vpa_hash text) returns public.block_scope
language sql stable security definer set search_path = '' as $$
  select scope from public.blocked_identities
   where (expires_at is null or expires_at > now())
     and ((kind = 'mobile' and p_mobile is not null and value_hash = app.hash_mobile(p_mobile))
       or (kind = 'device' and p_device_hash is not null and value_hash = p_device_hash)
       or (kind = 'vpa' and p_vpa_hash is not null and value_hash = p_vpa_hash))
   order by case scope when 'all' then 0 when 'tokens' then 1 else 2 end
   limit 1
$$;

create function public.block_identity(p_order_id uuid, p_kind public.identity_kind, p_scope public.block_scope, p_reason text, p_days int default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ctx     app.staff_context := app.require_role('owner', 'manager');
  o       public.orders;
  p       public.payments;
  v_hash  text;
  v_mask  text;
  v_id    uuid;
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    perform app.raise('VALIDATION_FAILED', 'Give a reason (at least 3 characters).', jsonb_build_object('fields', jsonb_build_object('reason', 'required')));
  end if;
  select * into o from public.orders where id = p_order_id and branch_id = ctx.branch_id;
  if o.id is null then perform app.raise('NOT_FOUND', 'Order not found.'); end if;
  if p_kind = 'mobile' then
    v_hash := app.hash_mobile(o.customer_mobile);
    v_mask := app.mask_mobile(o.customer_mobile);
  elsif p_kind = 'device' then
    v_hash := o.device_id_hash;
    v_mask := 'device ' || right(coalesce(o.device_id_hash, ''), 6);
  else
    select * into p from public.payments where order_id = o.id and not is_duplicate and payer_vpa_hash is not null order by created_at desc limit 1;
    v_hash := p.payer_vpa_hash;
    v_mask := p.payer_vpa_masked;
  end if;
  if v_hash is null then
    perform app.raise('VALIDATION_FAILED', 'That order doesn’t have this kind of identity to block.');
  end if;

  insert into public.blocked_identities (branch_id, kind, value_hash, masked, scope, reason, blocked_by, expires_at)
  values (ctx.branch_id, p_kind, v_hash, v_mask, p_scope, btrim(p_reason), ctx.staff_id,
          case when p_days is not null then now() + make_interval(days => p_days) end)
  on conflict (kind, value_hash) do update
    set scope = excluded.scope, reason = excluded.reason, blocked_by = excluded.blocked_by, expires_at = excluded.expires_at
  returning id into v_id;
  perform app.audit('risk.block_identity', 'blocked_identity', v_id::text, null,
                    jsonb_build_object('kind', p_kind, 'scope', p_scope, 'masked', v_mask, 'order_id', o.id), p_reason);
  return jsonb_build_object('id', v_id, 'masked', v_mask);
end $$;

create function public.unblock_identity(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager');
  b   public.blocked_identities;
begin
  select * into b from public.blocked_identities where id = p_id and branch_id = ctx.branch_id;
  if b.id is null then perform app.raise('NOT_FOUND', 'That block doesn’t exist.'); end if;
  delete from public.blocked_identities where id = b.id;
  perform app.audit('risk.unblock_identity', 'blocked_identity', b.id::text,
                    jsonb_build_object('kind', b.kind, 'scope', b.scope, 'masked', b.masked), null, p_reason);
end $$;

-- ----------------------------------------------------------------------------
-- Offers/tokens/ordering now respect blocks.
-- ----------------------------------------------------------------------------
create or replace function app.offer_context(p_branch_id uuid, p_mobile text, p_coupon_code text, p_device_hash text) returns jsonb
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
  v_block  public.block_scope := app.block_scope_for(nullif(p_mobile, ''), p_device_hash, null);
begin
  if p_mobile is not null and p_mobile <> '' then
    select * into c from public.customers where mobile = p_mobile;
  end if;
  if v_block = 'all' then
    v_offers := false;
  end if;
  select * into cmp from app.active_campaign(p_branch_id);
  if c.id is not null and cmp.id is not null then
    select coalesce(a.spend_paise, 0) into v_spend from public.loyalty_accounts a
     where a.campaign_id = cmp.id and a.customer_id = c.id;
  end if;

  if nullif(btrim(coalesce(p_coupon_code, '')), '') is not null then
    select * into k from public.coupons where branch_id = p_branch_id and code::text = upper(btrim(p_coupon_code));
    v_status := case
      when not v_offers or v_block in ('all', 'offers') or k.id is null or not k.is_active then 'invalid'
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
  v_eligible := v_offers and v_block is null and v_first is not null
    and not coalesce((s ->> 'first_order_offer_requires_otp')::boolean, true)
    and coalesce(c.order_count, 0) = 0
    and not exists (select 1 from public.orders o where o.device_id_hash = p_device_hash and o.paid_at is not null);

  return jsonb_build_object(
    'offers_enabled', v_offers,
    'blocked', v_block,
    'happy_hours', case when v_block = 'all' then '[]'::jsonb else app.active_promotions(p_branch_id, 'happy_hour') end,
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
                      'earning', v_block not in ('all', 'offers') and not coalesce(c.is_frozen, false),
                      'frozen', coalesce(c.is_frozen, false)) end);
end $$;

-- ----------------------------------------------------------------------------
-- Chargebacks / disputes (C13, R6)
-- ----------------------------------------------------------------------------
create function app.apply_dispute(p_payment_id text, p_dispute_id text, p_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p public.payments;
  o public.orders;
  v_earned bigint;
  v_campaign uuid;
begin
  select * into p from public.payments where provider_payment_id = p_payment_id for update;
  if p.id is null then return jsonb_build_object('ok', false, 'code', 'UNKNOWN_PAYMENT'); end if;
  select * into o from public.orders where id = p.order_id for update;

  if p_status = 'created' then
    if p.status = 'disputed' then return jsonb_build_object('ok', true, 'replay', true); end if;
    update public.payments set status = 'disputed', dispute_id = p_dispute_id, disputed_at = now() where id = p.id;
    update public.orders set on_hold = true, hold_reason = 'The customer’s bank opened a dispute for this payment' where id = o.id;
    -- Freeze the customer and take back what this order earned (they can still order).
    update public.customers set is_frozen = true, frozen_reason = 'Payment dispute on ' || coalesce(o.order_number, 'an order') where id = o.customer_id;
    select l.campaign_id, sum(l.spend_delta_paise) into v_campaign, v_earned from public.token_ledger l
     where l.order_id = o.id and l.entry_type in ('loyalty_earned', 'loyalty_reversed') group by l.campaign_id;
    if coalesce(v_earned, 0) > 0 then
      perform app.reverse_loyalty(v_campaign, o.customer_id, v_earned, o.id, 'Payment dispute ' || p_dispute_id);
    end if;
    perform app.flag('DISPUTE_OPENED', 'block', o.id, jsonb_build_object('dispute_id', p_dispute_id, 'amount_paise', p.amount_paise));
  else
    update public.payments set dispute_id = p_dispute_id where id = p.id;
    perform app.flag('DISPUTE_' || upper(p_status), 'warn', o.id, jsonb_build_object('dispute_id', p_dispute_id));
  end if;
  return jsonb_build_object('ok', true, 'order_id', o.id, 'status', p_status);
end $$;

-- ----------------------------------------------------------------------------
-- Reconciliation against Razorpay (P1, S6)
-- ----------------------------------------------------------------------------
create table public.reconciliation_runs (
  id                        uuid primary key default app.uuid_v7(),
  branch_id                 uuid not null references public.branches (id),
  window_start              timestamptz not null,
  window_end                timestamptz not null,
  provider_captured_count   int not null default 0,
  provider_captured_paise   bigint not null default 0,
  db_paid_count             int not null default 0,
  db_paid_paise             bigint not null default 0,
  fixed_count               int not null default 0,
  mismatches                jsonb not null default '[]',
  status                    text not null check (status in ('ok', 'fixed', 'needs_review')),
  created_at                timestamptz not null default now()
);
create index reconciliation_runs_idx on public.reconciliation_runs (branch_id, created_at desc);

/**
 * Compare what Razorpay captured in a window with what this database recorded.
 * `p` = { branch_id, window_start, window_end, fixed_count,
 *         payments: [{ id, amount, status, order_id }] } (already-repaired ones counted in fixed_count).
 */
create function app.reconcile(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_branch  uuid := (p ->> 'branch_id')::uuid;
  v_from    timestamptz := (p ->> 'window_start')::timestamptz;
  v_to      timestamptz := (p ->> 'window_end')::timestamptz;
  v_fixed   int := coalesce((p ->> 'fixed_count')::int, 0);
  v_mis     jsonb := '[]';
  v_run     public.reconciliation_runs;
  r         record;
begin
  create temporary table if not exists provider_payments (id text primary key, amount bigint, status text) on commit drop;
  delete from provider_payments;
  insert into provider_payments (id, amount, status)
  select e ->> 'id', (e ->> 'amount')::bigint, e ->> 'status'
    from jsonb_array_elements(coalesce(p -> 'payments', '[]')) e
   where e ->> 'status' = 'captured'
  on conflict (id) do nothing;

  -- Captured at Razorpay but missing (or different) here.
  for r in
    select pp.id, pp.amount, pay.amount_paise, pay.id as payment_row
      from provider_payments pp
      left join public.payments pay on pay.provider_payment_id = pp.id
  loop
    if r.payment_row is null then
      v_mis := v_mis || jsonb_build_object('kind', 'missing_in_db', 'payment_id', r.id, 'amount_paise', r.amount);
    elsif r.amount <> r.amount_paise then
      v_mis := v_mis || jsonb_build_object('kind', 'amount_differs', 'payment_id', r.id, 'provider_paise', r.amount, 'db_paise', r.amount_paise);
    end if;
  end loop;

  -- Recorded here as successful but not in the provider's list for the window.
  for r in
    select pay.provider_payment_id, pay.amount_paise
      from public.payments pay
      join public.orders o on o.id = pay.order_id
     where o.branch_id = v_branch and pay.captured_at >= v_from and pay.captured_at < v_to
       and pay.status in ('successful', 'partially_refunded', 'refunded', 'disputed')
       and not exists (select 1 from provider_payments pp where pp.id = pay.provider_payment_id)
  loop
    v_mis := v_mis || jsonb_build_object('kind', 'missing_at_provider', 'payment_id', r.provider_payment_id, 'amount_paise', r.amount_paise);
  end loop;

  insert into public.reconciliation_runs (branch_id, window_start, window_end, provider_captured_count, provider_captured_paise,
                                          db_paid_count, db_paid_paise, fixed_count, mismatches, status)
  select v_branch, v_from, v_to,
         (select count(*) from provider_payments), (select coalesce(sum(amount), 0) from provider_payments),
         (select count(*) from public.payments pay join public.orders o on o.id = pay.order_id
           where o.branch_id = v_branch and pay.captured_at >= v_from and pay.captured_at < v_to
             and pay.status in ('successful', 'partially_refunded', 'refunded', 'disputed')),
         (select coalesce(sum(pay.amount_paise), 0) from public.payments pay join public.orders o on o.id = pay.order_id
           where o.branch_id = v_branch and pay.captured_at >= v_from and pay.captured_at < v_to
             and pay.status in ('successful', 'partially_refunded', 'refunded', 'disputed')),
         v_fixed, v_mis,
         case when jsonb_array_length(v_mis) > 0 then 'needs_review' when v_fixed > 0 then 'fixed' else 'ok' end
  returning * into v_run;

  if jsonb_array_length(v_mis) > 0 then
    insert into public.fraud_flags (branch_id, rule, severity, details)
    values (v_branch, 'RECON_MISMATCH', 'warn', jsonb_build_object('run_id', v_run.id, 'mismatches', v_mis));
  end if;
  return jsonb_build_object('id', v_run.id, 'status', v_run.status, 'mismatches', jsonb_array_length(v_mis), 'fixed', v_fixed);
end $$;

-- ----------------------------------------------------------------------------
-- Pattern fraud rules (Revision 2 §10), run every 10 minutes by a job.
-- ----------------------------------------------------------------------------
create function app.flag_once(p_branch_id uuid, p_rule text, p_severity public.flag_severity, p_key text, p_details jsonb,
                              p_window interval default interval '7 days', p_customer uuid default null, p_staff uuid default null,
                              p_order uuid default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.fraud_flags
              where rule = p_rule and details ->> 'key' = p_key and created_at > now() - p_window) then
    return false;
  end if;
  insert into public.fraud_flags (branch_id, rule, severity, customer_id, staff_id, order_id, details)
  values (p_branch_id, p_rule, p_severity, p_customer, p_staff, p_order, p_details || jsonb_build_object('key', p_key));
  return true;
end $$;

create function app.run_fraud_rules() returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int := 0;
  r record;
begin
  -- One device, many mobiles, all building up loyalty spend (MULTI_MOBILE_DEVICE).
  for r in
    select o.branch_id, o.device_id_hash, count(distinct o.customer_id) as mobiles
      from public.orders o
     where o.paid_at > now() - interval '7 days' and o.device_id_hash is not null
     group by o.branch_id, o.device_id_hash
    having count(distinct o.customer_id) > 3
  loop
    if exists (select 1 from public.orders o2 join public.token_ledger l on l.customer_id = o2.customer_id
                where o2.device_id_hash = r.device_id_hash and l.created_at > now() - interval '7 days') then
      if app.flag_once(r.branch_id, 'MULTI_MOBILE_DEVICE', 'warn', r.device_id_hash,
                       jsonb_build_object('mobiles', r.mobiles, 'device', right(r.device_id_hash, 6))) then n := n + 1; end if;
    end if;
  end loop;

  -- One UPI ID paying for many mobiles that earn loyalty spend (MULTI_MOBILE_VPA).
  for r in
    select o.branch_id, pay.payer_vpa_hash, min(pay.payer_vpa_masked) as masked, count(distinct o.customer_id) as mobiles
      from public.payments pay join public.orders o on o.id = pay.order_id
     where pay.captured_at > now() - interval '30 days' and pay.payer_vpa_hash is not null
     group by o.branch_id, pay.payer_vpa_hash
    having count(distinct o.customer_id) > 3
  loop
    if app.flag_once(r.branch_id, 'MULTI_MOBILE_VPA', 'warn', r.payer_vpa_hash,
                     jsonb_build_object('mobiles', r.mobiles, 'vpa', r.masked), interval '30 days') then n := n + 1; end if;
  end loop;

  -- A Lucky Draw token was just earned on an order paid from a UPI ID that mobile had never
  -- used before: worth a glance, because it is how one person farms tokens across numbers.
  for r in
    select o.branch_id, o.id, o.customer_id, pay.payer_vpa_hash, pay.payer_vpa_masked, t.code
      from public.lucky_draw_tokens t
      join public.orders o on o.id = t.trigger_order_id
      join public.payments pay on pay.order_id = o.id and not pay.is_duplicate
     where t.issued_at > now() - interval '2 days' and pay.payer_vpa_hash is not null
  loop
    if not exists (
      select 1 from public.payments p2 join public.orders o2 on o2.id = p2.order_id
       where o2.customer_id = r.customer_id and o2.id <> r.id and p2.payer_vpa_hash = r.payer_vpa_hash and p2.captured_at < now() - interval '1 minute')
    then
      if app.flag_once(r.branch_id, 'TOKEN_EARNED_NEW_VPA', 'info', r.id::text,
                       jsonb_build_object('vpa', r.payer_vpa_masked, 'token', r.code), interval '30 days', r.customer_id, null, r.id) then n := n + 1; end if;
    end if;
  end loop;

  -- A price changed and was put back within 24 h with orders in between (PRICE_FLIP).
  for r in
    select a.branch_id, a.entity_id, count(*) as changes
      from public.audit_logs a
     where a.action = 'product.price_changed' and a.created_at > now() - interval '24 hours'
     group by a.branch_id, a.entity_id
    having count(*) > 1
  loop
    if (select (first_value(a.before -> 'price_paise') over w) = (last_value(a.after -> 'price_paise') over w)
          from public.audit_logs a
         where a.action = 'product.price_changed' and a.entity_id = r.entity_id and a.created_at > now() - interval '24 hours'
        window w as (order by a.id rows between unbounded preceding and unbounded following)
         limit 1)
    then
      if app.flag_once(r.branch_id, 'PRICE_FLIP', 'warn', r.entity_id,
                       jsonb_build_object('variant_id', r.entity_id, 'changes', r.changes), interval '24 hours') then n := n + 1; end if;
    end if;
  end loop;
  return n;
end $$;

create function public.review_fraud_flag(p_flag_id bigint, p_outcome text, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager');
  f   public.fraud_flags;
begin
  if p_outcome not in ('cleared', 'confirmed') then perform app.raise('VALIDATION_FAILED', 'Choose cleared or confirmed.'); end if;
  select * into f from public.fraud_flags where id = p_flag_id and branch_id = ctx.branch_id for update;
  if f.id is null then perform app.raise('NOT_FOUND', 'That flag doesn’t exist.'); end if;
  if f.status <> 'open' then perform app.raise('INVALID_TRANSITION', 'That flag was already reviewed.'); end if;
  -- The person a flag is about can't clear their own flag (Revision 2 §9.1).
  if f.staff_id is not null and f.staff_id = ctx.staff_id then
    perform app.raise('FORBIDDEN', 'Someone else has to review a flag about you.');
  end if;
  update public.fraud_flags set status = p_outcome::public.flag_status, reviewed_by = ctx.staff_id, reviewed_at = now(),
         review_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = f.id;
  perform app.audit('risk.review_flag', 'fraud_flag', f.id::text, jsonb_build_object('rule', f.rule), jsonb_build_object('outcome', p_outcome), p_note);
end $$;

-- ----------------------------------------------------------------------------
-- Risk screen (A12)
-- ----------------------------------------------------------------------------
create function public.risk_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  ctx     app.staff_context := app.require_role('owner', 'manager');
  v_owner boolean := ctx.role = 'owner';
begin
  return jsonb_build_object(
    'flags', coalesce((select jsonb_agg(jsonb_build_object(
                'id', f.id, 'rule', f.rule, 'severity', f.severity, 'status', f.status, 'details', f.details,
                'created_at', f.created_at, 'order_id', f.order_id, 'order_number', (select order_number from public.orders where id = f.order_id),
                'customer_id', f.customer_id, 'customer', (select name from public.customers where id = f.customer_id),
                'staff', (select name from public.staff where id = f.staff_id),
                'reviewed_by', (select name from public.staff where id = f.reviewed_by), 'reviewed_at', f.reviewed_at, 'review_note', f.review_note)
                order by f.id desc)
              from (select * from public.fraud_flags where branch_id = ctx.branch_id order by id desc limit 100) f), '[]'),
    'open_count', (select count(*) from public.fraud_flags where branch_id = ctx.branch_id and status = 'open'),
    'blocked', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'kind', b.kind, 'masked', b.masked, 'scope', b.scope,
                                                             'reason', b.reason, 'expires_at', b.expires_at, 'created_at', b.created_at,
                                                             'by', (select name from public.staff where id = b.blocked_by))
                                          order by b.created_at desc)
                         from public.blocked_identities b where b.branch_id = ctx.branch_id), '[]'),
    'approvals', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'summary', a.summary, 'created_at', a.created_at,
                                                               'requested_by', (select name from public.staff where id = a.requested_by))
                                            order by a.created_at)
                           from public.approval_requests a where a.branch_id = ctx.branch_id and a.status = 'pending'), '[]'),
    'reconciliation', (select jsonb_build_object('at', r.created_at, 'status', r.status, 'window_start', r.window_start, 'window_end', r.window_end,
                                                 'provider_count', r.provider_captured_count, 'db_count', r.db_paid_count,
                                                 'provider_paise', r.provider_captured_paise, 'db_paise', r.db_paid_paise,
                                                 'mismatches', r.mismatches, 'fixed', r.fixed_count)
                        from public.reconciliation_runs r where r.branch_id = ctx.branch_id order by r.created_at desc limit 1),
    'chains', case when v_owner then jsonb_build_object('audit_ok', app.verify_audit_chain() is null, 'ledger_ok', app.verify_ledger_chain() is null) end,
    'disputes', (select count(*) from public.payments p join public.orders o on o.id = p.order_id
                  where o.branch_id = ctx.branch_id and p.status = 'disputed'));
end $$;

-- ----------------------------------------------------------------------------
-- Reports (Manager+). Every amount is in paise; the app formats them.
-- ----------------------------------------------------------------------------
create function app.report_range(p jsonb, out branch_id uuid, out from_ts timestamptz, out to_ts timestamptz)
language plpgsql stable set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager');
begin
  branch_id := ctx.branch_id;
  from_ts := (coalesce((p ->> 'from')::date, (now() at time zone 'Asia/Kolkata')::date))::timestamp at time zone 'Asia/Kolkata';
  to_ts := (coalesce((p ->> 'to')::date, (now() at time zone 'Asia/Kolkata')::date) + 1)::timestamp at time zone 'Asia/Kolkata';
  if to_ts - from_ts > interval '400 days' then
    perform app.raise('VALIDATION_FAILED', 'Pick a period of up to a year.');
  end if;
end $$;

/** Orders that count as sales: paid and not rejected/cancelled/expired. */
create function app.sold_orders(p_branch uuid, p_from timestamptz, p_to timestamptz)
returns table (id uuid, paid_at timestamptz, total_paise bigint, subtotal_paise bigint, discount_paise bigint,
               delivery_fee_paise bigint, tax_paise bigint, customer_id uuid, order_type public.order_type, refunded_paise bigint)
language sql stable security definer set search_path = '' as $$
  select o.id, o.paid_at, o.total_paise, o.subtotal_paise,
         o.promo_discount_paise + o.order_discount_paise, o.delivery_fee_paise, o.tax_paise,
         o.customer_id, o.order_type,
         coalesce((select sum(pay.refunded_paise) from public.payments pay where pay.order_id = o.id and not pay.is_duplicate), 0)
  from public.orders o
  where o.branch_id = p_branch and o.paid_at >= p_from and o.paid_at < p_to
    and o.status not in ('awaiting_payment', 'payment_expired', 'rejected', 'cancelled')
$$;

create function public.report_sales(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r        record := app.report_range(p);
  v_grain  text := coalesce(p ->> 'grain', 'day');
begin
  if v_grain not in ('day', 'hour', 'month') then perform app.raise('VALIDATION_FAILED', 'Group by day, hour or month.'); end if;
  return (select jsonb_build_object(
    'rows', coalesce(jsonb_agg(jsonb_build_object('bucket', bucket, 'orders', orders, 'gross_paise', gross, 'discount_paise', discounts,
                                                  'refund_paise', refunds, 'net_paise', gross - refunds, 'avg_paise', case when orders > 0 then round(gross::numeric / orders)::bigint else 0 end)
                               order by bucket), '[]'),
    'total', jsonb_build_object('orders', coalesce(sum(orders), 0), 'gross_paise', coalesce(sum(gross), 0), 'discount_paise', coalesce(sum(discounts), 0),
                                'refund_paise', coalesce(sum(refunds), 0), 'net_paise', coalesce(sum(gross) - sum(refunds), 0)))
    from (
      select to_char(date_trunc(v_grain, s.paid_at at time zone 'Asia/Kolkata'), case v_grain when 'hour' then 'YYYY-MM-DD HH24:00' when 'month' then 'YYYY-MM' else 'YYYY-MM-DD' end) as bucket,
             count(*) as orders, sum(s.total_paise) as gross, sum(s.discount_paise) as discounts, sum(s.refunded_paise) as refunds
        from app.sold_orders(r.branch_id, r.from_ts, r.to_ts) s
       group by 1) t);
end $$;

create function public.report_products(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r record := app.report_range(p);
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'variant', variant, 'qty', qty, 'refunded_qty', refunded,
                                                       'gross_paise', gross)
                                    order by gross desc), '[]')
    from (
      select i.product_name as name, i.variant_name as variant, sum(i.qty)::int as qty, sum(i.refunded_qty)::int as refunded,
             sum(i.line_total_paise - i.promo_discount_paise * i.qty) as gross
        from public.order_items i join app.sold_orders(r.branch_id, r.from_ts, r.to_ts) s on s.id = i.order_id
       group by 1, 2) t);
end $$;

create function public.report_categories(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r record := app.report_range(p);
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'qty', qty, 'gross_paise', gross) order by gross desc), '[]')
    from (
      select coalesce(c.name, 'Removed items') as name, sum(i.qty)::int as qty, sum(i.line_total_paise) as gross
        from public.order_items i
        join app.sold_orders(r.branch_id, r.from_ts, r.to_ts) s on s.id = i.order_id
        left join public.products pr on pr.id = i.product_id
        left join public.categories c on c.id = pr.category_id
       group by 1) t);
end $$;

create function public.report_hours(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r record := app.report_range(p);
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('hour', hour, 'orders', orders, 'gross_paise', gross) order by hour), '[]')
    from (
      select extract(hour from s.paid_at at time zone 'Asia/Kolkata')::int as hour, count(*) as orders, sum(s.total_paise) as gross
        from app.sold_orders(r.branch_id, r.from_ts, r.to_ts) s
       group by 1) t);
end $$;

create function public.report_payments(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r record := app.report_range(p);
begin
  return jsonb_build_object(
    'methods', coalesce((select jsonb_agg(jsonb_build_object('method', method, 'count', n, 'amount_paise', amount, 'refunded_paise', refunded) order by amount desc)
                         from (select coalesce(pay.method, 'other') as method, count(*) as n, sum(pay.amount_paise) as amount, sum(pay.refunded_paise) as refunded
                                 from public.payments pay join public.orders o on o.id = pay.order_id
                                where o.branch_id = r.branch_id and pay.captured_at >= r.from_ts and pay.captured_at < r.to_ts
                                  and pay.status <> 'failed' and not pay.is_duplicate
                                group by 1) m), '[]'),
    'failed', (select count(*) from public.payments pay join public.orders o on o.id = pay.order_id
                where o.branch_id = r.branch_id and pay.status = 'failed' and pay.created_at >= r.from_ts and pay.created_at < r.to_ts),
    'duplicates', (select count(*) from public.payments pay join public.orders o on o.id = pay.order_id
                    where o.branch_id = r.branch_id and pay.is_duplicate and pay.created_at >= r.from_ts and pay.created_at < r.to_ts),
    'disputed', (select count(*) from public.payments pay join public.orders o on o.id = pay.order_id
                  where o.branch_id = r.branch_id and pay.status = 'disputed'),
    'refunds', coalesce((select jsonb_agg(jsonb_build_object('status', status, 'count', n, 'amount_paise', amount) order by status)
                         from (select rf.status::text, count(*) as n, sum(rf.amount_paise) as amount
                                 from public.refunds rf join public.orders o on o.id = rf.order_id
                                where o.branch_id = r.branch_id and rf.created_at >= r.from_ts and rf.created_at < r.to_ts
                                group by 1) f), '[]'));
end $$;

-- The Lucky Draw, for the Reports screen: where the 500 tokens have gone.
create function public.report_tokens(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r record := app.report_range(p);
  k public.campaigns;
begin
  select * into k from public.campaigns where branch_id = r.branch_id and is_active limit 1;
  if k.id is null then return jsonb_build_object('running', false); end if;
  return jsonb_build_object(
    'running', true,
    'campaign', k.name,
    'threshold_paise', k.threshold_paise,
    'token_limit', k.token_limit,
    'tokens_issued', k.tokens_issued,
    'tokens_left', greatest(0, k.token_limit - k.tokens_issued),
    'issued_in_range', (select count(*) from public.lucky_draw_tokens t
                         where t.campaign_id = k.id and t.issued_at >= r.from_ts and t.issued_at < r.to_ts),
    'voided', (select count(*) from public.lucky_draw_tokens t where t.campaign_id = k.id and t.status = 'void'),
    'loyalty_customers', (select count(*) from public.loyalty_accounts a where a.campaign_id = k.id and a.spend_paise > 0),
    'loyalty_spend_paise', (select coalesce(sum(a.spend_paise), 0) from public.loyalty_accounts a where a.campaign_id = k.id),
    'earned_in_range_paise', (select coalesce(sum(l.spend_delta_paise), 0) from public.token_ledger l
                               where l.campaign_id = k.id and l.created_at >= r.from_ts and l.created_at < r.to_ts
                                 and l.entry_type = 'loyalty_earned'),
    'close_to_token', (select count(*) from public.loyalty_accounts a
                        where a.campaign_id = k.id and a.spend_paise < k.threshold_paise
                          and a.spend_paise >= k.threshold_paise / 2),
    -- Where each ₹100 of loyalty spend sits, for the bar chart.
    'bands', (select coalesce(jsonb_agg(jsonb_build_object('label', band, 'customers', n) order by lo), '[]') from (
                select case when a.spend_paise >= k.threshold_paise then 'Token earned'
                            when a.spend_paise >= k.threshold_paise / 2 then 'Half way or more'
                            when a.spend_paise >= k.threshold_paise / 4 then 'A quarter of the way'
                            else 'Just started' end as band,
                       case when a.spend_paise >= k.threshold_paise then 4
                            when a.spend_paise >= k.threshold_paise / 2 then 3
                            when a.spend_paise >= k.threshold_paise / 4 then 2 else 1 end as lo,
                       count(*) as n
                  from public.loyalty_accounts a where a.campaign_id = k.id and a.spend_paise > 0
                 group by 1, 2) bands));
end $$;

create function public.report_customers(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r record := app.report_range(p);
begin
  return jsonb_build_object(
    'new', (select count(*) from public.customers c where c.first_order_at >= r.from_ts and c.first_order_at < r.to_ts),
    'ordering', (select count(distinct s.customer_id) from app.sold_orders(r.branch_id, r.from_ts, r.to_ts) s),
    'repeat', (select count(*) from (select s.customer_id from app.sold_orders(r.branch_id, r.from_ts, r.to_ts) s
                                      group by s.customer_id having count(*) > 1) t),
    'by_type', coalesce((select jsonb_agg(jsonb_build_object('order_type', order_type, 'orders', n, 'gross_paise', gross) order by n desc)
                         from (select s.order_type::text, count(*) as n, sum(s.total_paise) as gross
                                 from app.sold_orders(r.branch_id, r.from_ts, r.to_ts) s group by 1) t), '[]'),
    'top', coalesce((select jsonb_agg(jsonb_build_object('customer_id', id, 'name', name, 'mobile_masked', masked, 'orders', n, 'spent_paise', spent)
                                      order by spent desc)
                     from (select c.id, c.name, app.mask_mobile(c.mobile) as masked, count(*) as n, sum(s.total_paise) as spent
                             from app.sold_orders(r.branch_id, r.from_ts, r.to_ts) s join public.customers c on c.id = s.customer_id
                            group by 1, 2, 3 order by sum(s.total_paise) desc limit 10) t), '[]'));
end $$;

-- A2: the dashboard's "today" figures, in one call.
create function public.dashboard_today() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  ctx        app.staff_context := app.require_role('owner', 'manager');
  v_today    timestamptz := date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  v_yesterday timestamptz := v_today - interval '1 day';
  v_today_p  jsonb := jsonb_build_object('from', (v_today at time zone 'Asia/Kolkata')::date);
begin
  return jsonb_build_object(
    'today', (select jsonb_build_object('orders', count(*), 'gross_paise', coalesce(sum(s.total_paise), 0),
                                        'refund_paise', coalesce(sum(s.refunded_paise), 0),
                                        'avg_paise', case when count(*) > 0 then round(sum(s.total_paise)::numeric / count(*))::bigint else 0 end)
               from app.sold_orders(ctx.branch_id, v_today, v_today + interval '1 day') s),
    'yesterday', (select jsonb_build_object('orders', count(*), 'gross_paise', coalesce(sum(s.total_paise), 0))
                   from app.sold_orders(ctx.branch_id, v_yesterday, v_today) s),
    'live', jsonb_build_object(
      'pending', (select count(*) from public.orders where branch_id = ctx.branch_id and status = 'pending'),
      'in_kitchen', (select count(*) from public.orders where branch_id = ctx.branch_id and status in ('confirmed', 'preparing')),
      'ready', (select count(*) from public.orders where branch_id = ctx.branch_id and status in ('ready', 'out_for_delivery')),
      'on_hold', (select count(*) from public.orders where branch_id = ctx.branch_id and on_hold
                    and status in ('pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery'))),
    'failed_payments', (select count(*) from public.payments pay join public.orders o on o.id = pay.order_id
                         where o.branch_id = ctx.branch_id and pay.status = 'failed' and pay.created_at >= v_today),
    'hours', public.report_hours(v_today_p),
    'products', public.report_products(v_today_p),
    'customers', public.report_customers(v_today_p),
    'tokens', public.report_tokens(v_today_p),
    'attention', public.staff_alerts());
end $$;

-- ----------------------------------------------------------------------------
-- Housekeeping (Phase 4 O6): keep the database small; paid records are never touched.
-- ----------------------------------------------------------------------------
create function app.housekeeping() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_orders int;
  v_hooks  int;
begin
  create temporary table dead_orders on commit drop as
    select o.id from public.orders o
     where o.status = 'payment_expired' and o.created_at < now() - interval '30 days'
       and not exists (select 1 from public.payments p where p.order_id = o.id)
       and not exists (select 1 from public.token_ledger l where l.order_id = o.id)
       and not exists (select 1 from public.coupon_redemptions cr where cr.order_id = o.id);
  delete from public.order_item_modifiers m using public.order_items i, dead_orders d where m.order_item_id = i.id and i.order_id = d.id;
  delete from public.order_items i using dead_orders d where i.order_id = d.id;
  delete from public.order_status_events e using dead_orders d where e.order_id = d.id;
  delete from public.fraud_flags f using dead_orders d where f.order_id = d.id;
  delete from public.orders o using dead_orders d where o.id = d.id;
  get diagnostics v_orders = row_count;
  drop table dead_orders;

  update app.webhook_events set payload = '{}'::jsonb
   where received_at < now() - interval '180 days' and payload <> '{}'::jsonb;
  get diagnostics v_hooks = row_count;
  return jsonb_build_object('orders_removed', v_orders, 'webhooks_trimmed', v_hooks);
end $$;

-- ----------------------------------------------------------------------------
-- RLS & privileges
-- ----------------------------------------------------------------------------
alter table public.blocked_identities enable row level security;
alter table public.reconciliation_runs enable row level security;
revoke all on public.blocked_identities, public.reconciliation_runs from anon, authenticated;

revoke execute on function
  app.hash_mobile(text), app.block_scope_for(text, text, text), app.apply_dispute(text, text, text), app.reconcile(jsonb),
  app.flag_once(uuid, text, public.flag_severity, text, jsonb, interval, uuid, uuid, uuid), app.run_fraud_rules(),
  app.report_range(jsonb), app.sold_orders(uuid, timestamptz, timestamptz), app.housekeeping(),
  public.block_identity(uuid, public.identity_kind, public.block_scope, text, int), public.unblock_identity(uuid, text),
  public.review_fraud_flag(bigint, text, text), public.risk_overview(),
  public.report_sales(jsonb), public.report_products(jsonb), public.report_categories(jsonb), public.report_hours(jsonb),
  public.report_payments(jsonb), public.report_tokens(jsonb), public.report_customers(jsonb), public.dashboard_today()
  from public, anon, authenticated;
grant execute on function
  public.block_identity(uuid, public.identity_kind, public.block_scope, text, int), public.unblock_identity(uuid, text),
  public.review_fraud_flag(bigint, text, text), public.risk_overview(),
  public.report_sales(jsonb), public.report_products(jsonb), public.report_categories(jsonb), public.report_hours(jsonb),
  public.report_payments(jsonb), public.report_tokens(jsonb), public.report_customers(jsonb), public.dashboard_today()
  to authenticated;
grant execute on function app.apply_dispute(text, text, text), app.reconcile(jsonb), app.run_fraud_rules(), app.housekeeping()
  to service_role;
