const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Intelligence = require('./owner-intelligence.js');

function snapshot(overrides = {}) {
  return {
    period: { operating_days: 20 },
    kpis: {
      outstanding_balance: 0,
      payment_review_reservations: 0,
      total_reservations: 20,
      ...overrides.kpis,
    },
    heatmap: overrides.heatmap || [],
  };
}

test('confidence uses comparable operating evidence instead of deployment age', () => {
  assert.equal(Intelligence.confidenceFor({ comparable_days: 5, available_hours: 50 }).code, 'learning');
  assert.equal(Intelligence.confidenceFor({ comparable_days: 6, available_hours: 12 }).code, 'medium');
  assert.equal(Intelligence.confidenceFor({ comparable_days: 12, available_hours: 24 }).code, 'high');
});

test('historical trend grain stays readable at product boundaries', () => {
  assert.equal(Intelligence.trendGrainForDays(28), 'day');
  assert.equal(Intelligence.trendGrainForDays(29), 'week');
  assert.equal(Intelligence.trendGrainForDays(180), 'week');
  assert.equal(Intelligence.trendGrainForDays(181), 'month');
});

test('direct payment recovery is prioritized ahead of promotional suggestions', () => {
  const recommendations = Intelligence.buildRecommendations(snapshot({
    kpis: { outstanding_balance: 4200 },
    heatmap: [{
      weekday: 2, weekday_label: 'Tue', start_hour: 9, end_hour: 12,
      comparable_days: 15, available_hours: 45, booked_hours: 5, utilization_pct: 11.1,
    }],
  }));

  assert.equal(recommendations[0].type, 'payment_recovery');
  assert.match(recommendations[0].evidence, /4,200/);
  assert.ok(recommendations.some(item => item.type === 'off_peak'));
});

test('receipt-backed payment review is actionable and cancellation language is absent', () => {
  const recommendations = Intelligence.buildRecommendations(snapshot({
    kpis: { payment_review_reservations: 2, cancellation_rate: 80 },
  }));

  assert.equal(recommendations[0].type, 'payment_review');
  assert.equal(recommendations[0].actionSection, 'payreview');
  assert.ok(!recommendations.some(item => item.type === 'cancellation'));
});

test('off-peak and peak recommendations cite the actual weekday and time cell', () => {
  const recommendations = Intelligence.buildRecommendations(snapshot({
    heatmap: [
      { weekday_label: 'Tue', start_hour: 9, end_hour: 12, comparable_days: 14, available_hours: 42, booked_hours: 4, utilization_pct: 9.5 },
      { weekday_label: 'Sat', start_hour: 18, end_hour: 21, comparable_days: 14, available_hours: 42, booked_hours: 35, utilization_pct: 83.3 },
    ],
  }));

  const offPeak = recommendations.find(item => item.type === 'off_peak');
  const peak = recommendations.find(item => item.type === 'protect_peak');
  assert.match(offPeak.title, /Tue 9 AM–12 PM/);
  assert.match(offPeak.evidence, /14 comparable operating days/);
  assert.match(peak.title, /Sat 6 PM–9 PM/);
  assert.doesNotMatch(JSON.stringify(recommendations), /voucher/i);
  assert.ok(offPeak.plan && offPeak.guardrail && offPeak.successMetric && offPeak.reviewDate);
});

test('insufficient evidence produces a learning state instead of a fake action', () => {
  const recommendations = Intelligence.buildRecommendations(snapshot({
    heatmap: [{
      weekday_label: 'Mon', start_hour: 6, end_hour: 9,
      comparable_days: 2, available_hours: 6, booked_hours: 0, utilization_pct: 0,
    }],
  }));

  assert.deepEqual(recommendations.map(item => item.type), ['learning']);
  assert.equal(recommendations[0].action, '');
});

