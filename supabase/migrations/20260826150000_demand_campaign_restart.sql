-- Allow a deliberately ended Smart Offer to be started again without
-- confusing an old ended campaign for a successful activation.
--
-- Each restart receives a new campaign row so the prior run and its
-- redemptions remain auditable. The existing one-active-campaign index and
-- transaction advisory lock continue to prevent concurrent active offers.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '90s';

alter table public.demand_campaigns
  drop constraint if exists demand_campaigns_source_recommendation_id_key;

create index if not exists demand_campaigns_source_recommendation_idx
  on public.demand_campaigns (source_recommendation_id, created_at desc);

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
  is_restart boolean := false;
  prior_usage integer := 0;
  remaining_redemptions integer := 0;
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
        'created', false,
        'restarted', false,
        'idempotent', true,
        'campaign_id', existing.id,
        'status', existing.status,
        'starts_at', existing.starts_at,
        'ends_at', existing.ends_at
      );
    end if;
    raise exception 'A growth campaign is already active. End it before applying another recommendation.'
      using errcode = 'P0001';
  end if;

  select exists (
    select 1
    from public.demand_campaigns campaign
    where campaign.source_recommendation_id = clean_id
      and campaign.status = 'ended'
  ) into is_restart;

  perform public.release_expired_demand_campaign_reservations();

  select count(*)::integer
    into prior_usage
  from public.demand_campaign_redemptions redemption
  join public.demand_campaigns campaign on campaign.id = redemption.campaign_id
  where campaign.source_recommendation_id = clean_id
    and redemption.status in ('reserved', 'redeemed');

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

  remaining_redemptions := least(
    coalesce((recommendation ->> 'max_redemptions')::integer, 20),
    20
  ) - prior_usage;
  if remaining_redemptions <= 0 then
    raise exception 'This smart offer has already reached its 20-booking safety limit.'
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
    remaining_redemptions,
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
    'created', true,
    'restarted', is_restart,
    'idempotent', false,
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

revoke all on function public.create_demand_campaign_from_recommendation(text, text)
  from public, anon;
grant execute on function public.create_demand_campaign_from_recommendation(text, text)
  to authenticated;

notify pgrst, 'reload schema';

commit;
