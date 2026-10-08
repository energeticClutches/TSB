-- ============================================================================
-- M2 Menu: categories, products, sizes, add-on/option groups, combos, time
-- windows, the public menu snapshot, and Owner approval requests.
-- Design: docs/PHASE-4-DATABASE.md §2.4, Revision 2 §9.1 (approval_requests), Phase 2 §2.6.
-- ============================================================================

create type public.product_kind as enum ('item', 'combo');
create type public.modifier_kind as enum ('paid_addon', 'free_option');
create type public.approval_kind as enum ('refund_over_limit', 'coupon_high_value', 'manual_loyalty_over_cap', 'price_drop_large');
create type public.approval_status as enum ('pending', 'approved', 'declined', 'expired');

alter table public.branches add column menu_version bigint not null default 1;

create table public.categories (
  id          uuid primary key default app.uuid_v7(),
  branch_id   uuid not null references public.branches (id),
  name        text not null check (length(btrim(name)) between 1 and 40),
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index categories_name_idx on public.categories (branch_id, lower(name)) where archived_at is null;
create trigger categories_updated_at before update on public.categories for each row execute function app.touch_updated_at();

create table public.products (
  id            uuid primary key default app.uuid_v7(),
  branch_id     uuid not null references public.branches (id),
  category_id   uuid not null references public.categories (id),
  kind          public.product_kind not null default 'item',
  name          text not null check (length(btrim(name)) between 1 and 80),
  description   text not null default '' check (length(description) <= 300),
  image_path    text check (image_path ~ '^[a-z0-9/_.-]{1,200}$'),
  accent_color  text check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  prep_minutes  smallint not null default 5 check (prep_minutes between 0 and 120),
  is_featured   boolean not null default false,
  is_sold_out   boolean not null default false,
  is_active     boolean not null default true,
  sort_order    int not null default 0,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index products_menu_idx on public.products (branch_id, category_id, sort_order) where archived_at is null;
create trigger products_updated_at before update on public.products for each row execute function app.touch_updated_at();

create table public.product_variants (
  id                   uuid primary key default app.uuid_v7(),
  product_id           uuid not null references public.products (id),
  name                 text not null check (length(btrim(name)) between 1 and 40),
  price_paise          bigint not null check (price_paise between 0 and 10000000),
  is_default           boolean not null default false,
  sort_order           int not null default 0,
  archived_at          timestamptz,
  created_at           timestamptz not null default now()
);
create index product_variants_product_idx on public.product_variants (product_id) where archived_at is null;
create unique index product_variants_default_idx on public.product_variants (product_id) where is_default and archived_at is null;

create table public.modifier_groups (
  id          uuid primary key default app.uuid_v7(),
  branch_id   uuid not null references public.branches (id),
  name        text not null check (length(btrim(name)) between 1 and 40),
  kind        public.modifier_kind not null,
  min_select  smallint not null default 0,
  max_select  smallint not null default 1,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  check (min_select >= 0 and max_select >= 1 and min_select <= max_select and max_select <= 20)
);

create table public.modifier_options (
  id           uuid primary key default app.uuid_v7(),
  group_id     uuid not null references public.modifier_groups (id),
  name         text not null check (length(btrim(name)) between 1 and 40),
  price_paise  bigint not null default 0 check (price_paise between 0 and 1000000),
  is_default   boolean not null default false,
  is_sold_out  boolean not null default false,
  sort_order   int not null default 0,
  archived_at  timestamptz
);
create index modifier_options_group_idx on public.modifier_options (group_id) where archived_at is null;

create table public.product_modifier_groups (
  product_id  uuid not null references public.products (id),
  group_id    uuid not null references public.modifier_groups (id),
  sort_order  int not null default 0,
  primary key (product_id, group_id)
);

create table public.combo_components (
  combo_product_id      uuid not null references public.products (id),
  component_product_id  uuid not null references public.products (id),
  component_variant_id  uuid references public.product_variants (id),
  qty                   smallint not null default 1 check (qty between 1 and 10),
  sort_order            int not null default 0,
  primary key (combo_product_id, component_product_id),
  check (combo_product_id <> component_product_id)
);

create table public.availability_windows (
  id           uuid primary key default app.uuid_v7(),
  category_id  uuid references public.categories (id),
  product_id   uuid references public.products (id),
  days_mask    smallint not null default 127 check (days_mask between 1 and 127),
  start_time   time not null,
  end_time     time not null,
  check ((category_id is null) <> (product_id is null)),
  check (start_time <> end_time)
);
create index availability_windows_product_idx on public.availability_windows (product_id);
create index availability_windows_category_idx on public.availability_windows (category_id);

create table public.approval_requests (
  id            uuid primary key default app.uuid_v7(),
  branch_id     uuid not null references public.branches (id),
  kind          public.approval_kind not null,
  payload       jsonb not null,
  summary       text not null,
  requested_by  uuid not null references public.staff (id),
  decided_by    uuid references public.staff (id),
  decided_at    timestamptz,
  decision_note text,
  status        public.approval_status not null default 'pending',
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '48 hours',
  check (decided_by is null or decided_by <> requested_by)
);
create index approval_requests_pending_idx on public.approval_requests (branch_id, created_at) where status = 'pending';

-- ----------------------------------------------------------------------------
-- Helpers
-- ----------------------------------------------------------------------------
create function app.bump_menu_version(p_branch_id uuid) returns bigint
language sql security definer set search_path = '' as $$
  update public.branches set menu_version = menu_version + 1 where id = p_branch_id returning menu_version
$$;

create function app.setting(p_branch_id uuid, p_key text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select value from public.settings where branch_id = p_branch_id and key = p_key
$$;

create function app.text_field(p jsonb, p_key text, p_max int, p_required boolean default true) returns text
language plpgsql stable set search_path = '' as $$
declare
  v text := btrim(coalesce(p ->> p_key, ''));
begin
  if p_required and v = '' then
    perform app.raise('VALIDATION_FAILED', format('%s is required.', initcap(replace(p_key, '_', ' '))),
                      jsonb_build_object('fields', jsonb_build_object(p_key, 'required')));
  end if;
  if length(v) > p_max then
    perform app.raise('VALIDATION_FAILED', format('%s is too long (max %s characters).', initcap(replace(p_key, '_', ' ')), p_max),
                      jsonb_build_object('fields', jsonb_build_object(p_key, 'too_long')));
  end if;
  return v;
end $$;

-- Replace the time windows of a product or category from a JSON array.
create function app.set_windows(p_product_id uuid, p_category_id uuid, p_windows jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  w jsonb;
begin
  if p_windows is null then return; end if;
  if jsonb_typeof(p_windows) <> 'array' or jsonb_array_length(p_windows) > 7 then
    perform app.raise('VALIDATION_FAILED', 'Up to 7 time windows are allowed.');
  end if;
  delete from public.availability_windows
   where (p_product_id is not null and product_id = p_product_id)
      or (p_category_id is not null and category_id = p_category_id);
  for w in select * from jsonb_array_elements(p_windows) loop
    if coalesce(w ->> 'start', '') !~ '^([01]\d|2[0-3]):[0-5]\d$' or coalesce(w ->> 'end', '') !~ '^([01]\d|2[0-3]):[0-5]\d$'
       or w ->> 'start' = w ->> 'end'
       or coalesce((w ->> 'days_mask')::int, 127) not between 1 and 127 then
      perform app.raise('VALIDATION_FAILED', 'Each time window needs different start and end times (HH:MM) and at least one day.');
    end if;
    insert into public.availability_windows (product_id, category_id, days_mask, start_time, end_time)
    values (p_product_id, p_category_id, coalesce((w ->> 'days_mask')::smallint, 127), (w ->> 'start')::time, (w ->> 'end')::time);
  end loop;
end $$;

create function app.product_json(p_product_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'category_id', p.category_id, 'kind', p.kind, 'name', p.name, 'description', p.description,
    'image_path', p.image_path, 'accent_color', p.accent_color, 'prep_minutes', p.prep_minutes,
    'is_featured', p.is_featured, 'is_sold_out', p.is_sold_out, 'is_active', p.is_active,
    'variants', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'price_paise', v.price_paise,
                          'is_default', v.is_default) order by v.sort_order)
                          from public.product_variants v where v.product_id = p.id and v.archived_at is null), '[]'),
    'modifier_group_ids', coalesce((select jsonb_agg(g.group_id order by g.sort_order)
                          from public.product_modifier_groups g where g.product_id = p.id), '[]'),
    'windows', coalesce((select jsonb_agg(jsonb_build_object('days_mask', w.days_mask, 'start', to_char(w.start_time, 'HH24:MI'),
                          'end', to_char(w.end_time, 'HH24:MI')) order by w.start_time)
                          from public.availability_windows w where w.product_id = p.id), '[]'),
    'combo_components', coalesce((select jsonb_agg(jsonb_build_object('product_id', c.component_product_id,
                          'variant_id', c.component_variant_id, 'qty', c.qty) order by c.sort_order)
                          from public.combo_components c where c.combo_product_id = p.id), '[]'))
  from public.products p where p.id = p_product_id
