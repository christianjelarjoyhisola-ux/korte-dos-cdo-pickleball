-- System-owner correction flow for test/erroneous bookings.
-- Active bookings are removed, unremitted fees are excluded, and the archive
-- plus remittance ledger retain an audit trail. Settled money is never erased.

alter table public.deleted_booking_archive
  add column if not exists voided_fee_amount numeric(12,2),
  add column if not exists void_reason text,
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid;

alter table public.deleted_booking_archive drop constraint if exists deleted_booking_archive_void_fee_check;
alter table public.deleted_booking_archive add constraint deleted_booking_archive_void_fee_check
  check (voided_fee_amount is null or voided_fee_amount >= 0);

create or replace function public.guard_unsettled_booking_fee_delete()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if current_setting('app.owner_void_booking', true) = 'on'
     and public.current_account_role() = 'owner' then return old; end if;
  if old.booking_fee_earned_at is null or coalesce(old.booking_fee_amount_snapshot, 0) <= 0 then return old; end if;
  if exists (
    select 1 from public.booking_fee_remittance_items i
    join public.booking_fee_remittances r on r.id = i.remittance_id
    where i.booking_ref = old.ref and i.released_at is null and r.status = 'settled'
  ) or exists (
    select 1 from public.weekly_fees wf where wf.status = 'paid'
      and (wf.id = old.weekly_fee_id or coalesce(wf.billed_refs, '[]'::jsonb) @> jsonb_build_array(old.ref))
  ) then return old; end if;
  raise exception 'This paid booking has an unsettled platform fee and cannot be deleted. Use System Owner Void & Delete or settle its remittance first.' using errcode = '22000';
end; $$;

create or replace function public.archive_deleted_booking()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  is_void boolean := current_setting('app.owner_void_booking', true) = 'on';
  reason text := nullif(current_setting('app.owner_void_reason', true), '');
begin
  insert into public.deleted_booking_archive (
    booking_ref, source, original_booking, recovery_status, deleted_at, notes,
    voided_fee_amount, void_reason, voided_at, voided_by
  ) values (
    old.ref, case when is_void then 'owner_void' else 'trigger' end, to_jsonb(old),
    case when is_void then 'voided' else 'deleted' end, now(),
    case when is_void then 'System Owner voided and deleted this booking. Fee excluded from future computation. Reason: ' || coalesce(reason, 'Not supplied')
         else 'Automatically archived before hard delete.' end,
    case when is_void and old.booking_fee_earned_at is not null then greatest(coalesce(old.booking_fee_amount_snapshot, 0), 0) else 0 end,
    case when is_void then reason end, case when is_void then now() end, case when is_void then auth.uid() end
  );
  return old;
end; $$;

