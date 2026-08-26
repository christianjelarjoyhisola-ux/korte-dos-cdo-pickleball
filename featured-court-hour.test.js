'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = __dirname;
const MIGRATION_RELATIVE = 'supabase/migrations/20260826220000_public_featured_court_hour.sql';
const migration = fs.readFileSync(path.join(ROOT, MIGRATION_RELATIVE), 'utf8');
const config = fs.readFileSync(path.join(ROOT, 'supabase-config.js'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const workflow = fs.readFileSync(path.join(
  ROOT, '.github', 'workflows', 'apply-public-featured-court-hour.yml',
), 'utf8');

function sqlFunction(source, name) {
  const marker = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, 'i');
  const match = marker.exec(source);
  assert.ok(match, `public.${name} must be defined`);
  const rest = source.slice(match.index);
  const opening = /\bas\s+(\$[A-Za-z0-9_]*\$)/i.exec(rest);
  assert.ok(opening, `public.${name} must use a dollar-quoted body`);
  const bodyStart = opening.index + opening[0].length;
  const bodyEnd = rest.indexOf(opening[1], bodyStart);
  assert.ok(bodyEnd > bodyStart, `public.${name} must have a complete body`);
  return rest.slice(0, bodyEnd + opening[1].length + 1);
}

function objectMethodAt(source, name, occurrence = 0) {
  const marker = `async ${name}(`;
  let start = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    start = source.indexOf(marker, start + 1);
    assert.notEqual(start, -1, `${name} occurrence ${occurrence + 1} must exist`);
  }
  const indent = source.slice(source.lastIndexOf('\n', start) + 1, start);
  const candidates = [
    source.indexOf(`\n${indent}async `, start + marker.length),
    source.indexOf(`\n${indent}//`, start + marker.length),
    source.indexOf(`\n${indent}};`, start + marker.length),
  ].filter(index => index > start);
  assert.ok(candidates.length, `${name} occurrence ${occurrence + 1} must have a detectable end`);
  return source.slice(start, Math.min(...candidates)).replace(/,\s*$/, '').trim();
}

function namedFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test('public Featured Court Hour RPC returns one rigorously revalidated PII-free regular-price slot', () => {
  const rpc = sqlFunction(migration, 'get_public_featured_court_hour');
  const returned = /returns\s+table\s*\(([\s\S]*?)\)\s*(?:language|stable|security)/i.exec(rpc);
  assert.ok(returned);
  const columns = returned[1].split(',')
    .map(column => column.trim().match(/^([a-z_][a-z0-9_]*)\b/i)?.[1])
    .filter(Boolean);
  assert.deepEqual(columns, [
    'placement_token', 'court_id', 'court_name', 'play_date', 'slot_hour',
    'end_hour', 'regular_rate', 'expires_at',
  ]);

  assert.match(rpc, /experiment\.status\s*=\s*'active'/i);
  assert.match(rpc, /experiment\.target_pairs\s*=\s*1/i);
  assert.match(rpc, /occurrence\.arm\s*=\s*'treatment'/i);
  assert.match(rpc, /facebook_regular_price/i);
  assert.match(rpc, /experiment\.discount_percent\s*=\s*0/i);
  assert.match(rpc, /from\s+public\.demand_campaigns[\s\S]*?campaign\.status\s*=\s*'active'/i);
  assert.match(rpc, /Asia\/Manila/i);
  assert.match(rpc, /clock\.local_today\s*\+\s*28/i);
  assert.match(rpc, /expires_at[\s\S]*?>\s*clock\.requested_at/i);
  assert.match(rpc, /not\s+coalesce\(court\.blocked,\s*false\)/i);
  assert.match(rpc, /from\s+public\.blocked_dates/i);
  assert.match(rpc, /demand_schedule_hour_is_unavailable/i);
  assert.match(rpc, /setting\.key\s*=\s*'open_hour'[\s\S]*?setting\.key\s*=\s*'close_hour'/i);
  assert.match(rpc, /from\s+public\.bookings/i);
  assert.match(rpc, /not\s+in\s*\(\s*'cancelled'\s*,\s*'forfeited'\s*\)/i);
  assert.match(rpc, /booking\.created_at\s+is\s+null[\s\S]*?interval\s*'15 minutes'/i);
  assert.match(rpc, /calculate_booking_court_total/i);
  assert.match(rpc, /candidate\.current_rate\s*=\s*candidate\.regular_rate_snapshot/i);
  assert.match(rpc, /event_type\s*=\s*'placement_activated'/i);
  assert.match(rpc, /limit\s+1/i);
  assert.match(rpc, /\bstable\b/i);
  assert.match(rpc, /security\s+definer/i);
  assert.doesNotMatch(returned[1], /experiment_id|occurrence_id|customer|email|contact|booking|payment|receipt/i);
  assert.doesNotMatch(rpc, /\b(?:insert\s+into|update\s+public\.|delete\s+from|truncate)\b/i);
  assert.match(migration, /grant\s+execute\s+on\s+function\s+public\.get_public_featured_court_hour\(\)[\s\S]*?to\s+anon\s*,\s*authenticated/i);
});

