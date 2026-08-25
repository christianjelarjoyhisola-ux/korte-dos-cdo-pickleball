-- Public, PII-free demand campaign slot previews and mixed-window pricing.
--
-- The preview is advisory only. Booking holds are still created at the normal
-- server-approved price and apply_matching_demand_campaign() remains the only
-- authority that reserves campaign capacity and changes a held booking total.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.get_public_demand_campaign_slot_offers(
  p_date date
)
returns table (
  court_id text,
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
  with active_offer as materialized (
    select
      campaign.id,
      campaign.court_id,
      campaign.start_hour,
      campaign.end_hour,
      campaign.discount_percent,
      campaign.ends_at
    from public.demand_campaigns campaign
    where p_date is not null
      and p_date > pg_catalog.timezone(
        'Asia/Manila',
        pg_catalog.statement_timestamp()
      )::date
      and campaign.status = 'active'
      and campaign.starts_at <= pg_catalog.statement_timestamp()
      and campaign.ends_at > pg_catalog.statement_timestamp()
      and extract(isodow from p_date)::integer = campaign.weekday
      and (
        select pg_catalog.count(*)
        from public.demand_campaign_redemptions redemption
        where redemption.campaign_id = campaign.id
          and (
            redemption.status = 'redeemed'
            or (
              redemption.status = 'reserved'
              and redemption.reserved_until > pg_catalog.statement_timestamp()
            )
          )
      ) < campaign.max_redemptions
    order by campaign.starts_at desc, campaign.id
    limit 1
  ), priced_slots as (
    select
      campaign.court_id,
      p_date as offer_date,
      offered.slot_hour,
      campaign.discount_percent,
      pg_catalog.round(
        greatest(
          public.calculate_booking_court_total(
            campaign.court_id,
            array[offered.slot_hour::text]
          ),
          0
        ),
        2
      )::numeric(12,2) as regular_rate,
      campaign.ends_at
    from active_offer campaign
    cross join lateral pg_catalog.generate_series(
      campaign.start_hour::integer,
      campaign.end_hour::integer - 1
    ) as offered(slot_hour)
  )
  select
    priced.court_id,
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
  order by priced.court_id, priced.slot_hour
$$;

revoke all on function public.get_public_demand_campaign_slot_offers(date)
  from public, anon, authenticated;
grant execute on function public.get_public_demand_campaign_slot_offers(date)
  to anon, authenticated;

comment on function public.get_public_demand_campaign_slot_offers(date) is
  'Returns only public-facing hourly Smart Rate prices for one future Manila play date. No campaign internals, quota counts, customer data, or payment data are exposed.';

-- Replace the campaign application function so a mixed booking row receives a
-- discount only for the hours inside the campaign window. Regular hours and the
-- full immutable booking fee remain in the gross total at their normal price.
create or replace function public.apply_matching_demand_campaign(
  p_booking_refs text[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  request_role text := coalesce(
    auth.role(),
    nullif(pg_catalog.current_setting('request.jwt.claim.role', true), '')
  );
  account_role text := public.current_account_role();
  local_today date := pg_catalog.timezone(
    'Asia/Manila',
    pg_catalog.clock_timestamp()
  )::date;
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
    select distinct pg_catalog.upper(pg_catalog.btrim(requested.ref))
    from pg_catalog.unnest(
      coalesce(p_booking_refs, '{}'::text[])
    ) as requested(ref)
    where pg_catalog.btrim(requested.ref) <> ''
    order by 1
  );
  if pg_catalog.cardinality(clean_refs) = 0 then
    return pg_catalog.jsonb_build_object(
      'applied', false,
      'reason', 'no_booking_holds'
    );
  end if;
  group_key := public.demand_booking_group_key(clean_refs);

  perform public.release_expired_demand_campaign_reservations();

  select campaign_row.* into campaign
  from public.demand_campaigns campaign_row
  where campaign_row.status = 'active'
    and campaign_row.starts_at <= pg_catalog.now()
    and campaign_row.ends_at > pg_catalog.now()
  limit 1
  for update;

  if not found then
    return pg_catalog.jsonb_build_object(
      'applied', false,
      'reason', 'no_active_campaign'
    );
  end if;

  perform 1
  from public.bookings booking
  where booking.ref = any(clean_refs)
  order by booking.ref
  for update;

  select
    pg_catalog.count(*),
    pg_catalog.count(*) filter (
      where booking.status = 'verifying'
        and booking.created_at > pg_catalog.now() - interval '15 minutes'
        and booking.date > local_today
        and (
          (
            request_role = 'anon'
            and coalesce(booking.host_booking, false) = false
            and booking.host_user_id is null
            and booking.created_via = 'customer'
            and booking.created_by_user_id is null
            and booking.email = 'reserve@hold.internal'
          )
          or (
            request_role = 'authenticated'
            and account_role = 'host'
            and coalesce(booking.host_booking, false) = true
            and booking.host_user_id = auth.uid()
            and booking.created_via = 'host'
            and booking.created_by_user_id = auth.uid()
          )
        )
    ),
    pg_catalog.min(
      coalesce(
        nullif(pg_catalog.btrim(booking.booking_group_ref), ''),
        booking.ref
      )
    ),
    pg_catalog.count(distinct coalesce(
      nullif(pg_catalog.btrim(booking.booking_group_ref), ''),
      booking.ref
    )),
    pg_catalog.min(booking.created_at + interval '15 minutes')
  into
    supplied_count,
    eligible_count,
    group_identity,
    group_identity_count,
    reservation_deadline
  from public.bookings booking
  where booking.ref = any(clean_refs);

  if supplied_count <> pg_catalog.cardinality(clean_refs)
     or eligible_count <> pg_catalog.cardinality(clean_refs) then
    raise exception 'The booking reservation expired or changed. Please select the slots again.'
      using errcode = 'P0001';
  end if;
  if group_identity_count <> 1 then
    raise exception 'Demand pricing can be applied to one booking group at a time.'
      using errcode = '22023';
  end if;

  select pg_catalog.count(*) into active_group_count
  from public.bookings booking
  where coalesce(
      nullif(pg_catalog.btrim(booking.booking_group_ref), ''),
      booking.ref
    ) = group_identity
    and booking.status not in ('cancelled', 'forfeited');
  if active_group_count <> pg_catalog.cardinality(clean_refs) then
    raise exception 'The complete booking group is required for automatic demand pricing.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.bookings booking
    where booking.ref = any(clean_refs)
      and (
        booking.voucher_id is not null
        or coalesce(booking.voucher_discount_amount, 0) > 0
      )
  ) then
    return pg_catalog.jsonb_build_object(
      'applied', false,
      'reason', 'voucher_already_applied'
    );
  end if;
  if exists (
    select 1
    from public.bookings booking
    where booking.ref = any(clean_refs)
      and booking.demand_campaign_id is not null
      and booking.demand_campaign_id <> campaign.id
  ) then
    return pg_catalog.jsonb_build_object(
      'applied', false,
      'reason', 'demand_campaign_already_applied'
    );
  end if;

  select redemption.* into existing_redemption
  from public.demand_campaign_redemptions redemption
  where redemption.campaign_id = campaign.id
    and redemption.booking_group_key = group_key;
  if found then
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'ref', booking.ref,
          'gross_total', booking.demand_campaign_gross_total,
          'discount_amount', booking.demand_campaign_discount_amount,
          'total', booking.total
        )
        order by booking.ref
      ),
      '[]'::jsonb
    )
    into allocations
    from public.bookings booking
    where booking.ref = any(existing_redemption.booking_refs);

    return pg_catalog.jsonb_build_object(
      'applied', existing_redemption.status <> 'released',
      'idempotent', true,
      'campaign_id', campaign.id,
      'discount_percent', campaign.discount_percent,
      'discount_amount', existing_redemption.discount_amount,
      'allocations', allocations
    );
  end if;

  with matching as materialized (
    select
      booking.*,
      slot_scope.eligible_slots
    from public.bookings booking
    cross join lateral (
      select array(
        select requested.slot_value
        from pg_catalog.unnest(
          coalesce(booking.slots, '{}'::text[])
        ) as requested(slot_value)
        where requested.slot_value ~ '^\d{1,2}(\.\d+)?$'
          and pg_catalog.floor(requested.slot_value::numeric)::integer >= campaign.start_hour
          and pg_catalog.floor(requested.slot_value::numeric)::integer < campaign.end_hour
        order by
          pg_catalog.floor(requested.slot_value::numeric)::integer,
          requested.slot_value
      ) as eligible_slots
    ) slot_scope
    where booking.ref = any(clean_refs)
      and booking.court_id = campaign.court_id
      and extract(isodow from booking.date)::integer = campaign.weekday
      and pg_catalog.cardinality(slot_scope.eligible_slots) > 0
      and booking.demand_campaign_id is null
  ), basis as materialized (
    select
      booking.ref,
      coalesce(
        booking.demand_campaign_gross_total,
        booking.total
      )::numeric as gross_total,
      least(
        greatest(
          coalesce(
            booking.demand_campaign_gross_total,
            booking.total
          ) - least(
            greatest(
              coalesce(booking.booking_fee_amount_snapshot, 0),
              0
            ),
            coalesce(
              booking.demand_campaign_gross_total,
              booking.total
            )
          ),
          0
        ),
        greatest(
          public.calculate_booking_court_total(
            booking.court_id,
            booking.eligible_slots
          ),
          0
        )
      )::numeric as eligible_amount
    from matching booking
  )
  select
    pg_catalog.count(*),
    coalesce(pg_catalog.round(pg_catalog.sum(gross_total), 2), 0),
    coalesce(pg_catalog.round(pg_catalog.sum(eligible_amount), 2), 0),
    coalesce(
      pg_catalog.array_agg(ref order by ref),
      '{}'::text[]
    )
  into eligible_count, gross_amount, eligible_court_amount, affected_refs
  from basis;

  if eligible_count = 0 or eligible_court_amount <= 0 then
    return pg_catalog.jsonb_build_object(
      'applied', false,
      'reason', 'booking_not_in_campaign_window'
    );
  end if;

  select pg_catalog.count(*) into usage_count
  from public.demand_campaign_redemptions redemption
  where redemption.campaign_id = campaign.id
    and redemption.status in ('reserved', 'redeemed');
  if usage_count >= campaign.max_redemptions then
    return pg_catalog.jsonb_build_object(
      'applied', false,
      'reason', 'campaign_limit_reached'
    );
  end if;

  discount_amount := pg_catalog.round(
    eligible_court_amount * campaign.discount_percent / 100,
    2
  );
  discount_amount := greatest(
    least(discount_amount, eligible_court_amount),
    0
  );
  if discount_amount <= 0 then
    return pg_catalog.jsonb_build_object(
      'applied', false,
      'reason', 'no_discount'
    );
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

  perform pg_catalog.set_config('app.demand_campaign_apply', '1', true);
  with basis as materialized (
    select
      booking.ref,
      coalesce(
        booking.demand_campaign_gross_total,
        booking.total
      )::numeric as gross_total,
      least(
        greatest(
          coalesce(
            booking.demand_campaign_gross_total,
            booking.total
          ) - least(
            greatest(
              coalesce(booking.booking_fee_amount_snapshot, 0),
              0
            ),
            coalesce(
              booking.demand_campaign_gross_total,
              booking.total
            )
          ),
          0
        ),
        greatest(
          public.calculate_booking_court_total(
            booking.court_id,
            slot_scope.eligible_slots
          ),
          0
        )
      )::numeric as eligible_amount
    from public.bookings booking
    cross join lateral (
      select array(
        select requested.slot_value
        from pg_catalog.unnest(
          coalesce(booking.slots, '{}'::text[])
        ) as requested(slot_value)
        where requested.slot_value ~ '^\d{1,2}(\.\d+)?$'
          and pg_catalog.floor(requested.slot_value::numeric)::integer >= campaign.start_hour
          and pg_catalog.floor(requested.slot_value::numeric)::integer < campaign.end_hour
        order by
          pg_catalog.floor(requested.slot_value::numeric)::integer,
          requested.slot_value
      ) as eligible_slots
    ) slot_scope
    where booking.ref = any(affected_refs)
  ), allocated as (
    select
      basis.*,
      pg_catalog.row_number() over (order by basis.ref) as row_no,
      pg_catalog.count(*) over () as row_count
    from basis
  ), discounts as (
    select
      allocated.*,
      case
        when allocated.row_no < allocated.row_count then
          pg_catalog.round(
            discount_amount * allocated.eligible_amount
              / nullif(eligible_court_amount, 0),
            2
          )
        else discount_amount - coalesce(
          pg_catalog.sum(
            pg_catalog.round(
              discount_amount * allocated.eligible_amount
                / nullif(eligible_court_amount, 0),
              2
            )
          ) over (
            order by allocated.row_no
            rows between unbounded preceding and 1 preceding
          ),
          0
        )
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

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'ref', booking.ref,
        'gross_total', booking.demand_campaign_gross_total,
        'discount_amount', booking.demand_campaign_discount_amount,
        'total', booking.total
      )
      order by booking.ref
    ),
    '[]'::jsonb
  )
  into allocations
  from public.bookings booking
  where booking.ref = any(affected_refs);

  return pg_catalog.jsonb_build_object(
    'applied', true,
    'idempotent', false,
    'campaign_id', campaign.id,
    'campaign_name', campaign.court_name_snapshot || ' '
      || campaign.start_hour || ':00-' || campaign.end_hour || ':00 demand offer',
    'discount_percent', campaign.discount_percent,
    'discount_amount', discount_amount,
    'gross_amount', gross_amount,
    'total', gross_amount - discount_amount,
    'allocations', allocations,
    'reserved_until', reservation_deadline
  );
end;
$$;

revoke all on function public.apply_matching_demand_campaign(text[])
  from public;
grant execute on function public.apply_matching_demand_campaign(text[])
  to anon, authenticated;

notify pgrst, 'reload schema';

commit;
