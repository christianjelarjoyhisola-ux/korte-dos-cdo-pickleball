const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Intelligence = require('./owner-intelligence.js');

function local(overrides = {}) {
  return Intelligence.buildLocalSnapshot({
    now: '2026-08-26T10:00:00Z',
    settings: { open_hour:'6', close_hour:'22' },
    courts: [{ id:'c1', name:'Court 1', rate:360 }],
    blockedDates: [],
    bookings: [],
    ...overrides,
  });
}

test('confidence gates price actions until comparable evidence is medium or high', () => {
  assert.equal(Intelligence.confidenceFor({ comparable_days:3, available_hours:48 }).code, 'learning');
  assert.equal(Intelligence.confidenceFor({ comparable_days:4, available_hours:12 }).code, 'low');
  assert.equal(Intelligence.confidenceFor({ comparable_days:8, available_hours:24 }).code, 'medium');
  assert.equal(Intelligence.confidenceFor({ comparable_days:16, available_hours:48 }).code, 'high');
});

test('an evidence-rich zero-booking window is persistent vacancy, not invisible', () => {
  const cell = { comparable_days:10, available_hours:30, booked_hours:0, utilization_pct:0 };
  const bounds = Intelligence.wilsonBounds(0, 30);
  assert.ok(bounds.high < 30);
  assert.equal(Intelligence.demandState(cell), 'persistent_vacancy');
});

test('learning starts at first successful play and ends yesterday', () => {
  const snapshot = local({
    bookings: [
      { ref:'FAILED-EARLY', courtId:'c1', date:'2026-05-01', status:'cancelled', paymentStatus:'rejected', slots:[9] },
      { ref:'FIRST-SUCCESS', courtId:'c1', date:'2026-06-27', status:'completed', paymentStatus:'paid', slots:[18] },
      { ref:'TODAY', courtId:'c1', date:'2026-08-26', status:'confirmed', paymentStatus:'paid', slots:[18] },
    ],
  });
  assert.equal(snapshot.period.from, '2026-06-27');
  assert.equal(snapshot.period.to, '2026-08-25');
  assert.equal(snapshot.kpis.successful_reservations, 1);
});

test('a zero-booking court learns from the venue go-live date when filtered', () => {
  const snapshot = local({
    courtId: 'c2',
    courts: [
      { id:'c1', name:'Court 1', rate:360, createdAt:'2026-06-01T00:00:00Z' },
      { id:'c2', name:'Court 2', rate:360, createdAt:'2026-06-01T00:00:00Z' },
    ],
    bookings: [{ ref:'VENUE-START', courtId:'c1', date:'2026-06-01', status:'completed', slots:[18] }],
  });
  assert.equal(snapshot.period.from, '2026-06-01');
  assert.equal(snapshot.kpis.successful_reservations, 0);
  assert.equal(snapshot.recommendation?.court_id, 'c2');
});

test('manual real bookings count while failed operational states never train demand', () => {
  const snapshot = local({
    bookings: [
      { ref:'MANUAL-REAL', createdVia:'admin', paymentMethod:'manual', courtId:'c1', date:'2026-06-27', status:'completed', slots:[9], duration:1 },
      { ref:'ONLINE', courtId:'c1', date:'2026-06-28', status:'confirmed', slots:[10], duration:1 },
      { ref:'CANCEL', courtId:'c1', date:'2026-06-29', status:'cancelled', slots:[11], duration:1 },
      { ref:'FORFEIT', courtId:'c1', date:'2026-06-30', status:'forfeited', slots:[12], duration:1 },
      { ref:'REJECT', courtId:'c1', date:'2026-07-01', status:'pending', paymentStatus:'rejected', slots:[13], duration:1 },
      { ref:'HOLD', courtId:'c1', date:'2026-07-02', status:'verifying', email:'reserve@hold.internal', slots:[14], duration:1 },
      { ref:'TEST', courtId:'c1', date:'2026-07-03', status:'completed', analyticsEligible:false, slots:[15], duration:1 },
    ],
  });
  assert.equal(snapshot.kpis.successful_reservations, 2);
  assert.equal(snapshot.kpis.booked_hours, 2);
  assert.equal(snapshot.data_quality.successful_booking_rows, 2);
  assert.ok(!JSON.stringify(snapshot).match(/cancel|forfeit|reject/i));
});

