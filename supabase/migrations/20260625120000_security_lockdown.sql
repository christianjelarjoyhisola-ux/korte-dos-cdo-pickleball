-- ============================================================
-- 20260625120000_security_lockdown.sql
-- Security lockdown for public booking data and admin role access.
--
-- Goals:
--   * Public users can see availability, not personal booking rows.
--   * Admin/staff/court-owner users must be authenticated through Supabase Auth.
--   * Sensitive table changes leave a minimal audit trail.
--   * Old receipt/payment metadata can be purged on a retention schedule.
-- ============================================================

-- ---------- Role helpers ----------
create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select a.role
      from public.accounts a
      where a.id = auth.uid()
         or lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      limit 1
    ),
    case
      when auth.role() = 'service_role' then 'service_role'
      when auth.uid() is null then 'anon'
      else 'authenticated'
    end
  );
$$;

create or replace function public.is_system_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select public.current_app_role() = 'owner'; $$;

create or replace function public.is_app_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select public.current_app_role() in ('owner','court_owner','staff'); $$;

create or replace function public.is_app_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select public.current_app_role() in ('owner','court_owner'); $$;

revoke all on function public.current_app_role() from public;
revoke all on function public.is_system_owner() from public;
revoke all on function public.is_app_staff() from public;
revoke all on function public.is_app_manager() from public;
grant execute on function public.current_app_role() to authenticated;
grant execute on function public.is_system_owner() to authenticated;
grant execute on function public.is_app_staff() to authenticated;
grant execute on function public.is_app_manager() to authenticated;

