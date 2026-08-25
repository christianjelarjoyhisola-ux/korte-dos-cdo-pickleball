-- Demand-only growth intelligence and tightly scoped automatic campaigns.
--
-- This feature is intentionally separate from vouchers. It learns only from
-- successful, analytics-eligible play dates through yesterday, and applies a
-- server-approved campaign only to matching future booking holds. Existing
-- bookings are never repriced.

begin;

-- Keep production lock waits bounded. Any busy booking table causes a clean
-- deployment failure instead of holding customer traffic behind a long DDL
-- queue. Constraint scans run in their own lower-lock transaction below.
set local lock_timeout = '5s';
set local statement_timeout = '90s';

create extension if not exists pgcrypto;

alter table public.bookings
  add column if not exists analytics_eligible boolean not null default true;

comment on column public.bookings.analytics_eligible is
  'Explicit analytics inclusion flag. Demand Intelligence also requires a confirmed/completed play date through yesterday.';

create index if not exists idx_bookings_demand_growth_eligible
  on public.bookings (date, court_id, status)
  where analytics_eligible = true and status in ('confirmed', 'completed');

create table if not exists public.demand_campaigns (
  id uuid primary key default gen_random_uuid(),
  source_recommendation_id text not null unique,
  court_id text not null references public.courts(id) on delete restrict,
  court_name_snapshot text not null,
  weekday smallint not null check (weekday between 1 and 7),
  start_hour smallint not null check (start_hour between 0 and 23),
  end_hour smallint not null check (end_hour between 1 and 24 and end_hour > start_hour),
  discount_percent numeric(5,2) not null default 10
    check (discount_percent > 0 and discount_percent <= 10),
  max_redemptions integer not null default 20
    check (max_redemptions > 0 and max_redemptions <= 20),
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'ended')),
  baseline_period_from date not null,
  baseline_period_to date not null,
  baseline_utilization_pct numeric(5,1) not null check (baseline_utilization_pct between 0 and 100),
  baseline_comparable_days integer not null check (baseline_comparable_days >= 0),
  baseline_available_hours numeric(12,2) not null check (baseline_available_hours >= 0),
  baseline_confidence text not null check (baseline_confidence in ('learning', 'low', 'medium', 'high')),
  baseline_state text not null check (baseline_state in ('persistent_vacancy', 'underused')),
  baseline_open_future_hours numeric(12,2) not null default 0 check (baseline_open_future_hours >= 0),
  baseline_opportunity_value numeric(12,2) not null default 0 check (baseline_opportunity_value >= 0),
  created_by uuid not null default auth.uid(),
  ended_by uuid,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint demand_campaigns_window_check check (ends_at > starts_at),
  constraint demand_campaigns_max_duration_check check (ends_at <= starts_at + interval '28 days')
);

-- Product rule: run one controlled growth experiment at a time. The creation
-- RPC retires expired rows before inserting, while this index closes races.
create unique index if not exists demand_campaigns_one_active_uidx
  on public.demand_campaigns ((status))
  where status = 'active';

create index if not exists demand_campaigns_match_idx
  on public.demand_campaigns (status, court_id, weekday, start_hour, end_hour, starts_at, ends_at);

create table if not exists public.demand_campaign_redemptions (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.demand_campaigns(id) on delete restrict,
  booking_group_key text not null,
  booking_refs text[] not null,
  gross_amount numeric(12,2) not null check (gross_amount >= 0),
  eligible_court_amount numeric(12,2) not null check (eligible_court_amount >= 0),
  discount_amount numeric(12,2) not null check (discount_amount >= 0),
  status text not null default 'reserved' check (status in ('reserved', 'redeemed', 'released')),
  reserved_until timestamptz not null,
  redeemed_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, booking_group_key)
);

create index if not exists demand_campaign_redemptions_status_idx
  on public.demand_campaign_redemptions (campaign_id, status);

alter table public.bookings
  add column if not exists demand_campaign_id uuid references public.demand_campaigns(id) on delete set null,
  add column if not exists demand_campaign_discount_percent_snapshot numeric(5,2),
  add column if not exists demand_campaign_discount_amount numeric(12,2) not null default 0,
  add column if not exists demand_campaign_gross_total numeric(12,2);

alter table public.bookings
  drop constraint if exists bookings_demand_campaign_discount_nonnegative;
alter table public.bookings
  add constraint bookings_demand_campaign_discount_nonnegative
  check (demand_campaign_discount_amount >= 0) not valid;

alter table public.bookings
  drop constraint if exists bookings_demand_campaign_percent_range;
alter table public.bookings
  add constraint bookings_demand_campaign_percent_range
  check (
    demand_campaign_discount_percent_snapshot is null
    or demand_campaign_discount_percent_snapshot > 0
       and demand_campaign_discount_percent_snapshot <= 10
  ) not valid;

alter table public.bookings
  drop constraint if exists bookings_no_voucher_campaign_stacking;
alter table public.bookings
  add constraint bookings_no_voucher_campaign_stacking
  check (not (voucher_id is not null and demand_campaign_id is not null)) not valid;

comment on table public.demand_campaigns is
  'Owner-approved, server-generated growth experiments for one weak court/time window; separate from vouchers.';
comment on table public.demand_campaign_redemptions is
  'Reserved/redeemed booking groups receiving an automatic demand campaign price.';
comment on column public.bookings.demand_campaign_gross_total is
  'Booking total before a demand campaign discount. Existing bookings remain null and unchanged.';
comment on column public.bookings.demand_campaign_discount_amount is
  'Court-funded growth discount allocated to this booking row; the platform fee is never discounted.';

alter table public.demand_campaigns enable row level security;
alter table public.demand_campaign_redemptions enable row level security;

drop policy if exists demand_campaigns_read_owners on public.demand_campaigns;
create policy demand_campaigns_read_owners
  on public.demand_campaigns
  for select
  to authenticated
  using (public.has_account_role(array['owner', 'court_owner']));

drop policy if exists demand_campaign_redemptions_read_owners on public.demand_campaign_redemptions;
create policy demand_campaign_redemptions_read_owners
  on public.demand_campaign_redemptions
  for select
  to authenticated
  using (public.has_account_role(array['owner', 'court_owner']));

revoke all on public.demand_campaigns from anon;
revoke all on public.demand_campaign_redemptions from anon;
grant select on public.demand_campaigns to authenticated;
grant select on public.demand_campaign_redemptions to authenticated;

create or replace function public.demand_booking_group_key(p_booking_refs text[])
returns text
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  select array_to_string(
    array(
      select distinct btrim(ref)
      from unnest(p_booking_refs) ref
      where btrim(ref) <> ''
      order by 1
    ),
    '|'
  )
$$;

revoke all on function public.demand_booking_group_key(text[]) from public, anon, authenticated;

create or replace function public.release_expired_demand_campaign_reservations()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.demand_campaign_redemptions
     set status = 'released',
         released_at = coalesce(released_at, now()),
         updated_at = now()
   where status = 'reserved'
     and reserved_until <= now()
$$;

revoke all on function public.release_expired_demand_campaign_reservations()
  from public, anon, authenticated;

