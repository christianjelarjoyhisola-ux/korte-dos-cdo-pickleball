-- ============================================================
-- KORTE DOS - COMPLETE SUPABASE DATABASE SETUP
-- Use this on a fresh Supabase project:
--   Supabase Dashboard -> SQL Editor -> New query -> Run
--
-- This file is a consolidated baseline of the migration history.
-- Do not run it as a replacement for migrations on an existing
-- production database unless you have reviewed the seed/upsert data.
--
-- REQUIRED FRESH-INSTALL FOLLOW-UP:
-- After this baseline succeeds, run the complete contents of
-- supabase/migrations/20260713213000_accumulated_booking_fee_remittances.sql
-- as a second SQL Editor query. That migration installs the accumulated
-- exact-cutoff remittance ledger, private proof storage, security policies,
-- and RPCs. The Remittances UI is not ready until both SQL files succeed.
-- Then run:
-- supabase/migrations/20260723153000_payment_review_notifications.sql
-- to install private payment-review notification settings, durable email and
-- decision audits, atomic review RPCs, and the latest receipt-hold policies.
-- For a cloned Supabase project, first replace that migration's scheduled
-- worker URL with the clone's own Project URL; this baseline intentionally
-- cannot infer or schedule a project-specific Edge Function endpoint.
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
  booking_fee_amount_snapshot numeric(12,2),
  balance_due_at timestamptz,
  forfeited_at timestamptz,
  forfeiture_reason text,
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
      'rejected',
      'deposit_retained'
    )),
  constraint bookings_status_check
    check (status in ('pending','verifying','confirmed','cancelled','completed','forfeited')),
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

create table if not exists public.private_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
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
  receipt_verification_id bigint,
  capacity_exception boolean not null default false,
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
    check (receipt_status in ('none','auto_approved','manual_review','rejected')),
  constraint open_play_registration_capacity_exception_check
    check (
      capacity_exception = (
        coalesce(receipt_flags, '{}'::text[])
          @> array['SESSION_CAPACITY_REVIEW']::text[]
      )
      and (
        not capacity_exception
        or (
          lower(coalesce(payment_method, '')) in (
            'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
          )
          and payment_status in ('pending', 'rejected')
          and receipt_status in ('manual_review', 'rejected')
          and amount > 0
          and nullif(btrim(coalesce(gcash_ref, '')), '') is not null
          and receipt_verification_id is not null
          and nullif(btrim(coalesce(receipt_image_url, '')), '') is not null
          and lower(coalesce(receipt_image_hash, '')) ~ '^[a-f0-9]{64}$'
        )
      )
    )
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

alter table public.open_play_registrations
  add column if not exists receipt_verification_id bigint,
  add column if not exists capacity_exception boolean;

update public.open_play_registrations
set capacity_exception = false
where capacity_exception is null;

alter table public.open_play_registrations
  alter column capacity_exception set default false,
  alter column capacity_exception set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname =
      'open_play_registrations_receipt_verification_id_fkey'
      and conrelid = 'public.open_play_registrations'::regclass
  ) then
    alter table public.open_play_registrations
      add constraint open_play_registrations_receipt_verification_id_fkey
      foreign key (receipt_verification_id)
      references public.receipt_verifications(id);
  end if;
end
$$;

comment on column public.open_play_registrations.receipt_verification_id is
  'One-time server receipt-verification record authorizing this digital Open Play registration.';
comment on column public.open_play_registrations.capacity_exception is
  'True only for an attested paid receipt awaiting review outside normal Open Play capacity.';

create table if not exists public.payment_review_notifications (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  receipt_verification_id bigint references public.receipt_verifications(id) on delete set null,
  booking_ref text not null,
  booking_group_ref text,
  context_type text not null,
  image_hash text not null,
  payment_provider text,
  payment_reference_masked text,
  recipient_email text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  provider_message_id text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  sent_at timestamptz,
  constraint payment_review_notifications_context_check
    check (context_type in ('court_booking', 'open_play', 'host_session')),
  constraint payment_review_notifications_status_check
    check (status in ('pending', 'sending', 'sent', 'failed')),
  constraint payment_review_notifications_attempt_count_check
    check (attempt_count >= 0),
  constraint payment_review_notifications_dedupe_key_check
    check (length(dedupe_key) between 16 and 160),
  constraint payment_review_notifications_image_hash_check
    check (image_hash ~ '^[a-f0-9]{64}$')
);

-- The baseline installs the worker contract and secret without assuming a
-- project URL. The project-specific payment-review migration schedules the
-- Edge endpoint after this baseline is installed.
insert into public.private_settings (key, value)
values (
  'payment_review_notification_worker_secret',
  replace(gen_random_uuid()::text, '-', '')
    || replace(gen_random_uuid()::text, '-', '')
)
on conflict (key) do nothing;

create or replace function public.claim_due_payment_review_notifications(
  p_limit integer default 20
)
returns table (
  id uuid,
  dedupe_key text,
  receipt_verification_id bigint,
  booking_ref text,
  booking_group_ref text,
  context_type text,
  image_hash text,
  payment_provider text,
  payment_reference_masked text,
  payload jsonb,
  attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  safe_limit integer := greatest(1, least(coalesce(p_limit, 20), 50));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Service role required'
      using errcode = '42501';
  end if;

  return query
  with due as (
    select notification.id
    from public.payment_review_notifications notification
    where (
      notification.status in ('pending', 'failed')
      and coalesce(
        notification.next_attempt_at,
        notification.created_at
      ) <= clock_timestamp()
    ) or (
      notification.status = 'sending'
      and (
        notification.last_attempt_at is null
        or notification.last_attempt_at
          <= clock_timestamp() - interval '10 minutes'
      )
    )
    order by
      coalesce(
        notification.next_attempt_at,
        notification.last_attempt_at,
        notification.created_at
      ),
      notification.created_at
    for update skip locked
    limit safe_limit
  ),
  claimed as (
    update public.payment_review_notifications notification
    set status = 'sending',
        attempt_count = notification.attempt_count + 1,
        error_message = null,
        last_attempt_at = clock_timestamp(),
        next_attempt_at = null
    from due
    where notification.id = due.id
    returning notification.*
  )
  select
    claimed.id,
    claimed.dedupe_key,
    claimed.receipt_verification_id,
    claimed.booking_ref,
    claimed.booking_group_ref,
    claimed.context_type,
    claimed.image_hash,
    claimed.payment_provider,
    claimed.payment_reference_masked,
    claimed.payload,
    claimed.attempt_count
  from claimed;
end;
$$;

revoke all on function
  public.claim_due_payment_review_notifications(integer)
  from public, anon, authenticated;
grant execute on function
  public.claim_due_payment_review_notifications(integer)
  to service_role;

create table if not exists public.payment_review_decisions (
  id uuid primary key default gen_random_uuid(),
  receipt_verification_id bigint references public.receipt_verifications(id) on delete set null,
  booking_ref text not null,
  booking_group_ref text,
  decision text not null,
  actor_user_id uuid not null,
  actor_role text not null,
  reason text,
  prior_receipt_status text,
  prior_receipt_flags text[] not null default '{}',
  created_at timestamptz not null default now(),
  constraint payment_review_decisions_decision_check
    check (decision in ('approve', 'reject')),
  constraint payment_review_decisions_actor_role_check
    check (actor_role in ('owner', 'court_owner', 'staff'))
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
  receipt_verification_id bigint,
  capacity_exception boolean not null default false,
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
    check (payment_method in ('gcash','bdopay','maya','bpi','maribank','gotyme','pnb','cash')),
  constraint open_play_host_session_registrations_payment_status_check
    check (payment_status in ('pending','paid','rejected')),
  constraint open_play_host_session_registrations_receipt_status_check
    check (receipt_status in ('none','auto_approved','manual_review','rejected')),
  constraint open_play_host_session_registrations_amount_check check (amount >= 0),
  constraint host_registration_capacity_exception_check
    check (
      capacity_exception = (
        coalesce(receipt_flags, '{}'::text[])
          @> array['SESSION_CAPACITY_REVIEW']::text[]
      )
      and (
        not capacity_exception
        or (
          lower(coalesce(payment_method, '')) in (
            'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
          )
          and payment_status in ('pending', 'rejected')
          and receipt_status in ('manual_review', 'rejected')
          and amount > 0
          and nullif(btrim(coalesce(gcash_ref, '')), '') is not null
          and receipt_verification_id is not null
          and nullif(btrim(coalesce(receipt_image_url, '')), '') is not null
          and lower(coalesce(receipt_image_hash, '')) ~ '^[a-f0-9]{64}$'
        )
      )
    )
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
  voided_fee_amount numeric(12,2),
  void_reason text,
  voided_at timestamptz,
  voided_by uuid,
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
  add column if not exists confirmation_email_last_event text,
  add column if not exists booking_fee_amount_snapshot numeric(12,2),
  add column if not exists balance_due_at timestamptz,
  add column if not exists forfeited_at timestamptz,
  add column if not exists forfeiture_reason text;

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
    'rejected',
    'deposit_retained'
  ));

alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings
  add constraint bookings_status_check
  check (status in ('pending','verifying','confirmed','cancelled','completed','forfeited'));

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
  add column if not exists receipt_verified_at timestamptz,
  add column if not exists capacity_exception boolean;

update public.open_play_registrations
set payment_status = coalesce(payment_status, 'pending'),
    receipt_status = coalesce(receipt_status, 'none'),
    receipt_flags = coalesce(receipt_flags, '{}'),
    capacity_exception = coalesce(capacity_exception, false)
where payment_status is null
   or receipt_status is null
   or receipt_flags is null
   or capacity_exception is null;

alter table public.open_play_registrations
  alter column capacity_exception set default false,
  alter column capacity_exception set not null;

update public.open_play_registrations
set receipt_flags = case
  when capacity_exception then array_append(
    array_remove(
      coalesce(receipt_flags, '{}'::text[]),
      'SESSION_CAPACITY_REVIEW'
    ),
    'SESSION_CAPACITY_REVIEW'
  )
  else array_remove(
    coalesce(receipt_flags, '{}'::text[]),
    'SESSION_CAPACITY_REVIEW'
  )
end;

alter table public.open_play_registrations drop constraint if exists open_play_payment_status_check;
alter table public.open_play_registrations
  add constraint open_play_payment_status_check
  check (payment_status in ('pending','paid','rejected'));

alter table public.open_play_registrations drop constraint if exists open_play_receipt_status_check;
alter table public.open_play_registrations
  add constraint open_play_receipt_status_check
  check (receipt_status in ('none','auto_approved','manual_review','rejected'));

alter table public.open_play_registrations
  drop constraint if exists open_play_registration_capacity_exception_check;
alter table public.open_play_registrations
  add constraint open_play_registration_capacity_exception_check
  check (
    capacity_exception = (
      coalesce(receipt_flags, '{}'::text[])
        @> array['SESSION_CAPACITY_REVIEW']::text[]
    )
    and (
      not capacity_exception
      or (
        lower(coalesce(payment_method, '')) in (
          'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
        )
        and payment_status in ('pending', 'rejected')
        and receipt_status in ('manual_review', 'rejected')
        and amount > 0
        and nullif(btrim(coalesce(gcash_ref, '')), '') is not null
        and receipt_verification_id is not null
        and nullif(btrim(coalesce(receipt_image_url, '')), '') is not null
        and lower(coalesce(receipt_image_hash, '')) ~ '^[a-f0-9]{64}$'
      )
    )
  );

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
  check (payment_method in ('gcash','bdopay','maya','bpi','maribank','gotyme','pnb','cash'));

alter table public.open_play_host_session_registrations
  add column if not exists receipt_verification_id bigint,
  add column if not exists capacity_exception boolean;

update public.open_play_host_session_registrations
set capacity_exception = false
where capacity_exception is null;

alter table public.open_play_host_session_registrations
  alter column capacity_exception set default false,
  alter column capacity_exception set not null;

update public.open_play_host_session_registrations
set receipt_flags = case
  when capacity_exception then array_append(
    array_remove(
      coalesce(receipt_flags, '{}'::text[]),
      'SESSION_CAPACITY_REVIEW'
    ),
    'SESSION_CAPACITY_REVIEW'
  )
  else array_remove(
    coalesce(receipt_flags, '{}'::text[]),
    'SESSION_CAPACITY_REVIEW'
  )
end;

do $$
begin
  if not exists (
    select 1
    from pg_constraint constraint_row
    join pg_attribute source_column
      on source_column.attrelid = constraint_row.conrelid
     and source_column.attnum = constraint_row.conkey[1]
    join pg_attribute target_column
      on target_column.attrelid = constraint_row.confrelid
     and target_column.attnum = constraint_row.confkey[1]
    where constraint_row.contype = 'f'
      and constraint_row.conrelid =
        'public.open_play_host_session_registrations'::regclass
      and constraint_row.confrelid =
        'public.receipt_verifications'::regclass
      and array_length(constraint_row.conkey, 1) = 1
      and array_length(constraint_row.confkey, 1) = 1
      and source_column.attname = 'receipt_verification_id'
      and target_column.attname = 'id'
  ) then
    alter table public.open_play_host_session_registrations
      add constraint
        open_play_host_receipt_verification_fkey
      foreign key (receipt_verification_id)
      references public.receipt_verifications(id);
  end if;
end
$$;

alter table public.open_play_host_session_registrations
  drop constraint if exists host_registration_capacity_exception_check;
alter table public.open_play_host_session_registrations
  add constraint host_registration_capacity_exception_check
  check (
    capacity_exception = (
      coalesce(receipt_flags, '{}'::text[])
        @> array['SESSION_CAPACITY_REVIEW']::text[]
    )
    and (
      not capacity_exception
      or (
        lower(coalesce(payment_method, '')) in (
          'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
        )
        and payment_status in ('pending', 'rejected')
        and receipt_status in ('manual_review', 'rejected')
        and amount > 0
        and nullif(btrim(coalesce(gcash_ref, '')), '') is not null
        and receipt_verification_id is not null
        and nullif(btrim(coalesce(receipt_image_url, '')), '') is not null
        and lower(coalesce(receipt_image_hash, '')) ~ '^[a-f0-9]{64}$'
      )
    )
  );

comment on column
  public.open_play_host_session_registrations.receipt_verification_id is
  'One-time server receipt-verification record authorizing this paid host-session registration.';
comment on column
  public.open_play_host_session_registrations.capacity_exception is
  'True only for an attested paid receipt awaiting review outside normal session capacity.';

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
create index if not exists idx_payment_review_notifications_due
  on public.payment_review_notifications(status, next_attempt_at, created_at)
  where status in ('pending', 'failed', 'sending');
create index if not exists idx_payment_review_notifications_booking
  on public.payment_review_notifications(booking_ref, created_at desc);
create index if not exists idx_payment_review_notifications_recent
  on public.payment_review_notifications(created_at desc);
create index if not exists idx_payment_review_decisions_booking
  on public.payment_review_decisions(booking_ref, created_at desc);
create index if not exists idx_payment_review_decisions_group
  on public.payment_review_decisions(booking_group_ref, created_at desc)
  where booking_group_ref is not null;
create index if not exists idx_payment_review_decisions_receipt
  on public.payment_review_decisions(receipt_verification_id, created_at desc)
  where receipt_verification_id is not null;
create index if not exists idx_payment_review_decisions_recent
  on public.payment_review_decisions(created_at desc);
create unique index if not exists agreements_user_version_uq on public.agreements (user_id, version);

create unique index if not exists weekly_fees_owner_week_uq
  on public.weekly_fees (court_owner_user_id, week_start, week_end);
create index if not exists idx_weekly_fees_status on public.weekly_fees (status);
create index if not exists idx_weekly_fees_week_start on public.weekly_fees (week_start desc);

-- These pure matchers centralize the immutable audit contract used by
-- migration backfills, transitional stale-tab inserts, and human review.
-- The legacy branch is intentionally narrow and accepts only the verifier's
-- short-lived legacyRegistrationContext marker.
create or replace function public.open_play_receipt_audit_matches(
  p_extracted jsonb,
  p_full_name text,
  p_court_id text,
  p_court_name text,
  p_date date,
  p_hour integer,
  p_time_label text,
  p_payment_type text,
  p_payment_method text,
  p_payment_ref text,
  p_amount numeric
)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  registration_context jsonb;
  legacy_registration_context jsonb;
  audit_provider text;
  audit_reference text;
  audit_amount_text text;
  audit_total_text text;
  audit_amount numeric;
  audit_total numeric;
  normalized_payment_type text :=
    lower(btrim(coalesce(p_payment_type, '')));
  legacy_context boolean := false;
begin
  if jsonb_typeof(p_extracted) <> 'object' then
    return false;
  end if;

  registration_context := p_extracted->'registrationContext';
  legacy_registration_context :=
    p_extracted->'legacyRegistrationContext';
  legacy_context :=
    jsonb_typeof(registration_context) is distinct from 'object'
    and jsonb_typeof(legacy_registration_context) = 'object';

  audit_provider := lower(nullif(btrim(coalesce(
    p_extracted->>'provider',
    p_extracted->>'payment_method',
    p_extracted->>'paymentMethod'
  )), ''));
  audit_reference := nullif(btrim(coalesce(
    p_extracted->>'submittedReference',
    p_extracted->>'gcash_ref',
    p_extracted->>'gcashRef'
  )), '');
  audit_amount_text := btrim(coalesce(
    p_extracted->>'expectedAmount',
    p_extracted->>'downpayment',
    ''
  ));
  audit_total_text := btrim(coalesce(
    p_extracted->>'expectedTotal',
    p_extracted->>'total',
    ''
  ));

  if audit_provider is null
     or audit_provider is distinct from
       lower(nullif(btrim(p_payment_method), ''))
     or audit_reference is null
     or upper(audit_reference) is distinct from
       upper(nullif(btrim(p_payment_ref), ''))
     or audit_amount_text !~ '^[0-9]+([.][0-9]+)?$'
     or audit_total_text !~ '^[0-9]+([.][0-9]+)?$'
     or p_amount is null
     or normalized_payment_type not in ('50%', '100%') then
    return false;
  end if;

  audit_amount := audit_amount_text::numeric;
  audit_total := audit_total_text::numeric;
  if abs(audit_amount - p_amount) > 0.01
     or (
       normalized_payment_type = '100%'
       and abs(audit_amount - audit_total) > 0.01
     )
     or (
       normalized_payment_type = '50%'
       and abs(audit_amount - round(audit_total / 2, 2)) > 0.01
     ) then
    return false;
  end if;

  if jsonb_typeof(registration_context) = 'object' then
    return
      coalesce(p_extracted->>'verificationContext', '') = 'open_play'
      and nullif(btrim(registration_context->>'fullName'), '')
        is not distinct from nullif(btrim(p_full_name), '')
      and nullif(btrim(registration_context->>'courtId'), '')
        is not distinct from nullif(btrim(p_court_id), '')
      and nullif(btrim(registration_context->>'courtName'), '')
        is not distinct from nullif(btrim(p_court_name), '')
      and nullif(btrim(registration_context->>'date'), '')
        is not distinct from p_date::text
      and coalesce(registration_context->>'hour', '') ~ '^-?[0-9]+$'
      and case
        when coalesce(registration_context->>'hour', '') ~ '^-?[0-9]+$'
          then (registration_context->>'hour')::integer
        else null
      end is not distinct from p_hour
      and nullif(btrim(registration_context->>'timeLabel'), '')
        is not distinct from nullif(btrim(p_time_label), '')
      and lower(nullif(btrim(
        registration_context->>'paymentType'
      ), '')) is not distinct from normalized_payment_type;
  end if;

  return legacy_context
    and coalesce(p_extracted->>'verificationContext', '') = 'open_play'
    and nullif(btrim(legacy_registration_context->>'fullName'), '')
      is not distinct from nullif(btrim(p_full_name), '')
    and nullif(btrim(legacy_registration_context->>'date'), '')
      is not distinct from p_date::text;