test('the engine recommends an evidence-rich 0% window after the learning gate', () => {
  const snapshot = local({
    bookings: [
      { ref:'BASELINE', courtId:'c1', date:'2026-06-01', status:'completed', slots:[18], duration:1 },
    ],
  });
  assert.ok(snapshot.period.learning_days >= Intelligence.MINIMUM_LEARNING_DAYS);
  assert.ok(snapshot.recommendation);
  assert.equal(snapshot.recommendation.utilization_pct, 0);
  assert.equal(snapshot.recommendation.state, 'persistent_vacancy');
  assert.equal(snapshot.recommendation.discount_percent, 10);
  assert.equal(snapshot.recommendation.valid_days, 28);
  assert.equal(snapshot.recommendation.max_redemptions, 20);
});

test('the engine abstains before 30 learning days and while a campaign is active', () => {
  const tooEarly = local({
    bookings: [{ ref:'BASE', courtId:'c1', date:'2026-08-10', status:'completed', slots:[18] }],
  });
  assert.equal(tooEarly.recommendation, null);

  const active = local({
    bookings: [{ ref:'BASE', courtId:'c1', date:'2026-06-01', status:'completed', slots:[18] }],
    campaigns: [{ id:'campaign-1', status:'active', court_id:'c1' }],
  });
  assert.equal(active.recommendation, null);
  assert.equal(active.active_campaigns.length, 1);
});

test('future confirmed bookings and fresh holds reduce open inventory but do not teach history', () => {
  const base = {
    bookings: [{ ref:'BASE', courtId:'c1', date:'2026-06-01', status:'completed', slots:[18] }],
  };
  const withoutFuture = local(base);
  const withFuture = local({ bookings: [
    ...base.bookings,
    { ref:'FUTURE', courtId:'c1', date:'2026-09-01', status:'confirmed', slots:[6,7] },
    { ref:'FRESH-HOLD', courtId:'c1', date:'2026-09-08', status:'verifying', slots:[6], createdAt:'2026-08-26T09:55:00Z' },
    { ref:'PENDING', courtId:'c1', date:'2026-09-15', status:'pending', slots:[6] },
  ] });
  assert.equal(withFuture.kpis.successful_reservations, withoutFuture.kpis.successful_reservations);
  assert.ok(withFuture.kpis.expected_unsold_hours < withoutFuture.kpis.expected_unsold_hours);
});

test('the visible Insights surface is demand-only and inline browser code parses', () => {
  const html = fs.readFileSync(path.join(__dirname,'admin.html'),'utf8');
  const visible = html.slice(html.indexOf('<div class="dg-shell">'), html.indexOf('<div class="oi-legacy"'));
  assert.match(visible, /Find weak hours\. Fill more courts\./);
  assert.match(html, /Start \$\{oiNumber\(discount\)\}% smart offer/);
  assert.doesNotMatch(visible, /payment review|outstanding balance|revenue momentum|payments collected|booking pipeline/i);
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  blocks.forEach((match,index) => assert.doesNotThrow(() => new vm.Script(match[1],{filename:`admin-inline-${index}.js`})));
  assert.match(html,/const requestSeq = \+\+_oiRequestSeq;/);
  assert.match(html,/if \(requestSeq !== _oiRequestSeq\) return;/);
});

