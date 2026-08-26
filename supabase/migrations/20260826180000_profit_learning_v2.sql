-- Profit Learning V2: protected, occurrence-level learning for one-hour courts.
--
-- Phase 1 compares no action with a Facebook promotion at the same regular
-- hourly price. This migration is deliberately additive: it reads bookings to
-- measure outcomes, but never changes the booking schema, booking rows, payment
-- flow, vouchers, holds, or legacy Smart Rate functions.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '90s';

create extension if not exists pgcrypto;

create table if not exists public.profit_learning_experiments (
  id uuid primary key default gen_random_uuid(),
  source_recommendation_id text not null,
  court_id text not null references public.courts(id) on delete restrict,
  court_name_snapshot text not null,
  weekday smallint not null check (weekday between 1 and 7),
  slot_hour smallint not null check (slot_hour between 0 and 23),
  treatment_action text not null default 'facebook_regular_price'
    check (treatment_action = 'facebook_regular_price'),
  discount_percent numeric(5,2) not null default 0
    check (discount_percent = 0),
  target_pairs integer not null default 8
    check (target_pairs = 8),
  status text not null default 'active'
    check (status in ('active', 'stopped', 'completed')),
  baseline_period_from date not null,
  baseline_period_to date not null,
  baseline_utilization_pct numeric(5,1) not null
    check (baseline_utilization_pct between 0 and 100),
  baseline_comparable_days integer not null
    check (baseline_comparable_days >= 0),
  baseline_available_hours numeric(12,2) not null
    check (baseline_available_hours >= 0),
  baseline_confidence text not null
    check (baseline_confidence in ('learning', 'low', 'medium', 'high')),
  baseline_state text not null
    check (baseline_state in ('persistent_vacancy', 'underused')),
  baseline_open_future_hours numeric(12,2) not null default 0
    check (baseline_open_future_hours >= 0),
  baseline_opportunity_value numeric(12,2) not null default 0
    check (baseline_opportunity_value >= 0),
  started_at timestamptz not null default now(),
  scheduled_through date,
  ended_at timestamptz,
  created_by uuid not null default auth.uid(),
  ended_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists profit_learning_one_active_uidx
  on public.profit_learning_experiments ((status))
  where status = 'active';

create index if not exists profit_learning_experiment_history_idx
  on public.profit_learning_experiments (court_id, weekday, slot_hour, created_at desc);

create table if not exists public.profit_learning_occurrences (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null
    references public.profit_learning_experiments(id) on delete restrict,
  pair_no integer not null check (pair_no between 1 and 8),
  batch_no integer not null default 1 check (batch_no > 0),
  court_id text not null references public.courts(id) on delete restrict,
  play_date date not null,
  slot_hour smallint not null check (slot_hour between 0 and 23),
  arm text not null check (arm in ('control', 'treatment')),
  regular_rate_snapshot numeric(12,2) not null
    check (regular_rate_snapshot > 0),
  pricing_digest text not null,
  assigned_at timestamptz not null default now(),
  unique (experiment_id, pair_no, arm),
  unique (court_id, play_date, slot_hour)
);

create index if not exists profit_learning_occurrence_due_idx
  on public.profit_learning_occurrences (experiment_id, play_date, slot_hour);

create table if not exists public.profit_learning_occurrence_events (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null
    references public.profit_learning_experiments(id) on delete restrict,
  occurrence_id uuid
    references public.profit_learning_occurrences(id) on delete restrict,
  event_type text not null check (
    event_type in (
      'facebook_published',
      'facebook_publish_failed',
      'experiment_stopped'
    )
  ),
  publication_ref text,
  metadata jsonb not null default '{}'::jsonb,
  actor_id uuid not null default auth.uid(),
  event_at timestamptz not null default now()
);

create unique index if not exists profit_learning_one_publication_uidx
  on public.profit_learning_occurrence_events (occurrence_id, event_type)
  where event_type = 'facebook_published';

create index if not exists profit_learning_event_timeline_idx
  on public.profit_learning_occurrence_events (experiment_id, event_at);

create table if not exists public.profit_learning_occurrence_outcomes (
  occurrence_id uuid primary key
    references public.profit_learning_occurrences(id) on delete restrict,
  experiment_id uuid not null
    references public.profit_learning_experiments(id) on delete restrict,
  pair_no integer not null check (pair_no between 1 and 8),
  arm text not null check (arm in ('control', 'treatment')),
  eligible boolean not null,
  exclusion_reason text,
  treatment_delivered boolean not null default false,
  successful_paid_booking_count integer not null default 0
    check (successful_paid_booking_count >= 0),
  booked_hours numeric(4,2) not null default 0
    check (booked_hours in (0, 1)),
  secured_court_revenue numeric(12,2) not null default 0
    check (secured_court_revenue >= 0),
  qualifying_booking_refs text[] not null default '{}',
  regular_rate_snapshot numeric(12,2) not null
    check (regular_rate_snapshot > 0),
  finalized_at timestamptz not null default now(),
  check (eligible or exclusion_reason is not null)
);

create index if not exists profit_learning_outcome_pair_idx
  on public.profit_learning_occurrence_outcomes (experiment_id, pair_no, arm);

comment on table public.profit_learning_experiments is
  'Owner-approved one-hour occurrence experiments. Phase 1 tests Facebook promotion at the unchanged regular price against no action.';
comment on table public.profit_learning_occurrences is
  'Immutable whole-occurrence control/treatment assignments. Individual customers are never randomized.';
comment on table public.profit_learning_occurrence_events is
  'Append-only operational evidence that an assigned treatment promotion was or was not published.';
comment on table public.profit_learning_occurrence_outcomes is
  'Immutable finalized paid-success outcomes. Secured court revenue is the assigned hourly rate for an occupied qualifying hour.';

alter table public.profit_learning_experiments enable row level security;
alter table public.profit_learning_occurrences enable row level security;
alter table public.profit_learning_occurrence_events enable row level security;
alter table public.profit_learning_occurrence_outcomes enable row level security;

drop policy if exists profit_learning_experiments_read_owners
  on public.profit_learning_experiments;
create policy profit_learning_experiments_read_owners
  on public.profit_learning_experiments
  for select to authenticated
  using (public.has_account_role(array['owner', 'court_owner']));

drop policy if exists profit_learning_occurrences_read_owners
  on public.profit_learning_occurrences;
create policy profit_learning_occurrences_read_owners
  on public.profit_learning_occurrences
  for select to authenticated
  using (public.has_account_role(array['owner', 'court_owner']));

drop policy if exists profit_learning_events_read_owners
  on public.profit_learning_occurrence_events;
create policy profit_learning_events_read_owners
  on public.profit_learning_occurrence_events
  for select to authenticated
  using (public.has_account_role(array['owner', 'court_owner']));

drop policy if exists profit_learning_outcomes_read_owners
  on public.profit_learning_occurrence_outcomes;
create policy profit_learning_outcomes_read_owners
  on public.profit_learning_occurrence_outcomes
  for select to authenticated
  using (public.has_account_role(array['owner', 'court_owner']));

revoke all on public.profit_learning_experiments from public, anon, authenticated;
revoke all on public.profit_learning_occurrences from public, anon, authenticated;
revoke all on public.profit_learning_occurrence_events from public, anon, authenticated;
revoke all on public.profit_learning_occurrence_outcomes from public, anon, authenticated;
grant select on public.profit_learning_experiments to authenticated;
grant select on public.profit_learning_occurrences to authenticated;
grant select on public.profit_learning_occurrence_events to authenticated;
grant select on public.profit_learning_occurrence_outcomes to authenticated;

create or replace function public.profit_learning_reject_immutable_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'Profit Learning assignments, evidence, and outcomes are immutable.'
    using errcode = '55000';
end;
$$;

drop trigger if exists trg_profit_learning_occurrences_immutable
  on public.profit_learning_occurrences;
create trigger trg_profit_learning_occurrences_immutable
before update or delete on public.profit_learning_occurrences
for each row execute function public.profit_learning_reject_immutable_mutation();

drop trigger if exists trg_profit_learning_events_immutable
  on public.profit_learning_occurrence_events;
create trigger trg_profit_learning_events_immutable
before update or delete on public.profit_learning_occurrence_events
for each row execute function public.profit_learning_reject_immutable_mutation();

drop trigger if exists trg_profit_learning_outcomes_immutable
  on public.profit_learning_occurrence_outcomes;
create trigger trg_profit_learning_outcomes_immutable
before update or delete on public.profit_learning_occurrence_outcomes
for each row execute function public.profit_learning_reject_immutable_mutation();

revoke all on function public.profit_learning_reject_immutable_mutation()
  from public, anon, authenticated;

create or replace function public.profit_learning_booking_is_successful(
  p_analytics_eligible boolean,
  p_lifecycle_status text,
  p_payment_status text,
  p_email text
)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(p_analytics_eligible, false)
    and pg_catalog.lower(coalesce(p_lifecycle_status, '')) in ('confirmed', 'completed')
    and pg_catalog.lower(coalesce(p_payment_status, '')) in ('paid', 'downpayment_paid')
    and pg_catalog.lower(coalesce(p_email, '')) <> 'reserve@hold.internal'
$$;

revoke all on function public.profit_learning_booking_is_successful(
  boolean, text, text, text
) from public, anon, authenticated;

create or replace function public.get_profit_learning_v2_intelligence(
  p_from date default null,
  p_to date default null,
  p_court_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  account_role text := public.current_account_role();
  local_today date := pg_catalog.timezone(
    'Asia/Manila', pg_catalog.clock_timestamp()
  )::date;
  range_end date;
  range_start date;
  earliest_success_date date;
  learning_days integer;
  open_hour integer := 6;
  close_hour integer := 22;
  open_play_config jsonb := '{}'::jsonb;
  maintenance_config jsonb := '{}'::jsonb;
  result jsonb;
begin
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can view Profit Learning.'
      using errcode = '42501';
  end if;

  range_end := least(coalesce(p_to, local_today - 1), local_today - 1);

  select case when setting.value ~ '^\d{1,2}$' then setting.value::integer end
    into open_hour
    from public.settings setting
   where setting.key = 'open_hour'
   limit 1;
  select case when setting.value ~ '^\d{1,2}$' then setting.value::integer end
    into close_hour
    from public.settings setting
   where setting.key = 'close_hour'
   limit 1;

  open_hour := greatest(0, least(coalesce(open_hour, 6), 23));
  close_hour := greatest(open_hour + 1, least(coalesce(close_hour, 22), 24));

  select coalesce((
    select setting.value::jsonb from public.settings setting
    where setting.key = 'open_play_config' limit 1
  ), '{}'::jsonb) into open_play_config;
  select coalesce((
    select setting.value::jsonb from public.settings setting
    where setting.key = 'maintenance_config' limit 1
  ), '{}'::jsonb) into maintenance_config;

  if p_court_id is not null and not exists (
    select 1 from public.courts court where court.id = p_court_id
  ) then
    raise exception 'The selected court does not exist.' using errcode = '22023';
  end if;

  select min(booking.date)
    into earliest_success_date
    from public.bookings booking
   where public.profit_learning_booking_is_successful(
       booking.analytics_eligible,
       booking.status,
       booking.payment_status,
       booking.email
     )
     and booking.date <= range_end
     and (p_court_id is null or booking.court_id = p_court_id);

  range_start := coalesce(p_from, earliest_success_date, range_end);
  if range_start > range_end then
    raise exception 'The Profit Learning start date must not be after yesterday.'
      using errcode = '22007';
  end if;
  if range_end - range_start > 3650 then
    raise exception 'Profit Learning ranges are limited to ten years.'
      using errcode = '22023';
  end if;
  learning_days := range_end - range_start + 1;

  with
  hours as materialized (
    select hour_value::integer as slot_hour,
           hour_value::integer + 1 as end_hour
    from pg_catalog.generate_series(open_hour, close_hour - 1) hour_value
  ),
  historical_days as materialized (
    select day_value::date as play_date
    from pg_catalog.generate_series(
      range_start::timestamp,
      range_end::timestamp,
      interval '1 day'
    ) day_value
  ),
  eligible_courts as materialized (
    select court.id, court.name, court.created_at, court.blocked
    from public.courts court
    where p_court_id is null or court.id = p_court_id
  ),
  signal_dimensions as materialized (
    select
      court.id as court_id,
      court.name as court_name,
      weekday_value.weekday,
      hour_cell.slot_hour,
      hour_cell.end_hour,
      pg_catalog.round(greatest(
        public.calculate_booking_court_total(
          court.id,
          array[hour_cell.slot_hour::text]
        ),
        0
      ), 2)::numeric as hourly_rate
    from eligible_courts court
    cross join pg_catalog.generate_series(1, 7) weekday_value(weekday)
    cross join hours hour_cell
  ),
  historical_capacity_units as materialized (
    select
      court.id as court_id,
      day_row.play_date,
      extract(isodow from day_row.play_date)::integer as weekday,
      hour_cell.slot_hour
    from eligible_courts court
    cross join historical_days day_row
    cross join hours hour_cell
    where pg_catalog.timezone('Asia/Manila', court.created_at)::date <= day_row.play_date
      and not exists (
        select 1 from public.blocked_dates blocked
        where blocked.date = day_row.play_date
      )
      and not public.demand_schedule_hour_is_unavailable(
        day_row.play_date,
        hour_cell.slot_hour,
        court.id,
        open_play_config,
        maintenance_config
      )
  ),
  capacity_by_cell as materialized (
    select
      unit.court_id,
      unit.weekday,
      unit.slot_hour,
      count(*)::numeric as available_hours,
      count(distinct unit.play_date)::integer as comparable_days
    from historical_capacity_units unit
    group by unit.court_id, unit.weekday, unit.slot_hour
  ),
  successful_booking_units as materialized (
    select distinct
      coalesce(
        nullif(pg_catalog.btrim(booking.booking_group_ref), ''),
        booking.ref
      ) as reservation_key,
      booking.court_id,
      booking.date as play_date,
      extract(isodow from booking.date)::integer as weekday,
      pg_catalog.floor(slot_value::numeric)::integer as slot_hour
    from public.bookings booking
    cross join lateral pg_catalog.unnest(
      coalesce(booking.slots, '{}'::text[])
    ) requested(slot_value)
    where public.profit_learning_booking_is_successful(
        booking.analytics_eligible,
        booking.status,
        booking.payment_status,
        booking.email
      )
      and booking.date between range_start and range_end
      and (p_court_id is null or booking.court_id = p_court_id)
      and slot_value ~ '^\d{1,2}(\.\d+)?$'
      and pg_catalog.floor(slot_value::numeric)::integer between open_hour and close_hour - 1
      and exists (
        select 1
        from historical_capacity_units eligible
        where eligible.court_id = booking.court_id
          and eligible.play_date = booking.date
          and eligible.slot_hour = pg_catalog.floor(slot_value::numeric)::integer
      )
  ),
  successful_booking_slots as materialized (
    select distinct
      unit.court_id,
      unit.play_date,
      unit.weekday,
      unit.slot_hour
    from successful_booking_units unit
  ),
  successful_reservation_summary as materialized (
    select count(distinct unit.reservation_key)::integer as successful_reservations
    from successful_booking_units unit
  ),
  booked_by_cell as materialized (
    select court_id, weekday, slot_hour, count(*)::numeric as booked_hours
    from successful_booking_slots
    group by court_id, weekday, slot_hour
  ),
  future_days as materialized (
    select day_value::date as play_date
    from pg_catalog.generate_series(
      (local_today + 1)::timestamp,
      (local_today + 28)::timestamp,
      interval '1 day'
    ) day_value
  ),
  future_open_units as materialized (
    select
      court.id as court_id,
      day_row.play_date,
      extract(isodow from day_row.play_date)::integer as weekday,
      hour_cell.slot_hour
    from eligible_courts court
    cross join future_days day_row
    cross join hours hour_cell
    where not coalesce(court.blocked, false)
      and not exists (
        select 1 from public.blocked_dates blocked
        where blocked.date = day_row.play_date
      )
      and not public.demand_schedule_hour_is_unavailable(
        day_row.play_date,
        hour_cell.slot_hour,
        court.id,
        open_play_config,
        maintenance_config
      )
      and not exists (
        select 1
        from public.bookings booking
        where booking.court_id = court.id
          and booking.date = day_row.play_date
          and (
            pg_catalog.lower(coalesce(booking.status, '')) in (
              'pending', 'confirmed', 'completed'
            )
            or (
              pg_catalog.lower(coalesce(booking.status, '')) = 'verifying'
              and booking.created_at > pg_catalog.clock_timestamp() - interval '15 minutes'
            )
          )
          and exists (
            select 1
            from pg_catalog.unnest(coalesce(booking.slots, '{}'::text[])) occupied(slot_value)
            where slot_value ~ '^\d{1,2}(\.\d+)?$'
              and pg_catalog.floor(slot_value::numeric)::integer = hour_cell.slot_hour
          )
      )
  ),
  future_by_cell as materialized (
    select court_id, weekday, slot_hour, count(*)::numeric as open_future_hours
    from future_open_units
    group by court_id, weekday, slot_hour
  ),
  signals_base as materialized (
    select
      dimension.court_id,
      dimension.court_name,
      dimension.hourly_rate,
      dimension.weekday,
      case dimension.weekday
        when 1 then 'Mon' when 2 then 'Tue' when 3 then 'Wed' when 4 then 'Thu'
        when 5 then 'Fri' when 6 then 'Sat' else 'Sun'
      end as weekday_label,
      dimension.slot_hour as start_hour,
      dimension.end_hour,
      least(
        coalesce(booked.booked_hours, 0),
        coalesce(capacity.available_hours, 0)
      )::numeric as booked_hours,
      coalesce(capacity.available_hours, 0)::numeric as available_hours,
      coalesce(capacity.comparable_days, 0)::integer as comparable_days,
      coalesce(future.open_future_hours, 0)::numeric as open_future_hours
    from signal_dimensions dimension
    left join capacity_by_cell capacity
      on capacity.court_id = dimension.court_id
     and capacity.weekday = dimension.weekday
     and capacity.slot_hour = dimension.slot_hour
    left join booked_by_cell booked
      on booked.court_id = dimension.court_id
     and booked.weekday = dimension.weekday
     and booked.slot_hour = dimension.slot_hour
    left join future_by_cell future
      on future.court_id = dimension.court_id
     and future.weekday = dimension.weekday
     and future.slot_hour = dimension.slot_hour
  ),
  signals as materialized (
    select
      signal.*,
      case when signal.available_hours <= 0 then 0
        else pg_catalog.round(least(
          100,
          signal.booked_hours * 100 / signal.available_hours
        ), 1)
      end as utilization_pct,
      case
        when learning_days < 30 or signal.comparable_days < 4 then 'learning'
        when signal.comparable_days < 8 then 'low'
        when signal.comparable_days < 16 then 'medium'
        else 'high'
      end as confidence
    from signals_base signal
  ),
  classified as materialized (
    select
      signal.*,
      case
        when signal.confidence = 'learning' then 'learning'
        when signal.utilization_pct >= 80 then 'protected_peak'
        when signal.utilization_pct >= 60 then 'healthy'
        when signal.utilization_pct >= 40 then 'watch'
        when signal.utilization_pct >= 15 then 'underused'
        else 'persistent_vacancy'
      end as state,
      pg_catalog.round(
        signal.open_future_hours * greatest(100 - signal.utilization_pct, 0) / 100,
        2
      ) as expected_unsold_hours,
      pg_catalog.round(
        signal.open_future_hours * greatest(100 - signal.utilization_pct, 0) / 100
          * signal.hourly_rate,
        2
      ) as opportunity_value
    from signals signal
  ),
  venue_heatmap_base as materialized (
    select
      signal.weekday,
      min(signal.weekday_label) as weekday_label,
      signal.start_hour,
      signal.end_hour,
      sum(signal.booked_hours)::numeric as booked_hours,
      sum(signal.available_hours)::numeric as available_hours,
      max(signal.comparable_days)::integer as comparable_days,
      case when sum(signal.available_hours) <= 0 then 0
        else pg_catalog.round(least(
          100,
          sum(signal.booked_hours) * 100 / sum(signal.available_hours)
        ), 1)
      end as utilization_pct
    from classified signal
    group by signal.weekday, signal.start_hour, signal.end_hour
  ),
  venue_heatmap as materialized (
    select
      heatmap.*,
      case
        when learning_days < 30 or heatmap.comparable_days < 4 then 'learning'
        when heatmap.comparable_days < 8 then 'low'
        when heatmap.comparable_days < 16 then 'medium'
        else 'high'
      end as confidence,
      case
        when learning_days < 30 or heatmap.comparable_days < 4 then 'learning'
        when heatmap.utilization_pct >= 80 then 'protected_peak'
        when heatmap.utilization_pct >= 60 then 'healthy'
        when heatmap.utilization_pct >= 40 then 'watch'
        when heatmap.utilization_pct >= 15 then 'underused'
        else 'persistent_vacancy'
      end as state
    from venue_heatmap_base heatmap
  ),
  recommendation_candidate as materialized (
    select signal.*
    from classified signal
    where learning_days >= 30
      and signal.comparable_days >= 8
      and signal.confidence in ('medium', 'high')
      and signal.state in ('persistent_vacancy', 'underused')
      and signal.open_future_hours > 0
      and signal.hourly_rate > 0
      and not exists (
        select 1 from public.profit_learning_experiments experiment
        where experiment.status = 'active'
      )
      and not exists (
        select 1 from public.demand_campaigns campaign
        where campaign.status = 'active'
          and campaign.ends_at > pg_catalog.clock_timestamp()
      )
    order by signal.opportunity_value desc,
             signal.utilization_pct asc,
             signal.comparable_days desc,
             signal.court_id,
             signal.weekday,
             signal.start_hour
    limit 1
  ),
  recommendation as materialized (
    select
      candidate.*,
      'PL2-' || pg_catalog.upper(pg_catalog.substr(
        pg_catalog.encode(extensions.digest(
          pg_catalog.concat_ws('|',
            'profit-learning-v2',
            candidate.court_id,
            candidate.weekday,
            candidate.start_hour,
            candidate.hourly_rate,
            range_start,
            range_end,
            candidate.comparable_days,
            candidate.available_hours,
            candidate.utilization_pct
          ),
          'sha256'
        ), 'hex'),
        1,
        24
      )) as recommendation_id
    from recommendation_candidate candidate
  ),
  active_experiment as materialized (
    select experiment.*
    from public.profit_learning_experiments experiment
    where experiment.status = 'active'
    order by experiment.created_at desc
    limit 1
  ),
  summary as materialized (
    select
      coalesce(sum(signal.booked_hours), 0)::numeric as booked_hours,
      coalesce(sum(signal.available_hours), 0)::numeric as available_hours,
      coalesce(sum(signal.open_future_hours), 0)::numeric as future_open_hours,
      coalesce(sum(signal.expected_unsold_hours), 0)::numeric as expected_unsold_hours,
      coalesce(sum(signal.opportunity_value), 0)::numeric as opportunity_value
    from classified signal
  )
  select pg_catalog.jsonb_build_object(
    'version', 2,
    'period', pg_catalog.jsonb_build_object(
      'from', range_start,
      'to', range_end,
      'learning_days', learning_days,
      'minimum_learning_days', 30
    ),
    'kpis', pg_catalog.jsonb_build_object(
      'successful_reservations', (
        select successful.successful_reservations
        from successful_reservation_summary successful
      ),
      'booked_hours', pg_catalog.round(summary.booked_hours, 2),
      'available_hours', pg_catalog.round(summary.available_hours, 2),
      'utilization_pct', case when summary.available_hours <= 0 then 0
        else pg_catalog.round(least(
          100,
          summary.booked_hours * 100 / summary.available_hours
        ), 1)
      end,
      'expected_unsold_hours', pg_catalog.round(summary.expected_unsold_hours, 2),
      'opportunity_value', pg_catalog.round(summary.opportunity_value, 2)
    ),
    'heatmap', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'weekday', heatmap.weekday,
        'weekday_label', heatmap.weekday_label,
        'start_hour', heatmap.start_hour,
        'end_hour', heatmap.end_hour,
        'booked_hours', pg_catalog.round(heatmap.booked_hours, 2),
        'available_hours', pg_catalog.round(heatmap.available_hours, 2),
        'comparable_days', heatmap.comparable_days,
        'utilization_pct', heatmap.utilization_pct,
        'confidence', heatmap.confidence,
        'state', heatmap.state
      ) order by heatmap.start_hour, heatmap.weekday)
      from venue_heatmap heatmap
    ), '[]'::jsonb),
    'court_signals', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'court_id', signal.court_id,
        'court_name', signal.court_name,
        'weekday', signal.weekday,
        'weekday_label', signal.weekday_label,
        'start_hour', signal.start_hour,
        'end_hour', signal.end_hour,
        'rate', signal.hourly_rate,
        'hourly_rate', signal.hourly_rate,
        'booked_hours', pg_catalog.round(signal.booked_hours, 2),
        'available_hours', pg_catalog.round(signal.available_hours, 2),
        'comparable_days', signal.comparable_days,
        'utilization_pct', signal.utilization_pct,
        'confidence', signal.confidence,
        'state', signal.state,
        'open_future_hours', pg_catalog.round(signal.open_future_hours, 2),
        'opportunity_value', signal.opportunity_value
      ) order by signal.opportunity_value desc, signal.start_hour,
                 signal.weekday, signal.court_id)
      from classified signal
    ), '[]'::jsonb),
    'recommendation', (
      select pg_catalog.jsonb_build_object(
        'id', recommendation.recommendation_id,
        'court_id', recommendation.court_id,
        'court_name', recommendation.court_name,
        'weekday', recommendation.weekday,
        'weekday_label', recommendation.weekday_label,
        'start_hour', recommendation.start_hour,
        'end_hour', recommendation.end_hour,
        'rate', recommendation.hourly_rate,
        'hourly_rate', recommendation.hourly_rate,
        'utilization_pct', recommendation.utilization_pct,
        'booked_hours', pg_catalog.round(recommendation.booked_hours, 2),
        'available_hours', pg_catalog.round(recommendation.available_hours, 2),
        'comparable_days', recommendation.comparable_days,
        'confidence', recommendation.confidence,
        'state', recommendation.state,
        'open_future_hours', pg_catalog.round(recommendation.open_future_hours, 2),
        'opportunity_value', recommendation.opportunity_value,
        'action', 'facebook_regular_price',
        'action_type', 'facebook_regular_price',
        'discount_percent', 0,
        'target_pairs', 8
      )
      from recommendation
    ),
    'active_experiment', (
      select pg_catalog.jsonb_build_object(
        'id', experiment.id,
        'recommendation_id', experiment.source_recommendation_id,
        'court_id', experiment.court_id,
        'court_name', experiment.court_name_snapshot,
        'weekday', experiment.weekday,
        'slot_hour', experiment.slot_hour,
        'end_hour', experiment.slot_hour + 1,
        'action', experiment.treatment_action,
        'discount_percent', experiment.discount_percent,
        'target_pairs', experiment.target_pairs,
        'status', experiment.status,
        'started_at', experiment.started_at,
        'scheduled_through', experiment.scheduled_through
      ) from active_experiment experiment
    ),
    'active_experiments', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', experiment.id,
        'recommendation_id', experiment.source_recommendation_id,
        'court_id', experiment.court_id,
        'court_name', experiment.court_name_snapshot,
        'weekday', experiment.weekday,
        'slot_hour', experiment.slot_hour,
        'start_hour', experiment.slot_hour,
        'end_hour', experiment.slot_hour + 1,
        'action', experiment.treatment_action,
        'action_type', experiment.treatment_action,
        'discount_percent', experiment.discount_percent,
        'target_pairs', experiment.target_pairs,
        'status', experiment.status,
        'started_at', experiment.started_at,
        'scheduled_through', experiment.scheduled_through
      )) from active_experiment experiment
    ), '[]'::jsonb),
    'active_occurrences', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', occurrence.id,
        'experiment_id', occurrence.experiment_id,
        'pair_no', occurrence.pair_no,
        'court_id', occurrence.court_id,
        'play_date', occurrence.play_date,
        'slot_hour', occurrence.slot_hour,
        'end_hour', occurrence.slot_hour + 1,
        'arm', occurrence.arm,
        'regular_rate', occurrence.regular_rate_snapshot,
        'assigned_at', occurrence.assigned_at,
        'facebook_published_at', publication.event_at,
        'outcome_finalized', outcome.occurrence_id is not null
      ) order by occurrence.play_date, occurrence.slot_hour)
      from active_experiment experiment
      join public.profit_learning_occurrences occurrence
        on occurrence.experiment_id = experiment.id
      left join lateral (
        select min(event.event_at) as event_at
        from public.profit_learning_occurrence_events event
        where event.occurrence_id = occurrence.id
          and event.event_type = 'facebook_published'
      ) publication on true
      left join public.profit_learning_occurrence_outcomes outcome
        on outcome.occurrence_id = occurrence.id
    ), '[]'::jsonb),
    'data_quality', pg_catalog.jsonb_build_object(
      'note', 'One-hour learning includes only analytics-eligible confirmed/completed bookings with paid or downpayment-paid status. Internal holds and unsuccessful operational/payment states contribute zero.',
      'successful_lifecycle_statuses', pg_catalog.jsonb_build_array('confirmed', 'completed'),
      'successful_payment_statuses', pg_catalog.jsonb_build_array('paid', 'downpayment_paid'),
      'through_date', range_end
    )
  ) into result
  from summary;

  return result;
