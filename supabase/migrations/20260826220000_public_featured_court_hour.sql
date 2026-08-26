-- Public, PII-free discovery and measurement for the one-hour Best Move.
--
-- This migration is additive. It never changes bookings, prices, payments,
-- receipts, vouchers, or booking-hold authority. Public placement events carry
-- no stable visitor identity, booking reference, free-form metadata, or payment
-- data. A random per-tab UUID is accepted only to derive an irreversible hash.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Every immutable occurrence receives an unrelated, unguessable public token.
-- The UUID is the only occurrence handle exposed to the booking page.
alter table public.profit_learning_occurrences
  add column if not exists public_placement_token uuid
    not null default gen_random_uuid();

create unique index if not exists profit_learning_public_placement_token_uidx
  on public.profit_learning_occurrences (public_placement_token);

comment on column public.profit_learning_occurrences.public_placement_token is
  'Opaque public handle for a featured court-hour. It does not encode the experiment, court, date, customer, or booking.';

-- On-site placement is valid treatment delivery evidence. Facebook evidence is
-- retained unchanged and either delivery channel may make the occurrence
-- eligible when outcomes are finalized.
alter table public.profit_learning_occurrence_events
  drop constraint if exists profit_learning_occurrence_events_event_type_check;
alter table public.profit_learning_occurrence_events
  add constraint profit_learning_occurrence_events_event_type_check
  check (event_type in (
    'facebook_published',
    'facebook_publish_failed',
    'placement_activated',
    'experiment_stopped'
  ));

create unique index if not exists profit_learning_one_placement_activation_uidx
  on public.profit_learning_occurrence_events (occurrence_id, event_type)
  where event_type = 'placement_activated';

create or replace function public.activate_profit_learning_public_placement()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  experiment_creator uuid;
begin
  if new.arm <> 'treatment' then
    return new;
  end if;

  select experiment.created_by
    into experiment_creator
  from public.profit_learning_experiments experiment
  where experiment.id = new.experiment_id
    and experiment.status = 'active'
    and experiment.target_pairs = 1
    and experiment.treatment_action = 'facebook_regular_price'
    and experiment.discount_percent = 0;

  if not found then
    return new;
  end if;

  insert into public.profit_learning_occurrence_events (
    experiment_id,
    occurrence_id,
    event_type,
    metadata,
    actor_id
  ) values (
    new.experiment_id,
    new.id,
    'placement_activated',
    '{"surface":"public_booking","price_mode":"regular"}'::jsonb,
    experiment_creator
  )
  on conflict (occurrence_id, event_type)
    where event_type = 'placement_activated'
  do nothing;

  return new;
end;
$$;

revoke all on function public.activate_profit_learning_public_placement()
  from public, anon, authenticated;

drop trigger if exists trg_activate_profit_learning_public_placement
  on public.profit_learning_occurrences;
create trigger trg_activate_profit_learning_public_placement
after insert on public.profit_learning_occurrences
for each row execute function public.activate_profit_learning_public_placement();

-- Make the already-active one-hour Best Move visible without asking the owner
-- to recreate it. This adds operational evidence only; assignments stay intact.
insert into public.profit_learning_occurrence_events (
  experiment_id,
  occurrence_id,
  event_type,
  metadata,
  actor_id
)
select
  experiment.id,
  occurrence.id,
  'placement_activated',
  '{"surface":"public_booking","price_mode":"regular","activation":"migration"}'::jsonb,
  experiment.created_by
from public.profit_learning_experiments experiment
join public.profit_learning_occurrences occurrence
  on occurrence.experiment_id = experiment.id
 and occurrence.arm = 'treatment'
where experiment.status = 'active'
  and experiment.target_pairs = 1
  and experiment.treatment_action = 'facebook_regular_price'
  and experiment.discount_percent = 0
on conflict (occurrence_id, event_type)
  where event_type = 'placement_activated'
do nothing;

