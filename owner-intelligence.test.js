const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Intelligence = require('./owner-intelligence.js');

function snapshot(overrides = {}) {
  return {
    period: { operating_days: 20 },
    kpis: {
      outstanding_balance: 0,
      total_reservations: 20,
      cancellation_rate: 0,
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

test('database contract is owner-only, PII-free, and historical by default', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'supabase', 'migrations', '20260825190000_owner_intelligence.sql'), 'utf8');
  assert.match(sql, /account_role not in \('owner', 'court_owner'\)/);
  assert.match(sql, /range_start := coalesce\(p_from, earliest_reliable_date, range_end\)/);
  assert.match(sql, /revoke all on function public\.get_owner_intelligence/);
  assert.match(sql, /grant execute on function public\.get_owner_intelligence[^;]+to authenticated/);
  assert.doesNotMatch(sql, /jsonb_build_object\([^)]*'email'/s);
  assert.doesNotMatch(sql, /jsonb_build_object\([^)]*'contact_number'/s);
  assert.doesNotMatch(sql, /jsonb_build_object\([^)]*'gcash_ref'/s);
  assert.doesNotMatch(sql, /jsonb_build_object\([^)]*'receipt_image'/s);
});
