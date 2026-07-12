-- Complete the July host-portal schema rollout and give active hosts a
-- narrowly-scoped path for creating and finalizing their own booking holds.
--
-- Authenticated host holds are priced from server-side court/settings rows
-- before RLS evaluates the insert. Their client-supplied rate and total are not
-- trusted.

-- -------------------------------------------------------------------------
-- Compatibility repair for projects that did not receive both July migrations
-- -------------------------------------------------------------------------

alter table public.open_play_host_applications
  add column if not exists host_user_id uuid,
  add column if not exists gcash_number text,
  add column if not exists valid_id_file_name text,
  add column if not exists valid_id_file_type text,
  add column if not exists valid_id_file_size bigint,
  add column if not exists valid_id_path text;

-- Add status as nullable first so legacy rows can be reconciled before a
-- default is applied. Reruns preserve deliberate suspensions of approved or
-- pending hosts, while a latest pending/rejected application cannot stay active.
alter table public.accounts
  add column if not exists status text;

-- Pending legacy signups normally have an Auth user but no accounts row yet.
-- Recover that link only for a unique same-email Auth user whose signup
-- metadata identifies it as a host, and never repurpose an existing non-host
-- account. Account creation/activation remains the approval function's job.
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

-- Safely recover the durable application/account link where exactly one
-- legacy host account matches the normalized email/email-style username or
-- the UUID kept in legacy review_note signup metadata. Remaining ambiguous or
-- unmatched applications stay untouched for owner review.
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

-- An email-matched application that could not be linked uniquely must never
-- leave an already-defaulted legacy host active.
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

-- Pre-status dashboard accounts retain their historical access. A host that
-- is still null after reconciliation fails closed until owner activation.
update public.accounts
set status = case when role = 'host' then 'suspended' else 'active' end
where status is null;

-- Unknown states must not accidentally grant dashboard/host access.
update public.accounts
set status = 'suspended'
where status not in ('active', 'pending', 'suspended');

alter table public.accounts
  alter column status set default 'active',
  alter column status set not null;

alter table public.accounts
  drop constraint if exists accounts_status_check;

alter table public.accounts
  add constraint accounts_status_check
  check (status in ('active', 'pending', 'suspended'));

alter table public.accounts
  drop constraint if exists accounts_role_check;

alter table public.accounts
  add constraint accounts_role_check
  check (role in ('owner', 'court_owner', 'staff', 'host'));

create index if not exists idx_open_play_host_applications_host_user
  on public.open_play_host_applications(host_user_id);

alter table public.bookings
  add column if not exists host_booking boolean not null default false,
  add column if not exists host_user_id uuid,
  add column if not exists host_name text,
  add column if not exists host_email text,
  add column if not exists created_via text not null default 'customer',
  add column if not exists created_by_user_id uuid,
  add column if not exists created_by_role text,
  add column if not exists created_by_name text,
  add column if not exists created_by_email text;

alter table public.bookings
  alter column host_booking set default false,
  alter column created_via set default 'customer';

update public.bookings
set host_booking = false
where host_booking is null;

update public.bookings
set created_via = 'customer'
where created_via is null
   or created_via not in ('customer', 'admin', 'host', 'import', 'system');

alter table public.bookings
  alter column host_booking set not null,
  alter column created_via set not null;

alter table public.bookings
  drop constraint if exists bookings_created_via_check;

alter table public.bookings
  add constraint bookings_created_via_check
  check (created_via in ('customer', 'admin', 'host', 'import', 'system'));

create index if not exists idx_bookings_host_booking
  on public.bookings(host_booking, host_user_id, date);

create index if not exists idx_bookings_created_via
  on public.bookings(created_via);

create index if not exists idx_bookings_created_by_user_id
  on public.bookings(created_by_user_id);

-- Pending and suspended accounts authenticate with Supabase, but must not gain
-- application privileges until an owner activates them.
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

grant execute on function public.current_account_role() to anon, authenticated;

-- Match the booking UI/receipt verifier's tier selection for valid pricing
-- JSON: court-specific tiers win, then global pricing_tiers, then court.rate.
-- Overnight ranges (from > to) wrap across midnight; an unmatched hour uses
-- the minimum configured tier rate.
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

