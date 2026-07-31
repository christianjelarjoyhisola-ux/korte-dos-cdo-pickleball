begin;

alter table public.open_play_game_sessions
  add column if not exists location text,
  add column if not exists settings jsonb not null default '{}'::jsonb,
  add column if not exists share_enabled boolean not null default true;

alter table public.open_play_game_players
  add column if not exists profile jsonb not null default '{}'::jsonb;

alter table public.open_play_game_players
  drop constraint if exists open_play_game_players_status_check;

alter table public.open_play_game_players
  add constraint open_play_game_players_status_check
  check (status in ('active', 'no_show', 'break', 'removed'));

create or replace function public.replace_open_play_game_players(
  p_session_id uuid,
  p_players jsonb
)
returns setof public.open_play_game_players
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_invalid_count integer;
  v_status text;
begin
  if p_session_id is null then
    raise exception using errcode = '22023', message = 'A valid Open Play Rotation session is required.';
  end if;
  if jsonb_typeof(p_players) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Open Play Rotation players must be a JSON array.';
  end if;
  if jsonb_array_length(p_players) > 500 then
    raise exception using errcode = '22023', message = 'Open Play Rotation supports up to 500 players per session.';
  end if;

  select session.status into v_status
  from public.open_play_game_sessions session
  where session.id = p_session_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'The Open Play Rotation session was not found or is not accessible.';
  end if;
  if v_status in ('paused', 'completed', 'cancelled') then
    raise exception using errcode = '55000', message = 'Resume the session or create a new session before changing its roster.';
  end if;

  select count(*) into v_invalid_count
  from jsonb_array_elements(p_players) entry(item)
  where nullif(btrim(entry.item ->> 'full_name'), '') is null;
  if v_invalid_count > 0 then
    raise exception using errcode = '22023', message = 'Every saved rotation player needs a name.';
  end if;

  select count(*) into v_invalid_count
  from jsonb_array_elements(p_players) entry(item)
  where coalesce(nullif(entry.item ->> 'status', ''), 'active')
    not in ('active', 'no_show', 'break', 'removed');
  if v_invalid_count > 0 then
    raise exception using errcode = '22023', message = 'A rotation player has an invalid check-in status.';
  end if;

  select count(*) into v_invalid_count
  from jsonb_array_elements(p_players) entry(item)
  where entry.item ? 'profile'
    and jsonb_typeof(entry.item -> 'profile') is distinct from 'object';
  if v_invalid_count > 0 then
    raise exception using errcode = '22023', message = 'A rotation player profile must be a JSON object.';
  end if;

  select count(*) into v_invalid_count
  from jsonb_array_elements(p_players) entry(item)
  where nullif(entry.item ->> 'id', '') is not null
    and (entry.item ->> 'id') !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  if v_invalid_count > 0 then
    raise exception using errcode = '22023', message = 'A rotation player ID is invalid.';
  end if;

  select count(*) into v_invalid_count
  from jsonb_array_elements(p_players) entry(item)
  where nullif(entry.item ->> 'source_registration_id', '') is not null
    and (entry.item ->> 'source_registration_id') !~ '^[1-9][0-9]*$';
  if v_invalid_count > 0 then
    raise exception using errcode = '22023', message = 'A paid Open Play registration ID is invalid.';
  end if;

  select count(*) into v_invalid_count
  from (
    select lower(entry.item ->> 'id')
    from jsonb_array_elements(p_players) entry(item)
    where nullif(entry.item ->> 'id', '') is not null
    group by lower(entry.item ->> 'id')
    having count(*) > 1
  ) duplicate_ids;
  if v_invalid_count > 0 then
    raise exception using errcode = '22023', message = 'The same rotation player appears more than once.';
  end if;

  select count(*) into v_invalid_count
  from (
    select (entry.item ->> 'source_registration_id')::bigint
    from jsonb_array_elements(p_players) entry(item)
    where nullif(entry.item ->> 'source_registration_id', '') is not null
    group by (entry.item ->> 'source_registration_id')::bigint
    having count(*) > 1
  ) duplicate_sources;
  if v_invalid_count > 0 then
    raise exception using errcode = '22023', message = 'The same paid registration appears more than once.';
  end if;

  select count(*) into v_invalid_count
  from jsonb_array_elements(p_players) entry(item)
  where nullif(entry.item ->> 'id', '') is not null
    and not exists (
      select 1
      from public.open_play_game_players player
      where player.id = (entry.item ->> 'id')::uuid
        and player.session_id = p_session_id
    );
  if v_invalid_count > 0 then
    raise exception using errcode = '22023', message = 'A saved rotation player no longer belongs to this session.';
  end if;

  select count(*) into v_invalid_count
  from public.open_play_game_players player
  where player.session_id = p_session_id
    and exists (
      select 1 from public.open_play_game_rounds round
      where round.session_id = p_session_id
    )
    and not exists (
      select 1
      from jsonb_array_elements(p_players) entry(item)
      where nullif(entry.item ->> 'id', '') is not null
        and (entry.item ->> 'id')::uuid = player.id
    );
  if v_invalid_count > 0 then
    raise exception using errcode = '55000', message = 'Saved rounds lock existing player IDs. Use the roster reset action to erase history first.';
  end if;

  update public.open_play_game_players
  set source_registration_id = null
  where session_id = p_session_id;

  delete from public.open_play_game_players player
  where player.session_id = p_session_id
    and not exists (
      select 1
      from jsonb_array_elements(p_players) entry(item)
      where nullif(entry.item ->> 'id', '') is not null
        and (entry.item ->> 'id')::uuid = player.id
    );

  insert into public.open_play_game_players (
    id,
    session_id,
    full_name,
    source_registration_id,
    status,
    seed_order,
    profile
  )
  select
    coalesce(nullif(entry.item ->> 'id', '')::uuid, gen_random_uuid()),
    p_session_id,
    btrim(entry.item ->> 'full_name'),
    case
      when nullif(entry.item ->> 'source_registration_id', '') is null then null
      else (entry.item ->> 'source_registration_id')::bigint
    end,
    coalesce(nullif(entry.item ->> 'status', ''), 'active'),
    (entry.ordinality - 1)::integer,
    coalesce(entry.item -> 'profile', '{}'::jsonb)
  from jsonb_array_elements(p_players) with ordinality entry(item, ordinality)
  on conflict (id) do update
  set full_name = excluded.full_name,
      source_registration_id = excluded.source_registration_id,
      status = excluded.status,
      seed_order = excluded.seed_order,
      profile = excluded.profile
  where open_play_game_players.session_id = p_session_id;

  return query
  select player.*
  from public.open_play_game_players player
  where player.session_id = p_session_id
  order by player.seed_order, player.created_at, player.id;
