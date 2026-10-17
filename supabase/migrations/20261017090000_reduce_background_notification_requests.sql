begin;

-- Delivery claims stay private. Reuse the delivery key across retries so a
-- provider acceptance followed by a lost DB response does not send twice.
alter table public.booking_balance_notifications
  add column if not exists delivery_id uuid;

create or replace function public.claim_host_balance_notification(
  p_booking_key text, p_booking_ref text, p_event_type text,
  p_recipient_email text, p_force boolean default false
)
returns table (id uuid, attempt_count integer, delivery_id uuid)
language sql security definer set search_path = '' as $$
  insert into public.booking_balance_notifications as notice (
    booking_key, booking_ref, event_type, recipient_email, status,
    attempt_count, last_attempt_at, error_message, delivery_id
  ) values (
    p_booking_key, p_booking_ref, p_event_type, p_recipient_email, 'pending',
    1, clock_timestamp(), null, gen_random_uuid()
  )
  on conflict (booking_key, event_type) do update
  set booking_ref = excluded.booking_ref,
      recipient_email = excluded.recipient_email,
      status = 'pending', attempt_count = notice.attempt_count + 1,
      last_attempt_at = clock_timestamp(), error_message = null,
      delivery_id = case when p_force then gen_random_uuid()
        else coalesce(notice.delivery_id, gen_random_uuid()) end
  where (p_force or notice.status <> 'sent')
    and not (notice.status = 'pending' and notice.last_attempt_at is not null
      and notice.last_attempt_at > clock_timestamp() - interval '10 minutes')
  returning notice.id, notice.attempt_count, notice.delivery_id;
