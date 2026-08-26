const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function profitMigration() {
  const directory = path.join(ROOT, 'supabase', 'migrations');
  const candidates = fs.readdirSync(directory)
    .filter(name => name.endsWith('.sql'))
    .sort();
  const names = candidates.filter(candidate => {
    const source = fs.readFileSync(path.join(directory, candidate), 'utf8');
    return /profit_learning_experiments/i.test(source)
      && /profit_learning_occurrences/i.test(source);
  });
  assert.ok(names.length, 'an additive Profit Learning V2 migration must exist');
  return {
    name: names.at(-1),
    source: names.map(name => fs.readFileSync(path.join(directory, name), 'utf8')).join('\n'),
  };
}

function sqlFunction(source, name) {
  const startPattern = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`,
    'i',
  );
  const matches = [...source.matchAll(new RegExp(startPattern.source, 'ig'))];
  const match = matches.at(-1);
  assert.ok(match, `SQL function ${name} must exist`);
  const rest = source.slice(match.index + match[0].length);
  const next = rest.search(/\ncreate\s+or\s+replace\s+function\s+public\./i);
  return source.slice(match.index, next < 0 ? source.length : match.index + match[0].length + next);
}

function sqlTable(source, name) {
  const startPattern = new RegExp(
    `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?public\\.${name}\\b`,
    'i',
  );
  const match = startPattern.exec(source);
  assert.ok(match, `SQL table ${name} must exist`);
  const rest = source.slice(match.index + match[0].length);
  const next = rest.search(/\ncreate\s+table\s+/i);
  return source.slice(match.index, next < 0 ? source.length : match.index + match[0].length + next);
}

function onlineDataLayer() {
  const source = read('supabase-config.js');
  const localStart = source.indexOf('// LOCAL DATA MODE');
  assert.ok(localStart > 0, 'the production and local data layers must remain separate');
  return source.slice(0, localStart);
}

function objectMethod(source, name) {
  const marker = `  async ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `frontend method ${name} must exist`);
  const next = source.indexOf('\n  async ', start + marker.length);
  return source.slice(start, next < 0 ? source.length : next);
}

function monday(dateText) {
  return new Date(`${dateText}T12:00:00Z`).getUTCDay() === 1;
}

test('Best Move targets one regular-price occurrence within a 28-day horizon', () => {
  delete require.cache[require.resolve('./owner-intelligence.js')];
  const Intelligence = require('./owner-intelligence.js');
  const snapshot = Intelligence.buildLocalSnapshot({
    now: '2026-08-26T10:00:00Z',
    settings: { open_hour: '8', close_hour: '11' },
    courts: [{
      id: 'c2',
      name: 'Court 2',
      rate: 999,
      rateSchedule: [
        { from: 8, to: 9, rate: 300 },
        { from: 9, to: 10, rate: 400 },
        { from: 10, to: 11, rate: 500 },
      ],
    }],
    blockedDates: [],
    bookings: [{
      ref: 'LEARNING-ANCHOR',
      courtId: 'c2',
      date: '2026-06-01',
      slots: [8],
      status: 'completed',
      paymentStatus: 'paid',
      analyticsEligible: true,
    }],
  });

  assert.equal(snapshot.court_signals.length, 21, 'three sellable hours x seven weekdays');
  const mondaySignals = snapshot.court_signals
    .filter(signal => signal.weekday === 1)
    .sort((a, b) => a.start_hour - b.start_hour);
  assert.deepEqual(
    mondaySignals.map(signal => [signal.start_hour, signal.end_hour, signal.rate]),
    [[8, 9, 300], [9, 10, 400], [10, 11, 500]],
    'every hour must retain its own boundaries and authoritative regular rate',
  );
  assert.ok(snapshot.court_signals.every(signal => signal.end_hour === signal.start_hour + 1));

  assert.ok(snapshot.recommendation, 'an evidence-ready weak one-hour slot should be actionable');
  assert.equal(snapshot.recommendation.action_type, 'facebook_regular_price');
  assert.equal(snapshot.recommendation.discount_percent, 0);
  assert.equal(snapshot.recommendation.target_occurrences, 1);
  assert.equal(snapshot.recommendation.horizon_days, 28);
  if (snapshot.recommendation.target_pairs !== undefined) {
    assert.equal(snapshot.recommendation.target_pairs, 1, 'legacy storage compatibility may describe one target only');
  }
  assert.equal(snapshot.recommendation.end_hour, snapshot.recommendation.start_hour + 1);
  assert.ok(Number(snapshot.recommendation.hourly_rate ?? snapshot.recommendation.rate) > 0);
  assert.equal(snapshot.recommendation.valid_days, undefined);
  assert.equal(snapshot.recommendation.max_redemptions, undefined);
});

