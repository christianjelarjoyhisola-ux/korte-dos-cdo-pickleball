-- Count scheduled Open Play court-hours as occupied demand while keeping every
-- other Maintenance block type outside both demand and sellable capacity.
-- Future Open Play hours remain unavailable to private-booking promotions.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.demand_schedule_hour_is_open_play(
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
  ),
  open_play_rules as (
    select coalesce(
      pg_catalog.jsonb_agg(rule) filter (
        where pg_catalog.regexp_replace(
          pg_catalog.lower(coalesce(rule ->> 'label', '')),
          '[^a-z0-9]+',
          '',
          'g'
        ) in ('openplay', 'openplaysession')
      ),
      '[]'::jsonb
    ) as rules
    from maintenance_rules
  )
  select public.demand_schedule_hour_is_unavailable(
    p_date,
    p_hour,
    p_court_id,
    coalesce(p_open_play_config, '{}'::jsonb),
    pg_catalog.jsonb_build_object('rules', open_play_rules.rules)
  )
  from open_play_rules
$helper$;

revoke all on function public.demand_schedule_hour_is_open_play(
  date, integer, text, jsonb, jsonb
) from public, anon, authenticated;

do $patch$
declare
  target regprocedure := to_regprocedure(
    'public.get_profit_learning_v2_intelligence(date,date,text)'
  );
  current_definition text;
  patched_definition text;
  old_capacity text := $old$
      and not public.demand_schedule_hour_is_unavailable(
        day_row.play_date,
        hour_cell.slot_hour,
        court.id,
        open_play_config,
        maintenance_config
      )
  ),
  capacity_by_cell$old$;
  new_capacity text := $new$
      and (
        not public.demand_schedule_hour_is_unavailable(
          day_row.play_date,
          hour_cell.slot_hour,
          court.id,
          open_play_config,
          maintenance_config
        )
        or public.demand_schedule_hour_is_open_play(
          day_row.play_date,
          hour_cell.slot_hour,
          court.id,
          open_play_config,
          maintenance_config
        )
      )
  ),
  capacity_by_cell$new$;
  old_booked text := $old$
  booked_by_cell as materialized (
    select court_id, weekday, slot_hour, count(*)::numeric as booked_hours
    from successful_booking_slots
    group by court_id, weekday, slot_hour
  ),$old$;
  new_booked text := $new$
  scheduled_open_play_slots as materialized (
    select
      unit.court_id,
      unit.play_date,
      unit.weekday,
      unit.slot_hour
    from historical_capacity_units unit
    where public.demand_schedule_hour_is_open_play(
      unit.play_date,
      unit.slot_hour,
      unit.court_id,
      open_play_config,
      maintenance_config
    )
  ),
  booked_by_cell as materialized (
    select occupied.court_id,
           occupied.weekday,
           occupied.slot_hour,
           count(*)::numeric as booked_hours
    from (
      select court_id, play_date, weekday, slot_hour
      from successful_booking_slots
      union
      select court_id, play_date, weekday, slot_hour
      from scheduled_open_play_slots
    ) occupied
    group by occupied.court_id, occupied.weekday, occupied.slot_hour
  ),$new$;
begin
  if target is null then
    raise exception 'Profit Learning V2 intelligence function is missing';
  end if;

  current_definition := pg_catalog.pg_get_functiondef(target);
  if pg_catalog.position('scheduled_open_play_slots as materialized' in current_definition) > 0 then
    return;
  end if;
  if pg_catalog.position(old_capacity in current_definition) = 0
     or pg_catalog.position(old_booked in current_definition) = 0 then
    raise exception 'Profit Learning V2 definition does not match the expected checksum-locked source';
  end if;

  patched_definition := pg_catalog.replace(current_definition, old_capacity, new_capacity);
  patched_definition := pg_catalog.replace(patched_definition, old_booked, new_booked);
  if patched_definition = current_definition
     or pg_catalog.position('scheduled_open_play_slots as materialized' in patched_definition) = 0 then
    raise exception 'Open Play demand patch was not applied';
  end if;
  execute patched_definition;
end
$patch$;

revoke all on function public.get_profit_learning_v2_intelligence(date, date, text)
  from public, anon;
grant execute on function public.get_profit_learning_v2_intelligence(date, date, text)
  to authenticated;

comment on function public.demand_schedule_hour_is_open_play(
  date, integer, text, jsonb, jsonb
) is
  'Returns true only for scheduled Open Play hours, including Maintenance rules whose Block Type is Open Play Session.';

comment on function public.get_profit_learning_v2_intelligence(date, date, text) is
  'Owner-only one-hour demand snapshot. Scheduled Open Play is occupied demand; all other blocked capacity is excluded.';

notify pgrst, 'reload schema';

commit;