end;
$$;

revoke all on function public.replace_open_play_game_players(uuid, jsonb) from public, anon;
grant execute on function public.replace_open_play_game_players(uuid, jsonb) to authenticated;

create or replace function public.update_open_play_game_round(
  p_round_id uuid,
  p_expected_assignments jsonb,
  p_expected_queue_snapshot jsonb,
  p_assignments jsonb,
  p_queue_snapshot jsonb
)
returns public.open_play_game_rounds
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_round public.open_play_game_rounds%rowtype;
  v_session_id uuid;
  v_session_status text;
  v_current_round integer;
  v_mode text;
  v_team_size integer;
  v_current_assignments jsonb;
  v_current_queue jsonb;
  v_invalid_count integer;
begin
  if jsonb_typeof(p_assignments) is distinct from 'array'
     or jsonb_typeof(p_queue_snapshot) is distinct from 'array'
     or jsonb_typeof(p_expected_assignments) is distinct from 'array'
     or jsonb_typeof(p_expected_queue_snapshot) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'The live rotation update must contain assignment and queue arrays.';
  end if;

  select round.session_id, round.assignments, round.queue_snapshot
  into v_session_id, v_current_assignments, v_current_queue
  from public.open_play_game_rounds round
  where round.id = p_round_id
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'This rotation round no longer exists. Reload the session.';
  end if;

  select session.status, session.current_round, session.mode
  into v_session_status, v_current_round, v_mode
  from public.open_play_game_sessions session
  where session.id = v_session_id
  for update;

  select * into v_round
  from public.open_play_game_rounds round
  where round.id = p_round_id;

  if v_session_status is distinct from 'active' or v_round.round_no is distinct from v_current_round then
    raise exception using errcode = '55000', message = 'This is no longer the active rotation round. Reload it and try again.';
  end if;
  if v_current_assignments is distinct from p_expected_assignments
     or v_current_queue is distinct from p_expected_queue_snapshot then
    raise exception using errcode = '40001', message = 'The live rotation changed in another manager. Reload it and try again.';
  end if;

  v_team_size := case when split_part(coalesce(v_mode, 'doubles:balanced'), ':', 1) = 'singles' then 1 else 2 end;
  if jsonb_array_length(p_assignments) < 1 then
    raise exception using errcode = '22023', message = 'At least one court must remain in the active rotation.';
  end if;

  select count(*) into v_invalid_count
  from jsonb_array_elements(p_assignments) game(item)
  where jsonb_typeof(game.item -> 'teamA') is distinct from 'array'
     or jsonb_typeof(game.item -> 'teamB') is distinct from 'array'
     or jsonb_array_length(game.item -> 'teamA') <> v_team_size
     or jsonb_array_length(game.item -> 'teamB') <> v_team_size;
  if v_invalid_count > 0 then
    raise exception using errcode = '22023', message = 'A live court has invalid team slots.';
  end if;

  with assigned as (
    select slot.value #>> '{}' as player_id
    from jsonb_array_elements(p_assignments) game(item)
    cross join lateral jsonb_array_elements(game.item -> 'teamA') slot(value)
    union all
    select slot.value #>> '{}'
    from jsonb_array_elements(p_assignments) game(item)
    cross join lateral jsonb_array_elements(game.item -> 'teamB') slot(value)
  )
  select count(*) into v_invalid_count
  from assigned
  where player_id is not null
    and player_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  if v_invalid_count > 0 then
    raise exception using errcode = '22023', message = 'The live rotation contains an invalid assigned player ID.';
  end if;

  with assigned as (
    select slot.value #>> '{}' as player_id
    from jsonb_array_elements(p_assignments) game(item)
    cross join lateral jsonb_array_elements(game.item -> 'teamA') slot(value)
    union all
    select slot.value #>> '{}'
    from jsonb_array_elements(p_assignments) game(item)
    cross join lateral jsonb_array_elements(game.item -> 'teamB') slot(value)
  )
  select count(*) - count(distinct player_id) into v_invalid_count
  from assigned
  where player_id is not null;
  if v_invalid_count > 0 then
    raise exception using errcode = '22023', message = 'A player cannot be assigned to two court positions in the same rotation round.';
  end if;

  with assigned as (
    select slot.value #>> '{}' as player_id
    from jsonb_array_elements(p_assignments) game(item)
    cross join lateral jsonb_array_elements(game.item -> 'teamA') slot(value)
    union all
    select slot.value #>> '{}'
    from jsonb_array_elements(p_assignments) game(item)
    cross join lateral jsonb_array_elements(game.item -> 'teamB') slot(value)
  )
  select count(*) into v_invalid_count
  from assigned
  where player_id is not null
    and not exists (
      select 1 from public.open_play_game_players player
      where player.id = assigned.player_id::uuid
        and player.session_id = v_session_id
    );
  if v_invalid_count > 0 then
    raise exception using errcode = '55000', message = 'The roster changed in another manager. Reload it before recording live results.';
  end if;

  select count(*) into v_invalid_count
  from jsonb_array_elements_text(p_queue_snapshot) queue(player_id)
  where queue.player_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  if v_invalid_count > 0 then
    raise exception using errcode = '22023', message = 'The live rotation queue contains an invalid player ID.';
  end if;

  select count(*) - count(distinct queue.player_id) into v_invalid_count
  from jsonb_array_elements_text(p_queue_snapshot) queue(player_id);
  if v_invalid_count > 0 then
    raise exception using errcode = '22023', message = 'A player cannot appear twice in the live rotation queue.';
  end if;

  select count(*) into v_invalid_count
  from jsonb_array_elements_text(p_queue_snapshot) queue(player_id)
  where not exists (
    select 1 from public.open_play_game_players player
    where player.id = queue.player_id::uuid
      and player.session_id = v_session_id
      and player.status = 'active'
  );
  if v_invalid_count > 0 then
    raise exception using errcode = '55000', message = 'The checked-in roster changed in another manager. Reload it before changing the queue.';
  end if;

  update public.open_play_game_rounds
  set assignments = p_assignments,
      queue_snapshot = p_queue_snapshot
  where id = p_round_id
  returning * into v_round;
  return v_round;
