-- Give system owners and court owners a limited, read-only host directory for
-- host booking and outstanding-balance views. Keep the accounts table's RLS
-- unchanged so court owners cannot enumerate usernames or mutate accounts.

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

revoke all on function public.get_host_finance_accounts() from public, anon, authenticated;
grant execute on function public.get_host_finance_accounts() to authenticated;
