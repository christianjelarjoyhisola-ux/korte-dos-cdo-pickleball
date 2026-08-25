-- ============================================================================
-- Korte DOS Owner Intelligence
--
-- Provides a PII-free, server-aggregated venue-performance contract for the
-- system owner and court owner. The function learns from the earliest reliable
-- online booking through the current Manila date unless a narrower range is
-- requested. It never returns customer identity, payment references, or receipt
-- evidence.
-- ============================================================================

begin;

create index if not exists idx_bookings_owner_intelligence_range
  on public.bookings (date, court_id, status, payment_status);

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
  account_role text;
  local_today date := timezone('Asia/Manila', clock_timestamp())::date;
  earliest_reliable_date date;
  range_start date;
  range_end date;
  open_hour integer := 6;
  close_hour integer := 22;
  trend_grain text;
  trend_step interval;
  result jsonb;
begin
  account_role := public.current_account_role();
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can view Owner Intelligence.'
      using errcode = '42501';
  end if;

  select min(b.date)
    into earliest_reliable_date
    from public.bookings b
   where lower(coalesce(b.created_via, 'customer')) <> 'import'
     and upper(coalesce(b.ref, '')) not like 'MANUAL-%'
     and lower(coalesce(b.payment_method, '')) <> 'manual'
     and lower(coalesce(b.email, '')) <> 'reserve@hold.internal'
     and b.date <= local_today;

  range_end := least(coalesce(p_to, local_today), local_today);
  range_start := coalesce(p_from, earliest_reliable_date, range_end);

  if range_start > range_end then
    raise exception 'The Insights start date must not be after the end date.'
      using errcode = '22007';
  end if;
  if range_end - range_start > 3650 then
    raise exception 'Insights ranges are limited to ten years.'
      using errcode = '22023';
  end if;
  if p_court_id is not null and not exists (
    select 1 from public.courts c where c.id = p_court_id
  ) then
    raise exception 'The selected court does not exist.'
      using errcode = '22023';
  end if;

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

  if range_end - range_start > 180 then
    trend_grain := 'month';
    trend_step := interval '1 month';
  elsif range_end - range_start > 60 then
    trend_grain := 'week';
    trend_step := interval '1 week';
  else
    trend_grain := 'day';
    trend_step := interval '1 day';
  end if;

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
      coalesce(nullif(b.court_name, ''), c.name, b.court_id, 'Unknown Court') as court_name,
      b.date,
      coalesce(b.slots, '{}'::text[]) as slots,
      b.start_time,
      greatest(
        coalesce(nullif(b.duration, 0), cardinality(coalesce(b.slots, '{}'::text[]))::numeric, 0),
        0
      )::numeric as duration,
      greatest(coalesce(b.total, 0), 0)::numeric as total,
      lower(coalesce(b.status, 'pending')) as status,
      lower(coalesce(b.payment_status, 'unpaid')) as payment_status,
      greatest(coalesce(b.downpayment, 0), 0)::numeric as downpayment,
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
      case
        when nullif(lower(btrim(coalesce(b.email, ''))), '') is not null
          then md5('email:' || lower(btrim(b.email)))
        when nullif(regexp_replace(coalesce(b.contact_number, ''), '[^0-9]', '', 'g'), '') is not null
          then md5('phone:' || regexp_replace(b.contact_number, '[^0-9]', '', 'g'))
        else md5('reservation:' || case
          when nullif(btrim(b.booking_group_ref), '') is not null then btrim(b.booking_group_ref)
          else b.ref
        end)
      end as customer_key,
      b.created_at,
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
    left join public.courts c on c.id = b.court_id
    where b.date between range_start and range_end
      and lower(coalesce(b.created_via, 'customer')) <> 'import'
      and upper(coalesce(b.ref, '')) not like 'MANUAL-%'
      and lower(coalesce(b.payment_method, '')) <> 'manual'
      and lower(coalesce(b.email, '')) <> 'reserve@hold.internal'
      and (p_court_id is null or b.court_id = p_court_id)
  ),
  booking_rows as materialized (
    select r.*
    from raw_rows r
    where r.logical_row_number = 1
  ),
  reservation_rollup as materialized (
    select
      b.reservation_key,
      min(b.customer_key) as customer_key,
      case
        when bool_or(b.status = 'completed') then 'completed'
        when bool_or(b.status = 'confirmed') then 'confirmed'
        when bool_or(b.status = 'verifying') then 'verifying'
        when bool_or(b.status = 'pending') then 'pending'
        when bool_or(b.status = 'forfeited') then 'forfeited'
        else 'cancelled'
      end as lifecycle_status,
      sum(case
        when b.status in ('confirmed', 'completed') then b.total
        when b.status = 'forfeited' and b.payment_status = 'deposit_retained' then b.paid_amount
        else 0
      end)::numeric as gross_revenue,
      sum(case
        when b.status in ('confirmed', 'completed', 'forfeited') then b.paid_amount
        else 0
      end)::numeric as collected_revenue,
      sum(case
        when b.status in ('confirmed', 'completed') then greatest(b.total - b.paid_amount, 0)
        else 0
      end)::numeric as outstanding_balance,
      sum(case when b.status in ('confirmed', 'completed') then b.duration else 0 end)::numeric as booked_hours
    from booking_rows b
    group by b.reservation_key
  ),
  customer_activity as (
    select
      r.customer_key,
      count(*) filter (where r.lifecycle_status in ('confirmed', 'completed'))::integer as reservations
    from reservation_rollup r
    group by r.customer_key
  ),
  calendar_days as materialized (
    select d::date as day
    from generate_series(range_start::timestamp, range_end::timestamp, interval '1 day') d
  ),
  court_days as materialized (
    select
      d.day,
      c.id as court_id,
      c.name as court_name,
      case
        when bd.date is not null then 0::numeric
        when d.day = local_today and c.blocked then 0::numeric
        else (close_hour - open_hour)::numeric
      end as available_hours
    from calendar_days d
    join public.courts c
      on timezone('Asia/Manila', c.created_at)::date <= d.day
     and (p_court_id is null or c.id = p_court_id)
    left join public.blocked_dates bd on bd.date = d.day
  ),
  operating_summary as (
    select
      coalesce(sum(cd.available_hours), 0)::numeric as available_hours,
      count(distinct cd.day) filter (where cd.available_hours > 0)::integer as operating_days
    from court_days cd
  ),
  lifecycle as (
    select
      x.status,
      coalesce(count(r.reservation_key) filter (where r.lifecycle_status = x.status), 0)::integer as count
    from (values
      ('confirmed', 1), ('completed', 2), ('pending', 3), ('verifying', 4),
      ('cancelled', 5), ('forfeited', 6)
    ) x(status, sort_order)
    left join reservation_rollup r on r.lifecycle_status = x.status
    group by x.status, x.sort_order
    order by x.sort_order
  ),
  bands as materialized (
    select
      h::integer as start_hour,
      least(h::integer + 3, close_hour) as end_hour
    from generate_series(open_hour, close_hour - 1, 3) h
  ),
  available_cells as materialized (
    select
      extract(isodow from cd.day)::integer as weekday,
      b.start_hour,
      b.end_hour,
      sum(case when cd.available_hours > 0 then b.end_hour - b.start_hour else 0 end)::numeric as available_hours,
      count(distinct cd.day) filter (where cd.available_hours > 0)::integer as comparable_days
    from court_days cd
    cross join bands b
    group by extract(isodow from cd.day), b.start_hour, b.end_hour
  ),
  parsed_booking_slots as materialized (
    select
      b.court_id,
      b.date,
      b.status,
      floor(slot_value::numeric)::integer as slot_hour,
      1::numeric as booked_hours
    from booking_rows b
    cross join lateral unnest(b.slots) slot_value
    where b.status in ('confirmed', 'completed')
      and slot_value ~ '^\d{1,2}(\.\d+)?$'

    union all

    select
      b.court_id,
      b.date,
      b.status,
      case
        when coalesce(b.start_time, '') ~* '(AM|PM)'
          then mod(substring(b.start_time from '^\s*(\d{1,2})')::integer, 12)
            + case when b.start_time ~* 'PM' then 12 else 0 end
        when coalesce(b.start_time, '') ~ '^\s*\d{1,2}'
          then least(substring(b.start_time from '^\s*(\d{1,2})')::integer, 23)
        else open_hour
      end as slot_hour,
      greatest(b.duration, 0)::numeric as booked_hours
    from booking_rows b
    where b.status in ('confirmed', 'completed')
      and cardinality(b.slots) = 0
  ),
  booked_cells as (
    select
      extract(isodow from s.date)::integer as weekday,
      b.start_hour,
      b.end_hour,
      sum(s.booked_hours)::numeric as booked_hours
    from parsed_booking_slots s
    join bands b on s.slot_hour >= b.start_hour and s.slot_hour < b.end_hour
    group by extract(isodow from s.date), b.start_hour, b.end_hour
  ),
  heatmap as (
    select
      w.weekday,
      case w.weekday
        when 1 then 'Mon' when 2 then 'Tue' when 3 then 'Wed' when 4 then 'Thu'
        when 5 then 'Fri' when 6 then 'Sat' else 'Sun'
      end as weekday_label,
      b.start_hour,
      b.end_hour,
      coalesce(bc.booked_hours, 0)::numeric as booked_hours,
      coalesce(ac.available_hours, 0)::numeric as available_hours,
      coalesce(ac.comparable_days, 0)::integer as comparable_days,
      case
        when coalesce(ac.available_hours, 0) <= 0 then 0
        else round(least(100, coalesce(bc.booked_hours, 0) * 100 / ac.available_hours), 1)
      end as utilization_pct
    from generate_series(1, 7) w(weekday)
    cross join bands b
    left join available_cells ac
      on ac.weekday = w.weekday and ac.start_hour = b.start_hour
    left join booked_cells bc
      on bc.weekday = w.weekday and bc.start_hour = b.start_hour
  ),
  trend_periods as materialized (
    select bucket::date as bucket
    from generate_series(
      date_trunc(trend_grain, range_start::timestamp),
      date_trunc(trend_grain, range_end::timestamp),
      trend_step
    ) bucket
  ),
  trend_values as (
    select
      date_trunc(trend_grain, b.date::timestamp)::date as bucket,
      count(distinct b.reservation_key) filter (where b.status in ('confirmed', 'completed'))::integer as reservations,
      coalesce(sum(b.duration) filter (where b.status in ('confirmed', 'completed')), 0)::numeric as booked_hours,
      coalesce(sum(case
        when b.status in ('confirmed', 'completed', 'forfeited') then b.paid_amount
        else 0
      end), 0)::numeric as collected_revenue
    from booking_rows b
    group by date_trunc(trend_grain, b.date::timestamp)
  ),
  court_performance as (
    select
      c.id as court_id,
      c.name as court_name,
      coalesce(sum(b.duration) filter (where b.status in ('confirmed', 'completed')), 0)::numeric as booked_hours,
      coalesce(sum(case
        when b.status in ('confirmed', 'completed') then b.total
        when b.status = 'forfeited' and b.payment_status = 'deposit_retained' then b.paid_amount
        else 0
      end), 0)::numeric as gross_revenue,
      coalesce(sum(case
        when b.status in ('confirmed', 'completed', 'forfeited') then b.paid_amount
        else 0
      end), 0)::numeric as collected_revenue,
      coalesce((select sum(cd.available_hours) from court_days cd where cd.court_id = c.id), 0)::numeric as available_hours
    from public.courts c
    left join booking_rows b on b.court_id = c.id
    where timezone('Asia/Manila', c.created_at)::date <= range_end
      and (p_court_id is null or c.id = p_court_id)
    group by c.id, c.name
  ),
  excluded_counts as (
    select
      count(*) filter (
        where lower(coalesce(b.created_via, 'customer')) = 'import'
           or upper(coalesce(b.ref, '')) like 'MANUAL-%'
           or lower(coalesce(b.payment_method, '')) = 'manual'
      )::integer as import_rows,
      count(*) filter (where lower(coalesce(b.email, '')) = 'reserve@hold.internal')::integer as placeholder_rows
    from public.bookings b
    where b.date between range_start and range_end
      and (p_court_id is null or b.court_id = p_court_id)
  )
  select jsonb_build_object(
    'period', jsonb_build_object(
      'from', range_start,
      'to', range_end,
      'earliest_reliable_booking_date', earliest_reliable_date,
      'generated_at', clock_timestamp(),
      'days_analyzed', range_end - range_start + 1,
      'operating_days', os.operating_days,
      'trend_grain', trend_grain
    ),
    'settings', jsonb_build_object(
      'open_hour', open_hour,
      'close_hour', close_hour,
      'court_id', p_court_id
    ),
    'kpis', jsonb_build_object(
      'gross_revenue', coalesce(sum(r.gross_revenue), 0),
      'collected_revenue', coalesce(sum(r.collected_revenue), 0),
      'outstanding_balance', coalesce(sum(r.outstanding_balance), 0),
      'booked_hours', coalesce(sum(r.booked_hours), 0),
      'available_hours', os.available_hours,
      'utilization_pct', case
        when os.available_hours <= 0 then 0
        else round(least(100, coalesce(sum(r.booked_hours), 0) * 100 / os.available_hours), 1)
      end,
      'completed_reservations', count(*) filter (where r.lifecycle_status = 'completed'),
      'active_reservations', count(*) filter (where r.lifecycle_status in ('confirmed', 'completed')),
      'total_reservations', count(*),
      'revenue_per_booked_hour', case
        when coalesce(sum(r.booked_hours), 0) <= 0 then 0
        else round(coalesce(sum(r.collected_revenue), 0) / sum(r.booked_hours), 2)
      end,
      'revenue_per_available_hour', case
        when os.available_hours <= 0 then 0
        else round(coalesce(sum(r.collected_revenue), 0) / os.available_hours, 2)
      end,
      'cancellation_rate', case
        when count(*) <= 0 then 0
        else round(count(*) filter (where r.lifecycle_status in ('cancelled', 'forfeited')) * 100.0 / count(*), 1)
      end,
      'repeat_customer_rate', coalesce((
        select round(count(*) filter (where ca.reservations > 1) * 100.0 / nullif(count(*), 0), 1)
        from customer_activity ca
        where ca.reservations > 0
      ), 0)
    ),
    'lifecycle', coalesce((
      select jsonb_agg(jsonb_build_object('status', l.status, 'count', l.count) order by
        case l.status when 'confirmed' then 1 when 'completed' then 2 when 'pending' then 3
          when 'verifying' then 4 when 'cancelled' then 5 else 6 end)
      from lifecycle l
    ), '[]'::jsonb),
    'trend', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', tp.bucket,
        'reservations', coalesce(tv.reservations, 0),
        'booked_hours', coalesce(tv.booked_hours, 0),
        'collected_revenue', coalesce(tv.collected_revenue, 0)
      ) order by tp.bucket)
      from trend_periods tp
      left join trend_values tv on tv.bucket = tp.bucket
    ), '[]'::jsonb),
    'heatmap', coalesce((
      select jsonb_agg(jsonb_build_object(
        'weekday', h.weekday,
        'weekday_label', h.weekday_label,
        'start_hour', h.start_hour,
        'end_hour', h.end_hour,
        'booked_hours', h.booked_hours,
        'available_hours', h.available_hours,
        'comparable_days', h.comparable_days,
        'utilization_pct', h.utilization_pct
      ) order by h.start_hour, h.weekday)
      from heatmap h
    ), '[]'::jsonb),
    'courts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'court_id', cp.court_id,
        'court_name', cp.court_name,
        'booked_hours', cp.booked_hours,
        'available_hours', cp.available_hours,
        'utilization_pct', case
          when cp.available_hours <= 0 then 0
          else round(least(100, cp.booked_hours * 100 / cp.available_hours), 1)
        end,
        'gross_revenue', cp.gross_revenue,
        'collected_revenue', cp.collected_revenue
      ) order by cp.collected_revenue desc, cp.court_name)
      from court_performance cp
    ), '[]'::jsonb),
    'data_quality', jsonb_build_object(
      'reliable_booking_rows', (select count(*) from booking_rows),
      'excluded_import_rows', ec.import_rows,
      'excluded_placeholder_rows', ec.placeholder_rows,
      'historical_capacity_exact', false,
      'capacity_basis', 'operating hours, court creation dates, saved venue block dates, and current-day court state',
      'capacity_note', 'Historical court maintenance changes were not previously stored, so past capacity is an estimate. Booking, payment, and lifecycle totals are exact from stored reliable rows.'
    )
  )
    into result
    from reservation_rollup r
    cross join operating_summary os
    cross join excluded_counts ec
   group by os.available_hours, os.operating_days, ec.import_rows, ec.placeholder_rows;

  if result is null then
    result := jsonb_build_object(
      'period', jsonb_build_object(
        'from', range_start, 'to', range_end,
        'earliest_reliable_booking_date', earliest_reliable_date,
        'generated_at', clock_timestamp(), 'days_analyzed', range_end - range_start + 1,
        'operating_days', 0, 'trend_grain', trend_grain
      ),
      'settings', jsonb_build_object('open_hour', open_hour, 'close_hour', close_hour, 'court_id', p_court_id),
      'kpis', jsonb_build_object(
        'gross_revenue', 0, 'collected_revenue', 0, 'outstanding_balance', 0,
        'booked_hours', 0, 'available_hours', 0, 'utilization_pct', 0,
        'completed_reservations', 0, 'active_reservations', 0, 'total_reservations', 0,
        'revenue_per_booked_hour', 0, 'revenue_per_available_hour', 0,
        'cancellation_rate', 0, 'repeat_customer_rate', 0
      ),
      'lifecycle', '[]'::jsonb, 'trend', '[]'::jsonb, 'heatmap', '[]'::jsonb,
      'courts', '[]'::jsonb,
      'data_quality', jsonb_build_object(
        'reliable_booking_rows', 0, 'excluded_import_rows', 0, 'excluded_placeholder_rows', 0,
        'historical_capacity_exact', false,
        'capacity_note', 'No reliable online bookings exist in the selected period.'
      )
    );
  end if;

  return result;
end;
$$;

comment on function public.get_owner_intelligence(date, date, text) is
  'Returns PII-free historical venue performance aggregates for active system owners and court owners.';

revoke all on function public.get_owner_intelligence(date, date, text) from public;
revoke execute on function public.get_owner_intelligence(date, date, text) from anon;
grant execute on function public.get_owner_intelligence(date, date, text) to authenticated;

commit;
