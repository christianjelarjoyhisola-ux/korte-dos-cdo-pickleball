-- Remaining-balance receipts are separate financial evidence. Never overwrite
-- the deposit receipt/reference stored on public.bookings.

create table if not exists public.host_booking_balance_payments (
  id uuid primary key default gen_random_uuid(),
  verification_ref text not null unique,
  booking_key text not null,
  booking_ref text not null,
  booking_group_ref text,
  booking_refs text[] not null,
  host_user_id uuid not null,
  status text not null default 'created',
  total_amount numeric(12,2) not null,
  original_paid_amount numeric(12,2) not null,
  expected_amount numeric(12,2) not null,
  balance_due_at timestamptz not null,
  expires_at timestamptz not null,
  idempotency_key text not null,
  payment_provider text not null,
  payment_reference text not null,
  customer_name text not null,
  customer_email text,
  booking_date date not null,
  court_label text,
  schedule_label text,
  receipt_verification_id bigint
    references public.receipt_verifications(id) on delete restrict,
  receipt_result text,
  receipt_image_hash text,
  receipt_flags text[] not null default '{}',
  receipt_extracted jsonb,
  receipt_confidence numeric,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by_user_id uuid,
  reviewed_by_role text,
  review_reason text,
  approved_at timestamptz,
  rejected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint host_booking_balance_payments_verification_ref_check
    check (verification_ref ~ '^HBAL-[A-F0-9]{32}$'),
  constraint host_booking_balance_payments_status_check
    check (status in (
      'created', 'pending_review', 'approved', 'rejected', 'expired'
    )),
  constraint host_booking_balance_payments_amounts_check
    check (
      total_amount >= 0
      and original_paid_amount >= 0
      and original_paid_amount <= total_amount
      and expected_amount > 0
      and abs(
        expected_amount - (total_amount - original_paid_amount)
      ) <= 0.01
    ),
  constraint host_booking_balance_payments_refs_check
    check (cardinality(booking_refs) > 0),
  constraint host_booking_balance_payments_idempotency_check
    check (
      char_length(idempotency_key) between 8 and 128
      and idempotency_key !~ '[[:cntrl:]]'
    ),
  constraint host_booking_balance_payments_provider_check
    check (payment_provider in (
      'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
    )),
  constraint host_booking_balance_payments_reference_check
    check (
      char_length(payment_reference) between 4 and 80
      and payment_reference ~ '^[A-Z0-9]+$'
    ),
  constraint host_booking_balance_payments_receipt_result_check
    check (
      receipt_result is null
      or receipt_result in ('auto_approved', 'manual_review', 'rejected')
    ),
  constraint host_booking_balance_payments_receipt_link_check
    check (
      (receipt_verification_id is null and receipt_result is null)
      or (receipt_verification_id is not null and receipt_result is not null)
    ),
  constraint host_booking_balance_payments_terminal_time_check
    check (
      (status <> 'approved' or approved_at is not null)
      and (status <> 'rejected' or rejected_at is not null)
      and (
        status not in ('pending_review', 'approved', 'rejected')
        or submitted_at is not null
      )
    ),
  constraint host_booking_balance_payments_host_idempotency_uq
    unique (host_user_id, idempotency_key),
  constraint host_booking_balance_payments_receipt_uq
    unique (receipt_verification_id)
);

create unique index if not exists host_booking_balance_payments_active_booking_uq
  on public.host_booking_balance_payments (booking_key)
  where status in ('created', 'pending_review');

create index if not exists idx_host_booking_balance_payments_host_created
  on public.host_booking_balance_payments (host_user_id, created_at desc);

create index if not exists idx_host_booking_balance_payments_pending
  on public.host_booking_balance_payments (status, submitted_at)
  where status = 'pending_review';

create index if not exists idx_host_booking_balance_payments_booking_ref
  on public.host_booking_balance_payments (booking_ref);

create or replace function public.touch_host_booking_balance_payment()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists trg_touch_host_booking_balance_payment
  on public.host_booking_balance_payments;
create trigger trg_touch_host_booking_balance_payment
before update on public.host_booking_balance_payments
for each row execute function public.touch_host_booking_balance_payment();

alter table public.host_booking_balance_payments enable row level security;

drop policy if exists host_booking_balance_payments_host_select
  on public.host_booking_balance_payments;
create policy host_booking_balance_payments_host_select
  on public.host_booking_balance_payments
  for select
  to authenticated
  using (
    host_user_id = auth.uid()
    and public.current_account_role() = 'host'
  );

drop policy if exists host_booking_balance_payments_admin_select
  on public.host_booking_balance_payments;
create policy host_booking_balance_payments_admin_select
  on public.host_booking_balance_payments
  for select
  to authenticated
  using (public.has_account_role(array['owner', 'court_owner']));

revoke all on table public.host_booking_balance_payments
  from public, anon, authenticated;
grant select on table public.host_booking_balance_payments to authenticated;
grant all on table public.host_booking_balance_payments to service_role;