end;
$$;

revoke all on function public.update_open_play_game_round(uuid, jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.update_open_play_game_round(uuid, jsonb, jsonb, jsonb, jsonb) to authenticated;

create or replace function public.correct_open_play_game_result(
  p_round_id uuid,
  p_game_id text
)
returns public.open_play_game_rounds
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_round public.open_play_game_rounds%rowtype;
  v_assignments jsonb;
  v_found boolean;
begin
  if p_round_id is null or nullif(btrim(p_game_id), '') is null then
    raise exception using errcode = '22023', message = 'A saved round and game are required.';
  end if;

  select * into v_round
  from public.open_play_game_rounds round
  where round.id = p_round_id
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'That saved rotation round was not found.';
  end if;

  select exists (
    select 1
    from jsonb_array_elements(v_round.assignments) game(item)
    where game.item ->> 'gameId' = p_game_id
      and game.item ->> 'winner' in ('A', 'B')
    union all
    select 1
    from jsonb_array_elements(v_round.assignments) game(item)
    cross join lateral jsonb_array_elements(coalesce(game.item -> 'completedGames', '[]'::jsonb)) completed(item)
    where completed.item ->> 'gameId' = p_game_id
      and completed.item ->> 'winner' in ('A', 'B')
  ) into v_found;
  if not v_found then
    raise exception using errcode = '55000', message = 'That saved match result was not found.';
  end if;

  select jsonb_agg(
    case
      when game.item ->> 'gameId' = p_game_id
        and game.item ->> 'winner' in ('A', 'B')
      then jsonb_set(
        jsonb_set(
          game.item,
          '{winner}',
          to_jsonb(case when game.item ->> 'winner' = 'A' then 'B' else 'A' end),
          true
        ),
        '{correctedAt}',
        to_jsonb(now()),
        true
      )
      else jsonb_set(
        game.item,
        '{completedGames}',
        coalesce((
          select jsonb_agg(
            case
              when completed.item ->> 'gameId' = p_game_id
                and completed.item ->> 'winner' in ('A', 'B')
              then jsonb_set(
                jsonb_set(
                  completed.item,
                  '{winner}',
                  to_jsonb(case when completed.item ->> 'winner' = 'A' then 'B' else 'A' end),
                  true
                ),
                '{correctedAt}',
                to_jsonb(now()),
                true
              )
              else completed.item
            end
            order by completed.ordinality
          )
          from jsonb_array_elements(coalesce(game.item -> 'completedGames', '[]'::jsonb))
            with ordinality completed(item, ordinality)
        ), '[]'::jsonb),
        true
      )
    end
    order by game.ordinality
  )
  into v_assignments
  from jsonb_array_elements(v_round.assignments) with ordinality game(item, ordinality);

  update public.open_play_game_rounds
  set assignments = v_assignments
  where id = p_round_id
  returning * into v_round;
  return v_round;
end;
$$;

revoke all on function public.correct_open_play_game_result(uuid, text) from public, anon;
grant execute on function public.correct_open_play_game_result(uuid, text) to authenticated;

create or replace function public.public_check_in_open_play_player(
  p_session_id uuid,
  p_player_id uuid
)
returns public.open_play_game_players
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.open_play_game_sessions%rowtype;
  v_player public.open_play_game_players%rowtype;
begin
  select * into v_session
  from public.open_play_game_sessions session
  where session.id = p_session_id
    and session.share_enabled = true
  for update;
  if not found
     or v_session.status in ('completed', 'cancelled')
     or coalesce((v_session.settings ->> 'publicCheckIn')::boolean, false) is false then
    raise exception using errcode = '42501', message = 'Player self check-in is not enabled for this session.';
  end if;

  update public.open_play_game_players
  set status = 'active',
      profile = jsonb_set(
        coalesce(profile, '{}'::jsonb),
        '{checkedInAt}',
        to_jsonb(now()),
        true
      )
  where id = p_player_id
    and session_id = p_session_id
  returning * into v_player;
  if not found then
    raise exception using errcode = '55000', message = 'That player was not found in this session.';
  end if;
  return v_player;
end;
$$;

revoke all on function public.public_check_in_open_play_player(uuid, uuid) from public;
grant execute on function public.public_check_in_open_play_player(uuid, uuid) to anon, authenticated;

create or replace function public.get_public_open_play_game_session(
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_session public.open_play_game_sessions%rowtype;
begin
  select * into v_session
  from public.open_play_game_sessions session
  where session.id = p_session_id
    and session.share_enabled = true;
  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'session', jsonb_build_object(
      'id', v_session.id,
      'date', v_session.date,
      'time_label', v_session.time_label,
      'location', v_session.location,
      'court_ids', v_session.court_ids,
      'court_names', v_session.court_names,
      'mode', v_session.mode,
      'status', v_session.status,
      'public_check_in', coalesce((v_session.settings ->> 'publicCheckIn')::boolean, false),
      'current_round', v_session.current_round,
      'updated_at', v_session.updated_at
    ),
    'up_next', coalesce((
      select coalesce(
        (round.assignments -> 0) -> 'stagedMatches',
        (round.assignments -> 0) -> 'staged_matches',
        '[]'::jsonb
      )
      from public.open_play_game_rounds round
      where round.session_id = p_session_id
      order by round.round_no desc
      limit 1
    ), '[]'::jsonb),
    'players', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', player.id,
          'full_name', player.full_name,
          'status', player.status,
          'seed_order', player.seed_order,
          'profile', coalesce(player.profile, '{}'::jsonb) - 'duprId' - 'dupr_id'
        )
        order by player.seed_order, player.created_at, player.id
      )
      from public.open_play_game_players player
      where player.session_id = p_session_id
    ), '[]'::jsonb),
    'rounds', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', round.id,
          'round_no', round.round_no,
          'assignments', round.assignments,
          'queue_snapshot', round.queue_snapshot,
          'created_at', round.created_at,
          'completed_at', round.completed_at
        )
        order by round.round_no
      )
      from public.open_play_game_rounds round
      where round.session_id = p_session_id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_public_open_play_game_session(uuid) from public;
grant execute on function public.get_public_open_play_game_session(uuid) to anon, authenticated;

comment on function public.get_public_open_play_game_session(uuid) is
  'Returns the share-safe live Open Play board when public sharing is enabled.';

commit;
