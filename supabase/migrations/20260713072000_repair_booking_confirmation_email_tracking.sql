-- Repair deployments where the booking hold guard was installed before the
-- confirmation-email tracking columns. The guard references these fields on
-- every anonymous hold finalization, so all three must exist together.

alter table if exists public.bookings
  add column if not exists confirmation_email_id text,
  add column if not exists confirmation_email_sent_at timestamptz,
  add column if not exists confirmation_email_last_event text;

create index if not exists idx_bookings_confirmation_email_id
  on public.bookings (confirmation_email_id)
  where confirmation_email_id is not null;
