-- Small, PII-free Smart Offer discovery surface for promotional UI.
--
-- This is deliberately additive. Booking holds continue to use the existing
-- date-specific preview and apply_matching_demand_campaign() remains the only
-- authority that reserves campaign capacity or changes a booking total.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

create or replace function public.get_public_demand_campaign_featured_offers()
returns table (
  court_id text,
  court_name text,
  offer_date date,
  slot_hour integer,
  discount_percent numeric(5,2),
  regular_rate numeric(12,2),
  offer_rate numeric(12,2),
  ends_at timestamptz
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
        'Asia/Manila',
        pg_catalog.statement_timestamp()
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
  ), maintenance_rules as materialized (
    select expanded.rule
    from schedule_settings schedule
    cross join lateral pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(
          schedule.maintenance_config -> 'rules'
        ) = 'array' then schedule.maintenance_config -> 'rules'
        when pg_catalog.jsonb_typeof(schedule.maintenance_config) = 'object'
          and schedule.maintenance_config <> '{}'::jsonb
          then pg_catalog.jsonb_build_array(schedule.maintenance_config)
        else '[]'::jsonb
      end
    ) as expanded(rule)
  ), active_offer as materialized (
    select
      campaign.id,
      campaign.court_id,
      court.name as court_name,
      campaign.weekday,
      campaign.start_hour,
      campaign.end_hour,
      campaign.discount_percent,
      campaign.ends_at
    from public.demand_campaigns campaign
    join public.courts court
      on court.id = campaign.court_id
     and court.blocked = false
    cross join request_clock clock
    where campaign.status = 'active'
      and campaign.starts_at <= clock.requested_at
      and campaign.ends_at > clock.requested_at
      and (
        select pg_catalog.count(*)
        from public.demand_campaign_redemptions redemption
        where redemption.campaign_id = campaign.id
          and (
            redemption.status = 'redeemed'
            or (
              redemption.status = 'reserved'
              and redemption.reserved_until > clock.requested_at
            )
          )
      ) < campaign.max_redemptions
    order by campaign.starts_at desc, campaign.id
    limit 1
  ), candidate_slots as materialized (
    select
      campaign.court_id,
      campaign.court_name,
      offered_date.offer_date,
      offered_hour.slot_hour,
      campaign.discount_percent,
      campaign.ends_at
    from active_offer campaign
    cross join request_clock clock
    cross join schedule_settings schedule
    cross join lateral pg_catalog.generate_series(1, 28)
      as offered_day(day_offset)
    cross join lateral (
      select (clock.local_today + offered_day.day_offset)::date as offer_date
    ) as offered_date
    cross join lateral pg_catalog.generate_series(
      campaign.start_hour::integer,
      campaign.end_hour::integer - 1
    ) as offered_hour(slot_hour)
    where extract(
      isodow from offered_date.offer_date
    )::integer = campaign.weekday
      and schedule.open_hour ~ '^\d{1,2}$'
      and schedule.close_hour ~ '^\d{1,2}$'
      and offered_hour.slot_hour >= schedule.open_hour::integer
      and offered_hour.slot_hour < schedule.close_hour::integer
      and not exists (
        select 1
        from public.blocked_dates blocked
        where blocked.date = offered_date.offer_date
      )
      and not (
        pg_catalog.lower(
          coalesce(schedule.open_play_config ->> 'enabled', 'false')
        ) = 'true'
        and coalesce(schedule.open_play_config ->> 'start', '') ~ '^\d{1,2}$'
        and coalesce(schedule.open_play_config ->> 'end', '') ~ '^\d{1,2}$'
        and (schedule.open_play_config ->> 'start')::integer <>
          (schedule.open_play_config ->> 'end')::integer
        and case
          when (schedule.open_play_config ->> 'start')::integer <
            (schedule.open_play_config ->> 'end')::integer
            then offered_hour.slot_hour >=
              (schedule.open_play_config ->> 'start')::integer
              and offered_hour.slot_hour <
                (schedule.open_play_config ->> 'end')::integer
          else offered_hour.slot_hour >=
            (schedule.open_play_config ->> 'start')::integer
            or offered_hour.slot_hour <
              (schedule.open_play_config ->> 'end')::integer
        end
        and case
          when pg_catalog.jsonb_typeof(
            schedule.open_play_config -> 'courtIds'
          ) = 'array' then
            pg_catalog.jsonb_array_length(
              schedule.open_play_config -> 'courtIds'
            ) = 0
            or exists (
              select 1
              from pg_catalog.jsonb_array_elements_text(
                schedule.open_play_config -> 'courtIds'
              ) configured_court(court_id)
              where configured_court.court_id = campaign.court_id
            )
          else true
        end
        and (
          case
            when pg_catalog.jsonb_typeof(
              schedule.open_play_config -> 'days'
            ) = 'array' then exists (
              select 1
              from pg_catalog.jsonb_array_elements_text(
                schedule.open_play_config -> 'days'
              ) configured_day(day_value)
              where configured_day.day_value = extract(
                dow from offered_date.offer_date
              )::integer::text
            )
            else false
          end
          or case
            when pg_catalog.jsonb_typeof(
              schedule.open_play_config -> 'specificDates'
            ) = 'array' then exists (
              select 1
              from pg_catalog.jsonb_array_elements_text(
                schedule.open_play_config -> 'specificDates'
              ) configured_date(date_value)
              where configured_date.date_value = offered_date.offer_date::text
            )
            else false
          end
        )
      )
      and not exists (
        select 1
        from maintenance_rules maintenance
        where pg_catalog.lower(
            coalesce(maintenance.rule ->> 'enabled', 'false')
          ) = 'true'
          and coalesce(maintenance.rule ->> 'start', '') ~ '^\d{1,2}$'
          and coalesce(maintenance.rule ->> 'end', '') ~ '^\d{1,2}$'
          and (maintenance.rule ->> 'start')::integer <>
            (maintenance.rule ->> 'end')::integer
          and case
            when (maintenance.rule ->> 'start')::integer <
              (maintenance.rule ->> 'end')::integer
              then offered_hour.slot_hour >=
                (maintenance.rule ->> 'start')::integer
                and offered_hour.slot_hour <
                  (maintenance.rule ->> 'end')::integer
            else offered_hour.slot_hour >=
              (maintenance.rule ->> 'start')::integer
              or offered_hour.slot_hour <
                (maintenance.rule ->> 'end')::integer
          end
          and case
            when pg_catalog.jsonb_typeof(
              maintenance.rule -> 'courtIds'
            ) = 'array' then
              pg_catalog.jsonb_array_length(
                maintenance.rule -> 'courtIds'
              ) = 0
              or exists (
                select 1
                from pg_catalog.jsonb_array_elements_text(
                  maintenance.rule -> 'courtIds'
                ) configured_court(court_id)
                where configured_court.court_id = campaign.court_id
              )
            else true
          end
          and (
            (
              coalesce(maintenance.rule ->> 'mode', 'specific') = 'specific'
              and case
                when pg_catalog.jsonb_typeof(
                  maintenance.rule -> 'dates'
                ) = 'array' then exists (
                  select 1
                  from pg_catalog.jsonb_array_elements_text(
                    maintenance.rule -> 'dates'
                  ) configured_date(date_value)
                  where configured_date.date_value = offered_date.offer_date::text
                )
                else false
              end
            )
            or (
              maintenance.rule ->> 'mode' = 'monthly'
              and coalesce(
                maintenance.rule #>> '{recurring,day}', ''
              ) ~ '^\d{1,2}$'
              and (maintenance.rule #>> '{recurring,day}')::integer =
                extract(day from offered_date.offer_date)::integer
            )
            or (
              maintenance.rule ->> 'mode' = 'weekly'
              and case
                when pg_catalog.jsonb_typeof(
                  maintenance.rule #> '{recurring,days}'
                ) = 'array' then exists (
                  select 1
                  from pg_catalog.jsonb_array_elements_text(
                    maintenance.rule #> '{recurring,days}'
                  ) configured_day(day_value)
                  where configured_day.day_value = extract(
                    dow from offered_date.offer_date
                  )::integer::text
                )
                else false
              end
            )
          )
      )
      and not exists (
        select 1
        from public.bookings booking
        where booking.court_id = campaign.court_id
          and booking.date = offered_date.offer_date
          and booking.status not in ('cancelled', 'forfeited')
          and (
            booking.status <> 'verifying'
            or booking.created_at is null
            or booking.created_at > clock.requested_at - interval '15 minutes'
          )
          and exists (
            select 1
            from pg_catalog.unnest(
              coalesce(booking.slots, '{}'::text[])
            ) as occupied(slot_value)
            where occupied.slot_value ~ '^\d{1,2}(\.\d+)?$'
              and pg_catalog.floor(
                occupied.slot_value::numeric
              )::integer = offered_hour.slot_hour
          )
      )
  ), priced_slots as materialized (
    select
      offered.court_id,
      offered.court_name,
      offered.offer_date,
      offered.slot_hour,
      offered.discount_percent,
      pg_catalog.round(
        greatest(
          public.calculate_booking_court_total(
            offered.court_id,
            array[offered.slot_hour::text]
          ),
          0
        ),
        2
      )::numeric(12,2) as regular_rate,
      offered.ends_at
    from candidate_slots offered
  )
  select
    priced.court_id,
    priced.court_name,
    priced.offer_date,
    priced.slot_hour,
    priced.discount_percent::numeric(5,2),
    priced.regular_rate,
    pg_catalog.round(
      priced.regular_rate * (100 - priced.discount_percent) / 100,
      2
    )::numeric(12,2) as offer_rate,
    priced.ends_at
  from priced_slots priced
  where priced.regular_rate > 0
  order by priced.offer_date, priced.slot_hour, priced.court_id
  limit 6
$$;

revoke all on function public.get_public_demand_campaign_featured_offers()
  from public, anon, authenticated;
grant execute on function public.get_public_demand_campaign_featured_offers()
  to anon, authenticated;

comment on function public.get_public_demand_campaign_featured_offers() is
  'Returns at most six next open Smart Offer hours in the coming 28 Manila days. Filters blocked courts, blocked dates, Open Play, maintenance, active booking conflicts, expired campaign capacity, and exposes no customer, payment, redemption, or campaign identifiers.';

notify pgrst, 'reload schema';

commit;