end;
$$;

create or replace function public.host_session_receipt_audit_matches(
  p_extracted jsonb,
  p_session_id uuid,
  p_session_date date,
  p_full_name text,
  p_contact_number text,
  p_payment_method text,
  p_payment_ref text,
  p_amount numeric
)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  registration_context jsonb;
  legacy_registration_context jsonb;
  audit_provider text;
  audit_reference text;
  audit_amount_text text;
  audit_total_text text;
  audit_amount numeric;
  audit_total numeric;
  legacy_context boolean := false;
begin
  if jsonb_typeof(p_extracted) <> 'object' then
    return false;
  end if;

  registration_context := p_extracted->'registrationContext';
  legacy_registration_context :=
    p_extracted->'legacyRegistrationContext';
  legacy_context :=
    jsonb_typeof(registration_context) is distinct from 'object'
    and jsonb_typeof(legacy_registration_context) = 'object';

  audit_provider := lower(nullif(btrim(coalesce(
    p_extracted->>'provider',
    p_extracted->>'payment_method',
    p_extracted->>'paymentMethod'
  )), ''));
  audit_reference := nullif(btrim(coalesce(
    p_extracted->>'submittedReference',
    p_extracted->>'gcash_ref',
    p_extracted->>'gcashRef'
  )), '');
  audit_amount_text := btrim(coalesce(
    p_extracted->>'expectedAmount',
    p_extracted->>'downpayment',
    ''
  ));
  audit_total_text := btrim(coalesce(
    p_extracted->>'expectedTotal',
    p_extracted->>'total',
    ''
  ));

  if audit_provider is null
     or audit_provider is distinct from
       lower(nullif(btrim(p_payment_method), ''))
     or audit_reference is null
     or upper(audit_reference) is distinct from
       upper(nullif(btrim(p_payment_ref), ''))
     or audit_amount_text !~ '^[0-9]+([.][0-9]+)?$'
     or audit_total_text !~ '^[0-9]+([.][0-9]+)?$'
     or p_amount is null then
    return false;
  end if;

  audit_amount := audit_amount_text::numeric;
  audit_total := audit_total_text::numeric;
  if abs(audit_amount - p_amount) > 0.01
     or abs(audit_amount - audit_total) > 0.01 then
    return false;
  end if;

  if jsonb_typeof(registration_context) = 'object' then
    return
      coalesce(p_extracted->>'verificationContext', '') = 'host_session'
      and nullif(btrim(registration_context->>'fullName'), '')
        is not distinct from nullif(btrim(p_full_name), '')
      and registration_context ? 'contactNumber'
      and btrim(coalesce(registration_context->>'contactNumber', ''))
        is not distinct from btrim(coalesce(p_contact_number, ''))
      and nullif(btrim(registration_context->>'hostSessionId'), '')
        is not distinct from p_session_id::text
      and nullif(btrim(registration_context->>'date'), '')
        is not distinct from p_session_date::text;
  end if;

  return legacy_context
    and coalesce(p_extracted->>'verificationContext', '') = 'host_session'
    and nullif(btrim(
      legacy_registration_context->>'hostSessionId'
    ), '') is not distinct from p_session_id::text
    and nullif(btrim(legacy_registration_context->>'fullName'), '')
      is not distinct from nullif(btrim(p_full_name), '')
    and nullif(btrim(legacy_registration_context->>'date'), '')
      is not distinct from p_session_date::text;
end;
$$;

revoke all on function public.open_play_receipt_audit_matches(
  jsonb, text, text, text, date, integer, text, text, text, text, numeric
) from public, anon, authenticated;
revoke all on function public.host_session_receipt_audit_matches(
  jsonb, uuid, date, text, text, text, text, numeric
) from public, anon, authenticated;

-- Strictly bind legacy rows only when exactly one recent private audit matches
-- the deterministic object path, immutable fields, amount, and outcome.
with eligible_registration as (
  select registration.id
  from public.open_play_registrations registration
  where registration.receipt_verification_id is null
    and lower(coalesce(registration.payment_method, '')) in (
      'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
    )
    and nullif(btrim(coalesce(registration.gcash_ref, '')), '') is not null
    and registration.amount > 0
    and nullif(btrim(coalesce(registration.receipt_image_url, '')), '') is not null
    and lower(coalesce(registration.receipt_image_hash, ''))
      ~ '^[a-f0-9]{64}$'
    and not exists (
      select 1
      from public.open_play_registrations duplicate_registration
      where duplicate_registration.id <> registration.id
        and (
          lower(nullif(btrim(duplicate_registration.receipt_image_hash), ''))
            = lower(nullif(btrim(registration.receipt_image_hash), ''))
          or nullif(btrim(duplicate_registration.receipt_image_url), '')
            = nullif(btrim(registration.receipt_image_url), '')
        )
    )
),
verification_candidate as (
  select
    registration.id as registration_id,
    verification.id as verification_id
  from public.open_play_registrations registration
  join eligible_registration eligible
    on eligible.id = registration.id
  join public.receipt_verifications verification
    on verification.booking_ref ~ '^OP-[A-Z0-9]{6,40}$'
   and verification.created_at >= registration.created_at - interval '30 minutes'
   and verification.created_at <= registration.created_at + interval '5 minutes'
   and lower(coalesce(verification.image_hash, ''))
     = lower(registration.receipt_image_hash)
   and registration.receipt_image_url in (
     verification.booking_ref || '/' || lower(verification.image_hash) || '.jpg',
     verification.booking_ref || '/' || lower(verification.image_hash) || '.png',
     verification.booking_ref || '/' || lower(verification.image_hash) || '.webp',
     verification.booking_ref || '/' || lower(verification.image_hash) || '.heic'
   )
   and verification.result in ('auto_approved', 'manual_review', 'rejected')
   and (
     jsonb_typeof(verification.extracted->'registrationContext') = 'object'
     or (
       jsonb_typeof(
         verification.extracted->'legacyRegistrationContext'
       ) = 'object'
       and verification.created_at <
         timestamptz '2026-07-26 00:00:00+00'
     )
   )
   and (
     (
       verification.result = 'auto_approved'
       and registration.payment_status = 'paid'
       and registration.receipt_status = 'auto_approved'
     )
     or (
       verification.result in ('manual_review', 'rejected')
       and registration.payment_status = 'pending'
       and registration.receipt_status in ('manual_review', 'rejected')
     )
   )
   and public.open_play_receipt_audit_matches(
     verification.extracted,
     registration.full_name,
     registration.court_id,
     registration.court_name,
     registration.date,
     registration.hour,
     registration.time_label,
     registration.payment_type,
     registration.payment_method,
     registration.gcash_ref,
     registration.amount
   )
   and not exists (
     select 1
     from public.open_play_registrations claimed_registration
     where claimed_registration.id <> registration.id
       and claimed_registration.receipt_verification_id = verification.id
   )
),
matched_verification as (
  select
    candidate.registration_id,
    min(candidate.verification_id) as verification_id
  from verification_candidate candidate
  group by candidate.registration_id
  having count(*) = 1
)
update public.open_play_registrations registration
set receipt_verification_id = matched.verification_id,
    payment_method = lower(btrim(verification.extracted->>'provider')),
    gcash_ref = btrim(verification.extracted->>'submittedReference'),
    amount = round(
      (verification.extracted->>'expectedAmount')::numeric,
      2
    ),
    payment_status = case
      when jsonb_typeof(
        verification.extracted->'legacyRegistrationContext'
      ) = 'object' then 'pending'
      when verification.result = 'auto_approved' then 'paid'
      else 'pending'
    end,
    receipt_image_hash = lower(btrim(verification.image_hash)),
    receipt_phash = nullif(btrim(verification.phash), ''),
    receipt_status = case
      when jsonb_typeof(
        verification.extracted->'legacyRegistrationContext'
      ) = 'object' then 'manual_review'
      when verification.result = 'auto_approved' then 'auto_approved'
      else 'manual_review'
    end,
    receipt_flags = case
      when jsonb_typeof(
        verification.extracted->'legacyRegistrationContext'
      ) = 'object' then array_append(
        array_remove(
          array_remove(
            coalesce(verification.flags, '{}'::text[]),
            'SESSION_CAPACITY_REVIEW'
          ),
          'LEGACY_CLIENT_REVIEW'
        ),
        'LEGACY_CLIENT_REVIEW'
      )
      else array_remove(
        coalesce(verification.flags, '{}'::text[]),
        'SESSION_CAPACITY_REVIEW'
      )
    end,
    receipt_extracted = verification.extracted - array[
      'verificationContext',
      'registrationContext',
      'legacyRegistrationContext',
      'submittedReference',
      'expectedAmount',
      'expectedTotal',
      'dedupeKeys',
      'ocrAnalysisText'
    ],
    receipt_confidence = verification.confidence,
    receipt_verified_at = verification.created_at,
    capacity_exception = false
from matched_verification matched
join public.receipt_verifications verification
  on verification.id = matched.verification_id
where registration.id = matched.registration_id;

update public.open_play_registrations registration
set receipt_flags = array_append(
  array_remove(
    coalesce(registration.receipt_flags, '{}'::text[]),
    'LEGACY_RECEIPT_UNATTESTED'
  ),
  'LEGACY_RECEIPT_UNATTESTED'
)
where registration.receipt_verification_id is null
  and lower(coalesce(registration.payment_method, '')) in (
    'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
  )
  and (
    nullif(btrim(coalesce(registration.receipt_image_url, '')), '') is not null
    or nullif(btrim(coalesce(registration.receipt_image_hash, '')), '') is not null
  );

with eligible_registration as (
  select registration.id
  from public.open_play_host_session_registrations registration
  where registration.receipt_verification_id is null
    and lower(coalesce(registration.payment_method, '')) in (
      'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
    )
    and nullif(btrim(coalesce(registration.gcash_ref, '')), '') is not null
    and registration.amount > 0
    and nullif(btrim(coalesce(registration.receipt_image_url, '')), '') is not null
    and lower(coalesce(registration.receipt_image_hash, ''))
      ~ '^[a-f0-9]{64}$'
    and not exists (
      select 1
      from public.open_play_host_session_registrations duplicate_registration
      where duplicate_registration.id <> registration.id
        and (
          lower(nullif(btrim(duplicate_registration.receipt_image_hash), ''))
            = lower(nullif(btrim(registration.receipt_image_hash), ''))
          or nullif(btrim(duplicate_registration.receipt_image_url), '')
            = nullif(btrim(registration.receipt_image_url), '')
        )
    )
),
verification_candidate as (
  select
    registration.id as registration_id,
    verification.id as verification_id
  from public.open_play_host_session_registrations registration
  join eligible_registration eligible
    on eligible.id = registration.id
  join public.open_play_host_sessions host_session
    on host_session.id = registration.session_id
  join public.receipt_verifications verification
    on verification.booking_ref ~ '^HS-[A-Z0-9]{6,40}$'
   and verification.created_at >= registration.created_at - interval '30 minutes'
   and verification.created_at <= registration.created_at + interval '5 minutes'
   and lower(coalesce(verification.image_hash, ''))
     = lower(registration.receipt_image_hash)
   and registration.receipt_image_url in (
     verification.booking_ref || '/' || lower(verification.image_hash) || '.jpg',
     verification.booking_ref || '/' || lower(verification.image_hash) || '.png',
     verification.booking_ref || '/' || lower(verification.image_hash) || '.webp',
     verification.booking_ref || '/' || lower(verification.image_hash) || '.heic'
   )
   and verification.result in ('auto_approved', 'manual_review', 'rejected')
   and (
     jsonb_typeof(verification.extracted->'registrationContext') = 'object'
     or (
       jsonb_typeof(
         verification.extracted->'legacyRegistrationContext'
       ) = 'object'
       and verification.created_at <
         timestamptz '2026-07-26 00:00:00+00'
     )
   )
   and (
     (
       verification.result = 'auto_approved'
       and registration.payment_status = 'paid'
       and registration.receipt_status = 'auto_approved'
     )
     or (
       verification.result in ('manual_review', 'rejected')
       and registration.payment_status = 'pending'
       and registration.receipt_status in ('manual_review', 'rejected')
     )
   )
   and public.host_session_receipt_audit_matches(
     verification.extracted,
     registration.session_id,
     host_session.date,
     registration.full_name,
     registration.contact_number,
     registration.payment_method,
     registration.gcash_ref,
     registration.amount
   )
   and not exists (
     select 1
     from public.open_play_host_session_registrations claimed_registration
     where claimed_registration.id <> registration.id
       and claimed_registration.receipt_verification_id = verification.id
   )
),
matched_verification as (
  select
    candidate.registration_id,
    min(candidate.verification_id) as verification_id
  from verification_candidate candidate
  group by candidate.registration_id
  having count(*) = 1
)
update public.open_play_host_session_registrations registration
set receipt_verification_id = matched.verification_id,
    payment_method = lower(btrim(verification.extracted->>'provider')),
    gcash_ref = btrim(verification.extracted->>'submittedReference'),
    amount = round(
      (verification.extracted->>'expectedAmount')::numeric,
      2
    ),
    payment_status = case
      when jsonb_typeof(
        verification.extracted->'legacyRegistrationContext'
      ) = 'object' then 'pending'
      when verification.result = 'auto_approved' then 'paid'
      else 'pending'
    end,
    receipt_image_hash = lower(btrim(verification.image_hash)),
    receipt_phash = nullif(btrim(verification.phash), ''),
    receipt_status = case
      when jsonb_typeof(
        verification.extracted->'legacyRegistrationContext'
      ) = 'object' then 'manual_review'
      when verification.result = 'auto_approved' then 'auto_approved'
      else 'manual_review'
    end,
    receipt_flags = case
      when jsonb_typeof(
        verification.extracted->'legacyRegistrationContext'
      ) = 'object' then array_append(
        array_remove(
          array_remove(
            coalesce(verification.flags, '{}'::text[]),
            'SESSION_CAPACITY_REVIEW'
          ),
          'LEGACY_CLIENT_REVIEW'
        ),
        'LEGACY_CLIENT_REVIEW'
      )
      else array_remove(
        coalesce(verification.flags, '{}'::text[]),
        'SESSION_CAPACITY_REVIEW'
      )
    end,
    receipt_extracted = verification.extracted - array[
      'verificationContext',
      'registrationContext',
      'legacyRegistrationContext',
      'submittedReference',
      'expectedAmount',
      'expectedTotal',
      'dedupeKeys',
      'ocrAnalysisText'
    ],
    receipt_confidence = verification.confidence,
    receipt_verified_at = verification.created_at,
    capacity_exception = false
from matched_verification matched
join public.receipt_verifications verification
  on verification.id = matched.verification_id
where registration.id = matched.registration_id;

update public.open_play_host_session_registrations registration
set receipt_flags = array_append(
  array_remove(
    coalesce(registration.receipt_flags, '{}'::text[]),
    'LEGACY_RECEIPT_UNATTESTED'
  ),
  'LEGACY_RECEIPT_UNATTESTED'
)
where registration.receipt_verification_id is null
  and lower(coalesce(registration.payment_method, '')) in (
    'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
  )
  and (
    nullif(btrim(coalesce(registration.receipt_image_url, '')), '') is not null
    or nullif(btrim(coalesce(registration.receipt_image_hash, '')), '') is not null
  );

create unique index if not exists
  uniq_open_play_receipt_verification_id
  on public.open_play_registrations(receipt_verification_id)
  where receipt_verification_id is not null;
create unique index if not exists
  uniq_open_play_receipt_image_hash_secured
  on public.open_play_registrations(lower(receipt_image_hash))
  where receipt_verification_id is not null;
create unique index if not exists
  uniq_open_play_receipt_image_url_secured
  on public.open_play_registrations(receipt_image_url)
  where receipt_verification_id is not null;
create index if not exists idx_open_play_registration_active_capacity
  on public.open_play_registrations(date, court_id)
  where coalesce(payment_status, 'pending') <> 'rejected'
    and not capacity_exception;

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
create unique index if not exists
  uniq_host_session_registration_receipt_verification_id
  on public.open_play_host_session_registrations(receipt_verification_id)
  where receipt_verification_id is not null;
create unique index if not exists
  uniq_host_session_registration_receipt_image_hash
  on public.open_play_host_session_registrations(lower(receipt_image_hash))
  where receipt_verification_id is not null;
create unique index if not exists
  uniq_host_session_registration_receipt_image_url
  on public.open_play_host_session_registrations(receipt_image_url)
  where receipt_verification_id is not null;
create index if not exists idx_host_session_registration_active_capacity
  on public.open_play_host_session_registrations(session_id)
  where payment_status <> 'rejected'
    and not (payment_status = 'pending' and capacity_exception);

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

