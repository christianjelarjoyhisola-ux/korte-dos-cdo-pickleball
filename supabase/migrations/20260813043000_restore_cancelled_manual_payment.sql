-- Restore a cancelled digital booking only after an authorized reviewer has
-- independently matched the transaction in the payment provider's history.
-- This is intentionally separate from receipt review: missing receipt evidence
-- remains visible in the audit flags and is never represented as an OCR success.

create or replace function public.restore_cancelled_booking_after_manual_payment(
  p_booking_ref text,
  p_actor_user_id uuid,
  p_actor_role text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_ref text := nullif(btrim(coalesce(p_booking_ref, '')), '');
  requested_role text := lower(btrim(coalesce(p_actor_role, '')));
  clean_reason text := nullif(left(btrim(coalesce(p_reason, '')), 1000), '');
  authoritative_role text;
  primary_ref text;
  group_ref text;
  booking_refs text[];
  booking_count integer := 0;
  cancelled_count integer := 0;
  digital_count integer := 0;
  total_amount numeric := 0;
  received_amount numeric := 0;
  final_payment_status text;
  payment_provider text;
  payment_reference text;
  canonical_reference text;
  claimed_by_ref text;
  earliest_start timestamptz;
begin
  if requested_ref is null then
    raise exception using errcode = '22023', message = 'A booking reference is required.';
  end if;

  if p_actor_user_id is null
     or requested_role not in ('owner', 'court_owner', 'staff') then
    raise exception using errcode = '22023', message = 'A valid payment-review actor is required.';
  end if;

  if clean_reason is null or length(clean_reason) < 10 then
    raise exception using
      errcode = '22023',
      message = 'Describe how the payment was matched in the provider history (at least 10 characters).';
  end if;

  select account.role
    into authoritative_role
    from public.accounts account
   where account.id = p_actor_user_id
     and account.status = 'active'
   limit 1;

  if authoritative_role is null
     or authoritative_role <> requested_role
     or authoritative_role not in ('owner', 'court_owner', 'staff') then
    raise exception using
      errcode = '42501',
      message = 'The payment-review actor is not an active authorized account.';
  end if;

  select booking.ref, booking.booking_group_ref
    into primary_ref, group_ref
    from public.bookings booking
   where booking.ref = requested_ref
      or booking.booking_group_ref = requested_ref
   order by
     case when booking.ref = requested_ref then 0 else 1 end,
     booking.created_at,
     booking.ref
   limit 1;

  if primary_ref is null then
    raise exception using
      errcode = 'P0002',
      message = format('Booking or booking group %s was not found.', requested_ref);
  end if;

  perform booking.ref
    from public.bookings booking
   where (
     group_ref is not null and booking.booking_group_ref = group_ref
   ) or (
     group_ref is null and booking.ref = primary_ref
   )
   order by booking.ref
   for update;

  select
    array_agg(booking.ref order by booking.ref),
    count(*)::integer,
    count(*) filter (
      where booking.status = 'cancelled'
        and booking.payment_status = 'rejected'
    )::integer,
    count(*) filter (
      where lower(btrim(coalesce(booking.payment_method, ''))) in (
        'gcash', 'maya', 'gotyme', 'bpi', 'bdopay', 'maribank', 'pnb'
      )
    )::integer,
    coalesce(sum(booking.total), 0),
    coalesce(sum(booking.downpayment), 0),
    min(public.booking_start_at_ph(booking.date, booking.start_time, booking.slots))
    into
      booking_refs,
      booking_count,
      cancelled_count,
      digital_count,
      total_amount,
      received_amount,
      earliest_start
    from public.bookings booking
   where (
     group_ref is not null and booking.booking_group_ref = group_ref
   ) or (
     group_ref is null and booking.ref = primary_ref
   );

  if booking_count = 0 then
    raise exception using errcode = 'P0002', message = 'The booking group no longer exists.';
  end if;

  if cancelled_count <> booking_count then
    raise exception using
      errcode = 'P0001',
      message = 'Every booking must still be cancelled with payment rejected before it can be restored.';
  end if;

  if digital_count <> booking_count then
    raise exception using
      errcode = 'P0001',
      message = 'Manual provider confirmation is available only for digital payments.';
  end if;

  if earliest_start is null or earliest_start <= now() then
    raise exception using
      errcode = 'P0001',
      message = 'This booking schedule has already started or elapsed and cannot be restored.';
  end if;

  select
    lower(btrim(coalesce(booking.payment_method, ''))),
    nullif(btrim(coalesce(booking.gcash_ref, '')), '')
    into payment_provider, payment_reference
    from public.bookings booking
   where booking.ref = primary_ref;

  if payment_reference is null then
    raise exception using
      errcode = 'P0001',
      message = 'A provider transaction reference is required before restoring this booking.';
  end if;

  canonical_reference := case
    when payment_provider = 'gcash' then payment_reference
    else payment_provider || ':' || payment_reference
  end;

  insert into public.used_gcash_refs (gcash_ref, booking_ref, provider)
  values (canonical_reference, primary_ref, payment_provider)
  on conflict (gcash_ref) do nothing;

  select used_ref.booking_ref
    into claimed_by_ref
    from public.used_gcash_refs used_ref
   where used_ref.gcash_ref = canonical_reference
   for update;

  if claimed_by_ref is null then
    raise exception using errcode = 'P0001', message = 'The payment reference could not be claimed.';
  end if;

  if not (claimed_by_ref = any(booking_refs)) then
    raise exception using
      errcode = '23505',
      message = 'Duplicate payment reference: this reference belongs to another payment.';
  end if;

  final_payment_status := case
    when received_amount >= total_amount - 0.01 then 'paid'
    else 'downpayment_paid'
  end;

  update public.bookings booking
     set status = 'confirmed',
         payment_status = final_payment_status,
         receipt_status = 'manual_review',
         receipt_flags = array(
           select distinct flag
             from unnest(
               coalesce(booking.receipt_flags, '{}'::text[])
               || array['MANUAL_PROVIDER_VERIFICATION', 'NO_RECEIPT_IMAGE']::text[]
             ) flag
            order by flag
         ),
         receipt_verified_at = coalesce(booking.receipt_verified_at, now())
   where booking.ref = any(booking_refs);

  insert into public.payment_review_decisions (
    receipt_verification_id,
    booking_ref,
    booking_group_ref,
    decision,
    actor_user_id,
    actor_role,
    reason,
    prior_receipt_status,
    prior_receipt_flags
  ) values (
    null,
    primary_ref,
    group_ref,
    'approve',
    p_actor_user_id,
    authoritative_role,
    'Manual provider-history confirmation: ' || clean_reason,
    'none',
    array['MANUAL_PROVIDER_VERIFICATION', 'NO_RECEIPT_IMAGE']::text[]
  );

  return jsonb_build_object(
    'alreadyApplied', false,
    'manualProviderConfirmation', true,
    'status', 'confirmed',
    'paymentStatus', final_payment_status,
    'refs', to_jsonb(booking_refs)
  );
end;
$$;

revoke all on function public.restore_cancelled_booking_after_manual_payment(
  text, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.restore_cancelled_booking_after_manual_payment(
  text, uuid, text, text
) to service_role;
