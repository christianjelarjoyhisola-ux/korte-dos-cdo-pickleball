-- Harden live-share lifecycle after the initial player-board release:
-- * allow independent links from multiple staff browsers without silent rotation
-- * expire every bearer link after at most 24 hours
-- * reject link creation for sessions that cannot be viewed
-- * expose a cumulative result count without returning round history

begin;

alter table public.open_play_game_session_shares
  add column if not exists id uuid default gen_random_uuid();

update public.open_play_game_session_shares
   set id = gen_random_uuid()
 where id is null;

alter table public.open_play_game_session_shares
  alter column id set not null;

alter table public.open_play_game_session_shares
  drop constraint if exists open_play_game_session_shares_pkey;

alter table public.open_play_game_session_shares
  add constraint open_play_game_session_shares_pkey primary key (id);

create index if not exists idx_open_play_game_session_shares_session
  on public.open_play_game_session_shares(session_id);

alter table public.open_play_game_session_shares
  add column if not exists expires_at timestamptz;

update public.open_play_game_session_shares
   set expires_at = created_at + interval '24 hours'
 where expires_at is null;

alter table public.open_play_game_session_shares
  alter column expires_at set default (now() + interval '24 hours'),
  alter column expires_at set not null;

create or replace function public.set_open_play_game_public_share(
  p_session_id uuid,
  p_enabled boolean
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token text;
  v_status text;
  v_updated_at timestamptz;
  v_expires_at timestamptz;
begin
  if auth.uid() is null or not exists (
    select 1
      from public.accounts account
     where account.id = auth.uid()
       and account.status = 'active'
       and account.role in ('owner', 'court_owner', 'staff')
  ) then
    raise exception using
      errcode = '42501',
      message = 'PLAY_MANAGER_SHARE_NOT_ALLOWED';
  end if;

  select session.status, session.updated_at
    into v_status, v_updated_at
    from public.open_play_game_sessions session
   where session.id = p_session_id
   for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'PLAY_MANAGER_SESSION_NOT_FOUND';
  end if;

  if not coalesce(p_enabled, false) then
    delete from public.open_play_game_session_shares
     where session_id = p_session_id;
    return null;
  end if;

  if coalesce(v_status, '') not in ('active', 'paused', 'completed')
     or (
       v_status = 'completed'
       and (
         v_updated_at is null
         or v_updated_at < now() - interval '24 hours'
       )
     ) then
    raise exception using
      errcode = '55000',
      message = 'PLAY_MANAGER_SESSION_NOT_SHAREABLE';
  end if;

  delete from public.open_play_game_session_shares
   where session_id = p_session_id
     and expires_at <= now();

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_expires_at := case
    when v_status = 'completed'
      then least(now() + interval '24 hours', v_updated_at + interval '24 hours')
    else now() + interval '24 hours'
  end;

  insert into public.open_play_game_session_shares (
    session_id,
    token_hash,
    created_at,
    rotated_at,
    expires_at
  )
  values (
    p_session_id,
    extensions.digest(v_token, 'sha256'),
    now(),
    now(),
    v_expires_at
  );

  return v_token;
end;
$$;

revoke all on function public.set_open_play_game_public_share(uuid, boolean)
  from public, anon;
grant execute on function public.set_open_play_game_public_share(uuid, boolean)
  to authenticated, service_role;

drop function if exists public.rotate_open_play_game_public_share(uuid);

create function public.rotate_open_play_game_public_share(
  p_session_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token text;
begin
  -- The delegated setter authorizes the caller and locks the session row,
  -- serializing rotation against normal issuance for the same session.
  v_token := public.set_open_play_game_public_share(p_session_id, true);

  delete from public.open_play_game_session_shares
   where session_id = p_session_id
     and token_hash <> extensions.digest(v_token, 'sha256');

  return v_token;
end;
$$;

revoke all on function public.rotate_open_play_game_public_share(uuid)
  from public, anon;
grant execute on function public.rotate_open_play_game_public_share(uuid)
  to authenticated, service_role;

-- Preserve the already-audited narrow projection as an owner-only helper, then
-- wrap it with expiry enforcement and one additional aggregate.
alter function public.get_public_open_play_game_live_board(text)
  rename to get_public_open_play_game_live_board_v1;

revoke all on function public.get_public_open_play_game_live_board_v1(text)
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
  v_session_id uuid;
  v_board jsonb;
  v_result_count integer := 0;
begin
  if p_share_token is null
     or char_length(p_share_token) <> 64
     or p_share_token !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  select share.session_id
    into v_session_id
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

  v_board := public.get_public_open_play_game_live_board_v1(p_share_token);
  if v_board is null then
    return null;
  end if;

  with game_events as (
    select game.value as game
      from public.open_play_game_rounds round
      cross join lateral jsonb_array_elements(
        coalesce(round.assignments, '[]'::jsonb)
      ) as game(value)
     where round.session_id = v_session_id
    union all
    select completed.value as game
      from public.open_play_game_rounds round
      cross join lateral jsonb_array_elements(
        coalesce(round.assignments, '[]'::jsonb)
      ) as current_game(value)
      cross join lateral jsonb_array_elements(
        case
          when jsonb_typeof(current_game.value -> 'completedGames') = 'array'
            then current_game.value -> 'completedGames'
          else '[]'::jsonb
        end
      ) as completed(value)
     where round.session_id = v_session_id
  )
  select count(*)::integer
    into v_result_count
    from game_events event
   where event.game ->> 'winner' in ('A', 'B');

  return v_board || jsonb_build_object('resultCount', v_result_count);
end;
$$;

revoke all on function public.get_public_open_play_game_live_board(text)
  from public;
grant execute on function public.get_public_open_play_game_live_board(text)
  to anon, authenticated, service_role;

commit;