create or replace function public.apply_payment_review_decision(
  p_booking_ref text,
  p_decision text,
  p_actor_user_id uuid,
  p_actor_role text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_ref text := nullif(btrim(coalesce(p_booking_ref, '')), '');
  requested_decision text := lower(btrim(coalesce(p_decision, '')));
  requested_role text := lower(btrim(coalesce(p_actor_role, '')));
  clean_reason text := nullif(left(btrim(coalesce(p_reason, '')), 1000), '');
  authoritative_role text;
  primary_ref text;
  group_ref text;
  primary_payment_ref text;
  primary_provider text;
  primary_receipt_hash text;
  claimed_by_ref text;
  ledger_item record;
  ledger_count integer := 0;
  booking_refs text[];
  booking_count integer := 0;
  pending_count integer := 0;
  evidence_count integer := 0;
  approved_count integer := 0;
  rejected_count integer := 0;
  paid_count integer := 0;
  total_amount numeric := 0;
  paid_amount numeric := 0;
  final_payment_status text;
  prior_statuses text;
  prior_flags text[] := '{}';
  latest_receipt_verification_id bigint;
  latest_receipt_extracted jsonb;
begin
  if requested_ref is null then
    raise exception using
      errcode = '22023',
      message = 'A booking reference is required.';
  end if;

  if requested_decision not in ('approve', 'reject') then
    raise exception using
      errcode = '22023',
      message = 'Payment review decision must be approve or reject.';
  end if;

  if p_actor_user_id is null
     or requested_role not in ('owner', 'court_owner', 'staff') then
    raise exception using
      errcode = '22023',
      message = 'A valid payment-review actor is required.';
  end if;

  select account.role
    into authoritative_role
    from public.accounts account
   where account.id = p_actor_user_id
     and account.status = 'active'
   limit 1;

  if authoritative_role is null
     or authoritative_role <> requested_role
     or authoritative_role not in ('owner', 'court_owner', 'staff') then
    raise exception using
      errcode = '42501',
      message = 'The payment-review actor is not an active authorized account.';
  end if;

  select booking.ref, booking.booking_group_ref
    into primary_ref, group_ref
    from public.bookings booking
   where booking.ref = requested_ref
      or booking.booking_group_ref = requested_ref
   order by
     case when booking.ref = requested_ref then 0 else 1 end,
     booking.created_at,
     booking.ref
   limit 1;

  if primary_ref is null then
    raise exception using
      errcode = 'P0002',
      message = format('Booking or booking group %s was not found.', requested_ref);
  end if;

  -- Every reviewer locks a group in the same stable order. This serializes
  -- concurrent approve/reject requests and prevents partial group decisions.
  perform booking.ref
    from public.bookings booking
   where (
     group_ref is not null
     and booking.booking_group_ref = group_ref
   ) or (
     group_ref is null
     and booking.ref = primary_ref
   )
   order by booking.ref
   for update;

  select
    array_agg(booking.ref order by booking.ref),
    count(*)::integer,
    count(*) filter (
      where booking.status = 'pending'
        and booking.payment_status = 'for_verification'
    )::integer,
    count(*) filter (
      where nullif(btrim(coalesce(booking.receipt_image_url, '')), '') is not null
        and lower(coalesce(booking.receipt_image_hash, ''))
          ~ '^[a-f0-9]{64}$'
    )::integer,
    count(*) filter (
      where booking.status = 'confirmed'
        and booking.payment_status in ('paid', 'downpayment_paid')
    )::integer,
    count(*) filter (
      where booking.status = 'cancelled'
        and booking.payment_status = 'rejected'
    )::integer,
    count(*) filter (where booking.payment_status = 'paid')::integer,
    coalesce(sum(booking.total), 0),
    coalesce(sum(booking.downpayment), 0),
    string_agg(
      distinct coalesce(nullif(btrim(booking.receipt_status), ''), 'none'),
      ',' order by coalesce(nullif(btrim(booking.receipt_status), ''), 'none')
    )
    into
      booking_refs,
      booking_count,
      pending_count,
      evidence_count,
      approved_count,
      rejected_count,
      paid_count,
      total_amount,
      paid_amount,
      prior_statuses
    from public.bookings booking
   where (
     group_ref is not null
     and booking.booking_group_ref = group_ref
   ) or (
     group_ref is null
     and booking.ref = primary_ref
   );

  if booking_count = 0 then
    raise exception using
      errcode = 'P0002',
      message = 'The payment-review booking group no longer exists.';
  end if;

  final_payment_status := case
    when paid_amount >= total_amount - 0.01 then 'paid'
    else 'downpayment_paid'
  end;

  select
    booking.gcash_ref,
    lower(nullif(btrim(booking.payment_method), '')),
    lower(nullif(btrim(booking.receipt_image_hash), ''))
    into primary_payment_ref, primary_provider, primary_receipt_hash
    from public.bookings booking
   where booking.ref = primary_ref;

  if requested_decision = 'approve' and approved_count = booking_count then
    return jsonb_build_object(
      'alreadyApplied', true,
      'status', 'confirmed',
      'paymentStatus', case
        when paid_count = booking_count then 'paid'
        else 'downpayment_paid'
      end,
      'refs', to_jsonb(booking_refs)
    );
  end if;

  if requested_decision = 'reject' and rejected_count = booking_count then
    return jsonb_build_object(
      'alreadyApplied', true,
      'status', 'cancelled',
      'paymentStatus', 'rejected',
      'refs', to_jsonb(booking_refs)
    );
  end if;

  if pending_count <> booking_count then
    raise exception using
      errcode = 'P0001',
      message = 'Every booking in this payment review must still be pending and for verification.';
  end if;

  if evidence_count <> booking_count then
    raise exception using
      errcode = 'P0001',
      message = 'Every booking in this payment review must have stored receipt evidence.';
  end if;

  select coalesce(
    array_agg(distinct flag_value order by flag_value)
      filter (where flag_value is not null and btrim(flag_value) <> ''),
    '{}'::text[]
  )
    into prior_flags
    from public.bookings booking
    left join lateral unnest(coalesce(booking.receipt_flags, '{}'::text[]))
      as flag_value on true
   where (
     group_ref is not null
     and booking.booking_group_ref = group_ref
   ) or (
     group_ref is null
     and booking.ref = primary_ref
   );

  select verification.id, verification.extracted
    into latest_receipt_verification_id, latest_receipt_extracted
    from public.receipt_verifications verification
   where verification.booking_ref = any(booking_refs)
     and lower(coalesce(verification.image_hash, '')) = primary_receipt_hash
   order by verification.created_at desc, verification.id desc
   limit 1;

  if requested_decision = 'approve' then
    if latest_receipt_verification_id is null then
      raise exception using
        errcode = 'P0001',
        message = 'The stored receipt has no matching server verification audit.';
    end if;

    for ledger_item in
      select distinct keys.ledger_key, keys.provider_key
      from public.payment_review_ledger_keys(
        latest_receipt_extracted,
        primary_provider,
        primary_payment_ref
      ) keys
    loop
      ledger_count := ledger_count + 1;

      insert into public.used_gcash_refs (
        gcash_ref,
        booking_ref,
        provider
      )
      values (
        ledger_item.ledger_key,
        primary_ref,
        ledger_item.provider_key
      )
      on conflict (gcash_ref) do nothing;

      select used_ref.booking_ref
        into claimed_by_ref
        from public.used_gcash_refs used_ref
       where used_ref.gcash_ref = ledger_item.ledger_key
       for update;

      if claimed_by_ref is null then
        raise exception using
          errcode = 'P0001',
          message = 'The payment reference could not be claimed.';
      end if;

      if not (claimed_by_ref = any(booking_refs)) then
        raise exception using
          errcode = '23505',
          message = 'Duplicate payment reference: this reference belongs to another payment.';
      end if;
    end loop;

    if ledger_count = 0 then
      raise exception using
        errcode = 'P0001',
        message = 'The receipt has no authoritative payment replay key.';
    end if;

    update public.bookings booking
       set status = 'confirmed',
           payment_status = final_payment_status,
           receipt_verified_at = coalesce(booking.receipt_verified_at, now())
     where (
       group_ref is not null
       and booking.booking_group_ref = group_ref
     ) or (
       group_ref is null
       and booking.ref = primary_ref
     );
  else
    update public.bookings booking
       set status = 'cancelled',
           payment_status = 'rejected',
           receipt_verified_at = coalesce(booking.receipt_verified_at, now())
     where (
       group_ref is not null
       and booking.booking_group_ref = group_ref
     ) or (
       group_ref is null
       and booking.ref = primary_ref
     );
  end if;

  insert into public.payment_review_decisions (
    receipt_verification_id,
    booking_ref,
    booking_group_ref,
    decision,
    actor_user_id,
    actor_role,
    reason,
    prior_receipt_status,
    prior_receipt_flags
  )
  values (
    latest_receipt_verification_id,
    primary_ref,
    group_ref,
    requested_decision,
    p_actor_user_id,
    authoritative_role,
    clean_reason,
    prior_statuses,
    prior_flags
  );

  return jsonb_build_object(
    'alreadyApplied', false,
    'status', case
      when requested_decision = 'approve' then 'confirmed'
      else 'cancelled'
    end,
    'paymentStatus', case
      when requested_decision = 'approve' then final_payment_status
      else 'rejected'
    end,
    'refs', to_jsonb(booking_refs)
  );
end;
$$;

revoke all on function public.apply_payment_review_decision(
  text, text, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.apply_payment_review_decision(
  text, text, uuid, text, text
) to service_role;

create or replace function public.payment_review_ledger_keys(
  p_extracted jsonb,
  p_fallback_provider text default null,
  p_fallback_reference text default null
)
returns table (
  ledger_key text,
  provider_key text
)
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  item jsonb;
  clean_key text;
  clean_provider text;
  raw_reference text;
  transaction_time text;
  amount_text text;
  explicit_key_count integer := 0;
begin
  if jsonb_typeof(p_extracted->'dedupeKeys') = 'array' then
    for item in
      select value
      from jsonb_array_elements(p_extracted->'dedupeKeys')
    loop
      clean_key := nullif(btrim(item->>'key'), '');
      clean_provider := nullif(lower(btrim(item->>'providerKey')), '');
      if clean_key is not null
         and clean_provider is not null
         and length(clean_key) <= 240
         and length(clean_provider) <= 80 then
        ledger_key := clean_key;
        provider_key := clean_provider;
        explicit_key_count := explicit_key_count + 1;
        return next;
      end if;
    end loop;

    if explicit_key_count > 0 then
      return;
    end if;
  end if;

  clean_provider := lower(coalesce(
    nullif(btrim(p_extracted->>'provider'), ''),
    nullif(btrim(p_fallback_provider), '')
  ));
  raw_reference := coalesce(
    nullif(btrim(p_extracted->>'ref'), ''),
    nullif(btrim(p_extracted->>'submittedReference'), ''),
    nullif(btrim(p_fallback_reference), '')
  );

  if raw_reference is not null and clean_provider = 'gcash' then
    ledger_key := raw_reference;
    provider_key := 'gcash';
    return next;
  elsif raw_reference is not null
        and clean_provider in ('bdopay', 'maya', 'bpi', 'gotyme', 'pnb') then
    ledger_key := clean_provider || ':' || raw_reference;
    provider_key := clean_provider;
    return next;
  end if;

  if clean_provider = 'bdopay'
     and nullif(btrim(p_extracted->>'invoice'), '') is not null then
    ledger_key := 'bdopay_invoice:' || btrim(p_extracted->>'invoice');
    provider_key := 'bdopay_invoice';
    return next;
  end if;

  if clean_provider = 'maya'
     and nullif(btrim(p_extracted->>'instapayRefNo'), '') is not null then
    ledger_key := 'maya_instapay:' || btrim(p_extracted->>'instapayRefNo');
    provider_key := 'maya_instapay';
    return next;
  end if;

  if clean_provider = 'bpi'
     and nullif(btrim(p_extracted->>'bpiTransactionRefNo'), '') is not null then
    ledger_key :=
      'bpi_transaction:' || btrim(p_extracted->>'bpiTransactionRefNo');
    provider_key := 'bpi_transaction';
    return next;
  end if;

  if clean_provider = 'maribank'
     and raw_reference ~ '^[0-9]{6}$' then
    transaction_time := p_extracted->>'time';
    amount_text := p_extracted->>'amount';
    if transaction_time
         ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}'
       and amount_text ~ '^[0-9]+([.][0-9]+)?$' then
      ledger_key := 'maribank_transaction:'
        || left(transaction_time, 16)
        || ':' || raw_reference
        || ':' || to_char(
          round(amount_text::numeric, 2),
          'FM999999999999990.00'
        );
      provider_key := 'maribank_transaction';
      return next;
    end if;
  end if;
end;
$$;

revoke all on function public.payment_review_ledger_keys(jsonb, text, text)
  from public, anon, authenticated;

create or replace function public.apply_open_play_payment_review_decision(
  p_registration_id bigint,
  p_decision text,
  p_actor_user_id uuid,
  p_actor_role text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_decision text := lower(btrim(coalesce(p_decision, '')));
  requested_role text := lower(btrim(coalesce(p_actor_role, '')));
  clean_reason text := nullif(left(btrim(coalesce(p_reason, '')), 1000), '');
  authoritative_role text;
  registration_ref text;
  preliminary_date date;
  preliminary_court_id text;
  preliminary_capacity_exception boolean;
  capacity_lock_acquired boolean := false;
  stored_full_name text;
  stored_court_id text;
  stored_court_name text;
  stored_date date;
  stored_hour integer;
  stored_time_label text;
  stored_payment_type text;
  stored_amount numeric;
  stored_payment_status text;
  stored_payment_method text;
  stored_payment_ref text;
  stored_capacity_exception boolean;
  stored_receipt_url text;
  stored_receipt_hash text;
  stored_receipt_verification_id bigint;
  stored_receipt_status text;
  stored_receipt_flags text[] := '{}';
  verification_result text;
  verification_booking_ref text;
  verification_image_hash text;
  verification_extracted jsonb;
  verification_created_at timestamptz;
  legacy_compat_attestation boolean := false;
  registration_context jsonb;
  verified_provider text;
  submitted_reference text;
  expected_amount_text text;
  expected_total_text text;
  expected_path_prefix text;
  claimed_by_ref text;
  ledger_item record;
  ledger_count integer := 0;
  capacity_config_text text;
  capacity_config jsonb := '{}'::jsonb;
  max_players integer := 40;
  active_registration_count integer := 0;
begin
  if p_registration_id is null or p_registration_id <= 0 then
    raise exception using
      errcode = '22023',
      message = 'A valid Open Play registration ID is required.';
  end if;

  if requested_decision not in ('approve', 'reject') then
    raise exception using
      errcode = '22023',
      message = 'Payment review decision must be approve or reject.';
  end if;

  if requested_decision = 'reject'
     and (clean_reason is null or length(clean_reason) < 3) then
    raise exception using
      errcode = '22023',
      message = 'A rejection reason of at least 3 characters is required.';
  end if;

  if p_actor_user_id is null
     or requested_role not in ('owner', 'court_owner', 'staff') then
    raise exception using
      errcode = '22023',
      message = 'A valid payment-review actor is required.';
  end if;

  select account.role
    into authoritative_role
    from public.accounts account
   where account.id = p_actor_user_id
     and account.status = 'active'
   limit 1;

  if authoritative_role is null
     or authoritative_role <> requested_role
     or authoritative_role not in ('owner', 'court_owner', 'staff') then
    raise exception using
      errcode = '42501',
      message = 'The payment-review actor is not an active authorized account.';
  end if;

  registration_ref := 'OPR-' || p_registration_id::text;

  -- Capacity-exception approvals must take the same court/date lock as inserts
  -- before locking the child row. Revalidate the pre-read tuple after the row
  -- lock so a trusted concurrent mutation can only cause a safe retry.
  if requested_decision = 'approve' then
    select
      registration.date,
      nullif(btrim(registration.court_id), ''),
      registration.capacity_exception
      into
        preliminary_date,
        preliminary_court_id,
        preliminary_capacity_exception
      from public.open_play_registrations registration
     where registration.id = p_registration_id;

    if not found then
      raise exception using
        errcode = 'P0002',
        message = format(
          'Open Play registration %s was not found.',
          p_registration_id
        );
    end if;

    if preliminary_capacity_exception then
      if preliminary_date is null or preliminary_court_id is null then
        raise exception using
          errcode = 'P0001',
          message = 'This capacity-review registration has no valid session key.';
      end if;

      perform pg_advisory_xact_lock(
        hashtextextended(
          'open-play-capacity|' || preliminary_date::text || '|' ||
            preliminary_court_id,
          0
        )
      );
      capacity_lock_acquired := true;

      select setting_row.value
        into capacity_config_text
        from public.settings setting_row
       where setting_row.key = 'open_play_config'
       for share;

      begin
        capacity_config :=
          coalesce(nullif(btrim(capacity_config_text), ''), '{}')::jsonb;
      exception
        when others then
          capacity_config := '{}'::jsonb;
      end;

      capacity_config := coalesce(capacity_config, '{}'::jsonb);
      if jsonb_typeof(capacity_config) <> 'object' then
        capacity_config := '{}'::jsonb;
      end if;

      if btrim(coalesce(capacity_config->>'maxPlayers', '')) ~ '^[0-9]+$'
         and length(btrim(capacity_config->>'maxPlayers')) <= 9 then
        max_players := (btrim(capacity_config->>'maxPlayers'))::integer;
      end if;
      max_players := least(greatest(max_players, 1), 500);
    end if;
  end if;

  select
    registration.full_name,
    nullif(btrim(registration.court_id), ''),
    registration.court_name,
    registration.date,
    registration.hour,
    registration.time_label,
    registration.payment_type,
    registration.amount,
    registration.payment_status,
    lower(nullif(btrim(registration.payment_method), '')),
    nullif(btrim(registration.gcash_ref), ''),
    registration.capacity_exception,
    nullif(btrim(registration.receipt_image_url), ''),
    lower(nullif(btrim(registration.receipt_image_hash), '')),
    registration.receipt_verification_id,
    lower(coalesce(nullif(btrim(registration.receipt_status), ''), 'none')),
    coalesce(registration.receipt_flags, '{}'::text[])
    into
      stored_full_name,
      stored_court_id,
      stored_court_name,
      stored_date,
      stored_hour,
      stored_time_label,
      stored_payment_type,
      stored_amount,
      stored_payment_status,
      stored_payment_method,
      stored_payment_ref,
      stored_capacity_exception,
      stored_receipt_url,
      stored_receipt_hash,
      stored_receipt_verification_id,
      stored_receipt_status,
      stored_receipt_flags
    from public.open_play_registrations registration
   where registration.id = p_registration_id
   for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = format(
        'Open Play registration %s was not found.',
        p_registration_id
      );
  end if;

  if requested_decision = 'approve' and stored_payment_status = 'paid' then
    return jsonb_build_object(
      'alreadyApplied', true,
      'registrationId', p_registration_id,
      'reference', registration_ref,
      'paymentStatus', 'paid',
      'capacityException', stored_capacity_exception
    );
  end if;

  if requested_decision = 'reject' and stored_payment_status = 'rejected' then
    return jsonb_build_object(
      'alreadyApplied', true,
      'registrationId', p_registration_id,
      'reference', registration_ref,
      'paymentStatus', 'rejected',
      'capacityException', stored_capacity_exception
    );
  end if;

  if requested_decision = 'approve'
     and (
       stored_date is distinct from preliminary_date
       or stored_court_id is distinct from preliminary_court_id
       or stored_capacity_exception
         is distinct from preliminary_capacity_exception
     ) then
    raise exception using
      errcode = '40001',
      message = 'Open Play capacity-review state changed; retry the decision.';
  end if;

  if stored_payment_status <> 'pending' then
    raise exception using
      errcode = 'P0001',
      message = 'This Open Play payment is no longer pending review.';
  end if;

  if stored_payment_method not in (
    'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'Only digital Open Play payments can use receipt review.';
  end if;

  if requested_decision = 'approve' then
    if stored_receipt_verification_id is null
       or stored_receipt_url is null
       or stored_receipt_hash is null
       or stored_receipt_hash !~ '^[a-f0-9]{64}$' then
      raise exception using
        errcode = 'P0001',
        message = 'This Open Play payment has no valid stored receipt evidence.';
    end if;

    if stored_receipt_status not in ('manual_review', 'rejected') then
      raise exception using
        errcode = 'P0001',
        message = 'This Open Play receipt is not awaiting a human decision.';
    end if;

    select
      verification.result,
      verification.booking_ref,
      lower(nullif(btrim(verification.image_hash), '')),
      verification.extracted,
      verification.created_at
      into
        verification_result,
        verification_booking_ref,
        verification_image_hash,
        verification_extracted,
        verification_created_at
      from public.receipt_verifications verification
     where verification.id = stored_receipt_verification_id;

    registration_context := verification_extracted->'registrationContext';
    legacy_compat_attestation :=
      jsonb_typeof(verification_extracted->'legacyRegistrationContext')
        = 'object'
      and jsonb_typeof(registration_context) is distinct from 'object';
    verified_provider :=
      lower(nullif(btrim(coalesce(
        verification_extracted->>'provider',
        verification_extracted->>'payment_method',
        verification_extracted->>'paymentMethod'
      )), ''));
    submitted_reference :=
      nullif(btrim(coalesce(
        verification_extracted->>'submittedReference',
        verification_extracted->>'gcash_ref',
        verification_extracted->>'gcashRef'
      )), '');
    expected_amount_text := coalesce(
      verification_extracted->>'expectedAmount',
      verification_extracted->>'downpayment'
    );
    expected_total_text := coalesce(
      verification_extracted->>'expectedTotal',
      verification_extracted->>'total'
    );
    expected_path_prefix :=
      verification_booking_ref || '/' || stored_receipt_hash || '.';

    if not found
       or verification_extracted is null
       or verification_result not in (
         'auto_approved', 'manual_review', 'rejected'
       )
       or verification_booking_ref !~ '^OP-[A-Z0-9]{6,40}$'
       or verification_image_hash is distinct from stored_receipt_hash
       or coalesce(verification_extracted->>'verificationContext', '')
         <> 'open_play'
       or not public.open_play_receipt_audit_matches(
         verification_extracted,
         stored_full_name,
         stored_court_id,
         stored_court_name,
         stored_date,
         stored_hour,
         stored_time_label,
         stored_payment_type,
         stored_payment_method,
         stored_payment_ref,
         stored_amount
       )
       or legacy_compat_attestation is distinct from (
         stored_receipt_flags
           @> array['LEGACY_CLIENT_REVIEW']::text[]
       )
       or (
         legacy_compat_attestation
         and verification_created_at >=
           timestamptz '2026-07-26 00:00:00+00'
       )
       or stored_receipt_url not in (
         expected_path_prefix || 'jpg',
         expected_path_prefix || 'png',
         expected_path_prefix || 'webp',
         expected_path_prefix || 'heic'
       ) then
      raise exception using
        errcode = 'P0001',
        message = 'The stored receipt does not match its Open Play verification audit.';
    end if;

    if stored_capacity_exception then
      if not capacity_lock_acquired then
        raise exception using
          errcode = '40001',
          message = 'Open Play capacity-review state changed; retry the decision.';
      end if;

      select count(*)::integer
        into active_registration_count
        from public.open_play_registrations registration
       where registration.date = stored_date
         and registration.court_id is not distinct from stored_court_id
         and coalesce(registration.payment_status, 'pending') <> 'rejected'
         and not registration.capacity_exception;

      if active_registration_count >= max_players then
        raise exception using
          errcode = 'P0001',
          message = 'No Open Play capacity spot is currently available for approval.';
      end if;
    end if;

    for ledger_item in
      select distinct keys.ledger_key, keys.provider_key
      from public.payment_review_ledger_keys(
        verification_extracted,
        stored_payment_method,
        stored_payment_ref
      ) keys
      order by keys.ledger_key, keys.provider_key
    loop
      ledger_count := ledger_count + 1;

      insert into public.used_gcash_refs (
        gcash_ref,
        booking_ref,
        provider
      )
      values (
        ledger_item.ledger_key,
        registration_ref,
        ledger_item.provider_key
      )
      on conflict (gcash_ref) do nothing;

      select used_ref.booking_ref
        into claimed_by_ref
        from public.used_gcash_refs used_ref
       where used_ref.gcash_ref = ledger_item.ledger_key
       for update;

      if claimed_by_ref is null then
        raise exception using
          errcode = 'P0001',
          message = 'The payment reference could not be claimed.';
      end if;

      if claimed_by_ref <> registration_ref then
        raise exception using
          errcode = '23505',
          message = 'Duplicate payment reference: this reference belongs to another payment.';
      end if;
    end loop;

    if ledger_count = 0 then
      raise exception using
        errcode = 'P0001',
        message = 'The receipt has no authoritative payment replay key.';
    end if;
  end if;

  update public.open_play_registrations registration
     set payment_status = case
           when requested_decision = 'approve' then 'paid'
           else 'rejected'
         end,
         capacity_exception = case
           when requested_decision = 'approve' then false
           else registration.capacity_exception
         end,
         receipt_flags = case
           when requested_decision = 'approve' then array_remove(
             array_remove(
               coalesce(registration.receipt_flags, '{}'::text[]),
               'SESSION_CAPACITY_REVIEW'
             ),
             'LEGACY_CLIENT_REVIEW'
             )
           else registration.receipt_flags
         end,
         receipt_verified_at = coalesce(registration.receipt_verified_at, now())
   where registration.id = p_registration_id;

  insert into public.payment_review_decisions (
    booking_ref,
    receipt_verification_id,
    decision,
    actor_user_id,
    actor_role,
    reason,
    prior_receipt_status,
    prior_receipt_flags
  )
  values (
    registration_ref,
    stored_receipt_verification_id,
    requested_decision,
    p_actor_user_id,
    authoritative_role,
    clean_reason,
    stored_receipt_status,
    stored_receipt_flags
  );

  return jsonb_build_object(
    'alreadyApplied', false,
    'registrationId', p_registration_id,
    'reference', registration_ref,
    'paymentStatus', case
      when requested_decision = 'approve' then 'paid'
      else 'rejected'
    end,
    'capacityException', case
      when requested_decision = 'approve' then false
      else stored_capacity_exception
    end
  );
end;
$$;

revoke all on function public.apply_open_play_payment_review_decision(
  bigint, text, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.apply_open_play_payment_review_decision(
  bigint, text, uuid, text, text
) to service_role;

-- The service-side Open Play persistence action may consume an inline
-- verification exactly once. The trigger binds the audit to every immutable
-- registration field, replaces browser metadata with the authoritative audit,
-- and atomically claims replay keys for an automated approval.
create or replace function public.guard_open_play_registration_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  verification_result text;
  verification_booking_ref text;
  verification_image_hash text;
  verification_phash text;
  verification_flags text[];
  verification_confidence numeric;
  verification_extracted jsonb;
  verification_created_at timestamptz;
  registration_context jsonb;
  verified_provider text;
  expected_amount_text text;
  expected_total_text text;
  submitted_reference text;
  expected_path_prefix text;
  registration_ref text;
  claimed_by_ref text;
  ledger_item record;
  ledger_count integer := 0;
  capacity_config_text text;
  capacity_config jsonb := '{}'::jsonb;
  max_players integer := 40;
  active_registration_count integer := 0;
  capacity_is_full boolean := false;
  capacity_retry_conflict boolean := false;
  capacity_overflow_candidate boolean := false;
  attestation_match_count integer := 0;
  attestation_match_id bigint;
  legacy_compat_attestation boolean := false;
begin
  -- Never trust a browser-supplied exception marker. Only the authoritative
  -- full-session path below may set it after receipt attestation succeeds.
  new.capacity_exception := false;

  if new.date is null
     or nullif(btrim(coalesce(new.court_id, '')), '') is null then
    raise exception using
      errcode = '22023',
      message = 'Open Play date and court are required.';
  end if;

  new.court_id := btrim(new.court_id);
  if not exists (
    select 1
    from public.courts court
    where court.id = new.court_id
  ) then
    raise exception using
      errcode = '23503',
      message = 'Open Play court does not exist.';
  end if;

  -- Transitional stale-tab lane: an old client can submit the evidence fields
  -- but not the new audit id. Bind it only when exactly one recent, unused
  -- audit matches the deterministic path and every field that cohort recorded.
  if lower(coalesce(new.payment_method, 'cash')) in (
       'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
     )
     and new.receipt_verification_id is null then
    if now() >= timestamptz '2026-07-26 00:00:00+00' then
      raise exception using
        errcode = '42501',
        message = 'This older booking page has expired. Refresh and upload the receipt again.';
    end if;

    select count(*)::integer, min(verification.id)
      into attestation_match_count, attestation_match_id
      from public.receipt_verifications verification
     where verification.booking_ref ~ '^OP-[A-Z0-9]{6,40}$'
       and verification.created_at >= now() - interval '30 minutes'
       and verification.created_at <= now() + interval '5 minutes'
       and verification.created_at <
         timestamptz '2026-07-26 00:00:00+00'
       and jsonb_typeof(
         verification.extracted->'legacyRegistrationContext'
       ) = 'object'
       and jsonb_typeof(
         verification.extracted->'registrationContext'
       ) is distinct from 'object'
       and verification.result in (
         'auto_approved', 'manual_review', 'rejected'
       )
       and lower(coalesce(verification.image_hash, ''))
         = lower(nullif(btrim(new.receipt_image_hash), ''))
       and new.receipt_image_url in (
         verification.booking_ref || '/' ||
           lower(verification.image_hash) || '.jpg',
         verification.booking_ref || '/' ||
           lower(verification.image_hash) || '.png',
         verification.booking_ref || '/' ||
           lower(verification.image_hash) || '.webp',
         verification.booking_ref || '/' ||
           lower(verification.image_hash) || '.heic'
       )
       and public.open_play_receipt_audit_matches(
         verification.extracted,
         new.full_name,
         new.court_id,
         new.court_name,
         new.date,
         new.hour,
         new.time_label,
         new.payment_type,
         new.payment_method,
         new.gcash_ref,
         new.amount
       )
       and not exists (
         select 1
         from public.open_play_registrations claimed_registration
         where claimed_registration.receipt_verification_id = verification.id
            or lower(claimed_registration.receipt_image_hash)
              = lower(verification.image_hash)
            or claimed_registration.receipt_image_url = new.receipt_image_url
       );

    if attestation_match_count <> 1 or attestation_match_id is null then
      raise exception using
        errcode = '42501',
        message = case
          when attestation_match_count > 1
            then 'The receipt matches multiple verification audits; upload it again.'
          else 'No unused verification audit matches this Open Play receipt.'
        end;
    end if;

    new.receipt_verification_id := attestation_match_id;
  end if;

  -- Serialize registrations for one court/date before counting. The browser
  -- check remains useful for UX; this lock closes the last-spot race.
  perform pg_advisory_xact_lock(
    hashtextextended(
      'open-play-capacity|' || new.date::text || '|' || new.court_id,
      0
    )
  );

  select setting_row.value
    into capacity_config_text
    from public.settings setting_row
   where setting_row.key = 'open_play_config'
   for share;

  begin
    capacity_config :=
      coalesce(nullif(btrim(capacity_config_text), ''), '{}')::jsonb;
  exception
    when others then
      capacity_config := '{}'::jsonb;
  end;

  capacity_config := coalesce(capacity_config, '{}'::jsonb);
  if jsonb_typeof(capacity_config) <> 'object' then
    capacity_config := '{}'::jsonb;
  end if;

  if btrim(coalesce(capacity_config->>'maxPlayers', '')) ~ '^[0-9]+$'
     and length(btrim(capacity_config->>'maxPlayers')) <= 9 then
    max_players := (btrim(capacity_config->>'maxPlayers'))::integer;
  end if;
  max_players := least(greatest(max_players, 1), 500);

  select count(*)::integer
    into active_registration_count
    from public.open_play_registrations registration
   where registration.date = new.date
     and registration.court_id is not distinct from new.court_id
     and coalesce(registration.payment_status, 'pending') <> 'rejected'
     and not registration.capacity_exception;

  capacity_is_full := active_registration_count >= max_players;
  if capacity_is_full then
    select exists (
      select 1
      from public.open_play_registrations existing_registration
      where existing_registration.receipt_verification_id is not null
        and (
          (
            new.receipt_verification_id is not null
            and existing_registration.receipt_verification_id
              = new.receipt_verification_id
          )
          or (
            nullif(btrim(coalesce(new.receipt_image_hash, '')), '')
              is not null
            and lower(existing_registration.receipt_image_hash)
              = lower(btrim(new.receipt_image_hash))
          )
          or (
            nullif(btrim(coalesce(new.receipt_image_url, '')), '') is not null
            and existing_registration.receipt_image_url
              = btrim(new.receipt_image_url)
          )
        )
    ) into capacity_retry_conflict;

    if not capacity_retry_conflict then
      if lower(coalesce(new.payment_method, 'cash')) not in (
           'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
         )
         or new.receipt_verification_id is null
         or nullif(btrim(coalesce(new.receipt_image_url, '')), '') is null
         or nullif(btrim(coalesce(new.receipt_image_hash, '')), '') is null then
        raise exception using
          errcode = '23514',
          message = 'Open Play session is already full.';
      end if;

      capacity_overflow_candidate := true;
    end if;
  end if;

  if lower(coalesce(new.payment_method, 'cash')) = 'cash' then
    if new.payment_status <> 'pending'
       or new.receipt_verification_id is not null
       or new.gcash_ref is not null
       or nullif(btrim(coalesce(new.receipt_image_url, '')), '') is not null
       or nullif(btrim(coalesce(new.receipt_image_hash, '')), '') is not null
       or nullif(btrim(coalesce(new.receipt_phash, '')), '') is not null
       or lower(coalesce(new.receipt_status, 'none')) <> 'none'
       or coalesce(cardinality(new.receipt_flags), 0) <> 0
       or new.receipt_extracted is not null
       or new.receipt_confidence is not null
       or new.receipt_verified_at is not null then
      raise exception using
        errcode = '42501',
        message = 'Cash Open Play registrations cannot carry receipt evidence.';
    end if;
    return new;
  end if;

  if lower(coalesce(new.payment_method, '')) not in (
    'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
  ) then
    raise exception using
      errcode = '22023',
      message = 'Open Play payment method is not supported.';
  end if;

  if new.receipt_verification_id is null then
    raise exception using
      errcode = '42501',
      message = 'A server receipt-verification record is required.';
  end if;

  select
    verification.result,
    verification.booking_ref,
    lower(nullif(btrim(verification.image_hash), '')),
    nullif(btrim(verification.phash), ''),
    coalesce(verification.flags, '{}'::text[]),
    verification.confidence,
    verification.extracted,
    verification.created_at
    into
      verification_result,
      verification_booking_ref,
      verification_image_hash,
      verification_phash,
      verification_flags,
      verification_confidence,
      verification_extracted,
      verification_created_at
    from public.receipt_verifications verification
   where verification.id = new.receipt_verification_id
   for key share;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'The server receipt-verification record was not found.';
  end if;

  if verification_created_at < now() - interval '30 minutes'
     or verification_created_at > now() + interval '5 minutes'
     or verification_booking_ref !~ '^OP-[A-Z0-9]{6,40}$'
     or coalesce(verification_extracted->>'verificationContext', '') <> 'open_play' then
    raise exception using
      errcode = '42501',
      message = 'The server receipt-verification record is not valid for this Open Play registration.';
  end if;

  registration_context := verification_extracted->'registrationContext';
  legacy_compat_attestation :=
    jsonb_typeof(verification_extracted->'legacyRegistrationContext')
      = 'object'
    and jsonb_typeof(registration_context) is distinct from 'object';
  if legacy_compat_attestation
     and (
       now() >= timestamptz '2026-07-26 00:00:00+00'
       or verification_created_at >=
         timestamptz '2026-07-26 00:00:00+00'
     ) then
    raise exception using
      errcode = '42501',
      message = 'This older booking page has expired. Refresh and upload the receipt again.';
  end if;

  if not public.open_play_receipt_audit_matches(
    verification_extracted,
    new.full_name,
    new.court_id,
    new.court_name,
    new.date,
    new.hour,
    new.time_label,
    new.payment_type,
    new.payment_method,
    new.gcash_ref,
    new.amount
  ) then
    raise exception using
      errcode = '42501',
      message = 'Open Play registration details do not match server verification.';
  end if;

  if verification_image_hash is null
     or verification_image_hash !~ '^[a-f0-9]{64}$'
     or lower(coalesce(new.receipt_image_hash, '')) <> verification_image_hash then
    raise exception using
      errcode = '42501',
      message = 'The stored receipt hash does not match server verification.';
  end if;

  expected_path_prefix :=
    verification_booking_ref || '/' || verification_image_hash || '.';
  if coalesce(new.receipt_image_url, '') not in (
    expected_path_prefix || 'jpg',
    expected_path_prefix || 'png',
    expected_path_prefix || 'webp',
    expected_path_prefix || 'heic'
  ) then
    raise exception using
      errcode = '42501',
      message = 'The stored receipt path does not match server verification.';
  end if;

  verified_provider :=
    lower(nullif(btrim(coalesce(
      verification_extracted->>'provider',
      verification_extracted->>'payment_method',
      verification_extracted->>'paymentMethod'
    )), ''));
  if verified_provider is null
     or verified_provider <> lower(coalesce(new.payment_method, '')) then
    raise exception using
      errcode = '42501',
      message = 'The payment method does not match server verification.';
  end if;

  expected_amount_text := coalesce(
    verification_extracted->>'expectedAmount',
    verification_extracted->>'downpayment'
  );
  if expected_amount_text is null
     or expected_amount_text !~ '^[0-9]+([.][0-9]+)?$'
     or new.amount is null
     or abs(new.amount - expected_amount_text::numeric) > 0.01 then
    raise exception using
      errcode = '42501',
      message = 'The Open Play amount does not match server verification.';
  end if;

  expected_total_text := coalesce(
    verification_extracted->>'expectedTotal',
    verification_extracted->>'total'
  );
  if expected_total_text is null
     or expected_total_text !~ '^[0-9]+([.][0-9]+)?$'
     or expected_total_text::numeric < expected_amount_text::numeric then
    raise exception using
      errcode = '42501',
      message = 'The Open Play total is missing from server verification.';
  end if;

  if lower(btrim(coalesce(new.payment_type, '')))
       = '100%' then
    if abs(
      expected_amount_text::numeric - expected_total_text::numeric
    ) > 0.01 then
      raise exception using
        errcode = '42501',
        message = 'A 100% Open Play payment must equal the verified total.';
    end if;
  elsif lower(btrim(coalesce(new.payment_type, '')))
       = '50%' then
    if abs(
      expected_amount_text::numeric
      - round(expected_total_text::numeric / 2, 2)
    ) > 0.01 then
      raise exception using
        errcode = '42501',
        message = 'A 50% Open Play payment must equal half the verified total.';
    end if;
  else
    raise exception using
      errcode = '42501',
      message = 'Open Play payment type must be 50% or 100%.';
  end if;

  submitted_reference :=
    nullif(btrim(coalesce(
      verification_extracted->>'submittedReference',
      verification_extracted->>'gcash_ref',
      verification_extracted->>'gcashRef'
    )), '');
  if submitted_reference is null
     or upper(btrim(coalesce(new.gcash_ref, '')))
       <> upper(submitted_reference) then
    raise exception using
      errcode = '42501',
      message = 'The payment reference does not match server verification.';
  end if;

  if verification_result not in (
    'auto_approved', 'manual_review', 'rejected'
  ) then
    raise exception using
      errcode = '42501',
      message = 'The Open Play receipt outcome is not valid.';
  end if;

  -- Derive all receipt/payment metadata from the immutable private audit.
  new.payment_method := verified_provider;
  new.gcash_ref := submitted_reference;
  new.amount := round(expected_amount_text::numeric, 2);
  new.receipt_image_hash := verification_image_hash;
  new.receipt_phash := verification_phash;
  new.receipt_flags := array_remove(
    coalesce(verification_flags, '{}'::text[]),
    'SESSION_CAPACITY_REVIEW'
  );
  if legacy_compat_attestation then
    new.receipt_flags := array_append(
      array_remove(
        new.receipt_flags,
        'LEGACY_CLIENT_REVIEW'
      ),
      'LEGACY_CLIENT_REVIEW'
    );
  end if;
  new.receipt_extracted := verification_extracted - array[
    'verificationContext',
    'registrationContext',
    'legacyRegistrationContext',
    'submittedReference',
    'expectedAmount',
    'expectedTotal',
    'dedupeKeys',
    'ocrAnalysisText'
  ];
  new.receipt_confidence := verification_confidence;
  new.receipt_verified_at := verification_created_at;

  if capacity_overflow_candidate then
    if new.amount <= 0 then
      raise exception using
        errcode = '42501',
        message = 'A capacity-review payment must have a positive verified amount.';
    end if;

    new.capacity_exception := true;
    new.receipt_flags := array_append(
      array_remove(
        coalesce(new.receipt_flags, '{}'::text[]),
        'SESSION_CAPACITY_REVIEW'
      ),
      'SESSION_CAPACITY_REVIEW'
    );
    new.payment_status := 'pending';
    new.receipt_status := 'manual_review';
    return new;
  end if;

  if legacy_compat_attestation then
    new.payment_status := 'pending';
    new.receipt_status := 'manual_review';
    return new;
  end if;

  if verification_result = 'auto_approved' then
    new.payment_status := 'paid';
    new.receipt_status := 'auto_approved';

    if new.id is null then
      select nextval(
        pg_get_serial_sequence('public.open_play_registrations', 'id')
      ) into new.id;
    end if;
    registration_ref := 'OPR-' || new.id::text;

    for ledger_item in
      select distinct keys.ledger_key, keys.provider_key
      from public.payment_review_ledger_keys(
        verification_extracted,
        verified_provider,
        submitted_reference
      ) keys
      order by keys.ledger_key, keys.provider_key
    loop
      ledger_count := ledger_count + 1;

      insert into public.used_gcash_refs (
        gcash_ref,
        booking_ref,
        provider
      )
      values (
        ledger_item.ledger_key,
        registration_ref,
        ledger_item.provider_key
      )
      on conflict (gcash_ref) do nothing;

      claimed_by_ref := null;
      select used_ref.booking_ref
        into claimed_by_ref
        from public.used_gcash_refs used_ref
       where used_ref.gcash_ref = ledger_item.ledger_key
       for update;

      if claimed_by_ref is null then
        raise exception using
          errcode = 'P0001',
          message = 'The Open Play payment reference could not be claimed.';
      end if;

      if claimed_by_ref <> registration_ref then
        raise exception using
          errcode = '23505',
          message = 'Duplicate payment reference: this reference belongs to another payment.';
      end if;
    end loop;

    if ledger_count = 0 then
      raise exception using
        errcode = 'P0001',
        message = 'The receipt has no authoritative payment replay key.';
    end if;
  else
    new.payment_status := 'pending';
    new.receipt_status := 'manual_review';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_open_play_registration_insert()
  from public, anon, authenticated;

create or replace function public.get_host_finance_accounts()
returns table (
  id uuid,
  full_name text,
  email text,
  status text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_account_role(array['owner','court_owner']) then
    raise exception 'Only system owners and court owners can view host finance accounts.'
      using errcode = '42501';
  end if;

  return query
  select
    a.id,
    a.full_name,
    a.email,
    a.status,
    a.created_at
  from public.accounts a
  where a.role = 'host'
  order by lower(coalesce(a.full_name, a.email, '')), a.created_at, a.id;
end;
$$;

create or replace function public.get_host_finance_bookings(p_host_user_id uuid)
returns setof public.bookings
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  selected_host_email text;
  matching_host_emails integer;
begin
  if not public.has_account_role(array['owner','court_owner']) then
    raise exception 'Only system owners and court owners can view host finance bookings.'
      using errcode = '42501';
  end if;

  select a.email
    into selected_host_email
  from public.accounts a
  where a.id = p_host_user_id
    and a.role = 'host';

  if not found then
    raise exception 'Host account not found.' using errcode = 'P0002';
  end if;

  select count(*)::integer
    into matching_host_emails
  from public.accounts a
  where a.role = 'host'
    and lower(trim(coalesce(a.email, ''))) = lower(trim(coalesce(selected_host_email, '')));

  return query
  select b.*
  from public.bookings b
  where coalesce(b.host_booking, false) = true
    and coalesce(b.email, '') <> 'reserve@hold.internal'
    and (
      b.host_user_id = p_host_user_id
      or b.created_by_user_id = p_host_user_id
      or (
        b.host_user_id is null
        and b.created_by_user_id is null
        and matching_host_emails = 1
        and lower(trim(coalesce(
          b.host_email,
          case when b.created_by_role = 'host' then b.created_by_email end,
          ''
        ))) = lower(trim(coalesce(selected_host_email, '')))
      )
    )
  order by b.created_at desc, b.ref;
end;
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
set search_path = public, pg_temp
as $$
declare
  request_role text := coalesce(
    auth.role(),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
  account_role text := public.current_account_role();
  service_fee numeric := 0;
  public_due numeric := 0;
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
      or new.confirmation_email_sent_at
        is distinct from old.confirmation_email_sent_at
      or new.confirmation_email_last_event
        is distinct from old.confirmation_email_last_event then
      raise exception 'Reservation identity, slot, price, and ownership cannot be changed after a hold is created.';
    end if;

    if new.payment_status not in (
         'unpaid', 'pending', 'for_verification', 'rejected'
       )
       and not (
         request_role = 'anon'
         and old.status = 'verifying'
         and old.payment_status = 'for_verification'
         and new.status = 'cancelled'
         and new.payment_status = 'failed'
       ) then
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
      if old.total is null or old.total < 0 then
        raise exception 'Reservation payment amount is invalid.';
      end if;
      service_fee := least(
        greatest(coalesce(old.booking_fee_amount_snapshot, 0), 0),
        old.total
      );
      public_due := round(
        service_fee + ((old.total - service_fee) * 0.50),
        2
      );
      if abs(new.downpayment - old.total) > 0.01
         and abs(new.downpayment - public_due) > 0.01
         -- Grandfather an in-flight/cached checkout opened before this deploy.
         and abs(new.downpayment - (old.total / 2)) > 0.01
         and abs(new.downpayment - round(old.total / 2)) > 0.01 then
        raise exception 'Reservation payment amount is invalid. Expected 50%% of the court fee plus the full service fee.';
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
        greatest(coalesce(old.booking_fee_amount_snapshot, 0), 0),
        old.total
      );
      host_due := round(
        service_fee + ((old.total - service_fee) * 0.25),
        2
      );

      if abs(new.downpayment - old.total) > 0.01
         and abs(new.downpayment - host_due) > 0.01 then
        raise exception 'Host payment amount is invalid. Expected 25%% of the court fee plus the full service fee.';
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.guard_public_booking_hold_update()
  from public;

-- Dashboard roles retain broad booking-edit access for ordinary operations,
-- but a receipt awaiting human review may only leave that lane through trusted
-- service-role code (the verifier or the audited decision RPC).
create or replace function public.guard_payment_review_transition()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    current_user
  );
  trusted_writer boolean;
  old_has_evidence boolean;
  old_is_customer_hold boolean;
  old_is_placeholder boolean;
  protected_changed boolean;
begin
  trusted_writer :=
    request_role = 'service_role'
    or current_user in ('service_role', 'postgres', 'supabase_admin')
    or session_user in ('service_role', 'postgres', 'supabase_admin');

  if trusted_writer then
    return new;
  end if;

  old_has_evidence :=
    nullif(btrim(coalesce(old.receipt_image_url, '')), '') is not null
    or nullif(btrim(coalesce(old.receipt_image_hash, '')), '') is not null
    or nullif(btrim(coalesce(old.receipt_phash, '')), '') is not null
    or lower(coalesce(old.receipt_status, 'none')) <> 'none'
    or coalesce(cardinality(old.receipt_flags), 0) <> 0
    or old.receipt_extracted is not null
    or old.receipt_confidence is not null
    or old.receipt_verified_at is not null;

  old_is_customer_hold :=
    old.status = 'verifying'
    and old.payment_status = 'for_verification'
    and coalesce(old.host_booking, false) = false
    and old.host_user_id is null
    and old.created_via = 'customer'
    and old.created_by_user_id is null;

  old_is_placeholder :=
    lower(btrim(coalesce(old.full_name, ''))) in (
      'reserving...', 'reserving…'
    )
    and regexp_replace(
      coalesce(old.contact_number, ''),
      '[^0-9]',
      '',
      'g'
    ) = '00000000000'
    and lower(btrim(coalesce(old.email, ''))) = 'reserve@hold.internal'
    and old.gcash_ref is null
    and old.downpayment is null
    and not old_has_evidence;

  protected_changed :=
    new.ref is distinct from old.ref
    or new.booking_group_ref is distinct from old.booking_group_ref
    or new.full_name is distinct from old.full_name
    or new.contact_number is distinct from old.contact_number
    or new.email is distinct from old.email
    or new.court_id is distinct from old.court_id
    or new.court_name is distinct from old.court_name
    or new.date is distinct from old.date
    or new.slots is distinct from old.slots
    or new.start_time is distinct from old.start_time
    or new.end_time is distinct from old.end_time
    or new.duration is distinct from old.duration
    or new.rate is distinct from old.rate
    or new.total is distinct from old.total
    or new.payment_method is distinct from old.payment_method
    or new.received_account is distinct from old.received_account
    or new.payment_flow is distinct from old.payment_flow
    or new.payment_status is distinct from old.payment_status
    or new.payment_provider is distinct from old.payment_provider
    or new.payment_session_id is distinct from old.payment_session_id
    or new.payment_checkout_url is distinct from old.payment_checkout_url
    or new.paid_at is distinct from old.paid_at
    or new.gcash_ref is distinct from old.gcash_ref
    or new.downpayment is distinct from old.downpayment
    or new.balance_due_at is distinct from old.balance_due_at
    or new.forfeited_at is distinct from old.forfeited_at
    or new.forfeiture_reason is distinct from old.forfeiture_reason
    or new.host_booking is distinct from old.host_booking
    or new.host_user_id is distinct from old.host_user_id
    or new.host_name is distinct from old.host_name
    or new.host_email is distinct from old.host_email
    or new.created_via is distinct from old.created_via
    or new.created_by_user_id is distinct from old.created_by_user_id
    or new.created_by_role is distinct from old.created_by_role
    or new.created_by_name is distinct from old.created_by_name
    or new.created_by_email is distinct from old.created_by_email
    or new.receipt_image_url is distinct from old.receipt_image_url
    or new.receipt_image_hash is distinct from old.receipt_image_hash
    or new.receipt_phash is distinct from old.receipt_phash
    or new.receipt_status is distinct from old.receipt_status
    or new.receipt_flags is distinct from old.receipt_flags
    or new.receipt_extracted is distinct from old.receipt_extracted
    or new.receipt_confidence is distinct from old.receipt_confidence
    or new.receipt_verified_at is distinct from old.receipt_verified_at
    or new.status is distinct from old.status
    or new.created_at is distinct from old.created_at;

  -- Once server-stored evidence enters owner review, browser/dashboard writes
  -- cannot change either the payment state or the evidence it was based on.
  if old.status = 'pending'
     and old.payment_status = 'for_verification'
     and protected_changed then
    raise exception using
      errcode = '42501',
      message = 'Payment-review changes must use the audited review workflow.';
  end if;

  if old_has_evidence
     and (
       new.payment_method is distinct from old.payment_method
       or new.received_account is distinct from old.received_account
       or new.payment_flow is distinct from old.payment_flow
       or new.gcash_ref is distinct from old.gcash_ref
       or new.receipt_image_url is distinct from old.receipt_image_url
       or new.receipt_image_hash is distinct from old.receipt_image_hash
       or new.receipt_phash is distinct from old.receipt_phash
       or new.receipt_status is distinct from old.receipt_status
       or new.receipt_flags is distinct from old.receipt_flags
       or new.receipt_extracted is distinct from old.receipt_extracted
       or new.receipt_confidence is distinct from old.receipt_confidence
       or new.receipt_verified_at is distinct from old.receipt_verified_at
     ) then
    raise exception using
      errcode = '42501',
      message = 'Stored payment receipt evidence is immutable.';
  end if;

  if old_is_customer_hold then
    -- Slot-expiry and close-modal cleanup remains possible at any age, but it
    -- may change only the two lifecycle fields and only before evidence exists.
    if new.status = 'cancelled'
       and new.payment_status = 'failed'
       and not old_has_evidence then
      if (to_jsonb(new) - array['status', 'payment_status'])
           is distinct from
         (to_jsonb(old) - array['status', 'payment_status']) then
        raise exception using
          errcode = '42501',
          message = 'A reservation cleanup may only cancel the empty hold.';
      end if;
      return new;
    end if;

    -- The initial anonymous row is a short-lived slot placeholder. Permit its
    -- one-time personalization, while keeping court, schedule, pricing,
    -- ownership, provider-session, and receipt evidence immutable.
    if old_is_placeholder
       and old.created_at > now() - interval '15 minutes'
       and (
         (
           lower(coalesce(new.payment_method, '')) in (
             'gcash', 'bdopay', 'maya', 'bpi',
             'maribank', 'gotyme', 'pnb'
           )
           and new.status = 'verifying'
           and new.payment_status = 'for_verification'
         )
         or (
           lower(coalesce(new.payment_method, '')) = 'cash'
           and new.status = 'pending'
           and new.payment_status = 'unpaid'
         )
       )
       and new.ref is not distinct from old.ref
       and new.booking_group_ref is not distinct from old.booking_group_ref
       and new.court_id is not distinct from old.court_id
       and new.court_name is not distinct from old.court_name
       and new.date is not distinct from old.date
       and new.slots is not distinct from old.slots
       and new.start_time is not distinct from old.start_time
       and new.end_time is not distinct from old.end_time
       and new.duration is not distinct from old.duration
       and new.rate is not distinct from old.rate
       and new.total is not distinct from old.total
       and new.payment_provider is null
       and new.payment_session_id is null
       and new.payment_checkout_url is null
       and new.paid_at is null
       and coalesce(new.host_booking, false) = false
       and new.host_user_id is null
       and new.host_name is null
       and new.host_email is null
       and new.created_via = 'customer'
       and new.created_by_user_id is null
       and new.created_by_role is null
       and new.created_by_name is null
       and new.created_by_email is null
       and new.receipt_image_url is null
       and new.receipt_image_hash is null
       and new.receipt_phash is null
       and new.receipt_status = 'none'
       and coalesce(cardinality(new.receipt_flags), 0) = 0
       and new.receipt_extracted is null
       and new.receipt_confidence is null
       and new.receipt_verified_at is null
       and new.created_at is not distinct from old.created_at then
      return new;
    end if;

    if protected_changed then
      raise exception using
        errcode = '42501',
        message = 'This reservation hold cannot be changed from the browser.';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.guard_payment_review_transition()
  from public, anon, authenticated;

create or replace function public.guard_payment_review_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    current_user
  );
begin
  if old.status = 'pending'
     and old.payment_status = 'for_verification'
     and request_role is distinct from 'service_role'
     and current_user not in ('service_role', 'postgres', 'supabase_admin')
     and session_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception using
      errcode = '42501',
      message = 'Pending payment review must be resolved before deletion.';
  end if;

  return old;
end;
$$;

revoke all on function public.guard_payment_review_delete()
  from public, anon, authenticated;

-- Pending digital Open Play evidence is immutable to browser roles. Human
-- payment decisions must pass through the service-only audited RPC above.
create or replace function public.guard_open_play_payment_review_transition()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    current_user
  );
begin
  if (
       lower(coalesce(old.payment_method, '')) in (
         'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
       )
       or lower(coalesce(new.payment_method, '')) in (
         'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
       )
     )
     and (
       new.id is distinct from old.id
       or new.full_name is distinct from old.full_name
       or new.court_id is distinct from old.court_id
       or new.court_name is distinct from old.court_name
       or new.date is distinct from old.date
       or new.hour is distinct from old.hour
       or new.time_label is distinct from old.time_label
       or new.payment_type is distinct from old.payment_type
       or new.amount is distinct from old.amount
       or new.payment_method is distinct from old.payment_method
       or new.gcash_ref is distinct from old.gcash_ref
       or new.payment_status is distinct from old.payment_status
       or new.capacity_exception is distinct from old.capacity_exception
       or new.receipt_image_url is distinct from old.receipt_image_url
       or new.receipt_image_hash is distinct from old.receipt_image_hash
       or new.receipt_verification_id is distinct from old.receipt_verification_id
       or new.receipt_phash is distinct from old.receipt_phash
       or new.receipt_status is distinct from old.receipt_status
       or new.receipt_flags is distinct from old.receipt_flags
       or new.receipt_extracted is distinct from old.receipt_extracted
       or new.receipt_confidence is distinct from old.receipt_confidence
       or new.receipt_verified_at is distinct from old.receipt_verified_at
       or new.created_at is distinct from old.created_at
     )
     and request_role is distinct from 'service_role'
     and current_user not in ('service_role', 'postgres', 'supabase_admin')
     and session_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception using
      errcode = '42501',
      message = 'Open Play payment-review changes must use the audited review workflow.';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_open_play_payment_review_transition()
  from public, anon, authenticated;

create or replace function public.guard_open_play_payment_review_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    current_user
  );
begin
  if old.payment_status = 'pending'
     and lower(coalesce(old.payment_method, '')) in (
       'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
     )
     and (
       old.receipt_verification_id is not null
       or nullif(btrim(coalesce(old.receipt_image_url, '')), '') is not null
       or nullif(btrim(coalesce(old.receipt_image_hash, '')), '') is not null
     )
     and request_role is distinct from 'service_role'
     and current_user not in ('service_role', 'postgres', 'supabase_admin')
     and session_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception using
      errcode = '42501',
      message = 'Pending Open Play receipt evidence must be resolved before deletion.';
  end if;

  return old;
end;
$$;

revoke all on function public.guard_open_play_payment_review_delete()
  from public, anon, authenticated;

-- Host-session decisions use the same locked, replay-safe review transaction
-- as ordinary Open Play, but retain their own stable HSR reference namespace.
create or replace function public.apply_host_session_payment_review_decision(
  p_registration_id uuid,
  p_decision text,
  p_actor_user_id uuid,
  p_actor_role text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_decision text := lower(btrim(coalesce(p_decision, '')));
  requested_role text := lower(btrim(coalesce(p_actor_role, '')));
  clean_reason text := nullif(left(btrim(coalesce(p_reason, '')), 1000), '');
  authoritative_role text;
  registration_ref text;
  preliminary_session_id uuid;
  preliminary_capacity_exception boolean;
  capacity_parent_locked boolean := false;
  stored_session_id uuid;
  stored_full_name text;
  stored_contact_number text;
  stored_payment_status text;
  stored_payment_method text;
  stored_payment_ref text;
  stored_amount numeric;
  stored_capacity_exception boolean;
  stored_receipt_url text;
  stored_receipt_hash text;
  stored_receipt_verification_id bigint;
  stored_receipt_status text;
  stored_receipt_flags text[] := '{}';
  verification_result text;
  verification_booking_ref text;
  verification_image_hash text;
  verification_extracted jsonb;
  registration_context jsonb;
  expected_amount_text text;
  expected_total_text text;
  verified_provider text;
  submitted_reference text;
  expected_path_prefix text;
  claimed_by_ref text;
  ledger_item record;
  ledger_count integer := 0;
  verification_created_at timestamptz;
  legacy_compat_attestation boolean := false;
  session_date date;
  session_status text;
  session_max_players integer;
  active_registration_count integer := 0;
begin
  if p_registration_id is null then
    raise exception using
      errcode = '22023',
      message = 'A valid host-session registration ID is required.';
  end if;

  if requested_decision not in ('approve', 'reject') then
    raise exception using
      errcode = '22023',
      message = 'Payment review decision must be approve or reject.';
  end if;

  if requested_decision = 'reject'
     and (clean_reason is null or length(clean_reason) < 3) then
    raise exception using
      errcode = '22023',
      message = 'A rejection reason of at least 3 characters is required.';
  end if;

  if p_actor_user_id is null
     or requested_role not in ('owner', 'court_owner', 'staff') then
    raise exception using
      errcode = '22023',
      message = 'A valid payment-review actor is required.';
  end if;

  select account.role
    into authoritative_role
    from public.accounts account
   where account.id = p_actor_user_id
     and account.status = 'active'
   limit 1;

  if authoritative_role is null
     or authoritative_role <> requested_role
     or authoritative_role not in ('owner', 'court_owner', 'staff') then
    raise exception using
      errcode = '42501',
      message = 'The payment-review actor is not an active authorized account.';
  end if;

  registration_ref := 'HSR-' || p_registration_id::text;

  -- Parent-first locking matches inserts and session deletion. Never hold a
  -- child registration lock while waiting for its host-session row.
  if requested_decision = 'approve' then
    select
      registration.session_id,
      registration.capacity_exception
      into
        preliminary_session_id,
        preliminary_capacity_exception
      from public.open_play_host_session_registrations registration
     where registration.id = p_registration_id;

    if not found then
      raise exception using
        errcode = 'P0002',
        message = format(
          'Host-session registration %s was not found.',
          p_registration_id
        );
    end if;

    if preliminary_capacity_exception then
      perform pg_advisory_xact_lock(
        hashtextextended(
          'host-session-capacity|' || preliminary_session_id::text,
          0
        )
      );

      select
        host_session.date,
        host_session.status,
        host_session.max_players
        into session_date, session_status, session_max_players
        from public.open_play_host_sessions host_session
       where host_session.id = preliminary_session_id
       for update;

      if not found or session_status <> 'published' then
        raise exception using
          errcode = 'P0001',
          message = 'This host session is not open for capacity-exception approval.';
      end if;

      if session_max_players is null or session_max_players < 1 then
        raise exception using
          errcode = 'P0001',
          message = 'This host session has an invalid capacity.';
      end if;

      capacity_parent_locked := true;
    else
      select host_session.date, host_session.status
        into session_date, session_status
        from public.open_play_host_sessions host_session
       where host_session.id = preliminary_session_id
       for share;

      if not found or session_status <> 'published' then
        raise exception using
          errcode = 'P0001',
          message = 'This host session is not open for payment approval.';
      end if;
    end if;
  end if;

  select
    registration.session_id,
    registration.full_name,
    registration.contact_number,
    registration.payment_status,
    lower(nullif(btrim(registration.payment_method), '')),
    nullif(btrim(registration.gcash_ref), ''),
    registration.amount,
    registration.capacity_exception,
    nullif(btrim(registration.receipt_image_url), ''),
    lower(nullif(btrim(registration.receipt_image_hash), '')),
    registration.receipt_verification_id,
    lower(coalesce(nullif(btrim(registration.receipt_status), ''), 'none')),
    coalesce(registration.receipt_flags, '{}'::text[])
    into
      stored_session_id,
      stored_full_name,
      stored_contact_number,
      stored_payment_status,
      stored_payment_method,
      stored_payment_ref,
      stored_amount,
      stored_capacity_exception,
      stored_receipt_url,
      stored_receipt_hash,
      stored_receipt_verification_id,
      stored_receipt_status,
      stored_receipt_flags
    from public.open_play_host_session_registrations registration
   where registration.id = p_registration_id
   for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = format(
        'Host-session registration %s was not found.',
        p_registration_id
      );
  end if;

  if requested_decision = 'approve' and stored_payment_status = 'paid' then
    return jsonb_build_object(
      'alreadyApplied', true,
      'registrationId', p_registration_id,
      'reference', registration_ref,
      'paymentStatus', 'paid',
      'capacityException', stored_capacity_exception
    );
  end if;

  if requested_decision = 'reject' and stored_payment_status = 'rejected' then
    return jsonb_build_object(
      'alreadyApplied', true,
      'registrationId', p_registration_id,
      'reference', registration_ref,
      'paymentStatus', 'rejected',
      'capacityException', stored_capacity_exception
    );
  end if;

  if requested_decision = 'approve'
     and (
       stored_session_id is distinct from preliminary_session_id
       or stored_capacity_exception
         is distinct from preliminary_capacity_exception
     ) then
    raise exception using
      errcode = '40001',
      message = 'Host-session capacity-review state changed; retry the decision.';
  end if;

  if stored_payment_status <> 'pending' then
    raise exception using
      errcode = 'P0001',
      message = 'This host-session payment is no longer pending review.';
  end if;

  if stored_payment_method not in (
    'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'Only digital host-session payments can use receipt review.';
  end if;

  if requested_decision = 'approve' then
    if stored_receipt_verification_id is null
       or stored_receipt_url is null
       or stored_receipt_hash is null
       or stored_receipt_hash !~ '^[a-f0-9]{64}$' then
      raise exception using
        errcode = 'P0001',
        message = 'This host-session payment has no valid stored receipt evidence.';
    end if;

    if stored_receipt_status not in ('manual_review', 'rejected') then
      raise exception using
        errcode = 'P0001',
        message = 'This host-session receipt is not awaiting a human decision.';
    end if;

    select
      verification.result,
      verification.booking_ref,
      lower(nullif(btrim(verification.image_hash), '')),
      verification.extracted,
      verification.created_at
      into
        verification_result,
        verification_booking_ref,
        verification_image_hash,
        verification_extracted,
        verification_created_at
      from public.receipt_verifications verification
     where verification.id = stored_receipt_verification_id;

    registration_context := verification_extracted->'registrationContext';
    legacy_compat_attestation :=
      jsonb_typeof(verification_extracted->'legacyRegistrationContext')
        = 'object'
      and jsonb_typeof(registration_context) is distinct from 'object';
    expected_amount_text := coalesce(
      verification_extracted->>'expectedAmount',
      verification_extracted->>'downpayment'
    );
    expected_total_text := coalesce(
      verification_extracted->>'expectedTotal',
      verification_extracted->>'total'
    );
    verified_provider :=
      lower(nullif(btrim(coalesce(
        verification_extracted->>'provider',
        verification_extracted->>'payment_method',
        verification_extracted->>'paymentMethod'
      )), ''));
    submitted_reference :=
      nullif(btrim(coalesce(
        verification_extracted->>'submittedReference',
        verification_extracted->>'gcash_ref',
        verification_extracted->>'gcashRef'
      )), '');
    expected_path_prefix :=
      verification_booking_ref || '/' || stored_receipt_hash || '.';

    if not found
       or verification_result not in (
         'auto_approved', 'manual_review', 'rejected'
       )
       or verification_booking_ref !~ '^HS-[A-Z0-9]{6,40}$'
       or verification_image_hash is distinct from stored_receipt_hash
       or coalesce(verification_extracted->>'verificationContext', '')
         <> 'host_session'
       or not public.host_session_receipt_audit_matches(
         verification_extracted,
         stored_session_id,
         session_date,
         stored_full_name,
         stored_contact_number,
         stored_payment_method,
         stored_payment_ref,
         stored_amount
       )
       or legacy_compat_attestation is distinct from (
         stored_receipt_flags
           @> array['LEGACY_CLIENT_REVIEW']::text[]
       )
       or (
         legacy_compat_attestation
         and verification_created_at >=
           timestamptz '2026-07-26 00:00:00+00'
       )
       or stored_receipt_url not in (
         expected_path_prefix || 'jpg',
         expected_path_prefix || 'png',
         expected_path_prefix || 'webp',
         expected_path_prefix || 'heic'
       ) then
      raise exception using
        errcode = 'P0001',
        message = 'The stored receipt does not match its host-session verification audit.';
    end if;

    if stored_capacity_exception then
      if not capacity_parent_locked then
        raise exception using
          errcode = '40001',
          message = 'Host-session capacity-review state changed; retry the decision.';
      end if;

      select count(*)::integer
        into active_registration_count
        from public.open_play_host_session_registrations registration
       where registration.session_id = stored_session_id
         and registration.payment_status <> 'rejected'
         and not (
           registration.payment_status = 'pending'
           and registration.capacity_exception
         );

      if active_registration_count >= session_max_players then
        raise exception using
          errcode = 'P0001',
          message = 'No host-session capacity spot is currently available for approval.';
      end if;
    end if;

    for ledger_item in
      select distinct keys.ledger_key, keys.provider_key
      from public.payment_review_ledger_keys(
        verification_extracted,
        stored_payment_method,
        stored_payment_ref
      ) keys
      order by keys.ledger_key, keys.provider_key
    loop
      ledger_count := ledger_count + 1;

      insert into public.used_gcash_refs (
        gcash_ref,
        booking_ref,
        provider
      )
      values (
        ledger_item.ledger_key,
        registration_ref,
        ledger_item.provider_key
      )
      on conflict (gcash_ref) do nothing;

      claimed_by_ref := null;
      select used_ref.booking_ref
        into claimed_by_ref
        from public.used_gcash_refs used_ref
       where used_ref.gcash_ref = ledger_item.ledger_key
       for update;

      if claimed_by_ref is null then
        raise exception using
          errcode = 'P0001',
          message = 'The host-session payment reference could not be claimed.';
      end if;

      if claimed_by_ref <> registration_ref then
        raise exception using
          errcode = '23505',
          message = 'Duplicate payment reference: this reference belongs to another payment.';
      end if;
    end loop;

    if ledger_count = 0 then
      raise exception using
        errcode = 'P0001',
        message = 'The receipt has no authoritative payment replay key.';
    end if;
  end if;

  update public.open_play_host_session_registrations registration
     set payment_status = case
           when requested_decision = 'approve' then 'paid'
           else 'rejected'
         end,
         capacity_exception = case
           when requested_decision = 'approve' then false
           else registration.capacity_exception
         end,
         receipt_flags = case
           when requested_decision = 'approve' then array_remove(
             array_remove(
               coalesce(registration.receipt_flags, '{}'::text[]),
               'SESSION_CAPACITY_REVIEW'
             ),
             'LEGACY_CLIENT_REVIEW'
             )
           else registration.receipt_flags
         end,
         receipt_verified_at = coalesce(registration.receipt_verified_at, now())
   where registration.id = p_registration_id;

  insert into public.payment_review_decisions (
    booking_ref,
    receipt_verification_id,
    decision,
    actor_user_id,
    actor_role,
    reason,
    prior_receipt_status,
    prior_receipt_flags
  )
  values (
    registration_ref,
    stored_receipt_verification_id,
    requested_decision,
    p_actor_user_id,
    authoritative_role,
    clean_reason,
    stored_receipt_status,
    stored_receipt_flags
  );

  return jsonb_build_object(
    'alreadyApplied', false,
    'registrationId', p_registration_id,
    'reference', registration_ref,
    'paymentStatus', case
      when requested_decision = 'approve' then 'paid'
      else 'rejected'
    end,
    'capacityException', case
      when requested_decision = 'approve' then false
      else stored_capacity_exception
    end
  );
end;
$$;

revoke all on function public.apply_host_session_payment_review_decision(
  uuid, text, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.apply_host_session_payment_review_decision(
  uuid, text, uuid, text, text
) to service_role;

-- A paid host session requires a recent, session-bound receipt audit before
-- insertion. Manual outcomes remain pending for the audited decision RPC.
-- Free published sessions are receipt-free cash entries.
create or replace function public.guard_host_session_registration_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_date date;
  session_fee numeric;
  session_status text;
  session_max_players integer;
  active_registration_count integer := 0;
  capacity_is_full boolean := false;
  capacity_retry_conflict boolean := false;
  capacity_overflow_candidate boolean := false;
  attestation_match_count integer := 0;
  attestation_match_id bigint;
  legacy_compat_attestation boolean := false;
  verification_result text;
  verification_booking_ref text;
  verification_image_hash text;
  verification_phash text;
  verification_flags text[];
  verification_confidence numeric;
  verification_extracted jsonb;
  verification_created_at timestamptz;
  registration_context jsonb;
  verified_provider text;
  expected_amount_text text;
  expected_total_text text;
  submitted_reference text;
  expected_path_prefix text;
  registration_ref text;
  claimed_by_ref text;
  ledger_item record;
  ledger_count integer := 0;
begin
  -- Never trust a browser-supplied exception marker. Only the authoritative
  -- full-session path below may set it after receipt attestation succeeds.
  new.capacity_exception := false;

  if new.session_id is null then
    raise exception using
      errcode = '22023',
      message = 'A valid host session is required.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'host-session-capacity|' || new.session_id::text,
      0
    )
  );

  select
    host_session.date,
    host_session.fee_per_player,
    host_session.status,
    host_session.max_players
    into
      session_date,
      session_fee,
      session_status,
      session_max_players
    from public.open_play_host_sessions host_session
   where host_session.id = new.session_id
   for update;

  if not found or session_status <> 'published' then
    raise exception using
      errcode = '42501',
      message = 'This host session is not open for registration.';
  end if;

  if session_max_players is null or session_max_players < 1 then
    raise exception using
      errcode = '23514',
      message = 'This host session has an invalid capacity.';
  end if;

  -- Transitional stale-tab lane. The legacy audit intentionally lacks a
  -- contact number, so every field it did record must match and the result is
  -- forced through owner review during the short rollout grace period.
  if lower(coalesce(new.payment_method, 'cash')) in (
       'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
     )
     and new.receipt_verification_id is null then
    if now() >= timestamptz '2026-07-26 00:00:00+00' then
      raise exception using
        errcode = '42501',
        message = 'This older booking page has expired. Refresh and upload the receipt again.';
    end if;

    select count(*)::integer, min(verification.id)
      into attestation_match_count, attestation_match_id
      from public.receipt_verifications verification
     where verification.booking_ref ~ '^HS-[A-Z0-9]{6,40}$'
       and verification.created_at >= now() - interval '30 minutes'
       and verification.created_at <= now() + interval '5 minutes'
       and verification.created_at <
         timestamptz '2026-07-26 00:00:00+00'
       and verification.result in (
         'auto_approved', 'manual_review', 'rejected'
       )
       and jsonb_typeof(
         verification.extracted->'legacyRegistrationContext'
       ) = 'object'
       and jsonb_typeof(
         verification.extracted->'registrationContext'
       ) is distinct from 'object'
       and lower(coalesce(verification.image_hash, ''))
         = lower(nullif(btrim(new.receipt_image_hash), ''))
       and new.receipt_image_url in (
         verification.booking_ref || '/' ||
           lower(verification.image_hash) || '.jpg',
         verification.booking_ref || '/' ||
           lower(verification.image_hash) || '.png',
         verification.booking_ref || '/' ||
           lower(verification.image_hash) || '.webp',
         verification.booking_ref || '/' ||
           lower(verification.image_hash) || '.heic'
       )
       and public.host_session_receipt_audit_matches(
         verification.extracted,
         new.session_id,
         session_date,
         new.full_name,
         new.contact_number,
         new.payment_method,
         new.gcash_ref,
         new.amount
       )
       and not exists (
         select 1
         from public.open_play_host_session_registrations claimed_registration
         where claimed_registration.receipt_verification_id = verification.id
            or lower(claimed_registration.receipt_image_hash)
              = lower(verification.image_hash)
            or claimed_registration.receipt_image_url = new.receipt_image_url
       );

    if attestation_match_count <> 1 or attestation_match_id is null then
      raise exception using
        errcode = '42501',
        message = case
          when attestation_match_count > 1
            then 'The receipt matches multiple verification audits; upload it again.'
          else 'No unused verification audit matches this host-session receipt.'
        end;
    end if;

    new.receipt_verification_id := attestation_match_id;
  end if;

  select count(*)::integer
    into active_registration_count
    from public.open_play_host_session_registrations registration
   where registration.session_id = new.session_id
     and registration.payment_status <> 'rejected'
     and not (
       registration.payment_status = 'pending'
       and registration.capacity_exception
     );

  capacity_is_full := active_registration_count >= session_max_players;
  if capacity_is_full then
    select exists (
      select 1
      from public.open_play_host_session_registrations existing_registration
      where existing_registration.receipt_verification_id is not null
        and (
          (
            new.receipt_verification_id is not null
            and existing_registration.receipt_verification_id
              = new.receipt_verification_id
          )
          or (
            nullif(btrim(coalesce(new.receipt_image_hash, '')), '')
              is not null
            and lower(existing_registration.receipt_image_hash)
              = lower(btrim(new.receipt_image_hash))
          )
          or (
            nullif(btrim(coalesce(new.receipt_image_url, '')), '') is not null
            and existing_registration.receipt_image_url
              = btrim(new.receipt_image_url)
          )
        )
    ) into capacity_retry_conflict;

    if not capacity_retry_conflict then
      if coalesce(session_fee, 0) <= 0
         or lower(coalesce(new.payment_method, '')) not in (
           'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
         )
         or new.receipt_verification_id is null
         or nullif(btrim(coalesce(new.receipt_image_url, '')), '') is null
         or nullif(btrim(coalesce(new.receipt_image_hash, '')), '') is null then
        raise exception using
          errcode = '23514',
          message = 'This host session is already full.';
      end if;

      capacity_overflow_candidate := true;
    end if;
  end if;

  new.amount := round(coalesce(session_fee, 0), 2);

  if new.amount <= 0 then
    if lower(coalesce(new.payment_method, 'cash')) <> 'cash'
       or new.payment_status <> 'paid'
       or new.receipt_verification_id is not null
       or new.gcash_ref is not null
       or nullif(btrim(coalesce(new.receipt_image_url, '')), '') is not null
       or nullif(btrim(coalesce(new.receipt_image_hash, '')), '') is not null
       or nullif(btrim(coalesce(new.receipt_phash, '')), '') is not null
       or lower(coalesce(new.receipt_status, 'none')) <> 'none'
       or coalesce(cardinality(new.receipt_flags), 0) <> 0
       or new.receipt_extracted is not null
       or new.receipt_confidence is not null
       or new.receipt_verified_at is not null then
      raise exception using
        errcode = '42501',
        message = 'A free host session must use receipt-free cash registration.';
    end if;
    new.payment_method := 'cash';
    return new;
  end if;

  if lower(coalesce(new.payment_method, '')) not in (
    'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
  ) then
    raise exception using
      errcode = '22023',
      message = 'A paid host session requires a supported digital payment.';
  end if;

  if new.receipt_verification_id is null then
    raise exception using
      errcode = '42501',
      message = 'A server receipt-verification record is required.';
  end if;

  select
    verification.result,
    verification.booking_ref,
    lower(nullif(btrim(verification.image_hash), '')),
    nullif(btrim(verification.phash), ''),
    coalesce(verification.flags, '{}'::text[]),
    verification.confidence,
    verification.extracted,
    verification.created_at
    into
      verification_result,
      verification_booking_ref,
      verification_image_hash,
      verification_phash,
      verification_flags,
      verification_confidence,
      verification_extracted,
      verification_created_at
    from public.receipt_verifications verification
   where verification.id = new.receipt_verification_id
   for key share;

  if not found
     or verification_created_at < now() - interval '30 minutes'
     or verification_created_at > now() + interval '5 minutes'
     or verification_booking_ref !~ '^HS-[A-Z0-9]{6,40}$'
     or coalesce(verification_extracted->>'verificationContext', '')
       <> 'host_session' then
    raise exception using
      errcode = '42501',
      message = 'The receipt verification is not valid for this host session.';
  end if;

  registration_context := verification_extracted->'registrationContext';
  legacy_compat_attestation :=
    jsonb_typeof(verification_extracted->'legacyRegistrationContext')
      = 'object'
    and jsonb_typeof(registration_context) is distinct from 'object';
  if legacy_compat_attestation
     and (
       now() >= timestamptz '2026-07-26 00:00:00+00'
       or verification_created_at >=
         timestamptz '2026-07-26 00:00:00+00'
     ) then
    raise exception using
      errcode = '42501',
      message = 'This older booking page has expired. Refresh and upload the receipt again.';
  end if;

  if not public.host_session_receipt_audit_matches(
    verification_extracted,
    new.session_id,
    session_date,
    new.full_name,
    new.contact_number,
    new.payment_method,
    new.gcash_ref,
    new.amount
  ) then
    raise exception using
      errcode = '42501',
      message = 'Host-session registration details do not match server verification.';
  end if;

  if verification_image_hash is null
     or verification_image_hash !~ '^[a-f0-9]{64}$'
     or lower(coalesce(new.receipt_image_hash, ''))
       <> verification_image_hash then
    raise exception using
      errcode = '42501',
      message = 'The stored receipt hash does not match server verification.';
  end if;

  expected_path_prefix :=
    verification_booking_ref || '/' || verification_image_hash || '.';
  if coalesce(new.receipt_image_url, '') not in (
    expected_path_prefix || 'jpg',
    expected_path_prefix || 'png',
    expected_path_prefix || 'webp',
    expected_path_prefix || 'heic'
  ) then
    raise exception using
      errcode = '42501',
      message = 'The stored receipt path does not match server verification.';
  end if;

  verified_provider :=
    lower(nullif(btrim(coalesce(
      verification_extracted->>'provider',
      verification_extracted->>'payment_method',
      verification_extracted->>'paymentMethod'
    )), ''));
  if verified_provider is null
     or verified_provider <> lower(coalesce(new.payment_method, '')) then
    raise exception using
      errcode = '42501',
      message = 'The payment method does not match server verification.';
  end if;

  expected_amount_text := coalesce(
    verification_extracted->>'expectedAmount',
    verification_extracted->>'downpayment'
  );
  expected_total_text := coalesce(
    verification_extracted->>'expectedTotal',
    verification_extracted->>'total'
  );
  if expected_amount_text is null
     or expected_amount_text !~ '^[0-9]+([.][0-9]+)?$'
     or expected_total_text is null
     or expected_total_text !~ '^[0-9]+([.][0-9]+)?$'
     or abs(expected_amount_text::numeric - session_fee) > 0.01
     or abs(expected_total_text::numeric - session_fee) > 0.01 then
    raise exception using
      errcode = '42501',
      message = 'The host-session fee does not match server verification.';
  end if;

  submitted_reference :=
    nullif(btrim(coalesce(
      verification_extracted->>'submittedReference',
      verification_extracted->>'gcash_ref',
      verification_extracted->>'gcashRef'
    )), '');
  if submitted_reference is null
     or upper(btrim(coalesce(new.gcash_ref, '')))
       <> upper(submitted_reference) then
    raise exception using
      errcode = '42501',
      message = 'The payment reference does not match server verification.';
  end if;

  if verification_result not in (
    'auto_approved', 'manual_review', 'rejected'
  ) then
    raise exception using
      errcode = '42501',
      message = 'The host-session receipt outcome is not valid.';
  end if;

  new.payment_method := verified_provider;
  new.gcash_ref := submitted_reference;
  new.receipt_image_hash := verification_image_hash;
  new.receipt_phash := verification_phash;
  new.receipt_flags := array_remove(
    coalesce(verification_flags, '{}'::text[]),
    'SESSION_CAPACITY_REVIEW'
  );
  if legacy_compat_attestation then
    new.receipt_flags := array_append(
      array_remove(
        new.receipt_flags,
        'LEGACY_CLIENT_REVIEW'
      ),
      'LEGACY_CLIENT_REVIEW'
    );
  end if;
  new.receipt_extracted := verification_extracted - array[
    'verificationContext',
    'registrationContext',
    'legacyRegistrationContext',
    'submittedReference',
    'expectedAmount',
    'expectedTotal',
    'dedupeKeys',
    'ocrAnalysisText'
  ];
  new.receipt_confidence := verification_confidence;
  new.receipt_verified_at := verification_created_at;

  if capacity_overflow_candidate then
    new.capacity_exception := true;
    new.receipt_flags := array_append(
      array_remove(
        coalesce(new.receipt_flags, '{}'::text[]),
        'SESSION_CAPACITY_REVIEW'
      ),
      'SESSION_CAPACITY_REVIEW'
    );
    new.payment_status := 'pending';
    new.receipt_status := 'manual_review';
    return new;
  end if;

  if legacy_compat_attestation then
    new.payment_status := 'pending';
    new.receipt_status := 'manual_review';
    return new;
  end if;

  if verification_result = 'auto_approved' then
    new.payment_status := 'paid';
    new.receipt_status := 'auto_approved';
    if new.id is null then
      new.id := gen_random_uuid();
    end if;
    registration_ref := 'HSR-' || new.id::text;

    for ledger_item in
      select distinct keys.ledger_key, keys.provider_key
      from public.payment_review_ledger_keys(
        verification_extracted,
        verified_provider,
        submitted_reference
      ) keys
      order by keys.ledger_key, keys.provider_key
    loop
      ledger_count := ledger_count + 1;

      insert into public.used_gcash_refs (
        gcash_ref,
        booking_ref,
        provider
      )
      values (
        ledger_item.ledger_key,
        registration_ref,
        ledger_item.provider_key
      )
      on conflict (gcash_ref) do nothing;

      claimed_by_ref := null;
      select used_ref.booking_ref
        into claimed_by_ref
        from public.used_gcash_refs used_ref
       where used_ref.gcash_ref = ledger_item.ledger_key
       for update;

      if claimed_by_ref is null then
        raise exception using
          errcode = 'P0001',
          message = 'The host-session payment reference could not be claimed.';
      end if;

      if claimed_by_ref <> registration_ref then
        raise exception using
          errcode = '23505',
          message = 'Duplicate payment reference: this reference belongs to another payment.';
      end if;
    end loop;

    if ledger_count = 0 then
      raise exception using
        errcode = 'P0001',
        message = 'The receipt has no authoritative payment replay key.';
    end if;
  else
    new.payment_status := 'pending';
    new.receipt_status := 'manual_review';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_host_session_registration_insert()
  from public, anon, authenticated;

create or replace function public.guard_host_session_payment_review_transition()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    current_user
  );
begin
  if (
       lower(coalesce(old.payment_method, '')) in (
         'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
       )
       or lower(coalesce(new.payment_method, '')) in (
         'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
       )
     )
     and (
       new.id is distinct from old.id
       or new.session_id is distinct from old.session_id
       or new.full_name is distinct from old.full_name
       or new.contact_number is distinct from old.contact_number
       or new.payment_method is distinct from old.payment_method
       or new.gcash_ref is distinct from old.gcash_ref
       or new.payment_status is distinct from old.payment_status
       or new.amount is distinct from old.amount
       or new.capacity_exception is distinct from old.capacity_exception
       or new.receipt_verification_id
         is distinct from old.receipt_verification_id
       or new.receipt_image_url is distinct from old.receipt_image_url
       or new.receipt_image_hash is distinct from old.receipt_image_hash
       or new.receipt_phash is distinct from old.receipt_phash
       or new.receipt_status is distinct from old.receipt_status
       or new.receipt_flags is distinct from old.receipt_flags
       or new.receipt_extracted is distinct from old.receipt_extracted
       or new.receipt_confidence is distinct from old.receipt_confidence
       or new.receipt_verified_at is distinct from old.receipt_verified_at
       or new.created_at is distinct from old.created_at
     )
     and request_role is distinct from 'service_role'
     and current_user not in ('service_role', 'postgres', 'supabase_admin')
     and session_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception using
      errcode = '42501',
      message = 'Host-session receipt evidence is locked after submission.';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_host_session_payment_review_transition()
  from public, anon, authenticated;

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

create or replace function public.guard_host_session_pending_payment_reviews()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
     and new.date is not distinct from old.date
     and not (
       new.status is distinct from old.status
       and new.status is distinct from 'published'
     ) then
    return new;
  end if;

  if exists (
    select 1
    from public.open_play_host_session_registrations registration
    where registration.session_id = old.id
      and registration.receipt_verification_id is not null
      and registration.payment_status = 'pending'
      and registration.receipt_status = 'manual_review'
  ) then
    raise exception using
      errcode = '55000',
      message =
        'Resolve pending payment reviews before rescheduling, unpublishing, cancelling, or deleting this host session.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_host_session_pending_payment_reviews()
  from public, anon, authenticated;

create or replace function public.count_open_play_registrations(
  p_date date,
  p_court_id text default null
)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer
  from public.open_play_registrations registration
  where registration.date = p_date
    and (
      p_court_id is null
      or registration.court_id = p_court_id
    )
    and coalesce(registration.payment_status, 'pending') <> 'rejected'
    and not registration.capacity_exception
$$;

create or replace function public.count_open_play_host_session_registrations(
  p_session_id uuid
)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer
  from public.open_play_host_session_registrations registration
  where registration.session_id = p_session_id
    and registration.payment_status <> 'rejected'
    and not (
      registration.payment_status = 'pending'
      and registration.capacity_exception
    )
$$;

grant execute on function public.current_account_role() to anon, authenticated;
grant execute on function public.has_account_role(text[]) to anon, authenticated;
revoke all on function public.get_host_finance_accounts() from public, anon, authenticated;
grant execute on function public.get_host_finance_accounts() to authenticated;
revoke all on function public.get_host_finance_bookings(uuid) from public, anon, authenticated;
grant execute on function public.get_host_finance_bookings(uuid) to authenticated;
grant execute on function public.can_write_setting(text) to authenticated;
grant execute on function public.restore_deleted_booking_archive(uuid) to authenticated;
revoke all on function public.count_open_play_registrations(date, text)
  from public;
grant execute on function public.count_open_play_registrations(date, text)
  to anon, authenticated;
revoke all on function public.count_open_play_host_session_registrations(uuid)
  from public;
grant execute on function
  public.count_open_play_host_session_registrations(uuid)
  to anon, authenticated;

drop trigger if exists trg_private_settings_touch_updated_at on public.private_settings;
create trigger trg_private_settings_touch_updated_at
before update on public.private_settings
for each row execute function public.touch_updated_at();

drop trigger if exists trg_payment_review_notifications_touch_updated_at
  on public.payment_review_notifications;
create trigger trg_payment_review_notifications_touch_updated_at
before update on public.payment_review_notifications
for each row execute function public.touch_updated_at();

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

drop trigger if exists trg_guard_host_session_review_update
  on public.open_play_host_sessions;
create trigger trg_guard_host_session_review_update
before update of date, status on public.open_play_host_sessions
for each row execute function
  public.guard_host_session_pending_payment_reviews();

drop trigger if exists trg_guard_host_session_review_delete
  on public.open_play_host_sessions;
create trigger trg_guard_host_session_review_delete
before delete on public.open_play_host_sessions
for each row execute function
  public.guard_host_session_pending_payment_reviews();

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
alter table public.private_settings enable row level security;
alter table public.accounts enable row level security;
alter table public.blocked_dates enable row level security;
alter table public.open_play_registrations enable row level security;
alter table public.payment_sessions enable row level security;
alter table public.used_gcash_refs enable row level security;
alter table public.receipt_verifications enable row level security;
alter table public.payment_review_notifications enable row level security;
alter table public.payment_review_decisions enable row level security;
alter table public.agreements enable row level security;
alter table public.weekly_fees enable row level security;
alter table public.open_play_game_sessions enable row level security;
alter table public.open_play_game_players enable row level security;
alter table public.open_play_game_rounds enable row level security;
alter table public.open_play_host_applications enable row level security;
alter table public.open_play_host_sessions enable row level security;
alter table public.open_play_host_session_registrations enable row level security;
alter table public.deleted_booking_archive enable row level security;

drop trigger if exists trg_guard_payment_review_transition
  on public.bookings;

-- Quarantine legacy Open Play/host registrations that entered the pending
-- lane without any stored receipt. Recent rows are excluded so an in-flight
-- upload is never mistaken for abandoned legacy data. Paid legacy records are
-- preserved unchanged for manual audit.
update public.open_play_registrations registration
set payment_status = 'rejected',
    receipt_status = 'rejected',
    receipt_flags = case
      when 'MISSING_RECEIPT_EVIDENCE'
        = any(coalesce(registration.receipt_flags, '{}'::text[]))
        then coalesce(registration.receipt_flags, '{}'::text[])
      else array_append(
        coalesce(registration.receipt_flags, '{}'::text[]),
        'MISSING_RECEIPT_EVIDENCE'
      )
    end
where registration.payment_status = 'pending'
  and lower(coalesce(registration.payment_method, '')) in (
    'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
  )
  and registration.receipt_verification_id is null
  and nullif(btrim(coalesce(registration.receipt_image_url, '')), '') is null
  and nullif(btrim(coalesce(registration.receipt_image_hash, '')), '') is null
  and registration.created_at < now() - interval '15 minutes';

update public.open_play_host_session_registrations registration
set payment_status = 'rejected',
    receipt_status = 'rejected',
    receipt_flags = case
      when 'MISSING_RECEIPT_EVIDENCE'
        = any(coalesce(registration.receipt_flags, '{}'::text[]))
        then coalesce(registration.receipt_flags, '{}'::text[])
      else array_append(
        coalesce(registration.receipt_flags, '{}'::text[]),
        'MISSING_RECEIPT_EVIDENCE'
      )
    end
where registration.payment_status = 'pending'
  and lower(coalesce(registration.payment_method, '')) in (
    'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
  )
  and registration.receipt_verification_id is null
  and nullif(btrim(coalesce(registration.receipt_image_url, '')), '') is null
  and nullif(btrim(coalesce(registration.receipt_image_hash, '')), '') is null
  and registration.created_at < now() - interval '15 minutes';

update public.bookings
set status = 'cancelled',
    payment_status = 'failed'
where coalesce(host_booking, false) = false
  and created_via = 'customer'
  and lower(coalesce(payment_method, '')) in (
    'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
  )
  and status in ('pending', 'verifying')
  and payment_status in ('unpaid', 'pending', 'for_verification')
  and nullif(btrim(coalesce(receipt_image_url, '')), '') is null
  and created_at < now() - interval '15 minutes';

create trigger trg_guard_payment_review_transition
before update on public.bookings
for each row execute function public.guard_payment_review_transition();

drop trigger if exists trg_guard_payment_review_delete
  on public.bookings;
create trigger trg_guard_payment_review_delete
before delete on public.bookings
for each row execute function public.guard_payment_review_delete();

drop trigger if exists trg_guard_open_play_registration_insert
  on public.open_play_registrations;
create trigger trg_guard_open_play_registration_insert
before insert on public.open_play_registrations
for each row execute function public.guard_open_play_registration_insert();

drop trigger if exists trg_guard_open_play_payment_review_transition
  on public.open_play_registrations;
create trigger trg_guard_open_play_payment_review_transition
before update on public.open_play_registrations
for each row execute function public.guard_open_play_payment_review_transition();

drop trigger if exists trg_guard_open_play_payment_review_delete
  on public.open_play_registrations;
create trigger trg_guard_open_play_payment_review_delete
before delete on public.open_play_registrations
for each row execute function public.guard_open_play_payment_review_delete();

drop trigger if exists trg_guard_host_session_registration_insert
  on public.open_play_host_session_registrations;
create trigger trg_guard_host_session_registration_insert
before insert on public.open_play_host_session_registrations
for each row execute function public.guard_host_session_registration_insert();

drop trigger if exists trg_guard_host_session_payment_review_transition
  on public.open_play_host_session_registrations;
create trigger trg_guard_host_session_payment_review_transition
before update on public.open_play_host_session_registrations
for each row execute function
  public.guard_host_session_payment_review_transition();

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
    and receipt_image_url is null
    and receipt_image_hash is null
    and receipt_phash is null
    and receipt_status = 'none'
    and coalesce(cardinality(receipt_flags), 0) = 0
    and receipt_extracted is null
    and receipt_confidence is null
    and receipt_verified_at is null
    and (
      (
        lower(coalesce(payment_method, '')) = 'cash'
        and status = 'pending'
        and payment_status = 'unpaid'
      )
      or (
        lower(coalesce(payment_method, '')) in (
          'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
        )
        and status = 'verifying'
        and payment_status = 'for_verification'
      )
    )
    and created_at > now() - interval '15 minutes'
    and created_at <= now() + interval '5 minutes'
    and total is not null
    and total >= 0
    and (
      downpayment is null
      or abs(downpayment - total) <= 0.01
      or abs(downpayment - (total / 2)) <= 0.01
      or abs(downpayment - round(total / 2)) <= 0.01
      or abs(
        downpayment - round(
          least(greatest(coalesce(booking_fee_amount_snapshot, 0), 0), total)
          + (
            (
              total
              - least(greatest(coalesce(booking_fee_amount_snapshot, 0), 0), total)
            ) * 0.50
          ),
          2
        )
      ) <= 0.01
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
    and payment_status = 'for_verification'
    and coalesce(host_booking, false) = false
    and host_user_id is null
    and created_via = 'customer'
    and created_by_user_id is null
    and receipt_image_url is null
    and receipt_image_hash is null
    and receipt_phash is null
    and receipt_status = 'none'
    and coalesce(cardinality(receipt_flags), 0) = 0
    and receipt_extracted is null
    and receipt_confidence is null
    and receipt_verified_at is null
  )
  with check (
    (
      (
        lower(coalesce(payment_method, '')) in (
          'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
        )
        and status = 'verifying'
        and payment_status = 'for_verification'
      )
      or (
        lower(coalesce(payment_method, '')) = 'cash'
        and status = 'pending'
        and payment_status = 'unpaid'
      )
      or (
        status = 'cancelled'
        and payment_status = 'failed'
      )
    )
    and coalesce(host_booking, false) = false
    and host_user_id is null
    and created_via = 'customer'
    and created_by_user_id is null
    and receipt_image_url is null
    and receipt_image_hash is null
    and receipt_phash is null
    and receipt_status = 'none'
    and coalesce(cardinality(receipt_flags), 0) = 0
    and receipt_extracted is null
    and receipt_confidence is null
    and receipt_verified_at is null
    and (
      status = 'cancelled'
      or created_at > now() - interval '15 minutes'
    )
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
drop policy if exists open_play_select_capacity
  on public.open_play_registrations;
create policy open_play_select_capacity
  on public.open_play_registrations
  for select
  to anon
  using (
    not capacity_exception
    or payment_status = 'rejected'
  );

drop policy if exists open_play_select_dashboard_roles
  on public.open_play_registrations;
create policy open_play_select_dashboard_roles
  on public.open_play_registrations
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.accounts account
      where account.id = auth.uid()
        and account.status = 'active'
        and account.role in ('owner', 'court_owner', 'staff')
    )
  );

