import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { isEmptyProbePayload } from './player-live-probe.mjs';

const project = 'zcuufcpkgidmaanxjufo';
const action = process.argv[2];
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!['rehearse', 'apply', 'verify', 'probe-enable', 'disable'].includes(action)
  || !token || process.env.SUPABASE_PROJECT_REF !== project) {
  throw new Error('Expected a supported action and the configured production deployment credential');
}

const verification = `do $verify$
declare signature text; function_id regprocedure;
begin
  foreach signature in array array[
    'public.player_live_update_topic(bytea)', 'public.emit_player_live_invalidation(bytea)',
    'public.notify_player_live_session_change()',
    'public.get_public_open_play_game_live_board_before_updates(text)'
  ] loop
    function_id := to_regprocedure(signature);
    if function_id is null then raise exception 'Missing live update implementation'; end if;
    if has_function_privilege('anon', function_id, 'execute')
      or has_function_privilege('authenticated', function_id, 'execute')
      or has_function_privilege('service_role', function_id, 'execute') then
      raise exception 'Unsafe internal live update permissions';
    end if;
  end loop;
  function_id := to_regprocedure('public.get_public_open_play_game_live_board(text)');
  if function_id is null or not has_function_privilege('anon', function_id, 'execute')
    or not has_function_privilege('authenticated', function_id, 'execute') then
    raise exception 'Public live board is unavailable';
  end if;
  if (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
    and t.tgfoid='public.notify_player_live_session_change()'::regprocedure
    and t.tgenabled='O' and t.tgtype=29 and (c.relname,t.tgname) in (
      ('open_play_game_sessions','player_live_session_changed'),
      ('open_play_game_players','player_live_player_changed'),
      ('open_play_game_rounds','player_live_round_changed'),
      ('open_play_game_session_shares','player_live_share_changed'))) <> 4 then
    raise exception 'Live board change triggers are missing';
  end if;
  if not exists(select 1 from public.private_settings where key='player_live_broadcast_enabled'
    and value in ('true','false')) then raise exception 'Live update capability flag is missing'; end if;
  if not exists(select 1 from supabase_migrations.schema_migrations where version='20261018003000') then
    raise exception 'Live update migration history is missing';
  end if;
  if public.get_public_open_play_game_live_board('invalid-deployment-probe') is not null then
    raise exception 'Invalid share tokens must remain inaccessible';
  end if;
end $verify$;`;

async function query(sql, timeoutMs = 120_000) {
  // An uncertain mutation response must be inspected, never automatically replayed.
  const response = await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Live update ${action} failed (HTTP ${response.status}); inspect deployment state before retrying`);
  }
  const result = await response.json();
  if (result?.error) throw new Error('Live update database operation was rejected');
  return result;
}

async function probeAndEnable() {
  await query(verification);
  console.log('Live board database functions and permissions verified.');
  const config = await readFile(new URL('../supabase-config.js', import.meta.url), 'utf8');
  const anonKey = config.match(/const SUPABASE_ANON_KEY\s*=\s*'([^']+)'/)?.[1];
  if (!anonKey || !config.includes(`https://${project}.supabase.co`)) throw new Error('Public client configuration unavailable');
  const client = createClient(`https://${project}.supabase.co`, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: { timeout: 3000, disconnectOnEmptyChannelsAfterMs: 0 },
  });
  const topic = `player-live-probe:${randomUUID()}`;
  const channel = client.channel(topic, { config: { private: false } });
  let receive;
  const received = new Promise(resolve => { receive = resolve; });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Database broadcast probe timed out; live polling remains available')), 25_000);
  });
  try {
    await Promise.race([timeout, (async () => {
      await new Promise((resolve, reject) => {
        channel.on('broadcast', { event: 'changed' }, message => {
          if (isEmptyProbePayload(message.payload)) receive();
        }).subscribe(status => {
          if (status === 'SUBSCRIBED') resolve();
          else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) reject(new Error('Public broadcast unavailable'));
        });
      });
      console.log('Anonymous public probe channel subscribed.');
      // Random, non-customer topic; no session, token, name or score is used.
      await query(`select realtime.send('{}'::jsonb, 'changed', '${topic}', false);`, 15_000);
      const diagnostic = await query(`select count(*)::integer as probe_rows,
        count(*) filter(where not private and event='changed')::integer as public_changed_rows
        from realtime.messages where topic='${topic}';`, 10_000);
      // Only counts for our freshly generated dummy topic are printed.
      const row = diagnostic?.[0];
      console.log(JSON.stringify({ probe_rows: Number(row?.probe_rows), public_changed_rows: Number(row?.public_changed_rows) }));
      await received;
    })()]);
    clearTimeout(timer);
    await query(`update public.private_settings set value='true' where key='player_live_broadcast_enabled';`);
    console.log('Anonymous database-to-browser broadcast probe passed; live updates enabled.');
  } finally {
    clearTimeout(timer);
    await client.removeChannel(channel);
    await client.realtime.disconnect();
  }
}

try {
  if (action === 'probe-enable') await probeAndEnable();
  else if (action === 'verify') await query(verification);
  else if (action === 'disable') await query("update public.private_settings set value='false' where key='player_live_broadcast_enabled';");
  else {
    const migration = await readFile(new URL('../supabase/migrations/20261018003000_player_live_invalidation.sql', import.meta.url), 'utf8');
    if (!/^begin;/i.test(migration.trimStart()) || !/commit;\s*$/i.test(migration)) throw new Error('Expected transactional migration');
    await query(migration.replace(/commit;\s*$/i, `${verification}\n${action === 'rehearse' ? 'rollback' : 'commit'};`));
  }
  console.log(`Player live updates ${action} succeeded.`);
} catch (error) {
  // Never dump request objects, tokens or database response bodies.
  console.error(error instanceof Error && /^(Live update|Public broadcast|Database broadcast|Expected|Public client)/.test(error.message)
    ? error.message : 'Player live update deployment failed; inspect aggregate diagnostics.');
  process.exitCode = 1;
}
// This one-shot CLI has finished every database operation and cleanup above.
// Realtime SDK internal disconnect timers otherwise keep CI alive for a minute.
process.exit(process.exitCode || 0);