end;
$$;

revoke all on function public.get_profit_learning_v2_intelligence(date, date, text)
  from public, anon;
grant execute on function public.get_profit_learning_v2_intelligence(date, date, text)
  to authenticated;

create or replace function public.create_profit_learning_experiment_from_recommendation(
  p_recommendation_id text,
  p_court_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  account_role text := public.current_account_role();
  clean_id text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_recommendation_id, '')));
  local_today date := pg_catalog.timezone(
    'Asia/Manila', pg_catalog.clock_timestamp()
  )::date;
  open_play_config jsonb := '{}'::jsonb;
  maintenance_config jsonb := '{}'::jsonb;
  snapshot jsonb;
  recommendation jsonb;
  inserted public.profit_learning_experiments%rowtype;
  inserted_occurrences integer := 0;
  last_date date;
begin
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can start Profit Learning.'
      using errcode = '42501';
  end if;
  if clean_id !~ '^PL2-[A-F0-9]{24}$' then
    raise exception 'Profit Learning recommendation ID is invalid.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('korte-dos-profit-learning-v2-create', 0)
  );

  if exists (
    select 1 from public.profit_learning_experiments experiment
    where experiment.status = 'active'
  ) then
    raise exception 'A protected Profit Learning experiment is already active.'
      using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.demand_campaigns campaign
    where campaign.status = 'active' and campaign.ends_at > pg_catalog.now()
  ) then
    raise exception 'End the active Smart Rate campaign before starting a regular-price experiment.'
      using errcode = 'P0001';
  end if;

  snapshot := public.get_profit_learning_v2_intelligence(null, null, p_court_id);
  recommendation := snapshot -> 'recommendation';
  if recommendation is null or recommendation = 'null'::jsonb then
    raise exception 'There is no evidence-backed one-hour recommendation to test yet.'
      using errcode = 'P0001';
  end if;
  if pg_catalog.upper(coalesce(recommendation ->> 'id', '')) <> clean_id then
    raise exception 'This Profit Learning recommendation changed. Refresh Insights.'
      using errcode = '40001';
  end if;
  if recommendation ->> 'action' <> 'facebook_regular_price'
     or coalesce((recommendation ->> 'discount_percent')::numeric, -1) <> 0
     or coalesce((recommendation ->> 'target_pairs')::integer, 0) <> 8
     or coalesce(recommendation ->> 'confidence', '') not in ('medium', 'high')
     or coalesce(recommendation ->> 'state', '') not in ('persistent_vacancy', 'underused') then
    raise exception 'This recommendation is not eligible for a protected Phase 1 test.'
      using errcode = 'P0001';
  end if;

  select coalesce((
    select setting.value::jsonb from public.settings setting
    where setting.key = 'open_play_config' limit 1
  ), '{}'::jsonb) into open_play_config;
  select coalesce((
    select setting.value::jsonb from public.settings setting
    where setting.key = 'maintenance_config' limit 1
  ), '{}'::jsonb) into maintenance_config;

  insert into public.profit_learning_experiments (
    source_recommendation_id,
    court_id,
    court_name_snapshot,
    weekday,
    slot_hour,
    treatment_action,
    discount_percent,
    target_pairs,
    baseline_period_from,
    baseline_period_to,
    baseline_utilization_pct,
    baseline_comparable_days,
    baseline_available_hours,
    baseline_confidence,
    baseline_state,
    baseline_open_future_hours,
    baseline_opportunity_value,
    created_by
  ) values (
    clean_id,
    recommendation ->> 'court_id',
    recommendation ->> 'court_name',
    (recommendation ->> 'weekday')::smallint,
    (recommendation ->> 'start_hour')::smallint,
    'facebook_regular_price',
    0,
    8,
    (snapshot #>> '{period,from}')::date,
    (snapshot #>> '{period,to}')::date,
    (recommendation ->> 'utilization_pct')::numeric,
    (recommendation ->> 'comparable_days')::integer,
    (recommendation ->> 'available_hours')::numeric,
    recommendation ->> 'confidence',
    recommendation ->> 'state',
    (recommendation ->> 'open_future_hours')::numeric,
    (recommendation ->> 'opportunity_value')::numeric,
    auth.uid()
  ) returning * into inserted;

  with candidate_dates as materialized (
    select
      candidate.play_date,
      pg_catalog.row_number() over (order by candidate.play_date)::integer as occurrence_no
    from (
      select generated.day_value::date as play_date
      from pg_catalog.generate_series(
        (local_today + 2)::timestamp,
        (local_today + 365)::timestamp,
        interval '1 day'
      ) generated(day_value)
      join public.courts court
        on court.id = inserted.court_id
       and not coalesce(court.blocked, false)
      where extract(isodow from generated.day_value)::integer = inserted.weekday
        and not exists (
          select 1 from public.blocked_dates blocked
          where blocked.date = generated.day_value::date
        )
        and not public.demand_schedule_hour_is_unavailable(
          generated.day_value::date,
          inserted.slot_hour,
          inserted.court_id,
          open_play_config,
          maintenance_config
        )
        and not exists (
          select 1 from public.profit_learning_occurrences occurrence
          where occurrence.court_id = inserted.court_id
            and occurrence.play_date = generated.day_value::date
            and occurrence.slot_hour = inserted.slot_hour
        )
        and not exists (
          select 1
          from public.bookings booking
          where booking.court_id = inserted.court_id
            and booking.date = generated.day_value::date
            and pg_catalog.lower(coalesce(booking.status, '')) not in ('cancelled', 'forfeited')
            and (
              pg_catalog.lower(coalesce(booking.status, '')) <> 'verifying'
              or booking.created_at > pg_catalog.clock_timestamp() - interval '15 minutes'
            )
            and exists (
              select 1
              from pg_catalog.unnest(coalesce(booking.slots, '{}'::text[])) occupied(slot_value)
              where slot_value ~ '^\d{1,2}(\.\d+)?$'
                and pg_catalog.floor(slot_value::numeric)::integer = inserted.slot_hour
            )
        )
      order by generated.day_value
      limit 16
    ) candidate
  ), assignments as materialized (
    select
      candidate.play_date,
      candidate.occurrence_no,
      ((candidate.occurrence_no - 1) / 2 + 1)::integer as pair_no,
      ((candidate.occurrence_no - 1) % 2 + 1)::integer as pair_position
    from candidate_dates candidate
  ), assigned as materialized (
    select
      assignment.*,
      case
        when pg_catalog.mod(
          pg_catalog.get_byte(extensions.digest(
            inserted.id::text || ':' || assignment.pair_no::text,
            'sha256'
          ), 0),
          2
        ) = 0 then
          case when assignment.pair_position = 1 then 'treatment' else 'control' end
        else
          case when assignment.pair_position = 1 then 'control' else 'treatment' end
      end as arm
    from assignments assignment
  )
  insert into public.profit_learning_occurrences (
    experiment_id,
    pair_no,
    batch_no,
    court_id,
    play_date,
    slot_hour,
    arm,
    regular_rate_snapshot,
    pricing_digest
  )
  select
    inserted.id,
    assigned.pair_no,
    1,
    inserted.court_id,
    assigned.play_date,
    inserted.slot_hour,
    assigned.arm,
    pg_catalog.round(greatest(
      public.calculate_booking_court_total(
        inserted.court_id,
        array[inserted.slot_hour::text]
      ),
      0
    ), 2),
    pg_catalog.encode(extensions.digest(
      inserted.court_id || '|' || inserted.slot_hour::text || '|'
        || pg_catalog.round(greatest(
          public.calculate_booking_court_total(
            inserted.court_id,
            array[inserted.slot_hour::text]
          ),
          0
        ), 2)::text,
      'sha256'
    ), 'hex')
  from assigned;

  get diagnostics inserted_occurrences = row_count;
  if inserted_occurrences <> 16 then
    raise exception 'Eight complete matched pairs are not currently schedulable for this hour.'
      using errcode = 'P0001';
  end if;

  select max(occurrence.play_date) into last_date
  from public.profit_learning_occurrences occurrence
  where occurrence.experiment_id = inserted.id;

  update public.profit_learning_experiments experiment
     set scheduled_through = last_date,
         updated_at = pg_catalog.now()
   where experiment.id = inserted.id;

  return pg_catalog.jsonb_build_object(
    'created', true,
    'experiment_id', inserted.id,
    'recommendation_id', clean_id,
    'court_id', inserted.court_id,
    'court_name', inserted.court_name_snapshot,
    'weekday', inserted.weekday,
    'slot_hour', inserted.slot_hour,
    'end_hour', inserted.slot_hour + 1,
    'action', inserted.treatment_action,
    'discount_percent', 0,
    'target_pairs', 8,
    'assigned_occurrences', inserted_occurrences,
    'scheduled_through', last_date,
    'status', inserted.status
  );
end;
$$;

revoke all on function public.create_profit_learning_experiment_from_recommendation(
  text, text
) from public, anon;
grant execute on function public.create_profit_learning_experiment_from_recommendation(
  text, text
) to authenticated;

create or replace function public.record_profit_learning_facebook_publication(
  p_experiment_id uuid,
  p_occurrence_ids uuid[],
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  account_role text := public.current_account_role();
  clean_ids uuid[];
  expected_count integer;
  valid_count integer;
  inserted_count integer;
begin
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can record a publication.'
      using errcode = '42501';
  end if;

  clean_ids := array(
    select distinct occurrence_id
    from pg_catalog.unnest(coalesce(p_occurrence_ids, '{}'::uuid[])) occurrence_id
    order by occurrence_id
  );
  expected_count := pg_catalog.cardinality(clean_ids);
  if expected_count = 0 then
    raise exception 'At least one treatment occurrence is required.' using errcode = '22023';
  end if;

  select count(*)::integer into valid_count
  from public.profit_learning_occurrences occurrence
  join public.profit_learning_experiments experiment
    on experiment.id = occurrence.experiment_id
  where occurrence.id = any(clean_ids)
    and occurrence.experiment_id = p_experiment_id
    and occurrence.arm = 'treatment'
    and experiment.status = 'active'
    and pg_catalog.make_timestamptz(
      extract(year from occurrence.play_date)::integer,
      extract(month from occurrence.play_date)::integer,
      extract(day from occurrence.play_date)::integer,
      occurrence.slot_hour,
      0,
      0,
      'Asia/Manila'
    ) > pg_catalog.clock_timestamp();

  if valid_count <> expected_count then
    raise exception 'Publication evidence may be recorded only for future treatment occurrences in the active experiment.'
      using errcode = '22023';
  end if;

  insert into public.profit_learning_occurrence_events (
    experiment_id,
    occurrence_id,
    event_type,
    publication_ref,
    metadata,
    actor_id
  )
  select
    occurrence.experiment_id,
    occurrence.id,
    'facebook_published',
    nullif(pg_catalog.btrim(coalesce(p_metadata ->> 'publication_ref', '')), ''),
    coalesce(p_metadata, '{}'::jsonb),
    auth.uid()
  from public.profit_learning_occurrences occurrence
  where occurrence.id = any(clean_ids)
    and occurrence.experiment_id = p_experiment_id
  on conflict (occurrence_id, event_type)
    where event_type = 'facebook_published'
  do nothing;

  get diagnostics inserted_count = row_count;
  return pg_catalog.jsonb_build_object(
    'recorded', inserted_count,
    'idempotent', inserted_count = 0,
    'occurrence_ids', to_jsonb(clean_ids)
  );
end;
$$;

revoke all on function public.record_profit_learning_facebook_publication(
  uuid, uuid[], jsonb
) from public, anon;
grant execute on function public.record_profit_learning_facebook_publication(
  uuid, uuid[], jsonb
) to authenticated;

create or replace function public.finalize_profit_learning_occurrence_outcomes(
  p_experiment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  account_role text := public.current_account_role();
  local_today date := pg_catalog.timezone(
    'Asia/Manila', pg_catalog.clock_timestamp()
  )::date;
  open_play_config jsonb := '{}'::jsonb;
  maintenance_config jsonb := '{}'::jsonb;
  inserted_count integer := 0;
begin
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can finalize Profit Learning outcomes.'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profit_learning_experiments experiment
    where experiment.id = p_experiment_id
  ) then
    raise exception 'Profit Learning experiment was not found.' using errcode = 'P0001';
  end if;

  select coalesce((
    select setting.value::jsonb from public.settings setting
    where setting.key = 'open_play_config' limit 1
  ), '{}'::jsonb) into open_play_config;
  select coalesce((
    select setting.value::jsonb from public.settings setting
    where setting.key = 'maintenance_config' limit 1
  ), '{}'::jsonb) into maintenance_config;

  with due as materialized (
    select
      occurrence.*,
      pg_catalog.round(greatest(
        public.calculate_booking_court_total(
          occurrence.court_id,
          array[occurrence.slot_hour::text]
        ),
        0
      ), 2) as current_rate,
      exists (
        select 1 from public.blocked_dates blocked
        where blocked.date = occurrence.play_date
      ) as blocked_date,
      public.demand_schedule_hour_is_unavailable(
        occurrence.play_date,
        occurrence.slot_hour,
        occurrence.court_id,
        open_play_config,
        maintenance_config
      ) as schedule_unavailable,
      publication.event_at as published_at,
      success.successful_paid_booking_count,
      success.qualifying_booking_refs,
      success.first_qualifying_booking_at
    from public.profit_learning_occurrences occurrence
    left join public.profit_learning_occurrence_outcomes existing
      on existing.occurrence_id = occurrence.id
    left join lateral (
      select min(event.event_at) as event_at
      from public.profit_learning_occurrence_events event
      where event.occurrence_id = occurrence.id
        and event.event_type = 'facebook_published'
    ) publication on true
    left join lateral (
      select
        count(distinct coalesce(
          nullif(pg_catalog.btrim(booking.booking_group_ref), ''),
          booking.ref
        ))::integer as successful_paid_booking_count,
        coalesce(array_agg(distinct booking.ref order by booking.ref), '{}'::text[])
          as qualifying_booking_refs,
        min(booking.created_at) as first_qualifying_booking_at
      from public.bookings booking
      where booking.court_id = occurrence.court_id
        and booking.date = occurrence.play_date
        and public.profit_learning_booking_is_successful(
          booking.analytics_eligible,
          booking.status,
          booking.payment_status,
          booking.email
        )
        and exists (
          select 1
          from pg_catalog.unnest(coalesce(booking.slots, '{}'::text[])) occupied(slot_value)
          where slot_value ~ '^\d{1,2}(\.\d+)?$'
            and pg_catalog.floor(slot_value::numeric)::integer = occurrence.slot_hour
        )
    ) success on true
    where occurrence.experiment_id = p_experiment_id
      and occurrence.play_date < local_today
      and existing.occurrence_id is null
  ), classified as materialized (
    select
      due.*,
      case
        when due.blocked_date then 'blocked_date'
        when due.schedule_unavailable then 'operational_schedule'
        when due.current_rate is distinct from due.regular_rate_snapshot then 'price_changed'
        when due.arm = 'treatment' and due.published_at is null then 'promotion_not_published'
        when due.arm = 'treatment'
         and due.first_qualifying_booking_at is not null
         and due.published_at > due.first_qualifying_booking_at then 'published_after_booking'
        when due.arm = 'treatment'
         and due.published_at >= pg_catalog.make_timestamptz(
           extract(year from due.play_date)::integer,
           extract(month from due.play_date)::integer,
           extract(day from due.play_date)::integer,
           due.slot_hour,
           0,
           0,
           'Asia/Manila'
         ) then 'published_after_slot_start'
        else null
      end as exclusion_reason
    from due
  )
  insert into public.profit_learning_occurrence_outcomes (
    occurrence_id,
    experiment_id,
    pair_no,
    arm,
    eligible,
    exclusion_reason,
    treatment_delivered,
    successful_paid_booking_count,
    booked_hours,
    secured_court_revenue,
    qualifying_booking_refs,
    regular_rate_snapshot
  )
  select
    classified.id,
    classified.experiment_id,
    classified.pair_no,
    classified.arm,
    classified.exclusion_reason is null,
    classified.exclusion_reason,
    classified.arm = 'treatment' and classified.published_at is not null,
    coalesce(classified.successful_paid_booking_count, 0),
    case when coalesce(classified.successful_paid_booking_count, 0) > 0 then 1 else 0 end,
    case
      when coalesce(classified.successful_paid_booking_count, 0) > 0
        then classified.regular_rate_snapshot
      else 0
    end,
    coalesce(classified.qualifying_booking_refs, '{}'::text[]),
    classified.regular_rate_snapshot
  from classified
  on conflict (occurrence_id) do nothing;

  get diagnostics inserted_count = row_count;

  update public.profit_learning_experiments experiment
     set status = 'completed',
         ended_at = coalesce(experiment.ended_at, pg_catalog.now()),
         updated_at = pg_catalog.now()
   where experiment.id = p_experiment_id
     and experiment.status = 'active'
     and not exists (
       select 1
       from public.profit_learning_occurrences occurrence
       left join public.profit_learning_occurrence_outcomes outcome
         on outcome.occurrence_id = occurrence.id
       where occurrence.experiment_id = experiment.id
         and outcome.occurrence_id is null
     );

  return pg_catalog.jsonb_build_object(
    'experiment_id', p_experiment_id,
    'finalized', inserted_count,
    'idempotent', inserted_count = 0
  );
end;
$$;

revoke all on function public.finalize_profit_learning_occurrence_outcomes(uuid)
  from public, anon;
grant execute on function public.finalize_profit_learning_occurrence_outcomes(uuid)
  to authenticated;

create or replace function public.get_profit_learning_experiment_results(
  p_experiment_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  account_role text := public.current_account_role();
  result jsonb;
begin
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can view Profit Learning results.'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profit_learning_experiments experiment
    where experiment.id = p_experiment_id
  ) then
    raise exception 'Profit Learning experiment was not found.' using errcode = 'P0001';
  end if;

  with paired as materialized (
    select
      outcome.pair_no,
      max(outcome.secured_court_revenue) filter (where outcome.arm = 'treatment')
        as treatment_revenue,
      max(outcome.secured_court_revenue) filter (where outcome.arm = 'control')
        as control_revenue,
      max(outcome.booked_hours) filter (where outcome.arm = 'treatment')
        as treatment_booked_hours,
      max(outcome.booked_hours) filter (where outcome.arm = 'control')
        as control_booked_hours,
      bool_and(outcome.eligible) as both_eligible,
      count(*)::integer as arm_count
    from public.profit_learning_occurrence_outcomes outcome
    where outcome.experiment_id = p_experiment_id
    group by outcome.pair_no
  ), complete_pairs as materialized (
    select
      pair_row.*,
      pair_row.treatment_revenue - pair_row.control_revenue as revenue_difference,
      pair_row.treatment_booked_hours - pair_row.control_booked_hours
        as booking_difference
    from paired pair_row
    where pair_row.arm_count = 2
      and pair_row.both_eligible
      and pair_row.treatment_revenue is not null
      and pair_row.control_revenue is not null
  ), aggregate_result as materialized (
    select
      count(*)::integer as completed_pairs,
      coalesce(sum(treatment_revenue), 0)::numeric as treatment_secured_revenue,
      coalesce(sum(control_revenue), 0)::numeric as control_secured_revenue,
      coalesce(sum(treatment_booked_hours), 0)::numeric as treatment_booked_hours,
      coalesce(sum(control_booked_hours), 0)::numeric as control_booked_hours,
      coalesce(avg(revenue_difference), 0)::numeric as mean_incremental_revenue,
      coalesce(avg(booking_difference), 0)::numeric as mean_incremental_bookings,
      stddev_samp(revenue_difference)::numeric as revenue_difference_stddev
    from complete_pairs
  ), classified as materialized (
    select
      aggregate_result.*,
      case
        when aggregate_result.completed_pairs > 1 then
          2.365 * aggregate_result.revenue_difference_stddev
            / pg_catalog.sqrt(aggregate_result.completed_pairs::numeric)
        else null
      end as confidence_margin
    from aggregate_result
  )
  select pg_catalog.jsonb_build_object(
    'experiment_id', experiment.id,
    'status', experiment.status,
    'action', experiment.treatment_action,
    'discount_percent', experiment.discount_percent,
    'target_pairs', experiment.target_pairs,
    'completed_pairs', classified.completed_pairs,
    'remaining_pairs', greatest(experiment.target_pairs - classified.completed_pairs, 0),
    'treatment_secured_court_revenue',
      pg_catalog.round(classified.treatment_secured_revenue, 2),
    'control_secured_court_revenue',
      pg_catalog.round(classified.control_secured_revenue, 2),
    'incremental_secured_court_revenue',
      pg_catalog.round(
        classified.treatment_secured_revenue - classified.control_secured_revenue,
        2
      ),
    'incremental_secured_court_revenue_per_sellable_hour',
      pg_catalog.round(classified.mean_incremental_revenue, 2),
    'additional_paid_bookings',
      pg_catalog.round(
        classified.treatment_booked_hours - classified.control_booked_hours,
        2
      ),
    'promotion_cost', 0,
    'confidence_interval_95', case
      when classified.confidence_margin is null then null
      else pg_catalog.jsonb_build_object(
        'lower', pg_catalog.round(
          classified.mean_incremental_revenue - classified.confidence_margin,
          2
        ),
        'upper', pg_catalog.round(
          classified.mean_incremental_revenue + classified.confidence_margin,
          2
        )
      )
    end,
    'learning_status', case
      when classified.completed_pairs < experiment.target_pairs
       and classified.mean_incremental_revenue > 0 then 'promising'
      when classified.completed_pairs < experiment.target_pairs then 'learning'
      when classified.mean_incremental_revenue - classified.confidence_margin > 0
        then 'profitable'
      when classified.mean_incremental_revenue + classified.confidence_margin < 0
        then 'harmful'
      else 'inconclusive'
    end,
    'pairs', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'pair_no', pair_row.pair_no,
        'treatment_secured_court_revenue', pair_row.treatment_revenue,
        'control_secured_court_revenue', pair_row.control_revenue,
        'revenue_difference', pair_row.revenue_difference,
        'booking_difference', pair_row.booking_difference
      ) order by pair_row.pair_no)
      from complete_pairs pair_row
    ), '[]'::jsonb)
  ) into result
  from public.profit_learning_experiments experiment
  cross join classified
  where experiment.id = p_experiment_id;

  return result;
