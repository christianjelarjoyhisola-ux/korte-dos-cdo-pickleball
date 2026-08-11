-- Return only the authenticated host's own booking history.
-- This keeps the public booking page outside the general private-data surface.

create or replace function public.get_my_host_bookings()
returns setof public.bookings
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := auth.uid();
begin
  if caller_id is null then
    raise exception 'Authentication is required to load host bookings.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.accounts a
    where a.id = caller_id
      and a.role = 'host'
      and coalesce(a.status, 'active') = 'active'
  ) then
    raise exception 'An active host account is required to load host bookings.'
      using errcode = '42501';
  end if;

  return query
  select b.*
  from public.bookings b
  where coalesce(b.host_booking, false) = true
    and b.host_user_id = caller_id
    and coalesce(b.email, '') <> 'reserve@hold.internal'
  order by b.created_at desc, b.ref;
end;
$$;

revoke all on function public.get_my_host_bookings() from public, anon, authenticated;
grant execute on function public.get_my_host_bookings() to authenticated;

comment on function public.get_my_host_bookings() is
  'Returns only non-placeholder host bookings owned by the active authenticated host.';
