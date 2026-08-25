-- A receipt upload is durable payment evidence even when the browser loses the
-- stage/verify response. Reconcile Storage checkpoints before expiring public
-- holds so a paid customer is routed to owner review instead of being silently
-- cancelled and encouraged to submit the same payment again.

create or replace function public.expire_stale_verifying_bookings()
returns integer
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  staged record;
  changed integer := 0;
  affected_rows integer := 0;
begin
  for staged in
    select distinct on (booking.ref)
      booking.ref,
      booking.booking_group_ref,
      lower(coalesce(booking.payment_method, 'gcash')) as provider,
      booking.gcash_ref as submitted_reference,
      object.name as object_path,
      lower(substring(split_part(object.name, '/', 2) from '^([a-f0-9]{64})\.'))
        as image_hash
    from public.bookings booking
    join storage.objects object
      on object.bucket_id = 'receipts'
     and object.name like booking.ref || '/%'
     and split_part(object.name, '/', 2)
       ~* '^[a-f0-9]{64}\.(jpg|png|webp|heic)$'
    where booking.status = 'verifying'
      and booking.created_at < now() - interval '15 minutes'
      and nullif(btrim(coalesce(booking.receipt_image_url, '')), '') is null
    order by booking.ref, object.updated_at desc, object.created_at desc, object.id desc
  loop
    insert into public.receipt_verifications (
      booking_ref,
      result,
      flags,
      extracted,
      confidence,
      image_hash,
      phash,
      raw_ocr_text
    )
    select
      staged.ref,
      'manual_review',
      array['VERIFICATION_PROCESSING_INCOMPLETE']::text[],
      jsonb_build_object(
        'provider', staged.provider,
        'verificationContext', 'court_booking',
        'submittedReference', staged.submitted_reference,
        'processingCheckpoint', 'receipt_stored',
        'processingFailure',
          'The receipt upload was stored but automatic verification did not complete.'
      ),
      0,
      staged.image_hash,
      null,
      null
    where not exists (
      select 1
      from public.receipt_verifications verification
      where verification.booking_ref = staged.ref
        and lower(coalesce(verification.image_hash, '')) = staged.image_hash
    );

    update public.bookings booking
       set status = 'pending',
           payment_status = 'for_verification',
           receipt_image_url = staged.object_path,
           receipt_image_hash = staged.image_hash,
           receipt_status = 'manual_review',
           receipt_flags = array['VERIFICATION_PROCESSING_INCOMPLETE']::text[],
           receipt_confidence = 0
     where (
       (staged.booking_group_ref is not null
        and booking.booking_group_ref = staged.booking_group_ref)
       or
       (staged.booking_group_ref is null and booking.ref = staged.ref)
     )
       and booking.status = 'verifying'
       and nullif(btrim(coalesce(booking.receipt_image_url, '')), '') is null;
    get diagnostics affected_rows = row_count;
    changed := changed + affected_rows;
  end loop;

  -- Only genuinely empty holds may be released. A valid object below the
  -- booking prefix is a durable recovery journal and blocks cancellation even
  -- if reconciliation encounters a transient database error.
  update public.bookings booking
     set status = 'cancelled',
         payment_status = 'rejected'
   where booking.status = 'verifying'
     and booking.created_at < now() - interval '15 minutes'
     and nullif(btrim(coalesce(booking.receipt_image_url, '')), '') is null
     and not exists (
       select 1
       from public.bookings evidence_booking
       join storage.objects object
         on object.bucket_id = 'receipts'
        and object.name like evidence_booking.ref || '/%'
         and split_part(object.name, '/', 2)
           ~* '^[a-f0-9]{64}\.(jpg|png|webp|heic)$'
       where (
         (booking.booking_group_ref is not null
          and evidence_booking.booking_group_ref = booking.booking_group_ref)
         or
         (booking.booking_group_ref is null and evidence_booking.ref = booking.ref)
       )
     );
  get diagnostics affected_rows = row_count;
  changed := changed + affected_rows;

  return changed;
end;
$$;

revoke all on function public.expire_stale_verifying_bookings()
  from public;
grant execute on function public.expire_stale_verifying_bookings()
  to anon, authenticated;

comment on function public.expire_stale_verifying_bookings()
  is 'Recovers staged court receipts to manual review before cancelling genuinely empty expired booking holds.';
