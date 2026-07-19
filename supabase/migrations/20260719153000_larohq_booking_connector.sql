-- Sends a privacy-minimized booking event to LaroHQ after each Korte DOS change.
-- The destination URL and shared token stay encrypted in Supabase Vault.

create extension if not exists pg_net with schema extensions;

create or replace function public.larohq_safe_booking_payload(p_booking jsonb)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_booking is null then null
    else jsonb_build_object(
      'ref', p_booking -> 'ref',
      'court_id', p_booking -> 'court_id',
      'court_name', p_booking -> 'court_name',
      'date', p_booking -> 'date',
      'slots', p_booking -> 'slots',
      'start_time', p_booking -> 'start_time',
      'end_time', p_booking -> 'end_time',
      'duration', p_booking -> 'duration',
      'total', p_booking -> 'total',
      'status', p_booking -> 'status',
      'payment_status', p_booking -> 'payment_status',
      'created_at', p_booking -> 'created_at',
      'booking_fee_earned_at', p_booking -> 'booking_fee_earned_at',
      'booking_fee_amount_snapshot', p_booking -> 'booking_fee_amount_snapshot'
    )
  end
$$;

create or replace function public.dispatch_booking_to_larohq(
  p_type text,
  p_record jsonb,
  p_old_record jsonb default null,
  p_event_id uuid default gen_random_uuid()
)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, vault, pg_temp
as $$
declare
  connector_url text;
  connector_token text;
  request_id bigint;
begin
  select decrypted_secret into connector_url
    from vault.decrypted_secrets
   where name = 'larohq_ingest_url'
   limit 1;

  select decrypted_secret into connector_token
    from vault.decrypted_secrets
   where name = 'larohq_korte_token'
   limit 1;

  -- Installation is safe before configuration: bookings continue normally
  -- until both Vault values are present.
  if nullif(trim(connector_url), '') is null or nullif(trim(connector_token), '') is null then
    return null;
  end if;

  select net.http_post(
    url := connector_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-larohq-token', connector_token
    ),
    body := jsonb_build_object(
      'event_id', p_event_id,
      'type', upper(p_type),
      'table', 'bookings',
      'schema', 'public',
      'occurred_at', clock_timestamp(),
      'record', public.larohq_safe_booking_payload(p_record),
      'old_record', public.larohq_safe_booking_payload(p_old_record)
    )
  ) into request_id;

  return request_id;
end;
$$;

create or replace function public.notify_larohq_booking_change()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, vault, pg_temp
as $$
begin
  perform public.dispatch_booking_to_larohq(
    tg_op,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end,
    case when tg_op = 'INSERT' then null else to_jsonb(old) end
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists bookings_notify_larohq on public.bookings;
create trigger bookings_notify_larohq
after insert or update or delete on public.bookings
for each row execute function public.notify_larohq_booking_change();

create or replace function public.backfill_bookings_to_larohq(p_limit integer default 2000)
returns integer
language plpgsql
security definer
set search_path = public, extensions, vault, pg_temp
as $$
declare
  booking_row public.bookings%rowtype;
  queued integer := 0;
begin
  if p_limit < 1 or p_limit > 10000 then
    raise exception 'Backfill limit must be between 1 and 10000';
  end if;

  for booking_row in
    select * from public.bookings order by created_at, ref limit p_limit
  loop
    if public.dispatch_booking_to_larohq('BACKFILL', to_jsonb(booking_row)) is not null then
      queued := queued + 1;
    end if;
  end loop;

  return queued;
end;
$$;

revoke all on function public.larohq_safe_booking_payload(jsonb) from public, anon, authenticated;
revoke all on function public.dispatch_booking_to_larohq(text, jsonb, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.notify_larohq_booking_change() from public, anon, authenticated;
revoke all on function public.backfill_bookings_to_larohq(integer) from public, anon, authenticated;

grant execute on function public.backfill_bookings_to_larohq(integer) to service_role;

comment on function public.dispatch_booking_to_larohq(text, jsonb, jsonb, uuid) is
  'Queues a signed, privacy-minimized Korte DOS booking event for LaroHQ through pg_net.';

notify pgrst, 'reload schema';
