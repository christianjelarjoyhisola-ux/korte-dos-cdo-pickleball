'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(
  __dirname,
  'supabase',
  'migrations',
  '20260826180000_profit_learning_v2.sql',
);
const sql = fs.readFileSync(migrationPath, 'utf8');
const workflow = fs.readFileSync(path.join(
  __dirname,
  '.github',
  'workflows',
  'apply-profit-learning-v2-production-migration.yml',
), 'utf8');

function functionBody(name) {
  const start = sql.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\b`, 'i'));
  assert.notEqual(start, -1, `${name} must exist`);
  const next = sql.slice(start + 1).search(/create\s+or\s+replace\s+function\s+public\./i);
  return next === -1 ? sql.slice(start) : sql.slice(start, start + 1 + next);
}

test('Profit Learning V2 is additive and cannot affect booking or payment mutations', () => {
  assert.doesNotMatch(sql, /alter\s+table\s+public\.bookings/i);
  assert.doesNotMatch(sql, /(?:before|after)\s+[^;]*\s+on\s+public\.bookings/i);
  assert.doesNotMatch(sql, /create\s+or\s+replace\s+function\s+public\.(?:apply_matching_demand_campaign|apply_booking_voucher|guard_public_booking_hold_update|finalize_public_booking_holds|review_booking_payment)/i);
  assert.match(sql, /reads bookings to[\s\S]*never changes the booking schema/i);
});

test('schema separates experiments, immutable assignments, evidence, and outcomes', () => {
  for (const table of [
    'profit_learning_experiments',
    'profit_learning_occurrences',
    'profit_learning_occurrence_events',
    'profit_learning_occurrence_outcomes',
  ]) {
    assert.match(sql, new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${table}`, 'i'));
    assert.match(sql, new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`, 'i'));
    assert.match(sql, new RegExp(`revoke\\s+all\\s+on\\s+public\\.${table}[\\s\\S]*?from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated`, 'i'));
  }
  assert.match(sql, /unique\s*\(\s*experiment_id\s*,\s*pair_no\s*,\s*arm\s*\)/i);
  assert.match(sql, /unique\s*\(\s*court_id\s*,\s*play_date\s*,\s*slot_hour\s*\)/i);
  assert.match(sql, /before\s+update\s+or\s+delete\s+on\s+public\.profit_learning_occurrences/i);
  assert.match(sql, /before\s+update\s+or\s+delete\s+on\s+public\.profit_learning_occurrence_events/i);
  assert.match(sql, /before\s+update\s+or\s+delete\s+on\s+public\.profit_learning_occurrence_outcomes/i);
});

test('paid-success invariant is exact and excludes internal holds', () => {
  const helper = functionBody('profit_learning_booking_is_successful');
  assert.match(helper, /coalesce\(p_analytics_eligible,\s*false\)/i);
  assert.match(helper, /p_lifecycle_status[\s\S]*in\s*\(\s*'confirmed'\s*,\s*'completed'\s*\)/i);
  assert.match(helper, /p_payment_status[\s\S]*in\s*\(\s*'paid'\s*,\s*'downpayment_paid'\s*\)/i);
  assert.match(helper, /p_email[\s\S]*<>\s*'reserve@hold\.internal'/i);
  assert.doesNotMatch(helper, /cancelled|failed|rejected|expired|forfeited/);
});

test('intelligence is one-hour and prices every signal authoritatively', () => {
  const intelligence = functionBody('get_profit_learning_v2_intelligence');
  assert.match(intelligence, /generate_series\(open_hour,\s*close_hour\s*-\s*1\)/i);
  assert.doesNotMatch(intelligence, /generate_series\([^)]*,\s*3\s*\)/i);
  assert.match(intelligence, /hour_value::integer\s*\+\s*1\s+as\s+end_hour/i);
  assert.match(intelligence, /calculate_booking_court_total\s*\(\s*court\.id\s*,\s*array\[hour_cell\.slot_hour::text\]/i);
  assert.match(intelligence, /'hourly_rate'\s*,\s*signal\.hourly_rate/i);
  assert.match(intelligence, /'action'\s*,\s*'facebook_regular_price'/i);
  assert.match(intelligence, /'discount_percent'\s*,\s*0/i);
  assert.match(intelligence, /'target_pairs'\s*,\s*8/i);
  assert.match(intelligence, /'active_experiment'/i);
  assert.match(intelligence, /'active_occurrences'/i);
});

test('creation assigns eight balanced whole-occurrence pairs at regular price', () => {
  const create = functionBody('create_profit_learning_experiment_from_recommendation');
  assert.match(create, /limit\s+16/i);
  assert.match(create, /inserted_occurrences\s*<>\s*16/i);
  assert.match(create, /pair_no[\s\S]*pair_position/i);
  assert.match(create, /then\s+'treatment'\s+else\s+'control'/i);
  assert.match(create, /then\s+'control'\s+else\s+'treatment'/i);
  assert.match(create, /calculate_booking_court_total\s*\([\s\S]*array\[inserted\.slot_hour::text\]/i);
  assert.match(create, /demand_schedule_hour_is_unavailable/i);
  assert.match(create, /public\.blocked_dates/i);
  assert.match(create, /from\s+public\.bookings\s+booking/i);
  assert.match(create, /public\.demand_campaigns[\s\S]*campaign\.status\s*=\s*'active'/i);
});

test('publication evidence is treatment-only and append-only', () => {
  const publication = functionBody('record_profit_learning_facebook_publication');
  assert.match(publication, /occurrence\.arm\s*=\s*'treatment'/i);
  assert.match(publication, /experiment\.status\s*=\s*'active'/i);
  assert.match(publication, /'facebook_published'/i);
  assert.match(publication, /on\s+conflict\s*\(\s*occurrence_id\s*,\s*event_type\s*\)[\s\S]*do\s+nothing/i);
});

test('final outcomes are insert-once and use exact assigned hourly secured revenue', () => {
  const finalize = functionBody('finalize_profit_learning_occurrence_outcomes');
  assert.match(finalize, /profit_learning_booking_is_successful\s*\(/i);
  assert.match(finalize, /successful_paid_booking_count/i);
  assert.match(finalize, /then\s+classified\.regular_rate_snapshot\s+else\s+0/i);
  assert.match(finalize, /secured_court_revenue/i);
  assert.match(finalize, /on\s+conflict\s*\(\s*occurrence_id\s*\)\s*do\s+nothing/i);
  assert.match(finalize, /promotion_not_published/i);
  assert.match(finalize, /published_after_booking/i);
  assert.match(finalize, /price_changed/i);
  assert.doesNotMatch(finalize, /booking_fee|service_fee|voucher_gross/i);
});

test('results require eight eligible pairs and report paired secured revenue', () => {
  const results = functionBody('get_profit_learning_experiment_results');
  assert.match(results, /arm_count\s*=\s*2/i);
  assert.match(results, /both_eligible/i);
  assert.match(results, /completed_pairs\s*<\s*experiment\.target_pairs/i);
  assert.match(results, /2\.365\s*\*/i);
  assert.match(results, /incremental_secured_court_revenue_per_sellable_hour/i);
  assert.match(results, /promotion_cost'\s*,\s*0/i);
  assert.match(results, /'profitable'/i);
  assert.match(results, /'harmful'/i);
  assert.match(results, /'inconclusive'/i);
});

test('owner mutation RPCs are authenticated-only', () => {
  for (const signature of [
    'create_profit_learning_experiment_from_recommendation\\(\\s*text\\s*,\\s*text\\s*\\)',
    'record_profit_learning_facebook_publication\\(\\s*uuid\\s*,\\s*uuid\\[\\]\\s*,\\s*jsonb\\s*\\)',
    'finalize_profit_learning_occurrence_outcomes\\(\\s*uuid\\s*\\)',
    'get_profit_learning_experiment_results\\(\\s*uuid\\s*\\)',
    'end_profit_learning_experiment\\(\\s*uuid\\s*\\)',
  ]) {
    assert.match(sql, new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${signature}[\\s\\S]*?from\\s+public\\s*,\\s*anon`, 'i'));
    assert.match(sql, new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${signature}[\\s\\S]*?to\\s+authenticated`, 'i'));
  }
});

test('production release is checksum locked, single-attempt, and verified', () => {
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(migrationPath)).digest('hex');
  assert.match(workflow, new RegExp(`MIGRATION_SHA256:\\s*${checksum}`, 'i'));
  assert.match(workflow, /Read-only production preflight/i);
  assert.match(workflow, /schema exists without canonical history; refusing a partial rerun/i);
  assert.match(workflow, /Apply checksum-locked migration exactly once/i);
  const applyStep = workflow.slice(
    workflow.indexOf('- name: Apply checksum-locked migration exactly once'),
    workflow.indexOf('- name: Verify production database state'),
  );
  assert.doesNotMatch(applyStep, /--retry\b/i);
  assert.match(workflow, /Profit Learning V2 production migration verified/i);
  assert.match(workflow, /has_function_privilege\('anon'/i);
  assert.match(workflow, /relrowsecurity/i);
});