test('only genuine paid or verified-downpayment confirmed/completed rows teach outcomes', () => {
  delete require.cache[require.resolve('./owner-intelligence.js')];
  const Intelligence = require('./owner-intelligence.js');
  const successes = [
    ['PAID-CONFIRMED', 'confirmed', 'paid'],
    ['PAID-COMPLETED', 'completed', 'paid'],
    ['DP-CONFIRMED', 'confirmed', 'downpayment_paid'],
    ['DP-COMPLETED', 'completed', 'downpayment_paid'],
  ];
  const failedLifecycle = ['pending', 'verifying', 'cancelled', 'forfeited', 'expired', 'failed'];
  const failedPayments = ['unpaid', 'pending', 'for_verification', 'rejected', 'failed', 'expired'];
  const dates = [];
  for (let cursor = new Date('2026-06-01T12:00:00Z'); dates.length < 30; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const value = cursor.toISOString().slice(0, 10);
    if (monday(value)) dates.push(value);
  }
  const bookings = successes.map(([ref, status, paymentStatus], index) => ({
    ref, status, paymentStatus, analyticsEligible: true,
    courtId: 'c1', date: dates[index], slots: [8],
  }));
  failedLifecycle.forEach((status, index) => bookings.push({
    ref: `BAD-LIFECYCLE-${status}`,
    status,
    paymentStatus: 'paid',
    analyticsEligible: true,
    courtId: 'c1',
    date: dates[index + successes.length],
    slots: [8],
  }));
  failedPayments.forEach((paymentStatus, index) => bookings.push({
    ref: `BAD-PAYMENT-${paymentStatus}`,
    status: index % 2 ? 'completed' : 'confirmed',
    paymentStatus,
    analyticsEligible: true,
    courtId: 'c1',
    date: dates[index + successes.length + failedLifecycle.length],
    slots: [8],
  }));
  bookings.push({
    ref: 'ANALYTICS-EXCLUDED', status: 'completed', paymentStatus: 'paid',
    analyticsEligible: false, courtId: 'c1', date: dates[20], slots: [8],
  });
  bookings.push({
    ref: 'INTERNAL-HOLD', status: 'completed', paymentStatus: 'paid',
    analyticsEligible: true, email: 'reserve@hold.internal',
    courtId: 'c1', date: dates[21], slots: [8],
  });

  const snapshot = Intelligence.buildLocalSnapshot({
    now: '2027-02-01T10:00:00Z',
    settings: { open_hour: '8', close_hour: '9' },
    courts: [{ id: 'c1', name: 'Court 1', rate: 300 }],
    blockedDates: [],
    bookings,
  });
  assert.equal(snapshot.kpis.successful_reservations, 4);
  assert.equal(snapshot.kpis.booked_hours, 4);
  assert.equal(snapshot.data_quality.successful_booking_rows, 4);
});

