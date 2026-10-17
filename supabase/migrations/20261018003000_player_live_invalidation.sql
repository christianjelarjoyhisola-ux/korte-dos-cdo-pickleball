begin;

-- Deployment enables this only after an anonymous end-to-end database
-- broadcast probe. Until then every existing board keeps its polling path.
insert into public.private_settings(key, value)
values ('player_live_broadcast_enabled', 'false') on conflict (key) do nothing;

create or replace function public.player_live_update_topic(p_token_hash bytea)
returns text language sql immutable security definer set search_path = '' as $$
  select 'player-live:' || encode(extensions.digest(
    'player-live-v1:' || encode(p_token_hash, 'hex'), 'sha256'), 'hex');
$$;
revoke all on function public.player_live_update_topic(bytea) from public, anon, authenticated, service_role;

create or replace function public.emit_player_live_invalidation(p_token_hash bytea)
returns void language plpgsql security definer set search_path = '' as $$
declare
  topic text;
  seen jsonb;
begin
  if p_token_hash is null or not exists (
    select 1 from public.private_settings where key = 'player_live_broadcast_enabled' and value = 'true'
  ) then return; end if;
  topic := public.player_live_update_topic(p_token_hash);
  begin
    seen := coalesce(nullif(current_setting('korte.player_live_notified', true), ''), '[]')::jsonb;
    if jsonb_typeof(seen) <> 'array' then seen := '[]'::jsonb; end if;
  exception when others then seen := '[]'::jsonb;
  end;
  if seen ? topic then return; end if;
  -- Transaction-local, including when a whole roster is replaced. No token,
  -- token hash, row, player name, or score is published in the hint payload.
  perform set_config('korte.player_live_notified', (seen || jsonb_build_array(topic))::text, true);
  begin
    perform realtime.send('{}'::jsonb, 'changed', topic, false);
  exception when others then
    -- Realtime is an optimization; a transport failure cannot reject a score
    -- or roster write. The bounded client reconciliation repairs missed hints.
    raise warning 'Player live invalidation unavailable (SQLSTATE %)', sqlstate;
  end;
end;
$$;
revoke all on function public.emit_player_live_invalidation(bytea) from public, anon, authenticated, service_role;

create or replace function public.notify_player_live_session_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  old_session uuid;
  new_session uuid;
  share_hash bytea;
begin
  if tg_table_name = 'open_play_game_session_shares' then
    -- Deleted/rotated capabilities must receive their last hint directly;
    -- selecting only the new share table would miss their revocation.
    if tg_op <> 'INSERT' then perform public.emit_player_live_invalidation(old.token_hash); end if;
    if tg_op <> 'DELETE' then perform public.emit_player_live_invalidation(new.token_hash); end if;
    return null;
  end if;
  if tg_op <> 'INSERT' then
    if tg_table_name = 'open_play_game_sessions' then old_session := old.id;
    else old_session := old.session_id; end if;
  end if;
  if tg_op <> 'DELETE' then
    if tg_table_name = 'open_play_game_sessions' then new_session := new.id;
    else new_session := new.session_id; end if;
  end if;
  for share_hash in
    select share.token_hash from public.open_play_game_session_shares share
    where share.session_id in (old_session, new_session) and share.expires_at > now()
  loop
    perform public.emit_player_live_invalidation(share_hash);
  end loop;
  return null;
exception when others then
  raise warning 'Player live change hint unavailable (SQLSTATE %)', sqlstate;
  return null;
end;
$$;
revoke all on function public.notify_player_live_session_change() from public, anon, authenticated, service_role;

drop trigger if exists player_live_session_changed on public.open_play_game_sessions;
create trigger player_live_session_changed after insert or update or delete on public.open_play_game_sessions
for each row execute function public.notify_player_live_session_change();
drop trigger if exists player_live_player_changed on public.open_play_game_players;
create trigger player_live_player_changed after insert or update or delete on public.open_play_game_players
for each row execute function public.notify_player_live_session_change();
drop trigger if exists player_live_round_changed on public.open_play_game_rounds;
create trigger player_live_round_changed after insert or update or delete on public.open_play_game_rounds
for each row execute function public.notify_player_live_session_change();
drop trigger if exists player_live_share_changed on public.open_play_game_session_shares;
create trigger player_live_share_changed after insert or update or delete on public.open_play_game_session_shares
for each row execute function public.notify_player_live_session_change();

-- Keep the latest complete ranking/visibility implementation exactly once.
-- Replaying this migration must never rename the wrapper into its own backup.
do $$
begin
  if to_regprocedure('public.get_public_open_play_game_live_board_before_updates(text)') is null then
    alter function public.get_public_open_play_game_live_board(text)
      rename to get_public_open_play_game_live_board_before_updates;
  end if;
end;
$$;
revoke all on function public.get_public_open_play_game_live_board_before_updates(text)
  from public, anon, authenticated, service_role;

create or replace function public.get_public_open_play_game_live_board(p_share_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  board jsonb;
  capability record;
begin
  board := public.get_public_open_play_game_live_board_before_updates(p_share_token);
  if board is null then return null; end if;
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null or not exists (
    select 1 from public.private_settings where key = 'player_live_broadcast_enabled' and value = 'true'
  ) then return board; end if;
  select share.token_hash,
    least(share.expires_at, case when session.status = 'completed'
      then session.updated_at + interval '24 hours' else share.expires_at end) as expires_at
  into capability
  from public.open_play_game_session_shares share
  join public.open_play_game_sessions session on session.id = share.session_id
  where share.token_hash = extensions.digest(p_share_token, 'sha256') and share.expires_at > now()
  limit 1;
  if not found then return board; end if;
  return board || jsonb_build_object('liveUpdates', jsonb_build_object(
    'mode', 'broadcast', 'topic', public.player_live_update_topic(capability.token_hash),
    'expiresAt', capability.expires_at, 'reconcileMs', 60000
  ));
end;
$$;
revoke all on function public.get_public_open_play_game_live_board(text) from public;
grant execute on function public.get_public_open_play_game_live_board(text) to anon, authenticated, service_role;

insert into supabase_migrations.schema_migrations(version, name, statements)
values ('20261018003000', 'player_live_invalidation', array['capability-scoped empty broadcast hints with polling fallback'])
on conflict (version) do nothing;
notify pgrst, 'reload schema';
commit;