create or replace function public.normalize_host_balance_payment_reference(
  p_value text,
  p_provider text
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case lower(coalesce(p_provider, ''))
    when 'gcash' then regexp_replace(coalesce(p_value, ''), '[^0-9]', '', 'g')
    else upper(regexp_replace(coalesce(p_value, ''), '[^A-Za-z0-9]', '', 'g'))
  end
$$;

revoke all on function public.normalize_host_balance_payment_reference(text, text)
  from public, anon, authenticated;
grant execute on function public.normalize_host_balance_payment_reference(text, text)
  to service_role;

create or replace function public.host_booking_balance_payment_payload(
  p_payment public.host_booking_balance_payments
)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', p_payment.id,
    'verificationRef', p_payment.verification_ref,
    'bookingRef', p_payment.booking_ref,
    'bookingGroupRef', p_payment.booking_group_ref,
    'bookingKey', p_payment.booking_key,
    'bookingRefs', to_jsonb(p_payment.booking_refs),
    'hostUserId', p_payment.host_user_id,
    'status', p_payment.status,
    'totalAmount', p_payment.total_amount,
    'originalPaidAmount', p_payment.original_paid_amount,
    'paidAmount', case
      when p_payment.status = 'approved' then p_payment.total_amount
      else p_payment.original_paid_amount
    end,
    'balanceAmount', p_payment.expected_amount,
    'remainingAmount', case
      when p_payment.status = 'approved' then 0
      else p_payment.expected_amount
    end,
    'balanceDueAt', p_payment.balance_due_at,
    'expiresAt', p_payment.expires_at,
    'paymentProvider', p_payment.payment_provider,
    'paymentReference', p_payment.payment_reference,
    'customerName', p_payment.customer_name,
    'customerEmail', p_payment.customer_email,
    'bookingDate', p_payment.booking_date,
    'courtLabel', p_payment.court_label,
    'scheduleLabel', p_payment.schedule_label,
    'receiptVerificationId', p_payment.receipt_verification_id,
    'receiptStatus', p_payment.receipt_result,
    'receiptImageHash', p_payment.receipt_image_hash,
    'receiptFlags', to_jsonb(p_payment.receipt_flags),
    'receiptExtracted', p_payment.receipt_extracted,
    'receiptConfidence', p_payment.receipt_confidence,
    'submittedAt', p_payment.submitted_at,
    'reviewedAt', p_payment.reviewed_at,
    'reviewedByUserId', p_payment.reviewed_by_user_id,
    'reviewedByRole', p_payment.reviewed_by_role,
    'reviewReason', p_payment.review_reason,
    'approvedAt', p_payment.approved_at,
    'rejectedAt', p_payment.rejected_at,
    'createdAt', p_payment.created_at,
    'updatedAt', p_payment.updated_at
  )
$$;

revoke all on function public.host_booking_balance_payment_payload(
  public.host_booking_balance_payments
) from public, anon, authenticated;
grant execute on function public.host_booking_balance_payment_payload(
  public.host_booking_balance_payments
) to service_role;

