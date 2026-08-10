-- Booking vouchers for public court reservations.
-- Discounts apply only to the court-rental component. The snapshotted
-- platform booking fee remains untouched for remittance accounting.

create extension if not exists pgcrypto;

create table if not exists public.vouchers (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  description text,
  discount_type text not null check (discount_type in ('fixed', 'percent')),
  discount_value numeric(12,2) not null check (discount_value > 0),
  max_discount numeric(12,2) check (max_discount is null or max_discount > 0),
  minimum_spend numeric(12,2) not null default 0 check (minimum_spend >= 0),
  usage_limit integer check (usage_limit is null or usage_limit > 0),
  applicable_court_ids text[] not null default '{}',
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  archived_at timestamptz,
  created_by uuid not null default auth.uid(),
  updated_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vouchers_code_format check (code = upper(code) and code ~ '^[A-Z0-9][A-Z0-9-]{3,23}$'),
  constraint vouchers_percent_range check (discount_type <> 'percent' or discount_value <= 100),
  constraint vouchers_date_range check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create unique index if not exists vouchers_code_upper_uidx on public.vouchers (upper(code));
create index if not exists vouchers_active_window_idx on public.vouchers (active, starts_at, ends_at);

create table if not exists public.voucher_redemptions (
  id uuid primary key default gen_random_uuid(),
  voucher_id uuid not null references public.vouchers(id) on delete restrict,
  booking_group_key text not null,
  booking_refs text[] not null,
  customer_email text,
  gross_amount numeric(12,2) not null check (gross_amount >= 0),
  discount_amount numeric(12,2) not null check (discount_amount >= 0),
  status text not null default 'reserved' check (status in ('reserved', 'redeemed', 'released')),
  reserved_until timestamptz not null,
  redeemed_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (booking_group_key)
);

create index if not exists voucher_redemptions_voucher_status_idx
  on public.voucher_redemptions (voucher_id, status);

alter table public.bookings
  add column if not exists voucher_id uuid references public.vouchers(id) on delete set null,
  add column if not exists voucher_code_snapshot text,
  add column if not exists voucher_discount_amount numeric(12,2) not null default 0,
  add column if not exists voucher_gross_total numeric(12,2);

alter table public.bookings
  drop constraint if exists bookings_voucher_discount_nonnegative;
alter table public.bookings
  add constraint bookings_voucher_discount_nonnegative
  check (voucher_discount_amount >= 0);

create or replace function public.touch_voucher_row()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.code := upper(trim(new.code));
  new.updated_at := now();
  new.updated_by := auth.uid();
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_touch_voucher_row on public.vouchers;
create trigger trg_touch_voucher_row
before insert or update on public.vouchers
for each row execute function public.touch_voucher_row();

alter table public.vouchers enable row level security;
alter table public.voucher_redemptions enable row level security;

drop policy if exists vouchers_manage_owners on public.vouchers;
create policy vouchers_manage_owners
  on public.vouchers
  for all
  to authenticated
  using (public.has_account_role(array['owner', 'court_owner']))
  with check (public.has_account_role(array['owner', 'court_owner']));

drop policy if exists voucher_redemptions_read_owners on public.voucher_redemptions;
create policy voucher_redemptions_read_owners
  on public.voucher_redemptions
  for select
  to authenticated
  using (public.has_account_role(array['owner', 'court_owner']));

revoke all on public.vouchers from anon;
revoke all on public.voucher_redemptions from anon;
grant select, insert, update on public.vouchers to authenticated;
grant select on public.voucher_redemptions to authenticated;

create or replace function public.voucher_booking_group_key(p_booking_refs text[])
returns text
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  select array_to_string(array(select distinct trim(ref) from unnest(p_booking_refs) ref where trim(ref) <> '' order by 1), '|')
$$;

create or replace function public.release_expired_voucher_reservations()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.voucher_redemptions
     set status = 'released', released_at = now(), updated_at = now()
   where status = 'reserved'
     and reserved_until <= now()
$$;

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
begin
  clean_refs := array(select distinct trim(ref) from unnest(coalesce(p_booking_refs, '{}')) ref where trim(ref) <> '' order by 1);
  if cardinality(clean_refs) = 0 then raise exception 'No active booking reservation was supplied.'; end if;
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
         round(sum(greatest(coalesce(voucher_gross_total, total) - least(greatest(coalesce(booking_fee_amount_snapshot, 0), 0), coalesce(voucher_gross_total, total)), 0)), 2),
         array_agg(distinct court_id),
         min(created_at + interval '15 minutes'),
         (array_agg(voucher_id) filter (where voucher_id is not null))[1],
         min(booking_group_ref),
         count(distinct coalesce(booking_group_ref, ref))
    into booking_count, gross_amount, eligible_amount, court_ids, reservation_deadline, existing_voucher_id, selected_group_ref, group_identity_count
    from public.bookings
   where ref = any(clean_refs)
     and status = 'verifying'
     and created_at > now() - interval '15 minutes'
     and coalesce(host_booking, false) = false
     and created_via = 'customer'
     and created_by_user_id is null
     and email = 'reserve@hold.internal'
     and downpayment is null
     and payment_session_id is null
     and receipt_image_url is null;

  if booking_count <> cardinality(clean_refs) then raise exception 'The booking reservation expired or changed. Please select the slots again.'; end if;
  if group_identity_count <> 1 then raise exception 'Voucher codes must be applied to one booking group at a time.'; end if;
  if selected_group_ref is not null and exists (
    select 1 from public.bookings
     where booking_group_ref = selected_group_ref
       and status <> 'cancelled'
       and not (ref = any(clean_refs))
  ) then raise exception 'The complete booking group is required to apply a voucher.'; end if;
  if eligible_amount < voucher_row.minimum_spend then raise exception 'This voucher requires a minimum court spend of PHP %.', trim(to_char(voucher_row.minimum_spend, 'FM999999990.00')); end if;
  if cardinality(voucher_row.applicable_court_ids) > 0
     and exists (select 1 from unnest(court_ids) court_id where not (court_id = any(voucher_row.applicable_court_ids))) then
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
      from public.bookings where ref = any(clean_refs);
    return jsonb_build_object('id', voucher_row.id, 'code', voucher_row.code, 'name', voucher_row.name,
      'discountAmount', (select coalesce(sum(voucher_discount_amount), 0) from public.bookings where ref = any(clean_refs)),
      'grossAmount', gross_amount, 'total', gross_amount - (select coalesce(sum(voucher_discount_amount), 0) from public.bookings where ref = any(clean_refs)),
      'allocations', result_rows, 'reservedUntil', reservation_deadline);
  end if;

  if existing_voucher_id is not null then
    raise exception 'Remove the current voucher before applying a different code.';
  end if;

  select count(*) into usage_count
    from public.voucher_redemptions
   where voucher_id = voucher_row.id and status in ('reserved', 'redeemed');
  if voucher_row.usage_limit is not null and usage_count >= voucher_row.usage_limit then
    raise exception 'This voucher has reached its redemption limit.';
  end if;

  discount_amount := case voucher_row.discount_type
    when 'fixed' then voucher_row.discount_value
    else round(eligible_amount * voucher_row.discount_value / 100, 2)
  end;
  if voucher_row.max_discount is not null then discount_amount := least(discount_amount, voucher_row.max_discount); end if;
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
           greatest(coalesce(b.voucher_gross_total, b.total) - least(greatest(coalesce(b.booking_fee_amount_snapshot, 0), 0), coalesce(b.voucher_gross_total, b.total)), 0) as eligible,
           row_number() over (order by b.ref) as row_no,
           count(*) over () as row_count
      from public.bookings b where b.ref = any(clean_refs)
  ), allocated as (
    select basis.*,
           case when row_no < row_count
                then round(discount_amount * eligible / nullif(eligible_amount, 0), 2)
                else discount_amount - coalesce(sum(round(discount_amount * eligible / nullif(eligible_amount, 0), 2))
                     over (order by row_no rows between unbounded preceding and 1 preceding), 0)
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
    from public.bookings where ref = any(clean_refs);

  return jsonb_build_object(
    'id', voucher_row.id, 'code', voucher_row.code, 'name', voucher_row.name,
    'discountType', voucher_row.discount_type, 'discountValue', voucher_row.discount_value,
    'discountAmount', discount_amount, 'grossAmount', gross_amount,
    'total', gross_amount - discount_amount, 'allocations', result_rows,
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
begin
  clean_refs := array(select distinct trim(ref) from unnest(coalesce(p_booking_refs, '{}')) ref where trim(ref) <> '' order by 1);
  group_key := public.voucher_booking_group_key(clean_refs);
  if cardinality(clean_refs) = 0 then return jsonb_build_object('removed', false); end if;

  perform 1 from public.bookings
   where ref = any(clean_refs) and status = 'verifying' and created_at > now() - interval '15 minutes'
     and email = 'reserve@hold.internal' and downpayment is null and payment_session_id is null and receipt_image_url is null
   for update;
  if (select count(*) from public.bookings where ref = any(clean_refs) and status = 'verifying' and created_at > now() - interval '15 minutes'
       and email = 'reserve@hold.internal' and downpayment is null and payment_session_id is null and receipt_image_url is null) <> cardinality(clean_refs) then
    raise exception 'The voucher can no longer be changed for this reservation.';
  end if;

  perform set_config('app.voucher_apply', '1', true);
  update public.bookings
     set total = coalesce(voucher_gross_total, total),
         voucher_id = null,
         voucher_code_snapshot = null,
         voucher_discount_amount = 0,
         voucher_gross_total = null
   where ref = any(clean_refs) and voucher_id is not null;
  get diagnostics changed = row_count;

  update public.voucher_redemptions
     set status = 'released', released_at = now(), updated_at = now()
   where booking_group_key = group_key and status = 'reserved';
  return jsonb_build_object('removed', changed > 0);
end;
$$;

create or replace function public.finalize_booking_voucher(p_booking_refs text[], p_customer_email text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare group_key text := public.voucher_booking_group_key(p_booking_refs);
begin
  if not exists (
    select 1 from public.bookings
     where ref = any(p_booking_refs)
       and lower(trim(email)) = lower(trim(p_customer_email))
       and email <> 'reserve@hold.internal'
  ) then raise exception 'Voucher redemption could not be finalized.'; end if;
  update public.voucher_redemptions
     set status = 'redeemed', customer_email = lower(trim(p_customer_email)), redeemed_at = now(), updated_at = now()
   where booking_group_key = group_key and status = 'reserved';
end;
$$;

create or replace function public.sync_booking_voucher_redemption()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.voucher_id is not null
     and old.email = 'reserve@hold.internal'
     and new.email is distinct from old.email
     and nullif(trim(new.email), '') is not null then
    update public.voucher_redemptions
       set status = 'redeemed', customer_email = lower(trim(new.email)),
           redeemed_at = coalesce(redeemed_at, now()), updated_at = now()
     where voucher_id = new.voucher_id
       and new.ref = any(booking_refs)
       and status = 'reserved';
  elsif new.status = 'cancelled' and old.status is distinct from new.status then
    update public.voucher_redemptions redemption
       set status = 'released', released_at = now(), updated_at = now()
     where redemption.status = 'reserved'
       and new.ref = any(redemption.booking_refs)
       and not exists (
         select 1 from public.bookings booking
          where booking.ref = any(redemption.booking_refs)
            and booking.ref <> new.ref
            and booking.status <> 'cancelled'
       );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_booking_voucher_redemption on public.bookings;
create trigger trg_sync_booking_voucher_redemption
after update of email, status on public.bookings
for each row execute function public.sync_booking_voucher_redemption();

grant execute on function public.apply_booking_voucher(text, text[]) to anon, authenticated;
grant execute on function public.remove_booking_voucher(text[]) to anon, authenticated;
grant execute on function public.finalize_booking_voucher(text[], text) to anon, authenticated;
revoke all on function public.release_expired_voucher_reservations() from public, anon, authenticated;

-- Extend the existing public-hold guard so only the security-definer voucher
-- RPC may change price/voucher fields. Normal browser updates stay immutable.
create or replace function public.guard_public_booking_hold_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  request_role text := coalesce(auth.role(), nullif(current_setting('request.jwt.claim.role', true), ''));
  account_role text := public.current_account_role();
  voucher_context boolean := coalesce(current_setting('app.voucher_apply', true), '') = '1';
  service_fee numeric := 0;
  public_due numeric := 0;
  host_due numeric := 0;
begin
  if request_role = 'anon' or (request_role = 'authenticated' and account_role = 'host') then
    if new.ref is distinct from old.ref
      or new.booking_group_ref is distinct from old.booking_group_ref
      or new.court_id is distinct from old.court_id or new.court_name is distinct from old.court_name
      or new.date is distinct from old.date or new.slots is distinct from old.slots
      or new.start_time is distinct from old.start_time or new.end_time is distinct from old.end_time
      or new.duration is distinct from old.duration or new.rate is distinct from old.rate
      or (not voucher_context and new.total is distinct from old.total)
      or (not voucher_context and new.voucher_id is distinct from old.voucher_id)
      or (not voucher_context and new.voucher_code_snapshot is distinct from old.voucher_code_snapshot)
      or (not voucher_context and new.voucher_discount_amount is distinct from old.voucher_discount_amount)
      or (not voucher_context and new.voucher_gross_total is distinct from old.voucher_gross_total)
      or new.created_at is distinct from old.created_at
      or new.host_booking is distinct from old.host_booking or new.host_user_id is distinct from old.host_user_id
      or new.host_name is distinct from old.host_name or new.host_email is distinct from old.host_email
      or new.created_via is distinct from old.created_via or new.created_by_user_id is distinct from old.created_by_user_id
      or new.created_by_role is distinct from old.created_by_role or new.created_by_name is distinct from old.created_by_name
      or new.created_by_email is distinct from old.created_by_email
      or new.payment_provider is distinct from old.payment_provider or new.payment_session_id is distinct from old.payment_session_id
      or new.payment_checkout_url is distinct from old.payment_checkout_url or new.paid_at is distinct from old.paid_at
      or new.receipt_image_url is distinct from old.receipt_image_url or new.receipt_image_hash is distinct from old.receipt_image_hash
      or new.receipt_phash is distinct from old.receipt_phash or new.receipt_status is distinct from old.receipt_status
      or new.receipt_flags is distinct from old.receipt_flags or new.receipt_extracted is distinct from old.receipt_extracted
      or new.receipt_confidence is distinct from old.receipt_confidence or new.receipt_verified_at is distinct from old.receipt_verified_at
      or new.billed_at is distinct from old.billed_at or new.weekly_fee_id is distinct from old.weekly_fee_id
      or new.confirmation_email_id is distinct from old.confirmation_email_id
      or new.confirmation_email_sent_at is distinct from old.confirmation_email_sent_at
      or new.confirmation_email_last_event is distinct from old.confirmation_email_last_event then
      raise exception 'Reservation identity, slot, price, and ownership cannot be changed after a hold is created.';
    end if;
    if new.payment_status not in ('unpaid', 'pending', 'for_verification', 'rejected')
       and not (request_role = 'anon' and old.status = 'verifying' and old.payment_status = 'for_verification'
                and new.status = 'cancelled' and new.payment_status = 'failed') then
      raise exception 'Reservation payment status cannot be approved by the booking client.';
    end if;
  end if;

  if request_role = 'anon' then
    if coalesce(old.host_booking, false) or old.host_user_id is not null or old.created_via <> 'customer' or old.created_by_user_id is not null then
      raise exception 'Anonymous clients may only finalize public customer holds.';
    end if;
    if new.downpayment is not null then
      if old.total is null or old.total < 0 then raise exception 'Reservation payment amount is invalid.'; end if;
      service_fee := least(greatest(coalesce(old.booking_fee_amount_snapshot, 0), 0), old.total);
      public_due := round(service_fee + ((old.total - service_fee) * 0.50), 2);
      if abs(new.downpayment - old.total) > 0.01 and abs(new.downpayment - public_due) > 0.01
         and abs(new.downpayment - (old.total / 2)) > 0.01 and abs(new.downpayment - round(old.total / 2)) > 0.01 then
        raise exception 'Reservation payment amount is invalid. Expected 50%% of the court fee plus the full service fee.';
      end if;
    end if;
  elsif request_role = 'authenticated' and account_role = 'host' then
    if old.status <> 'verifying' or old.created_at is null or old.created_at <= now() - interval '15 minutes'
       or not coalesce(old.host_booking, false) or old.host_user_id is distinct from auth.uid()
       or old.created_via <> 'host' or old.created_by_user_id is distinct from auth.uid() or old.created_by_role <> 'host' then
      raise exception 'Hosts may only finalize their own active booking holds.';
    end if;
    if new.status not in ('verifying', 'pending', 'cancelled') then raise exception 'Host booking hold status transition is invalid.'; end if;
    if new.status = 'pending' and new.downpayment is null then raise exception 'A finalized host booking must store its payment amount.'; end if;
    if new.downpayment is not null then
      if old.total is null or old.total < 0 then raise exception 'Host booking total is invalid.'; end if;
      service_fee := least(greatest(coalesce(old.booking_fee_amount_snapshot, 0), 0), old.total);
      host_due := round(service_fee + ((old.total - service_fee) * 0.25), 2);
      if abs(new.downpayment - old.total) > 0.01 and abs(new.downpayment - host_due) > 0.01 then
        raise exception 'Host payment amount is invalid. Expected 25%% of the court fee plus the full service fee.';
      end if;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_public_booking_hold_update() from public;

comment on table public.vouchers is 'Owner-managed vouchers for normal court bookings.';
comment on column public.bookings.voucher_gross_total is 'Booking total before the court-funded voucher discount.';
comment on column public.bookings.voucher_discount_amount is 'Voucher discount allocated to this booking row; platform fee is excluded.';
