begin;

-- Replace one rotation roster atomically so a network or constraint failure
-- cannot leave the session with only part of its player list. Existing player
-- IDs are preserved, which keeps JSON round history and standings connected.
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
    raise exception using
      errcode = '22023',
      message = 'A valid Open Play Rotation session is required.';
  end if;

  if jsonb_typeof(p_players) is distinct from 'array' then
    raise exception using
      errcode = '22023',
      message = 'Open Play Rotation players must be a JSON array.';
  end if;

  if jsonb_array_length(p_players) > 500 then
    raise exception using
      errcode = '22023',
      message = 'Open Play Rotation supports up to 500 players per session.';
  end if;

  select session.status
  into v_status
  from public.open_play_game_sessions
  as session
  where session.id = p_session_id
  for update;
  if not found then
    raise exception using
      errcode = '42501',
      message = 'The Open Play Rotation session was not found or is not accessible.';
  end if;

  if v_status in ('paused', 'completed', 'cancelled') then
    raise exception using
      errcode = '55000',
      message = 'Resume the session or create a new session before changing its roster.';
  end if;

  select count(*)
  into v_invalid_count
  from jsonb_array_elements(p_players) as entry(item)
  where nullif(btrim(entry.item ->> 'full_name'), '') is null;
  if v_invalid_count > 0 then
    raise exception using
      errcode = '22023',
      message = 'Every saved rotation player needs a name.';
  end if;

  select count(*)
  into v_invalid_count
  from jsonb_array_elements(p_players) as entry(item)
  where coalesce(nullif(entry.item ->> 'status', ''), 'active')
    not in ('active', 'no_show', 'removed');
  if v_invalid_count > 0 then
    raise exception using
      errcode = '22023',
      message = 'A rotation player has an invalid check-in status.';
  end if;

  select count(*)
  into v_invalid_count
  from jsonb_array_elements(p_players) as entry(item)
  where nullif(entry.item ->> 'id', '') is not null
    and (entry.item ->> 'id') !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  if v_invalid_count > 0 then
    raise exception using
      errcode = '22023',
      message = 'A rotation player ID is invalid.';
  end if;

  select count(*)
  into v_invalid_count
  from jsonb_array_elements(p_players) as entry(item)
  where nullif(entry.item ->> 'source_registration_id', '') is not null
    and (entry.item ->> 'source_registration_id') !~ '^[1-9][0-9]*$';
  if v_invalid_count > 0 then
    raise exception using
      errcode = '22023',
      message = 'A paid Open Play registration ID is invalid.';
  end if;

  select count(*)
  into v_invalid_count
  from (
    select lower(entry.item ->> 'id')
    from jsonb_array_elements(p_players) as entry(item)
    where nullif(entry.item ->> 'id', '') is not null
    group by lower(entry.item ->> 'id')
    having count(*) > 1
  ) duplicates;
  if v_invalid_count > 0 then
    raise exception using
      errcode = '22023',
      message = 'The same rotation player appears more than once.';
  end if;

  select count(*)
  into v_invalid_count
  from (
    select (entry.item ->> 'source_registration_id')::bigint
    from jsonb_array_elements(p_players) as entry(item)
    where nullif(entry.item ->> 'source_registration_id', '') is not null
    group by (entry.item ->> 'source_registration_id')::bigint
    having count(*) > 1
  ) duplicates;
  if v_invalid_count > 0 then
    raise exception using
      errcode = '22023',
      message = 'The same paid registration appears more than once.';
  end if;

  select count(*)
  into v_invalid_count
  from jsonb_array_elements(p_players) as entry(item)
  where nullif(entry.item ->> 'id', '') is not null
    and not exists (
      select 1
      from public.open_play_game_players player
      where player.id = (entry.item ->> 'id')::uuid
        and player.session_id = p_session_id
    );
  if v_invalid_count > 0 then
    raise exception using
      errcode = '22023',
      message = 'A saved rotation player no longer belongs to this session.';
  end if;

  -- Ordinary check-in saves may update, add, or soft-remove players after play
  -- starts, but must not delete/re-key anyone referenced by saved round JSON.
  -- The explicit reset RPC deletes rounds first and can then replace the roster.
  select count(*)
  into v_invalid_count
  from public.open_play_game_players player
  where player.session_id = p_session_id
    and exists (
      select 1
      from public.open_play_game_rounds round
      where round.session_id = p_session_id
    )
    and not exists (
      select 1
      from jsonb_array_elements(p_players) as entry(item)
      where nullif(entry.item ->> 'id', '') is not null
        and (entry.item ->> 'id')::uuid = player.id
    );
  if v_invalid_count > 0 then
    raise exception using
      errcode = '55000',
      message = 'Saved rounds lock existing player IDs. Use the roster reset action to erase history first.';
  end if;

  -- Clearing these inside the transaction permits safe source-registration
  -- swaps without transient unique-index conflicts.
  update public.open_play_game_players
  set source_registration_id = null
  where session_id = p_session_id;

  delete from public.open_play_game_players player
  where player.session_id = p_session_id
    and not exists (
      select 1
      from jsonb_array_elements(p_players) as entry(item)
      where nullif(entry.item ->> 'id', '') is not null
        and (entry.item ->> 'id')::uuid = player.id
    );

  insert into public.open_play_game_players (
    id,
    session_id,
    full_name,
    source_registration_id,
    status,
    seed_order
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
    (entry.ordinality - 1)::integer
  from jsonb_array_elements(p_players) with ordinality as entry(item, ordinality)
  on conflict (id) do update
  set full_name = excluded.full_name,
      source_registration_id = excluded.source_registration_id,
      status = excluded.status,
      seed_order = excluded.seed_order
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

comment on function public.replace_open_play_game_players(uuid, jsonb) is
  'Atomically replaces one Open Play Rotation roster while preserving supplied player IDs.';

-- A roster reset is intentionally separate from an ordinary check-in save.
-- It clears round history and replaces the roster in the same transaction, so
-- either the whole reset succeeds or the original session remains untouched.
create or replace function public.reset_open_play_game_roster(
  p_session_id uuid,
  p_players jsonb
)
returns setof public.open_play_game_players
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  select session.status
  into v_status
  from public.open_play_game_sessions session
  where session.id = p_session_id
  for update;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'The Open Play Rotation session was not found or is not accessible.';
  end if;

  if v_status in ('paused', 'completed', 'cancelled') then
    raise exception using
      errcode = '55000',
      message = 'Resume the session or create a new session before resetting its roster.';
  end if;

  delete from public.open_play_game_rounds
  where session_id = p_session_id;

  update public.open_play_game_sessions
  set current_round = 0,
      status = 'draft',
      updated_at = now()
  where id = p_session_id;

  return query
  select *
  from public.replace_open_play_game_players(p_session_id, p_players);
end;
$$;

revoke all on function public.reset_open_play_game_roster(uuid, jsonb) from public, anon;
grant execute on function public.reset_open_play_game_roster(uuid, jsonb) to authenticated;

comment on function public.reset_open_play_game_roster(uuid, jsonb) is
  'Atomically clears rotation rounds and replaces the roster for a non-terminal, unpaused session.';

-- Round creation participates in the same per-session lock as roster changes.
-- This prevents two managers, or a manager and a roster reset, from committing
-- stale assignments that reference players no longer in the session.
create or replace function public.add_open_play_game_round(
  p_session_id uuid,
  p_round_no integer,
  p_assignments jsonb,
  p_queue_snapshot jsonb,
  p_partner_history jsonb,
  p_opponent_history jsonb,
  p_completed_at timestamptz
)
returns public.open_play_game_rounds
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_mode text;
  v_current_round integer;
  v_team_size integer;
  v_invalid_count integer;
  v_referenced_ids text[];
  v_round public.open_play_game_rounds%rowtype;
begin
  select session.status, session.mode, session.current_round
  into v_status, v_mode, v_current_round
  from public.open_play_game_sessions session
  where session.id = p_session_id
  for update;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'The Open Play Rotation session was not found or is not accessible.';
  end if;

  if v_status in ('paused', 'completed', 'cancelled') then
    raise exception using
      errcode = '55000',
      message = 'Resume the session or create a new session before adding a round.';
  end if;

  if p_round_no is null or p_round_no <> v_current_round + 1 then
    raise exception using
      errcode = '55000',
      message = 'The rotation changed in another manager. Reload it before adding the next round.';
  end if;

  if jsonb_typeof(p_assignments) is distinct from 'array'
     or jsonb_array_length(p_assignments) = 0
     or jsonb_typeof(p_queue_snapshot) is distinct from 'array'
     or jsonb_typeof(p_partner_history) is distinct from 'object'
     or jsonb_typeof(p_opponent_history) is distinct from 'object' then
    raise exception using
      errcode = '22023',
      message = 'The new rotation round has invalid assignment or history data.';
  end if;

  select count(*)
  into v_invalid_count
  from jsonb_array_elements(p_assignments) as game(item)
  where jsonb_typeof(game.item -> 'teamA') is distinct from 'array'
     or jsonb_typeof(game.item -> 'teamB') is distinct from 'array';
  if v_invalid_count > 0 then
    raise exception using
      errcode = '22023',
      message = 'Every rotation game needs two valid teams.';
  end if;

  v_team_size := case
    when split_part(coalesce(v_mode, ''), ':', 1) = 'singles' then 1
    else 2
  end;

  select count(*)
  into v_invalid_count
  from jsonb_array_elements(p_assignments) as game(item)
  where jsonb_array_length(game.item -> 'teamA') <> v_team_size
     or jsonb_array_length(game.item -> 'teamB') <> v_team_size;
  if v_invalid_count > 0 then
    raise exception using
      errcode = '22023',
      message = 'Every rotation game must match the session singles or doubles format.';
  end if;

  select coalesce(array_agg(reference.player_id), array[]::text[])
  into v_referenced_ids
  from (
    select queue_id as player_id
    from jsonb_array_elements_text(p_queue_snapshot) as queue(queue_id)
    union all
    select team_a_id
    from jsonb_array_elements(p_assignments) as game(item)
    cross join lateral jsonb_array_elements_text(game.item -> 'teamA') as team_a(team_a_id)
    union all
    select team_b_id
    from jsonb_array_elements(p_assignments) as game(item)
    cross join lateral jsonb_array_elements_text(game.item -> 'teamB') as team_b(team_b_id)
  ) reference;

  select count(*)
  into v_invalid_count
  from unnest(v_referenced_ids) as reference(player_id)
  where reference.player_id !~
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  if v_invalid_count > 0 then
    raise exception using
      errcode = '22023',
      message = 'The new rotation round contains an invalid player ID.';
  end if;

  select count(*) - count(distinct assigned.player_id::uuid)
  into v_invalid_count
  from (
    select team_a_id as player_id
    from jsonb_array_elements(p_assignments) as game(item)
    cross join lateral jsonb_array_elements_text(game.item -> 'teamA') as team_a(team_a_id)
    union all
    select team_b_id
    from jsonb_array_elements(p_assignments) as game(item)
    cross join lateral jsonb_array_elements_text(game.item -> 'teamB') as team_b(team_b_id)
  ) assigned;
  if v_invalid_count > 0 then
    raise exception using
      errcode = '22023',
      message = 'A player cannot be assigned to two court positions in the same rotation round.';
  end if;

  select count(*) - count(distinct queue.player_id::uuid)
  into v_invalid_count
  from jsonb_array_elements_text(p_queue_snapshot) as queue(player_id);
  if v_invalid_count > 0 then
    raise exception using
      errcode = '22023',
      message = 'A player cannot appear twice in the saved rotation order.';
  end if;

  select count(*)
  into v_invalid_count
  from unnest(v_referenced_ids) as reference(player_id)
  where not exists (
    select 1
    from public.open_play_game_players player
    where player.id = reference.player_id::uuid
      and player.session_id = p_session_id
      and player.status = 'active'
  );
  if v_invalid_count > 0 then
    raise exception using
      errcode = '55000',
      message = 'The roster changed in another manager. Reload it before adding the next round.';
  end if;

  insert into public.open_play_game_rounds (
    session_id,
    round_no,
    assignments,
    queue_snapshot,
    partner_history,
    opponent_history,
    completed_at
  )
  values (
    p_session_id,
    p_round_no,
    p_assignments,
    p_queue_snapshot,
    p_partner_history,
    p_opponent_history,
    p_completed_at
  )
  returning * into v_round;

  update public.open_play_game_sessions
  set current_round = p_round_no,
      status = 'active',
      updated_at = now()
  where id = p_session_id;

  return v_round;
end;
$$;

revoke all on function public.add_open_play_game_round(uuid, integer, jsonb, jsonb, jsonb, jsonb, timestamptz) from public, anon;
grant execute on function public.add_open_play_game_round(uuid, integer, jsonb, jsonb, jsonb, jsonb, timestamptz) to authenticated;

comment on function public.add_open_play_game_round(uuid, integer, jsonb, jsonb, jsonb, jsonb, timestamptz) is
  'Atomically validates and adds the next Open Play Rotation round under the session roster lock.';

create or replace function public.undo_latest_open_play_game_round(
  p_session_id uuid
)
returns public.open_play_game_rounds
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_current_round integer;
  v_round public.open_play_game_rounds%rowtype;
begin
  select session.status, session.current_round
  into v_status, v_current_round
  from public.open_play_game_sessions session
  where session.id = p_session_id
  for update;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'The Open Play Rotation session was not found or is not accessible.';
  end if;

  if v_status in ('paused', 'completed', 'cancelled') then
    raise exception using
      errcode = '55000',
      message = 'Resume the session before undoing a round.';
  end if;

  select round.*
  into v_round
  from public.open_play_game_rounds round
  where round.session_id = p_session_id
  order by round.round_no desc, round.created_at desc, round.id desc
  limit 1;

  if not found then
    return null;
  end if;

  delete from public.open_play_game_rounds
  where id = v_round.id;

  select coalesce(max(round.round_no), 0)
  into v_current_round
  from public.open_play_game_rounds round
  where round.session_id = p_session_id;

  update public.open_play_game_sessions
  set current_round = v_current_round,
      status = case when v_current_round = 0 then 'draft' else 'active' end,
      updated_at = now()
  where id = p_session_id;

  return v_round;
end;
$$;

revoke all on function public.undo_latest_open_play_game_round(uuid) from public, anon;
grant execute on function public.undo_latest_open_play_game_round(uuid) to authenticated;

comment on function public.undo_latest_open_play_game_round(uuid) is
  'Atomically removes the latest Open Play Rotation round under the session roster lock.';

-- Live result and queue edits use optimistic concurrency under the same
-- session lock. A stale manager must reload instead of overwriting another
-- manager's result for a different court.
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
  v_session_id uuid;
  v_status text;
  v_mode text;
  v_current_round integer;
  v_round_no integer;
  v_team_size integer;
  v_invalid_count integer;
  v_current_assignments jsonb;
  v_current_queue_snapshot jsonb;
  v_round public.open_play_game_rounds%rowtype;
begin
  if jsonb_typeof(p_expected_assignments) is distinct from 'array'
     or jsonb_typeof(p_expected_queue_snapshot) is distinct from 'array'
     or jsonb_typeof(p_assignments) is distinct from 'array'
     or jsonb_typeof(p_queue_snapshot) is distinct from 'array' then
    raise exception using
      errcode = '22023',
      message = 'The rotation round update is invalid.';
  end if;

  select round.session_id
  into v_session_id
  from public.open_play_game_rounds round
  where round.id = p_round_id;

  if not found then
    raise exception using
      errcode = '55000',
      message = 'This rotation round no longer exists. Reload the session.';
  end if;

  select session.status, session.mode, session.current_round
  into v_status, v_mode, v_current_round
  from public.open_play_game_sessions session
  where session.id = v_session_id
  for update;

  if not found or v_status <> 'active' then
    raise exception using
      errcode = '55000',
      message = 'This rotation session is no longer active. Reload it before recording changes.';
  end if;

  select round.round_no, round.assignments, round.queue_snapshot
  into v_round_no, v_current_assignments, v_current_queue_snapshot
  from public.open_play_game_rounds round
  where round.id = p_round_id
    and round.session_id = v_session_id;

  if not found or v_round_no <> v_current_round then
    raise exception using
      errcode = '55000',
      message = 'The live rotation changed in another manager. Reload it and try again.';
  end if;

  if jsonb_array_length(p_assignments) = 0 then
    raise exception using
      errcode = '22023',
      message = 'The live rotation must keep at least one court assignment.';
  end if;

  select count(*)
  into v_invalid_count
  from jsonb_array_elements(p_assignments) as game(item)
  where jsonb_typeof(game.item -> 'teamA') is distinct from 'array'
     or jsonb_typeof(game.item -> 'teamB') is distinct from 'array';
  if v_invalid_count > 0 then
    raise exception using
      errcode = '22023',
      message = 'Every rotation game needs two valid teams.';
  end if;

  v_team_size := case
    when split_part(coalesce(v_mode, ''), ':', 1) = 'singles' then 1
    else 2
  end;

  select count(*)
  into v_invalid_count
  from jsonb_array_elements(p_assignments) as game(item)
  where jsonb_array_length(game.item -> 'teamA') <> v_team_size
     or jsonb_array_length(game.item -> 'teamB') <> v_team_size;
  if v_invalid_count > 0 then
    raise exception using
      errcode = '22023',
      message = 'Every rotation game must match the session singles or doubles format.';
  end if;

  select count(*)
  into v_invalid_count
  from (
    select team_a_id as player_id
    from jsonb_array_elements(p_assignments) as game(item)
    cross join lateral jsonb_array_elements_text(game.item -> 'teamA') as team_a(team_a_id)
    union all
    select team_b_id
    from jsonb_array_elements(p_assignments) as game(item)
    cross join lateral jsonb_array_elements_text(game.item -> 'teamB') as team_b(team_b_id)
  ) assigned
  where assigned.player_id !~
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  if v_invalid_count > 0 then
    raise exception using
      errcode = '22023',
      message = 'The live rotation contains an invalid assigned player ID.';
  end if;

  select count(*) - count(distinct assigned.player_id::uuid)
  into v_invalid_count
  from (
    select team_a_id as player_id
    from jsonb_array_elements(p_assignments) as game(item)
    cross join lateral jsonb_array_elements_text(game.item -> 'teamA') as team_a(team_a_id)
    union all
    select team_b_id
    from jsonb_array_elements(p_assignments) as game(item)
    cross join lateral jsonb_array_elements_text(game.item -> 'teamB') as team_b(team_b_id)
  ) assigned;
  if v_invalid_count > 0 then
    raise exception using
      errcode = '22023',
      message = 'A player cannot be assigned to two court positions in the same rotation round.';
  end if;

  select count(*)
  into v_invalid_count
  from (
    select team_a_id as player_id
    from jsonb_array_elements(p_assignments) as game(item)
    cross join lateral jsonb_array_elements_text(game.item -> 'teamA') as team_a(team_a_id)
    union all
    select team_b_id
    from jsonb_array_elements(p_assignments) as game(item)
    cross join lateral jsonb_array_elements_text(game.item -> 'teamB') as team_b(team_b_id)
  ) assigned
  where not exists (
    select 1
    from public.open_play_game_players player
    where player.id = assigned.player_id::uuid
      and player.session_id = v_session_id
  );
  if v_invalid_count > 0 then
    raise exception using
      errcode = '55000',
      message = 'The roster changed in another manager. Reload it before recording live results.';
  end if;

  select count(*)
  into v_invalid_count
  from jsonb_array_elements_text(p_queue_snapshot) as queue(player_id)
  where queue.player_id !~
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  if v_invalid_count > 0 then
    raise exception using
      errcode = '22023',
      message = 'The live rotation queue contains an invalid player ID.';
  end if;

  select count(*) - count(distinct queue.player_id::uuid)
  into v_invalid_count
  from jsonb_array_elements_text(p_queue_snapshot) as queue(player_id);
  if v_invalid_count > 0 then
    raise exception using
      errcode = '22023',
      message = 'A player cannot appear twice in the live rotation queue.';
  end if;

  select count(*)
  into v_invalid_count
  from jsonb_array_elements_text(p_queue_snapshot) as queue(player_id)
  where not exists (
    select 1
    from public.open_play_game_players player
    where player.id = queue.player_id::uuid
      and player.session_id = v_session_id
      and player.status = 'active'
  );
  if v_invalid_count > 0 then
    raise exception using
      errcode = '55000',
      message = 'The checked-in roster changed in another manager. Reload it before changing the queue.';
  end if;

  if v_current_assignments is distinct from p_expected_assignments
     or v_current_queue_snapshot is distinct from p_expected_queue_snapshot then
    raise exception using
      errcode = '40001',
      message = 'The live rotation changed in another manager. Reload it and try again.';
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

comment on function public.update_open_play_game_round(uuid, jsonb, jsonb, jsonb, jsonb) is
  'Atomically updates the latest active rotation round only when the caller has its current version.';

create or replace function public.create_or_open_play_game_session(
  p_date date,
  p_time_label text,
  p_court_ids text[],
  p_court_names text[],
  p_mode text
)
returns public.open_play_game_sessions
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_court_key text;
  v_session public.open_play_game_sessions%rowtype;
begin
  if p_date is null
     or coalesce(cardinality(p_court_ids), 0) = 0
     or cardinality(p_court_ids) is distinct from cardinality(p_court_names)
     or nullif(btrim(p_mode), '') is null then
    raise exception using
      errcode = '22023',
      message = 'Choose a date, valid courts, and a rotation mode before creating the session.';
  end if;

  if (select count(*) <> count(distinct court_id) from unnest(p_court_ids) as court(court_id)) then
    raise exception using
      errcode = '22023',
      message = 'The same court cannot be selected twice.';
  end if;

  select coalesce(string_agg(court_id, ',' order by court_id), '')
  into v_court_key
  from unnest(p_court_ids) as court(court_id);

  perform pg_advisory_xact_lock(hashtextextended(
    p_date::text || chr(31) ||
    coalesce(btrim(p_time_label), '') || chr(31) ||
    v_court_key || chr(31) ||
    btrim(p_mode),
    0
  ));

  select session.*
  into v_session
  from public.open_play_game_sessions session
  where session.date = p_date
    and coalesce(session.time_label, '') = coalesce(btrim(p_time_label), '')
    and session.mode = btrim(p_mode)
    and session.status not in ('completed', 'cancelled')
    and session.court_ids @> p_court_ids
    and session.court_ids <@ p_court_ids
  order by session.created_at desc, session.id desc
  limit 1;

  if found then
    return v_session;
  end if;

  insert into public.open_play_game_sessions (
    date,
    time_label,
    court_ids,
    court_names,
    mode,
    status,
    current_round
  )
  values (
    p_date,
    nullif(btrim(p_time_label), ''),
    p_court_ids,
    p_court_names,
    btrim(p_mode),
    'draft',
    0
  )
  returning * into v_session;

  return v_session;
end;
$$;

revoke all on function public.create_or_open_play_game_session(date, text, text[], text[], text) from public, anon;
grant execute on function public.create_or_open_play_game_session(date, text, text[], text[], text) to authenticated;

comment on function public.create_or_open_play_game_session(date, text, text[], text[], text) is
  'Atomically creates or reuses one non-terminal session for the same date, time, courts, and mode.';

create or replace function public.transition_open_play_game_session(
  p_session_id uuid,
  p_expected_status text,
  p_next_status text
)
returns public.open_play_game_sessions
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_session public.open_play_game_sessions%rowtype;
begin
  select session.*
  into v_session
  from public.open_play_game_sessions session
  where session.id = p_session_id
  for update;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'The Open Play Rotation session was not found or is not accessible.';
  end if;

  if v_session.status in ('completed', 'cancelled') then
    raise exception using
      errcode = '55000',
      message = 'Completed and cancelled rotation sessions cannot be reopened.';
  end if;

  if v_session.status is distinct from p_expected_status then
    raise exception using
      errcode = '40001',
      message = 'The session status changed in another manager. Reload it and try again.';
  end if;

  if not (
    (v_session.status in ('draft', 'active') and p_next_status in ('paused', 'completed'))
    or (v_session.status = 'paused' and p_next_status in ('active', 'completed'))
  ) then
    raise exception using
      errcode = '22023',
      message = 'That rotation session status change is not allowed.';
  end if;

  update public.open_play_game_sessions
  set status = p_next_status,
      updated_at = now()
  where id = p_session_id
  returning * into v_session;

  return v_session;
end;
$$;

revoke all on function public.transition_open_play_game_session(uuid, text, text) from public, anon;
grant execute on function public.transition_open_play_game_session(uuid, text, text) to authenticated;

comment on function public.transition_open_play_game_session(uuid, text, text) is
  'Atomically pauses, resumes, or completes a rotation session using an expected-status check.';

notify pgrst, 'reload schema';

commit;