-- Canonicalize every booking hold inserted by an active authenticated host.
-- BEFORE INSERT triggers run before an RLS WITH CHECK expression, so the host
-- policy below can require these server-owned values even with an older client.
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

drop trigger if exists trg_prepare_authenticated_host_booking_hold
  on public.bookings;
create trigger trg_prepare_authenticated_host_booking_hold
before insert on public.bookings
for each row execute function public.prepare_authenticated_host_booking_hold();

-- Guard both anonymous hold finalization and authenticated host finalization.
-- Dashboard roles and service-role Edge Functions retain their existing write
-- behavior; their authorization continues to come from RLS/service role.
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
    -- A temporary hold may collect customer/payment details, but its booking
    -- identity, slot, original price, ownership, and server audit fields are
    -- immutable from the browser after insert.
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

    -- Browsers may submit a payment for review, leave cash unpaid, or cancel a
    -- failed hold. They may not directly mark their own payment as paid.
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

      -- The total was stamped by prepare_authenticated_host_booking_hold.
      -- Re-read the stored service-fee configuration only to separate that
      -- immutable total into its fee and court portions.
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

drop trigger if exists trg_guard_public_booking_hold_update on public.bookings;
create trigger trg_guard_public_booking_hold_update
before update on public.bookings
for each row execute function public.guard_public_booking_hold_update();

-- -------------------------------------------------------------------------
-- Booking RLS: separate public, dashboard, and active-host capabilities
-- -------------------------------------------------------------------------

alter table public.bookings enable row level security;

drop policy if exists bookings_insert_public on public.bookings;
create policy bookings_insert_public
  on public.bookings
  for insert
  to anon
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
create policy bookings_insert_dashboard_roles
  on public.bookings
  for insert
  to authenticated
  with check (public.has_account_role(array['owner', 'court_owner', 'staff']));

drop policy if exists bookings_insert_host_hold on public.bookings;
create policy bookings_insert_host_hold
  on public.bookings
  for insert
  to authenticated
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
create policy bookings_update_dashboard_roles
  on public.bookings
  for update
  to authenticated
  using (public.has_account_role(array['owner', 'court_owner', 'staff']))
  with check (public.has_account_role(array['owner', 'court_owner', 'staff']));

drop policy if exists bookings_update_public_hold on public.bookings;
create policy bookings_update_public_hold
  on public.bookings
  for update
  to anon
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
create policy bookings_update_host_hold
  on public.bookings
  for update
  to authenticated
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

-- Owners and court owners both review host applications in the portal.
drop policy if exists open_play_host_applications_owner_all
  on public.open_play_host_applications;
create policy open_play_host_applications_owner_all
  on public.open_play_host_applications
  for all
  to authenticated
  using (public.has_account_role(array['owner', 'court_owner']))
  with check (public.has_account_role(array['owner', 'court_owner']));

-- The application Edge Function uses service-role access for this private
-- bucket. Explicitly exclude it from the legacy catch-all object policies.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'host-ids',
  'host-ids',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists receipts_no_select on storage.objects;
create policy receipts_no_select
  on storage.objects
  for select to anon, authenticated
  using (bucket_id not in ('receipts', 'host-ids'));

drop policy if exists receipts_no_insert on storage.objects;
create policy receipts_no_insert
  on storage.objects
  for insert to anon, authenticated
  with check (bucket_id not in ('receipts', 'host-ids'));

drop policy if exists receipts_no_update on storage.objects;
create policy receipts_no_update
  on storage.objects
  for update to anon, authenticated
  using (bucket_id not in ('receipts', 'host-ids'));

drop policy if exists receipts_no_delete on storage.objects;
create policy receipts_no_delete
  on storage.objects
  for delete to anon, authenticated
  using (bucket_id not in ('receipts', 'host-ids'));

drop policy if exists host_ids_no_select on storage.objects;
drop policy if exists host_ids_no_insert on storage.objects;
drop policy if exists host_ids_no_update on storage.objects;
drop policy if exists host_ids_no_delete on storage.objects;

notify pgrst, 'reload schema';