revoke select on table public.open_play_registrations from public, anon;
grant select (id, court_id, date, payment_status)
  on public.open_play_registrations to anon;
grant select on table public.open_play_registrations to authenticated;

drop policy if exists open_play_insert_public on public.open_play_registrations;
create policy open_play_insert_public on public.open_play_registrations
  for insert
  to anon
  with check (
    (
      (
        lower(coalesce(payment_method, 'cash')) = 'cash'
        and payment_status = 'pending'
        and gcash_ref is null
        and receipt_verification_id is null
        and receipt_image_url is null
        and receipt_image_hash is null
        and receipt_phash is null
        and receipt_status = 'none'
        and coalesce(cardinality(receipt_flags), 0) = 0
        and receipt_extracted is null
        and receipt_confidence is null
        and receipt_verified_at is null
        and amount is not null
        and amount >= 0
        and not capacity_exception
      )
      or (
        lower(coalesce(payment_method, '')) in (
          'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
        )
        and payment_status in ('pending', 'paid')
        and receipt_status in ('manual_review', 'auto_approved')
        and nullif(btrim(coalesce(gcash_ref, '')), '') is not null
        and receipt_verification_id is not null
        and nullif(btrim(coalesce(receipt_image_url, '')), '') is not null
        and lower(coalesce(receipt_image_hash, '')) ~ '^[a-f0-9]{64}$'
        and receipt_verified_at is not null
        and amount > 0
      )
    )
    and created_at > now() - interval '15 minutes'
    and created_at <= now() + interval '5 minutes'
  );

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
  for select to authenticated
  using (
    exists (
      select 1
      from public.accounts account
      where account.id = auth.uid()
        and account.status = 'active'
        and account.role in ('owner','court_owner','staff')
    )
  );

