-- Korte DOS sessions are shorter than the source venue's sessions. Two
-- completed games provides a practical official-ranking threshold while
-- keeping zero- and one-game players provisional.

begin;

alter table public.open_play_game_sessions
  drop constraint if exists open_play_game_sessions_performance_rating_min_games_check;

alter table public.open_play_game_sessions
  alter column performance_rating_min_games set default 2;

-- The performance configuration is normally immutable after play begins.
-- This one-time rules migration intentionally updates historical sessions so
-- completed-session rankings and public live boards use the same threshold.
alter table public.open_play_game_sessions
  disable trigger trg_open_play_performance_session_config;

update public.open_play_game_sessions
   set performance_rating_min_games = 2
 where performance_rating_min_games is distinct from 2;

alter table public.open_play_game_sessions
  enable trigger trg_open_play_performance_session_config;

alter table public.open_play_game_sessions
  add constraint open_play_game_sessions_performance_rating_min_games_check
  check (performance_rating_min_games = 2);

comment on column public.open_play_game_sessions.performance_rating_min_games is
  'Minimum completed games required for an official Korte DOS session rank.';

commit;
