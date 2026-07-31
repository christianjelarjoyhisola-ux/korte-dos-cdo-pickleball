-- Make End Session authoritative across every staff browser.
-- Browser state can be stale, so the database serializes roster/round writes
-- against the parent session and rejects mutations after completion.

begin;

-- Legacy clients did not have a uniqueness guard. Preserve every saved round,
-- but normalize duplicate/gapped numbers deterministically before adding one.
with ranked_rounds as (
  select
    round.id,
    row_number() over (
      partition by round.session_id
      order by round.round_no, round.created_at, round.id
    )::integer as normalized_round_no
  from public.open_play_game_rounds round
)
update public.open_play_game_rounds round
   set round_no = ranked.normalized_round_no
  from ranked_rounds ranked
 where round.id = ranked.id
   and round.round_no is distinct from ranked.normalized_round_no;

-- Align historical session metadata with its actual last round. A draft that
-- already owns rounds was effectively active under the legacy client.
with round_state as (
  select round.session_id, max(round.round_no)::integer as current_round
    from public.open_play_game_rounds round
   group by round.session_id
)
update public.open_play_game_sessions session
   set current_round = state.current_round,
       status = case
         when session.status = 'draft' then 'active'
         else session.status
       end
 from round_state state
 where session.id = state.session_id
   and session.status not in ('completed', 'cancelled')
   and (
     session.current_round is distinct from state.current_round
     or session.status = 'draft'
   );

create unique index if not exists idx_op_game_rounds_session_round_no_unique
  on public.open_play_game_rounds(session_id, round_no);

create or replace function public.guard_open_play_game_session_transition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.status in ('completed', 'cancelled')
     and (
       new.status is distinct from old.status
       or new.current_round is distinct from old.current_round
     ) then
    raise exception using
      errcode = '55000',
      message = 'PLAY_MANAGER_SESSION_TERMINAL';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_open_play_game_session_transition
  on public.open_play_game_sessions;
create trigger trg_guard_open_play_game_session_transition
  before update of status, current_round on public.open_play_game_sessions
  for each row execute function public.guard_open_play_game_session_transition();

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
begin
  v_session_id := case when tg_op = 'DELETE' then old.session_id else new.session_id end;

  select session.status, session.current_round
    into v_status, v_current_round
    from public.open_play_game_sessions session
   where session.id = v_session_id
   for update;

  if not found then
    -- Referential cascades may remove child rows after the parent is gone.
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

drop trigger if exists trg_guard_open_play_game_round_mutation
  on public.open_play_game_rounds;
create trigger trg_guard_open_play_game_round_mutation
  before insert or update or delete on public.open_play_game_rounds
  for each row execute function public.guard_open_play_game_round_mutation();

create or replace function public.guard_open_play_game_player_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session_id uuid;
  v_status text;
begin
  v_session_id := case when tg_op = 'DELETE' then old.session_id else new.session_id end;

  if tg_op = 'UPDATE' and new.session_id is distinct from old.session_id then
    raise exception using
      errcode = '22023',
      message = 'PLAY_MANAGER_PLAYER_SESSION_IMMUTABLE';
  end if;

  select session.status
    into v_status
    from public.open_play_game_sessions session
   where session.id = v_session_id
   for update;

  if not found then
    if tg_op = 'DELETE' then return old; end if;
    raise exception using
      errcode = 'P0002',
      message = 'PLAY_MANAGER_SESSION_NOT_FOUND';
  end if;

  if v_status not in ('draft', 'active') then
    raise exception using
      errcode = '55000',
      message = 'PLAY_MANAGER_SESSION_NOT_ACTIVE';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_open_play_game_player_mutation
  on public.open_play_game_players;
create trigger trg_guard_open_play_game_player_mutation
  before insert or update or delete on public.open_play_game_players
  for each row execute function public.guard_open_play_game_player_mutation();

