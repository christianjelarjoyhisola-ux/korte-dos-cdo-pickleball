-- Add MariBank / InstaPay-to-GCash as a supported payment method.

insert into public.settings (key, value)
values
  ('payment_method_maribank', '1'),
  ('gcash_qr_account_id', 'DWQM4TK496R3UA1BS')
on conflict (key) do nothing;

alter table if exists public.open_play_host_session_registrations
  drop constraint if exists open_play_host_session_registrations_payment_method_check;

alter table if exists public.open_play_host_session_registrations
  add constraint open_play_host_session_registrations_payment_method_check
  check (payment_method in ('gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb', 'cash'));

update public.bookings
set received_account = 'gcash'
where lower(coalesce(payment_method, '')) = 'maribank'
  and (
    received_account is null
    or btrim(received_account) = ''
    or lower(btrim(received_account)) = 'maribank'
  );