-- Patch only the treatment-delivery predicate in the existing finalizer. The
-- rest of the audited paid-booking outcome function remains byte-for-byte the
-- same, and Facebook publication continues to qualify independently.
do $migration$
declare
  target regprocedure := to_regprocedure(
    'public.finalize_profit_learning_occurrence_outcomes(uuid)'
  );
  definition text;
  patched_definition text;
  original_predicate text := $$event.event_type = 'facebook_published'$$;
  delivery_predicate text := $$event.event_type in ('facebook_published', 'placement_activated')$$;
begin
  if target is null then
    raise exception 'Profit Learning outcome finalizer is missing.';
  end if;
  definition := pg_catalog.pg_get_functiondef(target);
  if pg_catalog.strpos(definition, delivery_predicate) > 0 then
    return;
  end if;
  if pg_catalog.strpos(definition, original_predicate) = 0 then
    raise exception 'Profit Learning finalizer does not match the expected delivery predicate.';
  end if;

  patched_definition := pg_catalog.replace(
    definition,
    original_predicate,
    delivery_predicate
  );
  if patched_definition = definition
     or pg_catalog.strpos(patched_definition, delivery_predicate) = 0 then
    raise exception 'Public placement delivery patch was not applied.';
  end if;
  execute patched_definition;
end;
$migration$;

create table if not exists public.profit_learning_public_placement_events (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null
    references public.profit_learning_experiments(id) on delete restrict,
  occurrence_id uuid not null
    references public.profit_learning_occurrences(id) on delete restrict,
  event_type text not null check (
    event_type in ('impression', 'open', 'slot_click', 'booking_started')
  ),
  session_hash text not null check (session_hash ~ '^[0-9a-f]{64}$'),
  source_channel text not null default 'unknown' check (
    source_channel in ('organic', 'facebook', 'qr', 'direct', 'unknown')
  ),
  event_at timestamptz not null default now()
);

create index if not exists profit_learning_public_placement_timeline_idx
  on public.profit_learning_public_placement_events (
    occurrence_id, event_at desc
  );

create index if not exists profit_learning_public_placement_experiment_idx
  on public.profit_learning_public_placement_events (
    experiment_id, event_type, event_at desc
  );

create unique index if not exists profit_learning_public_placement_session_uidx
  on public.profit_learning_public_placement_events (
    occurrence_id, event_type, session_hash
  );

comment on table public.profit_learning_public_placement_events is
  'Append-only, PII-free public funnel events for one featured court-hour. Only an irreversible, placement-scoped random per-tab session hash is retained; no stable visitor identity, booking, payment, receipt, or free-form metadata is stored.';

alter table public.profit_learning_public_placement_events enable row level security;

drop policy if exists profit_learning_public_placement_events_read_owners
  on public.profit_learning_public_placement_events;
create policy profit_learning_public_placement_events_read_owners
  on public.profit_learning_public_placement_events
  for select to authenticated
  using (public.has_account_role(array['owner', 'court_owner']));

revoke all on public.profit_learning_public_placement_events
  from public, anon, authenticated;
grant select on public.profit_learning_public_placement_events
  to authenticated;

drop trigger if exists trg_profit_learning_public_placement_events_immutable
  on public.profit_learning_public_placement_events;
create trigger trg_profit_learning_public_placement_events_immutable
before update or delete on public.profit_learning_public_placement_events
for each row execute function public.profit_learning_reject_immutable_mutation();

