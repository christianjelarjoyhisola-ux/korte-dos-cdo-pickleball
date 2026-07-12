-- Host portal self-service signup.
-- Pending hosts can submit applications, but they do not receive dashboard
-- permissions until the owner approves/activates the account.

alter table public.accounts
  add column if not exists status text not null default 'active';

alter table public.accounts
  drop constraint if exists accounts_status_check;

alter table public.accounts
  add constraint accounts_status_check
  check (status in ('active', 'pending', 'suspended'));

update public.accounts
set status = 'active'
where status is null;

alter table public.open_play_host_applications
  add column if not exists host_user_id uuid,
  add column if not exists gcash_number text,
  add column if not exists valid_id_file_name text,
  add column if not exists valid_id_file_type text,
  add column if not exists valid_id_file_size bigint,
  add column if not exists valid_id_path text;

create index if not exists idx_open_play_host_applications_host_user
  on public.open_play_host_applications(host_user_id);

alter table public.bookings
  add column if not exists host_booking boolean not null default false,
  add column if not exists host_user_id uuid,
  add column if not exists host_name text,
  add column if not exists host_email text;

create index if not exists idx_bookings_host_booking
  on public.bookings(host_booking, host_user_id, date);

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
    and coalesce(a.status, 'active') = 'active'
  limit 1
$$;

drop policy if exists open_play_host_applications_owner_all on public.open_play_host_applications;
create policy open_play_host_applications_owner_all
  on public.open_play_host_applications
  for all
  to authenticated
  using (public.has_account_role(array['owner','court_owner']))
  with check (public.has_account_role(array['owner','court_owner']));

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
