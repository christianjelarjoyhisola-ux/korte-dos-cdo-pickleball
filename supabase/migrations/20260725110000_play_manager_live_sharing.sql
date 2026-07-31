-- Revocable, token-gated player view for the Open Play Game Manager.
-- Share secrets are stored only as hashes and the public RPC returns a
-- deliberately narrow, name-only snapshot instead of exposing game tables.

begin;

create table if not exists public.open_play_game_session_shares (
  session_id  uuid primary key
    references public.open_play_game_sessions(id) on delete cascade,
  token_hash  bytea not null unique
    check (octet_length(token_hash) = 32),
  created_at  timestamptz not null default now(),
  rotated_at  timestamptz not null default now()
);

alter table public.open_play_game_session_shares enable row level security;

-- This table intentionally has no RLS policies. Only the two SECURITY DEFINER
-- functions below may manage or read the hashes.
revoke all on table public.open_play_game_session_shares
  from public, anon, authenticated;

drop function if exists public.set_open_play_game_public_share(uuid, boolean);

create function public.set_open_play_game_public_share(
  p_session_id uuid,
  p_enabled boolean
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token text;
begin
  if auth.uid() is null or not exists (
    select 1
      from public.accounts account
     where account.id = auth.uid()
       and account.status = 'active'
       and account.role in ('owner', 'court_owner', 'staff')
  ) then
    raise exception using
      errcode = '42501',
      message = 'PLAY_MANAGER_SHARE_NOT_ALLOWED';
  end if;

  if p_session_id is null or not exists (
    select 1
      from public.open_play_game_sessions session
     where session.id = p_session_id
  ) then
    raise exception using
      errcode = 'P0002',
      message = 'PLAY_MANAGER_SESSION_NOT_FOUND';
  end if;

  if not coalesce(p_enabled, false) then
    delete from public.open_play_game_session_shares
     where session_id = p_session_id;
    return null;
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.open_play_game_session_shares (
    session_id,
    token_hash,
    created_at,
    rotated_at
  )
  values (
    p_session_id,
    extensions.digest(v_token, 'sha256'),
    now(),
    now()
  )
  on conflict (session_id) do update
    set token_hash = excluded.token_hash,
        rotated_at = excluded.rotated_at;

  return v_token;
end;
$$;

revoke all on function public.set_open_play_game_public_share(uuid, boolean)
  from public, anon;
grant execute on function public.set_open_play_game_public_share(uuid, boolean)
  to authenticated, service_role;

drop function if exists public.get_public_open_play_game_live_board(text);

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
  v_session public.open_play_game_sessions%rowtype;
  v_latest_round public.open_play_game_rounds%rowtype;
  v_game_entry record;
  v_team_one jsonb;
  v_team_two jsonb;
  v_players jsonb := '[]'::jsonb;
  v_assignments jsonb := '[]'::jsonb;
  v_queue jsonb := '[]'::jsonb;
  v_standings jsonb := '[]'::jsonb;
  v_latest_snapshot jsonb := null;
begin
  -- Invalid, revoked, expired, and unknown links intentionally return the
  -- same null response.
  if p_share_token is null
     or char_length(p_share_token) <> 64
     or p_share_token !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  select session.*
    into v_session
    from public.open_play_game_session_shares share
    join public.open_play_game_sessions session
      on session.id = share.session_id
   where share.token_hash = extensions.digest(p_share_token, 'sha256')
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

  select round.*
    into v_latest_round
    from public.open_play_game_rounds round
   where round.session_id = v_session.id
   order by round.round_no desc, round.created_at desc
   limit 1;

  select coalesce(
    jsonb_agg(to_jsonb(player.full_name) order by player.seed_order, player.created_at, player.id),
    '[]'::jsonb
  )
    into v_players
    from public.open_play_game_players player
   where player.session_id = v_session.id
     and player.status = 'active';

  if v_latest_round.id is not null then
    for v_game_entry in
      select game.value, game.position
        from jsonb_array_elements(
          coalesce(v_latest_round.assignments, '[]'::jsonb)
        ) with ordinality as game(value, position)
       order by game.position
    loop
      select coalesce(
        jsonb_agg(to_jsonb(player.full_name) order by member.position),
        '[]'::jsonb
      )
        into v_team_one
        from jsonb_array_elements_text(
          coalesce(v_game_entry.value -> 'teamA', '[]'::jsonb)
        ) with ordinality as member(player_id, position)
        join public.open_play_game_players player
          on player.id::text = member.player_id
         and player.session_id = v_session.id;

      select coalesce(
        jsonb_agg(to_jsonb(player.full_name) order by member.position),
        '[]'::jsonb
      )
        into v_team_two
        from jsonb_array_elements_text(
          coalesce(v_game_entry.value -> 'teamB', '[]'::jsonb)
        ) with ordinality as member(player_id, position)
        join public.open_play_game_players player
          on player.id::text = member.player_id
         and player.session_id = v_session.id;

      v_assignments := v_assignments || jsonb_build_array(
        jsonb_build_object(
          'courtName', coalesce(
            nullif(v_game_entry.value ->> 'courtName', ''),
            'Court ' || v_game_entry.position::text
          ),
          'team1', v_team_one,
          'team2', v_team_two,
          'startedAt', nullif(v_game_entry.value ->> 'startedAt', ''),
          'winner', nullif(v_game_entry.value ->> 'winner', ''),
          'gameCount', 1 + case
            when jsonb_typeof(v_game_entry.value -> 'completedGames') = 'array'
              then jsonb_array_length(v_game_entry.value -> 'completedGames')
            else 0
          end
        )
      );
    end loop;

    -- Preserve the stored queue order, then append any active player who is
    -- no longer on a live court. Final-court players can therefore move to
    -- "Up Next" while slower courts are still playing.
    with live_assigned as (
      select distinct member.player_id
        from jsonb_array_elements(
          coalesce(v_latest_round.assignments, '[]'::jsonb)
        ) as game(value)
        cross join lateral jsonb_array_elements_text(
          coalesce(game.value -> 'teamA', '[]'::jsonb)
        ) as member(player_id)
       where nullif(game.value ->> 'winner', '') is null
      union
      select distinct member.player_id
        from jsonb_array_elements(
          coalesce(v_latest_round.assignments, '[]'::jsonb)
        ) as game(value)
        cross join lateral jsonb_array_elements_text(
          coalesce(game.value -> 'teamB', '[]'::jsonb)
        ) as member(player_id)
       where nullif(game.value ->> 'winner', '') is null
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
         and player.session_id = v_session.id
         and player.status = 'active'
       where not exists (
         select 1
           from live_assigned live
          where live.player_id = player.id::text
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
       where player.session_id = v_session.id
         and player.status = 'active'
         and not exists (
           select 1
             from live_assigned live
            where live.player_id = player.id::text
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

    v_latest_snapshot := jsonb_build_object(
      'roundNo', v_latest_round.round_no,
      'assignments', v_assignments,
      'queue', v_queue
    );
  end if;

  -- Aggregate the same game/win inputs the manager uses, while returning only
  -- the active players' names and totals.
  with game_events as (
    select game.value as game
      from public.open_play_game_rounds round
      cross join lateral jsonb_array_elements(
        coalesce(round.assignments, '[]'::jsonb)
      ) as game(value)
     where round.session_id = v_session.id
    union all
    select completed.value as game
      from public.open_play_game_rounds round
      cross join lateral jsonb_array_elements(
        coalesce(round.assignments, '[]'::jsonb)
      ) as current_game(value)
      cross join lateral jsonb_array_elements(
        case
          when jsonb_typeof(current_game.value -> 'completedGames') = 'array'
            then current_game.value -> 'completedGames'
          else '[]'::jsonb
        end
      ) as completed(value)
     where round.session_id = v_session.id
  ),
  appearances as (
    select member.player_id,
           'A'::text as team,
           nullif(event.game ->> 'winner', '') as winner
      from game_events event
      cross join lateral jsonb_array_elements_text(
        coalesce(event.game -> 'teamA', '[]'::jsonb)
      ) as member(player_id)
    union all
    select member.player_id,
           'B'::text as team,
           nullif(event.game ->> 'winner', '') as winner
      from game_events event
      cross join lateral jsonb_array_elements_text(
        coalesce(event.game -> 'teamB', '[]'::jsonb)
      ) as member(player_id)
  ),
  scores as (
    select appearance.player_id,
           count(*)::integer as games,
           count(*) filter (
             where appearance.winner = appearance.team
           )::integer as wins
      from appearances appearance
     group by appearance.player_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'name', player.full_name,
        'games', coalesce(score.games, 0),
        'wins', coalesce(score.wins, 0)
      )
      order by coalesce(score.wins, 0) desc,
               coalesce(score.games, 0),
               lower(player.full_name),
               player.seed_order
    ),
    '[]'::jsonb
  )
    into v_standings
    from public.open_play_game_players player
    left join scores score
      on score.player_id = player.id::text
   where player.session_id = v_session.id
     and player.status = 'active';

  return jsonb_build_object(
    'generatedAt', to_char(
      statement_timestamp() at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'session', jsonb_build_object(
      'date', v_session.date::text,
      'timeLabel', v_session.time_label,
      'courtNames', to_jsonb(v_session.court_names),
      'status', v_session.status,
      'currentRound', coalesce(v_latest_round.round_no, v_session.current_round)
    ),
    'players', v_players,
    'latestRound', v_latest_snapshot,
    'standings', v_standings
  );
end;
$$;

revoke all on function public.get_public_open_play_game_live_board(text)
  from public;
grant execute on function public.get_public_open_play_game_live_board(text)
  to anon, authenticated, service_role;

commit;
