begin;

-- Extend the already-narrow public board projection with only the latest
-- completed result. The player view uses this event to play a winner reveal
-- after a new result count arrives; no player IDs or private session data are
-- exposed.
create or replace function public.get_public_open_play_game_live_board(
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
  v_board jsonb;
  v_result_count integer := 0;
  v_latest_game jsonb := null;
  v_latest_round_no integer := null;
  v_latest_court_position bigint := null;
  v_latest_result jsonb := null;
  v_team_one jsonb := '[]'::jsonb;
  v_team_two jsonb := '[]'::jsonb;
  v_court_name text;
  v_result_at text;
  v_winner text;
begin
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

  v_board := public.get_public_open_play_game_live_board_v1(p_share_token);
  if v_board is null then
    return null;
  end if;

  with game_events as (
    select round.round_no,
           round.created_at,
           game.position as court_position,
           0::bigint as event_position,
           game.value as game
      from public.open_play_game_rounds round
      cross join lateral jsonb_array_elements(
        coalesce(round.assignments, '[]'::jsonb)
      ) with ordinality as game(value, position)
     where round.session_id = v_session_id
    union all
    select round.round_no,
           round.created_at,
           current_game.position as court_position,
           completed.position as event_position,
           completed.value as game
      from public.open_play_game_rounds round
      cross join lateral jsonb_array_elements(
        coalesce(round.assignments, '[]'::jsonb)
      ) with ordinality as current_game(value, position)
      cross join lateral jsonb_array_elements(
        case
          when jsonb_typeof(current_game.value -> 'completedGames') = 'array'
            then current_game.value -> 'completedGames'
          else '[]'::jsonb
        end
      ) with ordinality as completed(value, position)
     where round.session_id = v_session_id
  )
  select count(*)::integer
    into v_result_count
    from game_events event
   where event.game ->> 'winner' in ('A', 'B');

  with game_events as (
    select round.round_no,
           round.created_at,
           game.position as court_position,
           0::bigint as event_position,
           game.value as game
      from public.open_play_game_rounds round
      cross join lateral jsonb_array_elements(
        coalesce(round.assignments, '[]'::jsonb)
      ) with ordinality as game(value, position)
     where round.session_id = v_session_id
    union all
    select round.round_no,
           round.created_at,
           current_game.position as court_position,
           completed.position as event_position,
           completed.value as game
      from public.open_play_game_rounds round
      cross join lateral jsonb_array_elements(
        coalesce(round.assignments, '[]'::jsonb)
      ) with ordinality as current_game(value, position)
      cross join lateral jsonb_array_elements(
        case
          when jsonb_typeof(current_game.value -> 'completedGames') = 'array'
            then current_game.value -> 'completedGames'
          else '[]'::jsonb
        end
      ) with ordinality as completed(value, position)
     where round.session_id = v_session_id
  )
  select event.game,
         event.round_no,
         event.court_position
    into v_latest_game,
         v_latest_round_no,
         v_latest_court_position
    from game_events event
   where event.game ->> 'winner' in ('A', 'B')
   order by coalesce(
              nullif(event.game ->> 'resultAt', ''),
              to_char(event.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            ) desc,
            event.round_no desc,
            event.court_position desc,
            event.event_position desc
   limit 1;

  if v_latest_game is not null then
    select coalesce(
      jsonb_agg(to_jsonb(player.full_name) order by member.position),
      '[]'::jsonb
    )
      into v_team_one
      from jsonb_array_elements_text(
        coalesce(v_latest_game -> 'teamA', '[]'::jsonb)
      ) with ordinality as member(player_id, position)
      join public.open_play_game_players player
        on player.id::text = member.player_id
       and player.session_id = v_session_id;

    select coalesce(
      jsonb_agg(to_jsonb(player.full_name) order by member.position),
      '[]'::jsonb
    )
      into v_team_two
      from jsonb_array_elements_text(
        coalesce(v_latest_game -> 'teamB', '[]'::jsonb)
      ) with ordinality as member(player_id, position)
      join public.open_play_game_players player
        on player.id::text = member.player_id
       and player.session_id = v_session_id;

    v_court_name := coalesce(
      nullif(v_latest_game ->> 'courtName', ''),
      'Court ' || v_latest_court_position::text
    );
    v_result_at := nullif(v_latest_game ->> 'resultAt', '');
    v_winner := nullif(v_latest_game ->> 'winner', '');
    v_latest_result := jsonb_build_object(
      'eventId', concat_ws(
        ':',
        v_latest_round_no::text,
        v_court_name,
        coalesce(v_result_at, ''),
        v_winner
      ),
      'roundNo', v_latest_round_no,
      'courtIndex', greatest(v_latest_court_position - 1, 0),
      'courtName', v_court_name,
      'team1', v_team_one,
      'team2', v_team_two,
      'winner', v_winner,
      'resultAt', v_result_at
    );
  end if;

  return v_board || jsonb_build_object(
    'resultCount', v_result_count,
    'latestResult', v_latest_result
  );
end;
$$;

revoke all on function public.get_public_open_play_game_live_board(text)
  from public;
grant execute on function public.get_public_open_play_game_live_board(text)
  to anon, authenticated, service_role;

commit;
