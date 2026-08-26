'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = __dirname;
const MIGRATION_RELATIVE = 'supabase/migrations/20260826160000_public_demand_campaign_featured_offers.sql';
const MIGRATION_PATH = path.join(ROOT, MIGRATION_RELATIVE);
const WORKFLOW_PATH = path.join(
  ROOT,
  '.github',
  'workflows',
  'apply-public-demand-featured-offers-production-migration.yml',
);

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

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

test('featured-offer RPC is small, public, PII-free, and availability-aware', () => {
  assert.ok(fs.existsSync(MIGRATION_PATH), 'the additive featured-offer migration must exist');
  const migration = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const rpc = sqlFunction(migration, 'get_public_demand_campaign_featured_offers');
  const returned = /returns\s+table\s*\(([\s\S]*?)\)\s*(?:language|stable|security)/i.exec(rpc);

  assert.ok(returned, 'the RPC must have an explicit table return contract');
  const columns = returned[1]
    .split(',')
    .map(column => column.trim().match(/^([a-z_][a-z0-9_]*)\b/i)?.[1])
    .filter(Boolean);
  assert.deepEqual(columns, [
    'court_id',
    'court_name',
    'offer_date',
    'slot_hour',
    'discount_percent',
    'regular_rate',
    'offer_rate',
    'ends_at',
  ]);

  assert.match(rpc, /pg_catalog\.timezone\s*\([\s\S]*?'Asia\/Manila'/i);
  assert.match(rpc, /generate_series\s*\(\s*1\s*,\s*28\s*\)/i);
  assert.match(rpc, /extract\s*\(\s*isodow[\s\S]*?campaign\.weekday/i);
  assert.match(rpc, /campaign\.status\s*=\s*'active'/i);
  assert.match(rpc, /campaign\.starts_at\s*<=/i);
  assert.match(rpc, /campaign\.ends_at\s*>/i);
  assert.match(rpc, /campaign\.max_redemptions/i);
  assert.match(rpc, /redemption\.status\s*=\s*'redeemed'/i);
  assert.match(rpc, /redemption\.status\s*=\s*'reserved'[\s\S]*?reserved_until\s*>/i);
  assert.match(rpc, /court\.blocked\s*=\s*false/i);
  assert.match(rpc, /from\s+public\.blocked_dates/i);
  assert.match(rpc, /from\s+public\.settings/i);
  assert.match(rpc, /open_play_config/i);
  assert.match(rpc, /maintenance_config/i);
  assert.match(rpc, /setting\.key\s*=\s*'open_hour'[\s\S]*?setting\.key\s*=\s*'close_hour'/i);
  assert.match(rpc, /offered_hour\.slot_hour\s*>=\s*schedule\.open_hour::integer/i);
  assert.match(rpc, /offered_hour\.slot_hour\s*<\s*schedule\.close_hour::integer/i);
  assert.match(rpc, /jsonb_array_elements[\s\S]*?maintenance/i);
  assert.match(rpc, /maintenance\.rule\s*->>\s*'mode'\s*=\s*'monthly'/i);
  assert.match(rpc, /maintenance\.rule\s*->>\s*'mode'\s*=\s*'weekly'/i);
  assert.match(rpc, /from\s+public\.bookings/i);
  assert.match(rpc, /booking\.status\s+not\s+in\s*\(\s*'cancelled'\s*,\s*'forfeited'\s*\)/i);
  assert.match(rpc, /booking\.status\s*<>\s*'verifying'[\s\S]*?interval\s*'15 minutes'/i);
  assert.match(rpc, /unnest\s*\([\s\S]*?booking\.slots/i);
  assert.match(rpc, /calculate_booking_court_total\s*\(/i);
  assert.match(rpc, /regular_rate\s*\*\s*\(\s*100\s*-\s*priced\.discount_percent\s*\)\s*\/\s*100/i);
  assert.match(rpc, /order\s+by\s+priced\.offer_date\s*,\s*priced\.slot_hour/i);
  assert.match(rpc, /limit\s+6/i);
  assert.match(rpc, /\bstable\b/i);
  assert.match(rpc, /security\s+definer/i);
  assert.match(rpc, /set\s+search_path\s*=\s*pg_catalog\s*,\s*pg_temp/i);
  assert.doesNotMatch(rpc, /\b(?:insert\s+into|update\s+public\.|delete\s+from|truncate)\b/i);
  assert.doesNotMatch(returned[1], /\b(?:full_name|email|contact|payment|receipt|booking_ref|campaign_id)\b/i);
  assert.match(
    migration,
    /revoke\s+all\s+on\s+function\s+public\.get_public_demand_campaign_featured_offers\s*\(\s*\)[\s\S]*?from\s+public\s*,\s*anon\s*,\s*authenticated/i,
  );
  assert.match(
    migration,
    /grant\s+execute\s+on\s+function\s+public\.get_public_demand_campaign_featured_offers\s*\(\s*\)[\s\S]*?to\s+anon\s*,\s*authenticated/i,
  );
});

test('production featured-offer read is isolated, normalized, bounded, cached, and fail-open', () => {
  const config = read('supabase-config.js');
  const method = objectMethodAt(config, 'getPublicDemandCampaignFeaturedOffers', 0);
  const normalizerStart = config.indexOf('function publicDemandCampaignFeaturedOfferFromRow(');
  const normalizerEnd = config.indexOf('const PB_RESERVATION_HOLD_MINUTES', normalizerStart);
  const normalizer = config.slice(normalizerStart, normalizerEnd);

  assert.match(method, /_publicBookingSb\.rpc\s*\(\s*['"]get_public_demand_campaign_featured_offers['"]/);
  assert.match(method, /_pbCached\s*\(\s*['"]publicDemandCampaignFeaturedOffers['"]/);
  assert.match(method, /PB_PUBLIC_OFFER_TIMEOUT_MS/);
  assert.match(method, /\.map\(publicDemandCampaignFeaturedOfferFromRow\)/);
  assert.match(method, /\.slice\(0\s*,\s*6\)/);
  assert.match(method, /response\.error\)\s*return\s*\[\s*\]/);
  assert.match(method, /catch\s*\([^)]*\)\s*\{[\s\S]*?return\s*\[\s*\]/);
  for (const field of [
    'courtId', 'courtName', 'offerDate', 'slotHour',
    'discountPercent', 'regularRate', 'offerRate', 'endsAt',
  ]) assert.match(normalizer, new RegExp(`\\b${field}\\b`));
});

test('featured normalizer rejects malformed, non-discounted, and expired rows', () => {
  const config = read('supabase-config.js');
  const baseStart = config.indexOf('function publicDemandCampaignSlotOfferFromRow(');
  const featuredEnd = config.indexOf('const PB_RESERVATION_HOLD_MINUTES', baseStart);
  const source = config.slice(baseStart, featuredEnd);
  const context = { Date };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.normalize = publicDemandCampaignFeaturedOfferFromRow;`, context);

  const valid = {
    court_id: 'c2',
    court_name: 'Court 2',
    offer_date: '2026-09-03',
    slot_hour: 8,
    discount_percent: 10,
    regular_rate: 300,
    offer_rate: 270,
    ends_at: new Date(Date.now() + 86400000).toISOString(),
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.normalize(valid))),
    {
      courtId: 'c2', courtName: 'Court 2', offerDate: '2026-09-03', slotHour: 8,
      discountPercent: 10, regularRate: 300, offerRate: 270, endsAt: valid.ends_at,
    },
  );
  assert.equal(context.normalize({ ...valid, court_name: '' }), null);
  assert.equal(context.normalize({ ...valid, offer_rate: 300 }), null);
  assert.equal(context.normalize({ ...valid, ends_at: '2020-01-01T00:00:00Z' }), null);
});

test('local featured offers mirror blocked and booking-conflict safeguards', async () => {
  const config = read('supabase-config.js');
  const method = objectMethodAt(config, 'getPublicDemandCampaignFeaturedOffers', 1)
    .replace(/^async\s+getPublicDemandCampaignFeaturedOffers\s*\(\s*\)/, 'async function featuredOffers()');
  const now = Date.now();
  const db = {
    courts: [{ id: 'c2', name: 'Court 2', rate: 300, blocked: false }],
    settings: {
      open_hour: '6',
      close_hour: '24',
      open_play_config: JSON.stringify({
        enabled: true, start: 10, end: 11, days: [],
        specificDates: ['2026-09-03'], courtIds: ['c2'],
      }),
      maintenance_config: JSON.stringify({ rules: [
        {
          enabled: true, start: 8, end: 9, mode: 'specific',
          dates: ['2026-09-10'], courtIds: ['c2'],
        },
        {
          enabled: true, start: 9, end: 10, mode: 'weekly',
          recurring: { days: [4] }, courtIds: ['c2'],
        },
        {
          enabled: true, start: 10, end: 11, mode: 'monthly',
          recurring: { day: 17 }, courtIds: ['c2'],
        },
      ] }),
    },
    blockedDates: ['2026-08-27'],
    bookings: [
      { courtId: 'c2', date: '2026-09-03', slots: [8], status: 'confirmed' },
      { courtId: 'c2', date: '2026-09-03', slots: [9], status: 'verifying', createdAt: new Date(now - 60000).toISOString() },
      { courtId: 'c2', date: '2026-09-03', slots: [10], status: 'verifying', createdAt: new Date(now - 16 * 60000).toISOString() },
    ],
    demandCampaigns: [{
      id: 'campaign-1', court_id: 'c2', court_name_snapshot: 'Court 2',
      weekday: 4, start_hour: 8, end_hour: 11, discount_percent: 10,
      max_redemptions: 20, status: 'active',
      starts_at: new Date(now - 60000).toISOString(),
      ends_at: new Date(now + 86400000).toISOString(),
    }],
    demandCampaignRedemptions: [],
  };
  const context = {
    Date,
    Number,
    String,
    Set,
    PB_RESERVATION_HOLD_MINUTES: 15,
    readDb: () => db,
    localManilaDate: () => '2026-08-26',
    localDateAdd(dateText, days) {
      const date = new Date(`${dateText}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + Number(days));
      return date.toISOString().slice(0, 10);
    },
    localIsoWeekday: dateText => new Date(`${dateText}T00:00:00Z`).getUTCDay() || 7,
    localDemandSlotRate: (_db, _courtId, hour) => ({ 8: 300, 9: 320, 10: 350 }[hour] || 0),
  };
  vm.createContext(context);
  vm.runInContext(`${method}\nthis.featuredOffers = featuredOffers;`, context);

  const rows = JSON.parse(JSON.stringify(await context.featuredOffers()));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    courtId: 'c2', courtName: 'Court 2', offerDate: '2026-09-10', slotHour: 10,
    discountPercent: 10, regularRate: 350, offerRate: 315,
    endsAt: db.demandCampaigns[0].ends_at,
  });
  assert.equal(rows.some(row => row.offerDate === '2026-08-27'), false, 'blocked date must not be featured');
  assert.equal(rows.some(row => row.offerDate === '2026-09-03' && [8, 9].includes(row.slotHour)), false, 'occupied slots must not be featured');
  assert.equal(rows.some(row => row.offerDate === '2026-09-03' && row.slotHour === 10), false, 'Open Play slots must not be featured');
  assert.equal(rows.some(row => row.offerDate === '2026-09-10' && row.slotHour === 8), false, 'maintenance slots must not be featured');
  assert.equal(rows.some(row => row.offerDate === '2026-09-10' && row.slotHour === 9), false, 'weekly maintenance must not be featured');
  assert.equal(rows.some(row => row.offerDate === '2026-09-17' && row.slotHour === 10), false, 'monthly maintenance must not be featured');

  db.courts[0].blocked = true;
  assert.deepEqual(JSON.parse(JSON.stringify(await context.featuredOffers())), []);
});

test('player deal UI shows exact actionable slots without mutating a booking selection', () => {
  const index = read('index.html');
  const controller = read('demand-campaign-booking.js');
  const blocker = index.slice(
    index.indexOf('function featuredDealBlockingSurfaceOpen('),
    index.indexOf('function setFeaturedDealHidden('),
  );
  const renderer = index.slice(
    index.indexOf('function renderFeaturedCourtDeal('),
    index.indexOf('async function refreshFeaturedCourtDeal('),
  );
  const navigation = index.slice(
    index.indexOf('async function goToFeaturedCourtDeal('),
    index.indexOf('function initFeaturedCourtDeal('),
  );
  const initialization = index.slice(
    index.indexOf('function initFeaturedCourtDeal('),
    index.indexOf('/* =============================================', index.indexOf('function initFeaturedCourtDeal(')),
  );
  const widget = index.slice(
    index.indexOf('<!-- PUBLIC LIMITED COURT DEAL -->'),
    index.indexOf('<!-- MOBILE STICKY BOOK NOW BAR -->'),
  );

  assert.match(blocker, /isSplashActive\s*\(\s*\)/);
  assert.match(renderer, /<button class="featured-deal-slot"[^>]+goToFeaturedCourtDeal\(/);
  assert.match(renderer, /\$\{esc\(slotPercent\)\}% off • Save/);
  assert.match(renderer, /headlineDate\.day[\s\S]*headlineCourt/);
  assert.doesNotMatch(renderer, /Only \$\{count\}|Smart Rate is live/i);
  assert.match(navigation, /offers\.find\([\s\S]*offer\.slotHour/);
  assert.match(navigation, /loadOffersForDate\?\.\(target\.date, \{ force:true \}\)/);
  assert.doesNotMatch(navigation, /toggleCardSlot|proceedToBook|submitBooking|createBooking|reserveBooking/i);
  assert.match(initialization, /refreshFeaturedCourtDeal\(\{ force:true \}\)/);
  assert.match(widget, /Limited court deal/i);
  assert.doesNotMatch(widget, /Smart Rate/i);
  assert.match(controller, /Limited Court Deal applied/);
});

test('owner Facebook Post Kit creates a truthful portrait graphic and fail-soft caption workflow', () => {
  const admin = read('admin.html');
  const postKitStart = admin.indexOf('function demandPostPick(');
  const postKitEnd = admin.indexOf('function renderDemandQuality(', postKitStart);
  const postKit = admin.slice(postKitStart, postKitEnd);
  const modal = admin.slice(
    admin.indexOf('<!-- ACTIVE OFFER FACEBOOK POST KIT -->'),
    admin.indexOf('<!-- OPEN PLAY ROTATION SUMMARY -->'),
  );
  const openKit = admin.slice(
    admin.indexOf('async function openDemandPostKit('),
    admin.indexOf('function closeDemandPostKit('),
  );
  const openFacebook = admin.slice(
    admin.indexOf('async function openDemandPostFacebook('),
    admin.indexOf('function renderDemandQuality('),
  );

  assert.match(admin, />Create Facebook post</);
  assert.match(modal, /canvas[^>]+width="1080"[^>]+height="1350"/i);
  assert.match(modal, /data-variant="energetic"[\s\S]*data-variant="clean"[\s\S]*data-variant="barkada"/);
  assert.match(postKit, /DB\.getPublicDemandCampaignFeaturedOffers\(\)/);
  assert.match(postKit, /DISCOUNTED COURT HOUR/);
  assert.match(postKit, /\.slice\(0,1\)/);
  assert.match(postKit, /PaddleRageQRCode\.toCanvas[\s\S]*?https:\/\/kortedoscdo\.club\//);
  assert.match(postKit, /SCAN TO BOOK/);
  assert.match(postKit, /row\.offerDate[\s\S]*row\.slotHour[\s\S]*row\.offerRate/);
  assert.match(postKit, /No exact discounted court hour is open right now, so publishing is disabled/i);
  assert.match(postKit, /navigator\.share/);
  assert.match(modal, /Download PNG/);
  assert.match(modal, /Copy Caption/);
  assert.equal((modal.match(/data-demand-post-publish/g) || []).length, 4);
  assert.match(postKit, /button\.hasAttribute\('data-demand-post-publish'\) && !hasLiveSlots/);
  assert.equal((postKit.match(/if \(!await revalidateDemandPostKitForPublish\(\)\)/g) || []).length, 4);
  assert.match(postKit, /Offer availability changed\. The graphic and caption were refreshed/);
  assert.match(postKit, /renderDemandPostCanvas\(state\)[\s\S]*?_dgPostKitState !== state[\s\S]*?document\.fonts[\s\S]*?_dgPostKitState !== state[\s\S]*?Promise\.all[\s\S]*?_dgPostKitState !== state/);
  assert.match(postKit, /function demandPostCanvasBlob\(\)[\s\S]*?const state = _dgPostKitState;[\s\S]*?const requestSeq = _dgPostKitRequestSeq;[\s\S]*?state !== _dgPostKitState/);
  assert.ok(openFacebook.indexOf("window.open('about:blank'") < openFacebook.indexOf('await revalidateDemandPostKitForPublish()'));
  assert.match(openFacebook, /facebookWindow\?\.close\(\)/);
  assert.match(openKit, /Promise\.allSettled/);
  assert.doesNotMatch(openKit, /createBooking|reserveBooking|applyMatchingDemandCampaign|createDemandCampaign/i);
});

test('production workflow pins the migration checksum and never retries the mutation POST', () => {
  assert.ok(fs.existsSync(WORKFLOW_PATH), 'the one-shot production migration workflow must exist');
  const migration = fs.readFileSync(MIGRATION_PATH);
  const checksum = crypto.createHash('sha256').update(migration).digest('hex');
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  assert.match(workflow, new RegExp(`MIGRATION_SHA256:\\s*${checksum}`));
  assert.match(workflow, /sha256sum\s+--check\s+--strict/);
  assert.match(workflow, /history_marker/);
  assert.match(workflow, /schema_present/);
  assert.match(workflow, /Apply public featured offers migration exactly once/);
  const applyStep = workflow.match(/- name: Apply public featured offers migration exactly once[\s\S]*?(?=\n\s{6}- name:|$)/)?.[0] || '';
  assert.ok(applyStep, 'the mutation step must be detectable');
  assert.doesNotMatch(applyStep, /--retry|retry-all-errors/);
  assert.match(workflow, /get_public_demand_campaign_featured_offers\(\)/);
  assert.match(workflow, /has_function_privilege\('anon'[\s\S]*?'execute'\)/i);
});