create or replace function public.get_demand_growth_intelligence(
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
  account_role text;
  local_today date := timezone('Asia/Manila', clock_timestamp())::date;
  range_end date;
  range_start date;
  earliest_success_date date;
  learning_days integer;
  open_hour integer := 6;
  close_hour integer := 22;
  result jsonb;
begin
  account_role := public.current_account_role();
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can view Demand Intelligence.'
      using errcode = '42501';
  end if;

  range_end := least(coalesce(p_to, local_today - 1), local_today - 1);

  select min(b.date)
    into earliest_success_date
    from public.bookings b
   where b.analytics_eligible = true
     and lower(coalesce(b.status, '')) in ('confirmed', 'completed')
     and b.date <= range_end;

  range_start := coalesce(p_from, earliest_success_date, range_end);
  if range_start > range_end then
    raise exception 'The Demand Intelligence start date must not be after yesterday.'
      using errcode = '22007';
  end if;
  if range_end - range_start > 3650 then
    raise exception 'Demand Intelligence ranges are limited to ten years.'
      using errcode = '22023';
  end if;
  if p_court_id is not null and not exists (
    select 1 from public.courts c where c.id = p_court_id
  ) then
    raise exception 'The selected court does not exist.'
      using errcode = '22023';
  end if;

  learning_days := range_end - range_start + 1;

  select case when s.value ~ '^\d{1,2}$' then s.value::integer end
    into open_hour
    from public.settings s
   where s.key = 'open_hour'
   limit 1;
  select case when s.value ~ '^\d{1,2}$' then s.value::integer end
    into close_hour
    from public.settings s
   where s.key = 'close_hour'
   limit 1;

  open_hour := greatest(0, least(coalesce(open_hour, 6), 23));
  close_hour := greatest(open_hour + 1, least(coalesce(close_hour, 22), 24));

  with
  bands as materialized (
    select h::integer as start_hour, least(h::integer + 3, close_hour) as end_hour
    from generate_series(open_hour, close_hour - 1, 3) h
  ),
  historical_days as materialized (
    select day::date
    from generate_series(range_start::timestamp, range_end::timestamp, interval '1 day') day
  ),
  eligible_courts as materialized (
    select c.id, c.name, greatest(coalesce(c.rate, 0), 0)::numeric as rate,
           c.created_at, c.blocked
    from public.courts c
    where p_court_id is null or c.id = p_court_id
  ),
  capacity as materialized (
    select
      c.id as court_id,
      c.name as court_name,
      c.rate,
      extract(isodow from d.day)::integer as weekday,
      b.start_hour,
      b.end_hour,
      sum(case
        when timezone('Asia/Manila', c.created_at)::date <= d.day
         and bd.date is null
          then b.end_hour - b.start_hour
        else 0
      end)::numeric as available_hours,
      count(distinct d.day) filter (
        where timezone('Asia/Manila', c.created_at)::date <= d.day
          and bd.date is null
      )::integer as comparable_days
    from eligible_courts c
    cross join historical_days d
    cross join bands b
    left join public.blocked_dates bd on bd.date = d.day
    group by c.id, c.name, c.rate, extract(isodow from d.day), b.start_hour, b.end_hour
  ),
  raw_successes as materialized (
    select
      b.ref,
      coalesce(nullif(btrim(b.booking_group_ref), ''), b.ref) as reservation_key,
      b.court_id,
      b.date,
      coalesce(b.slots, '{}'::text[]) as slots,
      b.start_time,
      greatest(coalesce(nullif(b.duration, 0), cardinality(coalesce(b.slots, '{}'::text[]))::numeric, 0), 0)::numeric as duration,
      row_number() over (
        partition by
          coalesce(nullif(btrim(b.booking_group_ref), ''), b.ref),
          b.court_id,
          b.date,
          coalesce(array_to_string(b.slots, ','), b.start_time, '')
        order by b.created_at, b.ref
      ) as logical_row_number
    from public.bookings b
    where b.analytics_eligible = true
      and lower(coalesce(b.status, '')) in ('confirmed', 'completed')
      and b.date between range_start and range_end
      and (p_court_id is null or b.court_id = p_court_id)
  ),
  success_rows as materialized (
    select
      r.*,
      case
        when coalesce(r.start_time, '') ~* '(AM|PM)'
          then mod(substring(r.start_time from '^\s*(\d{1,2})')::integer, 12)
             + case when r.start_time ~* 'PM' then 12 else 0 end
        when coalesce(r.start_time, '') ~ '^\s*\d{1,2}'
          then least(substring(r.start_time from '^\s*(\d{1,2})')::integer, 23)
        else open_hour
      end as parsed_start_hour
    from raw_successes r
    where r.logical_row_number = 1
  ),
  booked_units as materialized (
    select
      r.reservation_key,
      r.court_id,
      r.date,
      floor(slot_value::numeric)::integer as slot_hour,
      1::numeric as booked_hours
    from success_rows r
    cross join lateral unnest(r.slots) slot_value
    where slot_value ~ '^\d{1,2}(\.\d+)?$'

    union all

    select
      r.reservation_key,
      r.court_id,
      r.date,
      r.parsed_start_hour + unit.unit_offset as slot_hour,
      least(1::numeric, greatest(r.duration - unit.unit_offset, 0))::numeric as booked_hours
    from success_rows r
    cross join lateral generate_series(
      0,
      greatest(ceil(r.duration)::integer - 1, 0)
    ) unit(unit_offset)
    where cardinality(r.slots) = 0
      and r.duration > 0
      and r.parsed_start_hour + unit.unit_offset < 24
  ),
  booked_by_cell as materialized (
    select
      u.court_id,
      extract(isodow from u.date)::integer as weekday,
      b.start_hour,
      b.end_hour,
      sum(u.booked_hours)::numeric as booked_hours
    from booked_units u
    join bands b on u.slot_hour >= b.start_hour and u.slot_hour < b.end_hour
    group by u.court_id, extract(isodow from u.date), b.start_hour, b.end_hour
  ),
  future_days as materialized (
    select day::date
    from generate_series((local_today + 1)::timestamp, (local_today + 28)::timestamp, interval '1 day') day
  ),
  future_capacity_base as materialized (
    select
      c.id as court_id,
      extract(isodow from d.day)::integer as weekday,
      b.start_hour,
      b.end_hour,
      sum(case
        when not coalesce(c.blocked, false) and bd.date is null
          then b.end_hour - b.start_hour
        else 0
      end)::numeric as open_future_hours
    from eligible_courts c
    cross join future_days d
    cross join bands b
    left join public.blocked_dates bd on bd.date = d.day
    group by c.id, extract(isodow from d.day), b.start_hour, b.end_hour
  ),
  future_booking_rows as materialized (
    select
      b.ref,
      coalesce(nullif(btrim(b.booking_group_ref), ''), b.ref) as reservation_key,
      b.court_id,
      b.date,
      coalesce(b.slots, '{}'::text[]) as slots,
      b.start_time,
      greatest(coalesce(nullif(b.duration, 0), cardinality(coalesce(b.slots, '{}'::text[]))::numeric, 0), 0)::numeric as duration,
      row_number() over (
        partition by
          coalesce(nullif(btrim(b.booking_group_ref), ''), b.ref),
          b.court_id,
          b.date,
          coalesce(array_to_string(b.slots, ','), b.start_time, '')
        order by b.created_at, b.ref
      ) as logical_row_number
    from public.bookings b
    where b.date between local_today + 1 and local_today + 28
      and (p_court_id is null or b.court_id = p_court_id)
      and (
        lower(coalesce(b.status, '')) in ('confirmed', 'completed', 'pending')
        or (
          lower(coalesce(b.status, '')) = 'verifying'
          and b.created_at > clock_timestamp() - interval '15 minutes'
        )
      )
  ),
  future_success_rows as materialized (
    select
      r.*,
      case
        when coalesce(r.start_time, '') ~* '(AM|PM)'
          then mod(substring(r.start_time from '^\s*(\d{1,2})')::integer, 12)
             + case when r.start_time ~* 'PM' then 12 else 0 end
        when coalesce(r.start_time, '') ~ '^\s*\d{1,2}'
          then least(substring(r.start_time from '^\s*(\d{1,2})')::integer, 23)
        else open_hour
      end as parsed_start_hour
    from future_booking_rows r
    where r.logical_row_number = 1
  ),
  future_booked_units as materialized (
    select
      r.court_id,
      r.date,
      floor(slot_value::numeric)::integer as slot_hour,
      1::numeric as booked_hours
    from future_success_rows r
    cross join lateral unnest(r.slots) slot_value
    where slot_value ~ '^\d{1,2}(\.\d+)?$'

    union all

    select
      r.court_id,
      r.date,
      r.parsed_start_hour + unit.unit_offset as slot_hour,
      least(1::numeric, greatest(r.duration - unit.unit_offset, 0))::numeric as booked_hours
    from future_success_rows r
    cross join lateral generate_series(
      0,
      greatest(ceil(r.duration)::integer - 1, 0)
    ) unit(unit_offset)
    where cardinality(r.slots) = 0
      and r.duration > 0
      and r.parsed_start_hour + unit.unit_offset < 24
  ),
  future_booked_by_cell as materialized (
    select
      u.court_id,
      extract(isodow from u.date)::integer as weekday,
      b.start_hour,
      sum(u.booked_hours)::numeric as booked_hours
    from future_booked_units u
    join bands b on u.slot_hour >= b.start_hour and u.slot_hour < b.end_hour
    group by u.court_id, extract(isodow from u.date), b.start_hour
  ),
  future_capacity as materialized (
    select
      capacity.court_id,
      capacity.weekday,
      capacity.start_hour,
      capacity.end_hour,
      greatest(capacity.open_future_hours - coalesce(booked.booked_hours, 0), 0)::numeric as open_future_hours
    from future_capacity_base capacity
    left join future_booked_by_cell booked
      on booked.court_id = capacity.court_id
     and booked.weekday = capacity.weekday
     and booked.start_hour = capacity.start_hour
  ),
  court_signals_base as materialized (
    select
      cap.court_id,
      cap.court_name,
      cap.rate,
      cap.weekday,
      case cap.weekday
        when 1 then 'Mon' when 2 then 'Tue' when 3 then 'Wed' when 4 then 'Thu'
        when 5 then 'Fri' when 6 then 'Sat' else 'Sun'
      end as weekday_label,
      cap.start_hour,
      cap.end_hour,
      least(coalesce(booked.booked_hours, 0), cap.available_hours)::numeric as booked_hours,
      cap.available_hours,
      cap.comparable_days,
      case when cap.available_hours <= 0 then 0
        else round(least(100, coalesce(booked.booked_hours, 0) * 100 / cap.available_hours), 1)
      end as utilization_pct,
      coalesce(future.open_future_hours, 0)::numeric as open_future_hours
    from capacity cap
    left join booked_by_cell booked
      on booked.court_id = cap.court_id
     and booked.weekday = cap.weekday
     and booked.start_hour = cap.start_hour
    left join future_capacity future
      on future.court_id = cap.court_id
     and future.weekday = cap.weekday
     and future.start_hour = cap.start_hour
  ),
  court_signals as materialized (
    select
      s.*,
      case
        when learning_days < 30 or s.comparable_days < 4 then 'learning'
        when s.comparable_days < 8 then 'low'
        when s.comparable_days < 16 then 'medium'
        else 'high'
      end as confidence,
      case
        when learning_days < 30 or s.comparable_days < 4 then 'learning'
        when s.utilization_pct >= 80 then 'protected_peak'
        when s.utilization_pct >= 60 then 'healthy'
        when s.utilization_pct >= 40 then 'watch'
        when s.utilization_pct >= 15 then 'underused'
        else 'persistent_vacancy'
      end as state,
      round(s.open_future_hours * greatest(100 - s.utilization_pct, 0) / 100, 2) as expected_unsold_hours,
      round(s.open_future_hours * greatest(100 - s.utilization_pct, 0) / 100 * s.rate, 2) as opportunity_value
    from court_signals_base s
  ),
  venue_heatmap as materialized (
    select
      weekday,
      min(weekday_label) as weekday_label,
      start_hour,
      end_hour,
      sum(booked_hours)::numeric as booked_hours,
      sum(available_hours)::numeric as available_hours,
      max(comparable_days)::integer as comparable_days,
      case when sum(available_hours) <= 0 then 0
        else round(least(100, sum(booked_hours) * 100 / sum(available_hours)), 1)
      end as utilization_pct
    from court_signals
    group by weekday, start_hour, end_hour
  ),
  venue_heatmap_classified as materialized (
    select
      h.*,
      case
        when learning_days < 30 or h.comparable_days < 4 then 'learning'
        when h.comparable_days < 8 then 'low'
        when h.comparable_days < 16 then 'medium'
        else 'high'
      end as confidence,
      case
        when learning_days < 30 or h.comparable_days < 4 then 'learning'
        when h.utilization_pct >= 80 then 'protected_peak'
        when h.utilization_pct >= 60 then 'healthy'
        when h.utilization_pct >= 40 then 'watch'
        when h.utilization_pct >= 15 then 'underused'
        else 'persistent_vacancy'
      end as state
    from venue_heatmap h
  ),
  recommendation_candidate as materialized (
    select s.*
    from court_signals s
    where learning_days >= 30
      and s.comparable_days >= 8
      and s.confidence in ('medium', 'high')
      and s.state in ('persistent_vacancy', 'underused')
      and s.open_future_hours > 0
      and not exists (
        select 1 from public.demand_campaigns campaign
        where campaign.status = 'active' and campaign.ends_at > clock_timestamp()
      )
    order by s.opportunity_value desc, s.utilization_pct asc,
             s.comparable_days desc, s.court_id, s.weekday, s.start_hour
    limit 1
  ),
  recommendation as materialized (
    select
      candidate.*,
      'DG-' || upper(substr(encode(public.digest(
        concat_ws('|',
          candidate.court_id,
          candidate.weekday,
          candidate.start_hour,
          candidate.end_hour,
          range_start,
          range_end,
          candidate.comparable_days,
          candidate.available_hours,
          candidate.utilization_pct
        ),
        'sha256'
      ), 'hex'), 1, 24)) as recommendation_id
    from recommendation_candidate candidate
  ),
  active_campaign_rows as materialized (
    select
      campaign.*,
      count(redemption.id) filter (where redemption.status = 'redeemed')::integer as redeemed_count,
      count(redemption.id) filter (where redemption.status = 'reserved')::integer as reserved_count,
      count(redemption.id) filter (where redemption.status in ('reserved', 'redeemed'))::integer as redemption_count,
      coalesce(sum(redemption.discount_amount) filter (
        where redemption.status in ('reserved', 'redeemed')
      ), 0)::numeric as discount_cost
    from public.demand_campaigns campaign
    left join public.demand_campaign_redemptions redemption on redemption.campaign_id = campaign.id
    where campaign.status = 'active' and campaign.ends_at > clock_timestamp()
    group by campaign.id
  ),
  summary as materialized (
    select
      coalesce((select count(distinct reservation_key) from success_rows), 0)::integer as successful_reservations,
      coalesce(sum(booked_hours), 0)::numeric as booked_hours,
      coalesce(sum(available_hours), 0)::numeric as available_hours,
      coalesce(sum(open_future_hours), 0)::numeric as future_open_hours,
      coalesce(sum(expected_unsold_hours), 0)::numeric as expected_unsold_hours,
      coalesce(sum(opportunity_value), 0)::numeric as opportunity_value,
      count(*) filter (
        where learning_days >= 30
          and comparable_days >= 8
          and confidence in ('medium', 'high')
          and state in ('persistent_vacancy', 'underused')
          and open_future_hours > 0
      )::integer as action_ready_windows
    from court_signals
  )
  select jsonb_build_object(
    'period', jsonb_build_object(
      'from', range_start,
      'to', range_end,
      'days_analyzed', learning_days,
      'learning_days', learning_days,
      'minimum_learning_days', 30
    ),
    'kpis', jsonb_build_object(
      'successful_reservations', summary.successful_reservations,
      'booked_hours', round(summary.booked_hours, 2),
      'available_hours', round(summary.available_hours, 2),
      'utilization_pct', case when summary.available_hours <= 0 then 0
        else round(least(100, summary.booked_hours * 100 / summary.available_hours), 1)
      end,
      'predicted_28d_fill_pct', case when summary.future_open_hours <= 0 then 0
        else round(least(100, greatest(0,
          (summary.future_open_hours - summary.expected_unsold_hours) * 100 / summary.future_open_hours
        )), 1)
      end,
      'expected_unsold_hours', round(summary.expected_unsold_hours, 2),
      'opportunity_value', round(summary.opportunity_value, 2),
      'action_ready_windows', summary.action_ready_windows
    ),
    'heatmap', coalesce((
      select jsonb_agg(jsonb_build_object(
        'weekday', h.weekday,
        'weekday_label', h.weekday_label,
        'start_hour', h.start_hour,
        'end_hour', h.end_hour,
        'booked_hours', round(h.booked_hours, 2),
        'available_hours', round(h.available_hours, 2),
        'comparable_days', h.comparable_days,
        'utilization_pct', h.utilization_pct,
        'confidence', h.confidence,
        'state', h.state
      ) order by h.start_hour, h.weekday)
      from venue_heatmap_classified h
    ), '[]'::jsonb),
    'court_signals', coalesce((
      select jsonb_agg(jsonb_build_object(
        'court_id', s.court_id,
        'court_name', s.court_name,
        'rate', s.rate,
        'weekday', s.weekday,
        'weekday_label', s.weekday_label,
        'start_hour', s.start_hour,
        'end_hour', s.end_hour,
        'booked_hours', round(s.booked_hours, 2),
        'available_hours', round(s.available_hours, 2),
        'comparable_days', s.comparable_days,
        'utilization_pct', s.utilization_pct,
        'confidence', s.confidence,
        'state', s.state,
        'open_future_hours', round(s.open_future_hours, 2),
        'opportunity_value', s.opportunity_value
      ) order by s.opportunity_value desc, s.start_hour, s.weekday, s.court_id)
      from court_signals s
    ), '[]'::jsonb),
    'recommendation', (
      select jsonb_build_object(
        'id', r.recommendation_id,
        'court_id', r.court_id,
        'court_name', r.court_name,
        'weekday', r.weekday,
        'weekday_label', r.weekday_label,
        'start_hour', r.start_hour,
        'end_hour', r.end_hour,
        'utilization_pct', r.utilization_pct,
        'expected_empty_pct', round(greatest(100 - r.utilization_pct, 0), 1),
        'booked_hours', round(r.booked_hours, 2),
        'comparable_days', r.comparable_days,
        'available_hours', round(r.available_hours, 2),
        'confidence', r.confidence,
        'state', r.state,
        'discount_percent', 10,
        'valid_days', 28,
        'max_redemptions', 20,
        'open_future_hours', round(r.open_future_hours, 2),
        'opportunity_value', r.opportunity_value
      ) from recommendation r
    ),
    'active_campaigns', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'recommendation_id', c.source_recommendation_id,
        'court_id', c.court_id,
        'court_name', c.court_name_snapshot,
        'weekday', c.weekday,
        'weekday_label', case c.weekday
          when 1 then 'Mon' when 2 then 'Tue' when 3 then 'Wed' when 4 then 'Thu'
          when 5 then 'Fri' when 6 then 'Sat' else 'Sun' end,
        'start_hour', c.start_hour,
        'end_hour', c.end_hour,
        'discount_percent', c.discount_percent,
        'max_redemptions', c.max_redemptions,
        'redeemed_count', c.redeemed_count,
        'reserved_count', c.reserved_count,
        'redemption_count', c.redemption_count,
        'discount_cost', round(c.discount_cost, 2),
        'starts_at', c.starts_at,
        'ends_at', c.ends_at,
        'status', c.status
      ) order by c.created_at desc)
      from active_campaign_rows c
    ), '[]'::jsonb),
    'data_quality', jsonb_build_object(
      'note', 'Demand learning includes only analytics-eligible confirmed/completed play dates through yesterday. Pending, verifying, cancelled, rejected, failed, expired, and forfeited records do not influence demand.',
      'successful_statuses', jsonb_build_array('confirmed', 'completed'),
      'through_date', range_end,
      'all_genuine_sources_included', true
    )
  )
  into result
  from summary;

  return result;
