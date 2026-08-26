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
    // Older fixtures predate payment-status snapshots. Production callers do
    // not get this compatibility path unless they request it explicitly.
    allowLegacyMissingPaymentStatus: true,
    ...overrides,
  });
}

function visibleLocalGrowth(db, filters = {}) {
  const source = fs.readFileSync(path.join(__dirname, 'supabase-config.js'), 'utf8');
  const start = source.indexOf('  function localDemandPricingTiers(value)');
  const end = source.indexOf('\n\n  window.DB = {', start);
  assert.ok(start >= 0 && end > start, 'visible local Demand Growth function must be extractable');
  const localDateAdd = (value, amount) => {
    const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + Number(amount));
    return date.toISOString().slice(0, 10);
  };
  const context = {
    window: { OwnerIntelligence: Intelligence },
    localManilaDate: () => '2026-08-26',
    localDateAdd,
    localDateDiff: (from, to) => Math.round(
      (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000,
    ),
    localIsoWeekday: value => ((new Date(`${value}T12:00:00Z`).getUTCDay() + 6) % 7) + 1,
    localRecommendationId: parts => `TEST-${parts.join('-')}`,
    _safeJsonParse: value => {
      try { return JSON.parse(value); } catch (_) { return null; }
    },
    result: null,
  };
  const sandbox = { ...context, inputDb: db, inputFilters: filters };
  vm.runInNewContext(
    `${source.slice(start, end)}\nresult = buildLocalDemandGrowthIntelligence(inputDb, inputFilters);`,
    sandbox,
    { filename:'visible-local-demand-growth.js' },
  );
  return sandbox.result;
}

test('confidence gates price actions until comparable evidence is medium or high', () => {
  assert.equal(Intelligence.confidenceFor({ comparable_days:3, available_hours:3 }).code, 'learning');
  assert.equal(Intelligence.confidenceFor({ comparable_days:4, available_hours:4 }).code, 'low');
  assert.equal(Intelligence.confidenceFor({ comparable_days:8, available_hours:8 }).code, 'medium');
  assert.equal(Intelligence.confidenceFor({ comparable_days:16, available_hours:16 }).code, 'high');
});

test('historical success requires a paid state with an explicit legacy escape hatch', () => {
  const base = { status:'completed', analyticsEligible:true, email:'player@example.com' };
  assert.equal(Intelligence.isPaidSuccessfulBooking({ ...base, paymentStatus:'paid' }), true);
  assert.equal(Intelligence.isPaidSuccessfulBooking({ ...base, payment_status:'downpayment_paid' }), true);
  assert.equal(Intelligence.isPaidSuccessfulBooking({ ...base, paymentStatus:'unpaid' }), false);
  assert.equal(Intelligence.isPaidSuccessfulBooking({ ...base, paymentStatus:'rejected' }), false);
  assert.equal(Intelligence.isPaidSuccessfulBooking(base), false);
  assert.equal(Intelligence.isPaidSuccessfulBooking(base, { allowLegacyMissingPaymentStatus:true }), true);
  assert.equal(Intelligence.isPaidSuccessfulBooking({ ...base, status:'cancelled', paymentStatus:'paid' }), false);
});

test('snapshot learning excludes confirmed/completed rows without collected payment', () => {
  const snapshot = local({
    allowLegacyMissingPaymentStatus: false,
    bookings: [
      { ref:'PAID', courtId:'c1', date:'2026-06-01', status:'completed', paymentStatus:'paid', slots:[8] },
      { ref:'DEPOSIT', courtId:'c1', date:'2026-06-02', status:'confirmed', paymentStatus:'downpayment_paid', slots:[9] },
      { ref:'UNPAID', courtId:'c1', date:'2026-06-03', status:'confirmed', paymentStatus:'unpaid', slots:[10] },
      { ref:'LEGACY-MISSING', courtId:'c1', date:'2026-06-04', status:'completed', slots:[11] },
    ],
  });
  assert.equal(snapshot.kpis.successful_reservations, 2);
  assert.equal(snapshot.kpis.booked_hours, 2);
  assert.equal(snapshot.data_quality.successful_booking_rows, 2);
});