test('local capacity counts comparable dates once while multiplying available court-hours', () => {
  const local = Intelligence.buildLocalSnapshot({
    now: '2026-08-10T12:00:00Z',
    from: '2026-08-03',
    to: '2026-08-10',
    settings: { open_hour: '6', close_hour: '9' },
    courts: [{ id: 'c1', name: 'One' }, { id: 'c2', name: 'Two' }],
    blockedDates: [],
    bookings: [],
  });
  const monday = local.heatmap.find(cell => cell.weekday === 1 && cell.start_hour === 6);
  assert.equal(monday.comparable_days, 2);
  assert.equal(monday.available_hours, 12);
  assert.equal(local.kpis.available_hours, 48);
});

test('cancelled and forfeited attempts are excluded from booking pipeline and efficiency', () => {
  const local = Intelligence.buildLocalSnapshot({
    now: '2026-08-10T12:00:00Z',
    from: '2026-08-10',
    to: '2026-08-10',
    settings: { open_hour: '6', close_hour: '9' },
    courts: [{ id: 'c1', name: 'One' }],
    blockedDates: [],
    bookings: [
      { ref:'OK-1', courtId:'c1', date:'2026-08-10', status:'completed', paymentStatus:'paid', total:600, duration:2 },
      { ref:'BAD-1', courtId:'c1', date:'2026-08-10', status:'cancelled', paymentStatus:'paid', total:600, duration:2 },
      { ref:'FOR-1', courtId:'c1', date:'2026-08-10', status:'forfeited', paymentStatus:'deposit_retained', downpayment:300, total:600, duration:2 },
      { ref:'REV-1', courtId:'c1', date:'2026-08-10', status:'pending', paymentStatus:'for_verification', receiptStatus:'manual_review', receiptImageUrl:'REV-1/hash.jpg', receiptImageHash:'a'.repeat(64), total:600, duration:2 },
    ],
  });

  assert.deepEqual(local.lifecycle, [
    { status:'completed', count:1 },
    { status:'confirmed', count:0 },
    { status:'payment_review', count:1 },
  ]);
  assert.equal(local.kpis.total_reservations, 2);
  assert.equal(local.kpis.payment_review_reservations, 1);
  assert.equal(local.kpis.collected_revenue, 600);
  assert.equal(local.trend[0].collected_revenue, 600);
  assert.equal('retained_deposit_amount' in local.kpis, false);
  assert.equal(local.kpis.revenue_per_booked_hour, 300);
  assert.equal('cancellation_rate' in local.kpis, false);
});

test('future outlook is separate, horizon-based, and excludes failed attempts', () => {
  const local = Intelligence.buildLocalSnapshot({
    now: '2026-08-10T12:00:00Z',
    from: '2026-08-10',
    to: '2026-08-10',
    settings: { open_hour:'6', close_hour:'10' },
    courts: [{ id:'c1', name:'One' }],
    blockedDates: [],
    bookings: [
      { ref:'HIST', courtId:'c1', date:'2026-08-10', status:'completed', paymentStatus:'paid', total:600, duration:2 },
      { ref:'F-PAID', courtId:'c1', date:'2026-08-11', status:'confirmed', paymentStatus:'paid', total:900, duration:2 },
      { ref:'F-DOWN', courtId:'c1', date:'2026-08-12', status:'confirmed', paymentStatus:'downpayment_paid', downpayment:300, total:900, duration:2 },
      { ref:'F-CANCEL', courtId:'c1', date:'2026-08-13', status:'cancelled', paymentStatus:'paid', total:900, duration:2 },
      { ref:'F-FORFEIT', courtId:'c1', date:'2026-08-14', status:'forfeited', paymentStatus:'deposit_retained', downpayment:300, total:900, duration:2 },
      { ref:'F-REVIEW', courtId:'c1', date:'2026-08-15', status:'pending', paymentStatus:'for_verification', receiptStatus:'manual_review', total:900, duration:2 },
      { ref:'F-COMPLETE', courtId:'c1', date:'2026-08-16', status:'completed', paymentStatus:'paid', total:900, duration:2 },
    ],
  });
  const next7 = local.forward_outlook.horizons.find(item => item.days === 7).kpis;
  assert.equal(local.kpis.collected_revenue, 600);
  assert.equal(next7.secured_revenue, 1200);
  assert.equal(next7.committed_booking_value, 1800);
  assert.equal(next7.outstanding_balance, 600);
  assert.equal(next7.confirmed_reservations, 2);
  assert.equal(next7.payment_review_reservations, 1);
  assert.equal(next7.secured_revenue + next7.outstanding_balance, next7.committed_booking_value);
});

