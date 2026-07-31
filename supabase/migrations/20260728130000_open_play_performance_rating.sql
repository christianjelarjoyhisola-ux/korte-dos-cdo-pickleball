-- Session-only Individual Performance Rating for rotating-doubles Open Play.
-- Ratings are event-sourced from completed 2v2 results. Only the frozen
-- algorithm inputs and each player's starting rating are persisted.

begin;

alter table public.open_play_game_sessions
  add column if not exists performance_rating_version text
    not null default 'pr-performance-v1',
  add column if not exists performance_rating_k smallint
    not null default 24,
  add column if not exists performance_rating_scale smallint
    not null default 400,
  add column if not exists performance_rating_min_games smallint
    not null default 3;

alter table public.open_play_game_sessions
  drop constraint if exists open_play_game_sessions_performance_rating_version_check,
  drop constraint if exists open_play_game_sessions_performance_rating_k_check,
  drop constraint if exists open_play_game_sessions_performance_rating_scale_check,
  drop constraint if exists open_play_game_sessions_performance_rating_min_games_check;

alter table public.open_play_game_sessions
  add constraint open_play_game_sessions_performance_rating_version_check
    check (performance_rating_version = 'pr-performance-v1'),
  add constraint open_play_game_sessions_performance_rating_k_check
    check (performance_rating_k = 24),
  add constraint open_play_game_sessions_performance_rating_scale_check
    check (performance_rating_scale = 400),
  add constraint open_play_game_sessions_performance_rating_min_games_check
    check (performance_rating_min_games = 3);

alter table public.open_play_game_players
  add column if not exists performance_seed_rating numeric(8, 1);

-- Backfill historical sessions too. Their normal mutation guard intentionally
-- blocks completed/cancelled rows, so suspend only that guard for this migration.
alter table public.open_play_game_players
  disable trigger trg_guard_open_play_game_player_mutation;

update public.open_play_game_players
   set performance_seed_rating =
     1000 + (coalesce(skill_level, 1)::integer - 1) * 100
 where performance_seed_rating is null;

alter table public.open_play_game_players
  enable trigger trg_guard_open_play_game_player_mutation;

alter table public.open_play_game_players
  alter column performance_seed_rating set not null,
  alter column performance_seed_rating set default 1000;

alter table public.open_play_game_players
  drop constraint if exists open_play_game_players_performance_seed_rating_check;

alter table public.open_play_game_players
  add constraint open_play_game_players_performance_seed_rating_check
    check (performance_seed_rating between 100 and 4000);

comment on column public.open_play_game_sessions.performance_rating_version is
  'Frozen session-only Individual Performance Rating algorithm version.';
comment on column public.open_play_game_players.performance_seed_rating is
  'Starting session rating, frozen after this player records a completed match.';

create or replace function public.guard_open_play_performance_player_seed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_has_completed_match boolean := false;
begin
  if tg_op = 'INSERT' then
    new.performance_seed_rating :=
      1000 + (coalesce(new.skill_level, 1)::integer - 1) * 100;
    return new;
  end if;

  if new.performance_seed_rating is distinct from old.performance_seed_rating then
    raise exception using
      errcode = '55000',
      message = 'PLAY_MANAGER_PERFORMANCE_SEED_IMMUTABLE';
  end if;

  if new.skill_level is distinct from old.skill_level then
    with game_events as (
      select game.value as event
        from public.open_play_game_rounds round
        cross join lateral jsonb_array_elements(
          coalesce(round.assignments, '[]'::jsonb)
        ) as game(value)
       where round.session_id = old.session_id
      union all
      select completed.value as event
        from public.open_play_game_rounds round
        cross join lateral jsonb_array_elements(
          coalesce(round.assignments, '[]'::jsonb)
        ) as game(value)
        cross join lateral jsonb_array_elements(
          case
            when jsonb_typeof(game.value -> 'completedGames') = 'array'
              then game.value -> 'completedGames'
            else '[]'::jsonb
          end
        ) as completed(value)
       where round.session_id = old.session_id
    )
    select exists (
      select 1
        from game_events
       where event ->> 'winner' in ('A', 'B')
         and (
           coalesce(event -> 'teamA', '[]'::jsonb) ? old.id::text
           or coalesce(event -> 'teamB', '[]'::jsonb) ? old.id::text
         )
    )
      into v_has_completed_match;

    if not v_has_completed_match then
      new.performance_seed_rating :=
        1000 + (coalesce(new.skill_level, 1)::integer - 1) * 100;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_open_play_performance_player_seed
  on public.open_play_game_players;