$$;

-- ----------------------------------------------------------------------------
-- Categories
-- ----------------------------------------------------------------------------
create function public.upsert_category(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  ctx     app.staff_context := app.require_role('owner', 'manager');
  v_id    uuid := nullif(p ->> 'id', '')::uuid;
  v_name  text := app.text_field(p, 'name', 40);
  v_before jsonb;
begin
  if v_id is null then
    insert into public.categories (branch_id, name, sort_order, is_active)
    values (ctx.branch_id, v_name,
            coalesce((select max(sort_order) + 1 from public.categories where branch_id = ctx.branch_id), 0),
            coalesce((p ->> 'is_active')::boolean, true))
    returning id into v_id;
  else
    select to_jsonb(c) into v_before from public.categories c where id = v_id and branch_id = ctx.branch_id and archived_at is null;
    if v_before is null then perform app.raise('NOT_FOUND', 'That category doesn’t exist.'); end if;
    update public.categories set name = v_name, is_active = coalesce((p ->> 'is_active')::boolean, is_active) where id = v_id;
  end if;
  perform app.set_windows(null, v_id, p -> 'windows');
  perform app.audit(case when v_before is null then 'category.created' else 'category.updated' end, 'category', v_id::text,
                    v_before, (select to_jsonb(c) from public.categories c where id = v_id));
  perform app.bump_menu_version(ctx.branch_id);
  return v_id;
exception when unique_violation then
  perform app.raise('VALIDATION_FAILED', 'A category with that name already exists.', jsonb_build_object('fields', jsonb_build_object('name', 'taken')));
end $$;

create function public.archive_category(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager');
begin
  if exists (select 1 from public.products where category_id = p_id and archived_at is null) then
    perform app.raise('VALIDATION_FAILED', 'Move or remove the items in this category first.');
  end if;
  update public.categories set archived_at = now() where id = p_id and branch_id = ctx.branch_id and archived_at is null;
  if not found then perform app.raise('NOT_FOUND', 'That category doesn’t exist.'); end if;
  perform app.audit('category.archived', 'category', p_id::text);
  perform app.bump_menu_version(ctx.branch_id);
end $$;

create function public.reorder_categories(p_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager');
begin
  update public.categories c set sort_order = o.ord
  from unnest(p_ids) with ordinality as o(id, ord)
  where c.id = o.id and c.branch_id = ctx.branch_id;
  perform app.bump_menu_version(ctx.branch_id);
end $$;

-- ----------------------------------------------------------------------------
-- Modifier groups (reusable add-ons and free options)
-- ----------------------------------------------------------------------------
create function public.upsert_modifier_group(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  ctx       app.staff_context := app.require_role('owner', 'manager');
  v_id      uuid := nullif(p ->> 'id', '')::uuid;
  v_name    text := app.text_field(p, 'name', 40);
  v_kind    public.modifier_kind := coalesce(p ->> 'kind', 'paid_addon')::public.modifier_kind;
  v_min     int := coalesce((p ->> 'min_select')::int, 0);
  v_max     int := coalesce((p ->> 'max_select')::int, 1);
  v_opts    jsonb := coalesce(p -> 'options', '[]');
  o         jsonb;
  v_keep    uuid[] := '{}';
  v_opt_id  uuid;
  v_i       int := 0;
  v_before  jsonb;
begin
  if jsonb_typeof(v_opts) <> 'array' or jsonb_array_length(v_opts) = 0 or jsonb_array_length(v_opts) > 20 then
    perform app.raise('VALIDATION_FAILED', 'Add between 1 and 20 options.');
  end if;
  if v_min < 0 or v_max < 1 or v_min > v_max or v_max > jsonb_array_length(v_opts) then
    perform app.raise('VALIDATION_FAILED', 'Minimum and maximum choices must fit the number of options.');
  end if;
  if (select count(*) from jsonb_array_elements(v_opts) x where (x ->> 'is_default')::boolean) > v_max then
    perform app.raise('VALIDATION_FAILED', 'More options are pre-selected than customers may choose.');
  end if;

  if v_id is null then
    insert into public.modifier_groups (branch_id, name, kind, min_select, max_select)
    values (ctx.branch_id, v_name, v_kind, v_min, v_max) returning id into v_id;
  else
    select jsonb_build_object('group', to_jsonb(g)) into v_before from public.modifier_groups g
     where id = v_id and branch_id = ctx.branch_id and archived_at is null;
    if v_before is null then perform app.raise('NOT_FOUND', 'That option group doesn’t exist.'); end if;
    update public.modifier_groups set name = v_name, kind = v_kind, min_select = v_min, max_select = v_max where id = v_id;
  end if;

  for o in select * from jsonb_array_elements(v_opts) loop
    v_i := v_i + 1;
    if v_kind = 'free_option' and coalesce((o ->> 'price_paise')::bigint, 0) <> 0 then
      perform app.raise('VALIDATION_FAILED', 'Free options (like ice level) can’t have a price.');
    end if;
    v_opt_id := nullif(o ->> 'id', '')::uuid;
    if v_opt_id is not null and exists (select 1 from public.modifier_options where id = v_opt_id and group_id = v_id) then
      update public.modifier_options
         set name = app.text_field(o, 'name', 40), price_paise = coalesce((o ->> 'price_paise')::bigint, 0),
             is_default = coalesce((o ->> 'is_default')::boolean, false), sort_order = v_i, archived_at = null
       where id = v_opt_id;
    else
      insert into public.modifier_options (group_id, name, price_paise, is_default, sort_order)
      values (v_id, app.text_field(o, 'name', 40), coalesce((o ->> 'price_paise')::bigint, 0),
              coalesce((o ->> 'is_default')::boolean, false), v_i)
      returning id into v_opt_id;
    end if;
    v_keep := v_keep || v_opt_id;
  end loop;
  update public.modifier_options set archived_at = now()
   where group_id = v_id and archived_at is null and not (id = any (v_keep));

  perform app.audit(case when v_before is null then 'option_group.created' else 'option_group.updated' end,
                    'modifier_group', v_id::text, v_before, p);
  perform app.bump_menu_version(ctx.branch_id);
  return v_id;
end $$;

create function public.archive_modifier_group(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager');
begin
  update public.modifier_groups set archived_at = now() where id = p_id and branch_id = ctx.branch_id and archived_at is null;
  if not found then perform app.raise('NOT_FOUND', 'That option group doesn’t exist.'); end if;
  delete from public.product_modifier_groups where group_id = p_id;
  perform app.audit('option_group.archived', 'modifier_group', p_id::text);
  perform app.bump_menu_version(ctx.branch_id);
end $$;

-- ----------------------------------------------------------------------------
-- Products
-- ----------------------------------------------------------------------------
create function public.upsert_product(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ctx          app.staff_context := app.require_role('owner', 'manager');
  v_id         uuid := nullif(p ->> 'id', '')::uuid;
  v_cat        uuid := nullif(p ->> 'category_id', '')::uuid;
  v_kind       public.product_kind := coalesce(p ->> 'kind', 'item')::public.product_kind;
  v_variants   jsonb := coalesce(p -> 'variants', '[]');
  v_before     jsonb;
  v            jsonb;
  v_var_id     uuid;
  v_old_price  bigint;
  v_new_price  bigint;
  v_keep       uuid[] := '{}';
  v_i          int := 0;
  v_has_default boolean;
  v_limit_bp   int := coalesce((app.setting(ctx.branch_id, 'price_drop_owner_approval_bp'))::int, 5000);
  v_pending    jsonb := '[]';
  v_approval   uuid;
  v_name       text := app.text_field(p, 'name', 80);
  v_desc       text := app.text_field(p, 'description', 300, false);
  c            jsonb;
begin
  if not exists (select 1 from public.categories where id = v_cat and branch_id = ctx.branch_id and archived_at is null) then
    perform app.raise('VALIDATION_FAILED', 'Choose a category.', jsonb_build_object('fields', jsonb_build_object('category_id', 'required')));
  end if;
  if jsonb_typeof(v_variants) <> 'array' or jsonb_array_length(v_variants) not between 1 and 10 then
    perform app.raise('VALIDATION_FAILED', 'Add at least one size with a price (up to 10).',
                      jsonb_build_object('fields', jsonb_build_object('variants', 'required')));
  end if;
  if (select count(distinct lower(btrim(x ->> 'name'))) from jsonb_array_elements(v_variants) x) <> jsonb_array_length(v_variants) then
    perform app.raise('VALIDATION_FAILED', 'Each size needs a different name.');
  end if;
  if (select count(*) from jsonb_array_elements(v_variants) x where (x ->> 'is_default')::boolean) > 1 then
    perform app.raise('VALIDATION_FAILED', 'Only one size can be the default.');
  end if;
  v_has_default := exists (select 1 from jsonb_array_elements(v_variants) x where (x ->> 'is_default')::boolean);

  if v_id is null then
    insert into public.products (branch_id, category_id, kind, name, description, image_path, accent_color, prep_minutes,
                                 is_featured, is_active, sort_order)
    values (ctx.branch_id, v_cat, v_kind, v_name, v_desc, nullif(p ->> 'image_path', ''), nullif(p ->> 'accent_color', ''),
            coalesce((p ->> 'prep_minutes')::smallint, 5), coalesce((p ->> 'is_featured')::boolean, false),
            coalesce((p ->> 'is_active')::boolean, true),
            coalesce((select max(sort_order) + 1 from public.products where category_id = v_cat), 0))
    returning id into v_id;
  else
    if not exists (select 1 from public.products where id = v_id and branch_id = ctx.branch_id and archived_at is null) then
      perform app.raise('NOT_FOUND', 'That item doesn’t exist.');
    end if;
    v_before := app.product_json(v_id);
    update public.products
       set category_id = v_cat, kind = v_kind, name = v_name, description = v_desc,
           image_path = nullif(p ->> 'image_path', ''), accent_color = nullif(p ->> 'accent_color', ''),
           prep_minutes = coalesce((p ->> 'prep_minutes')::smallint, prep_minutes),
           is_featured = coalesce((p ->> 'is_featured')::boolean, is_featured),
           is_active = coalesce((p ->> 'is_active')::boolean, is_active)
     where id = v_id;
  end if;

  -- Sizes: update existing, add new, archive removed. Large price drops by non-Owners wait for approval.
  update public.product_variants set is_default = false where product_id = v_id;
  for v in select * from jsonb_array_elements(v_variants) loop
    v_i := v_i + 1;
    v_new_price := (v ->> 'price_paise')::bigint;
    if v_new_price is null or v_new_price < 0 or v_new_price > 10000000 then
      perform app.raise('VALIDATION_FAILED', 'Every size needs a price between ₹0 and ₹1,00,000.');
    end if;
    v_var_id := nullif(v ->> 'id', '')::uuid;
    select price_paise into v_old_price from public.product_variants where id = v_var_id and product_id = v_id and archived_at is null;
    if v_old_price is not null then
      if ctx.role <> 'owner' and v_old_price > 0 and v_new_price < v_old_price
         and (v_old_price - v_new_price) * 10000 > v_old_price * v_limit_bp then
        insert into public.approval_requests (branch_id, kind, payload, summary, requested_by)
        values (ctx.branch_id, 'price_drop_large',
                jsonb_build_object('variant_id', v_var_id, 'product_id', v_id, 'old_price_paise', v_old_price, 'new_price_paise', v_new_price),
                format('%s (%s): ₹%s → ₹%s', v_name, btrim(v ->> 'name'), v_old_price / 100.0, v_new_price / 100.0), ctx.staff_id)
        returning id into v_approval;
        v_pending := v_pending || jsonb_build_object('approval_id', v_approval, 'variant', btrim(v ->> 'name'));
        v_new_price := v_old_price;  -- keep selling at the old price until the Owner approves
      end if;
      update public.product_variants
         set name = app.text_field(v, 'name', 40), price_paise = v_new_price, sort_order = v_i,
             is_default = coalesce((v ->> 'is_default')::boolean, false) or (not v_has_default and v_i = 1)
       where id = v_var_id;
      if v_new_price <> v_old_price then
        perform app.audit('product.price_changed', 'product_variant', v_var_id::text,
                          jsonb_build_object('price_paise', v_old_price), jsonb_build_object('price_paise', v_new_price));
      end if;
    else
      insert into public.product_variants (product_id, name, price_paise, is_default, sort_order)
      values (v_id, app.text_field(v, 'name', 40), v_new_price,
              coalesce((v ->> 'is_default')::boolean, false) or (not v_has_default and v_i = 1), v_i)
      returning id into v_var_id;
    end if;
    v_keep := v_keep || v_var_id;
  end loop;
  update public.product_variants set archived_at = now(), is_default = false
   where product_id = v_id and archived_at is null and not (id = any (v_keep));

  -- Option groups
  if p ? 'modifier_group_ids' then
    if exists (select 1 from jsonb_array_elements_text(p -> 'modifier_group_ids') gid
               where not exists (select 1 from public.modifier_groups g where g.id = gid::uuid and g.branch_id = ctx.branch_id and g.archived_at is null)) then
      perform app.raise('VALIDATION_FAILED', 'One of the option groups no longer exists.');
    end if;
    delete from public.product_modifier_groups where product_id = v_id;
    insert into public.product_modifier_groups (product_id, group_id, sort_order)
    select v_id, gid::uuid, ord from jsonb_array_elements_text(p -> 'modifier_group_ids') with ordinality as t(gid, ord);
  end if;

  -- Combo contents
  delete from public.combo_components where combo_product_id = v_id;
  if v_kind = 'combo' then
    if jsonb_array_length(coalesce(p -> 'combo_components', '[]')) < 2 then
      perform app.raise('VALIDATION_FAILED', 'A combo needs at least two items.');
    end if;
    v_i := 0;
    for c in select * from jsonb_array_elements(p -> 'combo_components') loop
      v_i := v_i + 1;
      if not exists (select 1 from public.products x where x.id = (c ->> 'product_id')::uuid and x.branch_id = ctx.branch_id
                     and x.kind = 'item' and x.archived_at is null) then
        perform app.raise('VALIDATION_FAILED', 'Combos can only contain regular menu items.');
      end if;
      if nullif(c ->> 'variant_id', '') is not null and not exists (
           select 1 from public.product_variants x where x.id = (c ->> 'variant_id')::uuid
           and x.product_id = (c ->> 'product_id')::uuid and x.archived_at is null) then
        perform app.raise('VALIDATION_FAILED', 'That size doesn’t belong to the chosen item.');
      end if;
      insert into public.combo_components (combo_product_id, component_product_id, component_variant_id, qty, sort_order)
      values (v_id, (c ->> 'product_id')::uuid, nullif(c ->> 'variant_id', '')::uuid, coalesce((c ->> 'qty')::smallint, 1), v_i);
    end loop;
  end if;

  perform app.set_windows(v_id, null, p -> 'windows');
  perform app.audit(case when v_before is null then 'product.created' else 'product.updated' end, 'product', v_id::text,
                    v_before, app.product_json(v_id));
  perform app.bump_menu_version(ctx.branch_id);
  return jsonb_build_object('product_id', v_id, 'pending_approvals', v_pending);
exception when unique_violation then
  perform app.raise('VALIDATION_FAILED', 'Only one size can be the default.');
end $$;

create function public.archive_product(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager');
begin
  update public.products set archived_at = now() where id = p_id and branch_id = ctx.branch_id and archived_at is null;
  if not found then perform app.raise('NOT_FOUND', 'That item doesn’t exist.'); end if;
  delete from public.combo_components where component_product_id = p_id;
  perform app.audit('product.archived', 'product', p_id::text);
  perform app.bump_menu_version(ctx.branch_id);
end $$;

create function public.reorder_products(p_category_id uuid, p_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager');
begin
  update public.products pr set sort_order = o.ord
  from unnest(p_ids) with ordinality as o(id, ord)
  where pr.id = o.id and pr.category_id = p_category_id and pr.branch_id = ctx.branch_id;
  perform app.bump_menu_version(ctx.branch_id);
end $$;

-- Quick "86" toggles for the counter (Phase 2 decision 9: Cashiers only get this).
create function public.set_product_sold_out(p_id uuid, p_sold_out boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager', 'cashier');
begin
  update public.products set is_sold_out = p_sold_out where id = p_id and branch_id = ctx.branch_id and archived_at is null;
  if not found then perform app.raise('NOT_FOUND', 'That item doesn’t exist.'); end if;
  perform app.audit(case when p_sold_out then 'product.sold_out' else 'product.back_in_stock' end, 'product', p_id::text);
  perform app.bump_menu_version(ctx.branch_id);
end $$;

create function public.set_option_sold_out(p_id uuid, p_sold_out boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner', 'manager', 'cashier');
begin
  update public.modifier_options o set is_sold_out = p_sold_out
  from public.modifier_groups g
  where o.id = p_id and g.id = o.group_id and g.branch_id = ctx.branch_id and o.archived_at is null;
  if not found then perform app.raise('NOT_FOUND', 'That option doesn’t exist.'); end if;
  perform app.audit(case when p_sold_out then 'option.sold_out' else 'option.back_in_stock' end, 'modifier_option', p_id::text);
  perform app.bump_menu_version(ctx.branch_id);
end $$;

-- ----------------------------------------------------------------------------
-- Owner approvals (maker–checker, Revision 2 R2)
-- ----------------------------------------------------------------------------
create function public.decide_approval(p_id uuid, p_approve boolean, p_note text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  ctx  app.staff_context := app.require_role('owner');
  r    public.approval_requests;
  v_current bigint;
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
-- Public menu snapshot (Phase 7 §2.2). Served by the API with CDN caching, so a
-- QR scan normally costs zero database reads (Phase 4 O3).
-- Contains nothing private: no coupon codes, costs or staff data.
-- ----------------------------------------------------------------------------
create function app.menu_snapshot(p_branch_slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with b as (select * from public.branches where slug = p_branch_slug and is_active)
  select jsonb_build_object(
    'version', b.menu_version,
    'branch', jsonb_build_object(
      'slug', b.slug, 'name', b.name, 'address', b.address, 'phone', b.phone,
      'hours', coalesce((select jsonb_agg(jsonb_build_object('weekday', h.weekday, 'opens', to_char(h.opens_at, 'HH24:MI'),
                         'closes', to_char(h.closes_at, 'HH24:MI')) order by h.weekday, h.opens_at)
                         from public.business_hours h where h.branch_id = b.id), '[]'),
      'closures', coalesce((select jsonb_agg(jsonb_build_object('starts_at', c.starts_at, 'ends_at', c.ends_at) order by c.starts_at)
                         from public.store_closures c where c.branch_id = b.id and c.ends_at > now()), '[]'),
      'last_order_buffer_min', (select value from public.settings where branch_id = b.id and key = 'last_order_buffer_min'),
      'delivery_enabled', (select value from public.settings where branch_id = b.id and key = 'delivery_enabled')),
    'categories', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name,
        'windows', coalesce((select jsonb_agg(jsonb_build_object('days_mask', w.days_mask, 'start', to_char(w.start_time, 'HH24:MI'),
                    'end', to_char(w.end_time, 'HH24:MI'))) from public.availability_windows w where w.category_id = c.id), '[]'))
        order by c.sort_order, c.name)
      from public.categories c where c.branch_id = b.id and c.is_active and c.archived_at is null), '[]'),
    'products', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'category_id', p.category_id, 'kind', p.kind, 'name', p.name, 'description', p.description,
        'image', p.image_path, 'accent', p.accent_color, 'featured', p.is_featured, 'sold_out', p.is_sold_out,
        'prep_minutes', p.prep_minutes,
        'windows', coalesce((select jsonb_agg(jsonb_build_object('days_mask', w.days_mask, 'start', to_char(w.start_time, 'HH24:MI'),
                    'end', to_char(w.end_time, 'HH24:MI'))) from public.availability_windows w where w.product_id = p.id), '[]'),
        'variants', (select jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'price_paise', v.price_paise,
                    'default', v.is_default) order by v.sort_order)
                    from public.product_variants v where v.product_id = p.id and v.archived_at is null),
        'modifier_groups', coalesce((select jsonb_agg(jsonb_build_object(
                    'id', g.id, 'name', g.name, 'kind', g.kind, 'min', g.min_select, 'max', g.max_select,
                    'options', (select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'price_paise', o.price_paise,
                                'default', o.is_default, 'sold_out', o.is_sold_out) order by o.sort_order)
                                from public.modifier_options o where o.group_id = g.id and o.archived_at is null))
                    order by pmg.sort_order)
                    from public.product_modifier_groups pmg join public.modifier_groups g on g.id = pmg.group_id and g.archived_at is null
                    where pmg.product_id = p.id), '[]'),
        'combo', coalesce((select jsonb_agg(jsonb_build_object('product_id', cc.component_product_id,
                    'variant_id', cc.component_variant_id, 'qty', cc.qty) order by cc.sort_order)
                    from public.combo_components cc where cc.combo_product_id = p.id), '[]'))
        order by c.sort_order, p.sort_order, p.name)
      from public.products p join public.categories c on c.id = p.category_id and c.is_active and c.archived_at is null
      where p.branch_id = b.id and p.is_active and p.archived_at is null
        and exists (select 1 from public.product_variants v where v.product_id = p.id and v.archived_at is null)), '[]'))
  from b
