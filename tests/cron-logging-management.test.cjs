const test = require('node:test');
const assert = require('node:assert/strict');
const env = { SUPABASE_ACCESS_TOKEN: 'test-only', SUPABASE_PROJECT_REF: 'zcuufcpkgidmaanxjufo' };
const state = { statement_logging: 'on', run_history: 'on', min_messages: 'warning', min_error_statement: 'error',
  pending_restart: false, schedule_fingerprint: [[1,'* * * * *',true,'hash']], recent_successes: 5,
  database_started_at: '2026-10-17 00:00:00+00', successes_since_restart: 5 };
const response = data => ({ ok: true, json: async () => data });

test('plan reads state without changing configuration or restarting', async () => {
  const { manageCronLogging } = await import('../tools/manage-cron-logging.mjs');
  let calls = 0;
  const result = await manageCronLogging('plan', env, async (url, options) => {
    calls++; assert.ok(url.endsWith('/database/query')); assert.match(JSON.parse(options.body).query, /^select/);
    return response([state]);
  });
  assert.equal(calls, 1); assert.equal(result.requires_authorized_restart, true);
  assert.deepEqual(result.proposed, { 'cron.log_statement': false, restart_database: true });
});

test('apply requires explicit restart authorization before mutation', async () => {
  const { manageCronLogging } = await import('../tools/manage-cron-logging.mjs');
  let calls = 0;
  await assert.rejects(manageCronLogging('apply', env, async () => { calls++; return response([state]); }), /authorized/);
  assert.equal(calls, 1);
});

test('apply changes only routine cron logging and verifies job history and schedules', async () => {
  const { manageCronLogging } = await import('../tools/manage-cron-logging.mjs');
  let mutations = 0;
  const result = await manageCronLogging('apply', { ...env, ALLOW_DATABASE_RESTART: 'yes' }, async (url, options) => {
    if (url.endsWith('/config/database/postgres')) {
      mutations++; assert.equal(options.method, 'PUT');
      assert.deepEqual(JSON.parse(options.body), { 'cron.log_statement': false, restart_database: true });
      return response({});
    }
    return response([{ ...state, statement_logging: mutations ? 'off' : 'on',
      database_started_at: mutations ? '2026-10-17 16:00:00+00' : state.database_started_at }]);
  }, async () => {});
  assert.equal(mutations, 1); assert.equal(result.schedules_and_error_reporting_unchanged, true);
});

test('an uncertain mutation is not automatically retried', async () => {
  const { manageCronLogging } = await import('../tools/manage-cron-logging.mjs');
  let mutations = 0;
  await assert.rejects(manageCronLogging('apply', { ...env, ALLOW_DATABASE_RESTART: 'yes' }, async url => {
    if (url.endsWith('/config/database/postgres')) { mutations++; throw new Error('response lost'); }
    return response([state]);
  }), /response lost/);
  assert.equal(mutations, 1);
});

test('existing pending restart or disabled run history blocks changes', async () => {
  const { manageCronLogging, stateQuery } = await import('../tools/manage-cron-logging.mjs');
  assert.match(stateQuery, /exists\(select 1 from pg_settings where pending_restart\)/);
  for (const override of [{ pending_restart: true }, { run_history: 'off' }]) {
    let calls = 0;
    await assert.rejects(manageCronLogging('apply', { ...env, ALLOW_DATABASE_RESTART: 'yes' }, async () => {
      calls++; return response([{ ...state, ...override }]);
    }));
    assert.equal(calls, 1);
  }
});
