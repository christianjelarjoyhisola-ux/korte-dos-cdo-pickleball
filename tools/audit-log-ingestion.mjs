import { pathToFileURL } from 'node:url';

// One-shot diagnostics only. Queries never select command text, message text,
// request parameters, credentials or customer data. Do not add arbitrary SQL inputs.
const PROJECT_REF = 'zcuufcpkgidmaanxjufo';
const LOG_SETTINGS = [
  'log_statement', 'log_duration', 'log_min_duration_statement', 'log_min_duration_sample',
  'log_statement_sample_rate', 'log_transaction_sample_rate', 'log_min_messages',
  'log_min_error_statement', 'log_connections', 'log_disconnections', 'log_checkpoints',
  'log_autovacuum_min_duration', 'log_lock_waits', 'log_temp_files',
  'cron.log_statement', 'cron.log_run', 'auto_explain.log_min_duration',
  'auto_explain.sample_rate', 'auto_explain.log_analyze', 'auto_explain.log_verbose',
  'pgaudit.log', 'pgaudit.log_level', 'pgaudit.log_parameter', 'pgaudit.log_relation',
];
const JOBS = ['process-payment-review-notifications', 'process-admin-device-notifications', 'process-host-balance-deadlines'];
const ROLES = ['anon', 'authenticated', 'postgres', 'service_role', 'authenticator',
  'supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin', 'supabase_read_only_user'];
const SOURCES = ['edge_logs', 'postgres_logs', 'postgrest_logs', 'auth_logs', 'auth_audit_logs',
  'storage_logs', 'realtime_logs', 'function_edge_logs', 'function_logs', 'supavisor_logs',
  'pgbouncer_logs', 'pg_upgrade_logs', 'multigres_logs'];
const PG_CATEGORIES = ['error', 'cron_start', 'cron_completion', 'statement', 'duration',
  'connection', 'checkpoint', 'autovacuum', 'other'];
const ROUTES = {
  public_booking_slots: '/rest/v1/rpc/public_booking_slots',
  public_open_play_counts: '/rest/v1/rpc/public_open_play_counts',
  player_live_board: '/rest/v1/rpc/get_public_open_play_game_live_board',
  public_featured_court: '/rest/v1/rpc/get_public_featured_court_hour',
  public_campaign_offers: '/rest/v1/rpc/get_public_demand_campaign_slot_offers',
  public_featured_offers: '/rest/v1/rpc/get_public_demand_campaign_featured_offers',
  public_settings: '/rest/v1/rpc/public_settings',
  legacy_live_board: '/rest/v1/rpc/get_public_open_play_game_session',
  host_bookings: '/rest/v1/rpc/get_my_host_bookings',
  expire_stale_holds: '/rest/v1/rpc/expire_stale_verifying_bookings',
  featured_event: '/rest/v1/rpc/record_public_featured_court_event',
  courts: '/rest/v1/courts',
  bookings: '/rest/v1/bookings',
  blocked_dates: '/rest/v1/blocked_dates',
  settings: '/rest/v1/settings',
  open_play_sessions: '/rest/v1/open_play_host_sessions',
  open_play_registrations: '/rest/v1/open_play_host_session_registrations',
  device_notifications: '/functions/v1/manage-device-notifications',
  review_notifications: '/functions/v1/process-payment-review-notifications',
  host_balance_deadlines: '/functions/v1/process-host-balance-deadlines',
  receipt_verification: '/functions/v1/verify-gcash-receipt',
};
const ROUTE_CATEGORIES = [...Object.keys(ROUTES), 'other_rpc', 'other_rest', 'other_function',
  'auth', 'storage', 'realtime', 'other'];
const quotedList = values => values.map(value => `'${value}'`).join(',');
const settingsList = quotedList(LOG_SETTINGS);

export const auditSql = {
  settings: `select name, setting, unit, context, pending_restart from pg_catalog.pg_settings
    where name in (${settingsList}) order by name;`,
  role_logging: `select r.oid::text as role_id,
    case when r.rolname in (${quotedList(ROLES)}) then r.rolname else 'custom_role' end as role,
    split_part(c.value, '=', 1) as name, substring(c.value from position('=' in c.value) + 1) as setting
    from pg_catalog.pg_roles r cross join lateral unnest(r.rolconfig) c(value)
    where split_part(c.value, '=', 1) in (${settingsList}) order by r.oid, name;`,
  database_role_logging: `select s.setrole::text as role_id, s.setdatabase::text as database_id,
    split_part(c.value, '=', 1) as name, substring(c.value from position('=' in c.value) + 1) as setting
    from pg_catalog.pg_db_role_setting s cross join lateral unnest(s.setconfig) c(value)
    where split_part(c.value, '=', 1) in (${settingsList}) order by s.setrole, s.setdatabase, name;`,
  cron_jobs: `select jobid::text as job_id,
    case when jobname in (${quotedList(JOBS)}) then jobname else 'other_job' end as job,
    schedule, active, (position('dispatch_due_notification_worker' in command) > 0) as due_work_gated
    from cron.job order by jobid;`,
  cron_runs: `select jobid::text as job_id,
    count(*)::text as runs, count(*) filter (where status = 'succeeded')::text as succeeded,
    count(*) filter (where status = 'failed')::text as failed,
    count(*) filter (where status not in ('succeeded', 'failed'))::text as other_status,
    coalesce(round(avg(extract(epoch from (end_time - start_time)))::numeric, 3), 0)::text as average_seconds
    from cron.job_run_details where start_time >= now() - interval '24 hours'
    group by jobid order by jobid;`,
};