test('on-site activation is owner evidence for current and future one-hour Best Moves', () => {
  assert.match(migration, /placement_activated/);
  assert.match(migration, /after\s+insert\s+on\s+public\.profit_learning_occurrences/i);
  assert.match(migration, /experiment\.target_pairs\s*=\s*1/i);
  assert.match(migration, /experiment\.status\s*=\s*'active'/i);
  assert.match(migration, /on\s+conflict\s*\(\s*occurrence_id\s*,\s*event_type\s*\)[\s\S]*?do\s+nothing/i);
  assert.match(migration, /event\.event_type\s+in\s*\(\s*'facebook_published'\s*,\s*'placement_activated'\s*\)/i);
  assert.match(migration, /finalize_profit_learning_occurrence_outcomes[\s\S]*?pg_get_functiondef/i);
  assert.doesNotMatch(migration, /create\s+or\s+replace\s+function\s+public\.record_profit_learning_facebook_publication/i);
});

test('public funnel RPC is append-only, session-deduplicated, bounded, and PII-free', () => {
  const rpc = sqlFunction(migration, 'record_public_featured_court_event');
  assert.match(migration, /create\s+table\s+if\s+not\s+exists\s+public\.profit_learning_public_placement_events/i);
  assert.match(migration, /enable\s+row\s+level\s+security/i);
  assert.match(migration, /before\s+update\s+or\s+delete\s+on\s+public\.profit_learning_public_placement_events/i);
  assert.match(migration, /unique\s+index[\s\S]*?occurrence_id\s*,\s*event_type\s*,\s*session_hash/i);
  assert.match(rpc, /impression[\s\S]*?open[\s\S]*?slot_click[\s\S]*?booking_started/i);
  assert.match(rpc, /extensions\.digest\s*\([\s\S]*?'sha256'/i);
  assert.match(rpc, /join\s+public\.get_public_featured_court_hour\(\)/i);
  assert.match(rpc, /recent_count\s*>=\s*120/i);
  assert.match(rpc, /on\s+conflict\s*\(\s*occurrence_id\s*,\s*event_type\s*,\s*session_hash\s*\)[\s\S]*?do\s+nothing/i);
  assert.doesNotMatch(rpc, /insert\s+into\s+public\.(?:bookings|payments|vouchers)/i);
  assert.doesNotMatch(migration, /alter\s+table\s+public\.(?:bookings|payments|vouchers)/i);
  assert.doesNotMatch(rpc, /\b(?:full_name|email|contact_number|booking_ref|payment_ref|receipt)\b/i);
  assert.match(migration, /grant\s+execute\s+on\s+function\s+public\.record_public_featured_court_event\(text,\s*text,\s*text,\s*text\)[\s\S]*?to\s+anon\s*,\s*authenticated/i);
});

test('production data layer normalizes and fail-soft tracks the exact public placement', () => {
  const readMethod = objectMethodAt(config, 'getPublicFeaturedCourtHour', 0);
  const eventMethod = objectMethodAt(config, 'recordFeaturedCourtPlacementEvent', 0);
  assert.match(readMethod, /_publicBookingSb\.rpc\(\s*'get_public_featured_court_hour'/i);
  assert.match(readMethod, /_pbCached\(\s*'publicFeaturedCourtHour'/i);
  assert.match(readMethod, /PB_PUBLIC_OFFER_TIMEOUT_MS/);
  assert.match(readMethod, /publicFeaturedCourtHourFromRow/i);
  assert.match(readMethod, /options\?\.force/i);
  assert.match(readMethod, /return\s+null/i);
  const clearCache = config.slice(
    config.indexOf('function _pbClearFastCache('),
    config.indexOf('function _pbHasAuthSession(', config.indexOf('function _pbClearFastCache(')),
  );
  assert.match(clearCache, /bookings[\s\S]*?blockedDates[\s\S]*?settings[\s\S]*?publicFeaturedCourtHour/i);

  assert.match(eventMethod, /^async\s+recordFeaturedCourtPlacementEvent\(placementToken,\s*eventType\)/i);
  assert.match(eventMethod, /_pbFeaturedCourtSessionToken\(\)/i);
  assert.match(eventMethod, /_publicBookingSb\.rpc\(\s*'record_public_featured_court_event'/i);
  assert.match(eventMethod, /p_session_token\s*:\s*sessionToken/i);
  assert.match(eventMethod, /p_source\s*:\s*_pbFeaturedCourtSource\(\)/i);
  assert.match(eventMethod, /catch\s*\([^)]*\)[\s\S]*?recorded:\s*false/i);
  assert.match(config, /sessionStorage\.setItem\(PB_FEATURED_COURT_SESSION_KEY,\s*created\)/i);
  assert.match(config, /crypto\?\.randomUUID|crypto\?\.getRandomValues/i);
});

test('featured-hour normalizer accepts only an exact future one-hour placement', () => {
  const start = config.indexOf('function publicFeaturedCourtHourFromRow(');
  const end = config.indexOf('function _pbSecureRandomUuid(', start);
  assert.ok(start >= 0 && end > start);
  const context = { Date, Number, String };
  vm.createContext(context);
  vm.runInContext(`${config.slice(start, end)}\nthis.normalize = publicFeaturedCourtHourFromRow;`, context);
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  const valid = {
    placement_token: '550e8400-e29b-41d4-a716-446655440000',
    court_id: 'c2', court_name: 'Court 2', play_date: '2026-08-31',
    slot_hour: 23, end_hour: 24, regular_rate: 350, expires_at: expiresAt,
  };
  assert.deepEqual(JSON.parse(JSON.stringify(context.normalize(valid))), {
    placementToken: valid.placement_token,
    courtId: 'c2', courtName: 'Court 2', playDate: '2026-08-31',
    slotHour: 23, endHour: 24, regularRate: 350, expiresAt,
  });
  assert.equal(context.normalize({ ...valid, placement_token: 'occurrence-id' }), null);
  assert.equal(context.normalize({ ...valid, end_hour: 23 }), null);
  assert.equal(context.normalize({ ...valid, regular_rate: 0 }), null);
  assert.equal(context.normalize({ ...valid, expires_at: '2020-01-01T00:00:00Z' }), null);
});

test('local data mode mirrors availability checks, activation, exact-token tracking, and deduplication', () => {
  const readMethod = objectMethodAt(config, 'getPublicFeaturedCourtHour', 1);
  const eventMethod = objectMethodAt(config, 'recordFeaturedCourtPlacementEvent', 1);
  assert.match(readMethod, /target_pairs[\s\S]*?===\s*1/i);
  assert.match(readMethod, /facebook_regular_price/i);
  assert.match(readMethod, /db\.demandCampaigns[\s\S]*?row\.status\s*===\s*'active'/i);
  assert.match(readMethod, /localDateDiff\(today,\s*playDate\)[\s\S]*?>\s*28/i);
  assert.match(readMethod, /localFeaturedScheduleHourUnavailable/i);
  assert.match(readMethod, /localProfitBookingOccupies/i);
  assert.match(readMethod, /regular_rate_snapshot/i);
  assert.match(readMethod, /placement_activated/i);
  assert.match(eventMethod, /token\s*!==\s*placement\.placementToken/i);
  assert.match(eventMethod, /session_hash:\s*sessionHash/i);
  assert.match(eventMethod, /duplicate[\s\S]*?idempotent:\s*true/i);
  assert.match(config, /event_type:\s*'placement_activated'[\s\S]*?price_mode:\s*'regular'/i);
});

test('player Court Pick is truthful, revalidated, one-click, and isolated from booking writes', () => {
  const render = namedFunction(index, 'renderCourtPickPanel');
  const select = namedFunction(index, 'goToFeaturedCourtPick');
  assert.match(index, /id="courtPickInline"/i);
  assert.match(index, /class="featured-deal-trigger"/i);
  assert.match(index, /URLSearchParams\(location\.search\)\.get\('courtPick'\)/i);
  assert.match(index, /const COURT_PICK_EVENT_TYPES = new Set\(\['impression','open','slot_click','booking_started'\]\)/);
  assert.match(index, /result\?\.recorded === true \|\| result\?\.idempotent === true/);
  assert.match(render, /Korte DOS Court Pick/i);
  assert.match(render, /Regular price/i);
  assert.match(render, /Available now/i);
  assert.doesNotMatch(render, /\d+%\s*off|discount(?:ed)?/i);
  assert.match(select, /refreshFeaturedCourtPick\(\{ force:true \}\)/);
  assert.match(select, /await toggleCardSlot\(/);
  assert.match(select, /recordCourtPickEvent\('booking_started'/);
  assert.doesNotMatch(select, /DB\.(?:createBooking|saveBooking|createReservationHold|uploadReceipt)/);
  assert.match(index, /const showSmartOffer = !!smartOffer;[\s\S]*?trigger\.dataset\.mode = showSmartOffer \? 'smart-offer' : 'court-pick'/);
  assert.match(index, /@media\(max-width:700px\)[\s\S]*?\.featured-deal-panel\s*\{[\s\S]*?bottom:0;[\s\S]*?width:100%/);
});

test('production migration workflow is checksum-locked, exact-once, and verifies grants and evidence', () => {
  const checksum = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, MIGRATION_RELATIVE)))
    .digest('hex');
  assert.match(workflow, new RegExp(`MIGRATION_SHA256:\\s*${checksum}`));
  assert.match(workflow, /Read-only production preflight/i);
  assert.match(workflow, /exists without canonical history; refusing a partial rerun/i);
  assert.match(workflow, /Apply checksum-locked migration exactly once/i);
  const applyStep = workflow.slice(
    workflow.indexOf('- name: Apply checksum-locked migration exactly once'),
    workflow.indexOf('- name: Verify production database state'),
  );
  assert.doesNotMatch(applyStep, /--retry\b/i);
  assert.match(workflow, /has_function_privilege\('anon',\s*reader,\s*'execute'\)/i);
  assert.match(workflow, /has_table_privilege\('anon'[\s\S]*?'insert'\)/i);
  assert.match(workflow, /event\.event_type\s*=\s*'placement_activated'/i);
});