create or replace function public.delete_latest_open_play_game_round_guarded(
  p_session_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_round public.open_play_game_rounds%rowtype;
  v_status text;
  v_current_round integer;
begin
  select *
    into v_round
    from public.open_play_game_rounds round
   where round.session_id = p_session_id
   order by round.round_no desc, round.created_at desc, round.id desc
   limit 1
   for update;

  if not found then
    return null;
  end if;

  select session.status, session.current_round
    into v_status, v_current_round
    from public.open_play_game_sessions session
   where session.id = p_session_id
   for update;

  if v_status is distinct from 'active'
     or v_round.round_no <> coalesce(v_current_round, 0) then
    raise exception using
      errcode = '55000',
      message = 'PLAY_MANAGER_SESSION_NOT_ACTIVE';
  end if;

  delete from public.open_play_game_rounds
   where id = v_round.id;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'PLAY_MANAGER_ROUND_CONFLICT';
  end if;

  return to_jsonb(v_round);
end;
$$;

revoke all on function public.delete_latest_open_play_game_round_guarded(uuid)
  from public, anon;
grant execute on function public.delete_latest_open_play_game_round_guarded(uuid)
  to authenticated, service_role;

create or replace function public.clear_open_play_game_rounds_guarded(
  p_session_id uuid
)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_round public.open_play_game_rounds%rowtype;
  v_status text;
  v_current_round integer;
  v_locked_current_round integer := 0;
  v_deleted integer := 0;
begin
  -- Lock every child first in the same deterministic order used by other
  -- round writers, then lock the parent. This avoids child/parent deadlocks.
  for v_round in
    select *
      from public.open_play_game_rounds round
     where round.session_id = p_session_id
     order by round.round_no desc, round.created_at desc, round.id desc
     for update
  loop
    v_locked_current_round := greatest(v_locked_current_round, v_round.round_no);
  end loop;

  select session.status, session.current_round
    into v_status, v_current_round
    from public.open_play_game_sessions session
   where session.id = p_session_id
   for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'PLAY_MANAGER_SESSION_NOT_FOUND';
  end if;
  if v_status not in ('draft', 'active') then
    raise exception using
      errcode = '55000',
      message = 'PLAY_MANAGER_SESSION_NOT_ACTIVE';
  end if;
  if coalesce(v_current_round, 0) <> v_locked_current_round then
    -- A new round committed between the child-lock scan and parent lock.
    -- Retry rather than reversing the established child-before-parent order.
    raise exception using
      errcode = '40001',
      message = 'PLAY_MANAGER_ROUND_CONFLICT';
  end if;

  loop
    select *
      into v_round
      from public.open_play_game_rounds round
     where round.session_id = p_session_id
     order by round.round_no desc, round.created_at desc, round.id desc
     limit 1
     for update;

    exit when not found;

    delete from public.open_play_game_rounds
     where id = v_round.id;
    v_deleted := v_deleted + 1;
  end loop;

  update public.open_play_game_sessions
     set current_round = 0,
         status = 'draft'
   where id = p_session_id;

  return v_deleted;
end;
$$;

revoke all on function public.clear_open_play_game_rounds_guarded(uuid)
  from public, anon;
grant execute on function public.clear_open_play_game_rounds_guarded(uuid)
  to authenticated, service_role;

-- Replace the original broad policies with operation-specific state checks.
drop policy if exists op_game_rounds_admin_all on public.open_play_game_rounds;
drop policy if exists op_game_rounds_dashboard_all on public.open_play_game_rounds;
drop policy if exists op_game_rounds_authenticated_select on public.open_play_game_rounds;
drop policy if exists op_game_rounds_active_insert on public.open_play_game_rounds;
drop policy if exists op_game_rounds_active_update on public.open_play_game_rounds;
drop policy if exists op_game_rounds_mutable_delete on public.open_play_game_rounds;

create policy op_game_rounds_authenticated_select
  on public.open_play_game_rounds
  for select
  to authenticated
  using (public.has_account_role(array['owner', 'court_owner', 'staff']));

create policy op_game_rounds_active_insert
  on public.open_play_game_rounds
  for insert
  to authenticated
  with check (
    public.has_account_role(array['owner', 'court_owner', 'staff'])
    and exists (
      select 1
        from public.open_play_game_sessions session
       where session.id = open_play_game_rounds.session_id
         and session.status in ('draft', 'active')
    )
  );

create policy op_game_rounds_active_update
  on public.open_play_game_rounds
  for update
  to authenticated
  using (
    public.has_account_role(array['owner', 'court_owner', 'staff'])
    and exists (
      select 1
        from public.open_play_game_sessions session
       where session.id = open_play_game_rounds.session_id
         and session.status = 'active'
    )
  )
  with check (
    public.has_account_role(array['owner', 'court_owner', 'staff'])
    and exists (
      select 1
        from public.open_play_game_sessions session
       where session.id = open_play_game_rounds.session_id
         and session.status = 'active'
    )
  );

create policy op_game_rounds_mutable_delete
  on public.open_play_game_rounds
  for delete
  to authenticated
  using (
    public.has_account_role(array['owner', 'court_owner', 'staff'])
    and exists (
      select 1
        from public.open_play_game_sessions session
       where session.id = open_play_game_rounds.session_id
         and session.status in ('draft', 'active')
    )
  );

drop policy if exists op_game_players_admin_all on public.open_play_game_players;
drop policy if exists op_game_players_dashboard_all on public.open_play_game_players;
drop policy if exists op_game_players_authenticated_select on public.open_play_game_players;
drop policy if exists op_game_players_mutable_insert on public.open_play_game_players;
drop policy if exists op_game_players_mutable_update on public.open_play_game_players;
drop policy if exists op_game_players_mutable_delete on public.open_play_game_players;

create policy op_game_players_authenticated_select
  on public.open_play_game_players
  for select
  to authenticated
  using (public.has_account_role(array['owner', 'court_owner', 'staff']));

create policy op_game_players_mutable_insert
  on public.open_play_game_players
  for insert
  to authenticated
  with check (
    public.has_account_role(array['owner', 'court_owner', 'staff'])
    and exists (
      select 1
        from public.open_play_game_sessions session
       where session.id = open_play_game_players.session_id
         and session.status in ('draft', 'active')
    )
  );

create policy op_game_players_mutable_update
  on public.open_play_game_players
  for update
  to authenticated
  using (
    public.has_account_role(array['owner', 'court_owner', 'staff'])
    and exists (
      select 1
        from public.open_play_game_sessions session
       where session.id = open_play_game_players.session_id
         and session.status in ('draft', 'active')
    )
  )
  with check (
    public.has_account_role(array['owner', 'court_owner', 'staff'])
    and exists (
      select 1
        from public.open_play_game_sessions session
       where session.id = open_play_game_players.session_id
         and session.status in ('draft', 'active')
    )
  );

create policy op_game_players_mutable_delete
  on public.open_play_game_players
  for delete
  to authenticated
  using (
    public.has_account_role(array['owner', 'court_owner', 'staff'])
    and exists (
      select 1
        from public.open_play_game_sessions session
       where session.id = open_play_game_players.session_id
         and session.status in ('draft', 'active')
    )
  );

notify pgrst, 'reload schema';

commit;
