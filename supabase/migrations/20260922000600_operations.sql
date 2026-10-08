-- ============================================================================
-- M4 Staff operations: live board & kitchen reads, accept / reject / advance /
-- step back, holds, audited mobile reveal, refunds (maker–checker), receipts
-- with gap-free numbering, and the QR code manager.
-- Design: docs/PHASE-2-USER-FLOWS.md §2.2–2.4, 2.7; docs/PHASE-7-API.md §5–6;
-- docs/PHASE-4-DATABASE.md §2.9.
--
-- Every staff function: checks the role itself, locks the rows it changes, checks
-- the order `version` (two tills can't both act on a stale card), and writes status
-- events / audit rows in the same transaction.
-- ============================================================================

alter table public.refunds
  add column needs_owner   boolean not null default false,   -- above the Owner-approval limit
  add column decision_note text check (length(decision_note) <= 300);

-- ----------------------------------------------------------------------------
-- Receipts: one per accepted order, numbered SLB/2026-27/000001 per financial year.
-- ----------------------------------------------------------------------------
create table public.receipts (
  id              uuid primary key default app.uuid_v7(),
  branch_id       uuid not null references public.branches (id),
  order_id        uuid not null unique references public.orders (id),
  receipt_number  text not null,
  financial_year  text not null,
  is_tax_invoice  boolean not null default false,
  snapshot        jsonb not null,
  created_at      timestamptz not null default now(),
  unique (branch_id, receipt_number)
);

create table app.receipt_counters (
  branch_id       uuid not null references public.branches (id),
  financial_year  text not null,
  last_seq        int not null default 0,
  primary key (branch_id, financial_year)
);

-- Receipts are what was printed: they never change and are never deleted.
create function app.block_receipt_changes() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = 'FORBIDDEN', detail = 'Receipts can’t be changed or deleted.';
end $$;
create trigger receipts_immutable before update or delete on public.receipts
  for each row execute function app.block_receipt_changes();

-- Indian financial year (April–March) for a moment, in IST: 2026-09-21 → '2026-27'.
create function app.financial_year(p_at timestamptz) returns text
language sql immutable set search_path = '' as $$
  select case when extract(month from (p_at at time zone 'Asia/Kolkata')) >= 4
              then to_char(p_at at time zone 'Asia/Kolkata', 'YYYY') || '-' ||
                   lpad(((extract(year from (p_at at time zone 'Asia/Kolkata'))::int + 1) % 100)::text, 2, '0')
              else ((extract(year from (p_at at time zone 'Asia/Kolkata'))::int - 1))::text || '-' ||
                   lpad((extract(year from (p_at at time zone 'Asia/Kolkata'))::int % 100)::text, 2, '0')
         end
$$;

create function app.mask_mobile(p_mobile text) returns text
language sql immutable set search_path = '' as $$
  select case when p_mobile ~ '^\+91\d{10}$' then substr(p_mobile, 4, 2) || 'xxxxx' || substr(p_mobile, 11, 3) else 'xxxxxxxxxx' end
$$;

-- Line items with their choices. Prices are left out for the kitchen.
create function app.order_items_json(p_order_id uuid, p_with_prices boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(
           jsonb_build_object('id', i.id, 'name', i.product_name, 'variant', i.variant_name, 'qty', i.qty, 'note', i.note,
                              'options', coalesce((select jsonb_agg(jsonb_build_object('group', m.group_name, 'name', m.option_name)
                                                                    || case when p_with_prices then jsonb_build_object('price_paise', m.price_paise) else '{}' end)
                                                   from public.order_item_modifiers m where m.order_item_id = i.id), '[]'))
           || case when p_with_prices then jsonb_build_object('unit_price_paise', i.unit_price_paise, 'line_total_paise', i.line_total_paise,
                                                              'promo_discount_paise', i.promo_discount_paise, 'refunded_qty', i.refunded_qty)
                   else '{}' end
           order by i.sort_order), '[]')
  from public.order_items i where i.order_id = p_order_id
$$;

create function app.issue_receipt(p_order_id uuid) returns public.receipts
language plpgsql security definer set search_path = '' as $$
declare
  rc   public.receipts;
  o    public.orders;
  b    public.branches;
  p    public.payments;
  s    jsonb;
  fy   text;
  seq  int;
  gst  boolean;
begin
  select * into rc from public.receipts where order_id = p_order_id;
  if rc.id is not null then return rc; end if;
  select * into o from public.orders where id = p_order_id;
  select * into b from public.branches where id = o.branch_id;
  select * into p from public.payments where order_id = o.id and not is_duplicate and status <> 'failed' order by created_at limit 1;
  s := app.branch_settings(o.branch_id);
  gst := coalesce((s ->> 'gst_enabled')::boolean, false);
  fy := app.financial_year(coalesce(o.paid_at, now()));

  insert into app.receipt_counters (branch_id, financial_year) values (o.branch_id, fy) on conflict do nothing;
  update app.receipt_counters set last_seq = last_seq + 1
   where branch_id = o.branch_id and financial_year = fy
  returning last_seq into seq;

  insert into public.receipts (branch_id, order_id, receipt_number, financial_year, is_tax_invoice, snapshot)
  values (o.branch_id, o.id, 'SLB/' || fy || '/' || lpad(seq::text, 6, '0'), fy, gst,
    jsonb_build_object(
      'shop', jsonb_build_object('header', coalesce(s ->> 'receipt_header', b.name), 'legal_name', s ->> 'legal_name',
                                 'address', b.address, 'pincode', b.pincode, 'phone', b.phone,
                                 'gstin', case when gst then s ->> 'gstin' end),
      'order', jsonb_build_object('order_number', o.order_number, 'pickup_number', o.pickup_number, 'order_type', o.order_type,
                                  'table_label', o.table_label, 'customer_name', o.customer_name, 'paid_at', o.paid_at,
                                  'delivery_address', o.delivery_address),
      'items', app.order_items_json(o.id, true),
      'totals', jsonb_build_object('subtotal_paise', o.subtotal_paise, 'promo_discount_paise', o.promo_discount_paise,
                                   'order_discount_paise', o.order_discount_paise,
                                   'delivery_fee_paise', o.delivery_fee_paise, 'tax_paise', o.tax_paise,
                                   'tax_included_paise', o.tax_included_paise, 'total_paise', o.total_paise,
                                   'gst_rate_bp', case when gst then (s ->> 'gst_rate_bp')::int end,
                                   'gst_inclusive', case when gst then (s ->> 'gst_inclusive')::boolean end),
      'payment', jsonb_build_object('method', p.method, 'vpa_masked', p.payer_vpa_masked,
                                    'reference', case when p.provider_payment_id is not null then '…' || right(p.provider_payment_id, 6) end),
      'footer', s ->> 'receipt_footer'))
  returning * into rc;
  return rc;
end $$;

-- ----------------------------------------------------------------------------
-- Order actions
-- ----------------------------------------------------------------------------
-- Lock the order for the caller's branch and check nobody changed it since the card was drawn.
create function app.lock_order(p_order_id uuid, p_version int, p_branch_id uuid) returns public.orders
language plpgsql security definer set search_path = '' as $$
declare
  o public.orders;
begin
  select * into o from public.orders where id = p_order_id and branch_id = p_branch_id for update;
  if o.id is null or o.status in ('awaiting_payment', 'payment_expired') then
    perform app.raise('NOT_FOUND', 'Order not found.');
  end if;
  if p_version is not null and o.version <> p_version then
    perform app.raise('VERSION_CONFLICT', 'Someone else just updated this order. The board has been refreshed.',
                      jsonb_build_object('status', o.status, 'version', o.version));
  end if;
  return o;
end $$;

create function public.accept_order(p_order_id uuid, p_version int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager', 'cashier');
  o   public.orders := app.lock_order(p_order_id, p_version, ctx.branch_id);
begin
  if o.on_hold then
    perform app.raise('ORDER_ON_HOLD', 'This order is on hold for a manager to review.', jsonb_build_object('reason', o.hold_reason));
  end if;
  if o.status <> 'pending' then
    perform app.raise('INVALID_TRANSITION', 'This order has already been handled.', jsonb_build_object('status', o.status));
  end if;
  update public.orders
     set status = 'confirmed', confirmed_at = now()
   where id = o.id
  returning * into o;
  perform app.issue_receipt(o.id);
  return jsonb_build_object('status', o.status, 'version', o.version);
end $$;

-- Refund request helper. Amounts are always worked out here, never taken from the client.
create function app.create_refund_request(
  o public.orders, p_kind public.refund_kind, p_items jsonb, p_reason text, p_requested_by uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p            public.payments;
  v_remaining  bigint;
  v_goods      bigint;
  v_amount     bigint := 0;
  v_refund     uuid;
  v_limit      bigint;
  v_needs      boolean;
  it           record;
  v_avail      int;
  v_line       bigint;
  v_lines      jsonb := '[]';
begin
  select * into p from public.payments
   where order_id = o.id and not is_duplicate and status in ('successful', 'partially_refunded') for update;
  if p.id is null then
    perform app.raise('INVALID_TRANSITION', 'There’s no payment left to refund on this order.');
  end if;
  -- Money already refunded or on its way back (failed ones may still be retried).
  v_remaining := p.amount_paise - coalesce((select sum(amount_paise) from public.refunds
                                            where payment_id = p.id and status in ('requested', 'approved', 'processing', 'processed', 'failed')), 0);
  if v_remaining <= 0 then
    perform app.raise('INVALID_TRANSITION', 'This order has already been refunded in full (or a refund is in progress).');
  end if;

  if p_kind = 'full' then
    v_amount := v_remaining;
    for it in select i.id, i.qty - coalesce((select sum(ri.qty) from public.refund_items ri join public.refunds r on r.id = ri.refund_id
                                             where ri.order_item_id = i.id and r.status <> 'declined'), 0) as avail
                from public.order_items i where i.order_id = o.id loop
      if it.avail > 0 then
        v_lines := v_lines || jsonb_build_object('order_item_id', it.id, 'qty', it.avail, 'amount_paise', 0);
      end if;
    end loop;
  else
    if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
      perform app.raise('VALIDATION_FAILED', 'Choose the items to refund.', jsonb_build_object('fields', jsonb_build_object('items', 'required')));
    end if;
    -- What the customer actually paid for goods (after discounts, including any GST), spread over item value.
    v_goods := (select sum(line_total_paise - promo_discount_paise) from public.order_items where order_id = o.id);
    for it in select (e ->> 'order_item_id')::uuid as id, (e ->> 'qty')::int as qty from jsonb_array_elements(p_items) e loop
      select i.qty - coalesce((select sum(ri.qty) from public.refund_items ri join public.refunds r on r.id = ri.refund_id
                               where ri.order_item_id = i.id and r.status <> 'declined'), 0),
             case when v_goods > 0 then
               round(((i.line_total_paise - i.promo_discount_paise)::numeric / i.qty) * it.qty
                     * (o.total_paise - o.delivery_fee_paise) / v_goods)::bigint
             else 0 end
        into v_avail, v_line
        from public.order_items i where i.id = it.id and i.order_id = o.id;
      if v_avail is null then
        perform app.raise('VALIDATION_FAILED', 'That item isn’t on this order.');
      end if;
      if it.qty is null or it.qty < 1 or it.qty > v_avail then
        perform app.raise('VALIDATION_FAILED', format('You can refund at most %s of that item.', greatest(v_avail, 0)),
                          jsonb_build_object('order_item_id', it.id, 'max', greatest(v_avail, 0)));
      end if;
      v_amount := v_amount + v_line;
      v_lines := v_lines || jsonb_build_object('order_item_id', it.id, 'qty', it.qty, 'amount_paise', v_line);
    end loop;
    v_amount := least(v_amount, v_remaining);
    if v_amount <= 0 then
      perform app.raise('VALIDATION_FAILED', 'There’s nothing left to refund on those items.');
    end if;
  end if;

  v_limit := coalesce((app.setting(o.branch_id, 'refund_owner_approval_above_paise'))::text::bigint, 50000);
  v_needs := v_amount > v_limit;
  insert into public.refunds (order_id, payment_id, kind, amount_paise, reason, status, requested_by, needs_owner)
  values (o.id, p.id, p_kind, v_amount, left(p_reason, 300), 'requested', p_requested_by, v_needs)
  returning id into v_refund;
  insert into public.refund_items (refund_id, order_item_id, qty, amount_paise)
  select v_refund, (l ->> 'order_item_id')::uuid, (l ->> 'qty')::smallint, (l ->> 'amount_paise')::bigint
    from jsonb_array_elements(v_lines) l;
  perform app.audit('refund.request', 'refund', v_refund::text, null,
                    jsonb_build_object('order_id', o.id, 'kind', p_kind, 'amount_paise', v_amount), p_reason, o.branch_id);
  return jsonb_build_object('refund_id', v_refund, 'amount_paise', v_amount, 'status', 'requested',
                            'needs', case when v_needs then 'owner' else 'manager' end);
end $$;

create function public.reject_order(p_order_id uuid, p_version int, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ctx      app.staff_context := app.require_role('owner', 'manager', 'cashier');
  o        public.orders := app.lock_order(p_order_id, p_version, ctx.branch_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_refund jsonb;
begin
  if length(v_reason) < 3 or length(v_reason) > 200 then
    perform app.raise('VALIDATION_FAILED', 'Tell the customer why (3–200 characters).', jsonb_build_object('fields', jsonb_build_object('reason', 'required')));
  end if;
  if o.status <> 'pending' then
    perform app.raise('INVALID_TRANSITION', 'Only new orders can be rejected. Use a refund instead.', jsonb_build_object('status', o.status));
  end if;
  perform set_config('app.reason', v_reason, true);
  update public.orders set status = 'rejected', reject_reason = v_reason where id = o.id returning * into o;
  -- The customer's money goes back once a Manager approves. Created by the system (not the
  -- rejecting cashier) so any Manager, including one who rejected it, can approve it: the
  -- refund can only ever go back to the original payer.
  if exists (select 1 from public.payments where order_id = o.id and not is_duplicate and status in ('successful', 'partially_refunded')) then
    v_refund := app.create_refund_request(o, 'full', null, 'Order rejected by the shop: ' || v_reason, null);
  end if;
  perform app.audit('order.reject', 'order', o.id::text, null, jsonb_build_object('refund_id', v_refund ->> 'refund_id'), v_reason);
  return jsonb_build_object('status', o.status, 'version', o.version, 'refund_id', v_refund ->> 'refund_id');
end $$;

create function public.advance_order(p_order_id uuid, p_version int, p_to_status public.order_status) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ctx  app.staff_context := app.require_role('owner', 'manager', 'cashier', 'kitchen');
  o    public.orders := app.lock_order(p_order_id, p_version, ctx.branch_id);
  ok   boolean;
begin
  ok := case
    when o.status = 'confirmed' and p_to_status = 'preparing' then true
    when o.status = 'preparing' and p_to_status = 'ready' then true
    when ctx.role = 'kitchen' then false
    when o.status = 'ready' and p_to_status = 'completed' then o.order_type <> 'delivery'
    when o.status = 'ready' and p_to_status = 'out_for_delivery' then o.order_type = 'delivery'
    when o.status = 'out_for_delivery' and p_to_status = 'delivered' then true
    else false
  end;
  if not ok then
    perform app.raise('INVALID_TRANSITION', format('This order can’t go from %s to %s.', replace(o.status::text, '_', ' '), replace(p_to_status::text, '_', ' ')),
                      jsonb_build_object('status', o.status));
  end if;
  if o.on_hold then
    perform app.raise('ORDER_ON_HOLD', 'This order is on hold for a manager to review.');
  end if;
  update public.orders
     set status = p_to_status,
         preparing_at = case when p_to_status = 'preparing' then now() else preparing_at end,
         ready_at     = case when p_to_status = 'ready' then now() else ready_at end,
         completed_at = case when p_to_status in ('completed', 'delivered') then now() else completed_at end
   where id = o.id
  returning * into o;
  return jsonb_build_object('status', o.status, 'version', o.version);
end $$;

-- Manager "one step back" (Phase 2 decision 5), for a mis-tap. Always audited.
create function public.revert_order_status(p_order_id uuid, p_version int, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ctx      app.staff_context := app.require_role('owner', 'manager');
  o        public.orders := app.lock_order(p_order_id, p_version, ctx.branch_id);
  v_back   public.order_status;
  v_from   public.order_status := o.status;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  v_back := case o.status when 'confirmed' then 'pending' when 'preparing' then 'confirmed'
                          when 'ready' then 'preparing' when 'out_for_delivery' then 'ready' end;
  if v_back is null then
    perform app.raise('INVALID_TRANSITION', 'This order can’t be stepped back.', jsonb_build_object('status', o.status));
  end if;
  if length(v_reason) < 3 then
    perform app.raise('VALIDATION_FAILED', 'Give a reason (at least 3 characters).', jsonb_build_object('fields', jsonb_build_object('reason', 'required')));
  end if;
  perform set_config('app.reason', left(v_reason, 200), true);
  update public.orders
     set status = v_back,
         confirmed_at = case when v_back = 'pending' then null else confirmed_at end,
         preparing_at = case when v_back = 'confirmed' then null else preparing_at end,
         ready_at     = case when v_back = 'preparing' then null else ready_at end
   where id = o.id
  returning * into o;
  perform app.audit('order.step_back', 'order', o.id::text, jsonb_build_object('status', v_from), jsonb_build_object('status', v_back), v_reason);
  return jsonb_build_object('status', o.status, 'version', o.version);
end $$;

create function public.clear_order_hold(p_order_id uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ctx    app.staff_context := app.require_role('owner', 'manager');
  o      public.orders := app.lock_order(p_order_id, null, ctx.branch_id);
  v_note text := btrim(coalesce(p_note, ''));
begin
  if not o.on_hold then
    return jsonb_build_object('on_hold', false, 'version', o.version);
  end if;
  if length(v_note) < 3 then
    perform app.raise('VALIDATION_FAILED', 'Write what you checked (at least 3 characters).', jsonb_build_object('fields', jsonb_build_object('note', 'required')));
  end if;
  update public.orders set on_hold = false, version = version + 1 where id = o.id returning * into o;
  perform app.audit('order.clear_hold', 'order', o.id::text, jsonb_build_object('hold_reason', o.hold_reason), null, v_note);
  return jsonb_build_object('on_hold', false, 'version', o.version);
end $$;

-- Full mobile number, for calling a customer. Logged every time (Phase 6 D8).
create function public.reveal_customer_mobile(p_order_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager', 'cashier');
  o   public.orders := app.lock_order(p_order_id, null, ctx.branch_id);
begin
  perform app.audit('order.reveal_mobile', 'order', o.id::text, null, null, null);
  return jsonb_build_object('mobile', o.customer_mobile);
end $$;

-- ----------------------------------------------------------------------------
-- Refunds
-- ----------------------------------------------------------------------------
create function public.request_refund(p_order_id uuid, p_kind public.refund_kind, p_items jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ctx      app.staff_context := app.require_role('owner', 'manager', 'cashier');
  o        public.orders := app.lock_order(p_order_id, null, ctx.branch_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_count  int;
  v_limit  int;
  v_result jsonb;
begin
  if length(v_reason) < 3 or length(v_reason) > 300 then
    perform app.raise('VALIDATION_FAILED', 'Give a reason (3–300 characters).', jsonb_build_object('fields', jsonb_build_object('reason', 'required')));
  end if;
  if o.status = 'pending' then
    perform app.raise('INVALID_TRANSITION', 'This order is still new: reject it instead, which refunds the customer.');
  end if;
  v_result := app.create_refund_request(o, p_kind, p_items, v_reason, ctx.staff_id);

  -- Fraud rule: unusually many refund requests from one person in a day (Phase 4 §8).
  v_limit := coalesce((app.setting(o.branch_id, 'refund_daily_limit_per_staff'))::text::int, 5);
  select count(*) into v_count from public.refunds
   where requested_by = ctx.staff_id and created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  if v_count > v_limit then
    insert into public.fraud_flags (branch_id, rule, severity, order_id, customer_id, staff_id, details)
    values (o.branch_id, 'REFUND_VOLUME', 'warn', o.id, o.customer_id, ctx.staff_id, jsonb_build_object('requests_today', v_count, 'limit', v_limit));
  end if;
  return v_result;
end $$;

-- Maker–checker: the person who asked can't approve. Above the limit only the Owner can
-- approve, after a fresh 2FA code. On approval the Edge API sends it to Razorpay.
create function public.decide_refund(p_refund_id uuid, p_approve boolean, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ctx    app.staff_context := app.require_role('owner', 'manager');
  r      public.refunds;
  o      public.orders;
  p      public.payments;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select r2.* into r from public.refunds r2 join public.orders o2 on o2.id = r2.order_id
   where r2.id = p_refund_id and o2.branch_id = ctx.branch_id for update of r2;
  if r.id is null then perform app.raise('NOT_FOUND', 'Refund not found.'); end if;
  if r.status <> 'requested' then
    perform app.raise('INVALID_TRANSITION', 'This refund has already been decided.', jsonb_build_object('status', r.status));
  end if;
  if r.requested_by = ctx.staff_id then
    perform app.raise('FORBIDDEN', 'Someone else has to approve a refund you asked for.');
  end if;
  if p_approve and r.needs_owner then
    if ctx.role <> 'owner' then
      perform app.raise('NEEDS_OWNER_APPROVAL', 'Refunds this big need the Owner’s approval.', jsonb_build_object('amount_paise', r.amount_paise));
    end if;
    perform app.require_recent_mfa();
  end if;
  if not p_approve and v_note is null then
    perform app.raise('VALIDATION_FAILED', 'Say why you’re declining.', jsonb_build_object('fields', jsonb_build_object('note', 'required')));
  end if;

  update public.refunds
     set status = case when p_approve then 'approved'::public.refund_status else 'declined'::public.refund_status end,
         decided_by = ctx.staff_id, decided_at = now(), decision_note = left(v_note, 300)
   where id = r.id
  returning * into r;
  select * into o from public.orders where id = r.order_id;
  select * into p from public.payments where id = r.payment_id;
  perform app.audit(case when p_approve then 'refund.approve' else 'refund.decline' end, 'refund', r.id::text,
                    null, jsonb_build_object('amount_paise', r.amount_paise, 'order_id', r.order_id), v_note, o.branch_id);
  return jsonb_build_object('refund_id', r.id, 'status', r.status, 'amount_paise', r.amount_paise,
                            'provider_payment_id', case when p_approve then p.provider_payment_id end);
end $$;

-- Retry sending an approved/failed refund to Razorpay (same idempotency key, so never twice).
create function public.refund_for_submission(p_refund_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager');
  r   public.refunds;
  p   public.payments;
begin
  select r2.* into r from public.refunds r2 join public.orders o2 on o2.id = r2.order_id
   where r2.id = p_refund_id and o2.branch_id = ctx.branch_id for update of r2;
  if r.id is null then perform app.raise('NOT_FOUND', 'Refund not found.'); end if;
  if r.status not in ('approved', 'failed') then
    perform app.raise('INVALID_TRANSITION', 'Only approved or failed refunds can be sent again.', jsonb_build_object('status', r.status));
  end if;
  if r.status = 'failed' then
    update public.refunds set status = 'approved', failure_reason = null where id = r.id;
  end if;
  select * into p from public.payments where id = r.payment_id;
  perform app.audit('refund.retry', 'refund', r.id::text, null, null, null);
  return jsonb_build_object('refund_id', r.id, 'provider_payment_id', p.provider_payment_id, 'amount_paise', r.amount_paise);
end $$;

-- Processed refunds also record which items went back (for reports and "refundable" maths).
create or replace function app.apply_refund_event(p_provider_refund_id text, p_payment_id text, p_amount bigint, p_processed boolean, p_reason text)
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
    if v_total_refunded >= p.amount_paise and o.status <> 'refunded'
       and exists (select 1 from app.order_transitions where from_status = o.status and to_status = 'refunded') then
      perform set_config('app.actor', 'system', true);
      update public.orders set status = 'refunded' where id = o.id;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'status', 'processed', 'order_id', r.order_id);
end $$;

-- ----------------------------------------------------------------------------
-- Reads for the staff screens (one round trip each)
-- ----------------------------------------------------------------------------
create function app.card_json(o public.orders) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', o.id, 'order_number', o.order_number, 'pickup_number', o.pickup_number, 'order_type', o.order_type,
    'status', o.status, 'version', o.version, 'table_label', o.table_label, 'customer_name', o.customer_name,
    'mobile_masked', app.mask_mobile(o.customer_mobile), 'note', o.note, 'total_paise', o.total_paise,
    'on_hold', o.on_hold, 'hold_reason', o.hold_reason, 'late_payment', o.late_payment,
    'paid_at', o.paid_at, 'confirmed_at', o.confirmed_at, 'preparing_at', o.preparing_at, 'ready_at', o.ready_at,
    'eta_minutes', o.eta_minutes, 'delivery_address', o.delivery_address, 'delivery_landmark', o.delivery_landmark,
    'items', app.order_items_json(o.id, true))
$$;

-- Counter board: everything not yet finished, oldest first.
create function public.live_orders() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager', 'cashier');
begin
  return jsonb_build_object(
    'orders', coalesce((select jsonb_agg(app.card_json(o) order by o.paid_at)
                        from public.orders o
                        where o.branch_id = ctx.branch_id
                          and o.status in ('pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery')), '[]'),
    'late_after_min', coalesce((app.setting(ctx.branch_id, 'late_order_alert_min'))::text::int, 5),
    'server_time', now());
end $$;

-- Kitchen: confirmed and preparing only; no prices, no phone numbers (Phase 2 decision 6).
create function public.kitchen_orders() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager', 'kitchen');
begin
  return jsonb_build_object(
    'orders', coalesce((select jsonb_agg(jsonb_build_object(
                          'id', o.id, 'pickup_number', o.pickup_number, 'order_number', o.order_number, 'order_type', o.order_type,
                          'table_label', o.table_label, 'status', o.status, 'version', o.version, 'note', o.note,
                          'confirmed_at', o.confirmed_at, 'preparing_at', o.preparing_at,
                          'items', app.order_items_json(o.id, false))
                        order by o.confirmed_at)
                        from public.orders o
                        where o.branch_id = ctx.branch_id and o.status in ('confirmed', 'preparing')), '[]'),
    'late_after_min', coalesce((app.setting(ctx.branch_id, 'late_order_alert_min'))::text::int, 5),
    'server_time', now());
end $$;

-- Cashiers see today's orders only (Phase 6 navigation table).
create function app.visible_to(ctx app.staff_context, o public.orders) returns boolean
language sql stable set search_path = '' as $$
  select o.branch_id = ctx.branch_id and o.status not in ('awaiting_payment', 'payment_expired')
     and (ctx.role in ('owner', 'manager')
          or o.paid_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')
$$;

create function public.order_detail(p_order_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager', 'cashier');
  o   public.orders;
begin
  select * into o from public.orders where id = p_order_id;
  if o.id is null or not app.visible_to(ctx, o) then
    perform app.raise('NOT_FOUND', 'Order not found.');
  end if;
  return app.card_json(o) || jsonb_build_object(
    'subtotal_paise', o.subtotal_paise, 'promo_discount_paise', o.promo_discount_paise, 'order_discount_paise', o.order_discount_paise,
    'delivery_fee_paise', o.delivery_fee_paise, 'tax_paise', o.tax_paise,
    'reject_reason', o.reject_reason, 'cancel_reason', o.cancel_reason, 'completed_at', o.completed_at,
    'public_token_hint', right(o.public_token, 4),
    'receipt_number', (select receipt_number from public.receipts where order_id = o.id),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'provider_payment_id', p.provider_payment_id, 'amount_paise', p.amount_paise,
                                                              'status', p.status, 'method', p.method, 'vpa_masked', p.payer_vpa_masked,
                                                              'refunded_paise', p.refunded_paise, 'is_duplicate', p.is_duplicate,
                                                              'captured_at', p.captured_at, 'failure_reason', p.failure_reason)
                                           order by p.created_at)
                          from public.payments p where p.order_id = o.id), '[]'),
    'refunds', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'amount_paise', r.amount_paise, 'reason', r.reason,
                                                             'status', r.status, 'is_automatic', r.is_automatic, 'needs_owner', r.needs_owner,
                                                             'requested_by', (select name from public.staff where id = r.requested_by),
                                                             'decided_by', (select name from public.staff where id = r.decided_by),
                                                             'created_at', r.created_at, 'failure_reason', r.failure_reason,
                                                             'decision_note', r.decision_note)
                                          order by r.created_at)
                         from public.refunds r where r.order_id = o.id), '[]'),
    'timeline', coalesce((select jsonb_agg(jsonb_build_object('from', e.from_status, 'to', e.to_status, 'actor', e.actor_type,
                                                              'staff', (select name from public.staff where id = e.staff_id),
                                                              'reason', e.reason, 'at', e.created_at) order by e.id)
                          from public.order_status_events e where e.order_id = o.id), '[]'),
    'flags', coalesce((select jsonb_agg(jsonb_build_object('rule', f.rule, 'severity', f.severity, 'status', f.status, 'at', f.created_at) order by f.id)
                       from public.fraud_flags f where f.order_id = o.id), '[]'));
end $$;

-- History with filters: {from, to, status, order_type, q, page}. 25 per page.
create function public.order_history(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  ctx     app.staff_context := app.require_role('owner', 'manager', 'cashier');
  v_from  timestamptz := coalesce((p ->> 'from')::date, (now() at time zone 'Asia/Kolkata')::date)::timestamp at time zone 'Asia/Kolkata';
  v_to    timestamptz := (coalesce((p ->> 'to')::date, (now() at time zone 'Asia/Kolkata')::date) + 1)::timestamp at time zone 'Asia/Kolkata';
  v_q     text := nullif(btrim(coalesce(p ->> 'q', '')), '');
  v_page  int := greatest(coalesce((p ->> 'page')::int, 1), 1);
  v_rows  jsonb;
  v_total bigint;
begin
  if v_to - v_from > interval '93 days' then
    perform app.raise('VALIDATION_FAILED', 'Pick a period of up to 3 months.');
  end if;
  with f as (
    select o.* from public.orders o
     where app.visible_to(ctx, o) and o.paid_at >= v_from and o.paid_at < v_to
       and (p ->> 'status' is null or o.status::text = p ->> 'status')
       and (p ->> 'order_type' is null or o.order_type::text = p ->> 'order_type')
       and (v_q is null or o.order_number ilike v_q || '%' or o.customer_name ilike '%' || v_q || '%'
            or (v_q ~ '^\d{10}$' and o.customer_mobile = '+91' || v_q)
            or (v_q ~ '^\d{1,2}$' and o.pickup_number = v_q::int))
  )
  select (select count(*) from f),
         coalesce((select jsonb_agg(jsonb_build_object(
                     'id', x.id, 'order_number', x.order_number, 'pickup_number', x.pickup_number, 'order_type', x.order_type,
                     'status', x.status, 'table_label', x.table_label, 'customer_name', x.customer_name,
                     'mobile_masked', app.mask_mobile(x.customer_mobile), 'total_paise', x.total_paise, 'paid_at', x.paid_at,
                     'payment_status', (select py.status from public.payments py where py.order_id = x.id and not py.is_duplicate
                                        and py.status <> 'failed' order by py.created_at limit 1))
                     order by x.paid_at desc)
                   from (select * from f order by paid_at desc offset (v_page - 1) * 25 limit 25) x), '[]')
    into v_total, v_rows;
  return jsonb_build_object('rows', v_rows, 'total', v_total, 'page', v_page, 'page_size', 25);
end $$;

create function public.refund_queue() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager');
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
            'id', r.id, 'order_id', o.id, 'order_number', o.order_number, 'pickup_number', o.pickup_number,
            'customer_name', o.customer_name, 'kind', r.kind, 'amount_paise', r.amount_paise, 'order_total_paise', o.total_paise,
            'reason', r.reason, 'status', r.status, 'needs_owner', r.needs_owner, 'is_automatic', r.is_automatic,
            'requested_by_id', r.requested_by, 'requested_by', (select name from public.staff where id = r.requested_by),
            'created_at', r.created_at, 'failure_reason', r.failure_reason, 'decision_note', r.decision_note,
            'decided_by', (select name from public.staff where id = r.decided_by),
            'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.product_name, 'variant', i.variant_name, 'qty', ri.qty))
                               from public.refund_items ri join public.order_items i on i.id = ri.order_item_id where ri.refund_id = r.id), '[]'))
            order by r.created_at)
          from public.refunds r join public.orders o on o.id = r.order_id
          where o.branch_id = ctx.branch_id
            and (r.status in ('requested', 'approved', 'processing', 'failed')
                 or r.updated_at >= now() - interval '2 days')), '[]');
