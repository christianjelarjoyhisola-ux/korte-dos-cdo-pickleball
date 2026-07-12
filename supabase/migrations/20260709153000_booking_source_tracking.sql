-- Track whether a booking was created by the public customer flow,
-- an admin/court-owner acting for a customer, a host, or a system import.

alter table public.bookings
  add column if not exists created_via text not null default 'customer',
  add column if not exists created_by_user_id uuid,
  add column if not exists created_by_role text,
  add column if not exists created_by_name text,
  add column if not exists created_by_email text;

update public.bookings
set created_via = coalesce(created_via, 'customer')
where created_via is null;

alter table public.bookings
  drop constraint if exists bookings_created_via_check;

alter table public.bookings
  add constraint bookings_created_via_check
  check (created_via in ('customer', 'admin', 'host', 'import', 'system'));

create index if not exists idx_bookings_created_via
  on public.bookings(created_via);

create index if not exists idx_bookings_created_by_user_id
  on public.bookings(created_by_user_id);
