-- Host reservations may use the non-refundable 25% option only while the
-- earliest booked start is more than five full days away. The balance is due
-- at that five-day boundary; overdue reservations are forfeited, not deleted.

alter table public.bookings
  add column if not exists balance_due_at timestamptz,
  add column if not exists forfeited_at timestamptz,
  add column if not exists forfeiture_reason text;

alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings
  add constraint bookings_status_check
  check (status in ('pending','verifying','confirmed','cancelled','completed','forfeited'));

alter table public.bookings drop constraint if exists bookings_payment_status_check;
alter table public.bookings
  add constraint bookings_payment_status_check
  check (payment_status in (
    'unpaid','pending','for_verification','downpayment_paid','paid','failed','rejected','deposit_retained'
  ));

create or replace function public.booking_start_at_ph(
  p_date date,
  p_start_time text,
  p_slots text[]
)
returns timestamptz
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_hour integer;
  v_local timestamp;
begin
  select min(slot::integer)
    into v_hour
  from unnest(coalesce(p_slots, array[]::text[])) slot
  where slot ~ '^\d{1,2}$'
    and slot::integer between 0 and 23;

  if v_hour is not null then
    v_local := p_date::timestamp + make_interval(hours => v_hour);
    return v_local at time zone 'Asia/Manila';
  end if;

  begin
    v_local := to_timestamp(
      p_date::text || ' ' || trim(coalesce(p_start_time, '')),
      'YYYY-MM-DD HH12:MI AM'
    )::timestamp;
    return v_local at time zone 'Asia/Manila';
  exception when others then
    return null;
  end;
end;
$$;

create or replace function public.set_host_balance_deadline()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_start timestamptz;
begin
  if coalesce(new.host_booking, false) then
    v_start := public.booking_start_at_ph(new.date, new.start_time, new.slots);
    new.balance_due_at := case when v_start is null then null else v_start - interval '5 days' end;
  else
    new.balance_due_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_host_balance_deadline on public.bookings;
create trigger trg_set_host_balance_deadline
before insert or update of date, start_time, slots, host_booking
on public.bookings
for each row execute function public.set_host_balance_deadline();

update public.bookings
set balance_due_at = public.booking_start_at_ph(date, start_time, slots) - interval '5 days'
where coalesce(host_booking, false)
  and balance_due_at is null
  and public.booking_start_at_ph(date, start_time, slots) - interval '5 days' > now();

create or replace function public.guard_host_payment_deadline()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  request_role text := coalesce(auth.role(), nullif(current_setting('request.jwt.claim.role', true), ''));
  account_role text := public.current_account_role();
begin
  if request_role = 'authenticated'
     and account_role = 'host'
     and coalesce(old.host_booking, false)
     and new.downpayment is not null
     and old.balance_due_at is not null
     and now() >= old.balance_due_at
     and abs(new.downpayment - old.total) > 0.01 then
    raise exception 'Full payment is required because this Open Play starts in five days or less.'
      using errcode = '22000';
  end if;

  if request_role in ('anon', 'authenticated')
     and (request_role = 'anon' or account_role = 'host') then
    if new.balance_due_at is distinct from old.balance_due_at
       or new.forfeited_at is distinct from old.forfeited_at
       or new.forfeiture_reason is distinct from old.forfeiture_reason
       or new.status = 'forfeited'
       or new.payment_status = 'deposit_retained' then
      raise exception 'Balance deadlines and forfeiture records are managed by Korte DOS.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_host_payment_deadline on public.bookings;
create trigger trg_guard_host_payment_deadline
before update on public.bookings
for each row execute function public.guard_host_payment_deadline();

-- Forfeited rows never hold a court slot.
create or replace function public.prevent_double_booking()
returns trigger
language plpgsql
set search_path = public, pg_temp
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

  if new.status in ('cancelled', 'forfeited') then return new; end if;

  if exists (
    select 1
    from public.bookings b
    where b.court_id = new.court_id
      and b.date = new.date
      and b.status not in ('cancelled', 'forfeited')
      and b.ref <> new.ref
      and b.slots && new.slots
      and (
        b.status <> 'verifying'
        or b.created_at is null
        or b.created_at > now() - interval '15 minutes'
      )
  ) then
    raise exception 'One or more time slots are already booked for this court and date.';
  end if;
  return new;
end;
$$;

create table if not exists public.booking_balance_notifications (
  id uuid primary key default gen_random_uuid(),
  booking_key text not null,
  booking_ref text not null,
  event_type text not null,
  recipient_email text not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  provider_message_id text,
  error_message text,
  created_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  constraint booking_balance_notifications_event_check
    check (event_type in ('reminder_3d','reminder_2d','reminder_1d','forfeited','manual')),
  constraint booking_balance_notifications_status_check
    check (status in ('pending','sent','failed')),
  constraint booking_balance_notifications_unique_event unique (booking_key, event_type)
);

create index if not exists idx_booking_balance_notifications_recent
  on public.booking_balance_notifications(created_at desc);

alter table public.booking_balance_notifications enable row level security;

drop policy if exists booking_balance_notifications_admin_read on public.booking_balance_notifications;
create policy booking_balance_notifications_admin_read
  on public.booking_balance_notifications
  for select to authenticated
  using (public.has_account_role(array['owner','court_owner','staff']));

create or replace function public.forfeit_overdue_host_booking(p_booking_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the balance processor may forfeit reservations.' using errcode = '42501';
  end if;

  with changed as (
    update public.bookings b
       set status = 'forfeited',
           payment_status = 'deposit_retained',
           forfeited_at = now(),
           forfeiture_reason = 'Remaining balance was not paid by the deadline.'
     where coalesce(b.host_booking, false)
       and (b.ref = p_booking_key or b.booking_group_ref = p_booking_key)
       and b.status = 'confirmed'
       and b.payment_status = 'downpayment_paid'
       and b.balance_due_at <= now()
    returning b.ref
  )
  select jsonb_build_object('changed', count(*), 'refs', coalesce(jsonb_agg(ref), '[]'::jsonb))
    into result
  from changed;

  return coalesce(result, jsonb_build_object('changed', 0, 'refs', '[]'::jsonb));
end;
$$;

revoke all on function public.forfeit_overdue_host_booking(text) from public, anon, authenticated;
grant execute on function public.forfeit_overdue_host_booking(text) to service_role;

-- The processor is idempotent and records one notification per booking/event.
-- Supabase's database cron invokes it every fifteen minutes.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $$
declare
  existing_job bigint;
begin
  select jobid into existing_job from cron.job where jobname = 'process-host-balance-deadlines' limit 1;
  if existing_job is not null then perform cron.unschedule(existing_job); end if;
  perform cron.schedule(
    'process-host-balance-deadlines',
    '*/15 * * * *',
    $job$select net.http_post(
      url := 'https://zcuufcpkgidmaanxjufo.supabase.co/functions/v1/process-host-balance-deadlines',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{"source":"database-cron"}'::jsonb
    );$job$
  );
end;
$$;

notify pgrst, 'reload schema';
