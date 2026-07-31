-- Production Competitive Ranking for rotating-doubles Open Play.
-- The official order is exact Elo performance, win percentage, wins,
-- head-to-head mini-table, opponent strength, best upset, then a real decider.

begin;

alter table public.open_play_game_sessions
  add column if not exists ranking_mode text;

update public.open_play_game_sessions
   set ranking_mode = case
     when status in ('completed', 'cancelled') then 'performance'
     else 'competitive'
   end
 where ranking_mode is null;

alter table public.open_play_game_sessions
  alter column ranking_mode set default 'competitive',
  alter column ranking_mode set not null;

alter table public.open_play_game_sessions
  drop constraint if exists open_play_game_sessions_ranking_mode_check;

alter table public.open_play_game_sessions
  add constraint open_play_game_sessions_ranking_mode_check
    check (ranking_mode in ('performance', 'competitive'));

comment on column public.open_play_game_sessions.ranking_mode is
  'Frozen official podium method. Competitive uses exact Elo and deterministic tiebreaks.';

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
    new.performance_rating_min_games,
    new.ranking_mode
  ) is distinct from row(
    old.performance_rating_version,
    old.performance_rating_k,
    old.performance_rating_scale,
    old.performance_rating_min_games,
    old.ranking_mode
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
  performance_rating_min_games,
  ranking_mode
on public.open_play_game_sessions
for each row execute function public.guard_open_play_performance_session_config();

create or replace function public.calculate_open_play_competitive_standings(
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
  v_row jsonb;
  v_peer jsonb;
  v_stat jsonb;
  v_ratings jsonb := '{}'::jsonb;
  v_seeds jsonb := '{}'::jsonb;
  v_games jsonb := '{}'::jsonb;
  v_wins jsonb := '{}'::jsonb;
  v_opponent_totals jsonb := '{}'::jsonb;
  v_best_upsets jsonb := '{}'::jsonb;
  v_head_to_head jsonb := '{}'::jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_enriched jsonb := '[]'::jsonb;
  v_a1 text;
  v_a2 text;
  v_b1 text;
  v_b2 text;
  v_team_a_rating numeric;
  v_team_b_rating numeric;
  v_expected_a numeric;
  v_delta_a numeric;
  v_delta_b numeric;
  v_upset_a numeric;
  v_upset_b numeric;
  v_id text;
  v_opponent_id text;
  v_h2h_games integer;
  v_h2h_wins integer;
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
    v_id := v_player.id::text;
    v_ratings := jsonb_set(
      v_ratings, array[v_id], to_jsonb(v_player.performance_seed_rating), true
    );
    v_seeds := jsonb_set(
      v_seeds, array[v_id], to_jsonb(v_player.performance_seed_rating), true
    );
    v_games := jsonb_set(v_games, array[v_id], '0'::jsonb, true);
    v_wins := jsonb_set(v_wins, array[v_id], '0'::jsonb, true);
    v_opponent_totals := jsonb_set(
      v_opponent_totals, array[v_id], '0'::jsonb, true
    );
    v_best_upsets := jsonb_set(
      v_best_upsets, array[v_id], '0'::jsonb, true
    );
    v_head_to_head := jsonb_set(
      v_head_to_head, array[v_id], '{}'::jsonb, true
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
    v_expected_a := 1 / (
      1 + power(
        10::numeric,
        (v_team_b_rating - v_team_a_rating) /
          v_session.performance_rating_scale::numeric
      )
    );
    v_delta_a := v_session.performance_rating_k::numeric * (
      case when v_event.event ->> 'winner' = 'A' then 1 else 0 end -
      v_expected_a
    );
    v_delta_b := -v_delta_a;
    v_upset_a := case
      when v_event.event ->> 'winner' = 'A'
        then greatest(0, v_team_b_rating - v_team_a_rating)
      else 0
    end;
    v_upset_b := case
      when v_event.event ->> 'winner' = 'B'
        then greatest(0, v_team_a_rating - v_team_b_rating)
      else 0
    end;

    foreach v_id in array array[v_a1, v_a2] loop
      v_games := jsonb_set(
        v_games, array[v_id],
        to_jsonb((v_games ->> v_id)::integer + 1), true
      );
      v_wins := jsonb_set(
        v_wins, array[v_id],
        to_jsonb(
          (v_wins ->> v_id)::integer +
          case when v_event.event ->> 'winner' = 'A' then 1 else 0 end
        ), true
      );
      v_opponent_totals := jsonb_set(
        v_opponent_totals, array[v_id],
        to_jsonb((v_opponent_totals ->> v_id)::numeric + v_team_b_rating),
        true
      );
      v_best_upsets := jsonb_set(
        v_best_upsets, array[v_id],
        to_jsonb(greatest((v_best_upsets ->> v_id)::numeric, v_upset_a)),
        true
      );
      v_ratings := jsonb_set(
        v_ratings, array[v_id],
        to_jsonb((v_ratings ->> v_id)::numeric + v_delta_a), true
      );
      foreach v_opponent_id in array array[v_b1, v_b2] loop
        if v_head_to_head #> array[v_id, v_opponent_id] is null then
          v_head_to_head := jsonb_set(
            v_head_to_head,
            array[v_id, v_opponent_id],
            '{"games":0,"wins":0}'::jsonb,
            true
          );
        end if;
        v_head_to_head := jsonb_set(
          v_head_to_head,
          array[v_id, v_opponent_id, 'games'],
          to_jsonb(
            (v_head_to_head #>> array[v_id, v_opponent_id, 'games'])::integer + 1
          ),
          true
        );
        if v_event.event ->> 'winner' = 'A' then
          v_head_to_head := jsonb_set(
            v_head_to_head,
            array[v_id, v_opponent_id, 'wins'],
            to_jsonb(
              (v_head_to_head #>> array[v_id, v_opponent_id, 'wins'])::integer + 1
            ),
            true
          );
        end if;
      end loop;
    end loop;

    foreach v_id in array array[v_b1, v_b2] loop
      v_games := jsonb_set(
        v_games, array[v_id],
        to_jsonb((v_games ->> v_id)::integer + 1), true
      );
      v_wins := jsonb_set(
        v_wins, array[v_id],
        to_jsonb(
          (v_wins ->> v_id)::integer +
          case when v_event.event ->> 'winner' = 'B' then 1 else 0 end
        ), true
      );
      v_opponent_totals := jsonb_set(
        v_opponent_totals, array[v_id],
        to_jsonb((v_opponent_totals ->> v_id)::numeric + v_team_a_rating),
        true
      );
      v_best_upsets := jsonb_set(
        v_best_upsets, array[v_id],
        to_jsonb(greatest((v_best_upsets ->> v_id)::numeric, v_upset_b)),
        true
      );
      v_ratings := jsonb_set(
        v_ratings, array[v_id],
        to_jsonb((v_ratings ->> v_id)::numeric + v_delta_b), true
      );
      foreach v_opponent_id in array array[v_a1, v_a2] loop
        if v_head_to_head #> array[v_id, v_opponent_id] is null then
          v_head_to_head := jsonb_set(
            v_head_to_head,
            array[v_id, v_opponent_id],
            '{"games":0,"wins":0}'::jsonb,
            true
          );
        end if;
        v_head_to_head := jsonb_set(
          v_head_to_head,
          array[v_id, v_opponent_id, 'games'],
          to_jsonb(
            (v_head_to_head #>> array[v_id, v_opponent_id, 'games'])::integer + 1
          ),
          true
        );
        if v_event.event ->> 'winner' = 'B' then
          v_head_to_head := jsonb_set(
            v_head_to_head,
            array[v_id, v_opponent_id, 'wins'],
            to_jsonb(
              (v_head_to_head #>> array[v_id, v_opponent_id, 'wins'])::integer + 1
            ),
            true
          );
        end if;
      end loop;
    end loop;
  end loop;

  for v_player in
    select player.id, player.full_name, player.seed_order, player.status
      from public.open_play_game_players player
     where player.session_id = p_session_id
       and (
         player.status = 'active'
         or (v_games ->> player.id::text)::integer > 0
       )
  loop
    v_id := v_player.id::text;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'id', v_id,
      'name', v_player.full_name,
      'seedOrder', v_player.seed_order,
      'rating', round((v_ratings ->> v_id)::numeric, 1),
      'ratingExact', (v_ratings ->> v_id)::numeric,
      'points', round(
        (v_ratings ->> v_id)::numeric - (v_seeds ->> v_id)::numeric, 1
      ),
      'pointsExact',
        (v_ratings ->> v_id)::numeric - (v_seeds ->> v_id)::numeric,
      'games', (v_games ->> v_id)::integer,
      'wins', (v_wins ->> v_id)::integer,
      'losses',
        (v_games ->> v_id)::integer - (v_wins ->> v_id)::integer,
      'winPercentage', case
        when (v_games ->> v_id)::integer > 0 then round(
          100 * (v_wins ->> v_id)::numeric /
            (v_games ->> v_id)::numeric,
          1
        )
        else 0
      end,
      'averageOpponentRating', case
        when (v_games ->> v_id)::integer > 0 then round(
          (v_opponent_totals ->> v_id)::numeric /
            (v_games ->> v_id)::numeric,
          1
        )
        else 0
      end,
      'averageOpponentRatingExact', case
        when (v_games ->> v_id)::integer > 0 then
          (v_opponent_totals ->> v_id)::numeric /
            (v_games ->> v_id)::numeric
        else 0
      end,
      'bestUpset', round((v_best_upsets ->> v_id)::numeric, 1),
      'bestUpsetExact', (v_best_upsets ->> v_id)::numeric,
      'eligible',
        (v_games ->> v_id)::integer >= v_session.performance_rating_min_games
    ));
  end loop;

  for v_row in select value from jsonb_array_elements(v_rows)
  loop
    v_h2h_games := 0;
    v_h2h_wins := 0;
    for v_peer in select value from jsonb_array_elements(v_rows)
    loop
      if v_peer ->> 'id' = v_row ->> 'id'
         or (v_peer ->> 'eligible')::boolean is distinct from
            (v_row ->> 'eligible')::boolean
         or (v_peer ->> 'pointsExact')::numeric <>
            (v_row ->> 'pointsExact')::numeric
         or (v_peer ->> 'wins')::integer <>
            (v_row ->> 'wins')::integer
         or (
           (v_peer ->> 'wins')::numeric *
             greatest(1, (v_row ->> 'games')::integer)
         ) <> (
           (v_row ->> 'wins')::numeric *
             greatest(1, (v_peer ->> 'games')::integer)
         ) then
        continue;
      end if;
      v_stat := v_head_to_head #> array[v_row ->> 'id', v_peer ->> 'id'];
      if v_stat is not null then
        v_h2h_games := v_h2h_games + coalesce((v_stat ->> 'games')::integer, 0);
        v_h2h_wins := v_h2h_wins + coalesce((v_stat ->> 'wins')::integer, 0);
      end if;
    end loop;
    v_enriched := v_enriched || jsonb_build_array(
      v_row || jsonb_build_object(
        'headToHeadGames', v_h2h_games,
        'headToHeadWins', v_h2h_wins,
        'headToHeadLosses', greatest(0, v_h2h_games - v_h2h_wins),
        'headToHeadPercentage', case
          when v_h2h_games > 0
            then round(100 * v_h2h_wins::numeric / v_h2h_games::numeric, 1)
          else 0
        end
      )
    );
  end loop;

  return (
    with raw as (
      select *
        from jsonb_to_recordset(v_enriched) as row(
          id text,
          name text,
          "seedOrder" integer,
          rating numeric,
          "ratingExact" numeric,
          points numeric,
          "pointsExact" numeric,
          games integer,
          wins integer,
          losses integer,
          "winPercentage" numeric,
          "averageOpponentRating" numeric,
          "averageOpponentRatingExact" numeric,
          "bestUpset" numeric,
          "bestUpsetExact" numeric,
          "headToHeadGames" integer,
          "headToHeadWins" integer,
          "headToHeadLosses" integer,
          "headToHeadPercentage" numeric,
          eligible boolean
        )
    ),
    ranked as (
      select raw.*,
             row_number() over (
               order by eligible desc,
                        "pointsExact" desc,
                        (wins::numeric / greatest(1, games)) desc,
                        wins desc,
                        ("headToHeadWins"::numeric /
                          greatest(1, "headToHeadGames")) desc,
                        "headToHeadWins" desc,
                        "averageOpponentRatingExact" desc,
                        "bestUpsetExact" desc,
                        "seedOrder",
                        id
             ) as position,
             case when eligible then rank() over (
               partition by eligible
               order by "pointsExact" desc,
                        (wins::numeric / greatest(1, games)) desc,
                        wins desc,
                        ("headToHeadWins"::numeric /
                          greatest(1, "headToHeadGames")) desc,
                        "headToHeadWins" desc,
                        "averageOpponentRatingExact" desc,
                        "bestUpsetExact" desc
             ) else null end as competitive_rank,
             count(*) over (
               partition by eligible,
                            "pointsExact",
                            (wins::numeric / greatest(1, games)),
                            wins,
                            ("headToHeadWins"::numeric /
                              greatest(1, "headToHeadGames")),
                            "headToHeadWins",
                            "averageOpponentRatingExact",
                            "bestUpsetExact"
             ) as identical_count
        from raw
    ),
    reasoned as (
      select ranked.*,
             peer.id as peer_id,
             case
               when ranked.identical_count > 1
                    and ranked.eligible
                    and ranked.competitive_rank <= 3
                 then 'podium_decider'
               when peer.id is null then 'performance_points'
               when (ranked.wins::numeric / greatest(1, ranked.games)) <>
                    (peer.wins::numeric / greatest(1, peer.games))
                 then 'win_percentage'
               when ranked.wins <> peer.wins then 'wins'
               when (
                 ranked."headToHeadWins"::numeric /
                   greatest(1, ranked."headToHeadGames")
               ) <> (
                 peer."headToHeadWins"::numeric /
                   greatest(1, peer."headToHeadGames")
               ) or ranked."headToHeadWins" <> peer."headToHeadWins"
                 then 'head_to_head'
               when ranked."averageOpponentRatingExact" <>
                    peer."averageOpponentRatingExact"
                 then 'opponent_strength'
               when ranked."bestUpsetExact" <> peer."bestUpsetExact"
                 then 'quality_win'
               else 'identical_record'
             end as criterion
        from ranked
        left join lateral (
          select other.*
            from ranked other
           where other.id <> ranked.id
             and other.eligible = ranked.eligible
             and other."pointsExact" = ranked."pointsExact"
           order by abs(other.position - ranked.position)
           limit 1
        ) peer on true
    )
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'name', name,
        'rating', rating,
        'ratingExact', "ratingExact",
        'points', points,
        'pointsExact', "pointsExact",
        'games', games,
        'wins', wins,
        'losses', losses,
        'winPercentage', "winPercentage",
        'mode', 'competitive',
        'eligible', eligible,
        'rank', competitive_rank,
        'averageOpponentRating', "averageOpponentRating",
        'averageOpponentRatingExact', "averageOpponentRatingExact",
        'bestUpset', "bestUpset",
        'bestUpsetExact', "bestUpsetExact",
        'headToHeadGames', "headToHeadGames",
        'headToHeadWins', "headToHeadWins",
        'headToHeadLosses', "headToHeadLosses",
        'headToHeadPercentage', "headToHeadPercentage",
        'rankCriterion', criterion,
        'rankReason', case criterion
          when 'performance_points' then 'Exact Performance Points'
          when 'win_percentage' then 'Win percentage tiebreak'
          when 'wins' then 'Wins tiebreak'
          when 'head_to_head' then 'Head-to-head tiebreak'
          when 'opponent_strength' then 'Opponent strength tiebreak'
          when 'quality_win' then 'Best upset tiebreak'
          when 'podium_decider' then 'Podium decider required'
          else 'Identical competitive record'
        end,
        'tieBreakReason', case criterion
          when 'performance_points' then null
          when 'win_percentage' then 'Win percentage tiebreak'
          when 'wins' then 'Wins tiebreak'
          when 'head_to_head' then 'Head-to-head tiebreak'
          when 'opponent_strength' then 'Opponent strength tiebreak'
          when 'quality_win' then 'Best upset tiebreak'
          when 'podium_decider' then 'Podium decider required'
          else null
        end,
        'requiresPodiumDecider',
          criterion = 'podium_decider',
        'podiumDeciderGroupId', case
          when criterion = 'podium_decider'
            then 'podium-decider-rank-' || competitive_rank::text
          else null
        end
      )
      order by position
    ), '[]'::jsonb)
      from reasoned
  );
end;
$$;

revoke all on function public.calculate_open_play_competitive_standings(uuid)
  from public, anon, authenticated, service_role;

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

  if v_session.ranking_mode = 'competitive' then
    v_standings :=
      public.calculate_open_play_competitive_standings(v_session.id);
  else
    v_standings :=
      public.calculate_open_play_performance_standings(v_session.id);
  end if;

  v_board := jsonb_set(v_board, '{standings}', v_standings, false);
  return v_board || jsonb_build_object(
    'ratingSystem', jsonb_build_object(
      'mode', v_session.ranking_mode,
      'name', case
        when v_session.ranking_mode = 'competitive'
          then 'Competitive Ranking'
        else 'Individual Performance Rating'
      end,
      'version', case
        when v_session.ranking_mode = 'competitive'
          then 'competitive-ranking-v2'
        else v_session.performance_rating_version
      end,
      'kFactor', v_session.performance_rating_k,
      'scale', v_session.performance_rating_scale,
      'minGames', v_session.performance_rating_min_games,
      'rankingMetric', case
        when v_session.ranking_mode = 'competitive' then 'competitive'
        else 'session_points'
      end
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
