-- Restore archived booking deletes atomically from the dashboard.

create or replace function public.restore_deleted_booking_archive(p_archive_id uuid)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  archive_rec public.deleted_booking_archive%rowtype;
  restored public.bookings%rowtype;
  target_ref text;
begin
  if not public.has_account_role(array['owner']) then
    raise exception 'Only the system owner can restore deleted bookings.'
      using errcode = '42501';
  end if;

  select *
    into archive_rec
    from public.deleted_booking_archive
   where id = p_archive_id
   for update;

  if not found then
    raise exception 'Deleted booking archive row not found.';
  end if;

  if archive_rec.original_booking is null then
    raise exception 'Archive row has no original booking payload.';
  end if;

  target_ref := coalesce(archive_rec.original_booking->>'ref', archive_rec.booking_ref);
  if exists (select 1 from public.bookings where ref = target_ref) then
    raise exception 'Booking % already exists in active bookings.', target_ref;
  end if;

  restored := jsonb_populate_record(null::public.bookings, archive_rec.original_booking);

  insert into public.bookings
  select (restored).*
  returning * into restored;

  update public.deleted_booking_archive
     set recovery_status = 'restored',
         recovered_booking = to_jsonb(restored),
         recovered_from = coalesce(recovered_from, 'archive_restore'),
         restored_at = now(),
         restored_by = auth.uid(),
         notes = concat_ws(E'\n', notes, 'Restored from deleted booking archive.')
   where id = p_archive_id;

  return restored;
end;
$$;

grant execute on function public.restore_deleted_booking_archive(uuid) to authenticated;