end $$;

-- Counts for the badges in the sidebar / board top bar.
create function public.staff_alerts() returns jsonb
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

-- Receipt for printing / PDF. Issued when the order is accepted.
create function public.order_receipt(p_order_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager', 'cashier');
  o   public.orders;
  rc  public.receipts;
begin
  select * into o from public.orders where id = p_order_id;
  if o.id is null or not app.visible_to(ctx, o) then perform app.raise('NOT_FOUND', 'Order not found.'); end if;
  select * into rc from public.receipts where order_id = o.id;
  if rc.id is null then perform app.raise('NOT_FOUND', 'A receipt is issued once the order is accepted.'); end if;
  return jsonb_build_object('receipt_number', rc.receipt_number, 'is_tax_invoice', rc.is_tax_invoice,
                            'issued_at', rc.created_at, 'snapshot', rc.snapshot);
end $$;

-- Customer's copy, behind the public API (service role).
create function app.receipt_public(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('receipt_number', rc.receipt_number, 'is_tax_invoice', rc.is_tax_invoice,
                            'issued_at', rc.created_at, 'snapshot', rc.snapshot,
                            'refunded_paise', (select coalesce(sum(p.refunded_paise), 0) from public.payments p
                                               where p.order_id = o.id and not p.is_duplicate))
  from public.orders o join public.receipts rc on rc.order_id = o.id
  where o.public_token = p_token
$$;

-- ----------------------------------------------------------------------------
-- QR codes (Manager+)
-- ----------------------------------------------------------------------------
create function public.create_qr(p_kind public.qr_kind, p_table_label text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ctx     app.staff_context := app.require_role('owner', 'manager');
  v_label text := upper(btrim(coalesce(p_table_label, '')));
  v_table uuid;
  q       public.qr_codes;
begin
  if p_kind = 'table' then
    if v_label !~ '^[A-Z0-9 -]{1,12}$' then
      perform app.raise('VALIDATION_FAILED', 'Table name: 1–12 letters or numbers, e.g. 04 or T1.',
                        jsonb_build_object('fields', jsonb_build_object('table_label', 'invalid')));
    end if;
    select id into v_table from public.dining_tables where branch_id = ctx.branch_id and lower(label) = lower(v_label) and is_active;
    if v_table is null then
      insert into public.dining_tables (branch_id, label) values (ctx.branch_id, v_label) returning id into v_table;
    elsif exists (select 1 from public.qr_codes where table_id = v_table and is_active) then
      perform app.raise('VALIDATION_FAILED', format('Table %s already has an active QR code. Switch it off first to make a new one.', v_label),
                        jsonb_build_object('fields', jsonb_build_object('table_label', 'taken')));
    end if;
  end if;
  insert into public.qr_codes (branch_id, kind, table_id) values (ctx.branch_id, p_kind, v_table) returning * into q;
  perform app.audit('qr.create', 'qr_code', q.id::text, null, jsonb_build_object('kind', p_kind, 'table', nullif(v_label, '')), null);
  return jsonb_build_object('id', q.id, 'slug', q.slug);
end $$;

create function public.set_qr_active(p_qr_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager');
  q   public.qr_codes;
begin
  select * into q from public.qr_codes where id = p_qr_id and branch_id = ctx.branch_id for update;
  if q.id is null then perform app.raise('NOT_FOUND', 'QR code not found.'); end if;
  if p_active and q.table_id is not null
     and exists (select 1 from public.qr_codes where table_id = q.table_id and is_active and id <> q.id) then
    perform app.raise('VALIDATION_FAILED', 'That table already has another active QR code.');
  end if;
  update public.qr_codes set is_active = p_active where id = q.id;
  perform app.audit(case when p_active then 'qr.enable' else 'qr.disable' end, 'qr_code', q.id::text,
                    jsonb_build_object('active', q.is_active), jsonb_build_object('active', p_active), null);
end $$;

create function public.list_qr_codes() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager');
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
            'id', q.id, 'slug', q.slug, 'kind', q.kind, 'table_label', t.label, 'is_active', q.is_active, 'created_at', q.created_at,
            'orders_30d', (select count(*) from public.orders o where o.qr_code_id = q.id and o.paid_at >= now() - interval '30 days'))
            order by q.is_active desc, q.kind desc, lpad(coalesce(t.label, ''), 12, '0'), q.created_at)
          from public.qr_codes q left join public.dining_tables t on t.id = q.table_id
          where q.branch_id = ctx.branch_id), '[]');
