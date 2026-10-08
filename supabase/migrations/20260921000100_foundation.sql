-- ============================================================================
-- M1 Foundation: branches, settings, hours, staff, devices, PIN sessions,
-- rate limits and the hash-chained audit log.
-- Design: docs/PHASE-4-DATABASE.md (§2.1, §2.2, §2.11, Revision 2), docs/PHASE-8-SECURITY.md
--
-- Conventions
--   * Tables live in `public` with RLS on and NO write policies: every write goes
--     through a SECURITY DEFINER function that checks the role, validates, and audits.
--   * Internal helpers live in schema `app`, which is not exposed over the REST API.
--     `app.*` functions meant for Edge Functions are granted to service_role only.
--   * Errors are raised as SQLSTATE P0001 with MESSAGE = an API error code
--     (docs/PHASE-7-API.md §1.6), DETAIL = a human message, HINT = JSON details.
--   * Every function pins `search_path = ''` and schema-qualifies all references.
--
-- Deviations from the Phase 4 document (implementation detail, same guarantees):
--   * Owner/Manager 2FA secrets are stored by Supabase Auth MFA (encrypted), so
--     there is no `totp_secret_enc` column.
--   * PINs are hashed with bcrypt (pgcrypto) instead of Argon2id so they can be checked
--     inside the database, and per-branch PIN uniqueness is checked by comparing hashes
--     instead of a peppered fingerprint. A 4-digit PIN's real protection is the device
--     binding + 5-try lockout; hash strength can't change a 10,000-value keyspace.
-- ============================================================================

create schema if not exists app;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;

revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Utilities
-- ----------------------------------------------------------------------------

-- Time-ordered UUIDs (Phase 4 O1). Postgres < 18 has no built-in uuidv7().
create function app.uuid_v7() returns uuid
language plpgsql volatile set search_path = '' as $$
declare
  ts bigint := floor(extract(epoch from clock_timestamp()) * 1000);
  b  bytea  := extensions.gen_random_bytes(16);
begin
  b := set_byte(b, 0, ((ts >> 40) & 255)::int);
  b := set_byte(b, 1, ((ts >> 32) & 255)::int);
  b := set_byte(b, 2, ((ts >> 24) & 255)::int);
  b := set_byte(b, 3, ((ts >> 16) & 255)::int);
  b := set_byte(b, 4, ((ts >> 8) & 255)::int);
  b := set_byte(b, 5, (ts & 255)::int);
  b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112);  -- version 7
  b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128);  -- RFC 4122 variant
  return encode(b, 'hex')::uuid;
end $$;

-- Raise an API error. Never returns.
create function app.raise(p_code text, p_message text, p_details jsonb default null) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception using
    errcode = 'P0001',
    message = p_code,
    detail  = p_message,
    hint    = coalesce(p_details::text, '');
end $$;

create function app.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
create type public.staff_role as enum ('owner', 'manager', 'cashier', 'kitchen');
create type public.actor_type as enum ('staff', 'system');

