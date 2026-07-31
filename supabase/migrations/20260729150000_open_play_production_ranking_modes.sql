-- Make all three podium choices available on the production Play Manager.

begin;

alter table public.open_play_game_sessions
  drop constraint if exists open_play_game_sessions_ranking_mode_check;

alter table public.open_play_game_sessions
  add constraint open_play_game_sessions_ranking_mode_check
    check (ranking_mode in ('competitive', 'performance', 'win_percentage'));

create or replace function public.calculate_open_play_win_percentage_standings(
  p_session_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_source jsonb;
begin
  -- Reuse the event-sourced competitive calculation for canonical games and
  -- wins, then rank only by exact win ratio followed by total wins.
  v_source := public.calculate_open_play_competitive_standings(p_session_id);

  return (
    with raw as (
      select entry.ordinality as source_order,
             row.*
        from jsonb_array_elements(v_source)
          with ordinality as entry(value, ordinality)
        cross join lateral jsonb_to_record(entry.value) as row(
          name text,
          rating numeric,
          "ratingExact" numeric,
          points numeric,
          "pointsExact" numeric,
          games integer,
          wins integer,
          losses integer,
          "winPercentage" numeric,
          eligible boolean,
          "averageOpponentRating" numeric,
          "averageOpponentRatingExact" numeric,
          "bestUpset" numeric,
          "bestUpsetExact" numeric
        )
    ),
    ranked as (
      select raw.*,
             case when eligible then rank() over (
               partition by eligible
               order by (wins::numeric / greatest(1, games)) desc,
                        wins desc
             ) else null end as win_rank,
             exists (
               select 1
                 from raw peer
                where peer.name <> raw.name
                  and peer.eligible = raw.eligible
                  and (
                    peer.wins::numeric / greatest(1, peer.games)
                  ) = (
                    raw.wins::numeric / greatest(1, raw.games)
                  )
                  and peer.wins <> raw.wins
             ) as used_wins_tiebreak
        from raw
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
        'mode', 'win_percentage',
        'eligible', eligible,
        'rank', win_rank,
        'averageOpponentRating', "averageOpponentRating",
        'averageOpponentRatingExact', "averageOpponentRatingExact",
        'bestUpset', "bestUpset",
        'bestUpsetExact', "bestUpsetExact",
        'headToHeadGames', 0,
        'headToHeadWins', 0,
        'headToHeadLosses', 0,
        'headToHeadPercentage', 0,
        'rankCriterion', case
          when used_wins_tiebreak then 'wins'
          else 'win_percentage'
        end,
        'rankReason', case
          when used_wins_tiebreak then 'Wins tiebreak'
          else 'Win percentage'
        end,
        'tieBreakReason', case
          when used_wins_tiebreak then 'Wins tiebreak'
          else null
        end,
        'requiresPodiumDecider', false,
        'podiumDeciderGroupId', null
      )
      order by eligible desc,
               (wins::numeric / greatest(1, games)) desc,
               wins desc,
               source_order
    ), '[]'::jsonb)
      from ranked
  );
end;
$$;

revoke all on function public.calculate_open_play_win_percentage_standings(uuid)
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

  v_standings := case v_session.ranking_mode
    when 'competitive' then
      public.calculate_open_play_competitive_standings(v_session.id)
    when 'win_percentage' then
      public.calculate_open_play_win_percentage_standings(v_session.id)
    else
      public.calculate_open_play_performance_standings(v_session.id)
  end;

  v_board := jsonb_set(v_board, '{standings}', v_standings, false);
  return v_board || jsonb_build_object(
    'ratingSystem', jsonb_build_object(
      'mode', v_session.ranking_mode,
      'name', case v_session.ranking_mode
        when 'competitive' then 'Competitive Ranking'
        when 'win_percentage' then 'Individual Win Percentage'
        else 'Individual Performance Rating'
      end,
      'version', case v_session.ranking_mode
        when 'competitive' then 'competitive-ranking-v2'
        when 'win_percentage' then 'win-percentage-v1'
        else v_session.performance_rating_version
      end,
      'kFactor', v_session.performance_rating_k,
      'scale', v_session.performance_rating_scale,
      'minGames', v_session.performance_rating_min_games,
      'rankingMetric', case v_session.ranking_mode
        when 'competitive' then 'competitive'
        when 'win_percentage' then 'win_percentage'
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
