-- Remaining-balance receipts use the same private owner-review notification
-- outbox as initial booking and registration receipts.

alter table public.payment_review_notifications
  drop constraint if exists payment_review_notifications_context_check;

alter table public.payment_review_notifications
  add constraint payment_review_notifications_context_check
  check (context_type in (
    'court_booking',
    'open_play',
    'host_session',
    'host_booking_balance'
  ));

-- Recover pending balance receipts created before this context was supported.
-- The stable payment id makes this idempotent across repeated migration runs.
insert into public.payment_review_notifications (
  dedupe_key,
  receipt_verification_id,
  booking_ref,
  booking_group_ref,
  context_type,
  image_hash,
  payment_provider,
  payment_reference_masked,
  recipient_email,
  payload,
  status,
  attempt_count,
  next_attempt_at
)
select
  'payment-review:host-balance:' || replace(payment.id::text, '-', ''),
  payment.receipt_verification_id,
  payment.verification_ref,
  payment.booking_group_ref,
  'host_booking_balance',
  lower(payment.receipt_image_hash),
  payment.payment_provider,
  '••••' || right(payment.payment_reference, 4),
  lower(btrim(setting.value)),
  jsonb_build_object(
    'bookingRef', payment.verification_ref,
    'bookingGroupRef', payment.booking_group_ref,
    'contextType', 'host_booking_balance',
    'receiptVerificationId', payment.receipt_verification_id,
    'fullName', payment.customer_name,
    'provider', payment.payment_provider,
    'paymentReferenceMasked', '••••' || right(payment.payment_reference, 4),
    'imageHash', lower(payment.receipt_image_hash),
    'flags', to_jsonb(coalesce(payment.receipt_flags, array[]::text[])),
    'expectedAmount', payment.expected_amount,
    'extractedAmount', case
      when coalesce(payment.receipt_extracted->>'amount', '')
        ~ '^[0-9]+([.][0-9]+)?$'
      then (payment.receipt_extracted->>'amount')::numeric
      else null
    end,
    'courtLabel', payment.court_label,
    'scheduleLabel', payment.schedule_label
  ),
  'pending',
  0,
  clock_timestamp()
from public.host_booking_balance_payments payment
join public.private_settings setting
  on setting.key = 'payment_review_notification_email'
 and nullif(btrim(setting.value), '') is not null
where payment.status = 'pending_review'
  and payment.receipt_verification_id is not null
  and lower(coalesce(payment.receipt_image_hash, '')) ~ '^[a-f0-9]{64}$'
on conflict (dedupe_key) do nothing;

comment on constraint payment_review_notifications_context_check
  on public.payment_review_notifications is
  'Allows review alerts for initial receipts, registrations, and remaining booking balances.';
