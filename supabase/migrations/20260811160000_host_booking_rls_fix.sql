-- Hosts reserve courts from the public booking page while retaining their
-- authenticated identity and host payment terms. Give an active host SELECT
-- visibility only to their own host-booking rows. PostgreSQL needs this
-- visibility both to target the subsequent UPDATE and when a client requests
-- an INSERT/UPDATE representation; no other customer's data is exposed.

drop policy if exists bookings_select_host_own on public.bookings;
create policy bookings_select_host_own
  on public.bookings
  for select
  to authenticated
  using (
    public.current_account_role() = 'host'
    and coalesce(host_booking, false) = true
    and host_user_id = auth.uid()
    and created_via = 'host'
    and created_by_user_id = auth.uid()
    and created_by_role = 'host'
  );

comment on policy bookings_select_host_own on public.bookings is
  'Allows an active host to read and update only booking rows owned by that host.';