create trigger trg_open_play_performance_player_seed
before insert or update of skill_level, performance_seed_rating
on public.open_play_game_players
for each row execute function public.guard_open_play_performance_player_seed();

create or replace function public.guard_open_play_performance_session_config()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if row(
    new.performance_rating_version,
    new.performance_rating_k,
    new.performance_rating_scale,
    new.performance_rating_min_games
  ) is distinct from row(
    old.performance_rating_version,
    old.performance_rating_k,
    old.performance_rating_scale,
    old.performance_rating_min_games
  ) and exists (
    select 1
      from public.open_play_game_rounds round
     where round.session_id = old.id
  ) then
    raise exception using
      errcode = '55000',
      message = 'PLAY_MANAGER_PERFORMANCE_CONFIG_IMMUTABLE';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_open_play_performance_session_config
  on public.open_play_game_sessions;
create trigger trg_open_play_performance_session_config
before update of
  performance_rating_version,
  performance_rating_k,
  performance_rating_scale,
  performance_rating_min_games
on public.open_play_game_sessions
for each row execute function public.guard_open_play_performance_session_config();

create or replace function public.calculate_open_play_performance_standings(
  p_session_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.open_play_game_sessions%rowtype;
  v_player record;
  v_event record;
  v_ratings jsonb := '{}'::jsonb;
  v_games jsonb := '{}'::jsonb;
  v_wins jsonb := '{}'::jsonb;
  v_opponent_totals jsonb := '{}'::jsonb;
  v_best_upsets jsonb := '{}'::jsonb;
  v_a1 text;
  v_a2 text;
  v_b1 text;
  v_b2 text;
  v_team_a_rating numeric;
  v_team_b_rating numeric;
  v_winner_rating numeric;
  v_loser_rating numeric;
  v_expected numeric;
  v_gain numeric;
  v_upset numeric;
  v_winner_ids text[];
  v_loser_ids text[];
  v_id text;
  v_rows jsonb := '[]'::jsonb;
begin
  select session.*
    into v_session
    from public.open_play_game_sessions session
   where session.id = p_session_id;

  if not found then
    return '[]'::jsonb;
  end if;

  for v_player in
    select player.id, player.performance_seed_rating
      from public.open_play_game_players player
     where player.session_id = p_session_id
  loop
    v_ratings := jsonb_set(
      v_ratings,
      array[v_player.id::text],
      to_jsonb(v_player.performance_seed_rating),
      true
    );
    v_games := jsonb_set(v_games, array[v_player.id::text], '0'::jsonb, true);
    v_wins := jsonb_set(v_wins, array[v_player.id::text], '0'::jsonb, true);
    v_opponent_totals := jsonb_set(
      v_opponent_totals,
      array[v_player.id::text],
      '0'::jsonb,
      true
    );
    v_best_upsets := jsonb_set(
      v_best_upsets,
      array[v_player.id::text],
      '0'::jsonb,
      true
    );
  end loop;

  for v_event in
    with game_events as (
      select round.round_no,
             game.position::integer - 1 as court_index,
             2147483647 as event_index,
             game.value as event
        from public.open_play_game_rounds round
        cross join lateral jsonb_array_elements(
          coalesce(round.assignments, '[]'::jsonb)
        ) with ordinality as game(value, position)
       where round.session_id = p_session_id
      union all
      select round.round_no,
             game.position::integer - 1 as court_index,
             completed.position::integer - 1 as event_index,
             completed.value as event
        from public.open_play_game_rounds round
        cross join lateral jsonb_array_elements(
          coalesce(round.assignments, '[]'::jsonb)
        ) with ordinality as game(value, position)
        cross join lateral jsonb_array_elements(
          case
            when jsonb_typeof(game.value -> 'completedGames') = 'array'
              then game.value -> 'completedGames'
            else '[]'::jsonb
          end
        ) with ordinality as completed(value, position)
       where round.session_id = p_session_id
    )
    select event.*
      from game_events event
     where event.event ->> 'winner' in ('A', 'B')
     order by (nullif(event.event ->> 'resultAt', '') is null),
              nullif(event.event ->> 'resultAt', ''),
              event.round_no,
              event.court_index,
              event.event_index,
              coalesce(event.event ->> 'matchId', '')
  loop
    if jsonb_typeof(v_event.event -> 'teamA') <> 'array'
       or jsonb_typeof(v_event.event -> 'teamB') <> 'array'
       or jsonb_array_length(v_event.event -> 'teamA') <> 2
       or jsonb_array_length(v_event.event -> 'teamB') <> 2 then
      continue;
    end if;

    v_a1 := nullif(v_event.event -> 'teamA' ->> 0, '');
    v_a2 := nullif(v_event.event -> 'teamA' ->> 1, '');
    v_b1 := nullif(v_event.event -> 'teamB' ->> 0, '');
    v_b2 := nullif(v_event.event -> 'teamB' ->> 1, '');

    if v_a1 is null or v_a2 is null or v_b1 is null or v_b2 is null
       or v_a1 = v_a2 or v_a1 = v_b1 or v_a1 = v_b2
       or v_a2 = v_b1 or v_a2 = v_b2 or v_b1 = v_b2
       or not (v_ratings ? v_a1)
       or not (v_ratings ? v_a2)
       or not (v_ratings ? v_b1)
       or not (v_ratings ? v_b2) then
      continue;
    end if;

    v_team_a_rating := (
      (v_ratings ->> v_a1)::numeric +
      (v_ratings ->> v_a2)::numeric
    ) / 2;
    v_team_b_rating := (
      (v_ratings ->> v_b1)::numeric +
      (v_ratings ->> v_b2)::numeric
    ) / 2;

    if v_event.event ->> 'winner' = 'A' then
      v_winner_rating := v_team_a_rating;
      v_loser_rating := v_team_b_rating;
      v_winner_ids := array[v_a1, v_a2];
      v_loser_ids := array[v_b1, v_b2];
    else
      v_winner_rating := v_team_b_rating;
      v_loser_rating := v_team_a_rating;
      v_winner_ids := array[v_b1, v_b2];
      v_loser_ids := array[v_a1, v_a2];
    end if;

    v_expected := 1 / (
      1 + power(
        10::numeric,
        (v_loser_rating - v_winner_rating) /
          v_session.performance_rating_scale::numeric
      )
    );
    v_gain := least(
      v_session.performance_rating_k - 1,
      greatest(
        1,
        round(v_session.performance_rating_k::numeric * (1 - v_expected))
      )
    );
    v_upset := greatest(0, v_loser_rating - v_winner_rating);

    foreach v_id in array array[v_a1, v_a2] loop
      v_games := jsonb_set(
        v_games,
        array[v_id],
        to_jsonb((v_games ->> v_id)::integer + 1),
        true
      );
      v_opponent_totals := jsonb_set(
        v_opponent_totals,
        array[v_id],
        to_jsonb((v_opponent_totals ->> v_id)::numeric + v_team_b_rating),
        true
      );
    end loop;

    foreach v_id in array array[v_b1, v_b2] loop
      v_games := jsonb_set(
        v_games,
        array[v_id],
        to_jsonb((v_games ->> v_id)::integer + 1),
        true
      );
      v_opponent_totals := jsonb_set(
        v_opponent_totals,
        array[v_id],
        to_jsonb((v_opponent_totals ->> v_id)::numeric + v_team_a_rating),
        true
      );
    end loop;

    foreach v_id in array v_winner_ids loop
      v_ratings := jsonb_set(
        v_ratings,
        array[v_id],
        to_jsonb((v_ratings ->> v_id)::numeric + v_gain),
        true
      );
      v_wins := jsonb_set(
        v_wins,
        array[v_id],
        to_jsonb((v_wins ->> v_id)::integer + 1),
        true
      );
      v_best_upsets := jsonb_set(
        v_best_upsets,
        array[v_id],
        to_jsonb(greatest((v_best_upsets ->> v_id)::numeric, v_upset)),
        true
      );
    end loop;

    foreach v_id in array v_loser_ids loop
      v_ratings := jsonb_set(
        v_ratings,
        array[v_id],
        to_jsonb((v_ratings ->> v_id)::numeric - v_gain),
        true
      );
    end loop;
  end loop;

  with raw as (
    select player.id,
           player.full_name,
           player.seed_order,
           (v_games ->> player.id::text)::integer as games,
           (v_wins ->> player.id::text)::integer as wins,
           round(
             (v_ratings ->> player.id::text)::numeric,
             1
           ) as rating,
           round(
             (v_ratings ->> player.id::text)::numeric -
               player.performance_seed_rating,
             1
           ) as points,
           case
             when (v_games ->> player.id::text)::integer > 0 then
               round(
                 (v_opponent_totals ->> player.id::text)::numeric /
                   (v_games ->> player.id::text)::integer,
                 1
               )
             else 0
           end as average_opponent_rating,
           round(
             (v_best_upsets ->> player.id::text)::numeric,
             1
           ) as best_upset
      from public.open_play_game_players player
     where player.session_id = p_session_id
       and (
         player.status = 'active'
         or (v_games ->> player.id::text)::integer > 0
       )
  ),
  ranked as (
    select raw.*,
           raw.games >= v_session.performance_rating_min_games as eligible,
           case
             when raw.games >= v_session.performance_rating_min_games then
               rank() over (
                 partition by (
                   raw.games >= v_session.performance_rating_min_games
                 )
                 order by raw.points desc,
                          raw.average_opponent_rating desc,
                          raw.best_upset desc
               )
             else null
           end as performance_rank
      from raw
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'name', ranked.full_name,
        'rating', ranked.rating,
        'points', ranked.points,
        'games', ranked.games,
        'wins', ranked.wins,
        'eligible', ranked.eligible,
        'rank', ranked.performance_rank,
        'averageOpponentRating', ranked.average_opponent_rating,
        'bestUpset', ranked.best_upset
      )
      order by ranked.eligible desc,
               ranked.points desc,
               ranked.average_opponent_rating desc,
               ranked.best_upset desc,
               lower(ranked.full_name),
               ranked.seed_order,
               ranked.id
    ),
    '[]'::jsonb
  )
    into v_rows
    from ranked;

  return v_rows;