test('slot pricing prefers an override, then court tiers, venue tiers, and flat rate', () => {
  const settings = { pricing_tiers: JSON.stringify([{ from:9, to:10, rate:420 }]) };
  const court = { id:'c1', rate:360, rateSchedule:[{ from:8, to:9, rate:300 }] };
  assert.equal(Intelligence.rateForSlot({ settings, slotRate:(_court,hour) => hour === 7 ? 275 : null }, court, 7), 275);
  assert.equal(Intelligence.rateForSlot({ settings }, court, 8), 300);
  assert.equal(Intelligence.rateForSlot({ settings }, court, 9), 360, 'court schedule owns pricing and falls back to the court flat rate');
  assert.equal(Intelligence.rateForSlot({ settings }, { id:'c2', rate:380 }, 9), 420);
  assert.equal(Intelligence.rateForSlot({ settings }, { id:'c2', rate:380 }, 10), 380);
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

test('the engine recommends a regular-price Facebook test after the learning gate', () => {
  const snapshot = local({
    bookings: [
      { ref:'BASELINE', courtId:'c1', date:'2026-06-01', status:'completed', slots:[18], duration:1 },
    ],
  });
  assert.ok(snapshot.period.learning_days >= Intelligence.MINIMUM_LEARNING_DAYS);
  assert.ok(snapshot.recommendation);
  assert.equal(snapshot.recommendation.utilization_pct, 0);
  assert.equal(snapshot.recommendation.state, 'persistent_vacancy');
  assert.equal(snapshot.recommendation.action_type, 'facebook_regular_price');
  assert.equal(snapshot.recommendation.discount_percent, 0);
  assert.equal(snapshot.recommendation.target_pairs, 8);
  assert.equal('valid_days' in snapshot.recommendation, false);
  assert.equal('max_redemptions' in snapshot.recommendation, false);
});

test('the engine abstains before 30 learning days and during legacy or V2 activity', () => {
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

  const activeV2 = local({
    courtId: 'c1',
    bookings: [{ ref:'BASE', courtId:'c1', date:'2026-06-01', status:'completed', slots:[18] }],
    experiments: [{ id:'experiment-1', status:'active', court_id:'another-court' }],
  });
  assert.equal(activeV2.recommendation, null);
  assert.equal(activeV2.active_experiments.length, 1);
  assert.equal(Intelligence.recommendationFromSignals({
    period: { learning_days:60 },
    recommendation: { id:'stale-recommendation' },
    active_experiments: [{ status:'active' }],
  }), null, 'active experiments must suppress even a supplied stale recommendation');
});

test('8–9, 9–10, and 10–11 remain independent signals with exact prices', () => {
  const snapshot = local({
    settings: { open_hour:'8', close_hour:'11' },
    courts: [{
      id:'c1', name:'Court 1', rate:600,
      rateSchedule: [
        { from:8, to:9, rate:300 },
        { from:9, to:10, rate:400 },
        { from:10, to:11, rate:500 },
      ],
    }],
    bookings: [{
      ref:'MULTI-HOUR', courtId:'c1', date:'2026-06-01', status:'completed', paymentStatus:'paid', slots:[8,9], duration:2,
    }],
  });
  const monday = snapshot.court_signals
    .filter(cell => cell.weekday === 1)
    .sort((a,b) => a.start_hour - b.start_hour);
  assert.deepEqual(monday.map(cell => [cell.start_hour,cell.end_hour,cell.rate,cell.booked_hours]), [
    [8,9,300,1],
    [9,10,400,1],
    [10,11,500,0],
  ]);
  assert.equal(new Set(snapshot.court_signals.map(cell => `${cell.start_hour}:${cell.end_hour}`)).size, 3);
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

test('every enabled Maintenance block label is unavailable demand capacity', () => {
  const labels = ['closed', 'maintenance', 'reserved', 'blocked', 'private', 'group', 'openplay'];
  for (const label of labels) {
    const settings = {
      maintenance_config: JSON.stringify({ rules: [{
        enabled: true,
        label,
        mode: 'specific',
        dates: ['2026-08-18'],
        start: 0,
        end: 24,
        courtIds: [],
      }] }),
    };
    assert.equal(
      Intelligence.scheduleHourUnavailable('2026-08-18', 9, 'c1', settings),
      true,
      `${label} must be excluded`,
    );
  }
});

test('Maintenance and Open Play matching supports recurrence, court scope, and disabled rules', () => {
  const settings = {
    maintenance_config: {
      rules: [
        { enabled: true, mode: 'weekly', recurring: { days: [2] }, start: 6, end: 9, courtIds: ['c1'], label: 'private' },
        { enabled: true, mode: 'monthly', recurring: { day: 18 }, start: 12, end: 13, courtIds: [], label: 'group' },
        { enabled: false, mode: 'specific', dates: ['2026-08-18'], start: 9, end: 12, courtIds: [], label: 'closed' },
      ],
    },
    open_play_config: {
      enabled: true,
      days: [2],
      specificDates: ['2026-08-19'],
      start: 18,
      end: 20,
      courtIds: ['c2'],
    },
  };
  assert.equal(Intelligence.scheduleHourUnavailable('2026-08-18', 6, 'c1', settings), true);
  assert.equal(Intelligence.scheduleHourUnavailable('2026-08-18', 6, 'c2', settings), false);
  assert.equal(Intelligence.scheduleHourUnavailable('2026-08-18', 12, 'c2', settings), true);
  assert.equal(Intelligence.scheduleHourUnavailable('2026-08-18', 10, 'c1', settings), false);
  assert.equal(Intelligence.scheduleHourUnavailable('2026-08-18', 18, 'c2', settings), true);
  assert.equal(Intelligence.scheduleHourUnavailable('2026-08-19', 19, 'c2', settings), true);
  assert.equal(Intelligence.scheduleHourUnavailable('2026-08-19', 19, 'c1', settings), false);
});

test('only Open Play Session blocks count as occupied demand', () => {
  const settings = {
    open_hour:'6', close_hour:'9',
    maintenance_config: { rules: [
      { enabled:true, label:'openplay', mode:'specific', dates:['2026-08-18'], start:6, end:8, courtIds:['c1'] },
      { enabled:true, label:'private', mode:'specific', dates:['2026-08-18'], start:8, end:9, courtIds:['c1'] },
    ] },
  };
  assert.equal(Intelligence.scheduleHourIsOpenPlay('2026-08-18', 6, 'c1', settings), true);
  assert.equal(Intelligence.scheduleHourIsOpenPlay('2026-08-18', 8, 'c1', settings), false);

  const snapshot = local({
    settings,
    bookings: [{
      ref:'LEARNING-ANCHOR', courtId:'c1', date:'2026-08-17', status:'completed',
      paymentStatus:'paid', analyticsEligible:true, slots:[8],
    }],
  });
  const openPlayCell = snapshot.heatmap.find(cell => cell.weekday === 2 && cell.start_hour === 6);
  const privateCell = snapshot.heatmap.find(cell => cell.weekday === 2 && cell.start_hour === 8);
  assert.equal(openPlayCell.available_hours, 2);
  assert.equal(openPlayCell.booked_hours, 1);
  assert.ok(openPlayCell.utilization_pct > 0);
  assert.equal(privateCell.available_hours, 1);
  assert.equal(privateCell.booked_hours, 0);
});

test('non-Open-Play blocked hours count as neither capacity nor demand', () => {
  const bookings = [
    { ref:'BLOCKED-HOUR', courtId:'c1', date:'2026-08-18', status:'completed', slots:[6] },
    { ref:'SELLABLE-HOUR', courtId:'c1', date:'2026-08-18', status:'completed', slots:[8] },
  ];
  const base = local({ settings: { open_hour:'6', close_hour:'9' }, bookings });
  const excluded = local({
    settings: {
      open_hour:'6',
      close_hour:'9',
      maintenance_config: { rules: [
        { enabled:true, label:'private', mode:'specific', dates:['2026-08-18'], start:6, end:8, courtIds:[] },
        { enabled:true, label:'maintenance', mode:'specific', dates:['2026-08-18'], start:6, end:8, courtIds:['c1'] },
      ] },
      open_play_config: { enabled:true, specificDates:['2026-08-18'], days:[], start:7, end:8, courtIds:[] },
    },
    bookings,
  });

  assert.equal(excluded.kpis.available_hours, base.kpis.available_hours - 1);
  assert.equal(excluded.kpis.booked_hours, 2);
  assert.equal(excluded.kpis.successful_reservations, 1);
  assert.equal(
    excluded.heatmap.find(cell => cell.weekday === 2 && cell.start_hour === 6).comparable_days,
    base.heatmap.find(cell => cell.weekday === 2 && cell.start_hour === 6).comparable_days - 1,
  );
  assert.equal(
    excluded.heatmap.find(cell => cell.weekday === 2 && cell.start_hour === 8).comparable_days,
    base.heatmap.find(cell => cell.weekday === 2 && cell.start_hour === 8).comparable_days,
  );
});

test('a fully blocked historical hour removes the date from comparable days', () => {
  const bookings = [
    { ref:'SELLABLE-ANCHOR', courtId:'c1', date:'2026-08-17', status:'completed', slots:[8] },
    { ref:'BLOCKED-BASELINE', courtId:'c1', date:'2026-08-18', status:'completed', slots:[6] },
  ];
  const base = local({
    settings: { open_hour:'6', close_hour:'9' },
    bookings,
  });
  const snapshot = local({
    settings: {
      open_hour:'6', close_hour:'9',
      maintenance_config: { rules: [{
        enabled:true, label:'private', mode:'specific', dates:['2026-08-18'], start:0, end:24, courtIds:[],
      }] },
    },
    bookings,
  });
  const baseTuesday = base.court_signals.find(cell => cell.weekday === 2 && cell.start_hour === 6);
  const tuesday = snapshot.court_signals.find(cell => cell.weekday === 2 && cell.start_hour === 6);
  assert.equal(tuesday.available_hours, baseTuesday.available_hours - 1);
  assert.equal(tuesday.comparable_days, baseTuesday.comparable_days - 1);
  assert.equal(snapshot.kpis.booked_hours, 1);
  assert.equal(snapshot.kpis.successful_reservations, 1);
});

test('an excluded booking cannot start the 30-day learning clock', () => {
  const snapshot = local({
    settings: {
      open_hour:'6', close_hour:'9',
      maintenance_config: { rules: [{
        enabled:true, label:'closed', mode:'specific', dates:['2026-06-01'], start:0, end:24, courtIds:[],
      }] },
    },
    bookings: [
      { ref:'BLOCKED-OLD', courtId:'c1', date:'2026-06-01', status:'completed', slots:[6] },
      { ref:'FIRST-SELLABLE', courtId:'c1', date:'2026-08-18', status:'completed', slots:[8] },
    ],
  });
  assert.equal(snapshot.period.from, '2026-08-18');
  assert.equal(snapshot.kpis.successful_reservations, 1);
  assert.equal(snapshot.recommendation, null);
});

test('overnight blocks follow the occurrence start date and remain end-exclusive', () => {
  const specific = {
    maintenance_config: {
      enabled:true, label:'private', mode:'specific', dates:['2026-08-17'], start:22, end:2, courtIds:[],
    },
  };
  assert.equal(Intelligence.scheduleHourUnavailable('2026-08-17', 23, 'c1', specific), true);
  assert.equal(Intelligence.scheduleHourUnavailable('2026-08-18', 1, 'c1', specific), true);
  assert.equal(Intelligence.scheduleHourUnavailable('2026-08-17', 1, 'c1', specific), false);
  assert.equal(Intelligence.scheduleHourUnavailable('2026-08-18', 2, 'c1', specific), false);

  const recurring = {
    maintenance_config: { rules: [
      { enabled:true, mode:'weekly', recurring:{days:[1]}, start:22, end:2, courtIds:[] },
      { enabled:true, mode:'monthly', recurring:{day:31}, start:22, end:2, courtIds:['c2'] },
    ] },
    open_play_config: { enabled:true, days:[1], specificDates:[], start:22, end:2, courtIds:['c3'] },
  };
  assert.equal(Intelligence.scheduleHourUnavailable('2026-08-18', 1, 'c1', recurring), true);
  assert.equal(Intelligence.scheduleHourUnavailable('2026-09-01', 1, 'c2', recurring), true);
  assert.equal(Intelligence.scheduleHourUnavailable('2026-08-18', 1, 'c3', recurring), true);
});

test('a future booking inside blocked time does not subtract capacity twice', () => {
  const commonSettings = { open_hour:'6', close_hour:'9' };
  const bookings = [{ ref:'BASE', courtId:'c1', date:'2026-06-01', status:'completed', slots:[8] }];
  const block = {
    enabled:true, label:'group', mode:'specific', dates:['2026-09-01'], start:6, end:8, courtIds:[],
  };
  const blockedOnly = local({
    settings: { ...commonSettings, maintenance_config:{ rules:[block] } },
    bookings,
  });
  const blockedAndBooked = local({
    settings: { ...commonSettings, maintenance_config:{ rules:[block] } },
    bookings: [...bookings, { ref:'FUTURE-BLOCKED', courtId:'c1', date:'2026-09-01', status:'confirmed', slots:[6] }],
  });
  assert.equal(blockedAndBooked.kpis.expected_unsold_hours, blockedOnly.kpis.expected_unsold_hours);
});

test('blocked dates exclude their bookings from both numerator and learning start', () => {
  const snapshot = local({
    settings: { open_hour:'6', close_hour:'9' },
    blockedDates: ['2026-06-01'],
    bookings: [
      { ref:'BLOCKED-DATE', courtId:'c1', date:'2026-06-01', status:'completed', slots:[6] },
      { ref:'SELLABLE', courtId:'c1', date:'2026-08-18', status:'completed', slots:[8] },
    ],
  });
  assert.equal(snapshot.period.from, '2026-08-18');
  assert.equal(snapshot.kpis.booked_hours, 1);
  assert.equal(snapshot.kpis.successful_reservations, 1);
});

test('the visible local Insights engine uses the same sellable-hour exclusions', () => {
  const db = {
    settings: {
      open_hour:'6', close_hour:'9',
      maintenance_config: JSON.stringify({ rules:[{
        enabled:true, label:'reserved', mode:'specific', dates:['2026-08-18'], start:6, end:8, courtIds:[],
      }] }),
      open_play_config: JSON.stringify({ enabled:false, days:[], specificDates:[], start:6, end:7, courtIds:[] }),
    },
    courts: [{ id:'c1', name:'Court 1', rate:360, createdAt:'2026-06-01T00:00:00Z', blocked:false }],
    blockedDates: ['2026-08-19'],
    bookings: [
      { ref:'ANCHOR', courtId:'c1', date:'2026-08-17', status:'completed', paymentStatus:'paid', analyticsEligible:true, slots:[6] },
      { ref:'MAINT', courtId:'c1', date:'2026-08-18', status:'completed', paymentStatus:'paid', analyticsEligible:true, slots:[6] },
      { ref:'SELLABLE', courtId:'c1', date:'2026-08-18', status:'completed', paymentStatus:'paid', analyticsEligible:true, slots:[8] },
      { ref:'CLOSED-DATE', courtId:'c1', date:'2026-08-19', status:'completed', paymentStatus:'paid', analyticsEligible:true, slots:[8] },
    ],
    demandCampaigns: [], demandCampaignRedemptions: [],
  };
  const result = visibleLocalGrowth(db, { from:'2026-08-17', to:'2026-08-19' });
  assert.equal(result.kpis.available_hours, 4);
  assert.equal(result.kpis.booked_hours, 2);
  assert.equal(result.kpis.successful_reservations, 2);
});

test('the visible local Insights engine preserves fractional duration and avoids future double subtraction', () => {
  const baseDb = {
    settings: {
      open_hour:'6', close_hour:'9',
      maintenance_config: JSON.stringify({ rules:[{
        enabled:true, label:'group', mode:'specific', dates:['2026-09-01'], start:6, end:8, courtIds:[],
      }] }),
    },
    courts: [{ id:'c1', name:'Court 1', rate:360, createdAt:'2026-06-01T00:00:00Z', blocked:false }],
    blockedDates: [], demandCampaigns: [], demandCampaignRedemptions: [],
    bookings: [{
      ref:'FRACTIONAL', courtId:'c1', date:'2026-08-17', status:'completed', paymentStatus:'paid', analyticsEligible:true,
      slots:[], startTime:'6:00 AM', duration:1.5,
    }],
  };
  const withoutFuture = visibleLocalGrowth(baseDb, { from:'2026-08-17', to:'2026-08-17' });
  const withBlockedFuture = visibleLocalGrowth({
    ...baseDb,
    bookings: [...baseDb.bookings, {
      ref:'FUTURE-BLOCKED', courtId:'c1', date:'2026-09-01', status:'confirmed', slots:[6],
    }],
  }, { from:'2026-08-17', to:'2026-08-17' });
  assert.equal(withoutFuture.kpis.booked_hours, 1.5);
  assert.equal(withBlockedFuture.kpis.expected_unsold_hours, withoutFuture.kpis.expected_unsold_hours);
});

test('the visible Insights surface is demand-only and inline browser code parses', () => {
  const html = fs.readFileSync(path.join(__dirname,'admin.html'),'utf8');
  const visible = html.slice(html.indexOf('<div class="dg-shell">'), html.indexOf('<div class="oi-legacy"'));
  assert.match(visible, /Find weak hours\. Fill more courts\./);
  assert.match(html, /Start protected test/);
  assert.match(html, /Test a Facebook promotion at regular price/);
  assert.doesNotMatch(visible, /payment review|outstanding balance|revenue momentum|payments collected|booking pipeline/i);
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  blocks.forEach((match,index) => assert.doesNotThrow(() => new vm.Script(match[1],{filename:`admin-inline-${index}.js`})));
  assert.match(html,/const requestSeq = \+\+_oiRequestSeq;/);
  assert.match(html,/if \(requestSeq !== _oiRequestSeq\) return;/);
});

test('selecting All courts is preserved when the Insights court list refreshes', () => {
  const html = fs.readFileSync(path.join(__dirname,'admin.html'),'utf8');
  const start = html.indexOf('async function ensureInsightsCourts(');
  const end = html.indexOf('\nfunction renderInsightsKpis(', start);
  assert.ok(start >= 0 && end > start, 'court option refresh helper must exist');
  const helper = html.slice(start, end);
  assert.match(helper, /selectedValues\s*=\s*new Map\(selects\.map\(select\s*=>\s*\[select,\s*select\.value\]\)\)/);
  assert.match(helper, /const selected\s*=\s*selectedValues\.get\(select\)\s*\|\|\s*''/);
  assert.doesNotMatch(helper, /\$\('dgCourt'\)\?\.value\s*\|\|\s*\$\('oiCourt'\)\?\.value/);
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
  assert.match(controller,/Limited Court Deal applied/);
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

  assert.match(html,/const experiment = await DB\.createProfitLearningExperimentFromRecommendation/);
  assert.match(html,/String\(experiment\?\.status \|\| ''\)\.toLowerCase\(\) !== 'active'/);
  assert.match(html,/courtId:\s*\$\('dgCourt'\)\?\.value \|\| null/);
  assert.doesNotMatch(
    html.slice(html.indexOf('async function applyDemandRecommendation()'), html.indexOf('async function endProfitLearningExperiment(')),
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

test('sellable-capacity migration is additive, pinned, and production-verifiable', () => {
  const migration = fs.readFileSync(path.join(
    __dirname,
    'supabase',
    'migrations',
    '20260826170000_demand_growth_schedule_capacity.sql',
  ), 'utf8');
  const workflow = fs.readFileSync(path.join(
    __dirname,
    '.github',
    'workflows',
    'apply-demand-growth-schedule-capacity.yml',
  ), 'utf8');
  const migrationSha = crypto.createHash('sha256').update(migration).digest('hex');
  const applyStep = workflow.slice(
    workflow.indexOf('- name: Apply Demand sellable-capacity migration exactly once'),
    workflow.indexOf('- name: Verify production database state'),
  );

  assert.match(migration,/create or replace function public\.demand_schedule_hour_is_unavailable/i);
  assert.match(migration,/historical_capacity_units as materialized/i);
  assert.match(migration,/future_capacity_units as materialized/i);
  assert.match(migration,/signal_dimensions as materialized[\s\S]*generate_series\(1, 7\)/i);
  assert.match(migration,/left join historical_capacity_by_cell/i);
  assert.match(migration,/count\(distinct unit\.capacity_date\)/i);
  assert.match(migration,/not public\.demand_schedule_hour_is_unavailable/gi);
  assert.match(migration,/then p_date - 1/i);
  assert.match(migration,/extensions\.digest/i);
  assert.doesNotMatch(migration,/public\.digest/i);
  assert.match(migration,/grant execute on function public\.demand_schedule_hour_is_unavailable[\s\S]*intelligence_owner/i);
  assert.doesNotMatch(migration,/\b(?:insert|update|delete|truncate)\s+(?:from\s+)?public\.(?:bookings|payments|settings|courts|blocked_dates)\b/i);
  assert.doesNotMatch(migration,/\b(?:create|alter|drop|truncate)\s+table\b/i);

  assert.match(workflow,/name: Read-only production preflight/i);
  assert.match(workflow,/MIGRATION_FILE: supabase\/migrations\/20260826170000_/i);
  assert.match(workflow,new RegExp(`MIGRATION_SHA256: ${migrationSha}`));
  assert.match(workflow,new RegExp(`sha256:${migrationSha}`));
  assert.match(workflow,/has_function_privilege[\s\S]*demand_function[\s\S]*helper_function/i);
  assert.match(workflow,/Overnight occurrence-date or end-boundary matching failed/);
  assert.match(workflow,/Canonical Demand migration history exists, but the schema has drifted/);
  assert.match(applyStep,/Exactly one mutation request and no automatic retry/i);
  assert.doesNotMatch(applyStep,/--retry/);
});