$$;
revoke all on function public.claim_host_balance_notification(text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.claim_host_balance_notification(text, text, text, text, boolean) to service_role;

-- One bounded server-side read replaces downloading every past forfeiture and
-- checking its notice separately. Financial mutation still uses the existing
-- authoritative RPC, including its locks and submitted-receipt safeguards.
create or replace function public.due_host_balance_notification_groups(p_limit integer default 100)
returns table (booking_key text, event_type text, needs_forfeiture boolean, bookings jsonb)
language sql stable security definer set search_path = '' as $$
  with grouped as (
    select coalesce(nullif(btrim(b.booking_group_ref), ''), b.ref) as booking_key,
      b.status, min(b.balance_due_at) as deadline,
      sum(coalesce(b.total, 0) - coalesce(b.downpayment, 0)) as balance,
      (array_agg(coalesce(nullif(b.host_email, ''), b.email) order by b.ref))[1] as recipient
    from public.bookings b
    where b.host_booking = true and b.balance_due_at is not null
      and ((b.status = 'confirmed' and b.payment_status = 'downpayment_paid')
        or (b.status = 'forfeited' and b.payment_status = 'deposit_retained'))
    group by coalesce(nullif(btrim(b.booking_group_ref), ''), b.ref), b.status
  ), candidates as (
    select g.*,
      (g.status = 'confirmed' and g.deadline <= now()) as needs_forfeiture,
      case when g.status = 'forfeited' or g.deadline <= now() then 'forfeited'
        when g.deadline <= now() + interval '1 day' then 'reminder_1d'
        when g.deadline <= now() + interval '2 days' then 'reminder_2d'
        else 'reminder_3d' end as event_type
    from grouped g
    where g.status = 'forfeited' or g.deadline <= now() + interval '3 days'
  ), due as (
    select c.* from candidates c
    where (
      c.needs_forfeiture
      and not exists (
        select 1 from public.bookings inconsistent
        where (inconsistent.ref = c.booking_key or inconsistent.booking_group_ref = c.booking_key)
          and (not coalesce(inconsistent.host_booking, false)
            or inconsistent.status <> 'confirmed' or inconsistent.payment_status <> 'downpayment_paid')
      )
      and not exists (
        select 1 from public.host_booking_balance_payments pending
        where pending.booking_key = c.booking_key and pending.status = 'pending_review'
          and pending.submitted_at is not null and pending.submitted_at <= pending.balance_due_at
      )
    ) or (
      not c.needs_forfeiture and c.balance > 0 and nullif(btrim(c.recipient), '') is not null
      and not exists (
        select 1 from public.booking_balance_notifications n
        where n.booking_key = c.booking_key and n.event_type = c.event_type
          and (n.status = 'sent' or (n.status = 'pending' and n.last_attempt_at > now() - interval '10 minutes'))
      )
    )
    -- Financial deadlines take precedence. Among notices, advance retries by
    -- their last attempt so old failures cannot monopolize every bounded run.
    order by c.needs_forfeiture desc,
      coalesce((select n.last_attempt_at from public.booking_balance_notifications n
        where n.booking_key = c.booking_key and n.event_type = c.event_type), '-infinity'::timestamptz),
      c.deadline, c.booking_key
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  )
  select d.booking_key, d.event_type, d.needs_forfeiture,
    (select jsonb_agg(jsonb_build_object(
      'ref', b.ref, 'booking_group_ref', b.booking_group_ref, 'full_name', b.full_name,
      'email', b.email, 'host_name', b.host_name, 'host_email', b.host_email,
      'court_name', b.court_name, 'date', b.date, 'start_time', b.start_time, 'end_time', b.end_time,
      'total', b.total, 'downpayment', b.downpayment, 'balance_due_at', b.balance_due_at,
      'status', b.status, 'payment_status', b.payment_status
    ) order by b.ref)
    from public.bookings b
    where coalesce(nullif(btrim(b.booking_group_ref), ''), b.ref) = d.booking_key
      and b.host_booking = true and b.balance_due_at is not null and b.status = d.status
      and b.payment_status = case when d.status = 'confirmed' then 'downpayment_paid' else 'deposit_retained' end)
  from due d;
$$;
revoke all on function public.due_host_balance_notification_groups(integer) from public, anon, authenticated;
grant execute on function public.due_host_balance_notification_groups(integer) to service_role;

-- Match claim_due_payment_review_notifications' retry/lease predicates. This
-- does not claim anything: the Edge worker remains the atomic claim owner.
create or replace function public.payment_review_notification_work_due()
returns boolean language sql volatile security definer set search_path = '' as $$
  select exists (select 1 from public.private_settings
    where key = 'payment_review_notification_email' and nullif(btrim(value), '') is not null)
  and exists (
    select 1 from public.payment_review_notifications notification
    where (notification.status in ('pending', 'failed')
      and coalesce(notification.next_attempt_at, notification.created_at) <= clock_timestamp())
    or (notification.status = 'sending' and (notification.last_attempt_at is null
      or notification.last_attempt_at <= clock_timestamp() - interval '10 minutes'))
  );
$$;
revoke all on function public.payment_review_notification_work_due() from public, anon, authenticated;
grant execute on function public.payment_review_notification_work_due() to service_role;

create or replace function public.admin_notification_work_due()
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  pending_keys text[] := public.pending_admin_review_keys();
  recipient text := (select value from public.private_settings where key = 'payment_review_notification_email');
begin
  if cardinality(pending_keys) = 0 then
    -- Keep the empty-queue transition even when no Edge function is invoked.
    -- Leased deliveries are left alone; the next cron pass clears them after
    -- their worker finishes or its lease expires, exactly as the claim RPC did.
    update public.admin_notification_targets set last_keys = '{}', delivery_id = null
    where cardinality(last_keys) > 0 and (lease_until is null or lease_until < now());
    return false;
  end if;
  return exists (
    select 1 from public.admin_notification_targets t
    where t.next_attempt_at <= now() and (t.lease_until is null or t.lease_until < now())
      and (
        (t.channel = 'push' and exists (
          select 1 from public.accounts a where a.id = t.user_id
            and a.status = 'active' and a.role in ('owner', 'court_owner')
        ) and (not pending_keys <@ t.last_keys or t.last_sent_at is null or t.last_sent_at <= now() - interval '1 hour'))
        or (t.channel = 'email' and nullif(btrim(recipient), '') is not null
          and coalesce(t.last_sent_at, t.created_at) <= now() - interval '1 hour')
      )
  );
end;
$$;
revoke all on function public.admin_notification_work_due() from public, anon, authenticated;
grant execute on function public.admin_notification_work_due() to service_role;

-- The named schedules keep their existing cadence. Only real work generates
-- an HTTP request (and its gateway, invocation, and service logs).
create or replace function public.dispatch_due_notification_worker(p_worker text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  worker_path text;
  payload jsonb;
  request_timeout integer := 5000;
  worker_secret text;
begin
  case p_worker
    when 'payment-review' then
      if not public.payment_review_notification_work_due() then return null; end if;
      worker_path := 'process-payment-review-notifications';
      payload := '{"source":"database-cron","batchSize":5}'::jsonb;
    when 'admin-device' then
      if not public.admin_notification_work_due() then return null; end if;
      worker_path := 'manage-device-notifications';
      payload := '{"action":"process"}'::jsonb;
      request_timeout := 55000;
    when 'host-balance' then
      if not exists (select 1 from public.due_host_balance_notification_groups(1)) then return null; end if;
      worker_path := 'process-host-balance-deadlines';
      payload := '{"source":"database-cron"}'::jsonb;
    else raise exception 'Unknown notification worker' using errcode = '22023';
  end case;
  select value into worker_secret from public.private_settings
    where key = 'payment_review_notification_worker_secret';
  if nullif(worker_secret, '') is null then raise exception 'Notification worker credential is unavailable'; end if;
  return net.http_post(
    url := 'https://zcuufcpkgidmaanxjufo.supabase.co/functions/v1/' || worker_path,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Payment-Review-Worker-Secret', worker_secret),
    body := payload, timeout_milliseconds := request_timeout
  );
end;
$$;
revoke all on function public.dispatch_due_notification_worker(text) from public, anon, authenticated;
grant execute on function public.dispatch_due_notification_worker(text) to service_role;

create or replace function public.configure_due_notification_schedules()
returns void language plpgsql security definer set search_path = '' as $$
declare existing_job bigint;
begin
  for existing_job in select jobid from cron.job where jobname in (
    'process-payment-review-notifications', 'process-admin-device-notifications', 'process-host-balance-deadlines'
  ) loop perform cron.unschedule(existing_job); end loop;
  perform cron.schedule('process-payment-review-notifications', '*/5 * * * *',
    $job$select public.dispatch_due_notification_worker('payment-review');$job$);
  perform cron.schedule('process-admin-device-notifications', '* * * * *',
    $job$select public.dispatch_due_notification_worker('admin-device');$job$);
  perform cron.schedule('process-host-balance-deadlines', '*/15 * * * *',
    $job$select public.dispatch_due_notification_worker('host-balance');$job$);
end;
$$;
revoke all on function public.configure_due_notification_schedules() from public, anon, authenticated;
grant execute on function public.configure_due_notification_schedules() to service_role;
select public.configure_due_notification_schedules();

insert into supabase_migrations.schema_migrations(version, name, statements)
values ('20261017090000', 'reduce_background_notification_requests', array['gate idle notification invocations and retrieve only due host notices'])
on conflict (version) do nothing;
notify pgrst, 'reload schema';
commit;
