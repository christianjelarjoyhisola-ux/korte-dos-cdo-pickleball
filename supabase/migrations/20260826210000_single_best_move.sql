-- One Best Move is one exact court-hour in the next 28 days.
-- Retires the former eight-pair scheduler without touching bookings, prices,
-- payments, receipts, vouchers, or public availability.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '90s';

alter table public.profit_learning_experiments
  drop constraint if exists profit_learning_experiments_target_pairs_check;
alter table public.profit_learning_experiments
  alter column target_pairs set default 1;
alter table public.profit_learning_experiments
  add constraint profit_learning_experiments_target_pairs_check
  check (target_pairs in (1, 8));

-- Historical paired runs remain readable, but an old long-running schedule must
-- not block the new near-term action model.
with retired as (
  update public.profit_learning_experiments
     set status = 'stopped',
         ended_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where status = 'active'
     and target_pairs <> 1
  returning id, created_by
)
insert into public.profit_learning_occurrence_events (
  experiment_id, occurrence_id, event_type, metadata, actor_id
)
select retired.id, null, 'experiment_stopped',
       '{"reason":"single_best_move_upgrade"}'::jsonb,
       retired.created_by
from retired;

-- Stopped historical assignments must not reserve future dates. Creation is
-- serialized and the function below checks live bookings and active work.
alter table public.profit_learning_occurrences
  drop constraint if exists profit_learning_occurrences_court_id_play_date_slot_hour_key;

do $migration$
declare
  target regprocedure := to_regprocedure(
    'public.get_profit_learning_v2_intelligence(date,date,text)'
  );
  definition text;
  patched_definition text;
begin
  if target is null then
    raise exception 'Profit Learning V2 intelligence function is missing.';
  end if;
  definition := pg_catalog.pg_get_functiondef(target);
  if pg_catalog.strpos(definition, $$'target_occurrences', 1$$) > 0 then
    return;
  end if;
  if pg_catalog.strpos(definition, $$'target_pairs', 8$$) = 0 then
    raise exception 'Profit Learning V2 definition does not match the expected source.';
  end if;

  patched_definition := pg_catalog.replace(
    definition,
    $$'target_pairs', 8$$,
    $$'target_occurrences', 1,
        'horizon_days', 28,
        'target_pairs', 1$$
  );
  if patched_definition = definition
     or pg_catalog.strpos(patched_definition, $$'target_occurrences', 1$$) = 0 then
    raise exception 'Single Best Move metadata patch was not applied.';
  end if;
  execute patched_definition;
end;
$migration$;

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
  local_today date := pg_catalog.timezone('Asia/Manila', pg_catalog.clock_timestamp())::date;
  open_play_config jsonb := '{}'::jsonb;
  maintenance_config jsonb := '{}'::jsonb;
  snapshot jsonb;
  recommendation jsonb;
  inserted public.profit_learning_experiments%rowtype;
  candidate_date date;
  candidate_rate numeric(12,2);
  occurrence_id uuid;
