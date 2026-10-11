begin;

-- Browser roles never read device endpoints, keys, delivery state or VAPID keys.
create table if not exists public.admin_notification_targets (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('push', 'email')),
  target_key text not null unique,
  user_id uuid references auth.users(id) on delete cascade,
  subscription jsonb,
  last_keys text[] not null default '{}',
  last_recipient text,
  last_sent_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  lease_id uuid,
  delivery_id uuid,
  last_test_at timestamptz,
  created_at timestamptz not null default now(),
  check (channel <> 'push' or (user_id is not null and subscription is not null))
);
alter table public.admin_notification_targets enable row level security;
revoke all on public.admin_notification_targets from public, anon, authenticated;
grant all on public.admin_notification_targets to service_role;
insert into public.admin_notification_targets(channel, target_key)
values ('email', 'payment-review-email-reminder') on conflict (target_key) do nothing;

-- Read current reviewable receipts, not upload holds or historical outbox rows.
create or replace function public.pending_admin_review_keys()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(k order by k), '{}'::text[]) from (
    select distinct 'b:' || coalesce(nullif(booking_group_ref, ''), ref) || ':' || coalesce(receipt_image_hash, '') as k
    from public.bookings
    where status not in ('cancelled', 'forfeited')
      and payment_status not in ('paid', 'downpayment_paid', 'rejected')
      and coalesce(receipt_status, 'none') <> 'auto_approved'
      and payment_method in ('gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb')
      and nullif(btrim(receipt_image_url), '') is not null
      and coalesce(email, '') <> 'reserve@hold.internal'
    union
    select 'o:' || id::text || ':' || coalesce(receipt_image_hash, '')
    from public.open_play_registrations
    where payment_status not in ('paid', 'rejected')
      and coalesce(receipt_status, 'none') <> 'auto_approved'
      and payment_method in ('gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb')
      and nullif(btrim(receipt_image_url), '') is not null
    union
    select 'h:' || id::text || ':' || coalesce(receipt_image_hash, '')
    from public.open_play_host_session_registrations
    where payment_status not in ('paid', 'rejected')
      and coalesce(receipt_status, 'none') <> 'auto_approved'
      and payment_method in ('gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb')
      and nullif(btrim(receipt_image_url), '') is not null
  ) reviews;
$$;
revoke all on function public.pending_admin_review_keys() from public, anon, authenticated;
grant execute on function public.pending_admin_review_keys() to service_role;

create or replace function public.claim_admin_notification_targets()
returns setof jsonb language plpgsql security definer set search_path = public as $$
declare
  pending_keys text[] := public.pending_admin_review_keys();
  recipient text := (select value from private_settings where key = 'payment_review_notification_email');
begin
  if cardinality(pending_keys) = 0 then
    -- A new queue after an empty queue should generate a fresh alert.
    update admin_notification_targets set last_keys = '{}', delivery_id = null
    where cardinality(last_keys) > 0 and (lease_until is null or lease_until < now());
    return;
  end if;
  return query
  with due as (
    select t.id from admin_notification_targets t
    where t.next_attempt_at <= now() and (t.lease_until is null or t.lease_until < now())
      and (
        (t.channel = 'push' and exists (
          select 1 from accounts a where a.id = t.user_id
            and a.status = 'active' and a.role in ('owner', 'court_owner')
        ) and (not pending_keys <@ t.last_keys or t.last_sent_at is null or t.last_sent_at <= now() - interval '1 hour'))
        or (t.channel = 'email' and nullif(btrim(recipient), '') is not null
          and coalesce(t.last_sent_at, t.created_at) <= now() - interval '1 hour')
      )
    order by t.next_attempt_at limit 25 for update skip locked
  ), claimed as (
    update admin_notification_targets t
    set lease_until = now() + interval '5 minutes', lease_id = gen_random_uuid(),
        delivery_id = coalesce(t.delivery_id, gen_random_uuid())
    from due where t.id = due.id returning t.*
  )
  select to_jsonb(c) || jsonb_build_object('pending_keys', pending_keys, 'recipient', recipient)
  from claimed c;
end;
$$;
revoke all on function public.claim_admin_notification_targets() from public, anon, authenticated;
grant execute on function public.claim_admin_notification_targets() to service_role;

do $$
begin
  if has_table_privilege('anon', 'public.admin_notification_targets', 'SELECT')
     or has_table_privilege('authenticated', 'public.admin_notification_targets', 'SELECT')
     or has_function_privilege('authenticated', 'public.claim_admin_notification_targets()', 'EXECUTE')
     or has_function_privilege('anon', 'public.pending_admin_review_keys()', 'EXECUTE') then
    raise exception 'Notification data must be service-only';
  end if;
  perform public.pending_admin_review_keys();
end;
$$;

select cron.schedule('process-admin-device-notifications', '* * * * *', $job$
  select net.http_post(
    url := 'https://zcuufcpkgidmaanxjufo.supabase.co/functions/v1/manage-device-notifications',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'X-Payment-Review-Worker-Secret', (select value from public.private_settings where key = 'payment_review_notification_worker_secret')),
    body := '{"action":"process"}'::jsonb, timeout_milliseconds := 55000
  );
$job$);
insert into supabase_migrations.schema_migrations(version, name, statements)
values ('20261011090000', 'admin_device_notifications', array['admin notification subscriptions and hourly reminders'])
on conflict (version) do nothing;
notify pgrst, 'reload schema';
commit;