// Current API uses ClickHouse and a unified logs table. Counts are not bytes or
// billable ingestion. No undocumented byte field or serialized billing estimate.
// https://supabase.com/docs/guides/observability/advanced-log-filtering
export const logQueries = {
  log_sources: 'select source, count() as events from logs group by source order by events desc limit 30',
  postgres_categories: `select multiIf(
    upper(log_attributes['parsed.error_severity']) in ('ERROR', 'FATAL', 'PANIC'), 'error',
    event_message ilike 'cron job % starting:%', 'cron_start',
    event_message ilike 'cron job % completed%' or event_message ilike 'cron job % command completed%', 'cron_completion',
    event_message ilike 'statement:%' or event_message ilike 'execute %', 'statement',
    event_message ilike 'duration:%', 'duration',
    event_message ilike 'connection %' or event_message ilike 'disconnection:%', 'connection',
    event_message ilike 'checkpoint %' or event_message ilike 'restartpoint %', 'checkpoint',
    event_message ilike 'automatic vacuum%' or event_message ilike 'automatic analyze%', 'autovacuum',
    'other') as category, count() as events
    from logs where source = 'postgres_logs' group by category order by events desc limit 20`,
  gateway_routes: `select multiIf(
    ${Object.entries(ROUTES).map(([label, path]) => `log_attributes['request.path'] = '${path}', '${label}'`).join(',\n    ')},
    startsWith(log_attributes['request.path'], '/rest/v1/rpc/'), 'other_rpc',
    startsWith(log_attributes['request.path'], '/rest/'), 'other_rest',
    startsWith(log_attributes['request.path'], '/functions/'), 'other_function',
    startsWith(log_attributes['request.path'], '/auth/'), 'auth',
    startsWith(log_attributes['request.path'], '/storage/'), 'storage',
    startsWith(log_attributes['request.path'], '/realtime/'), 'realtime', 'other') as route,
    multiIf(toInt32OrZero(log_attributes['response.status_code']) between 200 and 299, '2xx',
      toInt32OrZero(log_attributes['response.status_code']) between 300 and 399, '3xx',
      toInt32OrZero(log_attributes['response.status_code']) between 400 and 499, '4xx',
      toInt32OrZero(log_attributes['response.status_code']) between 500 and 599, '5xx', 'unknown') as status_class,
    count() as events from logs where source = 'edge_logs'
    group by route, status_class order by events desc limit 100`,
};

const numberText = value => /^\d+(?:\.\d+)?$/.test(String(value)) ? String(value) : null;
const known = (value, values, fallback = 'other') => values.includes(value) ? value : fallback;
function loggingValue(value) {
  const text = String(value ?? '');
  if (/^-?\d+(?:\.\d+)?(?:us|ms|s|min|h|d)?$/.test(text)) return text;
  if (text.split(',').every(part => ['on', 'off', 'true', 'false', 'none', 'all', 'ddl', 'mod',
    'debug5', 'debug4', 'debug3', 'debug2', 'debug1', 'info', 'notice', 'warning', 'error',
    'log', 'fatal', 'panic', 'read', 'write', 'function', 'role', 'misc', 'misc_set',
    '-read', '-write', '-function', '-role', '-ddl', '-misc', '-misc_set'].includes(part.trim().toLowerCase()))) return text;
  return 'unrecognized_value';
}