create or replace function public.get_public_featured_court_hour()
returns table (
  placement_token text,
  court_id text,
  court_name text,
  play_date date,
  slot_hour integer,
  end_hour integer,
  regular_rate numeric(12,2),
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with request_clock as materialized (
    select
      pg_catalog.statement_timestamp() as requested_at,
      pg_catalog.timezone(
        'Asia/Manila', pg_catalog.statement_timestamp()
      )::date as local_today
  ), schedule_settings as materialized (
    select
      coalesce((
        select setting.value::jsonb
        from public.settings setting
        where setting.key = 'open_play_config'
        limit 1
      ), '{}'::jsonb) as open_play_config,
      coalesce((
        select setting.value::jsonb
        from public.settings setting
        where setting.key = 'maintenance_config'
        limit 1
      ), '{}'::jsonb) as maintenance_config,
      coalesce((
        select setting.value
        from public.settings setting
        where setting.key = 'open_hour'
        limit 1
      ), '0') as open_hour,
      coalesce((
        select setting.value
        from public.settings setting
        where setting.key = 'close_hour'
        limit 1
      ), '24') as close_hour
  ), candidate as materialized (
    select
      occurrence.public_placement_token::text as placement_token,
      occurrence.id as occurrence_id,
      occurrence.court_id,
      court.name as court_name,
      occurrence.play_date,
      occurrence.slot_hour::integer as slot_hour,
      occurrence.slot_hour::integer + 1 as end_hour,
      occurrence.regular_rate_snapshot,
      pg_catalog.round(greatest(
        public.calculate_booking_court_total(
          occurrence.court_id,
          array[occurrence.slot_hour::text]
        ),
        0
      ), 2)::numeric(12,2) as current_rate,
      pg_catalog.make_timestamptz(
        extract(year from occurrence.play_date)::integer,
        extract(month from occurrence.play_date)::integer,
        extract(day from occurrence.play_date)::integer,
        occurrence.slot_hour,
        0,
        0,
        'Asia/Manila'
      ) as expires_at
    from public.profit_learning_experiments experiment
    join public.profit_learning_occurrences occurrence
      on occurrence.experiment_id = experiment.id
     and occurrence.arm = 'treatment'
    join public.courts court
      on court.id = occurrence.court_id
     and not coalesce(court.blocked, false)
    cross join request_clock clock
    cross join schedule_settings schedule
    where experiment.status = 'active'
      and experiment.target_pairs = 1
      and experiment.treatment_action = 'facebook_regular_price'
      and experiment.discount_percent = 0
      and not exists (
        select 1
        from public.demand_campaigns campaign
        where campaign.status = 'active'
          and campaign.starts_at <= clock.requested_at
          and campaign.ends_at > clock.requested_at
      )
      and occurrence.play_date between clock.local_today and clock.local_today + 28
      and schedule.open_hour ~ '^\d{1,2}$'
      and schedule.close_hour ~ '^\d{1,2}$'
      and schedule.open_hour::integer between 0 and 23
      and schedule.close_hour::integer between 1 and 24
      and occurrence.slot_hour >= schedule.open_hour::integer
      and occurrence.slot_hour < schedule.close_hour::integer
      and pg_catalog.make_timestamptz(
        extract(year from occurrence.play_date)::integer,
        extract(month from occurrence.play_date)::integer,
        extract(day from occurrence.play_date)::integer,
        occurrence.slot_hour,
        0,
        0,
        'Asia/Manila'
      ) > clock.requested_at
      and exists (
        select 1
        from public.profit_learning_occurrence_events activation
        where activation.occurrence_id = occurrence.id
          and activation.event_type = 'placement_activated'
      )
      and not exists (
        select 1
        from public.blocked_dates blocked
        where blocked.date = occurrence.play_date
      )
      and not public.demand_schedule_hour_is_unavailable(
        occurrence.play_date,
        occurrence.slot_hour,
        occurrence.court_id,
        schedule.open_play_config,
        schedule.maintenance_config
      )
      and not exists (
        select 1
        from public.bookings booking
        where booking.court_id = occurrence.court_id
          and booking.date = occurrence.play_date
          and pg_catalog.lower(coalesce(booking.status, ''))
            not in ('cancelled', 'forfeited')
          and (
            pg_catalog.lower(coalesce(booking.status, '')) <> 'verifying'
            or booking.created_at is null
            or booking.created_at > clock.requested_at - interval '15 minutes'
          )
          and exists (
            select 1
            from pg_catalog.unnest(
              coalesce(booking.slots, '{}'::text[])
            ) occupied(slot_value)
            where occupied.slot_value ~ '^\d{1,2}(\.\d+)?$'
              and pg_catalog.floor(
                occupied.slot_value::numeric
              )::integer = occurrence.slot_hour
          )
      )
  )
  select
    candidate.placement_token,
    candidate.court_id,
    candidate.court_name,
    candidate.play_date,
    candidate.slot_hour,
    candidate.end_hour,
    candidate.current_rate as regular_rate,
    candidate.expires_at
  from candidate
  where candidate.current_rate > 0
    and candidate.current_rate = candidate.regular_rate_snapshot
  order by candidate.play_date, candidate.slot_hour, candidate.court_id
  limit 1
$$;

revoke all on function public.get_public_featured_court_hour()
  from public, anon, authenticated;
grant execute on function public.get_public_featured_court_hour()
  to anon, authenticated;

comment on function public.get_public_featured_court_hour() is
  'Returns zero or one active, exact, regular-price Best Move. Rechecks the court, operating hours, blocked date, Open Play, maintenance, active holds/bookings, start time, 28-day horizon, and authoritative hourly rate without exposing experiment, customer, booking, or payment data.';

create or replace function public.record_public_featured_court_event(
  p_placement_token text,
  p_event_type text,
  p_session_token text,
  p_source text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  clean_token text := pg_catalog.btrim(coalesce(p_placement_token, ''));
  clean_event text := pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_event_type, ''))
  );
  clean_session text := pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_session_token, ''))
  );
  clean_source text := pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_source, 'unknown'))
  );
  hashed_session text;
  matched_occurrence uuid;
  matched_experiment uuid;
  recent_count integer;