end;
$$;

revoke all on function public.calculate_open_play_performance_standings(uuid)
  from public, anon, authenticated, service_role;

-- Preserve the existing lifecycle, latest-result, and ready-court projection
-- as a private implementation detail. Replace only standings and add public
-- algorithm metadata; player IDs and frozen seed ratings remain private.
alter function public.get_public_open_play_game_live_board(text)
  rename to get_public_open_play_game_live_board_v3;

revoke all on function public.get_public_open_play_game_live_board_v3(text)
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
  v_session public.open_play_game_sessions%rowtype;
  v_board jsonb;
  v_standings jsonb;
begin
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

  v_board := public.get_public_open_play_game_live_board_v3(p_share_token);
  if v_board is null then
    return null;
  end if;

  v_standings :=
    public.calculate_open_play_performance_standings(v_session.id);

  v_board := jsonb_set(v_board, '{standings}', v_standings, false);
  return v_board || jsonb_build_object(
    'ratingSystem', jsonb_build_object(
      'name', 'Individual Performance Rating',
      'version', v_session.performance_rating_version,
      'kFactor', v_session.performance_rating_k,
      'scale', v_session.performance_rating_scale,
      'minGames', v_session.performance_rating_min_games,
      'rankingMetric', 'session_points'
    )
  );
end;
$$;

revoke all on function public.get_public_open_play_game_live_board(text)
  from public;
grant execute on function public.get_public_open_play_game_live_board(text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
