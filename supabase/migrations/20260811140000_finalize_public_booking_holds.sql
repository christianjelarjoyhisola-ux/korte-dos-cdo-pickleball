-- Finalize anonymous booking holds without granting public SELECT access to
-- private booking rows. Direct UPDATEs cannot find a row when the hardened
-- bookings SELECT policy is staff-only, even when an UPDATE policy exists.

create or replace function public.finalize_public_booking_hold(
  p_ref text,
  p_full_name text,
  p_contact_number text,
  p_email text,
  p_payment_method text,
  p_payment_reference text,
  p_downpayment numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  hold_row public.bookings%rowtype;
  clean_ref text := upper(btrim(coalesce(p_ref, '')));
  clean_name text := btrim(coalesce(p_full_name, ''));
  clean_phone text := regexp_replace(coalesce(p_contact_number, ''), '[[:space:]-]', '', 'g');
  clean_email text := lower(btrim(coalesce(p_email, '')));
  clean_method text := lower(btrim(coalesce(p_payment_method, '')));
  clean_payment_ref text := btrim(coalesce(p_payment_reference, ''));
begin
  if clean_ref !~ '^PB-[A-Z0-9]+-[A-Z0-9]+$' then
    raise exception using errcode = '22023', message = 'Booking reference is invalid.';
  end if;

  select booking.*
    into hold_row
    from public.bookings booking
   where booking.ref = clean_ref
     and booking.status = 'verifying'
     and booking.payment_status = 'for_verification'
     and coalesce(booking.host_booking, false) = false
     and booking.host_user_id is null
     and booking.created_via = 'customer'
     and booking.created_by_user_id is null
     and booking.receipt_image_url is null
     and booking.receipt_image_hash is null
     and booking.created_at > now() - interval '15 minutes'
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'This booking reservation expired or changed. Please select the slots again.';
  end if;

  if char_length(clean_name) < 3 or char_length(clean_name) > 160 then
    raise exception using errcode = '22023', message = 'Enter a valid full name.';
  end if;
  if clean_phone !~ '^(09|\+639)[0-9]{9}$' then
    raise exception using errcode = '22023', message = 'Enter a valid Philippine contact number.';
  end if;
  if char_length(clean_email) > 254 or clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception using errcode = '22023', message = 'Enter a valid email address.';
  end if;
  if clean_method not in ('cash', 'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb') then
    raise exception using errcode = '22023', message = 'Selected payment method is not supported.';
  end if;
  if p_downpayment is null or p_downpayment < 0 then
    raise exception using errcode = '22023', message = 'Reservation payment amount is invalid.';
  end if;

  if clean_method = 'gcash' and clean_payment_ref !~ '^[0-9]{13}$' then
    raise exception using errcode = '22023', message = 'GCash reference number must be exactly 13 digits.';
  elsif clean_method = 'bdopay' and upper(regexp_replace(clean_payment_ref, '[[:space:]]', '', 'g')) !~ '^BN-?(NB-?)?[0-9]{8}-?[0-9]{8}$' then
    raise exception using errcode = '22023', message = 'BDO Pay reference number is invalid.';
  elsif clean_method = 'maya' and regexp_replace(upper(clean_payment_ref), '[^A-Z0-9]', '', 'g') !~ '^[A-Z0-9]{12}$' then
    raise exception using errcode = '22023', message = 'Maya Reference ID is invalid.';
  elsif clean_method = 'bpi' and regexp_replace(clean_payment_ref, '[^0-9]', '', 'g') !~ '^[0-9]{10,20}$' then
    raise exception using errcode = '22023', message = 'BPI Confirmation No. is invalid.';
  elsif clean_method = 'maribank' and clean_payment_ref !~ '^[0-9]{6}$' then
    raise exception using errcode = '22023', message = 'MariBank Reference Number must be exactly 6 digits.';
  elsif clean_method = 'gotyme' and upper(clean_payment_ref) !~ '^ITO[0-9]{15}$' then
    raise exception using errcode = '22023', message = 'GoTyme Reference No. is invalid.';
  elsif clean_method = 'pnb' and clean_payment_ref !~ '^[0-9]{1,30}$' then
    raise exception using errcode = '22023', message = 'PNB reference number is invalid.';
  elsif clean_method = 'cash' then
    clean_payment_ref := '';
  end if;

  update public.bookings
     set full_name = clean_name,
         contact_number = btrim(p_contact_number),
         email = clean_email,
         payment_method = clean_method,
         received_account = case when clean_method = 'cash' then 'cash' else 'gcash' end,
         payment_flow = clean_method,
         gcash_ref = nullif(clean_payment_ref, ''),
         downpayment = p_downpayment,
         status = case when clean_method = 'cash' then 'pending' else 'verifying' end,
         payment_status = case when clean_method = 'cash' then 'unpaid' else 'for_verification' end
   where ref = hold_row.ref;

  return jsonb_build_object(
    'ref', hold_row.ref,
    'createdAt', hold_row.created_at
  );
end;
$$;

create or replace function public.cancel_public_booking_hold(p_ref text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cancelled_ref text;
begin
  update public.bookings
     set status = 'cancelled',
         payment_status = 'failed'
   where ref = upper(btrim(coalesce(p_ref, '')))
     and status = 'verifying'
     and payment_status = 'for_verification'
     and coalesce(host_booking, false) = false
     and host_user_id is null
     and created_via = 'customer'
     and created_by_user_id is null
     and receipt_image_url is null
     and receipt_image_hash is null
  returning ref into cancelled_ref;

  return jsonb_build_object('ref', cancelled_ref, 'cancelled', cancelled_ref is not null);
end;
$$;

revoke all on function public.finalize_public_booking_hold(text, text, text, text, text, text, numeric)
  from public, authenticated;
revoke all on function public.cancel_public_booking_hold(text)
  from public, authenticated;
grant execute on function public.finalize_public_booking_hold(text, text, text, text, text, text, numeric)
  to anon;
grant execute on function public.cancel_public_booking_hold(text)
  to anon;

comment on function public.finalize_public_booking_hold(text, text, text, text, text, text, numeric)
  is 'Safely finalizes an active anonymous booking hold without exposing booking rows through SELECT RLS.';
comment on function public.cancel_public_booking_hold(text)
  is 'Releases an unsubmitted anonymous booking hold without exposing booking rows through SELECT RLS.';