test('future recoverable money outranks growth experiments and review dates use today', () => {
  const recommendations = Intelligence.buildRecommendations({
    period:{to:'2026-01-01',generated_at:'2026-08-10T12:00:00Z'},
    kpis:{outstanding_balance:0,payment_review_reservations:0},
    forward_outlook:{as_of:'2026-08-10',horizons:[{days:30,kpis:{outstanding_balance:5000,payment_review_reservations:2}}]},
    heatmap:[{weekday_label:'Tue',start_hour:9,end_hour:12,comparable_days:14,available_hours:42,booked_hours:4,utilization_pct:9.5}],
  });
  assert.equal(recommendations[0].type,'future_payment_recovery');
  assert.equal(recommendations[1].type,'future_payment_review');
  assert.equal(recommendations[0].reviewDate,'2026-08-13');
  assert.doesNotMatch(JSON.stringify(recommendations),/voucher/i);
});

test('database contract is owner-only, PII-free, and historical by default', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'supabase', 'migrations', '20260825190000_owner_intelligence.sql'), 'utf8');
  assert.match(sql, /account_role not in \('owner', 'court_owner'\)/);
  assert.match(sql, /range_start := coalesce\(p_from, earliest_reliable_date, range_end\)/);
  assert.match(sql, /revoke all on function public\.get_owner_intelligence/);
  assert.match(sql, /revoke execute on function public\.get_owner_intelligence[^;]+from anon/);
  assert.match(sql, /grant execute on function public\.get_owner_intelligence[^;]+to authenticated/);
  assert.doesNotMatch(sql, /jsonb_build_object\([^)]*'email'/s);
  assert.doesNotMatch(sql, /jsonb_build_object\([^)]*'contact_number'/s);
  assert.doesNotMatch(sql, /jsonb_build_object\([^)]*'gcash_ref'/s);
  assert.doesNotMatch(sql, /jsonb_build_object\([^)]*'receipt_image'/s);
});

test('corrective database contract excludes operational losses from owner booking metrics', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'supabase', 'migrations', '20260825223000_owner_intelligence_payment_pipeline.sql'), 'utf8');
  assert.match(sql, /status in \('pending', 'verifying'\)[\s\S]*payment_status = 'for_verification'[\s\S]*durable_review_evidence/);
  assert.match(sql, /'payment_review_reservations'/);
  assert.match(sql, /- 'retained_deposit_amount'/);
  assert.match(sql, /forward_outlook/);
  assert.match(sql, /horizon_days\(days\) as \(values \(7\), \(30\), \(60\)\)/);
  assert.match(sql, /range_end - range_start \+ 1 <= 28/);
  assert.match(sql, /when lower\(coalesce\(b\.status, ''\)\) not in \('confirmed', 'completed'\) then 0/);
  assert.match(sql, /- 'cancellation_rate'/);
  assert.match(sql, /'payment_review'/);
  assert.doesNotMatch(sql, /jsonb_build_object\('status', '(?:cancelled|forfeited)'/);
});

test('Owner Intelligence browser script parses and ignores stale filter responses', () => {
  const html = fs.readFileSync(path.join(__dirname,'admin.html'),'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  blocks.forEach((match,index) => assert.doesNotThrow(() => new vm.Script(match[1],{filename:`admin-inline-${index}.js`})));
  assert.match(html,/const requestSeq = \+\+_oiRequestSeq;/);
  assert.match(html,/if \(requestSeq !== _oiRequestSeq\) return;/);
  assert.doesNotMatch(html,/yAxisID: 'bookings'/);
});
