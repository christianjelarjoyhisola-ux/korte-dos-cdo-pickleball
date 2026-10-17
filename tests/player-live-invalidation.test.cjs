const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, beforeEach, afterEach, after } = require('node:test');
const { PGlite } = require('@electric-sql/pglite');
const migration = fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261018003000_player_live_invalidation.sql'),'utf8');
const tokenA='a'.repeat(64), tokenB='b'.repeat(64), tokenC='c'.repeat(64);
const sessionA='00000000-0000-4000-8000-000000000001', sessionB='00000000-0000-4000-8000-000000000002';
const expectedTopic = token => 'player-live:'+crypto.createHash('sha256').update('player-live-v1:'+crypto.createHash('sha256').update(token).digest('hex')).digest('hex');
let db;
const scalar = async sql => Object.values((await db.query(sql)).rows[0])[0];
const board = async token => (await db.query('select get_public_open_play_game_live_board($1) as board',[token])).rows[0].board;
const hints = async () => (await db.query('select payload,event,topic,is_private from realtime.fixture_messages order by topic')).rows;
const clearHints = async () => db.exec("truncate realtime.fixture_messages; select set_config('korte.player_live_notified','[]',true)");
const enable = async () => db.exec("update private_settings set value='true' where key='player_live_broadcast_enabled'");
async function share(token,session=sessionA,expiry='1 hour') {
  await db.query("insert into open_play_game_session_shares(session_id,token_hash,expires_at) values($1,extensions.digest($2,'sha256'),now()+$3::interval)",[session,token,expiry]);
}

