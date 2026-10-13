-- Let staff move a single-court booking to another court while preserving the
-- paid duration and all payment, receipt, voucher, and billing fields.

begin;

drop function if exists public.reschedule_booking_group(text[], date, integer, integer);

create or replace function public.reschedule_booking_group(
  p_booking_refs text[],
  p_new_date date,
  p_start_hour integer,
  p_duration integer,
  p_new_court_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  clean_refs text[];
  locked_count integer;
  group_ref text;
  group_count integer;
  first_booking public.bookings%rowtype;
  new_slots text[];
  new_start_time text;
  new_end_time text;
  target_court_id text := nullif(btrim(coalesce(p_new_court_id, '')), '');
  target_court_name text;
begin
  if auth.uid() is null
     or public.current_account_role() not in ('owner', 'court_owner', 'staff') then
    raise exception 'You do not have permission to reschedule bookings.' using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct btrim(ref) order by btrim(ref)), '{}'::text[])
    into clean_refs
  from unnest(coalesce(p_booking_refs, '{}'::text[])) supplied(ref)
  where nullif(btrim(ref), '') is not null;

  if cardinality(clean_refs) = 0
     or cardinality(clean_refs) <> cardinality(p_booking_refs) then
    raise exception 'The reservation references are invalid.';
  end if;
  if p_new_date is null or p_start_hour is null or p_duration is null
     or p_duration < 1 or p_duration > 4
     or p_start_hour < 6 or p_start_hour + p_duration > 24 then
    raise exception 'Choose a valid date and time within venue hours.';
  end if;
  if target_court_id is not null and cardinality(clean_refs) <> 1 then
    raise exception 'A different court can only be selected for a single-court booking.';
  end if;

  perform 1
  from public.bookings booking
  where booking.ref = any(clean_refs)
  order by booking.ref
  for update;

  select count(*)::integer into locked_count
  from public.bookings booking
  where booking.ref = any(clean_refs);
  if locked_count <> cardinality(clean_refs) then
    raise exception 'The complete reservation could not be found. Nothing was moved.';
  end if;

  if exists (
    select 1 from public.bookings booking
    where booking.ref = any(clean_refs)
      and lower(coalesce(booking.status, '')) not in ('pending', 'confirmed')
  ) then
    raise exception 'Only pending or confirmed reservations can be rescheduled.';
  end if;

  select booking.* into first_booking
  from public.bookings booking
  where booking.ref = clean_refs[1];
  group_ref := first_booking.booking_group_ref;

  if cardinality(clean_refs) > 1 then
    if group_ref is null then
      raise exception 'These bookings do not belong to one reservation.';
    end if;
    if exists (
      select 1 from public.bookings booking
      where booking.ref = any(clean_refs)
        and booking.booking_group_ref is distinct from group_ref
    ) then
      raise exception 'These bookings do not belong to one reservation.';
    end if;
    select count(*)::integer into group_count
    from public.bookings booking
    where booking.booking_group_ref = group_ref;
    if group_count <> cardinality(clean_refs) then
      raise exception 'The complete reservation must be moved together. Nothing was moved.';
    end if;
    if exists (
      select 1 from public.bookings booking
      where booking.ref = any(clean_refs)
        and (booking.date is distinct from first_booking.date
          or booking.slots is distinct from first_booking.slots
          or booking.start_time is distinct from first_booking.start_time
          or booking.end_time is distinct from first_booking.end_time
          or booking.duration is distinct from first_booking.duration)
    ) then
      raise exception 'This reservation contains different schedules and cannot be flattened into one time.';
    end if;
  end if;

  if target_court_id is not null then
    select court.name into target_court_name
    from public.courts court
    where court.id = target_court_id and not court.blocked;
    if target_court_name is null then
      raise exception 'The selected court is unavailable.';
    end if;
  end if;

  select array_agg(hour_value::text order by hour_value)
    into new_slots
  from generate_series(p_start_hour, p_start_hour + p_duration - 1) hour_value;
  new_start_time := to_char(make_time(p_start_hour, 0, 0), 'FMHH12:MI AM');
  new_end_time := case when p_start_hour + p_duration = 24
    then '12:00 AM'
    else to_char(make_time(p_start_hour + p_duration, 0, 0), 'FMHH12:MI AM')
  end;

  if exists (
    select 1
    from public.bookings moving
    join public.bookings occupied
      on occupied.ref <> all(clean_refs)
     and occupied.court_id = case
       when target_court_id is not null then target_court_id
       else moving.court_id
     end
     and occupied.date = p_new_date
     and lower(coalesce(occupied.status, '')) not in ('cancelled', 'forfeited')
     and occupied.slots && new_slots
    where moving.ref = any(clean_refs)
  ) then
    raise exception 'One or more time slots are already booked for the selected court and date.';
  end if;

  update public.bookings booking
     set date = p_new_date,
         slots = new_slots,
         start_time = new_start_time,
         end_time = new_end_time,
         duration = p_duration,
         court_id = case when target_court_id is not null then target_court_id else booking.court_id end,
         court_name = case when target_court_id is not null then target_court_name else booking.court_name end
   where booking.ref = any(clean_refs);

  return jsonb_build_object(
    'ok', true,
    'bookingRefs', to_jsonb(clean_refs),
    'bookingCount', cardinality(clean_refs),
    'date', p_new_date,
    'startTime', new_start_time,
    'endTime', new_end_time,
    'courtId', coalesce(target_court_id, first_booking.court_id),
    'courtName', coalesce(target_court_name, first_booking.court_name)
  );
end;
$$;

revoke all on function public.reschedule_booking_group(text[], date, integer, integer, text) from public;
revoke all on function public.reschedule_booking_group(text[], date, integer, integer, text) from anon;
grant execute on function public.reschedule_booking_group(text[], date, integer, integer, text) to authenticated;

comment on function public.reschedule_booking_group(text[], date, integer, integer, text)
  is 'Atomically moves a reservation to an available time slot and optionally changes the court for a single-court booking without changing financial fields.';

commit;
