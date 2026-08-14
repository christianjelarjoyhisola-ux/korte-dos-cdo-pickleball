-- Allow vouchers on both public/customer and authenticated-host court holds.
-- The voucher still discounts only the court charge; the platform booking fee
-- is removed from the eligible amount before any percentage or fixed discount.

create or replace function public.apply_booking_voucher(p_code text, p_booking_refs text[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  voucher_row public.vouchers%rowtype;
  clean_refs text[];
  group_key text;
  booking_count integer;
  usage_count integer;
  gross_amount numeric(12,2);
  eligible_amount numeric(12,2);
  discount_amount numeric(12,2);
  court_ids text[];
  reservation_deadline timestamptz;
  existing_voucher_id uuid;
  selected_group_ref text;
  group_identity_count integer;
  result_rows jsonb;
  request_role text := coalesce(auth.role(), nullif(current_setting('request.jwt.claim.role', true), ''));
  account_role text := public.current_account_role();
begin
  clean_refs := array(
    select distinct trim(ref)
      from unnest(coalesce(p_booking_refs, '{}')) ref
     where trim(ref) <> ''
     order by 1
  );
  if cardinality(clean_refs) = 0 then
    raise exception 'No active booking reservation was supplied.';
  end if;
  group_key := public.voucher_booking_group_key(clean_refs);

  perform public.release_expired_voucher_reservations();

  select * into voucher_row
    from public.vouchers
   where code = upper(trim(coalesce(p_code, '')))
   for update;
  if not found then raise exception 'Code is not valid for this booking.'; end if;
  if not voucher_row.active or voucher_row.archived_at is not null then raise exception 'This voucher is not active.'; end if;
  if voucher_row.starts_at is not null and voucher_row.starts_at > now() then raise exception 'This voucher is not active yet.'; end if;
  if voucher_row.ends_at is not null and voucher_row.ends_at <= now() then raise exception 'This voucher has expired.'; end if;

  perform 1
    from public.bookings
   where ref = any(clean_refs)
   order by ref
   for update;

  select count(*),
         round(sum(coalesce(voucher_gross_total, total)), 2),
         round(sum(greatest(
           coalesce(voucher_gross_total, total)
             - least(
                 greatest(coalesce(booking_fee_amount_snapshot, 0), 0),
                 coalesce(voucher_gross_total, total)
               ),
           0
         )), 2),
         array_agg(distinct court_id),
         min(created_at + interval '15 minutes'),
         (array_agg(voucher_id) filter (where voucher_id is not null))[1],
         min(booking_group_ref),
         count(distinct coalesce(booking_group_ref, ref))
    into booking_count, gross_amount, eligible_amount, court_ids, reservation_deadline,
         existing_voucher_id, selected_group_ref, group_identity_count
    from public.bookings
   where ref = any(clean_refs)
     and status = 'verifying'
     and created_at > now() - interval '15 minutes'
     and email = 'reserve@hold.internal'
     and downpayment is null
     and payment_session_id is null
     and receipt_image_url is null
     and (
       (
         request_role = 'anon'
         and coalesce(host_booking, false) = false
         and created_via = 'customer'
         and created_by_user_id is null
       )
       or
       (
         request_role = 'authenticated'
         and account_role = 'host'
         and coalesce(host_booking, false) = true
         and host_user_id = auth.uid()
         and created_via = 'host'
         and created_by_user_id = auth.uid()
         and created_by_role = 'host'
       )
     );

  if booking_count <> cardinality(clean_refs) then
    raise exception 'The booking reservation expired, changed, or does not belong to this account. Please select the slots again.';
  end if;
  if group_identity_count <> 1 then raise exception 'Voucher codes must be applied to one booking group at a time.'; end if;
  if selected_group_ref is not null and exists (
    select 1
      from public.bookings
     where booking_group_ref = selected_group_ref
       and status <> 'cancelled'
       and not (ref = any(clean_refs))
  ) then
    raise exception 'The complete booking group is required to apply a voucher.';
  end if;
  if eligible_amount < voucher_row.minimum_spend then
    raise exception 'This voucher requires a minimum court spend of PHP %.',
      trim(to_char(voucher_row.minimum_spend, 'FM999999990.00'));
  end if;
  if cardinality(voucher_row.applicable_court_ids) > 0
     and exists (
       select 1
         from unnest(court_ids) court_id
        where not (court_id = any(voucher_row.applicable_court_ids))
     ) then
    raise exception 'This voucher does not apply to one or more selected courts.';
  end if;

  if existing_voucher_id = voucher_row.id then
    select coalesce(jsonb_agg(jsonb_build_object(
      'ref', ref,
      'grossTotal', voucher_gross_total,
      'discountAmount', voucher_discount_amount,
      'total', total
    ) order by ref), '[]'::jsonb)
      into result_rows
      from public.bookings
     where ref = any(clean_refs);
    return jsonb_build_object(
      'id', voucher_row.id,
      'code', voucher_row.code,
      'name', voucher_row.name,
      'discountAmount', (select coalesce(sum(voucher_discount_amount), 0) from public.bookings where ref = any(clean_refs)),
      'grossAmount', gross_amount,
      'total', gross_amount - (select coalesce(sum(voucher_discount_amount), 0) from public.bookings where ref = any(clean_refs)),
      'allocations', result_rows,
      'reservedUntil', reservation_deadline
    );
  end if;

  if existing_voucher_id is not null then
    raise exception 'Remove the current voucher before applying a different code.';
  end if;

  select count(*) into usage_count
    from public.voucher_redemptions
   where voucher_id = voucher_row.id
     and status in ('reserved', 'redeemed');
  if voucher_row.usage_limit is not null and usage_count >= voucher_row.usage_limit then
    raise exception 'This voucher has reached its redemption limit.';
  end if;

  discount_amount := case voucher_row.discount_type
    when 'fixed' then voucher_row.discount_value
    else round(eligible_amount * voucher_row.discount_value / 100, 2)
  end;
  if voucher_row.max_discount is not null then
    discount_amount := least(discount_amount, voucher_row.max_discount);
  end if;
  discount_amount := greatest(least(discount_amount, eligible_amount), 0);
  if discount_amount <= 0 then raise exception 'This voucher has no discount for the selected booking.'; end if;

  insert into public.voucher_redemptions (
    voucher_id, booking_group_key, booking_refs, gross_amount, discount_amount, reserved_until
  ) values (
    voucher_row.id, group_key, clean_refs, gross_amount, discount_amount, reservation_deadline
  );

  perform set_config('app.voucher_apply', '1', true);
  with basis as (
    select b.ref,
           coalesce(b.voucher_gross_total, b.total) as gross_total,
           greatest(
             coalesce(b.voucher_gross_total, b.total)
               - least(
                   greatest(coalesce(b.booking_fee_amount_snapshot, 0), 0),
                   coalesce(b.voucher_gross_total, b.total)
                 ),
             0
           ) as eligible,
           row_number() over (order by b.ref) as row_no,
           count(*) over () as row_count
      from public.bookings b
     where b.ref = any(clean_refs)
  ), allocated as (
    select basis.*,
           case
             when row_no < row_count then
               round(discount_amount * eligible / nullif(eligible_amount, 0), 2)
             else
               discount_amount - coalesce(
                 sum(round(discount_amount * eligible / nullif(eligible_amount, 0), 2))
                   over (order by row_no rows between unbounded preceding and 1 preceding),
                 0
               )
           end as item_discount
      from basis
  )
  update public.bookings b
     set voucher_id = voucher_row.id,
         voucher_code_snapshot = voucher_row.code,
         voucher_gross_total = allocated.gross_total,
         voucher_discount_amount = allocated.item_discount,
         total = allocated.gross_total - allocated.item_discount
    from allocated
   where b.ref = allocated.ref;

  select coalesce(jsonb_agg(jsonb_build_object(
    'ref', ref,
    'grossTotal', voucher_gross_total,
    'discountAmount', voucher_discount_amount,
    'total', total
  ) order by ref), '[]'::jsonb)
    into result_rows
    from public.bookings
   where ref = any(clean_refs);

  return jsonb_build_object(
    'id', voucher_row.id,
    'code', voucher_row.code,
    'name', voucher_row.name,
    'discountType', voucher_row.discount_type,
    'discountValue', voucher_row.discount_value,
    'discountAmount', discount_amount,
    'grossAmount', gross_amount,
    'total', gross_amount - discount_amount,
    'allocations', result_rows,
    'reservedUntil', reservation_deadline
  );
end;
$$;

create or replace function public.remove_booking_voucher(p_booking_refs text[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  clean_refs text[];
  group_key text;
  changed integer;
  eligible_count integer;
  request_role text := coalesce(auth.role(), nullif(current_setting('request.jwt.claim.role', true), ''));
  account_role text := public.current_account_role();
begin
  clean_refs := array(
    select distinct trim(ref)
      from unnest(coalesce(p_booking_refs, '{}')) ref
     where trim(ref) <> ''
     order by 1
  );
  if cardinality(clean_refs) = 0 then return jsonb_build_object('removed', false); end if;
  group_key := public.voucher_booking_group_key(clean_refs);

  perform 1
    from public.bookings
   where ref = any(clean_refs)
   order by ref
   for update;

  select count(*) into eligible_count
    from public.bookings
   where ref = any(clean_refs)
     and status = 'verifying'
     and created_at > now() - interval '15 minutes'
     and email = 'reserve@hold.internal'
     and downpayment is null
     and payment_session_id is null
     and receipt_image_url is null
     and (
       (
         request_role = 'anon'
         and coalesce(host_booking, false) = false
         and created_via = 'customer'
         and created_by_user_id is null
       )
       or
       (
         request_role = 'authenticated'
         and account_role = 'host'
         and coalesce(host_booking, false) = true
         and host_user_id = auth.uid()
         and created_via = 'host'
         and created_by_user_id = auth.uid()
         and created_by_role = 'host'
       )
     );

  if eligible_count <> cardinality(clean_refs) then
    raise exception 'The voucher can no longer be changed or does not belong to this account.';
  end if;

  perform set_config('app.voucher_apply', '1', true);
  update public.bookings
     set total = coalesce(voucher_gross_total, total),
         voucher_id = null,
         voucher_code_snapshot = null,
         voucher_discount_amount = 0,
         voucher_gross_total = null
   where ref = any(clean_refs)
     and voucher_id is not null;
  get diagnostics changed = row_count;

  update public.voucher_redemptions
     set status = 'released', released_at = now(), updated_at = now()
   where booking_group_key = group_key
     and status = 'reserved';

  return jsonb_build_object('removed', changed > 0);
end;
$$;

create or replace function public.finalize_booking_voucher(p_booking_refs text[], p_customer_email text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  clean_refs text[];
  group_key text;
  eligible_count integer;
  request_role text := coalesce(auth.role(), nullif(current_setting('request.jwt.claim.role', true), ''));
  account_role text := public.current_account_role();
begin
  clean_refs := array(
    select distinct trim(ref)
      from unnest(coalesce(p_booking_refs, '{}')) ref
     where trim(ref) <> ''
     order by 1
  );
  if cardinality(clean_refs) = 0 then raise exception 'Voucher redemption could not be finalized.'; end if;
  group_key := public.voucher_booking_group_key(clean_refs);

  select count(*) into eligible_count
    from public.bookings
   where ref = any(clean_refs)
     and lower(trim(email)) = lower(trim(p_customer_email))
     and email <> 'reserve@hold.internal'
     and (
       (
         request_role = 'anon'
         and coalesce(host_booking, false) = false
         and created_via = 'customer'
         and created_by_user_id is null
       )
       or
       (
         request_role = 'authenticated'
         and account_role = 'host'
         and coalesce(host_booking, false) = true
         and host_user_id = auth.uid()
         and created_via = 'host'
         and created_by_user_id = auth.uid()
         and created_by_role = 'host'
       )
     );

  if eligible_count <> cardinality(clean_refs) then
    raise exception 'Voucher redemption could not be finalized.';
  end if;

  update public.voucher_redemptions
     set status = 'redeemed',
         customer_email = lower(trim(p_customer_email)),
         redeemed_at = now(),
         updated_at = now()
   where booking_group_key = group_key
     and status = 'reserved';

  if not found then raise exception 'Voucher redemption could not be finalized.'; end if;
end;
$$;

grant execute on function public.apply_booking_voucher(text, text[]) to anon, authenticated;
grant execute on function public.remove_booking_voucher(text[]) to anon, authenticated;
grant execute on function public.finalize_booking_voucher(text[], text) to anon, authenticated;

comment on table public.vouchers is
  'Owner-managed court-fee vouchers usable by guests, hosts, and administrators making court bookings.';