test('demand campaign booking integration is automatic and fail-open at normal price', () => {
  const html = fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
  const controller = fs.readFileSync(path.join(__dirname,'demand-campaign-booking.js'),'utf8');
  assert.match(html,/BookingDemandCampaign\?\.autoApply\(/);
  assert.match(html,/continuing at normal price/);
  assert.match(html,/pricingState: 'checking'/);
  assert.match(controller,/PRICE_CHECK_TIMEOUT_MS = 2500/);
  assert.match(controller,/second call reconciles an[\s\S]*network response was lost/);
  assert.match(controller,/if \(!result\?\.applied\) return null/);
  assert.match(controller,/Smart Rate applied automatically/);
  assert.doesNotMatch(controller,/cancelled|forfeited|rejected/);
});

test('an ended Smart Offer can restart without a false live state or losing its safety cap', () => {
  const html = fs.readFileSync(path.join(__dirname,'admin.html'),'utf8');
  const config = fs.readFileSync(path.join(__dirname,'supabase-config.js'),'utf8');
  const migration = fs.readFileSync(path.join(
    __dirname,
    'supabase',
    'migrations',
    '20260826150000_demand_campaign_restart.sql',
  ),'utf8');
  const workflow = fs.readFileSync(path.join(
    __dirname,
    '.github',
    'workflows',
    'apply-demand-campaign-restart.yml',
  ),'utf8');

  assert.match(html,/const campaign = await DB\.createDemandCampaignFromRecommendation/);
  assert.match(html,/String\(campaign\?\.status \|\| ''\)\.toLowerCase\(\) !== 'active'/);
  assert.match(html,/courtId:\s*\$\('dgCourt'\)\?\.value \|\| null/);
  assert.doesNotMatch(
    html.slice(html.indexOf('async function applyDemandRecommendation()'), html.indexOf('async function endDemandCampaign(')),
    /courtId:\s*recommendation\.court_id/,
  );

  assert.match(migration,/drop constraint if exists demand_campaigns_source_recommendation_id_key/i);
  assert.match(migration,/create index if not exists demand_campaigns_source_recommendation_idx/i);
  assert.doesNotMatch(migration,/create unique index if not exists demand_campaigns_source_recommendation_idx/i);
  assert.match(migration,/perform public\.release_expired_demand_campaign_reservations\(\)/i);
  assert.match(migration,/campaign\.source_recommendation_id = clean_id[\s\S]*redemption\.status in \('reserved', 'redeemed'\)/i);
  assert.match(migration,/remaining_redemptions[\s\S]*20[\s\S]*prior_usage/i);
  assert.match(migration,/'restarted', is_restart/i);
  assert.match(migration,/'status', inserted\.status/i);

  assert.match(config,/priorCampaignIds[\s\S]*remainingRedemptions/);
  assert.match(config,/created: true, restarted: !!prior, idempotent: false/);
  assert.match(config,/max_redemptions: remainingRedemptions/);

  const migrationSha = crypto.createHash('sha256').update(migration).digest('hex');
  const applyStep = workflow.slice(
    workflow.indexOf('- name: Apply Smart Offer restart migration exactly once'),
    workflow.indexOf('- name: Verify production database state'),
  );
  assert.match(workflow,/MIGRATION_FILE: supabase\/migrations\/20260826150000_demand_campaign_restart\.sql/);
  assert.match(workflow,new RegExp(`MIGRATION_SHA256: ${migrationSha}`));
  assert.match(workflow,new RegExp(`sha256:${migrationSha}`));
  assert.match(workflow,/demand_campaigns_source_recommendation_idx/);
  assert.match(workflow,/demand_campaigns_one_active_uidx/);
  assert.match(applyStep,/one mutation POST with no automatic retry/i);
  assert.doesNotMatch(applyStep,/--retry/);
});

test('automatic pricing retries an ambiguous network loss and hydrates the authoritative amount', async () => {
  const source = fs.readFileSync(path.join(__dirname,'demand-campaign-booking.js'),'utf8');
  let calls = 0;
  const context = {
    window: {},
    document: { getElementById: () => null },
    fmt: value => `P${value}`,
    setTimeout,
    clearTimeout,
    DB: {
      async applyMatchingDemandCampaign() {
        calls += 1;
        if (calls === 1) throw new TypeError('Failed to fetch');
        return {
          applied: true,
          campaign_id: 'campaign-1',
          discount_amount: 36,
          allocations: [{ ref:'PB-1', gross_total:410, discount_amount:36, total:374 }],
        };
      },
    },
  };
  vm.runInNewContext(source, context, { filename:'demand-campaign-booking.js' });
  const items = [{ ref:'PB-1', total:410, courtFee:360 }];
  const result = await context.window.BookingDemandCampaign.autoApply(['PB-1'], items, { timeoutMs:20 });
  assert.equal(calls, 2);
  assert.equal(result.applied, true);
  assert.equal(items[0].total, 374);
  assert.equal(items[0].demandCampaignDiscountAmount, 36);
});

test('database contract is PII-free, separate from vouchers, future-only, and owner-controlled', () => {
  const migrationPath = path.join(__dirname,'supabase','migrations','20260826120000_demand_growth_campaigns.sql');
  const sql = fs.readFileSync(migrationPath,'utf8');
  assert.match(sql,/create table (?:if not exists )?public\.demand_campaigns/i);
  assert.match(sql,/create table (?:if not exists )?public\.demand_campaign_redemptions/i);
  assert.match(sql,/status[^\n]+(?:confirmed|completed)/i);
  assert.match(sql,/local_yesterday|interval '1 day'|local_today - 1/i);
  assert.match(sql,/apply_matching_demand_campaign/i);
  assert.match(sql,/create_demand_campaign_from_recommendation/i);
  assert.match(sql,/end_demand_campaign/i);
  assert.match(sql,/not \(voucher_id is not null and demand_campaign_id is not null\)/i);
  assert.match(sql,/booking\.voucher_id is not null[\s\S]{0,120}voucher_discount_amount/i);
  assert.match(sql,/status = 'verifying'/i);
  assert.match(sql,/created_at > now\(\) - interval '15 minutes'/i);
  assert.match(sql,/discount_percent[^\n]+10/i);
  assert.match(sql,/max_redemptions[^\n]+20/i);
  assert.doesNotMatch(sql,/\bcustomer_email\b/i);
  assert.doesNotMatch(sql,/jsonb_build_object\([^)]*'(?:email|contact_number|gcash_ref|receipt_image)'/is);
});

test('digest schema hotfix is narrow, idempotent, and deployed without mutation retries', () => {
  const migration = fs.readFileSync(path.join(
    __dirname,
    'supabase',
    'migrations',
    '20260826130000_demand_growth_digest_schema_hotfix.sql',
  ),'utf8');
  const workflow = fs.readFileSync(path.join(
    __dirname,
    '.github',
    'workflows',
    'apply-demand-growth-digest-hotfix.yml',
  ),'utf8');
  const applyStep = workflow.slice(
    workflow.indexOf('- name: Apply Demand Growth digest hotfix exactly once'),
    workflow.indexOf('- name: Verify production database state'),
  );
  const migrationSha = crypto.createHash('sha256').update(migration).digest('hex');

  assert.match(migration,/to_regprocedure\('extensions\.digest\(text,text\)'\)/i);
  assert.match(migration,/replace\([\s\S]*'public\.digest\('[\s\S]*'extensions\.digest\('/i);
  assert.match(migration,/elsif function_definition not like '%extensions\.digest\(%'/i);
  assert.match(migration,/revoke all on function public\.get_demand_growth_intelligence[\s\S]*from public, anon/i);
  assert.match(migration,/grant execute on function public\.get_demand_growth_intelligence[\s\S]*to authenticated/i);
  assert.match(migration,/notify pgrst, 'reload schema'/i);
  assert.doesNotMatch(migration,/\b(?:create|alter|drop|truncate)\s+table\b/i);

  assert.match(workflow,/name: Read-only production preflight/i);
  assert.match(workflow,/MIGRATION_FILE: supabase\/migrations\/20260826130000_/i);
  assert.match(workflow,new RegExp(`MIGRATION_SHA256: ${migrationSha}`));
  assert.match(workflow,new RegExp(`sha256:${migrationSha}`));
  assert.match(workflow,/position\('extensions\.digest\('/i);
  assert.match(workflow,/position\('public\.digest\('/i);
  assert.match(workflow,/skip_apply=true/i);
  assert.match(applyStep,/one mutation POST with no automatic retry/i);
  assert.doesNotMatch(applyStep,/--retry/);
});