$$;

-- ----------------------------------------------------------------------------
-- RLS & privileges
-- ----------------------------------------------------------------------------
alter table public.categories              enable row level security;
alter table public.products                enable row level security;
alter table public.product_variants        enable row level security;
alter table public.modifier_groups         enable row level security;
alter table public.modifier_options        enable row level security;
alter table public.product_modifier_groups enable row level security;
alter table public.combo_components        enable row level security;
alter table public.availability_windows    enable row level security;
alter table public.approval_requests       enable row level security;

create policy categories_read on public.categories for select to authenticated
  using (branch_id = (select app.current_branch_id()));
create policy products_read on public.products for select to authenticated
  using (branch_id = (select app.current_branch_id()));
create policy variants_read on public.product_variants for select to authenticated
  using (exists (select 1 from public.products p where p.id = product_id and p.branch_id = (select app.current_branch_id())));
create policy groups_read on public.modifier_groups for select to authenticated
  using (branch_id = (select app.current_branch_id()));
create policy options_read on public.modifier_options for select to authenticated
  using (exists (select 1 from public.modifier_groups g where g.id = group_id and g.branch_id = (select app.current_branch_id())));
create policy pmg_read on public.product_modifier_groups for select to authenticated
  using (exists (select 1 from public.products p where p.id = product_id and p.branch_id = (select app.current_branch_id())));