export function sanitizeRows(section, rows) {
  if (!Array.isArray(rows) || rows.length > 1000) throw new Error('Unexpected aggregate result');
  return rows.map(row => {
    if (!row || typeof row !== 'object') throw new Error('Unexpected aggregate row');
    if (section === 'settings') return {
      name: known(row.name, LOG_SETTINGS), setting: loggingValue(row.setting),
      unit: known(row.unit, ['us', 'ms', 's', 'min', 'h', 'd', 'B', 'kB', 'MB', 'GB'], null),
      context: known(row.context, ['internal', 'postmaster', 'sighup', 'superuser-backend', 'backend', 'superuser', 'user']),
      pending_restart: row.pending_restart === true,
    };
    if (section === 'role_logging' || section === 'database_role_logging') return {
      role_id: numberText(row.role_id), ...(section === 'role_logging'
        ? { role: known(row.role, ROLES, 'custom_role') } : { database_id: numberText(row.database_id) }),
      name: known(row.name, LOG_SETTINGS), setting: loggingValue(row.setting),
    };
    if (section === 'cron_jobs') return {
      job_id: numberText(row.job_id), job: known(row.job, JOBS, 'other_job'),
      schedule: typeof row.schedule === 'string' && /^[\d\s*\/,\-]{1,80}$/.test(row.schedule) ? row.schedule : 'other_schedule',
      active: row.active === true, due_work_gated: row.due_work_gated === true,
    };
    if (section === 'cron_runs') return Object.fromEntries(
      ['job_id', 'runs', 'succeeded', 'failed', 'other_status', 'average_seconds'].map(key => [key, numberText(row[key])]),
    );
    if (section === 'log_sources') return { source: known(row.source, SOURCES), events: numberText(row.events) };
    if (section === 'postgres_categories') return { category: known(row.category, PG_CATEGORIES), events: numberText(row.events) };
    if (section === 'gateway_routes') return {
      route: known(row.route, ROUTE_CATEGORIES), status_class: known(row.status_class, ['2xx', '3xx', '4xx', '5xx'], 'unknown'),
      events: numberText(row.events),
    };
    throw new Error('Unknown diagnostic section');
  });
}

async function requestAggregate(url, options, section, fetcher) {
  try {
    const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      await response.body?.cancel();
      return { available: false, http_status: response.status };
    }
    const data = await response.json();
    if (data?.error) return { available: false, http_status: response.status, reason: 'query_rejected' };
    const rows = Array.isArray(data) ? data : data?.result;
    return { available: true, rows: sanitizeRows(section, rows) };
  } catch {
    // Do not print fetch errors, response bodies or SQL errors: they can contain
    // URLs, request details or credentials. An unavailable source is not zero.
    return { available: false, reason: 'request_or_result_unavailable' };
  }
}

export async function runAudit(env = process.env, fetcher = fetch, now = Date.now()) {
  const token = env.SUPABASE_ACCESS_TOKEN;
  if (!token || (env.SUPABASE_PROJECT_REF && env.SUPABASE_PROJECT_REF !== PROJECT_REF)) {
    throw new Error('The configured Korte DOS deployment credential and project are required');
  }
  const hours = Number(env.AUDIT_HOURS || 24);
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) throw new Error('Audit hours must be from 1 through 24');
  const requestedEnd = env.AUDIT_END_UTC || '';
  if (requestedEnd && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(requestedEnd)) throw new Error('Use a UTC end time such as 2026-10-18T00:00:00Z');
  const parsedEnd = requestedEnd ? Date.parse(requestedEnd) : now - 10 * 60_000;
  if (!Number.isFinite(parsedEnd) || parsedEnd > now) throw new Error('Audit end time must be valid and in the past');
  const end = new Date(Math.floor(parsedEnd / 60_000) * 60_000).toISOString();
  const start = new Date(Date.parse(end) - hours * 3_600_000).toISOString();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const report = { window_utc: { start, end }, cron_runs_window: 'rolling 24 hours at execution',
    measurement: 'Recorded event counts, not exact billing bytes. No raw logs or customer data are returned.', database: {}, logs: {} };
  let databaseDenied = false;
  for (const [section, query] of Object.entries(auditSql)) {
    if (databaseDenied) { report.database[section] = { available: false, reason: 'database_access_unavailable' }; continue; }
    // Same authorized management route used by deployments, but only fixed
    // SELECT queries. No migrations, function calls, SET/ALTER, or mutations.
    const result = await requestAggregate(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
      { method: 'POST', headers, body: JSON.stringify({ query }) }, section, fetcher);
    report.database[section] = result;
    databaseDenied = [401, 403].includes(result.http_status);
  }
  let analyticsDenied = false;
  for (const [section, query] of Object.entries(logQueries)) {
    if (analyticsDenied) { report.logs[section] = { available: false, reason: 'analytics_access_unavailable' }; continue; }
    const url = new URL(`https://api.supabase.com/v1/projects/${PROJECT_REF}/analytics/endpoints/logs`);
    url.searchParams.set('sql', query);
    url.searchParams.set('iso_timestamp_start', start);
    url.searchParams.set('iso_timestamp_end', end);
    const result = await requestAggregate(url, { method: 'GET', headers }, section, fetcher);
    report.logs[section] = result;
    analyticsDenied = [401, 402, 403, 429].includes(result.http_status);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runAudit(), null, 2)); }
  catch { console.error('Log audit could not start. Check the fixed project credential and audit time inputs.'); process.exitCode = 1; }
}