create or replace function public.quote_host_booking_balance_payment(
  p_booking_lookup text,
  p_host_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lookup text := nullif(btrim(coalesce(p_booking_lookup, '')), '');
  v_anchor_ref text;
  v_group_ref text;
  v_booking_key text;
  v_booking_refs text[];
  v_row_count integer;
  v_owned boolean;
  v_confirmed boolean;
  v_deposit_paid boolean;
  v_positive_balances boolean;
  v_all_deadlines boolean;
  v_total numeric(12,2);
  v_paid numeric(12,2);
  v_balance numeric(12,2);
  v_due_at timestamptz;
  v_customer_name text;
  v_customer_email text;
  v_booking_date date;
  v_court_label text;
  v_schedule_label text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the balance payment service may quote a balance.'
      using errcode = '42501';
  end if;
  if v_lookup is null or char_length(v_lookup) > 160 then
    raise exception 'A valid booking reference is required.'
      using errcode = '22023';
  end if;
  if p_host_user_id is null or not exists (
    select 1
    from public.accounts a
    where a.id = p_host_user_id
      and a.role = 'host'
      and a.status = 'active'
  ) then
    raise exception 'An active host account is required.'
      using errcode = '42501';
  end if;

  select b.ref, nullif(btrim(coalesce(b.booking_group_ref, '')), '')
    into v_anchor_ref, v_group_ref
  from public.bookings b
  where b.ref = v_lookup
     or nullif(btrim(coalesce(b.booking_group_ref, '')), '') = v_lookup
  order by case when b.ref = v_lookup then 0 else 1 end, b.ref
  limit 1;

  if v_anchor_ref is null then
    raise exception 'Booking was not found.' using errcode = 'P0002';
  end if;
  v_booking_key := coalesce(v_group_ref, v_anchor_ref);

  select
    count(*)::integer,
    array_agg(b.ref order by b.ref),
    bool_and(
      coalesce(b.host_booking, false)
      and b.host_user_id = p_host_user_id
    ),
    bool_and(b.status = 'confirmed'),
    bool_and(b.payment_status = 'downpayment_paid'),
    bool_and(
      b.total is not null
      and b.downpayment is not null
      and round(b.total - b.downpayment, 2) > 0
    ),
    bool_and(b.balance_due_at is not null),
    round(sum(coalesce(b.total, 0)), 2),
    round(sum(coalesce(b.downpayment, 0)), 2),
    min(b.balance_due_at),
    min(coalesce(nullif(btrim(b.host_name), ''), b.full_name)),
    min(coalesce(nullif(btrim(b.host_email), ''), nullif(btrim(b.email), ''))),
    min(b.date),
    string_agg(
      distinct coalesce(nullif(btrim(b.court_name), ''), b.court_id),
      ', '
      order by coalesce(nullif(btrim(b.court_name), ''), b.court_id)
    ),
    string_agg(
      distinct concat(
        b.date::text,
        case
          when nullif(btrim(coalesce(b.start_time, '')), '') is null then ''
          else ' ' || btrim(b.start_time)
        end
      ),
      ', '
      order by concat(
        b.date::text,
        case
          when nullif(btrim(coalesce(b.start_time, '')), '') is null then ''
          else ' ' || btrim(b.start_time)
        end
      )
    )
    into
      v_row_count,
      v_booking_refs,
      v_owned,
      v_confirmed,
      v_deposit_paid,
      v_positive_balances,
      v_all_deadlines,
      v_total,
      v_paid,
      v_due_at,
      v_customer_name,
      v_customer_email,
      v_booking_date,
      v_court_label,
      v_schedule_label
  from public.bookings b
  where (
    v_group_ref is not null
    and nullif(btrim(coalesce(b.booking_group_ref, '')), '') = v_group_ref
  ) or (
    v_group_ref is null
    and b.ref = v_anchor_ref
  );

  if v_row_count = 0 or not coalesce(v_owned, false) then
    raise exception 'This host does not own the requested booking.'
      using errcode = '42501';
  end if;
  if not coalesce(v_confirmed, false)
     or not coalesce(v_deposit_paid, false) then
    raise exception 'Only confirmed bookings with a paid deposit are eligible.'
      using errcode = '22023';
  end if;
  if not coalesce(v_positive_balances, false) then
    raise exception 'This booking has no remaining balance.'
      using errcode = '22023';
  end if;
  if not coalesce(v_all_deadlines, false) or v_due_at is null then
    raise exception 'This booking does not have a balance deadline.'
      using errcode = '22023';
  end if;
  if clock_timestamp() >= v_due_at then
    raise exception 'The remaining-balance deadline has passed.'
      using errcode = 'P0001';
  end if;

  v_balance := round(v_total - v_paid, 2);
  if v_balance <= 0 then
    raise exception 'This booking has no remaining balance.'
      using errcode = '22023';
  end if;

  return jsonb_build_object(
    'bookingRef', v_anchor_ref,
    'bookingGroupRef', v_group_ref,
    'bookingKey', v_booking_key,
    'bookingRefs', to_jsonb(v_booking_refs),
    'totalAmount', v_total,
    'originalPaidAmount', v_paid,
    'paidAmount', v_paid,
    'balanceAmount', v_balance,
    'remainingAmount', v_balance,
    'balanceDueAt', v_due_at,
    'customerName', v_customer_name,
    'customerEmail', v_customer_email,
    'bookingDate', v_booking_date,
    'courtLabel', v_court_label,
    'scheduleLabel', v_schedule_label,
    'canPay', true
  );
end;
$$;

revoke all on function public.quote_host_booking_balance_payment(text, uuid)
  from public, anon, authenticated;
grant execute on function public.quote_host_booking_balance_payment(text, uuid)
  to service_role;

create or replace function public.create_host_booking_balance_payment(
  p_booking_lookup text,
  p_host_user_id uuid,
  p_idempotency_key text,
  p_provider text,
  p_payment_reference text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lookup text := nullif(btrim(coalesce(p_booking_lookup, '')), '');
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_provider text := lower(btrim(coalesce(p_provider, '')));
  v_reference text;
  v_quote jsonb;
  v_locked_quote jsonb;
  v_refs text[];
  v_locked_refs text[];
  v_existing public.host_booking_balance_payments%rowtype;
  v_payment public.host_booking_balance_payments%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the balance payment service may create a payment.'
      using errcode = '42501';
  end if;
  if char_length(v_key) not between 8 and 128
     or v_key ~ '[[:cntrl:]]' then
    raise exception 'A valid idempotency key is required.'
      using errcode = '22023';
  end if;
  if v_provider not in (
    'gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'
  ) then
    raise exception 'A supported payment provider is required.'
      using errcode = '22023';
  end if;
  v_reference := public.normalize_host_balance_payment_reference(
    p_payment_reference,
    v_provider
  );
  if char_length(v_reference) not between 4 and 80 then
    raise exception 'A valid payment reference is required.'
      using errcode = '22023';
  end if;

  select *
    into v_existing
  from public.host_booking_balance_payments p
  where p.host_user_id = p_host_user_id
    and p.idempotency_key = v_key
  for update;
  if found then
    if v_existing.payment_provider <> v_provider
       or v_existing.payment_reference <> v_reference
       or not (
         v_lookup = v_existing.booking_key
         or v_lookup = v_existing.booking_ref
         or v_lookup = v_existing.booking_group_ref
         or v_lookup = any(v_existing.booking_refs)
       ) then
      raise exception 'This idempotency key belongs to a different request.'
        using errcode = '23505';
    end if;
    return public.host_booking_balance_payment_payload(v_existing);
  end if;

  v_quote := public.quote_host_booking_balance_payment(
    v_lookup,
    p_host_user_id
  );

  -- Keep the global lock order payment-attempt -> booking rows. Submit/review
  -- use that same order, preventing a create/submit deadlock.
  update public.host_booking_balance_payments p
     set status = 'expired'
   where p.booking_key = v_quote->>'bookingKey'
     and p.status = 'created'
     and (
       p.expires_at <= v_now
       or p.balance_due_at <= v_now
     );

  select *
    into v_existing
  from public.host_booking_balance_payments p
  where p.booking_key = v_quote->>'bookingKey'
    and p.status in ('created', 'pending_review')
  for update;
  if found then
    if v_existing.host_user_id <> p_host_user_id then
      raise exception 'An active payment request already exists.'
        using errcode = '23505';
    end if;
    if v_existing.payment_provider <> v_provider
       or v_existing.payment_reference <> v_reference then
      raise exception
        'An active request already uses a different payment reference.'
        using errcode = '23505';
    end if;
    return public.host_booking_balance_payment_payload(v_existing);
  end if;

  select coalesce(array_agg(value order by value), array[]::text[])
    into v_refs
  from jsonb_array_elements_text(v_quote->'bookingRefs');

  perform 1
  from public.bookings b
  where b.ref = any(v_refs)
  order by b.ref
  for update;

  v_locked_quote := public.quote_host_booking_balance_payment(
    v_lookup,
    p_host_user_id
  );
  select coalesce(array_agg(value order by value), array[]::text[])
    into v_locked_refs
  from jsonb_array_elements_text(v_locked_quote->'bookingRefs');
  if v_refs is distinct from v_locked_refs then
    raise exception 'The booking group changed; retry the request.'
      using errcode = '40001';
  end if;
  v_quote := v_locked_quote;

  -- A competing creator may have committed while this request waited for the
  -- booking locks. This second lookup is deliberately non-locking: no attempt
  -- row is mutated below unless this transaction inserts it.
  select *
    into v_existing
  from public.host_booking_balance_payments p
  where p.booking_key = v_quote->>'bookingKey'
    and p.status in ('created', 'pending_review');
  if found then
    if v_existing.host_user_id <> p_host_user_id then
      raise exception 'An active payment request already exists.'
        using errcode = '23505';
    end if;
    if v_existing.payment_provider <> v_provider
       or v_existing.payment_reference <> v_reference then
      raise exception
        'An active request already uses a different payment reference.'
        using errcode = '23505';
    end if;
    return public.host_booking_balance_payment_payload(v_existing);
  end if;

  begin
    insert into public.host_booking_balance_payments (
      verification_ref,
      booking_key,
      booking_ref,
      booking_group_ref,
      booking_refs,
      host_user_id,
      total_amount,
      original_paid_amount,
      expected_amount,
      balance_due_at,
      expires_at,
      idempotency_key,
      payment_provider,
      payment_reference,
      customer_name,
      customer_email,
      booking_date,
      court_label,
      schedule_label
    )
    values (
      'HBAL-' || upper(replace(gen_random_uuid()::text, '-', '')),
      v_quote->>'bookingKey',
      v_quote->>'bookingRef',
      nullif(v_quote->>'bookingGroupRef', ''),
      v_refs,
      p_host_user_id,
      (v_quote->>'totalAmount')::numeric,
      (v_quote->>'originalPaidAmount')::numeric,
      (v_quote->>'balanceAmount')::numeric,
      (v_quote->>'balanceDueAt')::timestamptz,
      least(
        (v_quote->>'balanceDueAt')::timestamptz,
        v_now + interval '15 minutes'
      ),
      v_key,
      v_provider,
      v_reference,
      coalesce(nullif(v_quote->>'customerName', ''), 'Host'),
      nullif(v_quote->>'customerEmail', ''),
      (v_quote->>'bookingDate')::date,
      nullif(v_quote->>'courtLabel', ''),
      nullif(v_quote->>'scheduleLabel', '')
    )
    returning * into v_payment;
  exception when unique_violation then
    select *
      into v_payment
    from public.host_booking_balance_payments p
    where (
      p.host_user_id = p_host_user_id
      and p.idempotency_key = v_key
    ) or (
      p.booking_key = v_quote->>'bookingKey'
      and p.status in ('created', 'pending_review')
    )
    order by case
      when p.host_user_id = p_host_user_id
       and p.idempotency_key = v_key then 0
      else 1
    end
    limit 1;
    if v_payment.id is null then raise; end if;
  end;

  if v_payment.host_user_id <> p_host_user_id
     or v_payment.payment_provider <> v_provider
     or v_payment.payment_reference <> v_reference
     or not (
       v_lookup = v_payment.booking_key
       or v_lookup = v_payment.booking_ref
       or v_lookup = v_payment.booking_group_ref
       or v_lookup = any(v_payment.booking_refs)
     ) then
    raise exception 'A conflicting balance payment request already exists.'
      using errcode = '23505';
  end if;

  return public.host_booking_balance_payment_payload(v_payment);
end;
$$;

revoke all on function public.create_host_booking_balance_payment(
  text, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_host_booking_balance_payment(
  text, uuid, text, text, text
) to service_role;

create or replace function public.assert_host_booking_balance_receipt_audit(
  p_payment_id uuid,
  p_receipt_verification_id bigint
)
returns public.receipt_verifications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.host_booking_balance_payments%rowtype;
  v_audit public.receipt_verifications%rowtype;
  v_expected_amount numeric;
  v_expected_total numeric;
  v_reference text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the balance payment service may validate an audit.'
      using errcode = '42501';
  end if;

  select * into v_payment
  from public.host_booking_balance_payments p
  where p.id = p_payment_id;
  if v_payment.id is null then
    raise exception 'Balance payment was not found.' using errcode = 'P0002';
  end if;

  select * into v_audit
  from public.receipt_verifications r
  where r.id = p_receipt_verification_id
    and r.booking_ref = v_payment.verification_ref;
  if v_audit.id is null then
    raise exception 'Receipt verification does not belong to this balance payment.'
      using errcode = '22023';
  end if;
  if v_audit.result not in ('auto_approved', 'manual_review', 'rejected')
     or nullif(btrim(coalesce(v_audit.image_hash, '')), '') is null
     or v_audit.created_at < v_payment.created_at - interval '5 seconds' then
    raise exception 'Receipt verification is incomplete or invalid.'
      using errcode = '22023';
  end if;
  if coalesce(v_audit.extracted->>'verificationContext', '') <>
       'host_booking_balance'
     or coalesce(v_audit.extracted->>'balancePaymentId', '') <>
       v_payment.id::text
     or lower(coalesce(v_audit.extracted->>'provider', '')) <>
       v_payment.payment_provider then
    raise exception 'Receipt verification context does not match this payment.'
      using errcode = '22023';
  end if;

  begin
    v_expected_amount := (v_audit.extracted->>'expectedAmount')::numeric;
    v_expected_total := (v_audit.extracted->>'expectedTotal')::numeric;
  exception when others then
    raise exception 'Receipt verification amount is missing or invalid.'
      using errcode = '22023';
  end;
  if abs(v_expected_amount - v_payment.expected_amount) > 0.01
     or abs(v_expected_total - v_payment.expected_amount) > 0.01 then
    raise exception 'Receipt verification amount does not match the balance due.'
      using errcode = '22023';
  end if;

  v_reference := public.normalize_host_balance_payment_reference(
    v_audit.extracted->>'submittedReference',
    v_payment.payment_provider
  );
  if v_reference <> v_payment.payment_reference then
    raise exception 'Receipt verification reference does not match this payment.'
      using errcode = '22023';
  end if;

  return v_audit;
end;
$$;

revoke all on function public.assert_host_booking_balance_receipt_audit(
  uuid, bigint
) from public, anon, authenticated;
grant execute on function public.assert_host_booking_balance_receipt_audit(
  uuid, bigint
) to service_role;

create or replace function public.apply_host_booking_balance_payment_decision(
  p_payment_id uuid,
  p_decision text,
  p_actor_user_id uuid,
  p_actor_role text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_decision text := lower(btrim(coalesce(p_decision, '')));
  v_actor_role text := lower(btrim(coalesce(p_actor_role, '')));
  v_reason text := nullif(
    left(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]', ' ', 'g'), 1000),
    ''
  );
  v_payment public.host_booking_balance_payments%rowtype;
  v_audit public.receipt_verifications%rowtype;
  v_count integer;
  v_group_count integer;
  v_total numeric(12,2);
  v_paid numeric(12,2);
  v_valid boolean;
  v_rows_updated integer;
  v_ledger record;
  v_ledger_owner text;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the balance payment service may review a payment.'
      using errcode = '42501';
  end if;
  if v_decision not in ('approve', 'reject') then
    raise exception 'Decision must be approve or reject.'
      using errcode = '22023';
  end if;
  if v_actor_role in ('owner', 'court_owner') then
    if p_actor_user_id is null or not exists (
      select 1
      from public.accounts a
      where a.id = p_actor_user_id
        and a.status = 'active'
        and a.role = v_actor_role
    ) then
      raise exception 'An active owner or court owner is required.'
        using errcode = '42501';
    end if;
  elsif v_actor_role = 'system' then
    if p_actor_user_id is not null then
      raise exception 'System decisions cannot impersonate a user.'
        using errcode = '42501';
    end if;
  else
    raise exception 'This account cannot review balance payments.'
      using errcode = '42501';
  end if;
  if v_decision = 'reject' and char_length(coalesce(v_reason, '')) < 3 then
    raise exception 'A rejection reason of at least 3 characters is required.'
      using errcode = '22023';
  end if;

  select * into v_payment
  from public.host_booking_balance_payments p
  where p.id = p_payment_id
  for update;
  if v_payment.id is null then
    raise exception 'Balance payment was not found.' using errcode = 'P0002';
  end if;

  if v_payment.status = 'approved' then
    if v_decision <> 'approve' then
      raise exception 'An approved balance payment cannot be rejected.'
        using errcode = 'P0001';
    end if;
    return public.host_booking_balance_payment_payload(v_payment);
  end if;
  if v_payment.status = 'rejected' then
    if v_decision <> 'reject' then
      raise exception 'A rejected balance payment cannot be approved.'
        using errcode = 'P0001';
    end if;
    return public.host_booking_balance_payment_payload(v_payment);
  end if;
  if v_payment.status <> 'pending_review'
     or v_payment.receipt_verification_id is null
     or v_payment.submitted_at is null then
    raise exception 'This balance payment is not awaiting review.'
      using errcode = 'P0001';
  end if;
  if v_payment.submitted_at > v_payment.balance_due_at then
    raise exception 'The receipt was submitted after the balance deadline.'
      using errcode = 'P0001';
  end if;

  v_audit := public.assert_host_booking_balance_receipt_audit(
    v_payment.id,
    v_payment.receipt_verification_id
  );
  if v_decision = 'approve' and v_audit.result = 'rejected' then
    raise exception 'A rejected automatic verification cannot be approved.'
      using errcode = '22023';
  end if;
  if v_actor_role = 'system'
     and (v_decision <> 'approve' or v_audit.result <> 'auto_approved') then
    raise exception 'System approval requires an auto-approved receipt audit.'
      using errcode = '42501';
  end if;

  if v_decision = 'reject' then
    update public.host_booking_balance_payments
       set status = 'rejected',
           reviewed_at = v_now,
           reviewed_by_user_id = p_actor_user_id,
           reviewed_by_role = v_actor_role,
           review_reason = v_reason,
           rejected_at = v_now
     where id = v_payment.id
     returning * into v_payment;
    return public.host_booking_balance_payment_payload(v_payment);
  end if;

  perform 1
  from public.bookings b
  where b.ref = any(v_payment.booking_refs)
  order by b.ref
  for update;

  select
    count(*)::integer,
    round(sum(coalesce(b.total, 0)), 2),
    round(sum(coalesce(b.downpayment, 0)), 2),
    bool_and(
      coalesce(b.host_booking, false)
      and b.host_user_id = v_payment.host_user_id
      and b.status = 'confirmed'
      and b.payment_status = 'downpayment_paid'
      and b.total is not null
      and b.downpayment is not null
      and round(b.total - b.downpayment, 2) > 0
      and coalesce(nullif(btrim(b.booking_group_ref), ''), b.ref) =
          v_payment.booking_key
    )
    into v_count, v_total, v_paid, v_valid
  from public.bookings b
  where b.ref = any(v_payment.booking_refs);

  select count(*)::integer
    into v_group_count
  from public.bookings b
  where coalesce(nullif(btrim(b.booking_group_ref), ''), b.ref) =
        v_payment.booking_key;

  if v_count <> cardinality(v_payment.booking_refs)
     or v_group_count <> cardinality(v_payment.booking_refs)
     or not coalesce(v_valid, false)
     or abs(v_total - v_payment.total_amount) > 0.01
     or abs(v_paid - v_payment.original_paid_amount) > 0.01
     or abs((v_total - v_paid) - v_payment.expected_amount) > 0.01 then
    raise exception 'The booking group no longer matches the submitted balance.'
      using errcode = 'P0001';
  end if;

  for v_ledger in
    select *
    from public.payment_review_ledger_keys(
      v_audit.extracted,
      v_payment.payment_provider,
      v_payment.payment_reference
    )
  loop
    insert into public.used_gcash_refs (
      gcash_ref,
      booking_ref,
      provider
    )
    values (
      v_ledger.ledger_key,
      v_payment.verification_ref,
      v_ledger.provider_key
    )
    on conflict (gcash_ref) do nothing;

    select u.booking_ref into v_ledger_owner
    from public.used_gcash_refs u
    where u.gcash_ref = v_ledger.ledger_key;
    if v_ledger_owner is distinct from v_payment.verification_ref then
      raise exception 'This payment reference was already used.'
        using errcode = '23505';
    end if;
  end loop;

  update public.bookings b
     set payment_status = 'paid',
         downpayment = b.total
   where b.ref = any(v_payment.booking_refs)
     and b.status = 'confirmed'
     and b.payment_status = 'downpayment_paid';
  get diagnostics v_rows_updated = row_count;
  if v_rows_updated <> cardinality(v_payment.booking_refs) then
    raise exception 'The booking group changed while applying the payment.'
      using errcode = '40001';
  end if;

  update public.host_booking_balance_payments
     set status = 'approved',
         reviewed_at = v_now,
         reviewed_by_user_id = p_actor_user_id,
         reviewed_by_role = v_actor_role,
         review_reason = coalesce(
           v_reason,
           case
             when v_actor_role = 'system'
               then 'Receipt automatically verified.'
             else 'Receipt reviewed and remaining balance confirmed.'
           end
         ),
         approved_at = v_now
   where id = v_payment.id
   returning * into v_payment;

  return public.host_booking_balance_payment_payload(v_payment);
end;
$$;

revoke all on function public.apply_host_booking_balance_payment_decision(
  uuid, text, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.apply_host_booking_balance_payment_decision(
  uuid, text, uuid, text, text
) to service_role;

create or replace function public.submit_host_booking_balance_payment(
  p_payment_id uuid,
  p_host_user_id uuid,
  p_receipt_verification_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.host_booking_balance_payments%rowtype;
  v_audit public.receipt_verifications%rowtype;
  v_count integer;
  v_group_count integer;
  v_total numeric(12,2);
  v_paid numeric(12,2);
  v_valid boolean;
  v_all_deadlines boolean;
  v_current_due_at timestamptz;
  v_now timestamptz := clock_timestamp();
  v_reason text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the balance payment service may submit a receipt.'
      using errcode = '42501';
  end if;
  if p_host_user_id is null or not exists (
    select 1
    from public.accounts a
    where a.id = p_host_user_id
      and a.role = 'host'
      and a.status = 'active'
  ) then
    raise exception 'An active host account is required.'
      using errcode = '42501';
  end if;

  select * into v_payment
  from public.host_booking_balance_payments p
  where p.id = p_payment_id
  for update;
  if v_payment.id is null then
    raise exception 'Balance payment was not found.' using errcode = 'P0002';
  end if;
  if v_payment.host_user_id <> p_host_user_id then
    raise exception 'This host does not own the balance payment.'
      using errcode = '42501';
  end if;

  if v_payment.status in ('pending_review', 'approved', 'rejected') then
    if v_payment.receipt_verification_id = p_receipt_verification_id then
      return public.host_booking_balance_payment_payload(v_payment);
    end if;
    raise exception 'This payment was already submitted with another receipt.'
      using errcode = '23505';
  end if;
  if v_payment.status <> 'created' then
    raise exception 'This balance payment is no longer active.'
      using errcode = 'P0001';
  end if;
  if v_now >= v_payment.balance_due_at then
    update public.host_booking_balance_payments
       set status = 'expired'
     where id = v_payment.id
     returning * into v_payment;
    return public.host_booking_balance_payment_payload(v_payment);
  end if;

  perform 1
  from public.bookings b
  where b.ref = any(v_payment.booking_refs)
  order by b.ref
  for update;
  select
    count(*)::integer,
    round(sum(coalesce(b.total, 0)), 2),
    round(sum(coalesce(b.downpayment, 0)), 2),
    bool_and(b.balance_due_at is not null),
    min(b.balance_due_at),
    bool_and(
      coalesce(b.host_booking, false)
      and b.host_user_id = p_host_user_id
      and b.status = 'confirmed'
      and b.payment_status = 'downpayment_paid'
      and b.total is not null
      and b.downpayment is not null
      and round(b.total - b.downpayment, 2) > 0
      and coalesce(nullif(btrim(b.booking_group_ref), ''), b.ref) =
          v_payment.booking_key
    )
    into
      v_count,
      v_total,
      v_paid,
      v_all_deadlines,
      v_current_due_at,
      v_valid
  from public.bookings b
  where b.ref = any(v_payment.booking_refs);

  select count(*)::integer
    into v_group_count
  from public.bookings b
  where coalesce(nullif(btrim(b.booking_group_ref), ''), b.ref) =
        v_payment.booking_key;

  if v_count <> cardinality(v_payment.booking_refs)
     or v_group_count <> cardinality(v_payment.booking_refs)
     or not coalesce(v_valid, false)
     or not coalesce(v_all_deadlines, false)
     or v_current_due_at is distinct from v_payment.balance_due_at
     or v_now >= v_current_due_at
     or abs(v_total - v_payment.total_amount) > 0.01
     or abs(v_paid - v_payment.original_paid_amount) > 0.01
     or abs((v_total - v_paid) - v_payment.expected_amount) > 0.01 then
    raise exception 'The booking group no longer matches this payment attempt.'
      using errcode = 'P0001';
  end if;

  v_audit := public.assert_host_booking_balance_receipt_audit(
    v_payment.id,
    p_receipt_verification_id
  );

  if v_audit.result = 'rejected' then
    v_reason := coalesce(
      nullif(array_to_string(v_audit.flags, ', '), ''),
      'Receipt verification rejected.'
    );
    update public.host_booking_balance_payments
       set status = 'rejected',
           receipt_verification_id = v_audit.id,
           receipt_result = v_audit.result,
           receipt_image_hash = v_audit.image_hash,
           receipt_flags = coalesce(v_audit.flags, array[]::text[]),
           receipt_extracted = v_audit.extracted,
           receipt_confidence = v_audit.confidence,
           submitted_at = v_now,
           reviewed_at = v_now,
           reviewed_by_role = 'system',
           review_reason = v_reason,
           rejected_at = v_now
     where id = v_payment.id
     returning * into v_payment;
    return public.host_booking_balance_payment_payload(v_payment);
  end if;

  update public.host_booking_balance_payments
     set status = 'pending_review',
         receipt_verification_id = v_audit.id,
         receipt_result = v_audit.result,
         receipt_image_hash = v_audit.image_hash,
         receipt_flags = coalesce(v_audit.flags, array[]::text[]),
         receipt_extracted = v_audit.extracted,
         receipt_confidence = v_audit.confidence,
         submitted_at = v_now
   where id = v_payment.id
   returning * into v_payment;

  if v_audit.result = 'auto_approved' then
    return public.apply_host_booking_balance_payment_decision(
      v_payment.id,
      'approve',
      null,
      'system',
      'Receipt automatically verified.'
    );
  end if;
  return public.host_booking_balance_payment_payload(v_payment);
end;
$$;

revoke all on function public.submit_host_booking_balance_payment(
  uuid, uuid, bigint
) from public, anon, authenticated;
grant execute on function public.submit_host_booking_balance_payment(
  uuid, uuid, bigint
) to service_role;

-- A receipt submitted before the deadline remains eligible while an owner is
-- reviewing it. A rejection releases this hold and the next processor run can
-- forfeit the booking normally.
create or replace function public.forfeit_overdue_host_booking(p_booking_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the balance processor may forfeit reservations.'
      using errcode = '42501';
  end if;

  -- Serialize against a submit/review already holding the attempt row. The
  -- winner then locks bookings second, matching the payment RPC lock order.
  perform 1
  from public.host_booking_balance_payments p
  where (
    p.booking_key = p_booking_key
    or p.booking_ref = p_booking_key
    or p_booking_key = any(p.booking_refs)
  )
    and p.status in ('created', 'pending_review')
  order by p.created_at
  for update;

  with changed as (
    update public.bookings b
       set status = 'forfeited',
           payment_status = 'deposit_retained',
           forfeited_at = clock_timestamp(),
           forfeiture_reason =
             'Remaining balance was not paid by the deadline.'
     where coalesce(b.host_booking, false)
       and (b.ref = p_booking_key or b.booking_group_ref = p_booking_key)
       and b.status = 'confirmed'
       and b.payment_status = 'downpayment_paid'
       and exists (
         select 1
         from public.bookings due
         where coalesce(due.host_booking, false)
           and (
             due.ref = p_booking_key
             or due.booking_group_ref = p_booking_key
           )
           and due.status = 'confirmed'
           and due.payment_status = 'downpayment_paid'
           and due.balance_due_at <= clock_timestamp()
       )
       and not exists (
         select 1
         from public.host_booking_balance_payments p
         where p.booking_key =
               coalesce(nullif(btrim(b.booking_group_ref), ''), b.ref)
           and p.status = 'pending_review'
           and p.submitted_at is not null
           and p.submitted_at <= p.balance_due_at
       )
    returning b.ref
  )
  select jsonb_build_object(
    'changed',
    count(*),
    'refs',
    coalesce(jsonb_agg(ref), '[]'::jsonb)
  )
    into result
  from changed;

  return coalesce(
    result,
    jsonb_build_object('changed', 0, 'refs', '[]'::jsonb)
  );
end;
$$;

revoke all on function public.forfeit_overdue_host_booking(text)
  from public, anon, authenticated;
grant execute on function public.forfeit_overdue_host_booking(text)
  to service_role;

comment on table public.host_booking_balance_payments is
  'Immutable-snapshot workflow for a host remaining-balance receipt. Deposit evidence stays on bookings; balance evidence is linked through receipt_verification_id.';
comment on function public.submit_host_booking_balance_payment(uuid, uuid, bigint)
  is 'Claims a context-bound receipt audit. Auto-approved audits pay the whole locked booking group; manual audits wait for owner review.';
