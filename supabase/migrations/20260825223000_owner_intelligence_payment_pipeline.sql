-- Correct Owner Intelligence semantics after confirming that booking.status
-- values `cancelled` and `forfeited` are operational/payment outcomes, not a
-- reliable record of customer-requested booking cancellations.

begin;

alter function public.get_owner_intelligence(date, date, text)
  rename to get_owner_intelligence_legacy;

revoke all on function public.get_owner_intelligence_legacy(date, date, text) from public;
revoke execute on function public.get_owner_intelligence_legacy(date, date, text) from anon, authenticated;

create or replace function public.get_owner_intelligence(
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
  snapshot jsonb;
  range_start date;
  range_end date;
  local_today date := timezone('Asia/Manila', clock_timestamp())::date;
  trend_grain text;
  trend_step interval;
  open_hour integer := 6;
  close_hour integer := 22;
  available_hours numeric := 0;
  gross_revenue numeric := 0;
  collected_revenue numeric := 0;
  outstanding_balance numeric := 0;
  booked_hours numeric := 0;
  completed_reservations integer := 0;
  confirmed_reservations integer := 0;
  payment_review_reservations integer := 0;
  pipeline_total integer := 0;
  corrected_lifecycle jsonb := '[]'::jsonb;
  corrected_courts jsonb := '[]'::jsonb;
  corrected_trend jsonb := '[]'::jsonb;
  forward_outlook jsonb := '{}'::jsonb;
begin
  -- The legacy implementation retains the owner/court-owner authorization,
  -- range validation, capacity model, heatmap, and repeat-customer logic.
  snapshot := public.get_owner_intelligence_legacy(p_from, p_to, p_court_id);
  range_start := (snapshot #>> '{period,from}')::date;
  range_end := (snapshot #>> '{period,to}')::date;
  if range_end - range_start + 1 <= 28 then
    trend_grain := 'day';
    trend_step := interval '1 day';
  elsif range_end - range_start + 1 <= 180 then
    trend_grain := 'week';
    trend_step := interval '1 week';
  else
    trend_grain := 'month';
    trend_step := interval '1 month';
  end if;
  open_hour := coalesce((snapshot #>> '{settings,open_hour}')::integer, 6);
  close_hour := coalesce((snapshot #>> '{settings,close_hour}')::integer, 22);
  available_hours := coalesce((snapshot #>> '{kpis,available_hours}')::numeric, 0);

  with
  raw_rows as materialized (
    select
      b.ref,
      case
        when nullif(btrim(b.booking_group_ref), '') is not null
          then 'group:' || btrim(b.booking_group_ref)
        else 'booking:' || b.ref
      end as reservation_key,
      b.court_id,
      b.date,
      lower(coalesce(b.status, 'pending')) as status,
      lower(coalesce(b.payment_status, 'unpaid')) as payment_status,
      greatest(coalesce(b.total, 0), 0)::numeric as total,
      greatest(coalesce(b.downpayment, 0), 0)::numeric as downpayment,
      greatest(
        coalesce(nullif(b.duration, 0), cardinality(coalesce(b.slots, '{}'::text[]))::numeric, 0),
        0
      )::numeric as duration,
      case
        when lower(coalesce(b.payment_status, 'unpaid')) = 'paid'
          then greatest(coalesce(b.total, 0), 0)::numeric
        when lower(coalesce(b.payment_status, 'unpaid')) in ('downpayment_paid', 'deposit_retained')
          then least(
            greatest(coalesce(b.total, 0), 0)::numeric,
            greatest(coalesce(b.downpayment, 0), 0)::numeric
          )
        else 0::numeric
      end as paid_amount,
      (
        (
          nullif(btrim(coalesce(b.receipt_image_url, '')), '') is not null
          and lower(coalesce(b.receipt_image_hash, '')) ~ '^[a-f0-9]{64}$'
        )
        or lower(coalesce(b.receipt_status, 'none')) = 'manual_review'
        or exists (
          select 1
          from public.receipt_verifications verification
          where verification.booking_ref = b.ref
            and lower(coalesce(verification.result, '')) = 'manual_review'
        )
      ) as durable_review_evidence,
      row_number() over (
        partition by
          case
            when nullif(btrim(b.booking_group_ref), '') is not null then btrim(b.booking_group_ref)
            else b.ref
          end,
          b.court_id,
          b.date,
          coalesce(array_to_string(b.slots, ','), b.start_time, '')
        order by b.created_at, b.ref
      ) as logical_row_number
    from public.bookings b
    where b.date between range_start and range_end
      and lower(coalesce(b.created_via, 'customer')) <> 'import'
      and upper(coalesce(b.ref, '')) not like 'MANUAL-%'
      and lower(coalesce(b.payment_method, '')) <> 'manual'
      and lower(coalesce(b.email, '')) <> 'reserve@hold.internal'
      and (p_court_id is null or b.court_id = p_court_id)
  ),
  booking_rows as materialized (
    select * from raw_rows where logical_row_number = 1
  ),
  pipeline as materialized (
    select
      reservation_key,
      case
        when bool_or(status = 'completed') then 'completed'
        when bool_or(status = 'confirmed') then 'confirmed'
        when bool_or(
          status in ('pending', 'verifying')
          and payment_status = 'for_verification'
          and durable_review_evidence
        ) then 'payment_review'
        else null
      end as pipeline_status
    from booking_rows
    group by reservation_key
  ),
  financial_summary as (
    select
      coalesce(sum(total) filter (where status in ('confirmed', 'completed')), 0)::numeric as gross_revenue,
      coalesce(sum(paid_amount) filter (where status in ('confirmed', 'completed')), 0)::numeric as collected_revenue,
      coalesce(sum(greatest(total - paid_amount, 0)) filter (where status in ('confirmed', 'completed')), 0)::numeric as outstanding_balance,
      coalesce(sum(duration) filter (where status in ('confirmed', 'completed')), 0)::numeric as booked_hours
    from booking_rows
  )
  select
    financial.gross_revenue,
    financial.collected_revenue,
    financial.outstanding_balance,
    financial.booked_hours,
    count(*) filter (where pipeline.pipeline_status = 'completed')::integer,
    count(*) filter (where pipeline.pipeline_status = 'confirmed')::integer,
    count(*) filter (where pipeline.pipeline_status = 'payment_review')::integer
  into
    gross_revenue,
    collected_revenue,
    outstanding_balance,
    booked_hours,
    completed_reservations,
    confirmed_reservations,
    payment_review_reservations
  from pipeline
  cross join financial_summary financial
  group by
    financial.gross_revenue,
    financial.collected_revenue,
    financial.outstanding_balance,
    financial.booked_hours;

  pipeline_total := completed_reservations + confirmed_reservations + payment_review_reservations;
  corrected_lifecycle := jsonb_build_array(
    jsonb_build_object('status', 'completed', 'count', completed_reservations),
    jsonb_build_object('status', 'confirmed', 'count', confirmed_reservations),
    jsonb_build_object('status', 'payment_review', 'count', payment_review_reservations)
  );

  with
  court_raw as materialized (
    select
      b.*,
      row_number() over (
        partition by
          case
            when nullif(btrim(b.booking_group_ref), '') is not null then btrim(b.booking_group_ref)
            else b.ref
          end,
          b.court_id,
          b.date,
          coalesce(array_to_string(b.slots, ','), b.start_time, '')
        order by b.created_at, b.ref
      ) as logical_row_number
    from public.bookings b
    where b.date between range_start and range_end
      and lower(coalesce(b.created_via, 'customer')) <> 'import'
      and upper(coalesce(b.ref, '')) not like 'MANUAL-%'
      and lower(coalesce(b.payment_method, '')) <> 'manual'
      and lower(coalesce(b.email, '')) <> 'reserve@hold.internal'
      and (p_court_id is null or b.court_id = p_court_id)
  ),
  court_financials as (
    select
      b.court_id,
      coalesce(sum(greatest(coalesce(b.total, 0), 0)) filter (
        where lower(coalesce(b.status, '')) in ('confirmed', 'completed')
      ), 0)::numeric as gross_revenue,
      coalesce(sum(case
        when lower(coalesce(b.status, '')) not in ('confirmed', 'completed') then 0
        when lower(coalesce(b.payment_status, '')) = 'paid' then greatest(coalesce(b.total, 0), 0)
        when lower(coalesce(b.payment_status, '')) = 'downpayment_paid' then least(
          greatest(coalesce(b.total, 0), 0), greatest(coalesce(b.downpayment, 0), 0)
        )
        else 0
      end), 0)::numeric as collected_revenue
    from court_raw b
    where b.logical_row_number = 1
    group by b.court_id
  )
  select coalesce(jsonb_agg(
    court.value || jsonb_build_object(
      'gross_revenue', coalesce(financial.gross_revenue, 0),
      'collected_revenue', coalesce(financial.collected_revenue, 0)
    )
    order by coalesce(financial.collected_revenue, 0) desc, court.value ->> 'court_name'
  ), '[]'::jsonb)
  into corrected_courts
  from jsonb_array_elements(coalesce(snapshot -> 'courts', '[]'::jsonb)) court(value)
  left join court_financials financial on financial.court_id = court.value ->> 'court_id';

  with
  trend_raw as materialized (
    select
      b.*,
      row_number() over (
        partition by
          case
            when nullif(btrim(b.booking_group_ref), '') is not null then btrim(b.booking_group_ref)
            else b.ref
          end,
          b.court_id,
          b.date,
          coalesce(array_to_string(b.slots, ','), b.start_time, '')
        order by b.created_at, b.ref
      ) as logical_row_number
    from public.bookings b
    where b.date between range_start and range_end
      and lower(coalesce(b.created_via, 'customer')) <> 'import'
      and upper(coalesce(b.ref, '')) not like 'MANUAL-%'
      and lower(coalesce(b.payment_method, '')) <> 'manual'
      and lower(coalesce(b.email, '')) <> 'reserve@hold.internal'
      and (p_court_id is null or b.court_id = p_court_id)
  ),
  trend_financials as (
    select
      date_trunc(trend_grain, b.date::timestamp)::date as bucket,
      count(distinct case
        when lower(coalesce(b.status, '')) in ('confirmed', 'completed')
          then coalesce(nullif(btrim(b.booking_group_ref), ''), b.ref)
      end)::integer as reservations,
      coalesce(sum(greatest(coalesce(nullif(b.duration, 0), cardinality(coalesce(b.slots, '{}'::text[]))::numeric, 0), 0)) filter (
        where lower(coalesce(b.status, '')) in ('confirmed', 'completed')
      ), 0)::numeric as booked_hours,
      coalesce(sum(case
        when lower(coalesce(b.status, '')) not in ('confirmed', 'completed') then 0
        when lower(coalesce(b.payment_status, '')) = 'paid' then greatest(coalesce(b.total, 0), 0)
        when lower(coalesce(b.payment_status, '')) = 'downpayment_paid' then least(
          greatest(coalesce(b.total, 0), 0), greatest(coalesce(b.downpayment, 0), 0)
        )
        else 0
      end), 0)::numeric as collected_revenue
    from trend_raw b
    where b.logical_row_number = 1
    group by date_trunc(trend_grain, b.date::timestamp)
  ),
  trend_buckets as (
    select
      bucket::date as bucket,
      greatest(bucket::date, range_start) as bucket_start,
      least((bucket + trend_step - interval '1 day')::date, range_end) as bucket_end,
      greatest(bucket::date, range_start) <> bucket::date
        or least((bucket + trend_step - interval '1 day')::date, range_end) <> (bucket + trend_step - interval '1 day')::date as is_partial
    from generate_series(
      date_trunc(trend_grain, range_start::timestamp),
      date_trunc(trend_grain, range_end::timestamp),
      trend_step
    ) bucket
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'date', bucket.bucket,
      'bucket_start', bucket.bucket_start,
      'bucket_end', bucket.bucket_end,
      'is_partial', bucket.is_partial,
      'reservations', coalesce(financial.reservations, 0),
      'booked_hours', coalesce(financial.booked_hours, 0),
      'collected_revenue', coalesce(financial.collected_revenue, 0)
    ) order by bucket.bucket
  ), '[]'::jsonb)
  into corrected_trend
  from trend_buckets bucket
  left join trend_financials financial on financial.bucket = bucket.bucket;

  with
  future_days as materialized (
    select d::date as date
    from generate_series((local_today + 1)::timestamp, (local_today + 60)::timestamp, interval '1 day') d
  ),
  future_raw as materialized (
    select
      b.ref,
      coalesce(nullif(btrim(b.booking_group_ref), ''), b.ref) as reservation_key,
      b.court_id,
      b.date,
      lower(coalesce(b.status, 'pending')) as status,
      lower(coalesce(b.payment_status, 'unpaid')) as payment_status,
      greatest(coalesce(b.total, 0), 0)::numeric as total,
      greatest(coalesce(b.downpayment, 0), 0)::numeric as downpayment,
      greatest(coalesce(nullif(b.duration, 0), cardinality(coalesce(b.slots, '{}'::text[]))::numeric, 0), 0)::numeric as duration,
      case
        when lower(coalesce(b.payment_status, 'unpaid')) = 'paid' then greatest(coalesce(b.total, 0), 0)::numeric
        when lower(coalesce(b.payment_status, 'unpaid')) = 'downpayment_paid' then least(greatest(coalesce(b.total, 0), 0), greatest(coalesce(b.downpayment, 0), 0))::numeric
        else 0::numeric
      end as paid_amount,
      (
        (nullif(btrim(coalesce(b.receipt_image_url, '')), '') is not null and lower(coalesce(b.receipt_image_hash, '')) ~ '^[a-f0-9]{64}$')
        or lower(coalesce(b.receipt_status, 'none')) = 'manual_review'
        or exists (
          select 1 from public.receipt_verifications verification
          where verification.booking_ref = b.ref
            and lower(coalesce(verification.result, '')) = 'manual_review'
        )
      ) as durable_review_evidence,
      row_number() over (
        partition by coalesce(nullif(btrim(b.booking_group_ref), ''), b.ref), b.court_id, b.date,
          coalesce(array_to_string(b.slots, ','), b.start_time, '')
        order by b.created_at, b.ref
      ) as logical_row_number
    from public.bookings b
    where b.date between local_today + 1 and local_today + 60
      and lower(coalesce(b.created_via, 'customer')) <> 'import'
      and upper(coalesce(b.ref, '')) not like 'MANUAL-%'
      and lower(coalesce(b.payment_method, '')) <> 'manual'
      and lower(coalesce(b.email, '')) <> 'reserve@hold.internal'
      and (p_court_id is null or b.court_id = p_court_id)
  ),
  future_rows as materialized (
    select * from future_raw where logical_row_number = 1
  ),
  future_capacity as (
    select
      d.date,
      coalesce(count(c.id) filter (where bd.date is null), 0) * (close_hour - open_hour)::numeric as available_hours
    from future_days d
    left join public.courts c
      on timezone('Asia/Manila', c.created_at)::date <= d.date
     and (p_court_id is null or c.id = p_court_id)
    left join public.blocked_dates bd on bd.date = d.date
    group by d.date
  ),
  future_financials as (
    select
      d.date,
      coalesce(sum(r.paid_amount) filter (where r.status = 'confirmed'), 0)::numeric as secured_revenue,
      coalesce(sum(r.total) filter (where r.status = 'confirmed'), 0)::numeric as committed_booking_value,
      coalesce(sum(greatest(r.total - r.paid_amount, 0)) filter (where r.status = 'confirmed'), 0)::numeric as outstanding_balance,
      coalesce(sum(r.duration) filter (where r.status = 'confirmed'), 0)::numeric as booked_hours,
      count(distinct r.reservation_key) filter (where r.status = 'confirmed')::integer as confirmed_reservations,
      count(distinct r.reservation_key) filter (
        where r.status in ('pending', 'verifying') and r.payment_status = 'for_verification' and r.durable_review_evidence
      )::integer as payment_review_reservations
    from future_days d
    left join future_rows r on r.date = d.date
    group by d.date
  ),
  future_daily as materialized (
    select
      f.date,
      f.secured_revenue,
      f.committed_booking_value,
      f.outstanding_balance,
      f.booked_hours,
      f.confirmed_reservations,
      f.payment_review_reservations,
      coalesce(c.available_hours, 0)::numeric as available_hours
    from future_financials f
    left join future_capacity c on c.date = f.date
  ),
  horizon_days(days) as (values (7), (30), (60)),
  horizons as (
    select
      h.days,
      local_today + 1 as from_date,
      local_today + h.days as to_date,
      coalesce(sum(d.secured_revenue), 0)::numeric as secured_revenue,
      coalesce(sum(d.committed_booking_value), 0)::numeric as committed_booking_value,
      coalesce(sum(d.outstanding_balance), 0)::numeric as outstanding_balance,
      coalesce(sum(d.booked_hours), 0)::numeric as booked_hours,
      coalesce(sum(d.available_hours), 0)::numeric as available_hours,
      coalesce(sum(d.confirmed_reservations), 0)::integer as confirmed_reservations,
      coalesce(sum(d.payment_review_reservations), 0)::integer as payment_review_reservations
    from horizon_days h
    left join future_daily d on d.date <= local_today + h.days
    group by h.days
  )
  select jsonb_build_object(
    'as_of', local_today,
    'horizons', (select jsonb_agg(jsonb_build_object(
      'days', h.days, 'from', h.from_date, 'to', h.to_date,
      'kpis', jsonb_build_object(
        'secured_revenue', h.secured_revenue,
        'committed_booking_value', h.committed_booking_value,
        'outstanding_balance', h.outstanding_balance,
        'confirmed_reservations', h.confirmed_reservations,
        'payment_review_reservations', h.payment_review_reservations,
        'booked_hours', h.booked_hours,
        'available_hours', h.available_hours,
        'booked_utilization_pct', case when h.available_hours <= 0 then 0 else round(least(100, h.booked_hours * 100 / h.available_hours), 2) end
      )
    ) order by h.days) from horizons h),
    'daily', (select jsonb_agg(to_jsonb(d) order by d.date) from future_daily d)
  ) into forward_outlook;

  snapshot := jsonb_set(
    snapshot,
    '{kpis}',
    (coalesce(snapshot -> 'kpis', '{}'::jsonb) - 'cancellation_rate' - 'retained_deposit_amount') || jsonb_build_object(
      'gross_revenue', gross_revenue,
      'collected_revenue', collected_revenue,
      'outstanding_balance', outstanding_balance,
      'booked_hours', booked_hours,
      'completed_reservations', completed_reservations,
      'active_reservations', completed_reservations + confirmed_reservations,
      'payment_review_reservations', payment_review_reservations,
      'total_reservations', pipeline_total,
      'revenue_per_booked_hour', case
        when booked_hours <= 0 then 0 else round(collected_revenue / booked_hours, 2)
      end,
      'revenue_per_available_hour', case
        when available_hours <= 0 then 0 else round(collected_revenue / available_hours, 2)
      end
    ),
    true
  );
  snapshot := jsonb_set(snapshot, '{lifecycle}', corrected_lifecycle, true);
  snapshot := jsonb_set(snapshot, '{courts}', corrected_courts, true);
  snapshot := jsonb_set(snapshot, '{trend}', corrected_trend, true);
  snapshot := jsonb_set(snapshot, '{period,trend_grain}', to_jsonb(trend_grain), true);
  snapshot := jsonb_set(snapshot, '{forward_outlook}', forward_outlook, true);
  snapshot := jsonb_set(
    snapshot,
    '{data_quality}',
    coalesce(snapshot -> 'data_quality', '{}'::jsonb) || jsonb_build_object(
      'pipeline_note', 'Cancelled, rejected, expired, and forfeited operational records are excluded from booking pipeline and revenue-efficiency metrics. Receipt-backed payments awaiting an owner decision are counted as Needs payment review.'
    ),
    true
  );

  return snapshot;
end;
$$;

comment on function public.get_owner_intelligence(date, date, text) is
  'Returns owner-only booking demand, successful-booking revenue, and durable payment-review pipeline aggregates without treating operational cancellations or forfeitures as customer cancellations.';

revoke all on function public.get_owner_intelligence(date, date, text) from public;
revoke execute on function public.get_owner_intelligence(date, date, text) from anon;
grant execute on function public.get_owner_intelligence(date, date, text) to authenticated;

commit;
