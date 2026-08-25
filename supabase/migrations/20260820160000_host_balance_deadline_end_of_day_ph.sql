-- Host balances are due at the end of the fifth Philippine calendar day
-- before the earliest booked date. Customer-facing code displays this as
-- 11:59 PM; the database keeps microsecond precision so the entire day is open.

create or replace function public.host_balance_deadline_at_ph(
  p_booking_date date
)
returns timestamptz
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  select ((p_booking_date - 5) + time '23:59:59.999999')
    at time zone 'Asia/Manila';
$$;

create or replace function public.set_host_balance_deadline()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if coalesce(new.host_booking, false) then
    new.balance_due_at := public.host_balance_deadline_at_ph(new.date);
  else
    new.balance_due_at := null;
  end if;
  return new;
end;
$$;

-- Correct every current or future host reservation, including a reservation
-- whose old exact-time deadline elapsed earlier today.
update public.bookings booking
   set balance_due_at = public.host_balance_deadline_at_ph(booking.date)
 where coalesce(booking.host_booking, false)
   and booking.date >= (clock_timestamp() at time zone 'Asia/Manila')::date
   and booking.balance_due_at is distinct from
       public.host_balance_deadline_at_ph(booking.date);

-- Keep already-created payment attempts aligned with their authoritative
-- booking deadline. A created attempt that expired only because of the old
-- same-day cutoff receives a fresh 15-minute upload window.
with current_deadlines as (
  select payment.id, min(booking.balance_due_at) as balance_due_at
  from public.host_booking_balance_payments payment
  join public.bookings booking
    on booking.ref = any(payment.booking_refs)
  where payment.status in ('created', 'pending_review')
  group by payment.id
)
update public.host_booking_balance_payments payment
   set balance_due_at = current_deadlines.balance_due_at,
       expires_at = case
         when payment.status = 'created'
          and payment.expires_at <= clock_timestamp()
          and current_deadlines.balance_due_at > clock_timestamp()
         then least(current_deadlines.balance_due_at, clock_timestamp() + interval '15 minutes')
         else payment.expires_at
       end
  from current_deadlines
 where payment.id = current_deadlines.id
   and current_deadlines.balance_due_at is not null
   and (
     payment.balance_due_at is distinct from current_deadlines.balance_due_at
     or (
       payment.status = 'created'
       and payment.expires_at <= clock_timestamp()
       and current_deadlines.balance_due_at > clock_timestamp()
     )
   );

comment on function public.host_balance_deadline_at_ph(date) is
  'Returns 11:59:59.999999 PM Asia/Manila on the fifth calendar day before a host booking date.';

-- Owners may settle an active host balance received outside the online flow
-- (for example, cash). Unsubmitted online attempts are closed atomically;
-- submitted receipts still require Payment Review so evidence is never lost.
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
  booking_refs text[];
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

  -- Match the payment service's lock order: payment attempt, then bookings.
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
    into booking_refs, booking_count, eligible_count, unpaid_count, existing_paid_at
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
      or payment.booking_ref = any(booking_refs)
      or payment.booking_refs && booking_refs
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
      or payment.booking_ref = any(booking_refs)
      or payment.booking_refs && booking_refs
   )
     and payment.status = 'created';

  if unpaid_count = 0 then
    return jsonb_build_object(
      'status', 'confirmed', 'paymentStatus', 'paid',
      'paidAt', existing_paid_at, 'refs', to_jsonb(booking_refs)
    );
  end if;

  update public.bookings booking
     set payment_status = 'paid',
         downpayment = booking.total,
         paid_at = coalesce(booking.paid_at, paid_time)
   where booking.ref = any(booking_refs);

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
    'paidAt', paid_time, 'refs', to_jsonb(booking_refs)
  );
end;
$$;

revoke all on function public.mark_host_booking_group_fully_paid(text)
  from public, anon, authenticated;
grant execute on function public.mark_host_booking_group_fully_paid(text)
  to authenticated;
