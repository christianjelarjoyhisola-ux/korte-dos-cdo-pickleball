-- PostgreSQL treats an unqualified PL/pgSQL variable that shares a table
-- column name as ambiguous. Use an unmistakable local name in both manual
-- settlement functions. A restoration may close an unsubmitted online
-- attempt, while submitted evidence still requires Payment Review.

create or replace function public.mark_host_booking_group_fully_paid(
  p_booking_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_ref text := nullif(btrim(coalesce(p_booking_ref, '')), '');
  actor_id uuid := auth.uid();
  actor_role text;
  primary_ref text;
  group_ref text;
  v_booking_refs text[];
  booking_count integer;
  eligible_count integer;
  unpaid_count integer;
  existing_paid_at timestamptz;
  paid_time timestamptz := clock_timestamp();
begin
  if requested_ref is null then
    raise exception using errcode = '22023', message = 'A booking reference is required.';
  end if;

  select account.role into actor_role
  from public.accounts account
  where account.id = actor_id and account.status = 'active'
  limit 1;

  if actor_id is null or actor_role not in ('owner', 'court_owner', 'staff') then
    raise exception using errcode = '42501', message = 'This account cannot record booking payments.';
  end if;

  select booking.ref, nullif(btrim(booking.booking_group_ref), '')
    into primary_ref, group_ref
  from public.bookings booking
  where booking.ref = requested_ref or booking.booking_group_ref = requested_ref
  order by case when booking.ref = requested_ref then 0 else 1 end,
           booking.created_at, booking.ref
  limit 1;

  if primary_ref is null then
    raise exception using errcode = 'P0002', message = 'Booking or booking group was not found.';
  end if;

  perform payment.id
  from public.host_booking_balance_payments payment
  where payment.booking_key = coalesce(group_ref, primary_ref)
     or payment.booking_ref = primary_ref
     or primary_ref = any(payment.booking_refs)
  order by payment.id
  for update;

  perform booking.ref
  from public.bookings booking
  where (group_ref is not null and booking.booking_group_ref = group_ref)
     or (group_ref is null and booking.ref = primary_ref)
  order by booking.ref
  for update;

  select array_agg(booking.ref order by booking.ref), count(*)::integer,
         count(*) filter (
           where coalesce(booking.host_booking, false)
             and booking.status = 'confirmed'
             and booking.payment_status in ('downpayment_paid', 'paid')
             and booking.total is not null
         )::integer,
         count(*) filter (where booking.payment_status = 'downpayment_paid')::integer,
         min(booking.paid_at)
    into v_booking_refs, booking_count, eligible_count, unpaid_count, existing_paid_at
  from public.bookings booking
  where (group_ref is not null and booking.booking_group_ref = group_ref)
     or (group_ref is null and booking.ref = primary_ref);

  if booking_count = 0 or eligible_count <> booking_count then
    raise exception using errcode = 'P0001',
      message = 'Every row must be an active confirmed host booking before it can be marked fully paid.';
  end if;

  if exists (
    select 1
    from public.host_booking_balance_payments payment
    where (
      payment.booking_key = coalesce(group_ref, primary_ref)
      or payment.booking_ref = any(v_booking_refs)
      or payment.booking_refs && v_booking_refs
    )
      and payment.status = 'pending_review'
  ) then
    raise exception using errcode = 'P0001',
      message = 'A submitted balance receipt is awaiting Payment Review and must be resolved first.';
  end if;

  update public.host_booking_balance_payments payment
     set status = 'expired',
         review_reason = 'Closed because an authorized account recorded manual full payment.',
         updated_at = paid_time
   where (
      payment.booking_key = coalesce(group_ref, primary_ref)
      or payment.booking_ref = any(v_booking_refs)
      or payment.booking_refs && v_booking_refs
   )
     and payment.status = 'created';

  if unpaid_count = 0 then
    return jsonb_build_object(
      'status', 'confirmed', 'paymentStatus', 'paid',
      'paidAt', existing_paid_at, 'refs', to_jsonb(v_booking_refs)
    );
  end if;

  update public.bookings booking
     set payment_status = 'paid',
         downpayment = booking.total,
         paid_at = coalesce(booking.paid_at, paid_time)
   where booking.ref = any(v_booking_refs);

  insert into public.payment_review_decisions (
    receipt_verification_id, booking_ref, booking_group_ref, decision,
    actor_user_id, actor_role, reason, prior_receipt_status, prior_receipt_flags
  ) values (
    null, primary_ref, group_ref, 'approve', actor_id, actor_role,
    'Host booking manually marked fully paid after the complete balance was received outside the online receipt flow.',
    'manual_review', array['MANUAL_FULL_PAYMENT']::text[]
  );

  return jsonb_build_object(
    'status', 'confirmed', 'paymentStatus', 'paid',
    'paidAt', paid_time, 'refs', to_jsonb(v_booking_refs)
  );
end;
$$;

revoke all on function public.mark_host_booking_group_fully_paid(text)
  from public, anon, authenticated;
grant execute on function public.mark_host_booking_group_fully_paid(text)
  to authenticated;

create or replace function public.restore_forfeited_host_booking_as_fully_paid(
  p_booking_ref text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_ref text := nullif(btrim(coalesce(p_booking_ref, '')), '');
  clean_reason text := nullif(left(btrim(coalesce(p_reason, '')), 1000), '');
  actor_id uuid := auth.uid();
  actor_role text;
  primary_ref text;
  group_ref text;
  v_booking_refs text[];
  booking_count integer;
  forfeited_count integer;
  earliest_start timestamptz;
  prior_forfeiture text;
  paid_time timestamptz := clock_timestamp();
begin
  if requested_ref is null then
    raise exception using errcode = '22023', message = 'A booking reference is required.';
  end if;
  if clean_reason is null or length(clean_reason) < 10 then
    raise exception using errcode = '22023', message = 'Enter a correction reason of at least 10 characters.';
  end if;

  select account.role into actor_role
  from public.accounts account
  where account.id = actor_id and account.status = 'active'
  limit 1;

  if actor_id is null or actor_role not in ('owner', 'court_owner') then
    raise exception using errcode = '42501', message = 'Only an owner can restore a forfeited booking.';
  end if;

  lock table public.bookings in share row exclusive mode;

  select booking.ref, nullif(btrim(booking.booking_group_ref), '')
    into primary_ref, group_ref
  from public.bookings booking
  where booking.ref = requested_ref or booking.booking_group_ref = requested_ref
  order by case when booking.ref = requested_ref then 0 else 1 end,
           booking.created_at, booking.ref
  limit 1;

  if primary_ref is null then
    raise exception using errcode = 'P0002', message = 'Booking or booking group was not found.';
  end if;

  perform booking.ref
  from public.bookings booking
  where (group_ref is not null and booking.booking_group_ref = group_ref)
     or (group_ref is null and booking.ref = primary_ref)
  order by booking.ref
  for update;

  select array_agg(booking.ref order by booking.ref), count(*)::integer,
         count(*) filter (
           where coalesce(booking.host_booking, false)
             and booking.status = 'forfeited'
             and booking.payment_status = 'deposit_retained'
         )::integer,
         min(public.booking_start_at_ph(booking.date, booking.start_time, booking.slots)),
         string_agg(
           format('%s forfeited_at=%s reason=%s', booking.ref, booking.forfeited_at,
                  coalesce(booking.forfeiture_reason, '')),
           '; ' order by booking.ref
         )
    into v_booking_refs, booking_count, forfeited_count, earliest_start, prior_forfeiture
  from public.bookings booking
  where (group_ref is not null and booking.booking_group_ref = group_ref)
     or (group_ref is null and booking.ref = primary_ref);

  if booking_count = 0 or forfeited_count <> booking_count then
    raise exception using errcode = 'P0001',
      message = 'Every row must still be forfeited with its deposit retained.';
  end if;
  if earliest_start is null or earliest_start <= now() then
    raise exception using errcode = 'P0001', message = 'This booking has already started or elapsed.';
  end if;

  perform payment.id
  from public.host_booking_balance_payments payment
  where payment.booking_key = coalesce(group_ref, primary_ref)
     or payment.booking_ref = any(v_booking_refs)
     or payment.booking_refs && v_booking_refs
  order by payment.id
  for update;

  if exists (
    select 1
    from public.host_booking_balance_payments payment
    where (
      payment.booking_key = coalesce(group_ref, primary_ref)
      or payment.booking_ref = any(v_booking_refs)
      or payment.booking_refs && v_booking_refs
    )
      and payment.status = 'pending_review'
  ) then
    raise exception using errcode = 'P0001',
      message = 'A submitted balance receipt is awaiting Payment Review and must be resolved first.';
  end if;

  if exists (
    select 1
    from public.bookings target
    join public.bookings occupied
      on occupied.court_id = target.court_id
     and occupied.date = target.date
     and occupied.ref <> all(v_booking_refs)
     and occupied.status not in ('cancelled', 'forfeited')
     and occupied.slots && target.slots
     and (occupied.status <> 'verifying' or occupied.created_at is null
          or occupied.created_at > now() - interval '15 minutes')
    where target.ref = any(v_booking_refs)
  ) then
    raise exception using errcode = 'P0001',
      message = 'This booking cannot be restored because one or more slots were booked again.';
  end if;

  update public.host_booking_balance_payments payment
     set status = 'expired',
         review_reason = 'Closed because an owner restored the booking as manually fully paid.',
         updated_at = paid_time
   where (
      payment.booking_key = coalesce(group_ref, primary_ref)
      or payment.booking_ref = any(v_booking_refs)
      or payment.booking_refs && v_booking_refs
   )
     and payment.status = 'created';

  update public.bookings booking
     set status = 'confirmed',
         payment_status = 'paid',
         downpayment = booking.total,
         paid_at = coalesce(booking.paid_at, paid_time),
         forfeited_at = null,
         forfeiture_reason = null
   where booking.ref = any(v_booking_refs);

  insert into public.payment_review_decisions (
    receipt_verification_id, booking_ref, booking_group_ref, decision,
    actor_user_id, actor_role, reason, prior_receipt_status, prior_receipt_flags
  ) values (
    null, primary_ref, group_ref, 'approve', actor_id, actor_role,
    'Forfeiture corrected as fully paid: ' || clean_reason
      || '. Prior forfeiture state: ' || coalesce(prior_forfeiture, 'not recorded'),
    'manual_review', array['FORFEITURE_CORRECTION', 'MANUAL_FULL_PAYMENT']::text[]
  );

  return jsonb_build_object(
    'status', 'confirmed', 'paymentStatus', 'paid',
    'paidAt', paid_time, 'refs', to_jsonb(v_booking_refs)
  );
end;
$$;

revoke all on function public.restore_forfeited_host_booking_as_fully_paid(text, text)
  from public, anon, authenticated;
grant execute on function public.restore_forfeited_host_booking_as_fully_paid(text, text)
  to authenticated;