create or replace function public.void_delete_booking_group(p_booking_ref text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  target public.bookings%rowtype;
  group_key text;
  refs text[];
  affected_ids uuid[];
  void_time timestamptz := clock_timestamp();
  deleted_count integer := 0;
  released_count integer := 0;
  voided_fee numeric(12,2) := 0;
  rid uuid;
  remaining_count integer;
  remaining_due numeric(12,2);
begin
  if public.current_account_role() <> 'owner' then
    raise exception 'Only the active System Owner can void and delete a booking.' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_booking_ref, ''))) = 0 then raise exception 'A booking reference is required.' using errcode = '22023'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'A void reason of at least 3 characters is required.' using errcode = '22023'; end if;

  perform pg_advisory_xact_lock(hashtextextended('korte-dos-booking-fee-remittance', 0));
  select * into target from public.bookings where ref = trim(p_booking_ref) for update;
  if not found then raise exception 'Booking % was not found.', trim(p_booking_ref) using errcode = 'P0002'; end if;
  group_key := coalesce(nullif(target.booking_group_ref, ''), target.ref);
  select array_agg(b.ref order by b.ref),
         coalesce(sum(case when b.booking_fee_earned_at is not null then greatest(coalesce(b.booking_fee_amount_snapshot, 0), 0) else 0 end), 0)
    into refs, voided_fee from public.bookings b
   where coalesce(nullif(b.booking_group_ref, ''), b.ref) = group_key;
  perform 1 from public.bookings b where b.ref = any(refs) for update;

  if exists (
    select 1 from public.bookings b join public.weekly_fees wf
      on wf.status = 'paid' and (wf.id = b.weekly_fee_id or coalesce(wf.billed_refs, '[]'::jsonb) @> jsonb_build_array(b.ref))
    where b.ref = any(refs)
  ) then raise exception 'This booking fee is already in a paid legacy statement and cannot be void-deleted.' using errcode = '22023'; end if;
  if exists (
    select 1 from public.booking_fee_remittance_items i join public.booking_fee_remittances r on r.id = i.remittance_id
    where i.booking_ref = any(refs) and i.released_at is null
      and (r.status not in ('prepared', 'payment_rejected') or r.amount_settled <> 0)
  ) then raise exception 'This booking fee has a submitted or settled remittance. Apply a credit adjustment instead of deleting financial history.' using errcode = '22023'; end if;
  if exists (
    select 1 from public.booking_fee_remittance_items i join public.booking_fee_remittance_payments p on p.remittance_id = i.remittance_id
    where i.booking_ref = any(refs) and i.released_at is null and p.status in ('pending', 'accepted', 'partially_accepted')
  ) then raise exception 'A pending or accepted remittance payment prevents this booking from being void-deleted.' using errcode = '22023'; end if;

  select array_agg(distinct i.remittance_id) into affected_ids
    from public.booking_fee_remittance_items i where i.booking_ref = any(refs) and i.released_at is null;
  update public.booking_fee_remittance_items i
     set released_at = void_time, released_by_user_id = auth.uid(),
         release_reason = 'Booking voided by System Owner: ' || trim(p_reason)
   where i.booking_ref = any(refs) and i.released_at is null;
  get diagnostics released_count = row_count;

  if affected_ids is not null then
    foreach rid in array affected_ids loop
      select count(*)::integer, coalesce(sum(i.fee_amount), 0) into remaining_count, remaining_due
        from public.booking_fee_remittance_items i where i.remittance_id = rid and i.released_at is null;
      update public.booking_fee_remittances r
         set bookings_count = remaining_count, amount_due = remaining_due,
             status = case when remaining_count = 0 then 'cancelled' else r.status end,
             cancelled_at = case when remaining_count = 0 then void_time else r.cancelled_at end,
             cancelled_by_user_id = case when remaining_count = 0 then auth.uid() else r.cancelled_by_user_id end,
             cancellation_reason = case when remaining_count = 0 then 'All items released after System Owner booking void: ' || trim(p_reason) else r.cancellation_reason end,
             cancel_idempotency_key = case when remaining_count = 0 then 'void-' || rid::text else r.cancel_idempotency_key end
       where r.id = rid;
    end loop;
  end if;

  perform set_config('app.owner_void_reason', trim(p_reason), true);
  perform set_config('app.owner_void_booking', 'on', true);
  delete from public.bookings b where b.ref = any(refs);
  get diagnostics deleted_count = row_count;
  return jsonb_build_object('booking_ref', trim(p_booking_ref), 'group_key', group_key,
    'deleted_count', deleted_count, 'released_remittance_items', released_count,
    'voided_fee_amount', voided_fee, 'reason', trim(p_reason));
end; $$;

revoke all on function public.void_delete_booking_group(text, text) from public, anon;
grant execute on function public.void_delete_booking_group(text, text) to authenticated;

-- Voided archives keep their payload for audit but must never be restored.
create or replace function public.restore_deleted_booking_archive(p_archive_id uuid)
returns public.bookings language plpgsql security definer set search_path = public, pg_temp as $$
declare archive_rec public.deleted_booking_archive%rowtype; restored public.bookings%rowtype; target_ref text;
begin
  if not public.has_account_role(array['owner']) then raise exception 'Only the system owner can restore deleted bookings.' using errcode = '42501'; end if;
  select * into archive_rec from public.deleted_booking_archive where id = p_archive_id for update;
  if not found then raise exception 'Deleted booking archive row not found.'; end if;
  if archive_rec.recovery_status = 'voided' or archive_rec.source = 'owner_void' then raise exception 'A voided booking is final and cannot be restored.' using errcode = '22023'; end if;
  if archive_rec.original_booking is null then raise exception 'Archive row has no original booking payload.'; end if;
  target_ref := coalesce(archive_rec.original_booking->>'ref', archive_rec.booking_ref);
  if exists (select 1 from public.bookings where ref = target_ref) then raise exception 'Booking % already exists in active bookings.', target_ref; end if;
  restored := jsonb_populate_record(null::public.bookings, archive_rec.original_booking);
  insert into public.bookings select (restored).* returning * into restored;
  update public.deleted_booking_archive set recovery_status = 'restored', recovered_booking = to_jsonb(restored),
    recovered_from = coalesce(recovered_from, 'archive_restore'), restored_at = now(), restored_by = auth.uid(),
    notes = concat_ws(E'\n', notes, 'Restored from deleted booking archive.') where id = p_archive_id;
  return restored;
end; $$;

notify pgrst, 'reload schema';