-- ---------- Safe public RPCs ----------
create or replace function public.public_booking_slots(p_date date, p_court_id text default null)
returns table (
  court_id text,
  date date,
  hour integer,
  status text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    b.court_id,
    b.date,
    h::integer as hour,
    case
      when b.status = 'verifying' then 'processing'
      when b.status = 'cancelled' then 'available'
      else 'booked'
    end as status
  from public.bookings b
  cross join lateral unnest(b.slots) as h
  where b.date = p_date
    and (p_court_id is null or b.court_id = p_court_id)
    and b.status <> 'cancelled'
    and not (
      b.status = 'verifying'
      and b.created_at < now() - interval '15 minutes'
    );
$$;

create or replace function public.public_open_play_counts(p_date date)
returns table (
  court_id text,
  player_count integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(r.court_id, '')::text as court_id,
    count(*)::integer as player_count
  from public.open_play_registrations r
  where r.date = p_date
    and coalesce(r.payment_status, '') <> 'rejected'
  group by coalesce(r.court_id, '');
$$;

create or replace function public.public_settings()
returns table (
  key text,
  value text
)
language sql
stable
security definer
set search_path = public
as $$
  select s.key, s.value
  from public.settings s
  where s.key in (
    'open_hour',
    'close_hour',
    'pricing_tiers',
    'open_play_config',
    'maintenance_config',
    'maintenance_fee',
    'service_fee_rate',
    'booking_fee',
    'fee_type',
    'gcash_merchant_number',
    'gcash_merchant_name',
    'gcash_qr_image',
    'gotyme_merchant_number',
    'gotyme_merchant_name',
    'gotyme_qr_image',
    'pnb_merchant_number',
    'pnb_merchant_name',
    'pnb_qr_image',
    'gcash_checkout_enabled',
    'gcash_checkout_url',
    'payment_method_cash',
    'payment_method_gcash',
    'payment_method_gotyme',
    'payment_method_pnb',
    'payment_acceptance_mode'
  );
$$;

grant execute on function public.public_booking_slots(date, text) to anon, authenticated;
grant execute on function public.public_open_play_counts(date) to anon, authenticated;
grant execute on function public.public_settings() to anon, authenticated;

create or replace function public.expire_stale_verifying_bookings()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  update public.bookings
  set
    status = 'cancelled',
    payment_status = 'rejected'
  where status = 'verifying'
    and created_at < now() - interval '15 minutes';

  get diagnostics affected = row_count;
  return affected;
end;
$$;

grant execute on function public.expire_stale_verifying_bookings() to anon, authenticated;

create or replace function public.enforce_public_booking_hold_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.role() <> 'anon' then
    return new;
  end if;

  if old.status <> 'verifying'
     or old.created_at < now() - interval '15 minutes' then
    raise exception 'Public booking update window has expired';
  end if;

  if new.status not in ('verifying','pending','cancelled')
     or new.payment_status not in ('unpaid','pending','for_verification','rejected') then
    raise exception 'Public booking update cannot confirm or mark a payment as paid';
  end if;

  if new.ref is distinct from old.ref
     or new.court_id is distinct from old.court_id
     or new.court_name is distinct from old.court_name
     or new.date is distinct from old.date
     or new.slots is distinct from old.slots
     or new.start_time is distinct from old.start_time
     or new.end_time is distinct from old.end_time
     or new.duration is distinct from old.duration
     or new.rate is distinct from old.rate
     or new.total is distinct from old.total
     or new.created_at is distinct from old.created_at
     or new.payment_provider is distinct from old.payment_provider
     or new.payment_session_id is distinct from old.payment_session_id
     or new.payment_checkout_url is distinct from old.payment_checkout_url
     or new.paid_at is distinct from old.paid_at
     or new.receipt_image_url is distinct from old.receipt_image_url
     or new.receipt_image_hash is distinct from old.receipt_image_hash
     or new.receipt_phash is distinct from old.receipt_phash
     or new.receipt_status is distinct from old.receipt_status
     or new.receipt_flags is distinct from old.receipt_flags
     or new.receipt_extracted is distinct from old.receipt_extracted
     or new.receipt_confidence is distinct from old.receipt_confidence
     or new.receipt_verified_at is distinct from old.receipt_verified_at
     or new.billed_at is distinct from old.billed_at
     or new.weekly_fee_id is distinct from old.weekly_fee_id then
    raise exception 'Public booking update can only fill customer and payment proof fields';
  end if;

  if new.downpayment is not null and old.total is not null
     and (new.downpayment < old.total * 0.5 or new.downpayment > old.total) then
    raise exception 'Invalid booking payment amount';
  end if;

  return new;
end;
$$;

-- ---------- Minimal security audit ----------
create table if not exists public.security_audit_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor_id uuid,
  actor_email text,
  actor_role text,
  table_name text not null,
  action text not null,
  record_id text,
  metadata jsonb not null default '{}'::jsonb
);

alter table public.security_audit_log enable row level security;
drop policy if exists security_audit_owner_select on public.security_audit_log;
drop policy if exists security_audit_no_client_write on public.security_audit_log;
create policy security_audit_owner_select
  on public.security_audit_log for select
  using (public.is_system_owner());
create policy security_audit_no_client_write
  on public.security_audit_log for all
  using (false)
  with check (false);

create or replace function public.audit_sensitive_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  rid text;
  row_data jsonb;
begin
  row_data := coalesce(to_jsonb(new), to_jsonb(old), '{}'::jsonb);
  rid := coalesce(
    row_data ->> 'ref',
    row_data ->> 'id',
    row_data ->> 'key'
  );

  insert into public.security_audit_log (
    actor_id,
    actor_email,
    actor_role,
    table_name,
    action,
    record_id
  ) values (
    auth.uid(),
    auth.jwt() ->> 'email',
    public.current_app_role(),
    TG_TABLE_NAME,
    TG_OP,
    rid
  );

  return coalesce(new, old);
end;
$$;

drop trigger if exists audit_bookings_sensitive_change on public.bookings;
create trigger audit_bookings_sensitive_change
  after insert or update or delete on public.bookings
  for each row execute function public.audit_sensitive_change();

drop trigger if exists audit_open_play_sensitive_change on public.open_play_registrations;
create trigger audit_open_play_sensitive_change
  after insert or update or delete on public.open_play_registrations
  for each row execute function public.audit_sensitive_change();

drop trigger if exists audit_accounts_sensitive_change on public.accounts;
create trigger audit_accounts_sensitive_change
  after insert or update or delete on public.accounts
  for each row execute function public.audit_sensitive_change();

drop trigger if exists audit_settings_sensitive_change on public.settings;
create trigger audit_settings_sensitive_change
  after insert or update or delete on public.settings
  for each row execute function public.audit_sensitive_change();

drop trigger if exists audit_courts_sensitive_change on public.courts;
create trigger audit_courts_sensitive_change
  after insert or update or delete on public.courts
  for each row execute function public.audit_sensitive_change();

-- Modern installs use trg_guard_public_booking_hold_update, introduced by the
-- role-based security migrations. Remove the legacy guard trigger so both
-- guards cannot reject the same server-owned booking mutation differently.
drop trigger if exists enforce_public_booking_hold_update on public.bookings;

create or replace function public.enforce_weekly_fee_owner_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  owns_statement boolean;
begin
  if public.is_system_owner() then
    return new;
  end if;

  owns_statement :=
    old.court_owner_user_id = auth.uid()::text
    or lower(coalesce(old.court_owner_email, '')) = actor_email;

  if public.current_app_role() = 'court_owner' and owns_statement then
    if new.id is distinct from old.id
       or new.court_owner_user_id is distinct from old.court_owner_user_id
       or new.court_owner_email is distinct from old.court_owner_email
       or new.week_start is distinct from old.week_start
       or new.week_end is distinct from old.week_end
       or new.bookings_count is distinct from old.bookings_count
       or new.fee_per_booking is distinct from old.fee_per_booking
       or new.amount_due is distinct from old.amount_due
       or new.generated_at is distinct from old.generated_at
       or new.sent_at is distinct from old.sent_at
       or new.due_at is distinct from old.due_at
       or new.paid_at is distinct from old.paid_at
       or new.paid_ref is distinct from old.paid_ref
       or new.paid_note is distinct from old.paid_note
       or new.paid_by_user_id is distinct from old.paid_by_user_id
       or new.created_at is distinct from old.created_at
       or new.billed_refs is distinct from old.billed_refs then
      raise exception 'Court owner can only submit remittance proof fields';
    end if;

    if new.status <> 'submitted' then
      raise exception 'Court owner can only submit a billing statement for review';
    end if;

    return new;
  end if;

  raise exception 'Not allowed to update billing statement';
end;
$$;

drop trigger if exists enforce_weekly_fee_owner_update on public.weekly_fees;
create trigger enforce_weekly_fee_owner_update
  before update on public.weekly_fees
  for each row execute function public.enforce_weekly_fee_owner_update();

-- ---------- Tight RLS policies ----------
alter table public.bookings enable row level security;
drop policy if exists bookings_select_public on public.bookings;
drop policy if exists bookings_insert_public on public.bookings;
drop policy if exists bookings_update_admin on public.bookings;
drop policy if exists bookings_delete_admin on public.bookings;
drop policy if exists bookings_select_staff on public.bookings;
drop policy if exists bookings_insert_anon on public.bookings;
drop policy if exists bookings_insert_staff on public.bookings;
drop policy if exists bookings_update_anon_active_hold on public.bookings;
drop policy if exists bookings_update_staff on public.bookings;
drop policy if exists bookings_delete_owner on public.bookings;

create policy bookings_select_staff
  on public.bookings for select
  using (public.is_app_staff());

create policy bookings_insert_anon
  on public.bookings for insert to anon
  with check (
    status in ('pending','verifying')
    and payment_status in ('unpaid','pending','for_verification')
    and created_at >= now() - interval '5 minutes'
    and created_at <= now() + interval '5 minutes'
  );

create policy bookings_insert_staff
  on public.bookings for insert to authenticated
  with check (public.is_app_staff());

create policy bookings_update_anon_active_hold
  on public.bookings for update to anon
  using (
    status = 'verifying'
    and created_at >= now() - interval '15 minutes'
  )
  with check (
    status in ('verifying','pending','cancelled')
    and payment_status in ('unpaid','pending','for_verification','rejected')
    and created_at >= now() - interval '15 minutes'
    and created_at <= now() + interval '5 minutes'
  );

create policy bookings_update_staff
  on public.bookings for update to authenticated
  using (public.is_app_staff())
  with check (public.is_app_staff());

create policy bookings_delete_owner
  on public.bookings for delete to authenticated
  using (public.is_system_owner());

alter table public.open_play_registrations enable row level security;
drop policy if exists open_play_select_public on public.open_play_registrations;
drop policy if exists open_play_insert_public on public.open_play_registrations;
drop policy if exists open_play_delete_admin on public.open_play_registrations;
drop policy if exists open_play_select_staff on public.open_play_registrations;
drop policy if exists open_play_insert_anon on public.open_play_registrations;
drop policy if exists open_play_update_staff on public.open_play_registrations;
drop policy if exists open_play_delete_staff on public.open_play_registrations;

create policy open_play_select_staff
  on public.open_play_registrations for select
  using (public.is_app_staff());

create policy open_play_insert_anon
  on public.open_play_registrations for insert to anon
  with check (
    coalesce(payment_status, 'pending') in ('pending','unpaid')
    and coalesce(receipt_status, 'none') in ('none','manual_review')
  );

create policy open_play_update_staff
  on public.open_play_registrations for update to authenticated
  using (public.is_app_staff())
  with check (public.is_app_staff());

create policy open_play_delete_staff
  on public.open_play_registrations for delete to authenticated
  using (public.is_app_staff());

alter table public.accounts enable row level security;
drop policy if exists accounts_select_admin on public.accounts;
drop policy if exists accounts_insert_admin on public.accounts;
drop policy if exists accounts_update_admin on public.accounts;
drop policy if exists accounts_delete_admin on public.accounts;
drop policy if exists accounts_select_own_or_owner on public.accounts;
drop policy if exists accounts_owner_insert on public.accounts;
drop policy if exists accounts_owner_update on public.accounts;
drop policy if exists accounts_owner_delete on public.accounts;

create policy accounts_select_own_or_owner
  on public.accounts for select to authenticated
  using (
    public.is_system_owner()
    or id = auth.uid()
    or lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

create policy accounts_owner_insert
  on public.accounts for insert to authenticated
  with check (public.is_system_owner());

create policy accounts_owner_update
  on public.accounts for update to authenticated
  using (public.is_system_owner())
  with check (public.is_system_owner());

create policy accounts_owner_delete
  on public.accounts for delete to authenticated
  using (public.is_system_owner());

alter table public.settings enable row level security;
drop policy if exists settings_select_public on public.settings;
drop policy if exists settings_insert_admin on public.settings;
drop policy if exists settings_update_admin on public.settings;
drop policy if exists settings_delete_admin on public.settings;
drop policy if exists settings_select_staff on public.settings;
drop policy if exists settings_write_staff on public.settings;

create policy settings_select_staff
  on public.settings for select
  using (public.is_app_staff());

create policy settings_write_staff
  on public.settings for all to authenticated
  using (public.is_app_manager())
  with check (public.is_app_manager());

alter table public.courts enable row level security;
drop policy if exists courts_select_public on public.courts;
drop policy if exists courts_insert_admin on public.courts;
drop policy if exists courts_update_admin on public.courts;
drop policy if exists courts_delete_admin on public.courts;
drop policy if exists courts_select_public_safe on public.courts;
drop policy if exists courts_write_staff on public.courts;

create policy courts_select_public_safe
  on public.courts for select
  using (true);

create policy courts_write_staff
  on public.courts for all to authenticated
  using (public.is_app_manager())
  with check (public.is_app_manager());

alter table public.blocked_dates enable row level security;
drop policy if exists blocked_dates_select_public on public.blocked_dates;
drop policy if exists blocked_dates_insert_admin on public.blocked_dates;
drop policy if exists blocked_dates_delete_admin on public.blocked_dates;
drop policy if exists blocked_dates_select_public_safe on public.blocked_dates;
drop policy if exists blocked_dates_write_staff on public.blocked_dates;

create policy blocked_dates_select_public_safe
  on public.blocked_dates for select
  using (true);

create policy blocked_dates_write_staff
  on public.blocked_dates for all to authenticated
  using (public.is_app_manager())
  with check (public.is_app_manager());

-- Admin-only game manager tables.
alter table public.open_play_game_sessions enable row level security;
alter table public.open_play_game_players enable row level security;
alter table public.open_play_game_rounds enable row level security;

drop policy if exists op_game_sessions_admin_all on public.open_play_game_sessions;
drop policy if exists op_game_players_admin_all on public.open_play_game_players;
drop policy if exists op_game_rounds_admin_all on public.open_play_game_rounds;
drop policy if exists op_game_sessions_staff_all on public.open_play_game_sessions;
drop policy if exists op_game_players_staff_all on public.open_play_game_players;
drop policy if exists op_game_rounds_staff_all on public.open_play_game_rounds;

create policy op_game_sessions_staff_all on public.open_play_game_sessions
  for all using (public.is_app_staff()) with check (public.is_app_staff());
create policy op_game_players_staff_all on public.open_play_game_players
  for all using (public.is_app_staff()) with check (public.is_app_staff());
create policy op_game_rounds_staff_all on public.open_play_game_rounds
  for all using (public.is_app_staff()) with check (public.is_app_staff());

-- Keep payment/receipt internals server-side only.
alter table public.payment_sessions enable row level security;
drop policy if exists payment_sessions_insert_public on public.payment_sessions;
drop policy if exists payment_sessions_select_admin on public.payment_sessions;
drop policy if exists payment_sessions_update_admin on public.payment_sessions;
drop policy if exists payment_sessions_select_none on public.payment_sessions;
drop policy if exists payment_sessions_insert_none on public.payment_sessions;
drop policy if exists payment_sessions_update_none on public.payment_sessions;
drop policy if exists payment_sessions_no_direct_access on public.payment_sessions;
drop policy if exists payment_sessions_no_client_access on public.payment_sessions;
create policy payment_sessions_no_client_access
  on public.payment_sessions for all
  using (false)
  with check (false);

alter table public.used_gcash_refs enable row level security;
drop policy if exists used_gcash_refs_no_select on public.used_gcash_refs;
drop policy if exists used_gcash_refs_no_write on public.used_gcash_refs;
drop policy if exists used_gcash_refs_no_client_access on public.used_gcash_refs;
create policy used_gcash_refs_no_client_access
  on public.used_gcash_refs for all
  using (false)
  with check (false);

alter table public.receipt_verifications enable row level security;
drop policy if exists receipt_verifications_select_admin on public.receipt_verifications;
drop policy if exists receipt_verifications_no_write on public.receipt_verifications;
drop policy if exists receipt_verifications_select_staff on public.receipt_verifications;
drop policy if exists receipt_verifications_no_client_write on public.receipt_verifications;
create policy receipt_verifications_select_staff
  on public.receipt_verifications for select
  using (public.is_app_staff());
create policy receipt_verifications_no_client_write
  on public.receipt_verifications for all
  using (false)
  with check (false);

-- Billing statements contain remittance and revenue details.
alter table public.weekly_fees enable row level security;
drop policy if exists weekly_fees_select_auth on public.weekly_fees;
drop policy if exists weekly_fees_insert_auth on public.weekly_fees;
drop policy if exists weekly_fees_update_auth on public.weekly_fees;
drop policy if exists weekly_fees_delete_auth on public.weekly_fees;
drop policy if exists weekly_fees_select_owner_or_court_owner on public.weekly_fees;
drop policy if exists weekly_fees_insert_owner on public.weekly_fees;
drop policy if exists weekly_fees_update_owner_or_submitter on public.weekly_fees;
drop policy if exists weekly_fees_delete_owner on public.weekly_fees;

create policy weekly_fees_select_owner_or_court_owner
  on public.weekly_fees for select to authenticated
  using (
    public.is_system_owner()
    or court_owner_user_id = auth.uid()::text
    or lower(coalesce(court_owner_email, '')) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

create policy weekly_fees_insert_owner
  on public.weekly_fees for insert to authenticated
  with check (public.is_system_owner());

create policy weekly_fees_update_owner_or_submitter
  on public.weekly_fees for update to authenticated
  using (
    public.is_system_owner()
    or (
      public.current_app_role() = 'court_owner'
      and (
        court_owner_user_id = auth.uid()::text
        or lower(coalesce(court_owner_email, '')) = lower(coalesce(auth.jwt() ->> 'email', ''))
      )
    )
  )
  with check (
    public.is_system_owner()
    or (
      public.current_app_role() = 'court_owner'
      and (
        court_owner_user_id = auth.uid()::text
        or lower(coalesce(court_owner_email, '')) = lower(coalesce(auth.jwt() ->> 'email', ''))
      )
    )
  );

create policy weekly_fees_delete_owner
  on public.weekly_fees for delete to authenticated
  using (public.is_system_owner());

-- Signed agreements contain legal names, signatures, IP, and user-agent data.
alter table public.agreements enable row level security;
drop policy if exists "users_read_own_agreement" on public.agreements;
drop policy if exists agreements_select_own_or_owner on public.agreements;
drop policy if exists agreements_insert_own on public.agreements;
drop policy if exists agreements_update_own on public.agreements;
drop policy if exists agreements_no_client_delete on public.agreements;

create policy agreements_select_own_or_owner
  on public.agreements for select to authenticated
  using (
    public.is_system_owner()
    or user_id = auth.uid()::text
    or lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

create policy agreements_insert_own
  on public.agreements for insert to authenticated
  with check (
    user_id = auth.uid()::text
    or lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

create policy agreements_update_own
  on public.agreements for update to authenticated
  using (
    user_id = auth.uid()::text
    or lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
  with check (
    user_id = auth.uid()::text
    or lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

create policy agreements_no_client_delete
  on public.agreements for delete to authenticated
  using (false);

-- ---------- Retention helper ----------
create or replace function public.purge_old_sensitive_data(retention_days integer default 180)
returns table (
  bookings_scrubbed integer,
  open_play_scrubbed integer,
  receipt_logs_deleted integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff timestamptz := now() - make_interval(days => greatest(retention_days, 30));
begin
  if not public.is_system_owner() then
    raise exception 'Only system owner can purge sensitive data';
  end if;

  update public.bookings
  set
    receipt_image_url = null,
    receipt_image_hash = null,
    receipt_phash = null,
    receipt_extracted = null,
    receipt_confidence = null
  where created_at < cutoff
    and (
      receipt_image_url is not null
      or receipt_image_hash is not null
      or receipt_phash is not null
      or receipt_extracted is not null
      or receipt_confidence is not null
    );
  get diagnostics bookings_scrubbed = row_count;

  update public.open_play_registrations
  set
    receipt_image_url = null,
    receipt_image_hash = null,
    receipt_phash = null,
    receipt_extracted = null,
    receipt_confidence = null
  where created_at < cutoff
    and (
      receipt_image_url is not null
      or receipt_image_hash is not null
      or receipt_phash is not null
      or receipt_extracted is not null
      or receipt_confidence is not null
    );
  get diagnostics open_play_scrubbed = row_count;

  delete from public.receipt_verifications
  where created_at < cutoff;
  get diagnostics receipt_logs_deleted = row_count;

  return next;
end;
$$;

revoke all on function public.purge_old_sensitive_data(integer) from public;
grant execute on function public.purge_old_sensitive_data(integer) to authenticated;