test('V2 persistence is additive, occurrence-level, unique, immutable, and owner controlled', () => {
  const { source: sql } = profitMigration();
  for (const table of [
    'profit_learning_experiments',
    'profit_learning_occurrences',
    'profit_learning_occurrence_events',
    'profit_learning_occurrence_outcomes',
  ]) {
    assert.match(sql, new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?public\\.${table}\\b`, 'i'));
  }

  const experimentTable = sqlTable(sql, 'profit_learning_experiments');
  const occurrenceTable = sqlTable(sql, 'profit_learning_occurrences');
  if (/\btarget_pairs\b/i.test(experimentTable)) {
    assert.match(sql, /alter\s+column\s+target_pairs\s+set\s+default\s+1/i);
  }
  for (const column of ['experiment_id', 'court_id', 'slot_hour']) {
    assert.match(occurrenceTable, new RegExp(`\\b${column}\\b`, 'i'));
  }
  assert.match(occurrenceTable, /\b(?:occurrence_date|play_date)\b/i);
  assert.match(occurrenceTable, /\b(?:assignment_arm|arm)\b/i);
  assert.match(occurrenceTable, /'treatment'/i);
  // Historical paired runs remain readable; the latest creation RPC below is
  // the contract that permits only one treatment occurrence.
  assert.match(
    sql,
    /unique\s*(?:index[^\n]*on\s+public\.profit_learning_occurrences\s*)?\(\s*(?:experiment_id\s*,\s*)?court_id\s*,\s*(?:occurrence_date|play_date)\s*,\s*slot_hour\s*\)/i,
    'one experiment/court/date/hour occurrence can have only one arm',
  );
  assert.match(sql, /profit_learning_occurrence[^\n]*(?:immutable|immutability)|(?:immutable|immutability)[^\n]*profit_learning_occurrence/i);

  for (const rpc of [
    'create_profit_learning_experiment_from_recommendation',
    'record_profit_learning_facebook_publication',
    'finalize_profit_learning_occurrence_outcomes',
    'end_profit_learning_experiment',
  ]) {
    const body = sqlFunction(sql, rpc);
    assert.match(body, /current_account_role\s*\(\s*\)/i);
    assert.match(body, /'owner'\s*,\s*'court_owner'|'court_owner'\s*,\s*'owner'/i);
    assert.match(sql, new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${rpc}[\\s\\S]*?from\\s+public\\s*,\\s*anon`, 'i'));
    assert.match(sql, new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${rpc}[\\s\\S]*?to\\s+authenticated`, 'i'));
  }
});

test('V2 uses separate RPCs and frontend methods without booking-price mutation calls', () => {
  const { source: sql } = profitMigration();
  const online = onlineDataLayer();
  const methods = {
    getDemandGrowthIntelligence: 'get_profit_learning_v2_intelligence',
    createProfitLearningExperimentFromRecommendation: 'create_profit_learning_experiment_from_recommendation',
    recordProfitLearningFacebookPublication: 'record_profit_learning_facebook_publication',
    finalizeProfitLearningOccurrenceOutcomes: 'finalize_profit_learning_occurrence_outcomes',
    getProfitLearningExperimentResults: 'get_profit_learning_experiment_results',
    endProfitLearningExperiment: 'end_profit_learning_experiment',
  };
  for (const [methodName, rpcName] of Object.entries(methods)) {
    assert.match(sql, new RegExp(`function\\s+public\\.${rpcName}\\s*\\(`, 'i'));
    const method = objectMethod(online, methodName);
    assert.match(method, new RegExp(`\\.rpc\\s*\\(\\s*['\"]${rpcName}['\"]`));
  }

  for (const methodName of [
    'createProfitLearningExperimentFromRecommendation',
    'recordProfitLearningFacebookPublication',
    'finalizeProfitLearningOccurrenceOutcomes',
    'endProfitLearningExperiment',
  ]) {
    const method = objectMethod(online, methodName);
    assert.doesNotMatch(method, /addBooking|updateBooking|deleteBooking|finalize_public_booking_hold|cancel_public_booking_hold/i);
    assert.doesNotMatch(method, /applyMatchingDemandCampaign|createDemandCampaignFromRecommendation|discount/i);
  }

  const createExperiment = sqlFunction(sql, 'create_profit_learning_experiment_from_recommendation');
  assert.match(createExperiment, /facebook_regular_price/i);
  assert.match(createExperiment, /discount_percent[\s\S]{0,100}\b0\b/i);
  assert.match(createExperiment, /target_occurrences[\s\S]{0,100}\b1\b/i);
  assert.match(createExperiment, /horizon_days[\s\S]{0,100}\b28\b/i);
  assert.match(createExperiment, /insert\s+into\s+public\.profit_learning_occurrences/i);
  assert.match(createExperiment, /'treatment'/i);
  assert.doesNotMatch(createExperiment, /'control'/i);
  assert.doesNotMatch(createExperiment, /(?:insert\s+into|update|delete\s+from)\s+public\.bookings/i);
  assert.doesNotMatch(createExperiment, /apply_matching_demand_campaign|demand_campaign_discount/i);
});

test('Best Move creates one treatment occurrence no more than 28 days ahead', () => {
  const { source: sql } = profitMigration();
  const createExperiment = sqlFunction(sql, 'create_profit_learning_experiment_from_recommendation');

  assert.match(sql, /'target_occurrences'\s*,\s*1/i);
  assert.match(sql, /'horizon_days'\s*,\s*28/i);
  assert.match(createExperiment, /(?:local_today|current_date)[\s\S]{0,160}(?:\+\s*28|interval\s*'28\s+days')/i);
  assert.match(createExperiment, /limit\s+1/i, 'candidate selection must stop after one exact occurrence');
  assert.doesNotMatch(createExperiment, /generate_series\s*\(\s*1\s*,\s*(?:8|16)/i);
});

test('occurrence outcomes allowlist paid success and make failed operational states zero', () => {
  const { source: sql } = profitMigration();
  const eligibility = sqlFunction(sql, 'profit_learning_booking_is_successful');
  const finalize = sqlFunction(sql, 'finalize_profit_learning_occurrence_outcomes');
  assert.match(eligibility, /coalesce\s*\(\s*p_analytics_eligible\s*,\s*false\s*\)/i);
  assert.match(eligibility, /p_lifecycle_status[\s\S]{0,100}\bin\s*\(\s*'confirmed'\s*,\s*'completed'\s*\)/i);
  assert.match(
    eligibility,
    /p_payment_status[\s\S]{0,100}\bin\s*\(\s*'paid'\s*,\s*'downpayment_paid'\s*\)/i,
  );
  assert.match(eligibility, /reserve@hold\.internal/i);
  assert.match(finalize, /profit_learning_booking_is_successful\s*\(/i);
  assert.match(finalize, /booking_fee_amount_snapshot|court_(?:revenue|amount)|collected_court/i);
  assert.match(finalize, /successful_paid_booking_count[\s\S]*coalesce\s*\(\s*classified\.successful_paid_booking_count\s*,\s*0\s*\)/i);
  assert.match(finalize, /when\s+coalesce\s*\(\s*classified\.successful_paid_booking_count\s*,\s*0\s*\)\s*>\s*0[\s\S]*else\s+0/i);
  assert.doesNotMatch(eligibility, /'(?:pending|verifying|cancelled|forfeited|expired|failed|unpaid|for_verification|rejected)'/i);
});

test('premium owner surface is one clear card with action-aware Facebook copy', () => {
  const html = read('admin.html');
  assert.equal((html.match(/Best next move/gi) || []).length, 1, 'show one primary recommendation card');
  assert.match(html, /Start protected test/i);
  assert.match(html, /Why this\?/i);
  assert.match(html, /Regular price/i);
  assert.match(html, /No discount required(?: yet)?/i);
  assert.match(html, /Existing bookings and hourly prices (?:stay|remain) unchanged/i);
  assert.match(html, /Create Facebook post/i);
  assert.doesNotMatch(html, /(?:8|eight)\s+matched\s+pairs?/i);

  const captionStart = html.indexOf('function buildDemandPostCaption(');
  assert.ok(captionStart >= 0, 'Facebook caption composer must remain available');
  const captionEnd = html.indexOf('\nfunction ', captionStart + 20);
  const caption = html.slice(captionStart, captionEnd < 0 ? html.length : captionEnd);
  assert.match(
    caption,
    /(?:rows\.slice\s*\(\s*0\s*,\s*1\s*\)|rows\s*\[\s*0\s*\]|featured\s*\[\s*0\s*\])/i,
    'the Post Kit must select one exact occurrence/date only',
  );
  assert.doesNotMatch(caption, /rows\.slice\s*\(\s*0\s*,\s*(?:[2-9]|\d{2,})\s*\)/i);
  assert.doesNotMatch(caption, /More selected offer times|matching (?:dates|times)|weekly window/i);
  assert.match(caption, /facebook_regular_price/i);
  assert.match(caption, /regular price|no discount/i);
  assert.match(caption, /discount|%\s*OFF|SAVE/i, 'discount actions keep their own truthful copy');
  assert.match(
    caption,
    /facebook_regular_price[\s\S]{0,1600}(?:return|\?)[\s\S]{0,800}(?:regular price|no discount)/i,
    'regular-price publication must take an explicit copy branch',
  );
});

test('the additive migration does not redefine core booking or receipt mutation RPCs', () => {
  const { source: sql } = profitMigration();
  const protectedFunctions = [
    'finalize_public_booking_hold',
    'cancel_public_booking_hold',
    'guard_public_booking_hold_update',
    'calculate_booking_court_total',
    'calculate_booking_service_fee',
    'restore_cancelled_booking_after_manual_payment',
    'mark_host_booking_group_fully_paid',
    'restore_forfeited_host_booking_as_fully_paid',
  ];
  for (const functionName of protectedFunctions) {
    assert.doesNotMatch(
      sql,
      new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${functionName}\\s*\\(`, 'i'),
      `Profit Learning V2 must not redefine ${functionName}`,
    );
  }
  assert.doesNotMatch(sql, /create\s+trigger[\s\S]{0,300}\bon\s+public\.bookings\b/i);
  assert.doesNotMatch(sql, /(?:insert\s+into|update|delete\s+from)\s+public\.receipt/i);
  assert.doesNotMatch(sql, /verify-gcash-receipt|review-payment-receipt|receipt_review/i);
});
