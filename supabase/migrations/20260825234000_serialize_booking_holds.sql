-- Serialize same-slot hold creation and make stale receipt reconciliation
-- resilient to legacy overlapping placeholders.

begin;

create or replace function public.prevent_double_booking()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  lock_slot text;
begin
  -- Receipt/payment metadata updates do not alter court occupancy. Returning
  -- here also lets recovery attach stored evidence to a legacy conflicted row.
  if tg_op = 'UPDATE'
     and new.court_id is not distinct from old.court_id
     and new.date is not distinct from old.date
     and new.status is not distinct from old.status
     and new.ref is not distinct from old.ref
     and new.slots is not distinct from old.slots then
    return new;
  end if;

  if new.status in ('cancelled', 'forfeited') then return new; end if;

  -- A check-only trigger has a race: two simultaneous INSERTs can both check
  -- before either row commits. Lock every requested court/date/slot key in a
  -- deterministic order, then recheck while the competing transaction is
  -- visible. Hash collisions only serialize unrelated slots; they cannot allow
  -- an overlap.
  for lock_slot in
    select distinct slot_value
    from unnest(coalesce(new.slots, '{}'::text[])) as requested(slot_value)
    order by slot_value
  loop
    perform pg_advisory_xact_lock(
      hashtextextended(
        'korte-dos-booking-slot|' || coalesce(new.court_id::text, '') || '|' ||
        coalesce(new.date::text, '') || '|' || lock_slot::text,
        0
      )
    );
  end loop;

  if exists (
    select 1
    from public.bookings booking
    where booking.court_id = new.court_id
      and booking.date = new.date
      and booking.status not in ('cancelled', 'forfeited')
      and booking.ref <> new.ref
      and booking.slots && new.slots
      and (
        booking.status <> 'verifying'
        or booking.created_at is null
        or booking.created_at > now() - interval '15 minutes'
      )
  ) then
    raise exception 'One or more time slots are already booked for this court and date.';
  end if;

  return new;
end;
$$;

comment on function public.prevent_double_booking()
  is 'Serializes active booking writes per court/date/slot before checking for overlaps.';

-- Reconcile in three safe phases: attach immutable evidence without changing
-- occupancy, release only genuinely empty expired siblings, then promote the
-- evidence-bearing hold to owner review. A remaining legitimate conflict is
-- isolated to that row and never rolls back receipt preservation.
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

    -- Status remains verifying in this phase, so an old overlapping placeholder
    -- cannot block attachment of the already-stored financial evidence.
    update public.bookings booking
       set receipt_image_url = staged.object_path,
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
  end loop;

  -- A valid Storage object or attached receipt always blocks cancellation.
  update public.bookings booking
     set status = 'cancelled',
         payment_status = 'failed'
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

  for staged in
    select distinct
      booking.ref,
      booking.booking_group_ref
    from public.bookings booking
    where booking.status = 'verifying'
      and booking.created_at < now() - interval '15 minutes'
      and nullif(btrim(coalesce(booking.receipt_image_url, '')), '') is not null
  loop
    begin
      update public.bookings booking
         set status = 'pending',
             payment_status = 'for_verification'
       where (
         (staged.booking_group_ref is not null
          and booking.booking_group_ref = staged.booking_group_ref)
         or
         (staged.booking_group_ref is null and booking.ref = staged.ref)
       )
         and booking.status = 'verifying'
         and nullif(btrim(coalesce(booking.receipt_image_url, '')), '') is not null;
      get diagnostics affected_rows = row_count;
      changed := changed + affected_rows;
    exception
      when sqlstate 'P0001' then
        -- A legitimate active conflict may still exist. Evidence remains
        -- attached and visible to the owner; a later run can promote it.
        null;
    end;
  end loop;

  return changed;
end;
$$;

revoke all on function public.expire_stale_verifying_bookings()
  from public;
grant execute on function public.expire_stale_verifying_bookings()
  to anon, authenticated;

comment on function public.expire_stale_verifying_bookings()
  is 'Preserves staged receipts before releasing empty holds as failed and promotes recoverable payments to owner review.';

commit;
