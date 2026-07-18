-- Keep provider ids for customer confirmation emails so Resend logs can be
-- matched back to booking rows exactly.

alter table public.bookings
  add column if not exists confirmation_email_id text,
  add column if not exists confirmation_email_sent_at timestamptz,
  add column if not exists confirmation_email_last_event text;

create index if not exists idx_bookings_confirmation_email_id
  on public.bookings (confirmation_email_id)
  where confirmation_email_id is not null;
