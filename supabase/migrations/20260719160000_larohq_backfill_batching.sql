-- Historical replays are deliberately batched so a large venue cannot
-- overwhelm either project's free-tier HTTP worker capacity.

drop function if exists public.backfill_bookings_to_larohq(integer);

create or replace function public.backfill_bookings_to_larohq(
  p_limit integer default 25,
  p_offset integer default 0
)
returns integer
language plpgsql
security definer
set search_path = public, extensions, vault, pg_temp
as $$
declare
  booking_row public.bookings%rowtype;
  queued integer := 0;
begin
  if p_limit < 1 or p_limit > 100 then
    raise exception 'Backfill batch size must be between 1 and 100';
  end if;
  if p_offset < 0 then
    raise exception 'Backfill offset cannot be negative';
  end if;

  for booking_row in
    select *
      from public.bookings
     order by created_at, ref
     limit p_limit
    offset p_offset
  loop
    if public.dispatch_booking_to_larohq('BACKFILL', to_jsonb(booking_row)) is not null then
      queued := queued + 1;
    end if;
  end loop;

  return queued;
end;
$$;

revoke all on function public.backfill_bookings_to_larohq(integer, integer) from public, anon, authenticated;
grant execute on function public.backfill_bookings_to_larohq(integer, integer) to service_role;

comment on function public.backfill_bookings_to_larohq(integer, integer) is
  'Queues one bounded, offset-based batch of privacy-minimized booking events for LaroHQ.';

notify pgrst, 'reload schema';
