-- Production pgcrypto is installed in the extensions schema. The original
-- Demand Growth function qualified digest as public.digest, which is absent on
-- standard Supabase projects. Rewrite only that function definition in place.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $hotfix$
declare
  target_function regprocedure :=
    to_regprocedure('public.get_demand_growth_intelligence(date,date,text)');
  digest_function regprocedure :=
    to_regprocedure('extensions.digest(text,text)');
  function_definition text;
begin
  if target_function is null then
    raise exception 'Demand Growth intelligence function is missing; digest hotfix was not applied.';
  end if;
  if digest_function is null then
    raise exception 'Required pgcrypto function extensions.digest(text,text) is missing.';
  end if;

  function_definition := pg_get_functiondef(target_function);

  if function_definition like '%public.digest(%' then
    function_definition := replace(
      function_definition,
      'public.digest(',
      'extensions.digest('
    );
    execute function_definition;
  elsif function_definition not like '%extensions.digest(%' then
    raise exception 'Demand Growth digest reference is in an unexpected state; hotfix stopped safely.';
  end if;

  function_definition := pg_get_functiondef(target_function);
  if function_definition not like '%extensions.digest(%'
     or function_definition like '%public.digest(%' then
    raise exception 'Demand Growth digest hotfix verification failed.';
  end if;
end
$hotfix$;

-- CREATE OR REPLACE preserves the owner and existing ACL. Restate the narrow
-- intended grant so a drifted environment cannot gain public execution.
revoke all on function public.get_demand_growth_intelligence(date, date, text)
  from public, anon;
grant execute on function public.get_demand_growth_intelligence(date, date, text)
  to authenticated;

-- Ask PostgREST to refresh the stored function definition immediately after
-- this transaction commits.
notify pgrst, 'reload schema';

commit;
