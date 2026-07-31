-- Keep READY-court reservations private while removing those reserved players
-- from the public "Up Next" queue. The existing narrow board projection,
-- including latestResult, remains the source for every other public field.

begin;

-- Preserve the winner-reveal projection as a private implementation detail.
-- The new public wrapper below validates the bearer token independently and
-- replaces only latestRound.queue.
alter function public.get_public_open_play_game_live_board(text)
  rename to get_public_open_play_game_live_board_v2;

revoke all on function public.get_public_open_play_game_live_board_v2(text)
  from public, anon, authenticated, service_role;

create function public.get_public_open_play_game_live_board(
  p_share_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_session_id uuid;
  v_latest_round public.open_play_game_rounds%rowtype;
  v_board jsonb;
  v_queue jsonb := '[]'::jsonb;
begin
  -- Invalid, revoked, expired, and unknown links intentionally return the
  -- same null response.
  if p_share_token is null
     or char_length(p_share_token) <> 64
     or p_share_token !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  select share.session_id
    into v_session_id
    from public.open_play_game_session_shares share
    join public.open_play_game_sessions session
      on session.id = share.session_id
   where share.token_hash = extensions.digest(p_share_token, 'sha256')
     and share.expires_at > now()
     and (
       session.status in ('active', 'paused')
       or (
         session.status = 'completed'
         and session.updated_at >= now() - interval '24 hours'
       )
     )
   limit 1;

  if not found then
    return null;
  end if;

  v_board := public.get_public_open_play_game_live_board_v2(p_share_token);
  if v_board is null then
    return null;
  end if;

  select round.*
    into v_latest_round
    from public.open_play_game_rounds round
   where round.session_id = v_session_id
   order by round.round_no desc, round.created_at desc
   limit 1;

  if v_latest_round.id is not null
     and jsonb_typeof(v_board -> 'latestRound') = 'object' then
    -- A player is unavailable when either actively playing or privately
    -- reserved for a READY court. Build the queue from IDs, then project only
    -- names so duplicate player names cannot cause over-filtering.
    with unavailable as (
      select distinct member.player_id
        from jsonb_array_elements(
          coalesce(v_latest_round.assignments, '[]'::jsonb)
        ) as game(value)
        cross join lateral jsonb_array_elements_text(
          case
            when jsonb_typeof(game.value -> 'teamA') = 'array'
              then game.value -> 'teamA'
            else '[]'::jsonb
          end
        ) as member(player_id)
       where nullif(game.value ->> 'winner', '') is null
      union
      select distinct member.player_id
        from jsonb_array_elements(
          coalesce(v_latest_round.assignments, '[]'::jsonb)
        ) as game(value)
        cross join lateral jsonb_array_elements_text(
          case
            when jsonb_typeof(game.value -> 'teamB') = 'array'
              then game.value -> 'teamB'
            else '[]'::jsonb
          end
        ) as member(player_id)
       where nullif(game.value ->> 'winner', '') is null
      union
      select distinct member.player_id
        from jsonb_array_elements(
          coalesce(v_latest_round.assignments, '[]'::jsonb)
        ) as game(value)
        cross join lateral jsonb_array_elements_text(
          case
            when jsonb_typeof(game.value -> 'readyMatch' -> 'teamA') = 'array'
              then game.value -> 'readyMatch' -> 'teamA'
            else '[]'::jsonb
          end
        ) as member(player_id)
      union
      select distinct member.player_id
        from jsonb_array_elements(
          coalesce(v_latest_round.assignments, '[]'::jsonb)
        ) as game(value)
        cross join lateral jsonb_array_elements_text(
          case
            when jsonb_typeof(game.value -> 'readyMatch' -> 'teamB') = 'array'
              then game.value -> 'readyMatch' -> 'teamB'
            else '[]'::jsonb
          end
        ) as member(player_id)
    ),
    stored as (
      select player.id,
             player.full_name,
             min(queued.position) as position
        from jsonb_array_elements_text(
          coalesce(v_latest_round.queue_snapshot, '[]'::jsonb)
        ) with ordinality as queued(player_id, position)
        join public.open_play_game_players player
          on player.id::text = queued.player_id
         and player.session_id = v_session_id
         and player.status = 'active'
       where not exists (
         select 1
           from unavailable unavailable_player
          where unavailable_player.player_id = player.id::text
       )
       group by player.id, player.full_name
    ),
    ordered_queue as (
      select stored.full_name,
             0 as source_order,
             stored.position as position,
             stored.id
        from stored
      union all
      select player.full_name,
             1 as source_order,
             player.seed_order::bigint as position,
             player.id
        from public.open_play_game_players player
       where player.session_id = v_session_id
         and player.status = 'active'
         and not exists (
           select 1
             from unavailable unavailable_player
            where unavailable_player.player_id = player.id::text
         )
         and not exists (
           select 1
             from stored
            where stored.id = player.id
         )
    )
    select coalesce(
      jsonb_agg(
        to_jsonb(ordered_queue.full_name)
        order by ordered_queue.source_order,
                 ordered_queue.position,
                 lower(ordered_queue.full_name),
                 ordered_queue.id
      ),
      '[]'::jsonb
    )
      into v_queue
      from ordered_queue;

    v_board := jsonb_set(
      v_board,
      '{latestRound,queue}',
      v_queue,
      false
    );
  end if;

  return v_board;
end;
$$;

revoke all on function public.get_public_open_play_game_live_board(text)
  from public;
grant execute on function public.get_public_open_play_game_live_board(text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
