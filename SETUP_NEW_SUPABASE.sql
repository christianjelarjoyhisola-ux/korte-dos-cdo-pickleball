-- ============================================================
-- KORTE DOS - COMPLETE SUPABASE DATABASE SETUP
-- Use this on a fresh Supabase project:
--   Supabase Dashboard -> SQL Editor -> New query -> Run
--
-- This file is a consolidated baseline of the migration history.
-- Do not run it as a replacement for migrations on an existing
-- production database unless you have reviewed the seed/upsert data.
-- ============================================================

create extension if not exists pgcrypto;

-- ============================================================
-- 1. BASE TABLES
-- ============================================================

create table if not exists public.courts (
  id text primary key,
  name text not null,
  description text,
  rate numeric not null default 300,
  blocked boolean not null default false,
  feats text[] default '{}',
  photo text,
  rate_schedule jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.bookings (
  ref text primary key,
  booking_group_ref text,
  full_name text not null,
  contact_number text,
  email text,
  court_id text not null,
  court_name text,
  date date not null,
  slots text[] not null default '{}',
  start_time text,
  end_time text,
  duration numeric,
  rate numeric,
  total numeric,
  payment_method text,
  received_account text,
  payment_flow text,
  payment_status text not null default 'unpaid',
  payment_provider text,
  payment_session_id text,
  payment_checkout_url text,
  paid_at timestamptz,
  gcash_ref text,
  downpayment numeric,
  host_booking boolean not null default false,
  host_user_id uuid,
  host_name text,
  host_email text,
  created_via text not null default 'customer',
  created_by_user_id uuid,
  created_by_role text,
  created_by_name text,
  created_by_email text,
  receipt_image_url text,
  receipt_image_hash text,
  receipt_phash text,
  receipt_status text not null default 'none',
  receipt_flags text[] not null default '{}',
  receipt_extracted jsonb,
  receipt_confidence numeric,
  receipt_verified_at timestamptz,
  billed_at timestamptz,
  weekly_fee_id uuid,
  confirmation_email_id text,
  confirmation_email_sent_at timestamptz,
  confirmation_email_last_event text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  constraint bookings_payment_status_check
    check (payment_status in (
      'unpaid',
      'pending',
      'for_verification',
      'downpayment_paid',
      'paid',
      'failed',
      'rejected'
    )),
  constraint bookings_status_check
    check (status in ('pending','verifying','confirmed','cancelled','completed')),
  constraint bookings_created_via_check
    check (created_via in ('customer','admin','host','import','system')),
  constraint bookings_receipt_status_check
    check (receipt_status in ('none','auto_approved','manual_review','rejected'))
);

create table if not exists public.settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

create table if not exists public.accounts (
  id uuid primary key,
  username text unique not null,
  full_name text,
  email text unique,
  role text not null default 'staff',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  constraint accounts_role_check
    check (role in ('owner','court_owner','staff','host')),
  constraint accounts_status_check
    check (status in ('active','pending','suspended'))
);

create table if not exists public.blocked_dates (
  date date primary key,
  created_at timestamptz not null default now()
);

create table if not exists public.open_play_registrations (
  id bigserial primary key,
  full_name text not null,
  court_id text,
  court_name text,
  date date not null,
  hour integer,
  time_label text,
  payment_type text,
  amount numeric,
  payment_method text default 'cash',
  gcash_ref text,
  payment_status text default 'pending',
  receipt_image_url text,
  receipt_image_hash text,
  receipt_phash text,
  receipt_status text not null default 'none',
  receipt_flags text[] not null default '{}',
  receipt_extracted jsonb,
  receipt_confidence numeric,
  receipt_verified_at timestamptz,
  created_at timestamptz not null default now(),
  constraint open_play_payment_status_check
    check (payment_status in ('pending','paid','rejected')),
  constraint open_play_receipt_status_check
    check (receipt_status in ('none','auto_approved','manual_review','rejected'))
);

create table if not exists public.payment_sessions (
  id text primary key,
  booking_ref text not null,
  provider text not null,
  provider_reference text,
  amount_php numeric not null,
  status text not null default 'pending',
  checkout_url text,
  raw_request jsonb,
  raw_webhook jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz
);

create table if not exists public.used_gcash_refs (
  gcash_ref text primary key,
  booking_ref text not null,
  provider text,
  used_at timestamptz not null default now()
);

create table if not exists public.receipt_verifications (
  id bigserial primary key,
  booking_ref text not null,
  result text not null,
  flags text[] not null default '{}',
  extracted jsonb,
  confidence numeric,
  image_hash text,
  phash text,
  raw_ocr_text text,
  created_at timestamptz not null default now()
);

create table if not exists public.agreements (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  email text not null,
  full_name text not null,
  role text not null,
  version integer not null default 1,
  signature_data text not null,
  ip_address text,
  user_agent text,
  agreed_at timestamptz not null default now()
);

create table if not exists public.weekly_fees (
  id uuid primary key default gen_random_uuid(),
  court_owner_user_id text not null,
  court_owner_email text,
  week_start date not null,
  week_end date not null,
  bookings_count integer not null default 0,
  fee_per_booking numeric not null default 15,
  amount_due numeric not null default 0,
  status text not null default 'draft',
  billed_refs jsonb not null default '[]'::jsonb,
  generated_at timestamptz not null default now(),
  sent_at timestamptz,
  due_at timestamptz,
  submitted_at timestamptz,
  submitted_ref text,
  submitted_note text,
  submitted_proof_url text,
  paid_at timestamptz,
  paid_ref text,
  paid_note text,
  paid_by_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint weekly_fees_status_check
    check (status in ('draft','sent','submitted','paid','overdue')),
  constraint weekly_fees_bookings_count_check check (bookings_count >= 0),
  constraint weekly_fees_amount_due_check check (amount_due >= 0),
  constraint weekly_fees_week_range_check check (week_end >= week_start)
);

create table if not exists public.open_play_game_sessions (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  time_label text,
  court_ids text[] not null default '{}',
  court_names text[] not null default '{}',
  mode text not null default 'smart_random_mixer',
  status text not null default 'draft',
  current_round integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint open_play_game_sessions_status_check
    check (status in ('draft','active','paused','completed','cancelled'))
);

create table if not exists public.open_play_game_players (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.open_play_game_sessions(id) on delete cascade,
  full_name text not null,
  source_registration_id bigint,
  status text not null default 'active',
  seed_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint open_play_game_players_status_check
    check (status in ('active','no_show','removed'))
);

create table if not exists public.open_play_game_rounds (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.open_play_game_sessions(id) on delete cascade,
  round_no integer not null,
  assignments jsonb not null default '[]'::jsonb,
  queue_snapshot jsonb not null default '[]'::jsonb,
  partner_history jsonb not null default '{}'::jsonb,
  opponent_history jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.open_play_host_applications (
  id uuid primary key default gen_random_uuid(),
  host_user_id uuid,
  full_name text not null,
  contact_number text not null,
  email text not null,
  gcash_number text,
  valid_id_file_name text,
  valid_id_file_type text,
  valid_id_file_size bigint,
  valid_id_path text,
  preferred_schedule text,
  notes text,
  status text not null default 'pending',
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint open_play_host_applications_status_check
    check (status in ('pending','approved','rejected'))
);

create table if not exists public.open_play_host_sessions (
  id uuid primary key default gen_random_uuid(),
  host_user_id uuid,
  host_name text not null,
  host_email text,
  title text not null,
  date date not null,
  start_hour int not null,
  end_hour int not null,
  court_ids text[] not null default '{}',
  court_names text[] not null default '{}',
  max_players int not null default 16,
  fee_per_player numeric(10,2) not null default 0,
  status text not null default 'published',
  notes text,
  payment_instructions text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint open_play_host_sessions_status_check
    check (status in ('draft','published','cancelled')),
  constraint open_play_host_sessions_time_check
    check (start_hour >= 0 and start_hour <= 23 and end_hour > start_hour and end_hour <= 24),
  constraint open_play_host_sessions_capacity_check check (max_players > 0),
  constraint open_play_host_sessions_fee_check check (fee_per_player >= 0)
);

create table if not exists public.open_play_host_session_registrations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.open_play_host_sessions(id) on delete cascade,
  full_name text not null,
  contact_number text,
  payment_method text not null default 'gcash',
  gcash_ref text,
  payment_status text not null default 'pending',
  amount numeric(10,2) not null default 0,
  receipt_image_url text,
  receipt_image_hash text,
  receipt_phash text,
  receipt_status text not null default 'none',
  receipt_flags text[] not null default '{}',
  receipt_extracted jsonb,
  receipt_confidence numeric,
  receipt_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint open_play_host_session_registrations_payment_method_check
    check (payment_method in ('gcash','bdopay','maya','bpi','gotyme','pnb','cash')),
  constraint open_play_host_session_registrations_payment_status_check
    check (payment_status in ('pending','paid','rejected')),
  constraint open_play_host_session_registrations_receipt_status_check
    check (receipt_status in ('none','auto_approved','manual_review','rejected')),
  constraint open_play_host_session_registrations_amount_check check (amount >= 0)
);

create table if not exists public.deleted_booking_archive (
  id uuid primary key default gen_random_uuid(),
  booking_ref text not null,
  source text not null default 'trigger',
  original_booking jsonb,
  recovered_booking jsonb,
  recovery_status text not null default 'archived',
  recovered_from text,
  notes text,
  deleted_at timestamptz not null default now(),
  archived_at timestamptz not null default now(),
  restored_at timestamptz,
  restored_by uuid,
  created_at timestamptz not null default now()
);

-- Repair/upgrade tables when this script is rerun after an older partial setup.
alter table public.bookings
  add column if not exists booking_group_ref text,
  add column if not exists received_account text,
  add column if not exists host_booking boolean not null default false,
  add column if not exists host_user_id uuid,
  add column if not exists host_name text,
  add column if not exists host_email text,
  add column if not exists created_via text not null default 'customer',
  add column if not exists created_by_user_id uuid,
  add column if not exists created_by_role text,
  add column if not exists created_by_name text,
  add column if not exists created_by_email text,
  add column if not exists receipt_image_url text,
  add column if not exists receipt_image_hash text,
  add column if not exists receipt_phash text,
  add column if not exists receipt_status text not null default 'none',
  add column if not exists receipt_flags text[] not null default '{}',
  add column if not exists receipt_extracted jsonb,
  add column if not exists receipt_confidence numeric,
  add column if not exists receipt_verified_at timestamptz,
  add column if not exists billed_at timestamptz,
  add column if not exists weekly_fee_id uuid,
  add column if not exists confirmation_email_id text,
  add column if not exists confirmation_email_sent_at timestamptz,
  add column if not exists confirmation_email_last_event text;

alter table public.bookings
  alter column payment_status set default 'unpaid',
  alter column status set default 'pending',
  alter column host_booking set default false,
  alter column created_via set default 'customer',
  alter column receipt_status set default 'none',
  alter column receipt_flags set default '{}';

update public.bookings
set host_booking = coalesce(host_booking, false),
    created_via = case
      when created_via in ('customer','admin','host','import','system') then created_via
      else 'customer'
    end,
    receipt_status = coalesce(receipt_status, 'none'),
    receipt_flags = coalesce(receipt_flags, '{}')
where host_booking is null
   or created_via is null
   or created_via not in ('customer','admin','host','import','system')
   or receipt_status is null
   or receipt_flags is null;

alter table public.bookings
  alter column host_booking set not null,
  alter column created_via set not null;

alter table public.bookings drop constraint if exists bookings_payment_status_check;
alter table public.bookings
  add constraint bookings_payment_status_check
  check (payment_status in (
    'unpaid',
    'pending',
    'for_verification',
    'downpayment_paid',
    'paid',
    'failed',
    'rejected'
  ));

alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings
  add constraint bookings_status_check
  check (status in ('pending','verifying','confirmed','cancelled','completed'));

alter table public.bookings drop constraint if exists bookings_receipt_status_check;
alter table public.bookings
  add constraint bookings_receipt_status_check
  check (receipt_status in ('none','auto_approved','manual_review','rejected'));

alter table public.bookings drop constraint if exists bookings_created_via_check;
alter table public.bookings
  add constraint bookings_created_via_check
  check (created_via in ('customer','admin','host','import','system'));

alter table public.accounts drop constraint if exists accounts_role_check;
alter table public.accounts
  add constraint accounts_role_check
  check (role in ('owner','court_owner','staff','host'));

alter table public.open_play_host_applications
  add column if not exists host_user_id uuid,
  add column if not exists gcash_number text,
  add column if not exists valid_id_file_name text,
  add column if not exists valid_id_file_type text,
  add column if not exists valid_id_file_size bigint,
  add column if not exists valid_id_path text;

-- Add status as nullable first so an older installation can reconcile host
-- access before the default/not-null rules are applied. Reruns preserve owner
-- suspensions while preventing pending/rejected applications from staying active.
alter table public.accounts
  add column if not exists status text;

-- Pending legacy signups normally have an Auth user but no accounts row. Link
-- only a unique same-email Auth identity marked as a host, without repurposing
-- an existing non-host account. Approval still creates/activates the account.
with unique_host_auth_match as (
  select
    h.id as application_id,
    (array_agg(u.id order by u.id))[1] as auth_user_id
  from public.open_play_host_applications h
  join auth.users u
    on lower(trim(h.email)) = lower(trim(u.email))
   and u.raw_user_meta_data->>'role' = 'host'
  where h.host_user_id is null
    and not exists (
      select 1
      from public.accounts existing_account
      where (
          existing_account.id = u.id
          or lower(trim(existing_account.email)) = lower(trim(u.email))
          or lower(trim(existing_account.username)) = lower(trim(u.email))
        )
        and existing_account.role <> 'host'
    )
  group by h.id
  having count(*) = 1
)
update public.open_play_host_applications h
set host_user_id = matched.auth_user_id
from unique_host_auth_match matched
where h.id = matched.application_id
  and h.host_user_id is null;

-- Recover an unambiguous application/account link by normalized email or the
-- UUID kept in legacy review_note metadata. Remaining unmatched or ambiguous
-- rows stay owner-managed.
with unique_host_account_match as (
  select
    h.id as application_id,
    (array_agg(a.id order by a.id))[1] as account_id
  from public.open_play_host_applications h
  join public.accounts a
    on a.role = 'host'
   and (
     lower(trim(h.email)) = lower(trim(a.email))
     or lower(trim(h.email)) = lower(trim(a.username))
     or a.id::text = substring(
       h.review_note from '"hostUserId"[[:space:]]*:[[:space:]]*"([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})"'
     )
   )
  where h.host_user_id is null
  group by h.id
  having count(*) = 1
)
update public.open_play_host_applications h
set host_user_id = matched.account_id
from unique_host_account_match matched
where h.id = matched.application_id
  and h.host_user_id is null;

with latest_host_application as (
  select distinct on (account_id)
    account_id,
    application_status
  from (
    select
      a.id as account_id,
      h.status as application_status,
      coalesce(h.reviewed_at, h.created_at) as status_at,
      h.created_at,
      h.id as application_id
    from public.accounts a
    join public.open_play_host_applications h
      on h.host_user_id = a.id
    where a.role = 'host'
  ) candidates
  order by account_id, status_at desc, created_at desc, application_id desc
)
update public.accounts a
set status = case
  when latest.application_status = 'approved' then coalesce(a.status, 'active')
  when latest.application_status = 'pending' and a.status = 'suspended' then 'suspended'
  when latest.application_status = 'pending' then 'pending'
  else 'suspended'
end
from latest_host_application latest
where a.id = latest.account_id
  and (
    a.status is null
    or (latest.application_status = 'pending' and a.status = 'active')
    or (latest.application_status = 'rejected' and a.status is distinct from 'suspended')
  );

-- Ambiguous email matches remain unlinked and fail closed.
update public.accounts a
set status = 'suspended'
where a.role = 'host'
  and a.status = 'active'
  and exists (
    select 1
    from public.open_play_host_applications h
    where h.host_user_id is null
      and (
        lower(trim(h.email)) = lower(trim(a.email))
        or lower(trim(h.email)) = lower(trim(a.username))
      )
  );

-- Preserve legacy dashboard access; a host still null after reconciliation
-- fails closed until an owner explicitly activates the account.
update public.accounts
set status = case when role = 'host' then 'suspended' else 'active' end
where status is null;

update public.accounts
set status = 'suspended'
where status not in ('active','pending','suspended');

alter table public.accounts
  alter column status set default 'active',
  alter column status set not null;

alter table public.accounts drop constraint if exists accounts_status_check;
alter table public.accounts
  add constraint accounts_status_check
  check (status in ('active','pending','suspended'));

alter table public.open_play_registrations
  add column if not exists payment_method text default 'cash',
  add column if not exists gcash_ref text,
  add column if not exists payment_status text default 'pending',
  add column if not exists receipt_image_url text,
  add column if not exists receipt_image_hash text,
  add column if not exists receipt_phash text,
  add column if not exists receipt_status text not null default 'none',
  add column if not exists receipt_flags text[] not null default '{}',
  add column if not exists receipt_extracted jsonb,
  add column if not exists receipt_confidence numeric,
  add column if not exists receipt_verified_at timestamptz;

update public.open_play_registrations
set payment_status = coalesce(payment_status, 'pending'),
    receipt_status = coalesce(receipt_status, 'none'),
    receipt_flags = coalesce(receipt_flags, '{}')
where payment_status is null
   or receipt_status is null
   or receipt_flags is null;

alter table public.open_play_registrations drop constraint if exists open_play_payment_status_check;
alter table public.open_play_registrations
  add constraint open_play_payment_status_check
  check (payment_status in ('pending','paid','rejected'));

alter table public.open_play_registrations drop constraint if exists open_play_receipt_status_check;
alter table public.open_play_registrations
  add constraint open_play_receipt_status_check
  check (receipt_status in ('none','auto_approved','manual_review','rejected'));

alter table public.weekly_fees
  add column if not exists billed_refs jsonb not null default '[]'::jsonb,
  add column if not exists submitted_at timestamptz,
  add column if not exists submitted_ref text,
  add column if not exists submitted_note text,
  add column if not exists submitted_proof_url text;

alter table public.open_play_host_session_registrations
  drop constraint if exists open_play_host_session_registrations_payment_method_check;
alter table public.open_play_host_session_registrations
  add constraint open_play_host_session_registrations_payment_method_check
  check (payment_method in ('gcash','bdopay','maya','bpi','gotyme','pnb','cash'));

-- ============================================================
-- 2. INDEXES
-- ============================================================

create index if not exists idx_bookings_court_date on public.bookings (court_id, date);
create index if not exists idx_bookings_status on public.bookings (status);
create index if not exists idx_bookings_booking_group_ref on public.bookings (booking_group_ref);
create index if not exists idx_bookings_billed_at on public.bookings (billed_at);
create index if not exists idx_bookings_weekly_fee_id on public.bookings (weekly_fee_id);
create index if not exists idx_bookings_received_account on public.bookings (received_account);
create index if not exists idx_bookings_host_booking
  on public.bookings (host_booking, host_user_id, date);
create index if not exists idx_bookings_created_via on public.bookings (created_via);
create index if not exists idx_bookings_created_by_user_id on public.bookings (created_by_user_id);
create index if not exists idx_bookings_receipt_phash
  on public.bookings (receipt_phash)
  where receipt_phash is not null and receipt_phash <> '';
create index if not exists idx_bookings_confirmation_email_id
  on public.bookings (confirmation_email_id)
  where confirmation_email_id is not null;

create index if not exists idx_payment_sessions_booking_ref on public.payment_sessions (booking_ref);
create index if not exists idx_payment_sessions_status on public.payment_sessions (status);
create index if not exists idx_payment_sessions_provider_reference on public.payment_sessions (provider_reference);

create index if not exists idx_used_gcash_refs_booking_ref on public.used_gcash_refs (booking_ref);
create index if not exists idx_receipt_verifications_booking_ref on public.receipt_verifications (booking_ref);
create index if not exists idx_receipt_verifications_created_at on public.receipt_verifications (created_at);
create unique index if not exists agreements_user_version_uq on public.agreements (user_id, version);

create unique index if not exists weekly_fees_owner_week_uq
  on public.weekly_fees (court_owner_user_id, week_start, week_end);
create index if not exists idx_weekly_fees_status on public.weekly_fees (status);
create index if not exists idx_weekly_fees_week_start on public.weekly_fees (week_start desc);

create index if not exists idx_open_play_receipt_status on public.open_play_registrations (receipt_status);
create index if not exists idx_open_play_receipt_verified_at on public.open_play_registrations (receipt_verified_at);

create index if not exists idx_op_game_sessions_date on public.open_play_game_sessions (date);
create index if not exists idx_op_game_players_session
  on public.open_play_game_players (session_id, seed_order);
create unique index if not exists idx_op_game_players_source
  on public.open_play_game_players (session_id, source_registration_id)
  where source_registration_id is not null;
create index if not exists idx_op_game_rounds_session
  on public.open_play_game_rounds (session_id, round_no);

create index if not exists idx_open_play_host_applications_status
  on public.open_play_host_applications (status, created_at desc);
create index if not exists idx_open_play_host_applications_host_user
  on public.open_play_host_applications (host_user_id);
create index if not exists idx_open_play_host_sessions_date
  on public.open_play_host_sessions (date, start_hour);
create index if not exists idx_open_play_host_session_registrations_session
  on public.open_play_host_session_registrations (session_id, created_at desc);
create index if not exists idx_open_play_host_session_registrations_payment
  on public.open_play_host_session_registrations (payment_status, receipt_status);

create index if not exists idx_deleted_booking_archive_ref on public.deleted_booking_archive (booking_ref);
create index if not exists idx_deleted_booking_archive_deleted_at on public.deleted_booking_archive (deleted_at desc);
create index if not exists idx_deleted_booking_archive_status on public.deleted_booking_archive (recovery_status);
create unique index if not exists uniq_deleted_booking_archive_screenshot_ref
  on public.deleted_booking_archive (booking_ref, source)
  where source = 'screenshot_recovery';

-- ============================================================
-- 3. FUNCTIONS AND TRIGGERS
-- ============================================================

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.current_account_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select a.role
  from public.accounts a
  where a.id = auth.uid()
    and a.status = 'active'
  limit 1
$$;

create or replace function public.has_account_role(allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_account_role() = any(allowed_roles), false)
$$;

create or replace function public.can_write_setting(setting_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.current_account_role() = 'owner' then true
    when public.current_account_role() = 'court_owner' then
      coalesce(setting_key, '') not in (
        'booking_fee',
        'service_fee_rate',
        'maintenance_fee',
        'fee_type',
        'platform_gcash_number',
        'platform_gcash_name',
        'platform_gcash_qr'
      )
    else false
  end
$$;

create or replace function public.prevent_double_booking()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE'
     and new.court_id is not distinct from old.court_id
     and new.date is not distinct from old.date
     and new.status is not distinct from old.status
     and new.ref is not distinct from old.ref
     and new.slots is not distinct from old.slots then
    return new;
  end if;

  if new.status = 'cancelled' then
    return new;
  end if;

  if exists (
    select 1
    from public.bookings b
    where b.court_id = new.court_id
      and b.date = new.date
      and b.status != 'cancelled'
      and b.ref != new.ref
      and b.slots && new.slots
      and (
        b.status != 'verifying'
        or b.created_at is null
        or b.created_at > (now() - interval '15 minutes')
      )
  ) then
    raise exception 'One or more time slots are already booked for this court and date.';
  end if;

  return new;
end;
$$;

create or replace function public.calculate_booking_court_total(
  booking_court_id text,
  booking_slots text[]
)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  base_rate numeric;
  court_tiers jsonb;
  global_tiers_text text;
  global_tiers jsonb := '[]'::jsonb;
  active_tiers jsonb := '[]'::jsonb;
  slot_text text;
  slot_hour numeric;
  tier jsonb;
  tier_from_text text;
  tier_to_text text;
  tier_rate_text text;
  tier_from numeric;
  tier_to numeric;
  tier_rate numeric;
  matched_rate numeric;
  minimum_rate numeric;
  court_total numeric := 0;
begin
  select c.rate, c.rate_schedule
    into base_rate, court_tiers
    from public.courts c
   where c.id = booking_court_id
   limit 1;

  if not found then
    raise exception 'Booking court was not found.';
  end if;
  if base_rate is null or base_rate < 0 then
    raise exception 'Booking court rate is invalid.';
  end if;
  if booking_slots is null or coalesce(cardinality(booking_slots), 0) = 0 then
    raise exception 'Booking must contain at least one time slot.';
  end if;

  if jsonb_typeof(court_tiers) = 'array' then
    active_tiers := court_tiers;
  end if;

  if jsonb_array_length(active_tiers) = 0 then
    select s.value
      into global_tiers_text
      from public.settings s
     where s.key = 'pricing_tiers'
     limit 1;

    if nullif(trim(coalesce(global_tiers_text, '')), '') is not null then
      begin
        global_tiers := global_tiers_text::jsonb;
      exception when others then
        global_tiers := '[]'::jsonb;
      end;
    end if;

    if jsonb_typeof(global_tiers) = 'array' then
      active_tiers := global_tiers;
    end if;
  end if;

  foreach slot_text in array booking_slots loop
    if trim(coalesce(slot_text, '')) !~ '^[0-9]+([.][0-9]+)?$' then
      raise exception 'Booking contains an invalid time slot.';
    end if;

    slot_hour := trim(slot_text)::numeric;
    if slot_hour <> trunc(slot_hour) or slot_hour < 0 or slot_hour >= 24 then
      raise exception 'Booking contains an invalid time slot.';
    end if;

    matched_rate := null;
    minimum_rate := null;

    for tier in
      select value
      from jsonb_array_elements(active_tiers)
    loop
      tier_from_text := tier->>'from';
      tier_to_text := tier->>'to';
      tier_rate_text := tier->>'rate';

      if trim(coalesce(tier_from_text, '')) ~ '^-?[0-9]+([.][0-9]+)?$'
         and trim(coalesce(tier_to_text, '')) ~ '^-?[0-9]+([.][0-9]+)?$'
         and trim(coalesce(tier_rate_text, '')) ~ '^[0-9]+([.][0-9]+)?$' then
        tier_from := trim(tier_from_text)::numeric;
        tier_to := trim(tier_to_text)::numeric;
        tier_rate := trim(tier_rate_text)::numeric;
        minimum_rate := case
          when minimum_rate is null then tier_rate
          else least(minimum_rate, tier_rate)
        end;

        if (tier_from < tier_to and slot_hour >= tier_from and slot_hour < tier_to)
           or (tier_from >= tier_to and (slot_hour >= tier_from or slot_hour < tier_to)) then
          matched_rate := tier_rate;
          exit;
        end if;
      end if;
    end loop;

    court_total := court_total + coalesce(matched_rate, minimum_rate, base_rate);
  end loop;

  return round(court_total, 2);
end;
$$;

revoke all on function public.calculate_booking_court_total(text, text[])
  from public;

create or replace function public.calculate_booking_service_fee(booking_slots text[])
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  fee_text text;
  fee_type_text text;
  fee_rate numeric := 0;
  slot_count integer := coalesce(cardinality(booking_slots), 0);
begin
  select s.value
    into fee_text
    from public.settings s
   where s.key in ('maintenance_fee', 'service_fee_rate', 'booking_fee')
     and s.value is not null
   order by case s.key
     when 'maintenance_fee' then 1
     when 'service_fee_rate' then 2
     else 3
   end
   limit 1;

  if trim(coalesce(fee_text, '')) ~ '^[0-9]+([.][0-9]+)?$' then
    fee_rate := trim(fee_text)::numeric;
  end if;

  select s.value
    into fee_type_text
    from public.settings s
   where s.key = 'fee_type'
   limit 1;

  if lower(trim(coalesce(fee_type_text, ''))) in
     ('flat', 'booking', 'per_booking', 'per_transaction') then
    return round(fee_rate, 2);
  end if;

  return round(fee_rate * slot_count, 2);
end;
$$;

revoke all on function public.calculate_booking_service_fee(text[])
  from public;

create or replace function public.prepare_authenticated_host_booking_hold()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  account_name text;
  account_email text;
  authoritative_court_name text;
  authoritative_rate numeric;
  court_blocked boolean;
  court_total numeric;
  service_fee numeric;
begin
  if auth.role() = 'authenticated'
     and public.current_account_role() = 'host' then
    select a.full_name, a.email
      into account_name, account_email
      from public.accounts a
     where a.id = auth.uid()
       and a.role = 'host'
       and a.status = 'active'
     limit 1;

    select c.name, c.rate, c.blocked
      into authoritative_court_name, authoritative_rate, court_blocked
      from public.courts c
     where c.id = new.court_id
     limit 1;

    if not found then
      raise exception 'Booking court was not found.';
    end if;
    if coalesce(court_blocked, false) then
      raise exception 'This court is not currently available for booking.';
    end if;

    court_total := public.calculate_booking_court_total(new.court_id, new.slots);
    service_fee := public.calculate_booking_service_fee(new.slots);

    new.host_booking := true;
    new.host_user_id := auth.uid();
    new.host_name := account_name;
    new.host_email := account_email;
    new.created_via := 'host';
    new.created_by_user_id := auth.uid();
    new.created_by_role := 'host';
    new.created_by_name := account_name;
    new.created_by_email := account_email;
    new.court_name := authoritative_court_name;
    new.rate := authoritative_rate;
    new.total := round(court_total + service_fee, 2);
  end if;

  return new;
end;
$$;

create or replace function public.guard_public_booking_hold_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  request_role text := coalesce(auth.role(), nullif(current_setting('request.jwt.claim.role', true), ''));
  account_role text := public.current_account_role();
  service_fee numeric := 0;
  host_due numeric := 0;
begin
  if request_role = 'anon'
     or (request_role = 'authenticated' and account_role = 'host') then
    if new.ref is distinct from old.ref
      or new.booking_group_ref is distinct from old.booking_group_ref
      or new.court_id is distinct from old.court_id
      or new.court_name is distinct from old.court_name
      or new.date is distinct from old.date
      or new.slots is distinct from old.slots
      or new.start_time is distinct from old.start_time
      or new.end_time is distinct from old.end_time
      or new.duration is distinct from old.duration
      or new.rate is distinct from old.rate
      or new.total is distinct from old.total
      or new.created_at is distinct from old.created_at
      or new.host_booking is distinct from old.host_booking
      or new.host_user_id is distinct from old.host_user_id
      or new.host_name is distinct from old.host_name
      or new.host_email is distinct from old.host_email
      or new.created_via is distinct from old.created_via
      or new.created_by_user_id is distinct from old.created_by_user_id
      or new.created_by_role is distinct from old.created_by_role
      or new.created_by_name is distinct from old.created_by_name
      or new.created_by_email is distinct from old.created_by_email
      or new.payment_provider is distinct from old.payment_provider
      or new.payment_session_id is distinct from old.payment_session_id
      or new.payment_checkout_url is distinct from old.payment_checkout_url
      or new.paid_at is distinct from old.paid_at
      or new.receipt_image_url is distinct from old.receipt_image_url
      or new.receipt_image_hash is distinct from old.receipt_image_hash
      or new.receipt_phash is distinct from old.receipt_phash
      or new.receipt_status is distinct from old.receipt_status
      or new.receipt_flags is distinct from old.receipt_flags
      or new.receipt_extracted is distinct from old.receipt_extracted
      or new.receipt_confidence is distinct from old.receipt_confidence
      or new.receipt_verified_at is distinct from old.receipt_verified_at
      or new.billed_at is distinct from old.billed_at
      or new.weekly_fee_id is distinct from old.weekly_fee_id
      or new.confirmation_email_id is distinct from old.confirmation_email_id
      or new.confirmation_email_sent_at is distinct from old.confirmation_email_sent_at
      or new.confirmation_email_last_event is distinct from old.confirmation_email_last_event then
      raise exception 'Reservation identity, slot, price, and ownership cannot be changed after a hold is created.';
    end if;

    if new.payment_status not in ('unpaid', 'pending', 'for_verification', 'rejected') then
      raise exception 'Reservation payment status cannot be approved by the booking client.';
    end if;
  end if;

  if request_role = 'anon' then
    if coalesce(old.host_booking, false)
      or old.host_user_id is not null
      or old.created_via <> 'customer'
      or old.created_by_user_id is not null then
      raise exception 'Anonymous clients may only finalize public customer holds.';
    end if;

    if new.downpayment is not null then
      if old.total is null
        or (
          abs(new.downpayment - old.total) > 0.01
          and abs(new.downpayment - (old.total / 2)) > 0.01
          and abs(new.downpayment - round(old.total / 2)) > 0.01
        ) then
        raise exception 'Reservation payment amount is invalid.';
      end if;
    end if;
  elsif request_role = 'authenticated' and account_role = 'host' then
    if old.status <> 'verifying'
      or old.created_at is null
      or old.created_at <= now() - interval '15 minutes'
      or not coalesce(old.host_booking, false)
      or old.host_user_id is distinct from auth.uid()
      or old.created_via <> 'host'
      or old.created_by_user_id is distinct from auth.uid()
      or old.created_by_role <> 'host' then
      raise exception 'Hosts may only finalize their own active booking holds.';
    end if;

    if new.status not in ('verifying', 'pending', 'cancelled') then
      raise exception 'Host booking hold status transition is invalid.';
    end if;

    if new.status = 'pending' and new.downpayment is null then
      raise exception 'A finalized host booking must store its payment amount.';
    end if;

    if new.downpayment is not null then
      if old.total is null or old.total < 0 then
        raise exception 'Host booking total is invalid.';
      end if;

      service_fee := least(
        greatest(public.calculate_booking_service_fee(old.slots), 0),
        old.total
      );
      host_due := round(service_fee + ((old.total - service_fee) * 0.25), 2);

      if abs(new.downpayment - old.total) > 0.01
         and abs(new.downpayment - host_due) > 0.01 then
        raise exception 'Host payment amount is invalid. Expected 25%% of the court fee plus the full service fee.';
      end if;
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.guard_weekly_fee_court_owner_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_account_role() = 'court_owner' then
    if new.court_owner_user_id is distinct from old.court_owner_user_id
      or new.court_owner_email is distinct from old.court_owner_email
      or new.week_start is distinct from old.week_start
      or new.week_end is distinct from old.week_end
      or new.bookings_count is distinct from old.bookings_count
      or new.fee_per_booking is distinct from old.fee_per_booking
      or new.amount_due is distinct from old.amount_due
      or new.generated_at is distinct from old.generated_at
      or new.sent_at is distinct from old.sent_at
      or new.due_at is distinct from old.due_at
      or new.paid_at is distinct from old.paid_at
      or new.paid_ref is distinct from old.paid_ref
      or new.paid_note is distinct from old.paid_note
      or new.paid_by_user_id is distinct from old.paid_by_user_id then
      raise exception 'Court owners may only submit payment proof fields.';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.archive_deleted_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.deleted_booking_archive (
    booking_ref,
    source,
    original_booking,
    recovery_status,
    deleted_at,
    notes
  )
  values (
    old.ref,
    'trigger',
    to_jsonb(old),
    'deleted',
    now(),
    'Automatically archived before hard delete.'
  );

  return old;
end;
$$;

create or replace function public.restore_deleted_booking_archive(p_archive_id uuid)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  archive_rec public.deleted_booking_archive%rowtype;
  restored public.bookings%rowtype;
  target_ref text;
begin
  if not public.has_account_role(array['owner']) then
    raise exception 'Only the system owner can restore deleted bookings.'
      using errcode = '42501';
  end if;

  select *
    into archive_rec
    from public.deleted_booking_archive
   where id = p_archive_id
   for update;

  if not found then
    raise exception 'Deleted booking archive row not found.';
  end if;

  if archive_rec.original_booking is null then
    raise exception 'Archive row has no original booking payload.';
  end if;

  target_ref := coalesce(archive_rec.original_booking->>'ref', archive_rec.booking_ref);
  if exists (select 1 from public.bookings where ref = target_ref) then
    raise exception 'Booking % already exists in active bookings.', target_ref;
  end if;

  restored := jsonb_populate_record(null::public.bookings, archive_rec.original_booking);

  insert into public.bookings
  select (restored).*
  returning * into restored;

  update public.deleted_booking_archive
     set recovery_status = 'restored',
         recovered_booking = to_jsonb(restored),
         recovered_from = coalesce(recovered_from, 'archive_restore'),
         restored_at = now(),
         restored_by = auth.uid(),
         notes = concat_ws(E'\n', notes, 'Restored from deleted booking archive.')
   where id = p_archive_id;

  return restored;
end;
$$;

create or replace function public.count_open_play_host_session_registrations(p_session_id uuid)
returns int
language sql
security definer
set search_path = public
as $$
  select count(*)::int
  from public.open_play_host_session_registrations r
  where r.session_id = p_session_id
    and coalesce(r.payment_status, 'pending') <> 'rejected';
$$;

grant execute on function public.current_account_role() to anon, authenticated;
grant execute on function public.has_account_role(text[]) to anon, authenticated;
grant execute on function public.can_write_setting(text) to authenticated;
grant execute on function public.restore_deleted_booking_archive(uuid) to authenticated;
grant execute on function public.count_open_play_host_session_registrations(uuid) to anon, authenticated;

drop trigger if exists trg_payment_sessions_touch_updated_at on public.payment_sessions;
create trigger trg_payment_sessions_touch_updated_at
before update on public.payment_sessions
for each row execute function public.touch_updated_at();

drop trigger if exists check_booking_conflict on public.bookings;
create trigger check_booking_conflict
before insert or update on public.bookings
for each row execute function public.prevent_double_booking();

drop trigger if exists trg_prepare_authenticated_host_booking_hold
  on public.bookings;
create trigger trg_prepare_authenticated_host_booking_hold
before insert on public.bookings
for each row execute function public.prepare_authenticated_host_booking_hold();

drop trigger if exists trg_guard_public_booking_hold_update on public.bookings;
create trigger trg_guard_public_booking_hold_update
before update on public.bookings
for each row execute function public.guard_public_booking_hold_update();

drop trigger if exists trg_archive_deleted_booking on public.bookings;
create trigger trg_archive_deleted_booking
before delete on public.bookings
for each row execute function public.archive_deleted_booking();

drop trigger if exists trg_weekly_fees_touch_updated_at on public.weekly_fees;
create trigger trg_weekly_fees_touch_updated_at
before update on public.weekly_fees
for each row execute function public.touch_updated_at();

drop trigger if exists trg_guard_weekly_fee_court_owner_update on public.weekly_fees;
create trigger trg_guard_weekly_fee_court_owner_update
before update on public.weekly_fees
for each row execute function public.guard_weekly_fee_court_owner_update();

drop trigger if exists trg_op_game_sessions_touch_updated_at on public.open_play_game_sessions;
create trigger trg_op_game_sessions_touch_updated_at
before update on public.open_play_game_sessions
for each row execute function public.touch_updated_at();

drop trigger if exists trg_open_play_host_applications_touch_updated_at on public.open_play_host_applications;
create trigger trg_open_play_host_applications_touch_updated_at
before update on public.open_play_host_applications
for each row execute function public.touch_updated_at();

drop trigger if exists trg_open_play_host_sessions_touch_updated_at on public.open_play_host_sessions;
create trigger trg_open_play_host_sessions_touch_updated_at
before update on public.open_play_host_sessions
for each row execute function public.touch_updated_at();

drop trigger if exists trg_open_play_host_session_registrations_touch_updated_at
  on public.open_play_host_session_registrations;
create trigger trg_open_play_host_session_registrations_touch_updated_at
before update on public.open_play_host_session_registrations
for each row execute function public.touch_updated_at();

-- ============================================================
-- 4. ROW LEVEL SECURITY AND POLICIES
-- ============================================================

alter table public.bookings enable row level security;
alter table public.courts enable row level security;
alter table public.settings enable row level security;
alter table public.accounts enable row level security;
alter table public.blocked_dates enable row level security;
alter table public.open_play_registrations enable row level security;
alter table public.payment_sessions enable row level security;
alter table public.used_gcash_refs enable row level security;
alter table public.receipt_verifications enable row level security;
alter table public.agreements enable row level security;
alter table public.weekly_fees enable row level security;
alter table public.open_play_game_sessions enable row level security;
alter table public.open_play_game_players enable row level security;
alter table public.open_play_game_rounds enable row level security;
alter table public.open_play_host_applications enable row level security;
alter table public.open_play_host_sessions enable row level security;
alter table public.open_play_host_session_registrations enable row level security;
alter table public.deleted_booking_archive enable row level security;

drop policy if exists bookings_select_public on public.bookings;
create policy bookings_select_public on public.bookings
  for select using (true);

drop policy if exists bookings_insert_public on public.bookings;
create policy bookings_insert_public on public.bookings
  for insert to anon
  with check (
    coalesce(host_booking, false) = false
    and host_user_id is null
    and host_name is null
    and host_email is null
    and created_via = 'customer'
    and created_by_user_id is null
    and created_by_role is null
    and created_by_name is null
    and created_by_email is null
    and status in ('verifying', 'pending')
    and payment_status in ('unpaid', 'pending', 'for_verification')
    and created_at > now() - interval '15 minutes'
    and created_at <= now() + interval '5 minutes'
    and total is not null
    and total >= 0
    and (
      downpayment is null
      or abs(downpayment - total) <= 0.01
      or abs(downpayment - (total / 2)) <= 0.01
      or abs(downpayment - round(total / 2)) <= 0.01
    )
  );

drop policy if exists bookings_insert_admin on public.bookings;
drop policy if exists bookings_insert_dashboard_roles on public.bookings;
create policy bookings_insert_dashboard_roles on public.bookings
  for insert to authenticated
  with check (public.has_account_role(array['owner','court_owner','staff']));

drop policy if exists bookings_insert_host_hold on public.bookings;
create policy bookings_insert_host_hold on public.bookings
  for insert to authenticated
  with check (
    public.current_account_role() = 'host'
    and host_booking = true
    and host_user_id = auth.uid()
    and created_via = 'host'
    and created_by_user_id = auth.uid()
    and created_by_role = 'host'
    and status = 'verifying'
    and payment_status in ('unpaid', 'pending', 'for_verification')
    and downpayment is null
    and created_at > now() - interval '5 minutes'
    and created_at <= now() + interval '5 minutes'
    and total is not null
    and total >= 0
  );

drop policy if exists bookings_update_admin on public.bookings;
drop policy if exists bookings_update_dashboard_roles on public.bookings;
create policy bookings_update_dashboard_roles on public.bookings
  for update to authenticated
  using (public.has_account_role(array['owner','court_owner','staff']))
  with check (public.has_account_role(array['owner','court_owner','staff']));

drop policy if exists bookings_update_public_hold on public.bookings;
create policy bookings_update_public_hold on public.bookings
  for update to anon
  using (
    status = 'verifying'
    and created_at > now() - interval '15 minutes'
    and coalesce(host_booking, false) = false
    and host_user_id is null
    and created_via = 'customer'
    and created_by_user_id is null
  )
  with check (
    status in ('verifying', 'pending', 'cancelled')
    and payment_status in ('unpaid', 'pending', 'for_verification', 'rejected')
    and created_at > now() - interval '15 minutes'
    and coalesce(host_booking, false) = false
    and host_user_id is null
    and created_via = 'customer'
    and created_by_user_id is null
  );

drop policy if exists bookings_update_host_hold on public.bookings;
create policy bookings_update_host_hold on public.bookings
  for update to authenticated
  using (
    public.current_account_role() = 'host'
    and status = 'verifying'
    and created_at > now() - interval '15 minutes'
    and host_booking = true
    and host_user_id = auth.uid()
    and created_via = 'host'
    and created_by_user_id = auth.uid()
    and created_by_role = 'host'
  )
  with check (
    public.current_account_role() = 'host'
    and status in ('verifying', 'pending', 'cancelled')
    and payment_status in ('unpaid', 'pending', 'for_verification', 'rejected')
    and created_at > now() - interval '15 minutes'
    and host_booking = true
    and host_user_id = auth.uid()
    and created_via = 'host'
    and created_by_user_id = auth.uid()
    and created_by_role = 'host'
  );

drop policy if exists bookings_delete_admin on public.bookings;
drop policy if exists bookings_delete_owner on public.bookings;
create policy bookings_delete_owner on public.bookings
  for delete to authenticated
  using (public.has_account_role(array['owner']));

drop policy if exists courts_select_public on public.courts;
create policy courts_select_public on public.courts
  for select using (true);

drop policy if exists courts_insert_admin on public.courts;
drop policy if exists courts_insert_operators on public.courts;
create policy courts_insert_operators on public.courts
  for insert to authenticated
  with check (public.has_account_role(array['owner','court_owner']));

drop policy if exists courts_update_admin on public.courts;
drop policy if exists courts_update_operators on public.courts;
create policy courts_update_operators on public.courts
  for update to authenticated
  using (public.has_account_role(array['owner','court_owner']))
  with check (public.has_account_role(array['owner','court_owner']));

drop policy if exists courts_delete_admin on public.courts;
drop policy if exists courts_delete_operators on public.courts;
create policy courts_delete_operators on public.courts
  for delete to authenticated
  using (public.has_account_role(array['owner','court_owner']));

drop policy if exists settings_select_public on public.settings;
create policy settings_select_public on public.settings
  for select using (true);

drop policy if exists settings_insert_admin on public.settings;
drop policy if exists settings_insert_operators on public.settings;
create policy settings_insert_operators on public.settings
  for insert to authenticated
  with check (public.can_write_setting(key));

drop policy if exists settings_update_admin on public.settings;
drop policy if exists settings_update_operators on public.settings;
create policy settings_update_operators on public.settings
  for update to authenticated
  using (public.can_write_setting(key))
  with check (public.can_write_setting(key));

drop policy if exists settings_delete_admin on public.settings;
drop policy if exists settings_delete_operators on public.settings;
create policy settings_delete_operators on public.settings
  for delete to authenticated
  using (public.can_write_setting(key));

drop policy if exists accounts_select_admin on public.accounts;
drop policy if exists accounts_select_self_or_owner on public.accounts;
create policy accounts_select_self_or_owner on public.accounts
  for select to authenticated
  using (id = auth.uid() or public.has_account_role(array['owner']));

drop policy if exists accounts_insert_admin on public.accounts;
drop policy if exists accounts_insert_owner on public.accounts;
create policy accounts_insert_owner on public.accounts
  for insert to authenticated
  with check (public.has_account_role(array['owner']));

drop policy if exists accounts_update_admin on public.accounts;
drop policy if exists accounts_update_owner on public.accounts;
create policy accounts_update_owner on public.accounts
  for update to authenticated
  using (public.has_account_role(array['owner']))
  with check (public.has_account_role(array['owner']));

drop policy if exists accounts_delete_admin on public.accounts;
drop policy if exists accounts_delete_owner on public.accounts;
create policy accounts_delete_owner on public.accounts
  for delete to authenticated
  using (public.has_account_role(array['owner']));

drop policy if exists blocked_dates_select_public on public.blocked_dates;
create policy blocked_dates_select_public on public.blocked_dates
  for select using (true);

drop policy if exists blocked_dates_insert_admin on public.blocked_dates;
drop policy if exists blocked_dates_insert_operators on public.blocked_dates;
create policy blocked_dates_insert_operators on public.blocked_dates
  for insert to authenticated
  with check (public.has_account_role(array['owner','court_owner']));

drop policy if exists blocked_dates_delete_admin on public.blocked_dates;
drop policy if exists blocked_dates_delete_operators on public.blocked_dates;
create policy blocked_dates_delete_operators on public.blocked_dates
  for delete to authenticated
  using (public.has_account_role(array['owner','court_owner']));

drop policy if exists open_play_select_public on public.open_play_registrations;
create policy open_play_select_public on public.open_play_registrations
  for select using (true);

drop policy if exists open_play_insert_public on public.open_play_registrations;
create policy open_play_insert_public on public.open_play_registrations
  for insert with check (true);

drop policy if exists open_play_update_dashboard_roles on public.open_play_registrations;
create policy open_play_update_dashboard_roles on public.open_play_registrations
  for update to authenticated
  using (public.has_account_role(array['owner','court_owner','staff']))
  with check (public.has_account_role(array['owner','court_owner','staff']));

drop policy if exists open_play_delete_admin on public.open_play_registrations;
drop policy if exists open_play_delete_dashboard_roles on public.open_play_registrations;
create policy open_play_delete_dashboard_roles on public.open_play_registrations
  for delete to authenticated
  using (public.has_account_role(array['owner','court_owner','staff']));

drop policy if exists payment_sessions_no_direct on public.payment_sessions;
drop policy if exists payment_sessions_no_direct_access on public.payment_sessions;
drop policy if exists payment_sessions_select_none on public.payment_sessions;
create policy payment_sessions_select_none on public.payment_sessions
  for select to authenticated using (false);

drop policy if exists payment_sessions_insert_none on public.payment_sessions;
create policy payment_sessions_insert_none on public.payment_sessions
  for insert to authenticated with check (false);

drop policy if exists payment_sessions_update_none on public.payment_sessions;
create policy payment_sessions_update_none on public.payment_sessions
  for update to authenticated using (false) with check (false);

drop policy if exists used_gcash_refs_no_select on public.used_gcash_refs;
create policy used_gcash_refs_no_select on public.used_gcash_refs
  for select to authenticated using (false);

drop policy if exists used_gcash_refs_no_write on public.used_gcash_refs;
create policy used_gcash_refs_no_write on public.used_gcash_refs
  for all to authenticated using (false) with check (false);

drop policy if exists receipt_verifications_select_admin on public.receipt_verifications;
create policy receipt_verifications_select_admin on public.receipt_verifications
  for select to authenticated using (true);

drop policy if exists receipt_verifications_no_write on public.receipt_verifications;
create policy receipt_verifications_no_write on public.receipt_verifications
  for all to authenticated using (false) with check (false);

drop policy if exists agreements_select_self_or_owner on public.agreements;
drop policy if exists users_read_own_agreement on public.agreements;
create policy agreements_select_self_or_owner on public.agreements
  for select to authenticated
  using (user_id = auth.uid()::text or public.has_account_role(array['owner']));

drop policy if exists agreements_insert_self on public.agreements;
create policy agreements_insert_self on public.agreements
  for insert to authenticated
  with check (user_id = auth.uid()::text);

drop policy if exists agreements_update_self on public.agreements;
create policy agreements_update_self on public.agreements
  for update to authenticated
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

drop policy if exists weekly_fees_select_role_scoped on public.weekly_fees;
drop policy if exists weekly_fees_select_auth on public.weekly_fees;
create policy weekly_fees_select_role_scoped on public.weekly_fees
  for select to authenticated
  using (public.has_account_role(array['owner','court_owner']));

drop policy if exists weekly_fees_insert_owner on public.weekly_fees;
drop policy if exists weekly_fees_insert_auth on public.weekly_fees;
create policy weekly_fees_insert_owner on public.weekly_fees
  for insert to authenticated
  with check (public.has_account_role(array['owner']));

drop policy if exists weekly_fees_update_role_scoped on public.weekly_fees;
drop policy if exists weekly_fees_update_auth on public.weekly_fees;
create policy weekly_fees_update_role_scoped on public.weekly_fees
  for update to authenticated
  using (public.has_account_role(array['owner','court_owner']))
  with check (
    public.has_account_role(array['owner'])
    or (
      public.has_account_role(array['court_owner'])
      and status = 'submitted'
    )
  );

drop policy if exists weekly_fees_delete_owner on public.weekly_fees;
drop policy if exists weekly_fees_delete_auth on public.weekly_fees;
create policy weekly_fees_delete_owner on public.weekly_fees
  for delete to authenticated
  using (public.has_account_role(array['owner']));

drop policy if exists op_game_sessions_admin_all on public.open_play_game_sessions;
drop policy if exists op_game_sessions_dashboard_all on public.open_play_game_sessions;
create policy op_game_sessions_dashboard_all on public.open_play_game_sessions
  for all to authenticated
  using (public.has_account_role(array['owner','court_owner','staff']))
  with check (public.has_account_role(array['owner','court_owner','staff']));

drop policy if exists op_game_players_admin_all on public.open_play_game_players;
drop policy if exists op_game_players_dashboard_all on public.open_play_game_players;
create policy op_game_players_dashboard_all on public.open_play_game_players
  for all to authenticated
  using (public.has_account_role(array['owner','court_owner','staff']))
  with check (public.has_account_role(array['owner','court_owner','staff']));

drop policy if exists op_game_rounds_admin_all on public.open_play_game_rounds;
drop policy if exists op_game_rounds_dashboard_all on public.open_play_game_rounds;
create policy op_game_rounds_dashboard_all on public.open_play_game_rounds
  for all to authenticated
  using (public.has_account_role(array['owner','court_owner','staff']))
  with check (public.has_account_role(array['owner','court_owner','staff']));

drop policy if exists open_play_host_applications_insert_public on public.open_play_host_applications;
create policy open_play_host_applications_insert_public on public.open_play_host_applications
  for insert with check (status = 'pending');

drop policy if exists open_play_host_applications_owner_all on public.open_play_host_applications;
create policy open_play_host_applications_owner_all on public.open_play_host_applications
  for all to authenticated
  using (public.has_account_role(array['owner','court_owner']))
  with check (public.has_account_role(array['owner','court_owner']));

drop policy if exists open_play_host_sessions_select_public on public.open_play_host_sessions;
create policy open_play_host_sessions_select_public on public.open_play_host_sessions
  for select
  using (status = 'published' or public.has_account_role(array['owner','court_owner','host']));

drop policy if exists open_play_host_sessions_insert_host_roles on public.open_play_host_sessions;
create policy open_play_host_sessions_insert_host_roles on public.open_play_host_sessions
  for insert to authenticated
  with check (
    public.has_account_role(array['owner','court_owner'])
    or (public.has_account_role(array['host']) and host_user_id = auth.uid())
  );

drop policy if exists open_play_host_sessions_update_host_roles on public.open_play_host_sessions;
create policy open_play_host_sessions_update_host_roles on public.open_play_host_sessions
  for update to authenticated
  using (
    public.has_account_role(array['owner','court_owner'])
    or (public.has_account_role(array['host']) and host_user_id = auth.uid())
  )
  with check (
    public.has_account_role(array['owner','court_owner'])
    or (public.has_account_role(array['host']) and host_user_id = auth.uid())
  );

drop policy if exists open_play_host_session_registrations_insert_public
  on public.open_play_host_session_registrations;
create policy open_play_host_session_registrations_insert_public
  on public.open_play_host_session_registrations
  for insert
  with check (
    exists (
      select 1
      from public.open_play_host_sessions s
      where s.id = session_id
        and s.status = 'published'
    )
  );

drop policy if exists open_play_host_session_registrations_select_host_roles
  on public.open_play_host_session_registrations;
create policy open_play_host_session_registrations_select_host_roles
  on public.open_play_host_session_registrations
  for select to authenticated
  using (
    public.has_account_role(array['owner','court_owner'])
    or exists (
      select 1
      from public.open_play_host_sessions s
      where s.id = session_id
        and public.has_account_role(array['host'])
        and s.host_user_id = auth.uid()
    )
  );

drop policy if exists open_play_host_session_registrations_update_host_roles
  on public.open_play_host_session_registrations;
create policy open_play_host_session_registrations_update_host_roles
  on public.open_play_host_session_registrations
  for update to authenticated
  using (
    public.has_account_role(array['owner','court_owner'])
    or exists (
      select 1
      from public.open_play_host_sessions s
      where s.id = session_id
        and public.has_account_role(array['host'])
        and s.host_user_id = auth.uid()
    )
  )
  with check (
    public.has_account_role(array['owner','court_owner'])
    or exists (
      select 1
      from public.open_play_host_sessions s
      where s.id = session_id
        and public.has_account_role(array['host'])
        and s.host_user_id = auth.uid()
    )
  );

drop policy if exists deleted_booking_archive_select_dashboard_roles on public.deleted_booking_archive;
create policy deleted_booking_archive_select_dashboard_roles on public.deleted_booking_archive
  for select to authenticated
  using (public.has_account_role(array['owner','court_owner','staff']));

drop policy if exists deleted_booking_archive_insert_owner on public.deleted_booking_archive;
create policy deleted_booking_archive_insert_owner on public.deleted_booking_archive
  for insert to authenticated
  with check (public.has_account_role(array['owner']));

drop policy if exists deleted_booking_archive_update_owner on public.deleted_booking_archive;
create policy deleted_booking_archive_update_owner on public.deleted_booking_archive
  for update to authenticated
  using (public.has_account_role(array['owner']))
  with check (public.has_account_role(array['owner']));

-- ============================================================
-- 5. STORAGE FOR PRIVATE RECEIPTS
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receipts',
  'receipts',
  false,
  5242880,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'host-ids',
  'host-ids',
  false,
  5242880,
  array['image/jpeg','image/png','image/webp','application/pdf']::text[]
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists receipts_no_select on storage.objects;
create policy receipts_no_select on storage.objects
  for select to anon, authenticated using (bucket_id not in ('receipts','host-ids'));

drop policy if exists receipts_no_insert on storage.objects;
create policy receipts_no_insert on storage.objects
  for insert to anon, authenticated with check (bucket_id not in ('receipts','host-ids'));

drop policy if exists receipts_no_update on storage.objects;
create policy receipts_no_update on storage.objects
  for update to anon, authenticated using (bucket_id not in ('receipts','host-ids'));

drop policy if exists receipts_no_delete on storage.objects;
create policy receipts_no_delete on storage.objects
  for delete to anon, authenticated using (bucket_id not in ('receipts','host-ids'));

drop policy if exists host_ids_no_select on storage.objects;
drop policy if exists host_ids_no_insert on storage.objects;
drop policy if exists host_ids_no_update on storage.objects;
drop policy if exists host_ids_no_delete on storage.objects;

-- ============================================================
-- 6. SEED DATA
-- ============================================================

insert into public.courts (id, name, description, rate, blocked, feats)
values
  ('c1', 'Court Alpha', 'Outdoor - Open Air - Standard Flooring', 350, false, array['Outdoor','Open Air','Standard Floor']),
  ('c2', 'Court Beta', 'Outdoor - Open Air - Standard Flooring', 280, false, array['Outdoor','Open Air','Standard Floor'])
on conflict (id) do nothing;

insert into public.settings (key, value)
values
  ('venue_name', 'Korte DOS'),
  ('open_time', '6'),
  ('close_time', '22'),
  ('booking_fee', '5'),
  ('open_play_fee', '100'),
  ('payment_method_maya', '1'),
  ('payment_method_bpi', '1')
on conflict (key) do nothing;

notify pgrst, 'reload schema';

-- ============================================================
-- DONE
--
-- Next steps:
-- 1. Authentication -> Providers -> Email -> disable Confirm email.
-- 2. Project Settings -> API -> copy Project URL and anon public key.
-- 3. Update .env.local / supabase-config.js for the cloned app.
-- 4. Run create-accounts.js with a service-role key to create dashboard users.
-- 5. Deploy edge functions and configure their required secrets.
-- ============================================================
