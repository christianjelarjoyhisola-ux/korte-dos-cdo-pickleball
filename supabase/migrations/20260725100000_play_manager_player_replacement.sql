-- Atomically replace one player in a live court slot. The database, rather
-- than the browser, owns the assignment mutation and resulting queue.

begin;

drop function if exists public.replace_open_play_game_court_player(
  uuid, jsonb, jsonb, jsonb, jsonb, uuid, uuid, boolean
);
drop function if exists public.replace_open_play_game_court_player(
  uuid, jsonb, jsonb, integer, text, integer, uuid, uuid, text, boolean
);

create function public.replace_open_play_game_court_player(
  p_round_id uuid,
  p_expected_assignments jsonb,
  p_expected_queue_snapshot jsonb,
  p_court_index integer,
  p_team text,
  p_slot_index integer,
  p_outgoing_player_id uuid,
  p_incoming_player_id uuid default null,
  p_incoming_player_name text default null,
  p_mark_outgoing_removed boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_round public.open_play_game_rounds%rowtype;
  v_outgoing public.open_play_game_players%rowtype;
  v_incoming public.open_play_game_players%rowtype;
  v_session_status text;
  v_team_key text;
  v_game jsonb;
  v_assignments jsonb;
  v_queue_snapshot jsonb;
  v_incoming_name text := nullif(btrim(coalesce(p_incoming_player_name, '')), '');
  v_assigned_ids text[] := array[]::text[];
  v_queue_ids text[] := array[]::text[];
  v_queue_id text;
  v_created_walk_in boolean := false;
begin
  if p_court_index is null or p_court_index < 0
     or p_slot_index is null or p_slot_index < 0
     or p_team is null
     or p_team not in ('A', 'B') then
    raise exception using
      errcode = '22023',
      message = 'PLAY_MANAGER_REPLACEMENT_SLOT_INVALID';
  end if;

  if (p_incoming_player_id is null and v_incoming_name is null)
     or (p_incoming_player_id is not null and v_incoming_name is not null) then
    raise exception using
      errcode = '22023',
      message = 'PLAY_MANAGER_REPLACEMENT_PLAYER_REQUIRED';
  end if;

  select *
    into v_round
    from public.open_play_game_rounds
   where id = p_round_id
   for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'PLAY_MANAGER_ROUND_NOT_FOUND';
  end if;

  if v_round.assignments <> coalesce(p_expected_assignments, '[]'::jsonb)
     or v_round.queue_snapshot <> coalesce(p_expected_queue_snapshot, '[]'::jsonb) then
    raise exception using
      errcode = '40001',
      message = 'PLAY_MANAGER_ROUND_CONFLICT';
  end if;

  select status
    into v_session_status
    from public.open_play_game_sessions
   where id = v_round.session_id;

  if v_session_status is distinct from 'active'
     or v_round.completed_at is not null
     or exists (
       select 1
         from public.open_play_game_rounds newer
        where newer.session_id = v_round.session_id
          and newer.round_no > v_round.round_no
     ) then
    raise exception using
      errcode = '55000',
      message = 'PLAY_MANAGER_SESSION_NOT_ACTIVE';
  end if;

  v_team_key := case when p_team = 'A' then 'teamA' else 'teamB' end;
  if jsonb_typeof(v_round.assignments) <> 'array' then
    raise exception using
      errcode = '23514',
      message = 'PLAY_MANAGER_REPLACEMENT_ASSIGNMENTS_INVALID';
  end if;
  v_game := v_round.assignments -> p_court_index;

  if v_game is null
     or jsonb_typeof(v_game) <> 'object'
     or jsonb_typeof(v_game -> v_team_key) <> 'array'
     or nullif(v_game ->> 'winner', '') is not null
     or v_game #>> array[v_team_key, p_slot_index::text] is distinct from p_outgoing_player_id::text then
    raise exception using
      errcode = '40001',
      message = 'PLAY_MANAGER_REPLACEMENT_SLOT_CHANGED';
  end if;

  select *
    into v_outgoing
    from public.open_play_game_players
   where id = p_outgoing_player_id
     and session_id = v_round.session_id
     and status = 'active'
   for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'PLAY_MANAGER_REPLACEMENT_PLAYER_NOT_ACTIVE';
  end if;

  if p_incoming_player_id is not null then
    if p_incoming_player_id = p_outgoing_player_id then
      raise exception using
        errcode = '22023',
        message = 'PLAY_MANAGER_REPLACEMENT_SAME_PLAYER';
    end if;

    select *
      into v_incoming
      from public.open_play_game_players
     where id = p_incoming_player_id
       and session_id = v_round.session_id
       and status = 'active'
     for update;

    if not found then
      raise exception using
        errcode = '22023',
        message = 'PLAY_MANAGER_REPLACEMENT_PLAYER_NOT_ACTIVE';
    end if;

    if exists (
      select 1
        from jsonb_array_elements(v_round.assignments) as game(value)
       where nullif(game.value ->> 'winner', '') is null
         and (
           coalesce(game.value -> 'teamA', '[]'::jsonb)
             @> jsonb_build_array(v_incoming.id::text)
           or coalesce(game.value -> 'teamB', '[]'::jsonb)
             @> jsonb_build_array(v_incoming.id::text)
         )
    ) then
      raise exception using
        errcode = '22023',
        message = 'PLAY_MANAGER_REPLACEMENT_PLAYER_ALREADY_PLAYING';
    end if;
  else
    if char_length(v_incoming_name) > 90 then
      raise exception using
        errcode = '22001',
        message = 'PLAY_MANAGER_REPLACEMENT_NAME_TOO_LONG';
    end if;

    if exists (
      select 1
        from public.open_play_game_players player
       where player.session_id = v_round.session_id
         and lower(btrim(player.full_name)) = lower(v_incoming_name)
    ) then
      raise exception using
        errcode = '23505',
        message = 'PLAY_MANAGER_REPLACEMENT_DUPLICATE_NAME';
    end if;

    insert into public.open_play_game_players (
      session_id,
      full_name,
      source_registration_id,
      status,
      seed_order
    )
    values (
      v_round.session_id,
      v_incoming_name,
      null,
      'active',
      coalesce((
        select max(player.seed_order) + 1
          from public.open_play_game_players player
         where player.session_id = v_round.session_id
      ), 0)
    )
    returning * into v_incoming;

    v_created_walk_in := true;
  end if;

  v_assignments := jsonb_set(
    v_round.assignments,
    array[p_court_index::text, v_team_key, p_slot_index::text],
    to_jsonb(v_incoming.id::text),
    false
  );
  v_assignments := jsonb_set(
    v_assignments,
    array[p_court_index::text, 'startedAt'],
    to_jsonb(to_char(
      clock_timestamp() at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )),
    true
  );

  if coalesce(p_mark_outgoing_removed, false) then
    update public.open_play_game_players
       set status = 'removed'
     where id = v_outgoing.id
       and session_id = v_round.session_id;
  end if;

  select coalesce(array_agg(assigned.player_id), array[]::text[])
    into v_assigned_ids
    from (
      select player_id
        from jsonb_array_elements(v_assignments) as game(value)
        cross join lateral jsonb_array_elements_text(
          coalesce(game.value -> 'teamA', '[]'::jsonb)
        ) as ids(player_id)
       where nullif(game.value ->> 'winner', '') is null
      union all
      select player_id
        from jsonb_array_elements(v_assignments) as game(value)
        cross join lateral jsonb_array_elements_text(
          coalesce(game.value -> 'teamB', '[]'::jsonb)
        ) as ids(player_id)
       where nullif(game.value ->> 'winner', '') is null
    ) assigned;

  if cardinality(v_assigned_ids) <> (
    select count(distinct player_id)
      from unnest(v_assigned_ids) as ids(player_id)
  ) then
    raise exception using
      errcode = '23514',
      message = 'PLAY_MANAGER_REPLACEMENT_DUPLICATE_ASSIGNMENT';
  end if;

  if exists (
    select 1
      from unnest(v_assigned_ids) as ids(player_id)
     where not exists (
       select 1
         from public.open_play_game_players player
        where player.id::text = ids.player_id
          and player.session_id = v_round.session_id
          and player.status = 'active'
     )
  ) then
    raise exception using
      errcode = '23514',
      message = 'PLAY_MANAGER_REPLACEMENT_PLAYER_NOT_ACTIVE';
  end if;

  for v_queue_id in
    select queued.player_id
      from jsonb_array_elements_text(
        coalesce(v_round.queue_snapshot, '[]'::jsonb)
      ) with ordinality as queued(player_id, position)
     order by queued.position
  loop
    if v_queue_id <> p_outgoing_player_id::text
       and not (v_queue_id = any(v_assigned_ids))
       and not (v_queue_id = any(v_queue_ids))
       and exists (
         select 1
           from public.open_play_game_players player
          where player.id::text = v_queue_id
            and player.session_id = v_round.session_id
            and player.status = 'active'
       ) then
      v_queue_ids := array_append(v_queue_ids, v_queue_id);
    end if;
  end loop;

  for v_queue_id in
    select player.id::text
      from public.open_play_game_players player
     where player.session_id = v_round.session_id
       and player.status = 'active'
       and player.id <> p_outgoing_player_id
       and not (player.id::text = any(v_assigned_ids))
     order by player.seed_order, player.created_at, player.id
  loop
    if not (v_queue_id = any(v_queue_ids)) then
      v_queue_ids := array_append(v_queue_ids, v_queue_id);
    end if;
  end loop;

  if not coalesce(p_mark_outgoing_removed, false) then
    v_queue_ids := array_append(v_queue_ids, p_outgoing_player_id::text);
  end if;

  v_queue_snapshot := to_jsonb(v_queue_ids);

  update public.open_play_game_rounds
     set assignments = v_assignments,
         queue_snapshot = v_queue_snapshot
   where id = v_round.id
  returning * into v_round;

  return jsonb_build_object(
    'round', to_jsonb(v_round),
    'incoming_player', to_jsonb(v_incoming),
    'created_walk_in', v_created_walk_in
  );
end;
$$;

revoke all on function public.replace_open_play_game_court_player(
  uuid, jsonb, jsonb, integer, text, integer, uuid, uuid, text, boolean
) from public;
revoke all on function public.replace_open_play_game_court_player(
  uuid, jsonb, jsonb, integer, text, integer, uuid, uuid, text, boolean
) from anon;
grant execute on function public.replace_open_play_game_court_player(
  uuid, jsonb, jsonb, integer, text, integer, uuid, uuid, text, boolean
) to authenticated;
grant execute on function public.replace_open_play_game_court_player(
  uuid, jsonb, jsonb, integer, text, integer, uuid, uuid, text, boolean
) to service_role;

commit;