end;
$$;

revoke all on function public.get_demand_growth_intelligence(date, date, text) from public, anon;
grant execute on function public.get_demand_growth_intelligence(date, date, text) to authenticated;

create or replace function public.create_demand_campaign_from_recommendation(
  p_recommendation_id text,
  p_court_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  account_role text := public.current_account_role();
  clean_id text := upper(btrim(coalesce(p_recommendation_id, '')));
  existing public.demand_campaigns%rowtype;
  snapshot jsonb;
  recommendation jsonb;
  inserted public.demand_campaigns%rowtype;
begin
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can create a demand campaign.'
      using errcode = '42501';
  end if;
  if clean_id !~ '^DG-[A-F0-9]{24}$' then
    raise exception 'Demand recommendation ID is invalid.' using errcode = '22023';
  end if;
  if p_court_id is not null and not exists (
    select 1 from public.courts court where court.id = p_court_id
  ) then
    raise exception 'The selected court does not exist.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('korte-dos-demand-campaign-create', 0));

  update public.demand_campaigns
     set status = 'ended', ended_at = coalesce(ended_at, now()), updated_at = now()
   where status = 'active' and ends_at <= now();

  select * into existing
  from public.demand_campaigns campaign
  where campaign.status = 'active'
  limit 1
  for update;

  if found then
    if existing.source_recommendation_id = clean_id then
      return jsonb_build_object(
        'created', false, 'idempotent', true, 'campaign_id', existing.id,
        'status', existing.status, 'starts_at', existing.starts_at, 'ends_at', existing.ends_at
      );
    end if;
    raise exception 'A growth campaign is already active. End it before applying another recommendation.'
      using errcode = 'P0001';
  end if;

  select * into existing
  from public.demand_campaigns campaign
  where campaign.source_recommendation_id = clean_id
  limit 1;
  if found then
    return jsonb_build_object(
      'created', false, 'idempotent', true, 'campaign_id', existing.id,
      'status', existing.status, 'starts_at', existing.starts_at, 'ends_at', existing.ends_at
    );
  end if;

  snapshot := public.get_demand_growth_intelligence(null, null, p_court_id);
  recommendation := snapshot -> 'recommendation';
  if recommendation is null or recommendation = 'null'::jsonb then
    raise exception 'There is no evidence-backed demand recommendation to apply yet.'
      using errcode = 'P0001';
  end if;
  if upper(coalesce(recommendation ->> 'id', '')) <> clean_id then
    raise exception 'This demand recommendation changed. Refresh Insights before applying it.'
      using errcode = '40001';
  end if;
  if coalesce(recommendation ->> 'confidence', '') not in ('medium', 'high')
     or coalesce(recommendation ->> 'state', '') not in ('persistent_vacancy', 'underused')
     or coalesce((recommendation ->> 'comparable_days')::integer, 0) < 8
     or coalesce((snapshot #>> '{period,learning_days}')::integer, 0) < 30 then
    raise exception 'This recommendation no longer has enough evidence to publish.'
      using errcode = 'P0001';
  end if;

  insert into public.demand_campaigns (
    source_recommendation_id,
    court_id,
    court_name_snapshot,
    weekday,
    start_hour,
    end_hour,
    discount_percent,
    max_redemptions,
    starts_at,
    ends_at,
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
    (recommendation ->> 'end_hour')::smallint,
    least((recommendation ->> 'discount_percent')::numeric, 10),
    least((recommendation ->> 'max_redemptions')::integer, 20),
    now(),
    now() + least((recommendation ->> 'valid_days')::integer, 28) * interval '1 day',
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
  )
  returning * into inserted;

  return jsonb_build_object(
    'created', inserted.status = 'active',
    'idempotent', inserted.created_at < now() - interval '1 second',
    'campaign_id', inserted.id,
    'recommendation_id', inserted.source_recommendation_id,
    'court_id', inserted.court_id,
    'court_name', inserted.court_name_snapshot,
    'weekday', inserted.weekday,
    'start_hour', inserted.start_hour,
    'end_hour', inserted.end_hour,
    'discount_percent', inserted.discount_percent,
    'max_redemptions', inserted.max_redemptions,
    'status', inserted.status,
    'starts_at', inserted.starts_at,
    'ends_at', inserted.ends_at
  );
end;
$$;

revoke all on function public.create_demand_campaign_from_recommendation(text, text) from public, anon;
grant execute on function public.create_demand_campaign_from_recommendation(text, text) to authenticated;

create or replace function public.apply_matching_demand_campaign(p_booking_refs text[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  request_role text := coalesce(auth.role(), nullif(current_setting('request.jwt.claim.role', true), ''));
  account_role text := public.current_account_role();
  local_today date := timezone('Asia/Manila', clock_timestamp())::date;
  clean_refs text[];
  group_key text;
  campaign public.demand_campaigns%rowtype;
  supplied_count integer;
  eligible_count integer;
  group_identity text;
  group_identity_count integer;
  active_group_count integer;
  usage_count integer;
  gross_amount numeric(12,2);
  eligible_court_amount numeric(12,2);
  discount_amount numeric(12,2);
  reservation_deadline timestamptz;
  affected_refs text[];
  allocations jsonb;
  existing_redemption public.demand_campaign_redemptions%rowtype;
begin
  if request_role <> 'anon'
     and not (request_role = 'authenticated' and account_role = 'host') then
    raise exception 'Automatic demand pricing is available only to public and host booking holds.'
      using errcode = '42501';
  end if;

  clean_refs := array(
    select distinct upper(btrim(ref))
    from unnest(coalesce(p_booking_refs, '{}'::text[])) ref
    where btrim(ref) <> ''
    order by 1
  );
  if cardinality(clean_refs) = 0 then
    return jsonb_build_object('applied', false, 'reason', 'no_booking_holds');
  end if;
  group_key := public.demand_booking_group_key(clean_refs);

  perform public.release_expired_demand_campaign_reservations();

  select * into campaign
  from public.demand_campaigns c
  where c.status = 'active'
    and c.starts_at <= now()
    and c.ends_at > now()
  limit 1
  for update;

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'no_active_campaign');
  end if;

  perform 1
  from public.bookings booking
  where booking.ref = any(clean_refs)
  order by booking.ref
  for update;

  select
    count(*),
    count(*) filter (
      where booking.status = 'verifying'
        and booking.created_at > now() - interval '15 minutes'
        and booking.date > local_today
        and (
          (request_role = 'anon'
            and coalesce(booking.host_booking, false) = false
            and booking.host_user_id is null
            and booking.created_via = 'customer'
            and booking.created_by_user_id is null
            and booking.email = 'reserve@hold.internal')
          or
          (request_role = 'authenticated'
            and account_role = 'host'
            and coalesce(booking.host_booking, false) = true
            and booking.host_user_id = auth.uid()
            and booking.created_via = 'host'
            and booking.created_by_user_id = auth.uid())
        )
    ),
    min(coalesce(nullif(btrim(booking.booking_group_ref), ''), booking.ref)),
    count(distinct coalesce(nullif(btrim(booking.booking_group_ref), ''), booking.ref)),
    min(booking.created_at + interval '15 minutes')
  into supplied_count, eligible_count, group_identity, group_identity_count, reservation_deadline
  from public.bookings booking
  where booking.ref = any(clean_refs);

  if supplied_count <> cardinality(clean_refs) or eligible_count <> cardinality(clean_refs) then
    raise exception 'The booking reservation expired or changed. Please select the slots again.'
      using errcode = 'P0001';
  end if;
  if group_identity_count <> 1 then
    raise exception 'Demand pricing can be applied to one booking group at a time.'
      using errcode = '22023';
  end if;

  select count(*) into active_group_count
  from public.bookings booking
  where coalesce(nullif(btrim(booking.booking_group_ref), ''), booking.ref) = group_identity
    and booking.status not in ('cancelled', 'forfeited');
  if active_group_count <> cardinality(clean_refs) then
    raise exception 'The complete booking group is required for automatic demand pricing.'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from public.bookings booking
    where booking.ref = any(clean_refs)
      and (booking.voucher_id is not null or coalesce(booking.voucher_discount_amount, 0) > 0)
  ) then
    return jsonb_build_object('applied', false, 'reason', 'voucher_already_applied');
  end if;
  if exists (
    select 1 from public.bookings booking
    where booking.ref = any(clean_refs)
      and booking.demand_campaign_id is not null
      and booking.demand_campaign_id <> campaign.id
  ) then
    return jsonb_build_object('applied', false, 'reason', 'demand_campaign_already_applied');
  end if;

  select * into existing_redemption
  from public.demand_campaign_redemptions redemption
  where redemption.campaign_id = campaign.id
    and redemption.booking_group_key = group_key;
  if found then
    select coalesce(jsonb_agg(jsonb_build_object(
      'ref', booking.ref,
      'gross_total', booking.demand_campaign_gross_total,
      'discount_amount', booking.demand_campaign_discount_amount,
      'total', booking.total
    ) order by booking.ref), '[]'::jsonb)
    into allocations
    from public.bookings booking
    where booking.ref = any(existing_redemption.booking_refs);

    return jsonb_build_object(
      'applied', existing_redemption.status <> 'released',
      'idempotent', true,
      'campaign_id', campaign.id,
      'discount_percent', campaign.discount_percent,
      'discount_amount', existing_redemption.discount_amount,
      'allocations', allocations
    );
  end if;

  with matching as (
    select booking.*
    from public.bookings booking
    where booking.ref = any(clean_refs)
      and booking.court_id = campaign.court_id
      and extract(isodow from booking.date)::integer = campaign.weekday
      and cardinality(coalesce(booking.slots, '{}'::text[])) > 0
      and not exists (
        select 1 from unnest(booking.slots) slot_value
        where case
          when slot_value !~ '^\d{1,2}(\.\d+)?$' then true
          else floor(slot_value::numeric)::integer < campaign.start_hour
            or floor(slot_value::numeric)::integer >= campaign.end_hour
        end
      )
      and booking.demand_campaign_id is null
  ), basis as (
    select
      booking.ref,
      coalesce(booking.demand_campaign_gross_total, booking.total)::numeric as gross_total,
      greatest(
        coalesce(booking.demand_campaign_gross_total, booking.total)
          - least(
              greatest(coalesce(booking.booking_fee_amount_snapshot, 0), 0),
              coalesce(booking.demand_campaign_gross_total, booking.total)
            ),
        0
      )::numeric as eligible_amount
    from matching booking
  )
  select
    count(*),
    coalesce(round(sum(gross_total), 2), 0),
    coalesce(round(sum(eligible_amount), 2), 0),
    coalesce(array_agg(ref order by ref), '{}'::text[])
  into eligible_count, gross_amount, eligible_court_amount, affected_refs
  from basis;

  if eligible_count = 0 or eligible_court_amount <= 0 then
    return jsonb_build_object('applied', false, 'reason', 'booking_not_in_campaign_window');
  end if;

  select count(*) into usage_count
  from public.demand_campaign_redemptions redemption
  where redemption.campaign_id = campaign.id
    and redemption.status in ('reserved', 'redeemed');
  if usage_count >= campaign.max_redemptions then
    return jsonb_build_object('applied', false, 'reason', 'campaign_limit_reached');
  end if;

  discount_amount := round(eligible_court_amount * campaign.discount_percent / 100, 2);
  discount_amount := greatest(least(discount_amount, eligible_court_amount), 0);
  if discount_amount <= 0 then
    return jsonb_build_object('applied', false, 'reason', 'no_discount');
  end if;

  insert into public.demand_campaign_redemptions (
    campaign_id,
    booking_group_key,
    booking_refs,
    gross_amount,
    eligible_court_amount,
    discount_amount,
    reserved_until
  ) values (
    campaign.id,
    group_key,
    affected_refs,
    gross_amount,
    eligible_court_amount,
    discount_amount,
    reservation_deadline
  );

  perform set_config('app.demand_campaign_apply', '1', true);
  with basis as (
    select
      booking.ref,
      coalesce(booking.demand_campaign_gross_total, booking.total)::numeric as gross_total,
      greatest(
        coalesce(booking.demand_campaign_gross_total, booking.total)
          - least(
              greatest(coalesce(booking.booking_fee_amount_snapshot, 0), 0),
              coalesce(booking.demand_campaign_gross_total, booking.total)
            ),
        0
      )::numeric as eligible_amount
    from public.bookings booking
    where booking.ref = any(affected_refs)
  ), allocated as (
    select
      basis.*,
      row_number() over (order by basis.ref) as row_no,
      count(*) over () as row_count
    from basis
  ), discounts as (
    select
      allocated.*,
      case
        when allocated.row_no < allocated.row_count
          then round(discount_amount * allocated.eligible_amount / nullif(eligible_court_amount, 0), 2)
        else discount_amount - coalesce(sum(
          round(discount_amount * allocated.eligible_amount / nullif(eligible_court_amount, 0), 2)
        ) over (order by allocated.row_no rows between unbounded preceding and 1 preceding), 0)
      end as item_discount
    from allocated
  )
  update public.bookings booking
     set demand_campaign_id = campaign.id,
         demand_campaign_discount_percent_snapshot = campaign.discount_percent,
         demand_campaign_gross_total = discounts.gross_total,
         demand_campaign_discount_amount = discounts.item_discount,
         total = discounts.gross_total - discounts.item_discount
    from discounts
   where booking.ref = discounts.ref;

  select coalesce(jsonb_agg(jsonb_build_object(
    'ref', booking.ref,
    'gross_total', booking.demand_campaign_gross_total,
    'discount_amount', booking.demand_campaign_discount_amount,
    'total', booking.total
  ) order by booking.ref), '[]'::jsonb)
  into allocations
  from public.bookings booking
  where booking.ref = any(affected_refs);

  return jsonb_build_object(
    'applied', true,
    'idempotent', false,
    'campaign_id', campaign.id,
    'campaign_name', campaign.court_name_snapshot || ' ' || campaign.start_hour || ':00-' || campaign.end_hour || ':00 demand offer',
    'discount_percent', campaign.discount_percent,
    'discount_amount', discount_amount,
    'gross_amount', gross_amount,
    'total', gross_amount - discount_amount,
    'allocations', allocations,
    'reserved_until', reservation_deadline
  );
end;
$$;

revoke all on function public.apply_matching_demand_campaign(text[]) from public;
grant execute on function public.apply_matching_demand_campaign(text[]) to anon, authenticated;

-- Voucher choice is explicit and takes precedence over an automatic growth
-- offer. If the campaign RPC committed but its response was lost, applying a
-- valid voucher must atomically restore the original price, release the still-
-- reserved campaign use, and then calculate the voucher from that gross price.
-- This is the latest role-aware voucher RPC plus the demand opt-out step so the
-- forward migration remains self-contained and deployment order is explicit.
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
  released_demand_count integer := 0;
  request_role text := coalesce(auth.role(), nullif(current_setting('request.jwt.claim.role', true), ''));
  account_role text := public.current_account_role();
begin
  clean_refs := array(
    select distinct trim(ref)
      from unnest(coalesce(p_booking_refs, '{}')) ref
     where trim(ref) <> ''
     order by 1
  );
  if cardinality(clean_refs) = 0 then
    raise exception 'No active booking reservation was supplied.';
  end if;
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

  -- The hold eligibility and ownership checks below still govern the whole
  -- transaction. If any later voucher validation fails, this opt-out rolls
  -- back with it. Only the reservation linked to these exact refs is released.
  perform set_config('app.demand_campaign_apply', '1', true);
  with released as (
    update public.demand_campaign_redemptions redemption
       set status = 'released',
           released_at = coalesce(redemption.released_at, now()),
           updated_at = now()
     where redemption.status = 'reserved'
       and redemption.booking_refs && clean_refs
    returning redemption.campaign_id, redemption.booking_refs
  ), restored as (
    update public.bookings booking
       set total = coalesce(booking.demand_campaign_gross_total, booking.total),
           demand_campaign_id = null,
           demand_campaign_discount_percent_snapshot = null,
           demand_campaign_discount_amount = 0,
           demand_campaign_gross_total = null
     where booking.ref = any(clean_refs)
       and exists (
         select 1
           from released
          where released.campaign_id = booking.demand_campaign_id
            and booking.ref = any(released.booking_refs)
       )
    returning 1
  )
  select count(*) into released_demand_count from restored;

  select count(*),
         round(sum(coalesce(voucher_gross_total, total)), 2),
         round(sum(greatest(
           coalesce(voucher_gross_total, total)
             - least(
                 greatest(coalesce(booking_fee_amount_snapshot, 0), 0),
                 coalesce(voucher_gross_total, total)
               ),
           0
         )), 2),
         array_agg(distinct court_id),
         min(created_at + interval '15 minutes'),
         (array_agg(voucher_id) filter (where voucher_id is not null))[1],
         min(booking_group_ref),
         count(distinct coalesce(booking_group_ref, ref))
    into booking_count, gross_amount, eligible_amount, court_ids, reservation_deadline,
         existing_voucher_id, selected_group_ref, group_identity_count
    from public.bookings
   where ref = any(clean_refs)
     and status = 'verifying'
     and created_at > now() - interval '15 minutes'
     and email = 'reserve@hold.internal'
     and downpayment is null
     and payment_session_id is null
     and receipt_image_url is null
     and (
       (
         request_role = 'anon'
         and coalesce(host_booking, false) = false
         and created_via = 'customer'
         and created_by_user_id is null
       )
       or
       (
         request_role = 'authenticated'
         and account_role = 'host'
         and coalesce(host_booking, false) = true
         and host_user_id = auth.uid()
         and created_via = 'host'
         and created_by_user_id = auth.uid()
         and created_by_role = 'host'
       )
     );

  if booking_count <> cardinality(clean_refs) then
    raise exception 'The booking reservation expired, changed, or does not belong to this account. Please select the slots again.';
  end if;
  if group_identity_count <> 1 then raise exception 'Voucher codes must be applied to one booking group at a time.'; end if;
  if selected_group_ref is not null and exists (
    select 1
      from public.bookings
     where booking_group_ref = selected_group_ref
       and status <> 'cancelled'
       and not (ref = any(clean_refs))
  ) then
    raise exception 'The complete booking group is required to apply a voucher.';
  end if;
  if eligible_amount < voucher_row.minimum_spend then
    raise exception 'This voucher requires a minimum court spend of PHP %.',
      trim(to_char(voucher_row.minimum_spend, 'FM999999990.00'));
  end if;
  if cardinality(voucher_row.applicable_court_ids) > 0
     and exists (
       select 1
         from unnest(court_ids) court_id
        where not (court_id = any(voucher_row.applicable_court_ids))
     ) then
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
      from public.bookings
     where ref = any(clean_refs);
    return jsonb_build_object(
      'id', voucher_row.id,
      'code', voucher_row.code,
      'name', voucher_row.name,
      'discountAmount', (select coalesce(sum(voucher_discount_amount), 0) from public.bookings where ref = any(clean_refs)),
      'grossAmount', gross_amount,
      'total', gross_amount - (select coalesce(sum(voucher_discount_amount), 0) from public.bookings where ref = any(clean_refs)),
      'allocations', result_rows,
      'reservedUntil', reservation_deadline,
      'replacedDemandCampaign', released_demand_count > 0
    );
  end if;

  if existing_voucher_id is not null then
    raise exception 'Remove the current voucher before applying a different code.';
  end if;

  select count(*) into usage_count
    from public.voucher_redemptions
   where voucher_id = voucher_row.id
     and status in ('reserved', 'redeemed');
  if voucher_row.usage_limit is not null and usage_count >= voucher_row.usage_limit then
    raise exception 'This voucher has reached its redemption limit.';
  end if;

  discount_amount := case voucher_row.discount_type
    when 'fixed' then voucher_row.discount_value
    else round(eligible_amount * voucher_row.discount_value / 100, 2)
  end;
  if voucher_row.max_discount is not null then
    discount_amount := least(discount_amount, voucher_row.max_discount);
  end if;
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
           greatest(
             coalesce(b.voucher_gross_total, b.total)
               - least(
                   greatest(coalesce(b.booking_fee_amount_snapshot, 0), 0),
                   coalesce(b.voucher_gross_total, b.total)
                 ),
             0
           ) as eligible,
           row_number() over (order by b.ref) as row_no,
           count(*) over () as row_count
      from public.bookings b
     where b.ref = any(clean_refs)
  ), allocated as (
    select basis.*,
           case
             when row_no < row_count then
               round(discount_amount * eligible / nullif(eligible_amount, 0), 2)
             else
               discount_amount - coalesce(
                 sum(round(discount_amount * eligible / nullif(eligible_amount, 0), 2))
                   over (order by row_no rows between unbounded preceding and 1 preceding),
                 0
               )
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
    from public.bookings
   where ref = any(clean_refs);

  return jsonb_build_object(
    'id', voucher_row.id,
    'code', voucher_row.code,
    'name', voucher_row.name,
    'discountType', voucher_row.discount_type,
    'discountValue', voucher_row.discount_value,
    'discountAmount', discount_amount,
    'grossAmount', gross_amount,
    'total', gross_amount - discount_amount,
    'allocations', result_rows,
    'reservedUntil', reservation_deadline,
    'replacedDemandCampaign', released_demand_count > 0
  );
end;
$$;

revoke all on function public.apply_booking_voucher(text, text[]) from public;
grant execute on function public.apply_booking_voucher(text, text[]) to anon, authenticated;

create or replace function public.end_demand_campaign(p_campaign_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  account_role text := public.current_account_role();
  ended public.demand_campaigns%rowtype;
begin
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can end a demand campaign.'
      using errcode = '42501';
  end if;

  update public.demand_campaigns
     set status = 'ended', ended_by = auth.uid(), ended_at = coalesce(ended_at, now()), updated_at = now()
   where id = p_campaign_id
  returning * into ended;

  if not found then
    raise exception 'Demand campaign was not found.' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'campaign_id', ended.id,
    'status', ended.status,
    'ended_at', ended.ended_at
  );
end;
$$;

revoke all on function public.end_demand_campaign(uuid) from public, anon;
grant execute on function public.end_demand_campaign(uuid) to authenticated;

create or replace function public.sync_demand_campaign_redemption()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status in ('cancelled', 'forfeited') and old.status is distinct from new.status then
    update public.demand_campaign_redemptions redemption
       set status = 'released', released_at = coalesce(released_at, now()), updated_at = now()
     where redemption.status = 'reserved'
       and new.ref = any(redemption.booking_refs)
       and not exists (
         select 1 from public.bookings booking
         where booking.ref = any(redemption.booking_refs)
           and booking.ref <> new.ref
           and booking.status not in ('cancelled', 'forfeited')
       );
  elsif new.demand_campaign_id is not null
     and nullif(btrim(new.email), '') is not null
     and new.email <> 'reserve@hold.internal'
     and (
       new.status in ('pending', 'confirmed', 'completed')
       or nullif(btrim(coalesce(new.receipt_image_url, '')), '') is not null
     ) then
    update public.demand_campaign_redemptions redemption
       set status = 'redeemed', redeemed_at = coalesce(redemption.redeemed_at, now()),
           updated_at = now()
     where redemption.campaign_id = new.demand_campaign_id
       and new.ref = any(redemption.booking_refs)
       and redemption.status = 'reserved';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_demand_campaign_redemption on public.bookings;
create trigger trg_sync_demand_campaign_redemption
after update of email, status, receipt_image_url on public.bookings
for each row execute function public.sync_demand_campaign_redemption();

revoke all on function public.sync_demand_campaign_redemption() from public, anon, authenticated;

-- Archived rows created before this migration do not contain the new fields.
-- Coalescing defaults here keeps restores forward-compatible. Public/host
-- callers also cannot smuggle campaign snapshots into a new hold.
create or replace function public.prepare_demand_campaign_booking_defaults()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  request_role text := coalesce(auth.role(), nullif(current_setting('request.jwt.claim.role', true), ''));
  account_role text := public.current_account_role();
begin
  new.analytics_eligible := coalesce(new.analytics_eligible, true);
  new.demand_campaign_discount_amount := coalesce(new.demand_campaign_discount_amount, 0);

  if request_role = 'anon' or (request_role = 'authenticated' and account_role = 'host') then
    new.analytics_eligible := true;
    new.demand_campaign_id := null;
    new.demand_campaign_discount_percent_snapshot := null;
    new.demand_campaign_discount_amount := 0;
    new.demand_campaign_gross_total := null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_prepare_demand_campaign_booking_defaults on public.bookings;
create trigger trg_prepare_demand_campaign_booking_defaults
before insert on public.bookings
for each row execute function public.prepare_demand_campaign_booking_defaults();

revoke all on function public.prepare_demand_campaign_booking_defaults() from public, anon, authenticated;

-- Extend the existing public/host hold guard so only the security-definer
-- campaign RPC may mutate its own isolated price snapshot. Direct clients
-- remain unable to change any price, campaign, or analytics field.
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
  demand_context boolean := coalesce(current_setting('app.demand_campaign_apply', true), '') = '1';
  service_fee numeric := 0;
  public_due numeric := 0;
  host_due numeric := 0;
  campaign_gross_total numeric := 0;
  campaign_gross_due numeric := 0;
  campaign_unaware_payment boolean := false;
begin
  if request_role = 'anon' or (request_role = 'authenticated' and account_role = 'host') then
    if new.ref is distinct from old.ref
      or new.booking_group_ref is distinct from old.booking_group_ref
      or new.court_id is distinct from old.court_id or new.court_name is distinct from old.court_name
      or new.date is distinct from old.date or new.slots is distinct from old.slots
      or new.start_time is distinct from old.start_time or new.end_time is distinct from old.end_time
      or new.duration is distinct from old.duration or new.rate is distinct from old.rate
      or (not voucher_context and not demand_context and new.total is distinct from old.total)
      or (not voucher_context and new.voucher_id is distinct from old.voucher_id)
      or (not voucher_context and new.voucher_code_snapshot is distinct from old.voucher_code_snapshot)
      or (not voucher_context and new.voucher_discount_amount is distinct from old.voucher_discount_amount)
      or (not voucher_context and new.voucher_gross_total is distinct from old.voucher_gross_total)
      or (not demand_context and new.demand_campaign_id is distinct from old.demand_campaign_id)
      or (not demand_context and new.demand_campaign_discount_percent_snapshot is distinct from old.demand_campaign_discount_percent_snapshot)
      or (not demand_context and new.demand_campaign_discount_amount is distinct from old.demand_campaign_discount_amount)
      or (not demand_context and new.demand_campaign_gross_total is distinct from old.demand_campaign_gross_total)
      or new.analytics_eligible is distinct from old.analytics_eligible
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

  -- Fail open at the original price if campaign application committed but its
  -- response never reached the browser. A client in that state submits the
  -- pre-campaign full/partial amount. Restore only this still-fresh hold,
  -- release the reservation counter, and then validate the original amount as
  -- normal. A client that received the offer submits the discounted amount and
  -- keeps the campaign snapshot.
  if (request_role = 'anon' or (request_role = 'authenticated' and account_role = 'host'))
     and new.downpayment is not null
     and old.status = 'verifying'
     and old.created_at > now() - interval '15 minutes'
     and old.demand_campaign_id is not null
     and old.demand_campaign_gross_total is not null
     and old.demand_campaign_discount_amount > 0 then
    campaign_gross_total := old.demand_campaign_gross_total;
    service_fee := least(
      greatest(coalesce(old.booking_fee_amount_snapshot, 0), 0),
      campaign_gross_total
    );

    if request_role = 'anon' then
      campaign_gross_due := round(service_fee + ((campaign_gross_total - service_fee) * 0.50), 2);
      campaign_unaware_payment :=
        abs(new.downpayment - campaign_gross_total) <= 0.01
        or abs(new.downpayment - campaign_gross_due) <= 0.01
        or abs(new.downpayment - (campaign_gross_total / 2)) <= 0.01
        or abs(new.downpayment - round(campaign_gross_total / 2)) <= 0.01;
    else
      campaign_gross_due := round(service_fee + ((campaign_gross_total - service_fee) * 0.25), 2);
      campaign_unaware_payment :=
        abs(new.downpayment - campaign_gross_total) <= 0.01
        or abs(new.downpayment - campaign_gross_due) <= 0.01;
    end if;

    if campaign_unaware_payment then
      update public.demand_campaign_redemptions redemption
         set status = 'released',
             released_at = coalesce(redemption.released_at, now()),
             updated_at = now()
       where redemption.campaign_id = old.demand_campaign_id
         and old.ref = any(redemption.booking_refs)
         and redemption.status = 'reserved';

      new.total := campaign_gross_total;
      new.demand_campaign_id := null;
      new.demand_campaign_discount_percent_snapshot := null;
      new.demand_campaign_discount_amount := 0;
      new.demand_campaign_gross_total := null;
    end if;
  end if;

  if request_role = 'anon' then
    if coalesce(old.host_booking, false) or old.host_user_id is not null or old.created_via <> 'customer' or old.created_by_user_id is not null then
      raise exception 'Anonymous clients may only finalize public customer holds.';
    end if;
    if new.downpayment is not null then
      if new.total is null or new.total < 0 then raise exception 'Reservation payment amount is invalid.'; end if;
      service_fee := least(greatest(coalesce(old.booking_fee_amount_snapshot, 0), 0), new.total);
      public_due := round(service_fee + ((new.total - service_fee) * 0.50), 2);
      if abs(new.downpayment - new.total) > 0.01 and abs(new.downpayment - public_due) > 0.01
         and abs(new.downpayment - (new.total / 2)) > 0.01 and abs(new.downpayment - round(new.total / 2)) > 0.01 then
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
      if new.total is null or new.total < 0 then raise exception 'Host booking total is invalid.'; end if;
      service_fee := least(greatest(coalesce(old.booking_fee_amount_snapshot, 0), 0), new.total);
      host_due := round(service_fee + ((new.total - service_fee) * 0.25), 2);
      if abs(new.downpayment - new.total) > 0.01 and abs(new.downpayment - host_due) > 0.01 then
        raise exception 'Host payment amount is invalid. Expected 25%% of the court fee plus the full service fee.';
      end if;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_public_booking_hold_update() from public;

commit;

-- NOT VALID makes the high-lock schema step independent of the historical
-- booking scan. Validation uses SHARE UPDATE EXCLUSIVE and remains bounded.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '90s';

alter table public.bookings
  validate constraint bookings_demand_campaign_discount_nonnegative;
alter table public.bookings
  validate constraint bookings_demand_campaign_percent_range;
alter table public.bookings
  validate constraint bookings_no_voucher_campaign_stacking;

commit;
