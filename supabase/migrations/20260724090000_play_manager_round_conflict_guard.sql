-- Prevent two operator screens from silently overwriting each other's
-- Play Manager court results or queue changes.

begin;

create or replace function public.update_open_play_game_round_if_current(
  p_round_id uuid,
  p_expected_assignments jsonb,
  p_expected_queue_snapshot jsonb,
  p_assignments jsonb,
  p_queue_snapshot jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_round public.open_play_game_rounds%rowtype;
begin
  update public.open_play_game_rounds
     set assignments = coalesce(p_assignments, '[]'::jsonb),
         queue_snapshot = coalesce(p_queue_snapshot, '[]'::jsonb)
   where id = p_round_id
     and assignments = coalesce(p_expected_assignments, '[]'::jsonb)
     and queue_snapshot = coalesce(p_expected_queue_snapshot, '[]'::jsonb)
  returning * into v_round;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'PLAY_MANAGER_ROUND_CONFLICT';
  end if;

  return to_jsonb(v_round);
end;
$$;

revoke all on function public.update_open_play_game_round_if_current(uuid, jsonb, jsonb, jsonb, jsonb) from public;
revoke all on function public.update_open_play_game_round_if_current(uuid, jsonb, jsonb, jsonb, jsonb) from anon;
grant execute on function public.update_open_play_game_round_if_current(uuid, jsonb, jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.update_open_play_game_round_if_current(uuid, jsonb, jsonb, jsonb, jsonb) to service_role;

commit;