end;
$$;

revoke all on function public.get_profit_learning_experiment_results(uuid)
  from public, anon;
grant execute on function public.get_profit_learning_experiment_results(uuid)
  to authenticated;

create or replace function public.end_profit_learning_experiment(
  p_experiment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  account_role text := public.current_account_role();
  ended public.profit_learning_experiments%rowtype;
begin
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can stop Profit Learning.'
      using errcode = '42501';
  end if;

  update public.profit_learning_experiments experiment
     set status = case when experiment.status = 'completed' then 'completed' else 'stopped' end,
         ended_at = coalesce(experiment.ended_at, pg_catalog.now()),
         ended_by = coalesce(experiment.ended_by, auth.uid()),
         updated_at = pg_catalog.now()
   where experiment.id = p_experiment_id
  returning * into ended;

  if not found then
    raise exception 'Profit Learning experiment was not found.' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.profit_learning_occurrence_events event
    where event.experiment_id = ended.id
      and event.event_type = 'experiment_stopped'
  ) then
    insert into public.profit_learning_occurrence_events (
      experiment_id,
      occurrence_id,
      event_type,
      metadata,
      actor_id
    ) values (
      ended.id,
      null,
      'experiment_stopped',
      pg_catalog.jsonb_build_object('status', ended.status),
      auth.uid()
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'experiment_id', ended.id,
    'status', ended.status,
    'ended_at', ended.ended_at
  );
end;
$$;

revoke all on function public.end_profit_learning_experiment(uuid)
  from public, anon;
grant execute on function public.end_profit_learning_experiment(uuid)
  to authenticated;

comment on function public.get_profit_learning_v2_intelligence(date, date, text) is
  'Owner-only one-hour demand and Profit Learning V2 snapshot using the authoritative price of each exact court hour.';
comment on function public.create_profit_learning_experiment_from_recommendation(text, text) is
  'Creates eight matched whole-occurrence pairs for no action versus Facebook promotion at the unchanged regular hourly price.';
comment on function public.finalize_profit_learning_occurrence_outcomes(uuid) is
  'Finalizes immutable paid-success outcomes through yesterday without mutating bookings or payment state.';

notify pgrst, 'reload schema';

commit;
