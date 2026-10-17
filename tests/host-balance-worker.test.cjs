const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const server = stripTypeScriptTypes(read('supabase/functions/process-host-balance-deadlines/index.ts'))
  .replace(/^import .+;\r?\n/gm, '').replace(/\bexport /g, '').split('if (import.meta.main)')[0];
const shared = stripTypeScriptTypes(read('supabase/functions/_shared/payment-review-worker.ts'));
const secretCheck = shared.slice(shared.indexOf('export function paymentReviewWorkerSecretsMatch'), shared.indexOf('function safePayload')).replace('export ', '');
const secret = 'fixture-worker-secret-'.repeat(3);
const env = key => ({ RESEND_API_KEY: 'fixture-api-key', EMAIL_FROM: 'Fixture <fixture@example.test>' }[key]);
const row = ref => ({ ref, booking_group_ref: null, full_name: 'Fixture Host', email: 'host@example.test',
  host_name: null, host_email: null, court_name: 'Court 1', date: '2026-11-01', start_time: '8:00 AM', end_time: '9:00 AM',
  total: 100, downpayment: 25, balance_due_at: '2026-10-27T15:59:59.999Z', status: 'confirmed', payment_status: 'downpayment_paid' });
const group = (ref, forfeit = false) => ({ booking_key: ref, event_type: forfeit ? 'forfeited' : 'reminder_1d', needs_forfeiture: forfeit, bookings: [row(ref)] });
function setup({ groups = [], rpcResult, queryResult, user = null } = {}) {
  const queries = [], rpcs = [], sends = [];
  const db = {
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    from(table) {
      const call = { table, filters: [] }; queries.push(call);
      const finish = () => {
        const override = queryResult?.(call);
        if (override !== undefined) return Promise.resolve(override);
        if (table === 'private_settings') return Promise.resolve({ data: { value: secret }, error: null });
        if (call.update) return Promise.resolve({ data: null, error: null });
        throw new Error(`Unexpected query: ${table}`);
      };
      const chain = {
        select(fields) { call.fields = fields; return chain; },
        eq(key,value) { call.filters.push([key,value]); return chain; },
        update(values) { call.update = values; return chain; },
        single: finish, maybeSingle: finish,
        order() { return finish(); },
        then(resolve,reject) { return finish().then(resolve,reject); },
      };
      return chain;
    },
    async rpc(name,args) {
      rpcs.push({name,args:JSON.parse(JSON.stringify(args))});
      const override = rpcResult?.(name,args);
      if (override !== undefined) return override;
      if (name === 'due_host_balance_notification_groups') return { data: groups, error: null };
      if (name === 'forfeit_overdue_host_booking') return { data: { changed: 1 }, error: null };
      if (name === 'claim_host_balance_notification') return { data: [{ id:'notice-id', attempt_count:2, delivery_id:'delivery-id' }], error:null };
      throw new Error(`Unexpected RPC: ${name}`);
    },
  };
  const context = { Response, Request, Date, Intl, fetch: () => { throw new Error('Unexpected live HTTP'); } };
  vm.createContext(context);
  vm.runInContext(`${secretCheck}\nconst PAYMENT_REVIEW_NOTIFICATION_WORKER_SETTING_KEY='payment_review_notification_worker_secret';\n${server}\nthis.handle=handle;`,context);
  async function run(body = { source:'database-cron' }, headers = { 'x-payment-review-worker-secret':secret }, fetcher) {
    return context.handle(new Request('https://fixture.test/worker',{method:'POST',headers,body:JSON.stringify(body)}),db,env,
      fetcher || (async (url,options) => { sends.push({url,options}); return new Response(JSON.stringify({id:'provider-id'})); }));
  }
  return { run, queries, rpcs, sends };
}

