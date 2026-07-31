-- Allow an authorized operator to correct only the recorded winner of a
-- completed match. Queue order and court rotation history remain unchanged,
-- and every correction is appended to the match JSON as an audit record.

begin;

create or replace function public.guard_open_play_game_round_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session_id uuid;
  v_status text;
  v_current_round integer;
  v_is_result_correction boolean :=
    coalesce(current_setting('app.play_manager_result_correction', true), '') = 'on';
begin
  v_session_id := case when tg_op = 'DELETE' then old.session_id else new.session_id end;

  select session.status, session.current_round
    into v_status, v_current_round
    from public.open_play_game_sessions session
   where session.id = v_session_id
   for update;

  if not found then
    if tg_op = 'DELETE' then return old; end if;
    raise exception using
      errcode = 'P0002',
      message = 'PLAY_MANAGER_SESSION_NOT_FOUND';
  end if;

  if tg_op = 'INSERT' then
    if v_status not in ('draft', 'active') then
      raise exception using
        errcode = '55000',
        message = 'PLAY_MANAGER_SESSION_NOT_ACTIVE';
    end if;
    if new.round_no <> coalesce(v_current_round, 0) + 1 then
      raise exception using
        errcode = '40001',
        message = 'PLAY_MANAGER_ROUND_CONFLICT';
    end if;

    update public.open_play_game_sessions
       set status = 'active',
           current_round = new.round_no
     where id = v_session_id;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.session_id is distinct from old.session_id
       or new.round_no is distinct from old.round_no then
      raise exception using
        errcode = '22023',
        message = 'PLAY_MANAGER_ROUND_IDENTITY_IMMUTABLE';
    end if;

    if v_is_result_correction then
      if v_status not in ('active', 'paused', 'completed')
         or new.queue_snapshot is distinct from old.queue_snapshot
         or new.partner_history is distinct from old.partner_history
         or new.opponent_history is distinct from old.opponent_history
         or new.completed_at is distinct from old.completed_at then
        raise exception using
          errcode = '55000',
          message = 'PLAY_MANAGER_RESULT_CORRECTION_INVALID';
      end if;
      return new;
    end if;

    if v_status <> 'active'
       or old.round_no <> coalesce(v_current_round, 0)
       or exists (
         select 1
           from public.open_play_game_rounds newer
          where newer.session_id = old.session_id
            and newer.round_no > old.round_no
       ) then
      raise exception using
        errcode = '55000',
        message = 'PLAY_MANAGER_SESSION_NOT_ACTIVE';
    end if;
    return new;
  end if;

  if v_status not in ('draft', 'active') then
    raise exception using
      errcode = '55000',
      message = 'PLAY_MANAGER_SESSION_NOT_ACTIVE';
  end if;
  if old.round_no <> coalesce(v_current_round, 0) then
    raise exception using
      errcode = '40001',
      message = 'PLAY_MANAGER_ROUND_CONFLICT';
  end if;

  update public.open_play_game_sessions
     set current_round = (
       select coalesce(max(round.round_no), 0)
         from public.open_play_game_rounds round
        where round.session_id = old.session_id
          and round.id <> old.id
     )
   where id = v_session_id;
  return old;
end;
$$;

