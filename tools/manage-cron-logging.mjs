import { pathToFileURL } from 'node:url';

const PROJECT = 'zcuufcpkgidmaanxjufo';
export const stateQuery = `select
  current_setting('cron.log_statement') as statement_logging,
  current_setting('cron.log_run') as run_history,
  current_setting('log_min_messages') as min_messages,
  current_setting('log_min_error_statement') as min_error_statement,
  pg_postmaster_start_time()::text as database_started_at,
  exists(select 1 from pg_settings where pending_restart) as pending_restart,
  (select coalesce(jsonb_agg(jsonb_build_array(jobid,schedule,active,md5(command)) order by jobid),'[]') from cron.job) as schedule_fingerprint,
  (select count(*) from cron.job_run_details where status='succeeded' and start_time>now()-interval '5 minutes') as recent_successes,
  (select count(*) from cron.job_run_details where status='succeeded' and start_time>pg_postmaster_start_time()
    and start_time>now()-interval '5 minutes') as successes_since_restart;`;

export async function manageCronLogging(action, env = process.env, fetcher = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  if (!['plan', 'apply', 'restore', 'verify'].includes(action) || !env.SUPABASE_ACCESS_TOKEN
    || env.SUPABASE_PROJECT_REF !== PROJECT) throw new Error('Expected a supported action and configured project credentials');
  const base = `https://api.supabase.com/v1/projects/${PROJECT}`;
  const headers = { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
  async function request(path, method, body) {
    const response = await fetcher(`${base}${path}`, {
      method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Cron logging request failed: HTTP ${response.status}`); }
    const data = await response.json();
    if (data?.error) throw new Error('Cron logging query rejected');
    return data;
  }
  async function readState() {
    const rows = await request('/database/query', 'POST', { query: stateQuery });
    const row = rows?.[0];
    if (!row || !['on','off'].includes(row.statement_logging) || row.run_history !== 'on'
      || !Array.isArray(row.schedule_fingerprint)) throw new Error('Expected cron run history and valid database state');
    return row;
  }
  const before = await readState();
  const summary = row => ({ statement_logging: row.statement_logging, run_history: row.run_history,
    pending_restart: row.pending_restart === true, active_schedules: row.schedule_fingerprint.filter(job => job[2] === true).length,
    recent_successes: Number(row.recent_successes) });
  const desired = action === 'restore' ? 'on' : 'off';
  if (action === 'plan') return { action, current: summary(before), proposed: { 'cron.log_statement': false, restart_database: true },
    preserves: ['cron.log_run', 'error reporting', 'notification schedules'], requires_authorized_restart: true };
  if (action === 'verify') {
    if (before.statement_logging !== 'off' || before.pending_restart || Number(before.recent_successes) < 1) {
      throw new Error('Cron logging change or recent job execution is not verified');
    }
    return { action, verified: summary(before) };
  }
  if (before.statement_logging === desired && !before.pending_restart) return { action, already_applied: true, verified: summary(before) };
  if (env.ALLOW_DATABASE_RESTART !== 'yes') throw new Error('An explicitly authorized production database restart is required');
  if (before.pending_restart) throw new Error('An existing pending database restart must be reviewed first');
  // PUT is the documented Supabase endpoint. Only one log setting changes.
  // Do not retry this mutation if its response is lost: it may have restarted.
  await request('/config/database/postgres', 'PUT', { 'cron.log_statement': desired === 'on', restart_database: true });
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(10_000);
    let after;
    try { after = await readState(); } catch { continue; }
    if (JSON.stringify(after.schedule_fingerprint) !== JSON.stringify(before.schedule_fingerprint)
      || after.min_messages !== before.min_messages || after.min_error_statement !== before.min_error_statement) {
      throw new Error('Post-restart schedules or error logging differ; inspect before further changes');
    }
    if (after.statement_logging === desired && !after.pending_restart
      && after.database_started_at !== before.database_started_at && Number(after.successes_since_restart) > 0) {
      return { action, verified: summary(after), schedules_and_error_reporting_unchanged: true };
    }
  }
  throw new Error('Change submitted but restart verification is incomplete; inspect before retrying');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await manageCronLogging(process.argv[2]), null, 2)); }
  catch (error) {
    console.error(error instanceof Error && /^(Expected|Cron logging|An |Post-restart|Change submitted)/.test(error.message)
      ? error.message : 'Cron logging operation failed; inspect state before retrying');
    process.exitCode = 1;
  }
}
