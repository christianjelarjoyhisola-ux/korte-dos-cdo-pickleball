begin;

alter table public.open_play_game_players
  add column if not exists skill_level smallint not null default 1;

alter table public.open_play_game_players
  drop constraint if exists open_play_game_players_skill_level_check;

alter table public.open_play_game_players
  add constraint open_play_game_players_skill_level_check
  check (skill_level between 1 and 6);

comment on column public.open_play_game_players.skill_level is
  'Manager-assigned 1-6 player skill rating used to balance Play Manager teams.';

notify pgrst, 'reload schema';

commit;
