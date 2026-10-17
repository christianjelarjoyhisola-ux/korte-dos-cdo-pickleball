const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, beforeEach, afterEach, after } = require('node:test');
const { PGlite } = require('@electric-sql/pglite');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const migration = read('supabase/migrations/20261017090000_reduce_background_notification_requests.sql');
let db;
const scalar = async sql => Object.values((await db.query(sql)).rows[0])[0];
const dueHost = async () => (await db.query('select * from public.due_host_balance_notification_groups()')).rows;
const owner = '00000000-0000-4000-8000-000000000001';

// Execute the real migration and the existing claim RPCs in isolated Postgres.
// Only external extensions/HTTP and unrelated application tables are fixtures.
before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.role() returns text language sql as $$select 'service_role'::text$$;
    create schema supabase_migrations;
    create table supabase_migrations.schema_migrations(version text primary key, name text, statements text[]);
    create schema cron;
    create table cron.job(jobid bigserial primary key, jobname text, schedule text, command text);
    create function cron.schedule(text, text, text) returns bigint language sql as $$
      insert into cron.job(jobname, schedule, command) values ($1,$2,$3) returning jobid;
    $$;
    create function cron.unschedule(bigint) returns boolean language sql as $$
      with deleted as (delete from cron.job where jobid = $1 returning jobid) select exists(select 1 from deleted);
    $$;
    create schema net;
    create table net.requests(id bigserial primary key, url text, headers jsonb, body jsonb, timeout_milliseconds integer);
    create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds integer)
    returns bigint language sql as $$
      insert into net.requests(url,headers,body,timeout_milliseconds) values($1,$2,$3,$4) returning id;
    $$;
    create table public.private_settings(key text primary key, value text);
    create table public.accounts(id uuid primary key, status text, role text);
    create table public.bookings(
      ref text primary key, booking_group_ref text, host_booking boolean default true,
      status text default 'confirmed', payment_status text default 'downpayment_paid',
      balance_due_at timestamptz, full_name text, email text, host_name text, host_email text,
      court_name text, date date, start_time text, end_time text, total numeric, downpayment numeric
    );
    create table public.host_booking_balance_payments(
      booking_key text, status text, submitted_at timestamptz, balance_due_at timestamptz
    );
    create table public.booking_balance_notifications(
      id uuid primary key default gen_random_uuid(), booking_key text, booking_ref text,
      event_type text, recipient_email text, status text default 'pending', attempt_count integer default 0,
      last_attempt_at timestamptz, error_message text, unique(booking_key,event_type)
    );
    create table public.payment_review_notifications(
      id uuid primary key default gen_random_uuid(), dedupe_key text, receipt_verification_id bigint,
      booking_ref text, booking_group_ref text, context_type text, image_hash text,
      payment_provider text, payment_reference_masked text, payload jsonb, attempt_count integer default 0,
      status text, next_attempt_at timestamptz, created_at timestamptz default now(),
      last_attempt_at timestamptz, error_message text
    );
    create table public.admin_notification_targets(
      id uuid primary key default gen_random_uuid(), channel text, user_id uuid, target_key text,
      last_keys text[] not null default '{}', last_sent_at timestamptz, created_at timestamptz default now(),
      next_attempt_at timestamptz not null default now(), lease_until timestamptz, lease_id uuid, delivery_id uuid
    );
    create table public.fixture_review_queue(keys text[]);
    create function public.pending_admin_review_keys() returns text[] language sql stable as $$
      select coalesce((select keys from public.fixture_review_queue limit 1), '{}'::text[]);
    $$;
  `);
  await db.exec(migration);
  const originalPayment = read('supabase/migrations/20260723153000_payment_review_notifications.sql');
  const paymentClaim = originalPayment.slice(originalPayment.indexOf('create or replace function public.claim_due_payment_review_notifications('), originalPayment.indexOf('create table if not exists public.payment_review_decisions'));
  await db.exec(paymentClaim);
  const originalDevice = read('supabase/migrations/20261011090000_admin_device_notifications.sql');
  const deviceClaim = originalDevice.slice(originalDevice.indexOf('create or replace function public.claim_admin_notification_targets()'), originalDevice.indexOf('\ndo $$'));
  await db.exec(deviceClaim);
});
beforeEach(async () => {
  await db.exec(`begin;
    truncate public.private_settings, public.accounts, public.bookings, public.host_booking_balance_payments,
      public.booking_balance_notifications, public.payment_review_notifications,
      public.admin_notification_targets, public.fixture_review_queue, net.requests;
    insert into public.private_settings values ('payment_review_notification_worker_secret', repeat('s',64));
  `);
});
afterEach(async () => { await db.exec('rollback'); });
after(async () => { if (db) await db.close(); });

async function booking(ref, offset = '12 hours', overrides = {}) {
  const values = { ref, booking_group_ref: null, host_booking: true, status: 'confirmed', payment_status: 'downpayment_paid',
    full_name: 'Fixture Host', email: 'host@example.test', host_name: null, host_email: null,
    court_name: 'Fixture Court', date: '2026-10-30', start_time: '8:00 AM', end_time: '9:00 AM', total: 100, downpayment: 25, ...overrides };
  await db.query(`insert into public.bookings (${Object.keys(values).join(',')},balance_due_at)
    values (${Object.keys(values).map((_,i) => '$' + (i+1)).join(',')}, now() + $${Object.keys(values).length+1}::interval)`, [...Object.values(values), offset]);
}
async function notice(key, status, lastAttempt = null, event = 'forfeited') {
  await db.query(`insert into public.booking_balance_notifications(booking_key,booking_ref,event_type,recipient_email,status,last_attempt_at)
    values($1,$1,$2,'host@example.test',$3,case when $4::text is null then null else now()+$4::interval end)`, [key,event,status,lastAttempt]);
}

test('idle database dispatches no HTTP and preserves the three original schedules', async () => {
  for (const worker of ['payment-review','admin-device','host-balance']) {
    assert.equal(await scalar(`select public.dispatch_due_notification_worker('${worker}')`), null);
  }
  assert.equal(Number(await scalar('select count(*) from net.requests')), 0);
  const jobs = (await db.query('select jobname,schedule from cron.job order by jobname')).rows;
  assert.deepEqual(jobs, [
    { jobname: 'process-admin-device-notifications', schedule: '* * * * *' },
    { jobname: 'process-host-balance-deadlines', schedule: '*/15 * * * *' },
    { jobname: 'process-payment-review-notifications', schedule: '*/5 * * * *' },
  ]);
  await db.exec('select public.configure_due_notification_schedules(); select public.configure_due_notification_schedules();');
  assert.equal(Number(await scalar('select count(*) from cron.job')), 3, 'reapplying configuration replaces named jobs');
});

test('payment gate matches actual claim RPC for retry and expired lease states', async () => {
  await db.exec("insert into private_settings values ('payment_review_notification_email','owner@example.test')");
  for (const [status,next,last,expected] of [
    ['pending',null,null,true], ['failed','-1 second',null,true], ['pending','1 minute',null,false],
    ['sending','1 hour',null,true], ['sending',null,'-11 minutes',true], ['sending',null,'-9 minutes',false],
    ['sent',null,null,false],
  ]) {
    await db.exec('truncate payment_review_notifications');
    await db.query(`insert into payment_review_notifications(status,next_attempt_at,last_attempt_at)
      values($1,case when $2::text is null then null else now()+$2::interval end,
        case when $3::text is null then null else now()+$3::interval end)`, [status,next,last]);
    assert.equal(await scalar('select payment_review_notification_work_due()'), expected, [status,next,last].join('/'));
    assert.equal((await db.query('select * from claim_due_payment_review_notifications(1)')).rows.length > 0, expected);
  }
});

test('disabled email does not invoke a worker for retained retry rows; enabling it resumes work', async () => {
  await db.exec("insert into payment_review_notifications(status) values('failed')");
  assert.equal(await scalar("select dispatch_due_notification_worker('payment-review')"), null);
  await db.exec("insert into private_settings values ('payment_review_notification_email','owner@example.test')");
  assert.ok(await scalar("select dispatch_due_notification_worker('payment-review')"));
  const request = (await db.query('select * from net.requests')).rows[0];
  assert.ok(request.url.endsWith('/process-payment-review-notifications'));
  assert.deepEqual(request.body, { source: 'database-cron', batchSize: 5 });
  assert.equal(request.headers['X-Payment-Review-Worker-Secret'], 's'.repeat(64));
});

test('host due RPC excludes historical sent/recent notices but retains missing, failed, and abandoned notices', async () => {
  for (const ref of ['SENT','RECENT','FAILED','UNSENT','STALE','NO-ATTEMPT']) await booking(ref,'-1 day', { status:'forfeited',payment_status:'deposit_retained' });
  await notice('SENT','sent'); await notice('RECENT','pending','-9 minutes');
  await notice('FAILED','failed','-1 minute'); await notice('STALE','pending','-10 minutes');
  await notice('NO-ATTEMPT','pending');
  const due = await dueHost();
  assert.deepEqual(due.map(x => x.booking_key).sort(), ['FAILED','NO-ATTEMPT','STALE','UNSENT']);
  assert.ok(due.every(x => !x.needs_forfeiture && x.event_type === 'forfeited'));
  assert.ok(due.every(x => Object.keys(x.bookings[0]).length === 15), 'only email rendering fields are returned');
  assert.ok(await scalar("select dispatch_due_notification_worker('host-balance')"));
});

test('host reminders preserve 1/2/3-day windows, use full groups, and are bounded', async () => {
  await booking('G-1','18 hours',{booking_group_ref:'G'}); await booking('G-2','20 hours',{booking_group_ref:'G'});
  await booking('TWO','36 hours'); await booking('THREE','72 hours'); await booking('LATER','73 hours');
  const due = await dueHost();
  assert.deepEqual(due.map(x => [x.booking_key,x.event_type]), [['G','reminder_1d'],['TWO','reminder_2d'],['THREE','reminder_3d']]);
  assert.equal(due[0].bookings.length,2);
  assert.equal((await db.query('select * from due_host_balance_notification_groups(1)')).rows.length,1);
  await notice('G','sent',null,'reminder_1d');
  assert.deepEqual((await dueHost()).map(x=>x.booking_key), ['TWO','THREE']);
});

test('old failed notices cannot starve financial deadlines or newly due reminders in a full batch', async () => {
  await db.exec(`insert into bookings(ref,status,payment_status,balance_due_at,email,total,downpayment)
    select 'OLD-'||n,'forfeited','deposit_retained',now()-interval '30 days','host@example.test',100,25
    from generate_series(1,101) n;
    insert into booking_balance_notifications(booking_key,booking_ref,event_type,recipient_email,status,last_attempt_at)
    select ref,ref,'forfeited',email,'failed',now()-interval '1 minute' from bookings;`);
  await booking('NEW-DEADLINE','-1 second');
  await booking('NEW-REMINDER','1 hour');
  const firstBatch = await dueHost();
  assert.equal(firstBatch.length,100);
  assert.equal(firstBatch[0].booking_key,'NEW-DEADLINE');
  assert.equal(firstBatch[1].booking_key,'NEW-REMINDER');
  const attempted = firstBatch.filter(row=>row.booking_key.startsWith('OLD-')).map(row=>row.booking_key);
  await db.query('update booking_balance_notifications set last_attempt_at=now() where booking_key=any($1)',[attempted]);
  const nextBatch = await dueHost();
  const previouslyUnreached = nextBatch.filter(row=>row.booking_key.startsWith('OLD-')&&!attempted.includes(row.booking_key));
  assert.equal(previouslyUnreached.length,3,'least recently attempted failures move to the front on the next run');
});

test('overdue financial actions remain eligible without email, while timely review and mixed groups remain protected', async () => {
  await booking('NO-EMAIL','-1 minute',{email:''});
  await booking('REVIEW','-1 minute'); await booking('LATE-REVIEW','-1 minute');
  await booking('MIXED-A','-1 minute',{booking_group_ref:'MIXED'});
  await booking('MIXED-B','-1 minute',{booking_group_ref:'MIXED',payment_status:'paid'});
  await db.exec(`insert into host_booking_balance_payments values
    ('REVIEW','pending_review',now()-interval '1 hour',now()-interval '1 minute'),
    ('LATE-REVIEW','pending_review',now(),now()-interval '1 minute')`);
  assert.deepEqual((await dueHost()).map(x=>[x.booking_key,x.needs_forfeiture]), [['LATE-REVIEW',true],['NO-EMAIL',true]]);
  await db.exec("update host_booking_balance_payments set status='rejected' where booking_key='REVIEW'");
  assert.ok((await dueHost()).some(x=>x.booking_key==='REVIEW'), 'rejected review releases the existing financial hold');
  assert.equal(await scalar("select status from bookings where ref='NO-EMAIL'"),'confirmed','selector cannot mutate financial state');
});

test('notice claims suppress overlap and reuse provider delivery IDs after a retry', async () => {
  const claim = async force => (await db.query("select * from claim_host_balance_notification('G','R','forfeited','host@example.test',$1)",[force])).rows;
  const first = (await claim(false))[0];
  assert.ok(first.delivery_id);
  assert.equal((await claim(false)).length,0);
  assert.equal((await claim(true)).length,0,'manual requests cannot steal a current send');
  await db.exec("update booking_balance_notifications set status='failed'");
  const retry = (await claim(false))[0];
  assert.equal(retry.delivery_id,first.delivery_id); assert.equal(retry.attempt_count,2);
  await db.exec("update booking_balance_notifications set status='sent'");
  assert.equal((await claim(false)).length,0);
  const manual = (await claim(true))[0];
  assert.notEqual(manual.delivery_id,first.delivery_id,'an explicit manual resend gets a new delivery ID');
  await db.exec('update booking_balance_notifications set last_attempt_at=null');
  assert.equal((await claim(false)).length,1,'legacy pending rows without attempt time are reclaimable');
});

test('device gate clears empty-queue keys without HTTP and detects reappearing work', async () => {
  await db.query("insert into accounts values($1,'active','owner')",[owner]);
  await db.query(`insert into admin_notification_targets(channel,user_id,last_keys,last_sent_at)
    values('push',$1,array['b:example'],now())`,[owner]);
  assert.equal(await scalar("select dispatch_due_notification_worker('admin-device')"),null);
  assert.deepEqual(await scalar('select last_keys from admin_notification_targets'),[]);
  await db.exec("insert into fixture_review_queue values(array['b:example'])");
  assert.equal(await scalar('select admin_notification_work_due()'),true);
  assert.ok(await scalar("select dispatch_due_notification_worker('admin-device')"));
  assert.equal((await db.query('select * from claim_admin_notification_targets()')).rows.length,1);
  assert.equal(await scalar('select admin_notification_work_due()'),false,'atomic claim owns active lease');
});

test('device gate mirrors role, retry, lease and hourly-reminder conditions', async () => {
  await db.query("insert into accounts values($1,'active','court_owner')",[owner]);
  await db.exec("insert into fixture_review_queue values(array['review'])");
  await db.query(`insert into admin_notification_targets(channel,user_id,last_keys,last_sent_at)
    values('push',$1,array['review'],now())`,[owner]);
  assert.equal(await scalar('select admin_notification_work_due()'),false);
  await db.exec("update admin_notification_targets set last_sent_at=now()-interval '1 hour'");
  assert.equal(await scalar('select admin_notification_work_due()'),true);
  await db.exec("update admin_notification_targets set next_attempt_at=now()+interval '1 minute'");
  assert.equal(await scalar('select admin_notification_work_due()'),false);
  await db.exec('update admin_notification_targets set next_attempt_at=now(),lease_until=now()');
  assert.equal(await scalar('select admin_notification_work_due()'),false,'equal lease boundary is still held');
  await db.exec("update admin_notification_targets set lease_until=now()-interval '1 second'; update accounts set status='inactive'");
  assert.equal(await scalar('select admin_notification_work_due()'),false);
  await db.exec("update accounts set status='active'");
  assert.equal(await scalar('select admin_notification_work_due()'),true);
  assert.equal((await db.query('select * from claim_admin_notification_targets()')).rows.length,1);
  await db.exec("truncate admin_notification_targets; insert into admin_notification_targets(channel,created_at) values('email',now()-interval '1 hour')");
  assert.equal(await scalar('select admin_notification_work_due()'),false);
  await db.exec("insert into private_settings values('payment_review_notification_email','owner@example.test')");
  assert.equal(await scalar('select admin_notification_work_due()'),true);
});

test('new RPCs are unavailable to browser roles and migration is safe to replay', async () => {
  for (const fn of ['claim_host_balance_notification(text,text,text,text,boolean)','due_host_balance_notification_groups(integer)',
    'payment_review_notification_work_due()','admin_notification_work_due()','dispatch_due_notification_worker(text)','configure_due_notification_schedules()']) {
    for (const role of ['anon','authenticated']) assert.equal(await scalar(`select has_function_privilege('${role}','public.${fn}','EXECUTE')`),false);
    assert.equal(await scalar(`select has_function_privilege('service_role','public.${fn}','EXECUTE')`),true);
  }
  // Strip transaction commands only for this rollback-scoped replay.
  await db.exec(migration.replace(/^begin;/,'').replace(/commit;\s*$/,''));
  assert.equal(Number(await scalar('select count(*) from cron.job')),3);
});