create or replace function public.correct_open_play_game_match_winner(
  p_round_id uuid,
  p_expected_assignments jsonb,
  p_court_index integer,
  p_completed_game_index integer,
  p_expected_winner text,
  p_new_winner text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_round public.open_play_game_rounds%rowtype;
  v_session_status text;
  v_game jsonb;
  v_result jsonb;
  v_result_path text[];
  v_current_winner text;
  v_corrections jsonb;
  v_assignments jsonb;
  v_corrected_at timestamptz := clock_timestamp();
begin
  if p_court_index is null or p_court_index < 0
     or p_completed_game_index is not null and p_completed_game_index < 0
     or p_expected_winner not in ('A', 'B')
     or p_new_winner not in ('A', 'B')
     or p_new_winner = p_expected_winner then
    raise exception using
      errcode = '22023',
      message = 'PLAY_MANAGER_WINNER_CORRECTION_INVALID';
  end if;

  select *
    into v_round
    from public.open_play_game_rounds round
   where round.id = p_round_id
   for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'PLAY_MANAGER_ROUND_NOT_FOUND';
  end if;

  if v_round.assignments <> coalesce(p_expected_assignments, '[]'::jsonb) then
    raise exception using
      errcode = '40001',
      message = 'PLAY_MANAGER_ROUND_CONFLICT';
  end if;

  select session.status
    into v_session_status
    from public.open_play_game_sessions session
   where session.id = v_round.session_id;

  if v_session_status in ('active', 'paused') then
    if not public.has_account_role(array['owner', 'court_owner', 'staff']) then
      raise exception using
        errcode = '42501',
        message = 'PLAY_MANAGER_WINNER_CORRECTION_FORBIDDEN';
    end if;
  elsif v_session_status = 'completed' then
    if not public.has_account_role(array['owner']) then
      raise exception using
        errcode = '42501',
        message = 'PLAY_MANAGER_WINNER_CORRECTION_OWNER_REQUIRED';
    end if;
  else
    raise exception using
      errcode = '55000',
      message = 'PLAY_MANAGER_WINNER_CORRECTION_SESSION_LOCKED';
  end if;

  if jsonb_typeof(v_round.assignments) <> 'array' then
    raise exception using
      errcode = '23514',
      message = 'PLAY_MANAGER_WINNER_CORRECTION_ASSIGNMENTS_INVALID';
  end if;

  v_game := v_round.assignments -> p_court_index;
  if v_game is null or jsonb_typeof(v_game) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'PLAY_MANAGER_WINNER_CORRECTION_MATCH_NOT_FOUND';
  end if;

  if p_completed_game_index is null then
    v_result := v_game;
    v_result_path := array[p_court_index::text];
  else
    if jsonb_typeof(v_game -> 'completedGames') <> 'array' then
      raise exception using
        errcode = '22023',
        message = 'PLAY_MANAGER_WINNER_CORRECTION_MATCH_NOT_FOUND';
    end if;
    v_result := v_game -> 'completedGames' -> p_completed_game_index;
    v_result_path := array[
      p_court_index::text,
      'completedGames',
      p_completed_game_index::text
    ];
  end if;

  if v_result is null or jsonb_typeof(v_result) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'PLAY_MANAGER_WINNER_CORRECTION_MATCH_NOT_FOUND';
  end if;

  v_current_winner := nullif(v_result ->> 'winner', '');
  if v_current_winner is distinct from p_expected_winner then
    raise exception using
      errcode = '40001',
      message = 'PLAY_MANAGER_WINNER_CORRECTION_CHANGED';
  end if;

  v_corrections := case
    when jsonb_typeof(v_result -> 'winnerCorrections') = 'array'
      then v_result -> 'winnerCorrections'
    else '[]'::jsonb
  end;
  v_corrections := v_corrections || jsonb_build_array(jsonb_build_object(
    'previousWinner', v_current_winner,
    'winner', p_new_winner,
    'correctedAt', v_corrected_at,
    'correctedBy', auth.uid()
  ));

  v_result := jsonb_set(v_result, '{winner}', to_jsonb(p_new_winner), false);
  v_result := jsonb_set(v_result, '{winnerCorrections}', v_corrections, true);
  v_assignments := jsonb_set(v_round.assignments, v_result_path, v_result, false);

  perform set_config('app.play_manager_result_correction', 'on', true);
  update public.open_play_game_rounds
     set assignments = v_assignments
   where id = v_round.id
  returning * into v_round;
  perform set_config('app.play_manager_result_correction', 'off', true);

  return to_jsonb(v_round);
end;
$$;

revoke all on function public.correct_open_play_game_match_winner(
  uuid, jsonb, integer, integer, text, text
) from public;
revoke all on function public.correct_open_play_game_match_winner(
  uuid, jsonb, integer, integer, text, text
) from anon;
grant execute on function public.correct_open_play_game_match_winner(
  uuid, jsonb, integer, integer, text, text
) to authenticated;

notify pgrst, 'reload schema';

commit;
