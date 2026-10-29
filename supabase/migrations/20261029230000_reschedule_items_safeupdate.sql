-- Production rejects UPDATE without WHERE (safeupdate), which blocked the
-- internal rs_plan slot update in reschedule_booking_items. Add "where true".
-- Applied to production via the SQL editor on 2026-10-29.
do $fix$
declare d text; n text;
begin
  select pg_get_functiondef('public.reschedule_booking_items(jsonb)'::regprocedure) into d;
  if position('where true;' in d) > 0 then return; end if;
  n := replace(d, 'plan.start_hour + plan.hours - 1) h);', 'plan.start_hour + plan.hours - 1) h)' || chr(10) || '   where true;');
  if n = d then raise exception 'fix target not found'; end if;
  execute n;
end
$fix$;
