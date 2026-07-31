-- Persist the moment each active player most recently entered the waiting
-- queue. Queue reordering keeps the timestamp; entering a court clears it.

begin;

alter table public.open_play_game_players
  add column if not exists queue_entered_at timestamptz;

comment on column public.open_play_game_players.queue_entered_at is
  'When the player most recently entered the active waiting queue; null while on court or inactive.';

create or replace function public.sync_open_play_game_queue_wait_times(
  p_session_id uuid,
  p_queue_player_ids uuid[]
)
returns setof public.open_play_game_players
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_queue_ids uuid[] := coalesce(p_queue_player_ids, array[]::uuid[]);
begin
  select session.status
    into v_status
    from public.open_play_game_sessions session
   where session.id = p_session_id
   for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'PLAY_MANAGER_SESSION_NOT_FOUND';
  end if;

  if v_status <> 'active' then
    raise exception using
      errcode = '55000',
      message = 'PLAY_MANAGER_SESSION_NOT_ACTIVE';
  end if;

  update public.open_play_game_players player
     set queue_entered_at = case
       when player.status = 'active' and player.id = any(v_queue_ids)
         then coalesce(player.queue_entered_at, clock_timestamp())
       else null
     end
   where player.session_id = p_session_id
     and player.queue_entered_at is distinct from case
       when player.status = 'active' and player.id = any(v_queue_ids)
         then coalesce(player.queue_entered_at, clock_timestamp())
       else null
     end;

  return query
    select player.*
      from public.open_play_game_players player
     where player.session_id = p_session_id
     order by player.seed_order, player.created_at, player.id;
end;
$$;

revoke all on function public.sync_open_play_game_queue_wait_times(uuid, uuid[])
  from public;
revoke all on function public.sync_open_play_game_queue_wait_times(uuid, uuid[])
  from anon;
grant execute on function public.sync_open_play_game_queue_wait_times(uuid, uuid[])
  to authenticated;
grant execute on function public.sync_open_play_game_queue_wait_times(uuid, uuid[])
  to service_role;

-- Existing active queues begin timing from this migration. Their earlier
-- waiting duration cannot be reconstructed reliably from legacy snapshots.
with current_rounds as (
  select round.*
    from public.open_play_game_rounds round
    join public.open_play_game_sessions session
      on session.id = round.session_id
     and session.status = 'active'
     and session.current_round = round.round_no
),
active_assignments as (
  select round.session_id, ids.player_id::uuid as player_id
    from current_rounds round
    cross join lateral jsonb_array_elements(round.assignments) as game(value)
    cross join lateral jsonb_array_elements_text(
      coalesce(game.value -> 'teamA', '[]'::jsonb)
    ) as ids(player_id)
   where nullif(game.value ->> 'winner', '') is null
  union
  select round.session_id, ids.player_id::uuid as player_id
    from current_rounds round
    cross join lateral jsonb_array_elements(round.assignments) as game(value)
    cross join lateral jsonb_array_elements_text(
      coalesce(game.value -> 'teamB', '[]'::jsonb)
    ) as ids(player_id)
   where nullif(game.value ->> 'winner', '') is null
)
update public.open_play_game_players player
   set queue_entered_at = clock_timestamp()
 where player.status = 'active'
   and exists (
     select 1
       from current_rounds round
      where round.session_id = player.session_id
   )
   and not exists (
     select 1
       from active_assignments assigned
      where assigned.session_id = player.session_id
        and assigned.player_id = player.id
   )
   and player.queue_entered_at is null;

notify pgrst, 'reload schema';

commit;