-- ----------------------------------------------------------------------------
-- Branches, settings, hours
-- ----------------------------------------------------------------------------
create table public.branches (
  id          uuid primary key default app.uuid_v7(),
  slug        text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name        text not null check (length(name) between 1 and 120),
  address     text not null default '',
  pincode     text check (pincode ~ '^\d{6}$'),
  phone       text,
  email       text,
  lat         numeric(9, 6) check (lat between -90 and 90),
  lng         numeric(9, 6) check (lng between -180 and 180),
  timezone    text not null default 'Asia/Kolkata',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger branches_updated_at before update on public.branches
  for each row execute function app.touch_updated_at();

-- One row per configurable rule. Mirrors packages/core/src/settings.ts
-- (a test asserts both stay in sync).
create table public.setting_definitions (
  key            text primary key,
  value_type     text not null check (value_type in ('boolean', 'integer', 'string', 'enum')),
  nullable       boolean not null default false,
  min_value      bigint,
  max_value      bigint,
  allowed        text[],
  pattern        text,
  max_length     int,
  default_value  jsonb not null,
  description    text not null
);

create table public.settings (
  branch_id   uuid not null references public.branches (id),
  key         text not null references public.setting_definitions (key),
  value       jsonb not null,
  updated_by  uuid,
  updated_at  timestamptz not null default now(),
  primary key (branch_id, key)
);

create table public.business_hours (
  id          uuid primary key default app.uuid_v7(),
  branch_id   uuid not null references public.branches (id),
  weekday     smallint not null check (weekday between 0 and 6),
  opens_at    time not null,
  closes_at   time not null,
  created_at  timestamptz not null default now()
);
create index business_hours_branch_idx on public.business_hours (branch_id, weekday);

create table public.store_closures (
  id          uuid primary key default app.uuid_v7(),
  branch_id   uuid not null references public.branches (id),
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  reason      text not null check (length(reason) between 1 and 200),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index store_closures_branch_idx on public.store_closures (branch_id, ends_at);

-- ----------------------------------------------------------------------------
-- Staff, roles, devices, PIN sessions
-- ----------------------------------------------------------------------------
create table public.staff (
  id                uuid primary key default app.uuid_v7(),
  auth_user_id      uuid unique,              -- Supabase Auth user (Owner/Manager)
  name              text not null check (length(btrim(name)) between 1 and 60),
  email             extensions.citext unique,
  pin_hash          text,                     -- bcrypt (Cashier/Kitchen)
  pin_changed_at    timestamptz,
  failed_pin_count  smallint not null default 0 check (failed_pin_count >= 0),
  locked_until      timestamptz,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (auth_user_id is not null or pin_hash is not null)
);
create trigger staff_updated_at before update on public.staff
  for each row execute function app.touch_updated_at();

create table public.staff_branch_roles (
  staff_id    uuid not null references public.staff (id),
  branch_id   uuid not null references public.branches (id),
  role        public.staff_role not null,
  created_at  timestamptz not null default now(),
  primary key (staff_id, branch_id)
);
create index staff_branch_roles_branch_idx on public.staff_branch_roles (branch_id, role);

create table public.devices (
  id                  uuid primary key default app.uuid_v7(),
  branch_id           uuid not null references public.branches (id),
  name                text not null check (length(btrim(name)) between 1 and 60),
  allowed_roles       public.staff_role[] not null
                        check (cardinality(allowed_roles) > 0
                               and allowed_roles <@ array['cashier', 'kitchen']::public.staff_role[]),
  secret_hash         text unique,            -- sha256 of the device cookie secret; null until paired
  pairing_code_hash   text,
  pairing_expires_at  timestamptz,
  paired_at           timestamptz,
  registered_by       uuid not null references public.staff (id),
  last_seen_at        timestamptz,
  revoked_at          timestamptz,
  created_at          timestamptz not null default now()
);
create unique index devices_pending_code_idx on public.devices (pairing_code_hash)
  where pairing_code_hash is not null;

create table public.staff_sessions (
  id            uuid primary key default app.uuid_v7(),
  staff_id      uuid not null references public.staff (id),
  device_id     uuid not null references public.devices (id),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz
);
create index staff_sessions_staff_idx on public.staff_sessions (staff_id) where revoked_at is null;
create index staff_sessions_device_idx on public.staff_sessions (device_id) where revoked_at is null;

-- ----------------------------------------------------------------------------
-- Rate limits (fixed window). Used by Edge Functions and database functions.
-- ----------------------------------------------------------------------------
create table app.rate_limits (
  bucket        text not null,
  window_start  timestamptz not null,
  hits          int not null,
  primary key (bucket, window_start)
);

-- Returns true if this hit is allowed.
create function app.hit_rate_limit(p_bucket text, p_limit int, p_window_seconds int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_window timestamptz := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);
  v_hits int;
begin
  insert into app.rate_limits as r (bucket, window_start, hits)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1
  returning hits into v_hits;
  return v_hits <= p_limit;
end $$;

-- ----------------------------------------------------------------------------
-- Audit log: append-only and hash-chained (Phase 4 R7).
-- row_hash = sha256(prev_hash || canonical JSON of the row). Deleting, editing or
-- reordering any row breaks the chain; app.verify_audit_chain() finds it.
-- ----------------------------------------------------------------------------
create table app.hash_chains (
  name       text primary key,
  last_id    bigint,
  last_hash  bytea
);
insert into app.hash_chains (name) values ('audit');

create table public.audit_logs (
  id           bigint primary key,
  branch_id    uuid,
  actor_type   public.actor_type not null,
  staff_id     uuid,
  device_id    uuid,
  action       text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  entity_type  text,
  entity_id    text,
  before       jsonb,
  after        jsonb,
  reason       text,
  created_at   timestamptz not null,
  prev_hash    bytea,
  row_hash     bytea not null
);
create sequence app.audit_logs_id_seq;
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id, id);
create index audit_logs_created_idx on public.audit_logs (created_at);

create function app.audit_payload(r public.audit_logs) returns bytea
language sql immutable set search_path = '' as $$
  select convert_to(jsonb_build_object(
    'id', r.id, 'branch_id', r.branch_id, 'actor_type', r.actor_type, 'staff_id', r.staff_id,
    'device_id', r.device_id, 'action', r.action, 'entity_type', r.entity_type,
    'entity_id', r.entity_id, 'before', r.before, 'after', r.after, 'reason', r.reason,
    'created_us', (extract(epoch from r.created_at) * 1000000)::bigint
  )::text, 'UTF8')
$$;

create function app.block_audit_changes() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = 'FORBIDDEN',
    detail = 'The audit log is append-only.';
end $$;

create trigger audit_logs_no_update before update or delete on public.audit_logs
  for each row execute function app.block_audit_changes();
create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function app.block_audit_changes();

-- ----------------------------------------------------------------------------
-- Who is calling? (JWT claims, validated against the database every time)
--
-- Owner/Manager: Supabase Auth session; claims added by custom_access_token_hook.
-- Cashier/Kitchen: JWT minted by the pin-login Edge Function with `pin_session_id`.
-- Claims are never trusted on their own: role, active status and session are re-read.
-- ----------------------------------------------------------------------------
create function app.claims() returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create type app.staff_context as (
  staff_id   uuid,
  branch_id  uuid,
  role       public.staff_role,
  device_id  uuid,
  session_id uuid
);

create function app.current_staff() returns app.staff_context
language plpgsql stable security definer set search_path = '' as $$
declare
  c          jsonb := app.claims();
  v_staff    uuid;
  v_branch   uuid;
  v_role     public.staff_role;
  v_session  uuid;
  v_device   uuid;
  ctx        app.staff_context;
begin
  begin
    v_staff   := (c ->> 'staff_id')::uuid;
    v_branch  := (c ->> 'branch_id')::uuid;
    v_session := (c ->> 'pin_session_id')::uuid;
  exception when invalid_text_representation then
    return null;
  end;
  if v_staff is null or v_branch is null then
    return null;
  end if;

  select r.role into v_role
  from public.staff s
  join public.staff_branch_roles r on r.staff_id = s.id and r.branch_id = v_branch
  join public.branches b on b.id = r.branch_id and b.is_active
  where s.id = v_staff and s.is_active;
  if v_role is null then
    return null;
  end if;

  if v_session is not null then
    -- PIN session: must be live, on a live device, for a PIN role.
    select ss.device_id into v_device
    from public.staff_sessions ss
    join public.devices d on d.id = ss.device_id and d.revoked_at is null and d.branch_id = v_branch
    where ss.id = v_session and ss.staff_id = v_staff
      and ss.revoked_at is null and ss.expires_at > now();
    if v_device is null or v_role not in ('cashier', 'kitchen') then
      return null;
    end if;
  else
    -- Email login: the token's subject must be this staff member's auth user.
    if not exists (
      select 1 from public.staff s
      where s.id = v_staff and s.auth_user_id::text = c ->> 'sub'
    ) then
      return null;
    end if;
    -- Owner accounts always require a completed 2FA session (Phase 8 §3.1).
    if v_role = 'owner' and coalesce(c ->> 'aal', '') <> 'aal2' then
      return null;
    end if;
  end if;

  ctx := row(v_staff, v_branch, v_role, v_device, v_session)::app.staff_context;
  return ctx;
end $$;

create function app.current_staff_id() returns uuid
language sql stable set search_path = '' as $$ select (app.current_staff()).staff_id $$;

create function app.current_branch_id() returns uuid
language sql stable set search_path = '' as $$ select (app.current_staff()).branch_id $$;

create function app.current_role() returns public.staff_role
language sql stable set search_path = '' as $$ select (app.current_staff()).role $$;

-- Raise unless the caller has one of the roles; returns the caller context.
create function app.require_role(variadic p_roles public.staff_role[]) returns app.staff_context
language plpgsql stable set search_path = '' as $$
declare
  ctx app.staff_context := app.current_staff();
begin
  if ctx.staff_id is null then
    perform app.raise('UNAUTHENTICATED', 'Please sign in again.');
  end if;
  if not (ctx.role = any (p_roles)) then
    perform app.raise('FORBIDDEN', 'You don’t have permission to do that.');
  end if;
  return ctx;
end $$;

-- Step-up 2FA for sensitive actions (Phase 8 S2): a TOTP verification in the last 15 minutes.
create function app.require_recent_mfa(p_minutes int default 15) returns void
language plpgsql stable set search_path = '' as $$
declare
  c jsonb := app.claims();
begin
  if not exists (
    select 1 from jsonb_array_elements(coalesce(c -> 'amr', '[]'::jsonb)) m
    where m ->> 'method' = 'totp'
      and (m ->> 'timestamp')::bigint >= extract(epoch from now() - make_interval(mins => p_minutes))
  ) then
    perform app.raise('FORBIDDEN', 'Please confirm with your 2FA code to continue.',
                      jsonb_build_object('reason', 'step_up_required'));
  end if;
end $$;

-- Write one audit row, extending the hash chain. Serialised by locking the chain head.
create function app.audit(
  p_action      text,
  p_entity_type text,
  p_entity_id   text,
  p_before      jsonb default null,
  p_after       jsonb default null,
  p_reason      text default null,
  p_branch_id   uuid default null
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  ctx     app.staff_context := app.current_staff();
  v_prev  bytea;
  v_row   public.audit_logs;
begin
  select last_hash into v_prev from app.hash_chains where name = 'audit' for update;

  v_row.id          := nextval('app.audit_logs_id_seq');
  v_row.branch_id   := coalesce(p_branch_id, ctx.branch_id);
  v_row.actor_type  := case when ctx.staff_id is null then 'system' else 'staff' end;
  v_row.staff_id    := ctx.staff_id;
  v_row.device_id   := ctx.device_id;
  v_row.action      := p_action;
  v_row.entity_type := p_entity_type;
  v_row.entity_id   := p_entity_id;
  v_row.before      := p_before;
  v_row.after       := p_after;
  v_row.reason      := p_reason;
  v_row.created_at  := date_trunc('microseconds', clock_timestamp());
  v_row.prev_hash   := v_prev;
  v_row.row_hash    := extensions.digest(coalesce(v_prev, ''::bytea) || app.audit_payload(v_row), 'sha256');

  insert into public.audit_logs select v_row.*;
  update app.hash_chains set last_id = v_row.id, last_hash = v_row.row_hash where name = 'audit';
  return v_row.id;
end $$;

-- Returns null if the chain is intact, otherwise the id of the first bad row
-- (0 if the newest row(s) were removed).
create function app.verify_audit_chain() returns bigint
language plpgsql stable security definer set search_path = '' as $$
declare
  r       public.audit_logs;
  v_prev  bytea := null;
  v_head  app.hash_chains;
begin
  for r in select * from public.audit_logs order by id loop
    if r.prev_hash is distinct from v_prev
       or r.row_hash <> extensions.digest(coalesce(v_prev, ''::bytea) || app.audit_payload(r), 'sha256') then
      return r.id;
    end if;
    v_prev := r.row_hash;
  end loop;
  select * into v_head from app.hash_chains where name = 'audit';
  if v_head.last_hash is distinct from v_prev then
    return 0;
  end if;
  return null;
end $$;

-- ----------------------------------------------------------------------------
-- Settings
-- ----------------------------------------------------------------------------
create function app.validate_setting(p_def public.setting_definitions, p_value jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare
  t text := jsonb_typeof(p_value);
  n numeric;
  s text;
begin
  if t = 'null' then
    return case when p_def.nullable then null else 'A value is required.' end;
  end if;
  case p_def.value_type
    when 'boolean' then
      if t <> 'boolean' then return 'Must be on or off.'; end if;
    when 'integer' then
      if t <> 'number' then return 'Must be a whole number.'; end if;
      n := p_value::text::numeric;
      if n <> trunc(n) then return 'Must be a whole number.'; end if;
      if p_def.min_value is not null and n < p_def.min_value then return format('Must be at least %s.', p_def.min_value); end if;
      if p_def.max_value is not null and n > p_def.max_value then return format('Must be at most %s.', p_def.max_value); end if;
    when 'string', 'enum' then
      if t <> 'string' then return 'Must be text.'; end if;
      s := p_value #>> '{}';
      if p_def.allowed is not null and not (s = any (p_def.allowed)) then return 'Not an allowed option.'; end if;
      if p_def.max_length is not null and length(s) > p_def.max_length then return format('Must be at most %s characters.', p_def.max_length); end if;
      if p_def.pattern is not null and s !~ p_def.pattern then return 'Not in the right format.'; end if;
  end case;
  return null;
end $$;

create function app.ensure_branch_settings(p_branch_id uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.settings (branch_id, key, value)
  select p_branch_id, d.key, d.default_value from public.setting_definitions d
  on conflict do nothing
$$;

create function app.branch_settings(p_branch_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from public.settings where branch_id = p_branch_id
$$;

-- Owner-only batch update so related values (e.g. gst_enabled + gstin) change together.
create function public.update_settings(p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ctx       app.staff_context := app.require_role('owner');
  v_key     text;
  v_value   jsonb;
  v_def     public.setting_definitions;
  v_problem text;
  v_errors  jsonb := '{}'::jsonb;
  v_before  jsonb := app.branch_settings(ctx.branch_id);
  v_after   jsonb;
  v_cross   text[] := '{}';
begin
  perform app.require_recent_mfa();
  if jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    perform app.raise('VALIDATION_FAILED', 'Nothing to save.');
  end if;

  for v_key, v_value in select * from jsonb_each(p_changes) loop
    select * into v_def from public.setting_definitions where key = v_key;
    if v_def.key is null then
      v_errors := v_errors || jsonb_build_object(v_key, 'Unknown setting.');
      continue;
    end if;
    v_problem := app.validate_setting(v_def, v_value);
    if v_problem is not null then
      v_errors := v_errors || jsonb_build_object(v_key, v_problem);
    end if;
  end loop;
  if v_errors <> '{}'::jsonb then
    perform app.raise('VALIDATION_FAILED', 'Some settings are not valid.', jsonb_build_object('fields', v_errors));
  end if;

  v_after := v_before || p_changes;
  if (v_after ->> 'gst_enabled')::boolean
     and (jsonb_typeof(v_after -> 'gstin') = 'null' or jsonb_typeof(v_after -> 'legal_name') = 'null') then
    v_cross := array_append(v_cross, 'Turning on GST needs a GSTIN and a legal name.');
  end if;
  if (v_after ->> 'delivery_enabled')::boolean and (v_after ->> 'delivery_radius_m')::int = 0 then
    v_cross := array_append(v_cross, 'Set a delivery radius before turning on delivery.');
  end if;
  if cardinality(v_cross) > 0 then
    perform app.raise('VALIDATION_FAILED', v_cross[1], jsonb_build_object('problems', to_jsonb(v_cross)));
  end if;

  for v_key, v_value in select * from jsonb_each(p_changes) loop
    if (v_before -> v_key) is distinct from v_value then
      update public.settings set value = v_value, updated_by = ctx.staff_id, updated_at = now()
      where branch_id = ctx.branch_id and key = v_key;
      perform app.audit('settings.updated', 'setting', v_key,
                        jsonb_build_object('value', v_before -> v_key), jsonb_build_object('value', v_value));
    end if;
  end loop;
  return app.branch_settings(ctx.branch_id);
end $$;

-- ----------------------------------------------------------------------------
-- Business hours & closures
-- ----------------------------------------------------------------------------
create function public.set_business_hours(p_hours jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ctx     app.staff_context := app.require_role('owner');
  v_item  jsonb;
  v_before jsonb;
begin
  perform app.require_recent_mfa();
  if jsonb_typeof(p_hours) <> 'array' or jsonb_array_length(p_hours) > 21 then
    perform app.raise('VALIDATION_FAILED', 'Hours must be a list of up to 21 opening windows.');
  end if;
  for v_item in select * from jsonb_array_elements(p_hours) loop
    if not (v_item ? 'weekday' and v_item ? 'opens' and v_item ? 'closes')
       or (v_item ->> 'weekday') !~ '^[0-6]$'
       or (v_item ->> 'opens') !~ '^([01]\d|2[0-3]):[0-5]\d$'
       or (v_item ->> 'closes') !~ '^([01]\d|2[0-3]):[0-5]\d$'
       or (v_item ->> 'opens') = (v_item ->> 'closes') then
      perform app.raise('VALIDATION_FAILED', 'Each window needs a day and different opening and closing times.',
                        jsonb_build_object('window', v_item));
    end if;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('weekday', weekday, 'opens', to_char(opens_at, 'HH24:MI'),
                                               'closes', to_char(closes_at, 'HH24:MI')) order by weekday, opens_at), '[]')
    into v_before from public.business_hours where branch_id = ctx.branch_id;

  delete from public.business_hours where branch_id = ctx.branch_id;
  insert into public.business_hours (branch_id, weekday, opens_at, closes_at)
  select ctx.branch_id, (h ->> 'weekday')::smallint, (h ->> 'opens')::time, (h ->> 'closes')::time
  from jsonb_array_elements(p_hours) h;

  perform app.audit('hours.updated', 'branch', ctx.branch_id::text, v_before, p_hours);
end $$;

create function public.add_store_closure(p_starts_at timestamptz, p_ends_at timestamptz, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  ctx  app.staff_context := app.require_role('owner', 'manager');
  v_id uuid;
begin
  if p_ends_at <= p_starts_at then
    perform app.raise('VALIDATION_FAILED', 'The closure must end after it starts.');
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    perform app.raise('VALIDATION_FAILED', 'Please give a reason.');
  end if;
  insert into public.store_closures (branch_id, starts_at, ends_at, reason, created_by)
  values (ctx.branch_id, p_starts_at, p_ends_at, btrim(p_reason), ctx.staff_id)
  returning id into v_id;
  perform app.audit('closure.added', 'store_closure', v_id::text, null,
                    jsonb_build_object('starts_at', p_starts_at, 'ends_at', p_ends_at, 'reason', p_reason));
  return v_id;
end $$;

create function public.remove_store_closure(p_closure_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ctx    app.staff_context := app.require_role('owner', 'manager');
  v_row  public.store_closures;
begin
  delete from public.store_closures where id = p_closure_id and branch_id = ctx.branch_id returning * into v_row;
  if v_row.id is null then
    perform app.raise('NOT_FOUND', 'That closure doesn’t exist.');
  end if;
  perform app.audit('closure.removed', 'store_closure', v_row.id::text, to_jsonb(v_row), null);
end $$;

-- ----------------------------------------------------------------------------
-- Staff PINs & staff management
-- ----------------------------------------------------------------------------

-- Same rules as packages/core/src/pin.ts (a test runs both over the same cases).
create function app.pin_problem(p_pin text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  d int[];
  asc_ok boolean := true;
  desc_ok boolean := true;
  i int;
begin
  if p_pin is null or p_pin !~ '^\d{4}$' then return 'format'; end if;
  if p_pin ~ '^(\d)\1{3}$' then return 'repeated'; end if;
  d := array[substr(p_pin, 1, 1)::int, substr(p_pin, 2, 1)::int, substr(p_pin, 3, 1)::int, substr(p_pin, 4, 1)::int];
  for i in 2..4 loop
    asc_ok  := asc_ok  and d[i] = (d[i - 1] + 1) % 10;
    desc_ok := desc_ok and d[i] = (d[i - 1] + 9) % 10;
  end loop;
  if asc_ok or desc_ok then return 'sequence'; end if;
  if p_pin::int between 1950 and 2035 then return 'year'; end if;
  if p_pin = any (array['1212', '6969', '1004', '2580', '0852', '1122', '4321', '7777', '1313', '2323']) then
    return 'common';
  end if;
  return null;
end $$;

create function app.pin_problem_message(p_problem text) returns text
language sql immutable set search_path = '' as $$
  select case p_problem
    when 'format'   then 'PIN must be exactly 4 digits.'
    when 'repeated' then 'PIN can’t be the same digit four times.'
    when 'sequence' then 'PIN can’t be a sequence like 1234 or 4321.'
    when 'year'     then 'PIN can’t look like a year.'
    when 'common'   then 'That PIN is too common. Choose another.'
    when 'taken'    then 'Another staff member already uses that PIN. Choose another.'
  end
$$;

-- Validates a new PIN for a branch and returns its hash.
create function app.hash_new_pin(p_branch_id uuid, p_pin text, p_except_staff uuid default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_problem text := app.pin_problem(p_pin);
begin
  if v_problem is null and exists (
    select 1 from public.staff s
    join public.staff_branch_roles r on r.staff_id = s.id and r.branch_id = p_branch_id
    where s.pin_hash is not null and s.is_active
      and s.id is distinct from p_except_staff
      and extensions.crypt(p_pin, s.pin_hash) = s.pin_hash
  ) then
    v_problem := 'taken';
  end if;
  if v_problem is not null then
    perform app.raise('VALIDATION_FAILED', app.pin_problem_message(v_problem),
                      jsonb_build_object('fields', jsonb_build_object('pin', v_problem)));
  end if;
  return extensions.crypt(p_pin, extensions.gen_salt('bf', 8));
end $$;

create function app.revoke_staff_sessions(p_staff_id uuid) returns void
language sql security definer set search_path = '' as $$
  update public.staff_sessions set revoked_at = now() where staff_id = p_staff_id and revoked_at is null
$$;

-- Owner creates a Cashier or Kitchen member who signs in with a PIN on shop devices.
create function public.create_pin_staff(p_name text, p_role public.staff_role, p_pin text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  ctx   app.staff_context := app.require_role('owner');
  v_id  uuid;
begin
  perform app.require_recent_mfa();
  if p_role not in ('cashier', 'kitchen') then
    perform app.raise('VALIDATION_FAILED', 'Only cashier and kitchen staff sign in with a PIN.');
  end if;
  if length(btrim(coalesce(p_name, ''))) not between 1 and 60 then
    perform app.raise('VALIDATION_FAILED', 'Enter a name (up to 60 characters).',
                      jsonb_build_object('fields', jsonb_build_object('name', 'required')));
  end if;
  insert into public.staff (name, pin_hash, pin_changed_at)
  values (btrim(p_name), app.hash_new_pin(ctx.branch_id, p_pin), now())
  returning id into v_id;
  insert into public.staff_branch_roles (staff_id, branch_id, role) values (v_id, ctx.branch_id, p_role);
  perform app.audit('staff.created', 'staff', v_id::text, null,
                    jsonb_build_object('name', btrim(p_name), 'role', p_role));
  return v_id;
end $$;

create function public.reset_staff_pin(p_staff_id uuid, p_pin text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner');
begin
  perform app.require_recent_mfa();
  if not exists (
    select 1 from public.staff s join public.staff_branch_roles r on r.staff_id = s.id
    where s.id = p_staff_id and r.branch_id = ctx.branch_id and r.role in ('cashier', 'kitchen')
  ) then
    perform app.raise('NOT_FOUND', 'That staff member doesn’t exist.');
  end if;
  update public.staff
     set pin_hash = app.hash_new_pin(ctx.branch_id, p_pin, p_staff_id),
         pin_changed_at = now(), failed_pin_count = 0, locked_until = null
   where id = p_staff_id;
  perform app.revoke_staff_sessions(p_staff_id);
  perform app.audit('staff.pin_reset', 'staff', p_staff_id::text);  -- the PIN itself is never logged
end $$;

create function public.deactivate_staff(p_staff_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ctx     app.staff_context := app.require_role('owner');
  v_role  public.staff_role;
begin
  perform app.require_recent_mfa();
  select r.role into v_role from public.staff_branch_roles r
  join public.staff s on s.id = r.staff_id and s.is_active
  where r.staff_id = p_staff_id and r.branch_id = ctx.branch_id;
  if v_role is null then
    perform app.raise('NOT_FOUND', 'That staff member doesn’t exist.');
  end if;
  if p_staff_id = ctx.staff_id then
    perform app.raise('FORBIDDEN', 'You can’t deactivate your own account.');
  end if;
  update public.staff set is_active = false where id = p_staff_id;
  perform app.revoke_staff_sessions(p_staff_id);
  perform app.audit('staff.deactivated', 'staff', p_staff_id::text,
                    jsonb_build_object('is_active', true), jsonb_build_object('is_active', false), p_reason);
end $$;

-- Service role (Edge Function after a Supabase Auth invite): add an email-login Manager.
create function app.create_login_staff(
  p_auth_user_id uuid, p_name text, p_email text, p_role public.staff_role, p_branch_id uuid
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_role not in ('manager', 'owner') then
    perform app.raise('VALIDATION_FAILED', 'Only owners and managers sign in with email.');
  end if;
  insert into public.staff (auth_user_id, name, email) values (p_auth_user_id, btrim(p_name), p_email)
  returning id into v_id;
  insert into public.staff_branch_roles (staff_id, branch_id, role) values (v_id, p_branch_id, p_role);
  perform app.audit('staff.created', 'staff', v_id::text, null,
                    jsonb_build_object('name', btrim(p_name), 'role', p_role, 'email', p_email),
                    null, p_branch_id);
  return v_id;
end $$;

-- Service role, one-time setup: the first Owner of a branch.
create function app.bootstrap_owner(p_auth_user_id uuid, p_name text, p_email text, p_branch_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.staff_branch_roles where branch_id = p_branch_id and role = 'owner') then
    perform app.raise('FORBIDDEN', 'This branch already has an owner.');
  end if;
  perform app.ensure_branch_settings(p_branch_id);
  return app.create_login_staff(p_auth_user_id, p_name, p_email, 'owner', p_branch_id);
end $$;

-- ----------------------------------------------------------------------------
-- Shop devices: pairing, PIN login, sessions
-- ----------------------------------------------------------------------------

-- Owner registers a device; returns a one-time 6-digit pairing code valid for 10 minutes.
create function public.create_device(p_name text, p_allowed_roles public.staff_role[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ctx     app.staff_context := app.require_role('owner');
  v_code  text;
  v_id    uuid;
  v_exp   timestamptz := now() + interval '10 minutes';
begin
  perform app.require_recent_mfa();
  if length(btrim(coalesce(p_name, ''))) not between 1 and 60 then
    perform app.raise('VALIDATION_FAILED', 'Give the device a name, e.g. “Counter tablet”.');
  end if;
  if p_allowed_roles is null or cardinality(p_allowed_roles) = 0
     or not (p_allowed_roles <@ array['cashier', 'kitchen']::public.staff_role[]) then
    perform app.raise('VALIDATION_FAILED', 'Choose who can use this device: cashier and/or kitchen.');
  end if;
  loop
    v_code := lpad((abs(('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
    exit when not exists (
      select 1 from public.devices
      where pairing_code_hash = encode(extensions.digest(v_code, 'sha256'), 'hex')
    );
  end loop;
  insert into public.devices (branch_id, name, allowed_roles, pairing_code_hash, pairing_expires_at, registered_by)
  values (ctx.branch_id, btrim(p_name), p_allowed_roles,
          encode(extensions.digest(v_code, 'sha256'), 'hex'), v_exp, ctx.staff_id)
  returning id into v_id;
  perform app.audit('device.created', 'device', v_id::text, null,
                    jsonb_build_object('name', btrim(p_name), 'allowed_roles', p_allowed_roles));
  return jsonb_build_object('device_id', v_id, 'pairing_code', v_code, 'expires_at', v_exp);
end $$;

create function public.revoke_device(p_device_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.require_role('owner');
begin
  perform app.require_recent_mfa();
  update public.devices set revoked_at = now(), pairing_code_hash = null
   where id = p_device_id and branch_id = ctx.branch_id and revoked_at is null;
  if not found then
    perform app.raise('NOT_FOUND', 'That device doesn’t exist or is already revoked.');
  end if;
  update public.staff_sessions set revoked_at = now() where device_id = p_device_id and revoked_at is null;
  perform app.audit('device.revoked', 'device', p_device_id::text);
end $$;

-- Service role. The new device sends the code; the Edge Function generates a random
-- secret, stores it in an HttpOnly cookie and passes only its sha256 here.
-- Failed attempts are capped globally (20 per 10 min) against brute force.
create function app.pair_device(p_code text, p_secret_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dev public.devices;
begin
  if p_secret_hash !~ '^[0-9a-f]{64}$' then
    perform app.raise('BAD_REQUEST', 'Invalid device secret.');
  end if;
  select * into v_dev from public.devices
  where pairing_code_hash = encode(extensions.digest(coalesce(p_code, ''), 'sha256'), 'hex')
    and revoked_at is null
  for update;
  if v_dev.id is null or v_dev.pairing_expires_at <= now() then
    if not app.hit_rate_limit('pair_device_fail', 20, 600) then
      return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED');
    end if;
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  update public.devices
     set secret_hash = p_secret_hash, pairing_code_hash = null, pairing_expires_at = null,
         paired_at = now(), last_seen_at = now()
   where id = v_dev.id;
  perform app.audit('device.paired', 'device', v_dev.id::text, null, null, null, v_dev.branch_id);
  return jsonb_build_object('ok', true, 'device_id', v_dev.id, 'device_name', v_dev.name, 'branch_id', v_dev.branch_id);
end $$;

-- Service role: staff tiles to show on a paired device.
create function app.device_staff(p_secret_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dev public.devices;
begin
  select * into v_dev from public.devices where secret_hash = p_secret_hash and revoked_at is null;
  if v_dev.id is null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_REGISTERED');
  end if;
  update public.devices set last_seen_at = now() where id = v_dev.id;
  return jsonb_build_object(
    'ok', true,
    'device_name', v_dev.name,
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'role', r.role) order by s.name)
      from public.staff s join public.staff_branch_roles r on r.staff_id = s.id
      where r.branch_id = v_dev.branch_id and s.is_active and s.pin_hash is not null
        and r.role = any (v_dev.allowed_roles)
    ), '[]'::jsonb));
end $$;

-- Service role. Returns a result object (never raises for a wrong PIN) so the
-- failed-attempt counter is committed.
create function app.pin_login(p_secret_hash text, p_staff_id uuid, p_pin text, p_session_hours int default 12)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dev      public.devices;
  v_staff    public.staff;
  v_role     public.staff_role;
  v_session  uuid;
  v_expires  timestamptz := now() + make_interval(hours => p_session_hours);
  v_left     int;
begin
  select * into v_dev from public.devices where secret_hash = p_secret_hash and revoked_at is null;
  if v_dev.id is null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_REGISTERED');
  end if;

  select s.* into v_staff from public.staff s where s.id = p_staff_id and s.is_active for update;
  select r.role into v_role from public.staff_branch_roles r
   where r.staff_id = p_staff_id and r.branch_id = v_dev.branch_id;
  if v_staff.id is null or v_role is null or not (v_role = any (v_dev.allowed_roles)) or v_staff.pin_hash is null then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  end if;

  if v_staff.locked_until is not null and v_staff.locked_until > now() then
    return jsonb_build_object('ok', false, 'code', 'ACCOUNT_LOCKED', 'until', v_staff.locked_until);
  end if;

  if extensions.crypt(coalesce(p_pin, ''), v_staff.pin_hash) <> v_staff.pin_hash then
    v_left := 5 - (v_staff.failed_pin_count + 1);
    if v_left <= 0 then
      update public.staff set failed_pin_count = 0, locked_until = now() + interval '15 minutes' where id = v_staff.id;
      perform app.audit('staff.pin_locked', 'staff', v_staff.id::text, null,
                        jsonb_build_object('device_id', v_dev.id), null, v_dev.branch_id);
      return jsonb_build_object('ok', false, 'code', 'ACCOUNT_LOCKED', 'until', now() + interval '15 minutes');
    end if;
    update public.staff set failed_pin_count = failed_pin_count + 1 where id = v_staff.id;
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED', 'attempts_left', v_left);
  end if;

  update public.staff set failed_pin_count = 0, locked_until = null where id = v_staff.id;
  update public.devices set last_seen_at = now() where id = v_dev.id;
  insert into public.staff_sessions (staff_id, device_id, expires_at)
  values (v_staff.id, v_dev.id, v_expires) returning id into v_session;
  return jsonb_build_object(
    'ok', true, 'session_id', v_session, 'staff_id', v_staff.id, 'staff_name', v_staff.name,
    'branch_id', v_dev.branch_id, 'role', v_role, 'device_id', v_dev.id, 'expires_at', v_expires);
end $$;

-- A PIN session signs itself out (the idle lock / "Switch" button).
create function public.end_pin_session() returns void
language plpgsql security definer set search_path = '' as $$
declare
  ctx app.staff_context := app.current_staff();
begin
  if ctx.session_id is not null then
    update public.staff_sessions set revoked_at = now() where id = ctx.session_id and revoked_at is null;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- Supabase Auth hook: add staff claims to Owner/Manager access tokens.
-- Enable in the Supabase dashboard: Auth → Hooks → Custom Access Token.
-- ----------------------------------------------------------------------------
create function public.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
  v_row    record;
begin
  select s.id as staff_id, r.branch_id, r.role into v_row
  from public.staff s
  join public.staff_branch_roles r on r.staff_id = s.id
  where s.auth_user_id::text = event ->> 'user_id' and s.is_active and r.role in ('owner', 'manager')
  order by r.created_at
  limit 1;
  if v_row.staff_id is not null then
    v_claims := v_claims || jsonb_build_object(
      'staff_id', v_row.staff_id, 'branch_id', v_row.branch_id, 'staff_role', v_row.role);
  end if;
  return jsonb_set(event, '{claims}', v_claims);
end $$;

-- ----------------------------------------------------------------------------
-- Row-level security. Reads only; there are no write policies.
-- `(select app.fn())` makes Postgres evaluate the helper once per query.
-- ----------------------------------------------------------------------------
alter table public.branches            enable row level security;
alter table public.setting_definitions enable row level security;
alter table public.settings            enable row level security;
alter table public.business_hours      enable row level security;
alter table public.store_closures      enable row level security;
alter table public.staff               enable row level security;
alter table public.staff_branch_roles  enable row level security;
alter table public.devices             enable row level security;
alter table public.staff_sessions      enable row level security;
alter table public.audit_logs          enable row level security;

create policy branches_read on public.branches for select to authenticated
  using (id = (select app.current_branch_id()));
create policy setting_definitions_read on public.setting_definitions for select to authenticated
  using ((select app.current_staff_id()) is not null);
create policy settings_read on public.settings for select to authenticated
  using (branch_id = (select app.current_branch_id()));
create policy business_hours_read on public.business_hours for select to authenticated
  using (branch_id = (select app.current_branch_id()));
create policy store_closures_read on public.store_closures for select to authenticated
  using (branch_id = (select app.current_branch_id()));
-- Owner/Manager see the branch team; everyone else sees only themselves.
create policy staff_read on public.staff for select to authenticated
  using (
    id = (select app.current_staff_id())
    or ((select app.current_role()) in ('owner', 'manager') and exists (
      select 1 from public.staff_branch_roles r
      where r.staff_id = staff.id and r.branch_id = (select app.current_branch_id())))
  );
create policy staff_roles_read on public.staff_branch_roles for select to authenticated
  using (
    staff_id = (select app.current_staff_id())
    or ((select app.current_role()) in ('owner', 'manager') and branch_id = (select app.current_branch_id()))
  );
create policy devices_read on public.devices for select to authenticated
  using ((select app.current_role()) = 'owner' and branch_id = (select app.current_branch_id()));
create policy audit_read on public.audit_logs for select to authenticated
  using ((select app.current_role()) = 'owner' and branch_id = (select app.current_branch_id()));
-- staff_sessions: no policy at all → invisible to every API role.

-- ----------------------------------------------------------------------------
-- Privileges: deny by default, then grant exactly what is needed.
-- ----------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all tables in schema app from anon, authenticated;
revoke all on all sequences in schema app from anon, authenticated;

grant select on public.branches, public.setting_definitions, public.settings,
  public.business_hours, public.store_closures, public.staff_branch_roles, public.audit_logs
  to authenticated;
-- Column-level: PIN hashes and lockout counters are never readable over the API.
grant select (id, auth_user_id, name, email, pin_changed_at, locked_until, is_active, created_at, updated_at)
  on public.staff to authenticated;
grant select (id, branch_id, name, allowed_roles, pairing_expires_at, paired_at, registered_by,
              last_seen_at, revoked_at, created_at)
  on public.devices to authenticated;

revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema app from public, anon, authenticated;

-- Helpers used inside RLS policies run as the caller, so the caller needs EXECUTE.
grant execute on function app.claims(), app.current_staff(), app.current_staff_id(),
  app.current_branch_id(), app.current_role() to authenticated;

-- Staff API (each function checks the role itself).
grant execute on function
  public.update_settings(jsonb),
  public.set_business_hours(jsonb),
  public.add_store_closure(timestamptz, timestamptz, text),
  public.remove_store_closure(uuid),
  public.create_pin_staff(text, public.staff_role, text),
  public.reset_staff_pin(uuid, text),
  public.deactivate_staff(uuid, text),
  public.create_device(text, public.staff_role[]),
  public.revoke_device(uuid),
  public.end_pin_session()
  to authenticated;

-- Edge Functions only.
grant execute on function
  app.hit_rate_limit(text, int, int),
  app.pair_device(text, text),
  app.device_staff(text),
  app.pin_login(text, uuid, text, int),
  app.create_login_staff(uuid, text, text, public.staff_role, uuid),
  app.bootstrap_owner(uuid, text, text, uuid),
  app.ensure_branch_settings(uuid),
  app.verify_audit_chain()
  to service_role;

grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
