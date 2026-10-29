-- Per-court reschedule. Each court entry in a reservation can get its own new
-- date, start time, and court, while keeping its paid number of hours and all
-- payment, receipt, voucher, and billing fields untouched. Every chosen move is
-- checked first and then applied together, so a reservation is never half-moved.
--
-- p_moves: [{ "ref": "PB-123-01", "date": "2026-11-05", "start_hour": 17, "court_id": "c8" }, ...]
-- Court entries of the reservation that are not listed keep their schedule.

begin;

create or replace function public.reschedule_booking_items(p_moves jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  move_count integer;
  clean_refs text[];
  locked_count integer;
  group_count integer;
  group_ref text;
  group_refs text[];
  bad_count integer;
  result jsonb;
begin
  if auth.uid() is null
     or public.current_account_role() not in ('owner', 'court_owner', 'staff') then
    raise exception 'You do not have permission to reschedule bookings.' using errcode = '42501';
  end if;

  if p_moves is null or jsonb_typeof(p_moves) <> 'array'
     or jsonb_array_length(p_moves) = 0 or jsonb_array_length(p_moves) > 50 then
    raise exception 'Choose at least one court to reschedule.';
  end if;

  drop table if exists pg_temp.rs_moves;
  create temp table rs_moves on commit drop as
  select nullif(btrim(m.ref), '') as ref,
         m.date as new_date,
         m.start_hour,
         nullif(btrim(coalesce(m.court_id, '')), '') as court_id
  from jsonb_to_recordset(p_moves) as m(ref text, date date, start_hour integer, court_id text);

  select count(*)::integer, coalesce(array_agg(distinct ref order by ref), '{}'::text[])
    into move_count, clean_refs
  from rs_moves;

  if exists (select 1 from rs_moves where ref is null)
     or cardinality(clean_refs) <> move_count then
    raise exception 'The reservation references are invalid.';
  end if;
  if exists (select 1 from rs_moves where new_date is null or start_hour is null) then
    raise exception 'Choose a new date and time for every court you are moving.';
  end if;

  perform 1 from public.bookings booking
  where booking.ref = any(clean_refs)
  order by booking.ref
  for update;

  select count(*)::integer into locked_count
  from public.bookings booking
  where booking.ref = any(clean_refs);
  if locked_count <> cardinality(clean_refs) then
    raise exception 'The complete reservation could not be found. Nothing was moved.';
  end if;

  select count(distinct coalesce(booking.booking_group_ref, '')), max(booking.booking_group_ref)
    into group_count, group_ref
  from public.bookings booking
  where booking.ref = any(clean_refs);
  if group_count <> 1
     or (group_ref is null and cardinality(clean_refs) > 1)
     or exists (select 1 from public.bookings booking
                where booking.ref = any(clean_refs) and booking.booking_group_ref is null
                  and group_ref is not null) then
    raise exception 'These bookings do not belong to one reservation.';
  end if;

  if group_ref is not null then
    perform 1 from public.bookings booking
    where booking.booking_group_ref = group_ref
    order by booking.ref
    for update;
    select coalesce(array_agg(booking.ref order by booking.ref), '{}'::text[]) into group_refs
    from public.bookings booking
    where booking.booking_group_ref = group_ref;
  else
    group_refs := clean_refs;
  end if;

  if exists (
    select 1 from public.bookings booking
    where booking.ref = any(clean_refs)
      and lower(coalesce(booking.status, '')) not in ('pending', 'confirmed')
  ) then
    raise exception 'Only pending or confirmed reservations can be rescheduled.';
  end if;

  drop table if exists pg_temp.rs_plan;
  create temp table rs_plan on commit drop as
  select booking.ref,
         booking.court_id as old_court_id,
         booking.court_name as old_court_name,
         booking.date as old_date,
         booking.start_time as old_start_time,
         booking.end_time as old_end_time,
         booking.slots as old_slots,
         coalesce(mv.court_id, booking.court_id) as new_court_id,
         mv.new_date,
         mv.start_hour,
         case when cardinality(booking.slots) > 0 then cardinality(booking.slots)
              else round(coalesce(booking.duration, 0))::integer end as hours
  from rs_moves mv
  join public.bookings booking on booking.ref = mv.ref;

  if exists (select 1 from rs_plan where hours < 1 or start_hour < 6 or start_hour + hours > 24) then
    raise exception 'Choose a valid date and time within venue hours.';
  end if;

  alter table rs_plan add column new_slots text[];
  alter table rs_plan add column new_court_name text;
  update rs_plan plan
     set new_slots = (select array_agg(h::text order by h)
                      from generate_series(plan.start_hour, plan.start_hour + plan.hours - 1) h);

  select count(*)::integer into bad_count
  from rs_plan plan
  left join public.courts court on court.id = plan.new_court_id
  where court.id is null
     or (court.blocked and plan.new_court_id is distinct from plan.old_court_id);
  if bad_count > 0 then
    raise exception 'The selected court is unavailable.';
  end if;

  update rs_plan plan
     set new_court_name = case when plan.new_court_id = plan.old_court_id
                               then coalesce(plan.old_court_name, court.name)
                               else court.name end
    from public.courts court
   where court.id = plan.new_court_id;

  -- Clash with any booking outside this reservation.
  if exists (
    select 1
    from rs_plan plan
    join public.bookings occupied
      on occupied.court_id = plan.new_court_id
     and occupied.date = plan.new_date
     and occupied.ref <> all(group_refs)
     and lower(coalesce(occupied.status, '')) not in ('cancelled', 'forfeited')
     and occupied.slots && plan.new_slots
  ) then
    raise exception 'One or more time slots are already booked for the selected court and date.';
  end if;

  -- Clash between court entries of this same reservation after the move.
  if exists (
    with final_state as (
      select booking.ref,
             coalesce(plan.new_court_id, booking.court_id) as court_id,
             coalesce(plan.new_date, booking.date) as date,
             coalesce(plan.new_slots, booking.slots) as slots,
             booking.court_id as orig_court_id,
             booking.date as orig_date,
             booking.slots as orig_slots,
             plan.ref is not null as moved
      from public.bookings booking
      left join rs_plan plan on plan.ref = booking.ref
      where booking.ref = any(group_refs)
        and lower(coalesce(booking.status, '')) not in ('cancelled', 'forfeited')
    )
    select 1
    from final_state a
    join final_state b
      on a.ref < b.ref
     and (a.moved or b.moved)
     and a.court_id = b.court_id
     and a.date = b.date
     and a.slots && b.slots
    where not (a.orig_court_id = b.orig_court_id and a.orig_date = b.orig_date
               and a.orig_slots = b.orig_slots and a.slots = b.slots)
  ) then
    raise exception 'Two courts in this reservation would overlap on the same court and time. Choose different times or courts.';
  end if;

  update public.bookings booking
     set date = plan.new_date,
         slots = plan.new_slots,
         start_time = to_char(make_time(plan.start_hour, 0, 0), 'FMHH12:MI AM'),
         end_time = case when plan.start_hour + plan.hours = 24 then '12:00 AM'
                         else to_char(make_time(plan.start_hour + plan.hours, 0, 0), 'FMHH12:MI AM') end,
         duration = plan.hours,
         court_id = plan.new_court_id,
         court_name = plan.new_court_name
    from rs_plan plan
   where booking.ref = plan.ref;

  select jsonb_build_object(
    'ok', true,
    'bookingCount', count(*),
    'changes', coalesce(jsonb_agg(jsonb_build_object(
      'ref', plan.ref,
      'oldCourtId', plan.old_court_id,
      'oldCourtName', plan.old_court_name,
      'oldDate', plan.old_date,
      'oldStartTime', plan.old_start_time,
      'oldEndTime', plan.old_end_time,
      'newCourtId', booking.court_id,
      'newCourtName', booking.court_name,
      'newDate', booking.date,
      'newStartTime', booking.start_time,
      'newEndTime', booking.end_time,
      'newDuration', plan.hours
    ) order by booking.date, plan.start_hour, booking.court_name), '[]'::jsonb)
  ) into result
  from rs_plan plan
  join public.bookings booking on booking.ref = plan.ref;

  return result;
end;
$$;

revoke all on function public.reschedule_booking_items(jsonb) from public;
revoke all on function public.reschedule_booking_items(jsonb) from anon;
grant execute on function public.reschedule_booking_items(jsonb) to authenticated;

comment on function public.reschedule_booking_items(jsonb)
  is 'Atomically moves chosen court entries of one reservation, each to its own date, start hour, and court, preserving paid hours and every financial field.';

commit;
