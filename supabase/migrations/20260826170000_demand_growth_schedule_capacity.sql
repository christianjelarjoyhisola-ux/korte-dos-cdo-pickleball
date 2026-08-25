-- Keep operational blocks out of Demand Intelligence capacity. Every enabled
-- Maintenance rule is unavailable regardless of its display label. Open Play,
-- closed dates, and occupied future hours remain separate from player demand.
--
-- Current settings are not effective-dated. Retained specific-date rules are
-- exact; current recurring rules are applied to matching historical dates.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create or replace function public.demand_schedule_hour_is_unavailable(
  p_date date,
  p_hour integer,
  p_court_id text,
  p_open_play_config jsonb,
  p_maintenance_config jsonb
)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $helper$
  with maintenance_rules as (
    select item.rule
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(coalesce(p_maintenance_config, '{}'::jsonb) -> 'rules') = 'array'
          then coalesce(p_maintenance_config, '{}'::jsonb) -> 'rules'
        when pg_catalog.jsonb_typeof(coalesce(p_maintenance_config, '{}'::jsonb)) = 'object'
         and coalesce(p_maintenance_config, '{}'::jsonb) <> '{}'::jsonb
          then pg_catalog.jsonb_build_array(p_maintenance_config)
        else '[]'::jsonb
      end
    ) item(rule)
  )
  select coalesce(
    (
      p_date is not null
      and p_hour between 0 and 23
      and (
        (
          pg_catalog.lower(coalesce(p_open_play_config ->> 'enabled', 'false')) = 'true'
          and coalesce(p_open_play_config ->> 'start', '') ~ '^\d{1,2}$'
          and coalesce(p_open_play_config ->> 'end', '') ~ '^\d{1,2}$'
          and (p_open_play_config ->> 'start')::integer between 0 and 23
          and (p_open_play_config ->> 'end')::integer between 0 and 24
          and (p_open_play_config ->> 'start')::integer <> (p_open_play_config ->> 'end')::integer
          and case
            when (p_open_play_config ->> 'start')::integer < (p_open_play_config ->> 'end')::integer
              then p_hour >= (p_open_play_config ->> 'start')::integer
               and p_hour < (p_open_play_config ->> 'end')::integer
            else p_hour >= (p_open_play_config ->> 'start')::integer
              or p_hour < (p_open_play_config ->> 'end')::integer
          end
          and case
            when pg_catalog.jsonb_typeof(p_open_play_config -> 'courtIds') = 'array'
              then pg_catalog.jsonb_array_length(p_open_play_config -> 'courtIds') = 0
                or exists (
                  select 1
                  from pg_catalog.jsonb_array_elements_text(p_open_play_config -> 'courtIds') configured(court_id)
                  where configured.court_id = p_court_id
                )
            else true
          end
          and (
            case
              when pg_catalog.jsonb_typeof(p_open_play_config -> 'days') = 'array'
                then exists (
                  select 1
                  from pg_catalog.jsonb_array_elements_text(p_open_play_config -> 'days') configured(day_value)
                  where configured.day_value = extract(dow from (
                    case
                      when (p_open_play_config ->> 'start')::integer > (p_open_play_config ->> 'end')::integer
                       and p_hour < (p_open_play_config ->> 'end')::integer
                        then p_date - 1
                      else p_date
                    end
                  ))::integer::text
                )
              else false
            end
            or case
              when pg_catalog.jsonb_typeof(p_open_play_config -> 'specificDates') = 'array'
                then exists (
                  select 1
                  from pg_catalog.jsonb_array_elements_text(p_open_play_config -> 'specificDates') configured(date_value)
                  where configured.date_value = (
                    case
                      when (p_open_play_config ->> 'start')::integer > (p_open_play_config ->> 'end')::integer
                       and p_hour < (p_open_play_config ->> 'end')::integer
                        then p_date - 1
                      else p_date
                    end
                  )::text
                )
              else false
            end
          )
        )
        or exists (
          select 1
          from maintenance_rules maintenance
          where pg_catalog.lower(coalesce(maintenance.rule ->> 'enabled', 'false')) = 'true'
            and coalesce(maintenance.rule ->> 'start', '') ~ '^\d{1,2}$'
            and coalesce(maintenance.rule ->> 'end', '') ~ '^\d{1,2}$'
            and (maintenance.rule ->> 'start')::integer between 0 and 23
            and (maintenance.rule ->> 'end')::integer between 0 and 24
            and (maintenance.rule ->> 'start')::integer <> (maintenance.rule ->> 'end')::integer
            and case
              when (maintenance.rule ->> 'start')::integer < (maintenance.rule ->> 'end')::integer
                then p_hour >= (maintenance.rule ->> 'start')::integer
                 and p_hour < (maintenance.rule ->> 'end')::integer
              else p_hour >= (maintenance.rule ->> 'start')::integer
                or p_hour < (maintenance.rule ->> 'end')::integer
            end
            and case
              when pg_catalog.jsonb_typeof(maintenance.rule -> 'courtIds') = 'array'
                then pg_catalog.jsonb_array_length(maintenance.rule -> 'courtIds') = 0
                  or exists (
                    select 1
                    from pg_catalog.jsonb_array_elements_text(maintenance.rule -> 'courtIds') configured(court_id)
                    where configured.court_id = p_court_id
                  )
              else true
            end
            and (
              (
                pg_catalog.lower(coalesce(maintenance.rule ->> 'mode', 'specific')) = 'specific'
                and case
                  when pg_catalog.jsonb_typeof(maintenance.rule -> 'dates') = 'array'
                    then exists (
                      select 1
                      from pg_catalog.jsonb_array_elements_text(maintenance.rule -> 'dates') configured(date_value)
                      where configured.date_value = (
                        case
                          when (maintenance.rule ->> 'start')::integer > (maintenance.rule ->> 'end')::integer
                           and p_hour < (maintenance.rule ->> 'end')::integer
                            then p_date - 1
                          else p_date
                        end
                      )::text
                    )
                  else false
                end
              )
              or (
                pg_catalog.lower(coalesce(maintenance.rule ->> 'mode', 'specific')) = 'monthly'
                and coalesce(maintenance.rule #>> '{recurring,day}', '') ~ '^\d{1,2}$'
                and (maintenance.rule #>> '{recurring,day}')::integer = extract(day from (
                  case
                    when (maintenance.rule ->> 'start')::integer > (maintenance.rule ->> 'end')::integer
                     and p_hour < (maintenance.rule ->> 'end')::integer
                      then p_date - 1
                    else p_date
                  end
                ))::integer
              )
              or (
                pg_catalog.lower(coalesce(maintenance.rule ->> 'mode', 'specific')) = 'weekly'
                and case
                  when pg_catalog.jsonb_typeof(maintenance.rule #> '{recurring,days}') = 'array'
                    then exists (
                      select 1
                      from pg_catalog.jsonb_array_elements_text(maintenance.rule #> '{recurring,days}') configured(day_value)
                      where configured.day_value = extract(dow from (
                        case
                          when (maintenance.rule ->> 'start')::integer > (maintenance.rule ->> 'end')::integer
                           and p_hour < (maintenance.rule ->> 'end')::integer
                            then p_date - 1
                          else p_date
                        end
                      ))::integer::text
                    )
                  else false
                end
              )
            )
        )
      )
    ),
    false
  );
$helper$;

revoke all on function public.demand_schedule_hour_is_unavailable(
  date, integer, text, jsonb, jsonb
) from public, anon, authenticated;

comment on function public.demand_schedule_hour_is_unavailable(
  date, integer, text, jsonb, jsonb
) is
  'Internal Demand Intelligence predicate. Returns true for any enabled Open Play or Maintenance rule hour, regardless of Maintenance block label. Empty courtIds applies to every court.';

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
  open_play_config jsonb := '{}'::jsonb;
  maintenance_config jsonb := '{}'::jsonb;
  result jsonb;
begin
  account_role := public.current_account_role();
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can view Demand Intelligence.'
      using errcode = '42501';
  end if;

  range_end := least(coalesce(p_to, local_today - 1), local_today - 1);

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

  select coalesce((
    select s.value::jsonb
    from public.settings s
    where s.key = 'open_play_config'
    limit 1
  ), '{}'::jsonb)
  into open_play_config;

  select coalesce((
    select s.value::jsonb
    from public.settings s
    where s.key = 'maintenance_config'
    limit 1
  ), '{}'::jsonb)
  into maintenance_config;

  select min(b.date)
    into earliest_success_date
    from public.bookings b
    join public.courts c on c.id = b.court_id
    left join public.blocked_dates blocked on blocked.date = b.date
   where b.analytics_eligible = true
     and lower(coalesce(b.status, '')) in ('confirmed', 'completed')
     and b.date <= range_end
     and timezone('Asia/Manila', c.created_at)::date <= b.date
     and blocked.date is null
     and exists (
       select 1
       from (
         select floor(slot_value::numeric)::integer as slot_hour
         from unnest(coalesce(b.slots, '{}'::text[])) slot_value
         where slot_value ~ '^\d{1,2}(\.\d+)?$'

         union all

         select
           case
             when coalesce(b.start_time, '') ~* '(AM|PM)'
               then mod(substring(b.start_time from '^\s*(\d{1,2})')::integer, 12)
                  + case when b.start_time ~* 'PM' then 12 else 0 end
             when coalesce(b.start_time, '') ~ '^\s*\d{1,2}'
               then least(substring(b.start_time from '^\s*(\d{1,2})')::integer, 23)
             else open_hour
           end + unit.unit_offset as slot_hour
         from generate_series(
           0,
           greatest(ceil(
             greatest(coalesce(
               nullif(b.duration, 0),
               cardinality(coalesce(b.slots, '{}'::text[]))::numeric,
               0
             ), 0)
           )::integer - 1, 0)
         ) unit(unit_offset)
         where cardinality(coalesce(b.slots, '{}'::text[])) = 0
           and greatest(coalesce(nullif(b.duration, 0), 0), 0) > 0
       ) booking_unit
       where booking_unit.slot_hour >= open_hour
         and booking_unit.slot_hour < close_hour
         and not public.demand_schedule_hour_is_unavailable(
           b.date,
           booking_unit.slot_hour,
           b.court_id,
           open_play_config,
           maintenance_config
         )
     );

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
  historical_capacity_units as materialized (
    select
      c.id as court_id,
      c.name as court_name,
      c.rate,
      d.day as capacity_date,
      extract(isodow from d.day)::integer as weekday,
      b.start_hour,
      b.end_hour,
      slot.slot_hour
    from eligible_courts c
    cross join historical_days d
    cross join bands b
    cross join lateral generate_series(
      b.start_hour,
      b.end_hour - 1
    ) slot(slot_hour)
    left join public.blocked_dates bd on bd.date = d.day
    where timezone('Asia/Manila', c.created_at)::date <= d.day
      and bd.date is null
      and not public.demand_schedule_hour_is_unavailable(
        d.day,
        slot.slot_hour,
        c.id,
        open_play_config,
        maintenance_config
      )
  ),
  signal_dimensions as materialized (
    select
      c.id as court_id,
      c.name as court_name,
      c.rate,
      weekday.weekday,
      b.start_hour,
      b.end_hour
    from eligible_courts c
    cross join generate_series(1, 7) weekday(weekday)
    cross join bands b
  ),
  historical_capacity_by_cell as materialized (
    select
      unit.court_id,
      unit.weekday,
      unit.start_hour,
      unit.end_hour,
      count(*)::numeric as available_hours,
      count(distinct unit.capacity_date)::integer as comparable_days
    from historical_capacity_units unit
    group by
      unit.court_id,
      unit.weekday,
      unit.start_hour,
      unit.end_hour
  ),
  capacity as materialized (
    select
      dimension.court_id,
      dimension.court_name,
      dimension.rate,
      dimension.weekday,
      dimension.start_hour,
      dimension.end_hour,
      coalesce(eligible.available_hours, 0)::numeric as available_hours,
      coalesce(eligible.comparable_days, 0)::integer as comparable_days
    from signal_dimensions dimension
    left join historical_capacity_by_cell eligible
      on eligible.court_id = dimension.court_id
     and eligible.weekday = dimension.weekday
     and eligible.start_hour = dimension.start_hour
     and eligible.end_hour = dimension.end_hour
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
      and exists (
        select 1
        from historical_capacity_units eligible
        where eligible.court_id = r.court_id
          and eligible.capacity_date = r.date
          and eligible.slot_hour = floor(slot_value::numeric)::integer
      )

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
      and exists (
        select 1
        from historical_capacity_units eligible
        where eligible.court_id = r.court_id
          and eligible.capacity_date = r.date
          and eligible.slot_hour = r.parsed_start_hour + unit.unit_offset
      )
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
  future_capacity_units as materialized (
    select
      c.id as court_id,
      d.day as capacity_date,
      extract(isodow from d.day)::integer as weekday,
      b.start_hour,
      b.end_hour,
      slot.slot_hour
    from eligible_courts c
    cross join future_days d
    cross join bands b
    cross join lateral generate_series(
      b.start_hour,
      b.end_hour - 1
    ) slot(slot_hour)
    left join public.blocked_dates bd on bd.date = d.day
    where not coalesce(c.blocked, false)
      and bd.date is null
      and not public.demand_schedule_hour_is_unavailable(
        d.day,
        slot.slot_hour,
        c.id,
        open_play_config,
        maintenance_config
      )
  ),
  future_capacity_base as materialized (
    select
      unit.court_id,
      unit.weekday,
      unit.start_hour,
      unit.end_hour,
      count(*)::numeric as open_future_hours
    from future_capacity_units unit
    group by unit.court_id, unit.weekday, unit.start_hour, unit.end_hour
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
      and exists (
        select 1
        from future_capacity_units eligible
        where eligible.court_id = r.court_id
          and eligible.capacity_date = r.date
          and eligible.slot_hour = floor(slot_value::numeric)::integer
      )

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
      and exists (
        select 1
        from future_capacity_units eligible
        where eligible.court_id = r.court_id
          and eligible.capacity_date = r.date
          and eligible.slot_hour = r.parsed_start_hour + unit.unit_offset
      )
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
  venue_comparable_days as materialized (
    select
      unit.weekday,
      unit.start_hour,
      unit.end_hour,
      count(distinct unit.capacity_date)::integer as comparable_days
    from historical_capacity_units unit
    group by unit.weekday, unit.start_hour, unit.end_hour
  ),
  venue_heatmap as materialized (
    select
      signal.weekday,
      min(signal.weekday_label) as weekday_label,
      signal.start_hour,
      signal.end_hour,
      sum(signal.booked_hours)::numeric as booked_hours,
      sum(signal.available_hours)::numeric as available_hours,
      coalesce(comparable.comparable_days, 0)::integer as comparable_days,
      case when sum(signal.available_hours) <= 0 then 0
        else round(least(100, sum(signal.booked_hours) * 100 / sum(signal.available_hours)), 1)
      end as utilization_pct
    from court_signals signal
    left join venue_comparable_days comparable
      on comparable.weekday = signal.weekday
     and comparable.start_hour = signal.start_hour
     and comparable.end_hour = signal.end_hour
    group by
      signal.weekday,
      signal.start_hour,
      signal.end_hour,
      comparable.comparable_days
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
      'DG-' || upper(substr(encode(extensions.digest(
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
      coalesce((select count(distinct reservation_key) from booked_units), 0)::integer as successful_reservations,
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
      'note', 'Demand learning includes only sellable court-hours and analytics-eligible confirmed/completed play through yesterday. Blocked dates, all enabled Maintenance rule types, and Open Play hours are excluded using the currently saved venue schedules. Pending, verifying, cancelled, rejected, failed, expired, and forfeited records do not influence demand.',
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

do $acl$
declare
  intelligence_owner name;
begin
  select role.rolname
    into intelligence_owner
  from pg_catalog.pg_proc function_row
  join pg_catalog.pg_roles role on role.oid = function_row.proowner
  where function_row.oid = 'public.get_demand_growth_intelligence(date,date,text)'::regprocedure;

  if intelligence_owner is null then
    raise exception 'Demand Intelligence function owner could not be resolved';
  end if;

  execute pg_catalog.format(
    'grant execute on function public.demand_schedule_hour_is_unavailable(date, integer, text, jsonb, jsonb) to %I',
    intelligence_owner
  );
end
$acl$;

revoke all on function public.get_demand_growth_intelligence(date, date, text)
  from public, anon;
grant execute on function public.get_demand_growth_intelligence(date, date, text)
  to authenticated;

comment on function public.get_demand_growth_intelligence(date, date, text) is
  'Owner-only demand intelligence over sellable court-hours. Excludes blocked dates, every enabled Maintenance rule type, and Open Play from historical booked/available hours and future opportunity capacity.';

notify pgrst, 'reload schema';

commit;