begin
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can start a Best Move.' using errcode = '42501';
  end if;
  if clean_id !~ '^PL2-[A-F0-9]{24}$' then
    raise exception 'Best Move recommendation ID is invalid.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('korte-dos-profit-learning-v2-create', 0)
  );

  if exists (select 1 from public.profit_learning_experiments where status = 'active') then
    raise exception 'A Best Move is already active.' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.demand_campaigns
    where status = 'active' and ends_at > pg_catalog.now()
  ) then
    raise exception 'End the active Smart Rate campaign before starting this Best Move.' using errcode = 'P0001';
  end if;

  snapshot := public.get_profit_learning_v2_intelligence(null, null, p_court_id);
  recommendation := snapshot -> 'recommendation';
  if recommendation is null or recommendation = 'null'::jsonb then
    raise exception 'There is no evidence-backed one-hour Best Move yet.' using errcode = 'P0001';
  end if;
  if pg_catalog.upper(coalesce(recommendation ->> 'id', '')) <> clean_id then
    raise exception 'This Best Move changed. Refresh Insights.' using errcode = '40001';
  end if;
  if recommendation ->> 'action' <> 'facebook_regular_price'
     or coalesce((recommendation ->> 'discount_percent')::numeric, -1) <> 0
     or coalesce((recommendation ->> 'target_occurrences')::integer, 0) <> 1
     or coalesce((recommendation ->> 'horizon_days')::integer, 0) <> 28
     or coalesce(recommendation ->> 'confidence', '') not in ('medium', 'high')
     or coalesce(recommendation ->> 'state', '') not in ('persistent_vacancy', 'underused') then
    raise exception 'This recommendation is not eligible for a Best Move.' using errcode = 'P0001';
  end if;

  select coalesce((select value::jsonb from public.settings where key = 'open_play_config' limit 1), '{}'::jsonb)
    into open_play_config;
  select coalesce((select value::jsonb from public.settings where key = 'maintenance_config' limit 1), '{}'::jsonb)
    into maintenance_config;

  select generated.day_value::date,
         pg_catalog.round(greatest(public.calculate_booking_court_total(
           recommendation ->> 'court_id',
           array[(recommendation ->> 'start_hour')::text]
         ), 0), 2)
    into candidate_date, candidate_rate
  from pg_catalog.generate_series(
    (local_today + 1)::timestamp,
    (local_today + 28)::timestamp,
    interval '1 day'
  ) generated(day_value)
  join public.courts court
    on court.id = recommendation ->> 'court_id'
   and not coalesce(court.blocked, false)
  where extract(isodow from generated.day_value)::integer = (recommendation ->> 'weekday')::integer
    and not exists (select 1 from public.blocked_dates where date = generated.day_value::date)
    and not public.demand_schedule_hour_is_unavailable(
      generated.day_value::date,
      (recommendation ->> 'start_hour')::integer,
      recommendation ->> 'court_id',
      open_play_config,
      maintenance_config
    )
    and not exists (
      select 1
      from public.profit_learning_occurrences occurrence
      join public.profit_learning_experiments experiment on experiment.id = occurrence.experiment_id
      where experiment.status = 'active'
        and occurrence.court_id = recommendation ->> 'court_id'
        and occurrence.play_date = generated.day_value::date
        and occurrence.slot_hour = (recommendation ->> 'start_hour')::integer
    )
    and not exists (
      select 1 from public.bookings booking
      where booking.court_id = recommendation ->> 'court_id'
        and booking.date = generated.day_value::date
        and pg_catalog.lower(coalesce(booking.status, '')) not in ('cancelled', 'forfeited')
        and (pg_catalog.lower(coalesce(booking.status, '')) <> 'verifying'
          or booking.created_at > pg_catalog.clock_timestamp() - interval '15 minutes')
        and exists (
          select 1 from pg_catalog.unnest(coalesce(booking.slots, '{}'::text[])) occupied(slot_value)
          where slot_value ~ '^\d{1,2}(\.\d+)?$'
            and pg_catalog.floor(slot_value::numeric)::integer = (recommendation ->> 'start_hour')::integer
        )
    )
  order by generated.day_value
  limit 1;

  if candidate_date is null or coalesce(candidate_rate, 0) <= 0 then
    raise exception 'No eligible one-hour court time is available in the next 28 days. Choose another Best Move.' using errcode = 'P0001';
  end if;

  insert into public.profit_learning_experiments (
    source_recommendation_id, court_id, court_name_snapshot, weekday, slot_hour,
    treatment_action, discount_percent, target_pairs, baseline_period_from,
    baseline_period_to, baseline_utilization_pct, baseline_comparable_days,
    baseline_available_hours, baseline_confidence, baseline_state,
    baseline_open_future_hours, baseline_opportunity_value, scheduled_through, created_by
  ) values (
    clean_id, recommendation ->> 'court_id', recommendation ->> 'court_name',
    (recommendation ->> 'weekday')::smallint, (recommendation ->> 'start_hour')::smallint,
    'facebook_regular_price', 0, 1, (snapshot #>> '{period,from}')::date,
    (snapshot #>> '{period,to}')::date, (recommendation ->> 'utilization_pct')::numeric,
    (recommendation ->> 'comparable_days')::integer, (recommendation ->> 'available_hours')::numeric,
    recommendation ->> 'confidence', recommendation ->> 'state',
    (recommendation ->> 'open_future_hours')::numeric,
    (recommendation ->> 'opportunity_value')::numeric, candidate_date, auth.uid()
  ) returning * into inserted;

  insert into public.profit_learning_occurrences (
    experiment_id, pair_no, batch_no, court_id, play_date, slot_hour, arm,
    regular_rate_snapshot, pricing_digest
  ) values (
    inserted.id, 1, 1, inserted.court_id, candidate_date, inserted.slot_hour,
    'treatment', candidate_rate,
    pg_catalog.encode(extensions.digest(
      inserted.court_id || '|' || candidate_date::text || '|' || inserted.slot_hour::text || '|' || candidate_rate::text,
      'sha256'
    ), 'hex')
  ) returning id into occurrence_id;

  return pg_catalog.jsonb_build_object(
    'created', true, 'experiment_id', inserted.id, 'recommendation_id', clean_id,
    'court_id', inserted.court_id, 'court_name', inserted.court_name_snapshot,
    'weekday', inserted.weekday, 'slot_hour', inserted.slot_hour,
    'end_hour', inserted.slot_hour + 1, 'action', inserted.treatment_action,
    'discount_percent', 0, 'target_occurrences', 1, 'horizon_days', 28,
    'target_pairs', 1, 'assigned_occurrences', 1,
    'occurrence_id', occurrence_id, 'play_date', candidate_date,
    'scheduled_through', candidate_date, 'status', inserted.status
  );
end;
$$;

revoke all on function public.create_profit_learning_experiment_from_recommendation(text, text)
  from public, anon;
grant execute on function public.create_profit_learning_experiment_from_recommendation(text, text)
  to authenticated;

comment on function public.create_profit_learning_experiment_from_recommendation(text, text) is
  'Creates one owner-approved, exact one-hour Best Move within the next 28 days. It never changes bookings or public prices.';

create or replace function public.advance_profit_learning_best_move()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  account_role text := public.current_account_role();
  local_today date := pg_catalog.timezone('Asia/Manila', pg_catalog.clock_timestamp())::date;
  active_id uuid;
  finalized jsonb := '{}'::jsonb;
begin
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can advance a Best Move.' using errcode = '42501';
  end if;

  select id into active_id
  from public.profit_learning_experiments
  where status = 'active'
    and target_pairs = 1
    and scheduled_through < local_today
  order by started_at
  limit 1
  for update;

  if active_id is null then
    return pg_catalog.jsonb_build_object('completed', false);
  end if;

  finalized := public.finalize_profit_learning_occurrence_outcomes(active_id);
  update public.profit_learning_experiments
     set status = 'completed',
         ended_at = pg_catalog.now(),
         ended_by = auth.uid(),
         updated_at = pg_catalog.now()
   where id = active_id and status = 'active';

  return pg_catalog.jsonb_build_object(
    'completed', true,
    'experiment_id', active_id,
    'outcomes', finalized
  );
end;
$$;

revoke all on function public.advance_profit_learning_best_move() from public, anon;
grant execute on function public.advance_profit_learning_best_move() to authenticated;

notify pgrst, 'reload schema';

commit;