begin
  if clean_token !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return pg_catalog.jsonb_build_object(
      'recorded', false,
      'reason', 'invalid_placement'
    );
  end if;
  if clean_event not in (
    'impression', 'open', 'slot_click', 'booking_started'
  ) then
    return pg_catalog.jsonb_build_object(
      'recorded', false,
      'reason', 'invalid_event'
    );
  end if;
  if clean_session !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return pg_catalog.jsonb_build_object(
      'recorded', false,
      'reason', 'invalid_session'
    );
  end if;
  if clean_source not in ('organic', 'facebook', 'qr', 'direct', 'unknown') then
    clean_source := 'unknown';
  end if;
  hashed_session := pg_catalog.encode(extensions.digest(
    'featured-court-session|' || clean_token || '|' || clean_session,
    'sha256'
  ), 'hex');

  -- Serialize the small per-placement abuse guard, then require the exact token
  -- to be the currently available public Best Move before appending anything.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('featured-court|' || clean_token, 0)
  );

  select occurrence.id, occurrence.experiment_id
    into matched_occurrence, matched_experiment
  from public.profit_learning_occurrences occurrence
  join public.get_public_featured_court_hour() featured
    on featured.placement_token = occurrence.public_placement_token::text
  where occurrence.public_placement_token::text = clean_token
  limit 1;

  if matched_occurrence is null then
    return pg_catalog.jsonb_build_object(
      'recorded', false,
      'reason', 'unavailable'
    );
  end if;

  select pg_catalog.count(*)::integer
    into recent_count
  from public.profit_learning_public_placement_events event
  where event.occurrence_id = matched_occurrence
    and event.event_at > pg_catalog.clock_timestamp() - interval '1 minute';

  if recent_count >= 120 then
    return pg_catalog.jsonb_build_object(
      'recorded', false,
      'reason', 'rate_limited'
    );
  end if;

  insert into public.profit_learning_public_placement_events (
    experiment_id,
    occurrence_id,
    event_type,
    session_hash,
    source_channel
  ) values (
    matched_experiment,
    matched_occurrence,
    clean_event,
    hashed_session,
    clean_source
  )
  on conflict (occurrence_id, event_type, session_hash)
  do nothing;

  if found then
    return pg_catalog.jsonb_build_object('recorded', true);
  end if;
  return pg_catalog.jsonb_build_object(
    'recorded', false,
    'idempotent', true
  );
end;
$$;

revoke all on function public.record_public_featured_court_event(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_public_featured_court_event(text, text, text, text)
  to anon, authenticated;

comment on function public.record_public_featured_court_event(text, text, text, text) is
  'Appends at most one whitelisted, PII-free funnel event per placement-scoped random browser-session hash when the exact opaque placement token still resolves to the available Best Move. The raw session token is never stored, hashes cannot be linked across placements, and the function cannot alter a booking, price, payment, voucher, or assignment.';

notify pgrst, 'reload schema';

commit;