before(async()=>{
  db=new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema extensions;
    create function extensions.digest(text,text) returns bytea language sql immutable as $$select sha256(convert_to($1,'UTF8'))$$;
    create schema supabase_migrations;
    create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);
    create table private_settings(key text primary key,value text);
    create table open_play_game_sessions(id uuid primary key,status text,updated_at timestamptz default now(),current_round int default 0);
    create table open_play_game_players(id uuid primary key default gen_random_uuid(),session_id uuid references open_play_game_sessions on delete cascade,full_name text);
    create table open_play_game_rounds(id uuid primary key default gen_random_uuid(),session_id uuid references open_play_game_sessions on delete cascade,assignments jsonb);
    create table open_play_game_session_shares(id uuid primary key default gen_random_uuid(),session_id uuid references open_play_game_sessions on delete cascade,token_hash bytea unique,expires_at timestamptz);
    alter table open_play_game_session_shares enable row level security;
    revoke all on open_play_game_session_shares,private_settings from public,anon,authenticated;
    create sequence fixture_original_calls;
    create function get_public_open_play_game_live_board(p_share_token text) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
    declare result jsonb;
    begin
      perform nextval('fixture_original_calls');
      if p_share_token is null or p_share_token !~ '^[0-9a-f]{64}$' then return null; end if;
      select jsonb_build_object('generatedAt',now(),'session',jsonb_build_object('status',s.status),
        'players',jsonb_build_array('Fixture Player'),'standings',jsonb_build_array(jsonb_build_object('points',7)),
        'ratingSystem',jsonb_build_object('mode','performance')) into result
      from open_play_game_session_shares h join open_play_game_sessions s on s.id=h.session_id
      where h.token_hash=extensions.digest(p_share_token,'sha256') and h.expires_at>now()
        and (s.status in ('active','paused') or (s.status='completed' and s.updated_at>=now()-interval '24 hours'));
      return result;
    end; $$;
    grant execute on function get_public_open_play_game_live_board(text) to anon,authenticated,service_role;
    create schema realtime;
    create table realtime.fixture_messages(payload jsonb,event text,topic text,is_private boolean);
    create function realtime.send(payload jsonb,event text,topic text,private boolean) returns void language plpgsql as $$
    begin
      if current_setting('fixture.realtime_fail',true)='true' then raise exception 'sensitive transport detail'; end if;
      insert into realtime.fixture_messages values(payload,event,topic,private);
    end; $$;
  `);
  await db.exec(migration);
});
beforeEach(async()=>{
  await db.exec(`begin;
    truncate open_play_game_sessions,open_play_game_players,open_play_game_rounds,open_play_game_session_shares,realtime.fixture_messages;
    update private_settings set value='false' where key='player_live_broadcast_enabled';
    select set_config('korte.player_live_notified','[]',true),set_config('fixture.realtime_fail','false',true);
    insert into open_play_game_sessions(id,status) values('${sessionA}','active'),('${sessionB}','paused');
  `);
});
afterEach(async()=>db.exec('rollback'));
after(async()=>{if(db)await db.close();});

test('disabled capability preserves the original board exactly and calls it once',async()=>{
  await share(tokenA);
  const beforeCalls=await scalar('select case when is_called then last_value else 0 end from fixture_original_calls');
  const result=await board(tokenA);
  const calls=await scalar('select last_value from fixture_original_calls');
  assert.equal(Number(calls)-Number(beforeCalls),1);
  assert.equal(result.liveUpdates,undefined);
  const original=(await db.query('select get_public_open_play_game_live_board_before_updates($1) as board',[tokenA])).rows[0].board;
  assert.deepEqual(result,original);
  assert.equal(Number(await scalar('select last_value from fixture_original_calls'))-Number(calls),1);
  assert.equal((await hints()).length,0);
});

test('enabled metadata is domain-separated, preserves ranking fields, and caps completed visibility',async()=>{
  await share(tokenA,sessionA,'3 hours'); await enable();
  await db.exec(`update open_play_game_sessions set status='completed',updated_at=now()-interval '23 hours' where id='${sessionA}'`);
  const result=await board(tokenA);
  assert.deepEqual(result.standings,[{points:7}]);
  assert.equal(result.ratingSystem.mode,'performance');
  assert.equal(result.liveUpdates.mode,'broadcast'); assert.equal(result.liveUpdates.reconcileMs,60000);
  assert.equal(result.liveUpdates.topic,expectedTopic(tokenA));
  assert.equal(Date.parse(result.liveUpdates.expiresAt)-Date.parse(result.generatedAt),3600000);
  assert.ok(!JSON.stringify(result).includes(tokenA));
  assert.ok(!JSON.stringify(result).includes(crypto.createHash('sha256').update(tokenA).digest('hex')));
});

test('unknown, revoked, expired and otherwise unshareable boards remain null',async()=>{
  await share(tokenA,sessionA,'-1 second'); await share(tokenB,sessionB); await enable();
  assert.equal(await board('invalid'),null); assert.equal(await board(tokenA),null); assert.equal(await board(tokenC),null);
  await db.exec(`update open_play_game_sessions set status='completed',updated_at=now()-interval '25 hours' where id='${sessionB}'`);
  assert.equal(await board(tokenB),null);
  await db.exec(`update open_play_game_sessions set status='active' where id='${sessionB}'; delete from open_play_game_session_shares where session_id='${sessionB}'`);
  assert.equal(await board(tokenB),null);
});

test('all three game tables emit only empty hints and roster bursts deduplicate per transaction',async()=>{
  await share(tokenA); await share(tokenB); await share(tokenC,sessionB); await enable();
  const actions=[
    `update open_play_game_sessions set current_round=1 where id='${sessionA}'`,
    `insert into open_play_game_players(session_id,full_name) values('${sessionA}','Sensitive Name')`,
    "update open_play_game_players set full_name='Another Private Name'",
    'delete from open_play_game_players',
    `insert into open_play_game_rounds(session_id,assignments) values('${sessionA}','[{"secret":"score data"}]')`,
    "update open_play_game_rounds set assignments='[]'",
    'delete from open_play_game_rounds',
  ];
  for(const action of actions){
    await clearHints(); await db.exec(action);
    assert.deepEqual(await hints(),[tokenA,tokenB].map(t=>({payload:{},event:'changed',topic:expectedTopic(t),is_private:false})).sort((a,b)=>a.topic.localeCompare(b.topic)));
  }
  await clearHints();
  await db.exec(`insert into open_play_game_players(session_id,full_name) select '${sessionA}','Player '||n from generate_series(1,100)n;
    update open_play_game_players set full_name=full_name||' updated';
    update open_play_game_sessions set current_round=2 where id='${sessionA}'`);
  assert.equal((await hints()).length,2,'one message per active share for the entire transaction');
});

test('moving a child invalidates old and new sessions without exposing expired capabilities',async()=>{
  await share(tokenA); await share(tokenB,sessionB); await share(tokenC,sessionA,'-1 second');
  await db.exec(`insert into open_play_game_players(session_id,full_name) values('${sessionA}','Player')`); await enable();
  await db.exec(`update open_play_game_players set session_id='${sessionB}'`);
  assert.deepEqual((await hints()).map(h=>h.topic).sort(),[expectedTopic(tokenA),expectedTopic(tokenB)].sort());
});

test('transaction-local dedupe resets after commit so later score changes still broadcast',async()=>{
  await share(tokenA);await enable();
  await db.exec(`update open_play_game_sessions set current_round=1 where id='${sessionA}';
    update open_play_game_sessions set current_round=2 where id='${sessionA}'`);
  assert.equal((await hints()).length,1);
  await db.exec(`commit;begin;update open_play_game_sessions set current_round=3 where id='${sessionA}'`);
  assert.equal((await hints()).length,2,'a new transaction emits another hint');
});

test('share rotation and deletion notify the old topic, including session cascade deletion',async()=>{
  await share(tokenA); await enable();
  await db.query("update open_play_game_session_shares set token_hash=extensions.digest($1,'sha256')",[tokenB]);
  assert.deepEqual((await hints()).map(h=>h.topic).sort(),[expectedTopic(tokenA),expectedTopic(tokenB)].sort());
  assert.equal(await board(tokenA),null);
  await clearHints(); await db.exec('delete from open_play_game_session_shares');
  assert.deepEqual((await hints()).map(h=>h.topic),[expectedTopic(tokenB)]);
  await share(tokenC); await clearHints();
  await db.exec(`delete from open_play_game_sessions where id='${sessionA}'`);
  assert.deepEqual((await hints()).map(h=>h.topic),[expectedTopic(tokenC)]);
});

test('broadcast failures never reject a game write or publish private diagnostics',async()=>{
  await share(tokenA); await enable();
  await db.exec("select set_config('fixture.realtime_fail','true',true)");
  await db.exec(`update open_play_game_sessions set current_round=7 where id='${sessionA}';
    insert into open_play_game_players(session_id,full_name) values('${sessionA}','Player')`);
  assert.equal(await scalar(`select current_round from open_play_game_sessions where id='${sessionA}'`),7);
  assert.equal(Number(await scalar('select count(*) from open_play_game_players')),1);
  assert.equal((await hints()).length,0);
  assert.match(migration,/raise warning 'Player live invalidation unavailable \(SQLSTATE %\)', sqlstate/);
});

test('missing broadcast infrastructure withholds capability even when the flag is enabled',async()=>{
  await share(tokenA); await enable();
  await db.exec('drop function realtime.send(jsonb,text,text,boolean)');
  assert.equal((await board(tokenA)).liveUpdates,undefined);
  await db.exec(`update open_play_game_sessions set current_round=8 where id='${sessionA}'`);
  assert.equal(await scalar(`select current_round from open_play_game_sessions where id='${sessionA}'`),8);
});

test('replay keeps one original implementation and grants no browser access to helpers or tables',async()=>{
  await share(tokenA); await enable();
  const original=await scalar("select pg_get_functiondef('get_public_open_play_game_live_board_before_updates(text)'::regprocedure)");
  await db.exec(migration.replace(/^begin;/,'').replace(/commit;\s*$/,''));
  assert.equal(await scalar("select pg_get_functiondef('get_public_open_play_game_live_board_before_updates(text)'::regprocedure)"),original);
  assert.equal((await board(tokenA)).liveUpdates.topic,expectedTopic(tokenA));
  for(const role of ['anon','authenticated','service_role']) {
    assert.equal(await scalar(`select has_function_privilege('${role}','get_public_open_play_game_live_board(text)','execute')`),true);
    for(const fn of ['player_live_update_topic(bytea)','emit_player_live_invalidation(bytea)','notify_player_live_session_change()','get_public_open_play_game_live_board_before_updates(text)'])
      assert.equal(await scalar(`select has_function_privilege('${role}','${fn}','execute')`),false);
  }
  for(const role of ['anon','authenticated']) for(const table of ['open_play_game_session_shares','open_play_game_sessions','open_play_game_players','open_play_game_rounds','private_settings'])
    assert.equal(await scalar(`select has_table_privilege('${role}','${table}','select')`),false);
  assert.equal(Number(await scalar("select count(*) from pg_trigger where tgname like 'player_live_%'")),4);
});