create policy combo_read on public.combo_components for select to authenticated
  using (exists (select 1 from public.products p where p.id = combo_product_id and p.branch_id = (select app.current_branch_id())));
create policy windows_read on public.availability_windows for select to authenticated
  using (exists (select 1 from public.products p where p.id = product_id and p.branch_id = (select app.current_branch_id()))
      or exists (select 1 from public.categories c where c.id = category_id and c.branch_id = (select app.current_branch_id())));
create policy approvals_read on public.approval_requests for select to authenticated
  using (branch_id = (select app.current_branch_id())
         and ((select app.current_role()) = 'owner' or requested_by = (select app.current_staff_id())));

revoke all on public.categories, public.products, public.product_variants, public.modifier_groups, public.modifier_options,
  public.product_modifier_groups, public.combo_components, public.availability_windows, public.approval_requests
  from anon, authenticated;
grant select on public.categories, public.products, public.product_variants, public.modifier_groups, public.modifier_options,
  public.product_modifier_groups, public.combo_components, public.availability_windows, public.approval_requests
  to authenticated;

-- Supabase grants EXECUTE on new functions to the API roles by default: revoke, then
-- grant back exactly what each role needs.
revoke execute on function
  app.bump_menu_version(uuid), app.setting(uuid, text), app.text_field(jsonb, text, int, boolean),
  app.set_windows(uuid, uuid, jsonb), app.product_json(uuid), app.menu_snapshot(text),
  public.upsert_category(jsonb), public.archive_category(uuid), public.reorder_categories(uuid[]),
  public.upsert_modifier_group(jsonb), public.archive_modifier_group(uuid),
  public.upsert_product(jsonb), public.archive_product(uuid), public.reorder_products(uuid, uuid[]),
  public.set_product_sold_out(uuid, boolean), public.set_option_sold_out(uuid, boolean),
  public.decide_approval(uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function
  public.upsert_category(jsonb), public.archive_category(uuid), public.reorder_categories(uuid[]),
  public.upsert_modifier_group(jsonb), public.archive_modifier_group(uuid),
  public.upsert_product(jsonb), public.archive_product(uuid), public.reorder_products(uuid, uuid[]),
  public.set_product_sold_out(uuid, boolean), public.set_option_sold_out(uuid, boolean),
  public.decide_approval(uuid, boolean, text)
  to authenticated;
grant execute on function app.menu_snapshot(text) to service_role;