drop policy if exists receipt_verifications_no_write on public.receipt_verifications;
create policy receipt_verifications_no_write on public.receipt_verifications
  for all to authenticated using (false) with check (false);

revoke all on table public.private_settings from anon, authenticated;

drop policy if exists payment_review_notifications_read_roles
  on public.payment_review_notifications;

revoke all on table public.payment_review_notifications from anon, authenticated;

drop policy if exists payment_review_decisions_read_roles
  on public.payment_review_decisions;
create policy payment_review_decisions_read_roles
  on public.payment_review_decisions
  for select to authenticated
  using (
    exists (
      select 1
      from public.accounts account
      where account.id = auth.uid()
        and account.status = 'active'
        and account.role in ('owner','court_owner','staff')
    )
  );

revoke all on table public.payment_review_decisions from anon, authenticated;
grant select on table public.payment_review_decisions to authenticated;

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
  to anon, authenticated
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
    public.has_account_role(array['owner','court_owner','staff'])
    or exists (
      select 1
      from public.open_play_host_sessions host_session
      where host_session.id = session_id
        and public.has_account_role(array['host'])
        and host_session.host_user_id = auth.uid()
    )
  );

-- The Edge verifier first creates a manual-review audit and pending
-- registration. This service-only RPC then derives the terminal metadata from
-- that bound audit, claims every replay key atomically, and only then marks an
-- automatic pass paid. Any exception rolls back every ledger claim and leaves
-- the checkpoint pending for owner review.
create or replace function public.finalize_inline_receipt_registration(
  p_context text,
  p_registration_id text,
  p_receipt_verification_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_context text := lower(btrim(coalesce(p_context, '')));
  audit_result text;
  audit_booking_ref text;
  audit_flags text[] := '{}';
  audit_extracted jsonb;
  audit_confidence numeric;
  audit_image_hash text;
  audit_phash text;
  audit_created_at timestamptz;
  public_extracted jsonb;
  final_flags text[] := '{}';
  verified_provider text;
  submitted_reference text;
  expected_path_prefix text;
  registration_ref text;
  claimed_by_ref text;
  ledger_item record;
  ledger_count integer := 0;
  open_play_id bigint;
  host_registration_id uuid;
  stored_payment_status text;
  stored_capacity_exception boolean;
  stored_receipt_verification_id bigint;
  stored_receipt_url text;
  stored_receipt_hash text;
  stored_full_name text;
  stored_court_id text;
  stored_court_name text;
  stored_date date;
  stored_hour integer;
  stored_time_label text;
  stored_payment_type text;
  stored_payment_method text;
  stored_payment_ref text;
  stored_amount numeric;
  stored_session_id uuid;
  stored_contact_number text;
  host_session_date date;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and session_user not in ('postgres', 'supabase_admin') then
    raise exception using
      errcode = '42501',
      message = 'Service-role receipt finalization is required.';
  end if;

  if requested_context not in ('open_play', 'host_session')
     or nullif(btrim(coalesce(p_registration_id, '')), '') is null
     or p_receipt_verification_id is null
     or p_receipt_verification_id <= 0 then
    raise exception using
      errcode = '22023',
      message = 'A valid inline receipt checkpoint is required.';
  end if;

  select
    verification.result,
    verification.booking_ref,
    coalesce(verification.flags, '{}'::text[]),
    verification.extracted,
    verification.confidence,
    lower(nullif(btrim(verification.image_hash), '')),
    verification.phash,
    verification.created_at
  into
    audit_result,
    audit_booking_ref,
    audit_flags,
    audit_extracted,
    audit_confidence,
    audit_image_hash,
    audit_phash,
    audit_created_at
  from public.receipt_verifications verification
  where verification.id = p_receipt_verification_id
  for share;

  if not found
     or audit_result not in ('auto_approved', 'manual_review', 'rejected')
     or audit_extracted is null
     or audit_image_hash !~ '^[a-f0-9]{64}$'
     or coalesce(audit_extracted->>'verificationContext', '')
       <> requested_context then
    raise exception using
      errcode = '42501',
      message = 'The inline receipt audit is invalid.';
  end if;

  verified_provider := lower(nullif(btrim(coalesce(
    audit_extracted->>'provider',
    audit_extracted->>'payment_method',
    audit_extracted->>'paymentMethod'
  )), ''));
  submitted_reference := nullif(btrim(coalesce(
    audit_extracted->>'submittedReference',
    audit_extracted->>'gcash_ref',
    audit_extracted->>'gcashRef'
  )), '');
  expected_path_prefix := audit_booking_ref || '/' || audit_image_hash || '.';
  public_extracted := audit_extracted - array[
    'verificationContext',
    'registrationContext',
    'legacyRegistrationContext',
    'submittedReference',
    'expectedAmount',
    'expectedTotal',
    'dedupeKeys',
    'ocrAnalysisText',
    'processingCheckpoint',
    'processingFailure'
  ];
  final_flags := array_remove(audit_flags, 'SESSION_CAPACITY_REVIEW');

  if requested_context = 'open_play' then
    begin
      open_play_id := p_registration_id::bigint;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception using
        errcode = '22023',
        message = 'A valid Open Play registration ID is required.';
    end;

    select
      registration.payment_status,
      registration.capacity_exception,
      registration.receipt_verification_id,
      registration.receipt_image_url,
      lower(nullif(btrim(registration.receipt_image_hash), '')),
      registration.full_name,
      registration.court_id,
      registration.court_name,
      registration.date,
      registration.hour,
      registration.time_label,
      registration.payment_type,
      lower(nullif(btrim(registration.payment_method), '')),
      nullif(btrim(registration.gcash_ref), ''),
      registration.amount
    into
      stored_payment_status,
      stored_capacity_exception,
      stored_receipt_verification_id,
      stored_receipt_url,
      stored_receipt_hash,
      stored_full_name,
      stored_court_id,
      stored_court_name,
      stored_date,
      stored_hour,
      stored_time_label,
      stored_payment_type,
      stored_payment_method,
      stored_payment_ref,
      stored_amount
    from public.open_play_registrations registration
    where registration.id = open_play_id
    for update;

    if not found then
      raise exception using
        errcode = 'P0002',
        message = 'Open Play receipt checkpoint was not found.';
    end if;
    if stored_payment_status in ('paid', 'rejected') then
      return jsonb_build_object(
        'registrationId', open_play_id,
        'paymentStatus', stored_payment_status,
        'capacityException', stored_capacity_exception
      );
    end if;
    if stored_payment_status <> 'pending'
       or stored_receipt_verification_id is distinct from
         p_receipt_verification_id
       or stored_receipt_hash is distinct from audit_image_hash
       or stored_receipt_url not in (
         expected_path_prefix || 'jpg',
         expected_path_prefix || 'png',
         expected_path_prefix || 'webp',
         expected_path_prefix || 'heic'
       )
       or audit_booking_ref !~ '^OP-[A-Z0-9]{6,40}$'
       or verified_provider is distinct from stored_payment_method
       or upper(submitted_reference)
         is distinct from upper(stored_payment_ref)
       or not public.open_play_receipt_audit_matches(
         audit_extracted,
         stored_full_name,
         stored_court_id,
         stored_court_name,
         stored_date,
         stored_hour,
         stored_time_label,
         stored_payment_type,
         stored_payment_method,
         stored_payment_ref,
         stored_amount
       ) then
      raise exception using
        errcode = '42501',
        message = 'The Open Play checkpoint does not match its receipt audit.';
    end if;

    if stored_capacity_exception then
      final_flags := array_append(
        final_flags,
        'SESSION_CAPACITY_REVIEW'
      );
    end if;

    if audit_result = 'auto_approved'
       and not stored_capacity_exception then
      registration_ref := 'OPR-' || open_play_id::text;
      for ledger_item in
        select distinct keys.ledger_key, keys.provider_key
        from public.payment_review_ledger_keys(
          audit_extracted,
          verified_provider,
          submitted_reference
        ) keys
        order by keys.ledger_key, keys.provider_key
      loop
        ledger_count := ledger_count + 1;
        insert into public.used_gcash_refs (
          gcash_ref,
          booking_ref,
          provider
        )
        values (
          ledger_item.ledger_key,
          registration_ref,
          ledger_item.provider_key
        )
        on conflict (gcash_ref) do nothing;

        select used_ref.booking_ref
        into claimed_by_ref
        from public.used_gcash_refs used_ref
        where used_ref.gcash_ref = ledger_item.ledger_key
        for update;
        if claimed_by_ref is distinct from registration_ref then
          raise exception using
            errcode = '23505',
            message = 'Duplicate payment reference: this reference belongs to another payment.';
        end if;
      end loop;
      if ledger_count = 0 then
        raise exception using
          errcode = 'P0001',
          message = 'The receipt has no authoritative payment replay key.';
      end if;
    end if;

    update public.open_play_registrations registration
    set payment_status = case
          when audit_result = 'auto_approved'
            and not stored_capacity_exception then 'paid'
          else 'pending'
        end,
        receipt_status = case
          when audit_result = 'auto_approved'
            and not stored_capacity_exception then 'auto_approved'
          else 'manual_review'
        end,
        receipt_phash = audit_phash,
        receipt_flags = final_flags,
        receipt_extracted = public_extracted,
        receipt_confidence = audit_confidence,
        receipt_verified_at = audit_created_at
    where registration.id = open_play_id
      and registration.payment_status = 'pending'
      and registration.receipt_verification_id =
        p_receipt_verification_id;

    if not found then
      raise exception using
        errcode = '40001',
        message = 'Open Play receipt checkpoint changed; retry finalization.';
    end if;
    return jsonb_build_object(
      'registrationId', open_play_id,
      'paymentStatus', case
        when audit_result = 'auto_approved'
          and not stored_capacity_exception then 'paid'
        else 'pending'
      end,
      'capacityException', stored_capacity_exception
    );
  end if;

  begin
    host_registration_id := p_registration_id::uuid;
  exception when invalid_text_representation then
    raise exception using
      errcode = '22023',
      message = 'A valid host-session registration ID is required.';
  end;

  select
    registration.payment_status,
    registration.capacity_exception,
    registration.receipt_verification_id,
    registration.receipt_image_url,
    lower(nullif(btrim(registration.receipt_image_hash), '')),
    registration.session_id,
    registration.full_name,
    coalesce(registration.contact_number, ''),
    lower(nullif(btrim(registration.payment_method), '')),
    nullif(btrim(registration.gcash_ref), ''),
    registration.amount,
    host_session.date
  into
    stored_payment_status,
    stored_capacity_exception,
    stored_receipt_verification_id,
    stored_receipt_url,
    stored_receipt_hash,
    stored_session_id,
    stored_full_name,
    stored_contact_number,
    stored_payment_method,
    stored_payment_ref,
    stored_amount,
    host_session_date
  from public.open_play_host_session_registrations registration
  join public.open_play_host_sessions host_session
    on host_session.id = registration.session_id
  where registration.id = host_registration_id
  for update of registration;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Host-session receipt checkpoint was not found.';
  end if;
  if stored_payment_status in ('paid', 'rejected') then
    return jsonb_build_object(
      'registrationId', host_registration_id,
      'paymentStatus', stored_payment_status,
      'capacityException', stored_capacity_exception
    );
  end if;
  if stored_payment_status <> 'pending'
     or stored_receipt_verification_id is distinct from
       p_receipt_verification_id
     or stored_receipt_hash is distinct from audit_image_hash
     or stored_receipt_url not in (
       expected_path_prefix || 'jpg',
       expected_path_prefix || 'png',
       expected_path_prefix || 'webp',
       expected_path_prefix || 'heic'
     )
     or audit_booking_ref !~ '^HS-[A-Z0-9]{6,40}$'
     or verified_provider is distinct from stored_payment_method
     or upper(submitted_reference)
       is distinct from upper(stored_payment_ref)
     or not public.host_session_receipt_audit_matches(
       audit_extracted,
       stored_session_id,
       host_session_date,
       stored_full_name,
       stored_contact_number,
       stored_payment_method,
       stored_payment_ref,
       stored_amount
     ) then
    raise exception using
      errcode = '42501',
      message = 'The host-session checkpoint does not match its receipt audit.';
  end if;

  if stored_capacity_exception then
    final_flags := array_append(
      final_flags,
      'SESSION_CAPACITY_REVIEW'
    );
  end if;

  if audit_result = 'auto_approved'
     and not stored_capacity_exception then
    registration_ref := 'HSR-' || host_registration_id::text;
    for ledger_item in
      select distinct keys.ledger_key, keys.provider_key
      from public.payment_review_ledger_keys(
        audit_extracted,
        verified_provider,
        submitted_reference
      ) keys
      order by keys.ledger_key, keys.provider_key
    loop
      ledger_count := ledger_count + 1;
      insert into public.used_gcash_refs (
        gcash_ref,
        booking_ref,
        provider
      )
      values (
        ledger_item.ledger_key,
        registration_ref,
        ledger_item.provider_key
      )
      on conflict (gcash_ref) do nothing;

      select used_ref.booking_ref
      into claimed_by_ref
      from public.used_gcash_refs used_ref
      where used_ref.gcash_ref = ledger_item.ledger_key
      for update;
      if claimed_by_ref is distinct from registration_ref then
        raise exception using
          errcode = '23505',
          message = 'Duplicate payment reference: this reference belongs to another payment.';
      end if;
    end loop;
    if ledger_count = 0 then
      raise exception using
        errcode = 'P0001',
        message = 'The receipt has no authoritative payment replay key.';
    end if;
  end if;

  update public.open_play_host_session_registrations registration
  set payment_status = case
        when audit_result = 'auto_approved'
          and not stored_capacity_exception then 'paid'
        else 'pending'
      end,
      receipt_status = case
        when audit_result = 'auto_approved'
          and not stored_capacity_exception then 'auto_approved'
        else 'manual_review'
      end,
      receipt_phash = audit_phash,
      receipt_flags = final_flags,
      receipt_extracted = public_extracted,
      receipt_confidence = audit_confidence,
      receipt_verified_at = audit_created_at
  where registration.id = host_registration_id
    and registration.payment_status = 'pending'
    and registration.receipt_verification_id =
      p_receipt_verification_id;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'Host-session receipt checkpoint changed; retry finalization.';
  end if;
  return jsonb_build_object(
    'registrationId', host_registration_id,
    'paymentStatus', case
      when audit_result = 'auto_approved'
        and not stored_capacity_exception then 'paid'
      else 'pending'
    end,
    'capacityException', stored_capacity_exception
  );
end;
$$;

revoke all on function public.finalize_inline_receipt_registration(
  text,
  text,
  bigint
) from public, anon, authenticated;
grant execute on function public.finalize_inline_receipt_registration(
  text,
  text,
  bigint
) to service_role;

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
  ('payment_method_bpi', '1'),
  ('payment_method_maribank', '1'),
  ('gcash_qr_account_id', 'DWQM4TK496R3UA1BS')
on conflict (key) do nothing;

notify pgrst, 'reload schema';

-- ============================================================
-- DONE
--
-- Next steps:
-- 1. In a new SQL Editor query, run the complete contents of
--    supabase/migrations/20260713213000_accumulated_booking_fee_remittances.sql.
-- 2. Authentication -> Providers -> Email -> disable Confirm email.
-- 3. Project Settings -> API -> copy Project URL and anon public key.
-- 4. Update .env.local / supabase-config.js for the cloned app.
-- 5. Run create-accounts.js with a service-role key to create dashboard users.
-- 6. Deploy edge functions and configure their required secrets.
-- ============================================================