test('scheduled host processing requires the shared worker secret before any booking read or mutation', async () => {
  for (const headers of [{},{'x-payment-review-worker-secret':'wrong-secret'}]) {
    const fixture=setup({groups:[group('PRIVATE',true)]});
    const response=await fixture.run({source:'database-cron'},headers);
    assert.equal(response.status,401);
    assert.equal(fixture.rpcs.length,0); assert.equal(fixture.sends.length,0);
    assert.deepEqual(fixture.queries.map(q=>q.table),['private_settings']);
  }
});

test('idle host worker uses exactly one due-group RPC and reads no historical bookings', async () => {
  const fixture=setup(); const response=await fixture.run();
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true,processed:0,sent:0,skipped:0,failed:0});
  assert.deepEqual(fixture.rpcs,[{name:'due_host_balance_notification_groups',args:{p_limit:100}}]);
  assert.equal(fixture.sends.length,0);
  assert.ok(!fixture.queries.some(q=>q.table==='bookings'));
});

test('overdue group rechecks authoritative forfeiture before sending and skips a concurrent settlement', async () => {
  const fixture=setup({groups:[group('SETTLED',true)],rpcResult:name=>name==='forfeit_overdue_host_booking'?{data:{changed:0},error:null}:undefined});
  const response=await fixture.run();
  assert.equal((await response.json()).skipped,1);
  assert.deepEqual(fixture.rpcs.map(r=>r.name),['due_host_balance_notification_groups','forfeit_overdue_host_booking']);
  assert.equal(fixture.sends.length,0);
});

test('eligible group sends only after atomic claim, with provider idempotency and fenced status writes', async () => {
  const fixture=setup({groups:[group('PRIVATE',true)]}); const response=await fixture.run();
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true,processed:1,sent:1,skipped:0,failed:0});
  assert.deepEqual(fixture.rpcs.map(r=>r.name),['due_host_balance_notification_groups','forfeit_overdue_host_booking','claim_host_balance_notification']);
  assert.equal(fixture.sends.length,1);
  assert.equal(fixture.sends[0].options.headers['Idempotency-Key'],'host-balance:delivery-id');
  const sent = fixture.queries.find(q=>q.update?.status==='sent');
  assert.deepEqual(sent.filters,[['id','notice-id'],['attempt_count',2],['delivery_id','delivery-id'],['status','pending']]);
});

test('overlapping claims are skipped and a failed group does not starve later due groups', async () => {
  const fixture=setup({groups:[group('CLAIMED'),group('RETRY'),group('NEXT')],rpcResult:(name,args)=>name==='claim_host_balance_notification' && args.p_booking_key==='CLAIMED'?{data:[],error:null}:undefined});
  let calls=0;
  const response=await fixture.run(undefined,undefined,async()=>{ calls++; return new Response(JSON.stringify({id:'ok'}),{status:calls===1?503:200}); });
  assert.equal(response.status,207);
  assert.deepEqual(await response.json(),{ok:false,processed:3,sent:1,skipped:1,failed:1});
  assert.equal(calls,2);
  assert.ok(fixture.queries.some(q=>q.update?.status==='failed'));
});

test('manual resend still requires an active admin and uses the atomic force claim', async () => {
  const denied=setup();
  await denied.run({action:'manual',bookingRef:'REF'},{});
  assert.equal(denied.rpcs.length,0); assert.equal(denied.sends.length,0);
  const fixture=setup({user:{id:'admin'},queryResult:call=>{
    if(call.table==='accounts')return {data:{role:'owner',status:'active'},error:null};
    if(call.table==='bookings')return {data:call.fields==='booking_group_ref'?{booking_group_ref:null}:[row('REF')],error:null};
  }});
  const response=await fixture.run({action:'manual',bookingRef:'REF'},{authorization:'Bearer fixture-user-token'});
  assert.equal(response.status,200);
  assert.equal(fixture.rpcs[0].name,'claim_host_balance_notification');
  assert.equal(fixture.rpcs[0].args.p_force,true);
  assert.ok(fixture.queries.every(q=>q.fields!=='*'));
  assert.equal(fixture.sends.length,1);
});
