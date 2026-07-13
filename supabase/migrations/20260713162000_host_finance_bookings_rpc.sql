-- Load only the selected host's finance bookings instead of downloading the
-- complete booking table. The function is intentionally restricted to active
-- system owners and court owners through has_account_role().

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

revoke all on function public.get_host_finance_bookings(uuid) from public, anon, authenticated;
grant execute on function public.get_host_finance_bookings(uuid) to authenticated;