end $$;

-- ----------------------------------------------------------------------------
-- RLS & privileges
-- ----------------------------------------------------------------------------
alter table public.receipts enable row level security;
revoke all on public.receipts from anon, authenticated;

revoke execute on function
  app.block_receipt_changes(), app.financial_year(timestamptz), app.mask_mobile(text), app.order_items_json(uuid, boolean),
  app.issue_receipt(uuid), app.lock_order(uuid, int, uuid),
  app.create_refund_request(public.orders, public.refund_kind, jsonb, text, uuid), app.card_json(public.orders),
  app.visible_to(app.staff_context, public.orders), app.receipt_public(text),
  public.accept_order(uuid, int), public.reject_order(uuid, int, text),
  public.advance_order(uuid, int, public.order_status), public.revert_order_status(uuid, int, text),
  public.clear_order_hold(uuid, text), public.reveal_customer_mobile(uuid),
  public.request_refund(uuid, public.refund_kind, jsonb, text), public.decide_refund(uuid, boolean, text),
  public.refund_for_submission(uuid), public.live_orders(), public.kitchen_orders(), public.order_detail(uuid),
  public.order_history(jsonb), public.refund_queue(), public.staff_alerts(), public.order_receipt(uuid),
  public.create_qr(public.qr_kind, text), public.set_qr_active(uuid, boolean), public.list_qr_codes()
  from public, anon, authenticated;
grant execute on function
  public.accept_order(uuid, int), public.reject_order(uuid, int, text),
  public.advance_order(uuid, int, public.order_status), public.revert_order_status(uuid, int, text),
  public.clear_order_hold(uuid, text), public.reveal_customer_mobile(uuid),
  public.request_refund(uuid, public.refund_kind, jsonb, text), public.decide_refund(uuid, boolean, text),
  public.refund_for_submission(uuid), public.live_orders(), public.kitchen_orders(), public.order_detail(uuid),
  public.order_history(jsonb), public.refund_queue(), public.staff_alerts(), public.order_receipt(uuid),
  public.create_qr(public.qr_kind, text), public.set_qr_active(uuid, boolean), public.list_qr_codes()
  to authenticated;
grant execute on function app.receipt_public(text) to service_role;

-- Realtime authorization (Phase 7 §7): only staff of the branch may join its private
-- `branch:{id}:orders` channel. Skipped where the Realtime schema doesn't exist (tests).
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute $p$
      create policy staff_branch_orders on realtime.messages for select to authenticated
        using (realtime.topic() = 'branch:' || (select app.current_branch_id()) || ':orders'
               and (select app.current_role()) is not null)
    $p$;
  end if;
end $$;
