-- Keep automatic approval for clean host-balance receipts, but do not prevent
-- a host from submitting reviewable OCR or payment-detail mismatches. The
-- immutable flags remain attached to the audit for the court owner's decision.
-- Payment replay and missing/unreadable image evidence remain terminal blocks.

create or replace function public.route_host_balance_receipt_for_owner_review()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_blocking_flags constant text[] := array[
    'DUPLICATE_REF',
    'DUPLICATE_INVOICE',
    'DUPLICATE_INSTAPAY_REF',
    'DUPLICATE_BPI_TRANSACTION_REF',
    'DUPLICATE_MARIBANK_TRANSACTION',
    'IMAGE_UNREADABLE'
  ]::text[];
begin
  if new.result = 'rejected'
     and coalesce(new.extracted->>'verificationContext', '') =
         'host_booking_balance'
     and not coalesce(new.flags, array[]::text[]) && v_blocking_flags then
    new.extracted := coalesce(new.extracted, '{}'::jsonb) || jsonb_build_object(
      'automaticResult', 'rejected',
      'reviewRouting', 'pending_owner_review'
    );
    new.result := 'manual_review';
  end if;
  return new;
end;
$$;

revoke all on function public.route_host_balance_receipt_for_owner_review()
  from public, anon, authenticated;

drop trigger if exists route_host_balance_receipt_for_owner_review
  on public.receipt_verifications;
create trigger route_host_balance_receipt_for_owner_review
before insert on public.receipt_verifications
for each row
execute function public.route_host_balance_receipt_for_owner_review();

comment on function public.route_host_balance_receipt_for_owner_review() is
  'Routes reviewable host balance receipt flags to an owner while retaining automatic approval for clean receipts and terminal rejection for replay/unreadable evidence.';
