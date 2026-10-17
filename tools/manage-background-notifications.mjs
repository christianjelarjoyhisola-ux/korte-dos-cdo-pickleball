import { readFile } from 'node:fs/promises';

const migrationPath = new URL('../supabase/migrations/20261017090000_reduce_background_notification_requests.sql', import.meta.url);
const action = process.argv[2];
const allowed = ['rehearse', 'apply', 'verify', 'restore-schedules'];
if (!allowed.includes(action)) throw new Error(`Expected one of: ${allowed.join(', ')}`);
const token = process.env.SUPABASE_ACCESS_TOKEN;
const project = process.env.SUPABASE_PROJECT_REF;
if (!token || !/^[a-z0-9]{20}$/.test(project || '')) throw new Error('Supabase deployment credentials/project are required');

const verification = `
do $verify$
declare signature text; function_id regprocedure;
begin
  foreach signature in array array[
    'public.claim_host_balance_notification(text,text,text,text,boolean)',
    'public.due_host_balance_notification_groups(integer)',
    'public.payment_review_notification_work_due()',
    'public.admin_notification_work_due()',
    'public.dispatch_due_notification_worker(text)',
    'public.configure_due_notification_schedules()'
  ] loop
    function_id := to_regprocedure(signature);
    if function_id is null then raise exception 'Missing notification function: %', signature; end if;
    if has_function_privilege('anon', function_id, 'execute')
      or has_function_privilege('authenticated', function_id, 'execute')
      or not has_function_privilege('service_role', function_id, 'execute') then
      raise exception 'Unsafe notification function permissions: %', signature;
    end if;
  end loop;
  if (select count(*) from cron.job where jobname in (
    'process-payment-review-notifications', 'process-admin-device-notifications', 'process-host-balance-deadlines'
  )) <> 3 then raise exception 'Unexpected notification schedule count'; end if;
  if (select count(*) from cron.job where active and (
    (jobname = 'process-payment-review-notifications' and schedule = '*/5 * * * *'
      and command = $job$select public.dispatch_due_notification_worker('payment-review');$job$)
    or (jobname = 'process-admin-device-notifications' and schedule = '* * * * *'
      and command = $job$select public.dispatch_due_notification_worker('admin-device');$job$)
    or (jobname = 'process-host-balance-deadlines' and schedule = '*/15 * * * *'
      and command = $job$select public.dispatch_due_notification_worker('host-balance');$job$)
  )) <> 3 then raise exception 'Notification schedules are not gated correctly'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
    and table_name = 'booking_balance_notifications' and column_name = 'delivery_id'
    and data_type = 'uuid') then raise exception 'Host delivery claim column is missing'; end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '20261017090000') then
    raise exception 'Notification migration history is missing';
  end if;
end $verify$;`;

let query;
if (action === 'restore-schedules') {
  query = `do $restore$ begin
    if to_regprocedure('public.configure_due_notification_schedules()') is not null then
      perform public.configure_due_notification_schedules();
    end if;
  end $restore$;`;
} else if (action === 'verify') {
  query = verification;
} else {
  const migration = await readFile(migrationPath, 'utf8');
  if (!/^begin;/i.test(migration.trimStart()) || !/commit;\s*$/i.test(migration)) {
    throw new Error('Expected a transactional notification migration');
  }
  // Validate the same resulting state before either rolling back or committing.
  query = migration.replace(/commit;\s*$/i, `${verification}\n${action === 'rehearse' ? 'rollback' : 'commit'};`);
}

// Never retry a schema mutation automatically after an unknown response.
const response = await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }),
  signal: AbortSignal.timeout(120_000),
});
if (!response.ok) {
  const result = await response.json().catch(() => ({}));
  throw new Error(`Notification ${action} failed: HTTP ${response.status}; ${result.message || result.error || 'query rejected'}`);
}
console.log(`Notification ${action} succeeded.`);
