'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = __dirname;
const MIGRATION_PATH = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260826140000_public_demand_campaign_slot_offers.sql',
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

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end);
}

function objectMethod(source, name) {
  const startMarker = `async ${name}(`;
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${name} must exist`);
  const candidates = [
    source.indexOf('\n  async ', start + startMarker.length),
    source.indexOf('\n  //', start + startMarker.length),
    source.indexOf('\n};', start + startMarker.length),
  ].filter(index => index > start);
  assert.ok(candidates.length, `${name} must have a detectable end`);
  return source.slice(start, Math.min(...candidates));
}

function classListStub() {
  const values = new Set();
  return {
    add: (...names) => names.forEach(name => values.add(name)),
    remove: (...names) => names.forEach(name => values.delete(name)),
    toggle(name, force) {
      const enabled = force === undefined ? !values.has(name) : Boolean(force);
      if (enabled) values.add(name);
      else values.delete(name);
      return enabled;
    },
    contains: name => values.has(name),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function loadDemandController(dbOverrides = {}) {
  const elements = {
    bDemandOfferStatus: {
      classList: classListStub(),
      innerHTML: '',
      textContent: '',
    },
    bookingVoucherEntry: { style: {} },
  };
  const context = {
    window: {},
    document: { getElementById: id => elements[id] || null },
    DB: {
      async getPublicDemandCampaignSlotOffers() { return []; },
      async applyMatchingDemandCampaign() { return { applied: false, reason: 'no_active_campaign' }; },
      ...dbOverrides,
    },
    fmt: value => `PHP ${Number(value).toFixed(2)}`,
    setTimeout,
    clearTimeout,
    console: { ...console, warn() {} },
  };
  vm.createContext(context);
  vm.runInContext(read('demand-campaign-booking.js'), context, {
    filename: 'demand-campaign-booking.js',
  });
  return {
    controller: context.window.BookingDemandCampaign,
    elements,
    context,
  };
}

function offer(overrides = {}) {
  return {
    courtId: 'c2',
    offerDate: '2026-09-01',
    slotHour: 8,
    discountPercent: 10,
    regularRate: 300,
    offerRate: 270,
    endsAt: '2026-09-23T00:00:00.000Z',
    ...overrides,
  };
}

test('public Smart Rate RPC exposes only active future slot offers with quota remaining', () => {
  assert.ok(fs.existsSync(MIGRATION_PATH), 'the forward-only Smart Rate migration must exist');
  const migration = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const rpc = sqlFunction(migration, 'get_public_demand_campaign_slot_offers');
  const returnsMatch = /returns\s+table\s*\(([\s\S]*?)\)\s*(?:language|stable|security)/i.exec(rpc);

  assert.ok(returnsMatch, 'the public RPC must use an explicit table return shape');
  const returnedColumns = returnsMatch[1]
    .split(',')
    .map(column => column.trim().match(/^([a-z_][a-z0-9_]*)\b/i)?.[1])
    .filter(Boolean);
  assert.deepEqual(returnedColumns, [
    'court_id',
    'offer_date',
    'slot_hour',
    'discount_percent',
    'regular_rate',
    'offer_rate',
    'ends_at',
  ]);

  assert.match(
    rpc,
    /p_date\s*>\s*(?:local_today|pg_catalog\.timezone\s*\([\s\S]*?\)::date)|p_date\s*<=\s*local_today[\s\S]*return/i,
  );
  assert.match(rpc, /status\s*=\s*'active'/i);
  assert.match(rpc, /starts_at\s*<=\s*(?:pg_catalog\.)?(?:now|clock_timestamp|statement_timestamp)\(\)/i);
  assert.match(rpc, /ends_at\s*>\s*(?:pg_catalog\.)?(?:now|clock_timestamp|statement_timestamp)\(\)/i);
  assert.match(rpc, /extract\s*\(\s*isodow\s+from\s+p_date\s*\)/i);
  assert.match(rpc, /start_hour/i);
  assert.match(rpc, /end_hour/i);
  assert.match(rpc, /max_redemptions/i);
  assert.match(rpc, /status\s*=\s*'redeemed'|status\s+in\s*\([^)]*'redeemed'/i);
  assert.match(rpc, /status\s*=\s*'reserved'|status\s+in\s*\([^)]*'reserved'/i);
  assert.match(rpc, /reserved_until\s*>\s*(?:pg_catalog\.)?(?:now|clock_timestamp|statement_timestamp)\(\)/i);
  assert.match(rpc, /\bstable\b/i);
  assert.match(rpc, /security\s+definer/i);
  assert.match(rpc, /set\s+search_path\s*=\s*pg_catalog\s*,\s*pg_temp/i);
  assert.doesNotMatch(rpc, /\b(?:insert\s+into|update\s+public\.|delete\s+from|truncate)\b/i);
  assert.doesNotMatch(
    rpc,
    /\b(?:email|contact_number|gcash_ref|receipt_image|receipt_hash|booking_refs|full_name|created_by)\b/i,
  );
  assert.match(
    migration,
    /revoke\s+all\s+on\s+function\s+public\.get_public_demand_campaign_slot_offers\s*\(\s*date\s*\)[\s\S]*from\s+public/i,
  );
  assert.match(
    migration,
    /grant\s+execute\s+on\s+function\s+public\.get_public_demand_campaign_slot_offers\s*\(\s*date\s*\)[\s\S]*to\s+anon\s*,\s*authenticated/i,
  );
});

test('server computes exact per-slot offer rates with the authoritative court-rate function', () => {
  const migration = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const rpc = sqlFunction(migration, 'get_public_demand_campaign_slot_offers');

  assert.match(rpc, /calculate_booking_court_total\s*\(/i);
  assert.match(rpc, /slot_hour/i);
  assert.match(rpc, /regular_rate/i);
  assert.match(rpc, /offer_rate/i);
  assert.match(rpc, /round\s*\([\s\S]*discount_percent[\s\S]*100/i);
});

test('mixed booking rows discount eligible hours only and preserve the complete booking fee', () => {
  const migration = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const apply = sqlFunction(migration, 'apply_matching_demand_campaign');

  assert.match(apply, /eligible_slots/i);
  assert.match(apply, /(?:pg_catalog\.)?unnest\s*\([\s\S]{0,80}booking\.slots/i);
  assert.match(apply, /campaign\.start_hour|c\.start_hour/i);
  assert.match(apply, /campaign\.end_hour|c\.end_hour/i);
  assert.match(
    apply,
    /calculate_booking_court_total\s*\(\s*booking\.court_id\s*,\s*(?:booking\.)?eligible_slots\s*\)/i,
  );
  assert.match(
    apply,
    /discount_amount\s*:=\s*(?:pg_catalog\.)?round\s*\(\s*eligible_court_amount\s*\*\s*campaign\.discount_percent\s*\/\s*100/i,
  );
  assert.match(apply, /gross_total/i);
  assert.match(apply, /total\s*=\s*discounts\.gross_total\s*-\s*discounts\.item_discount/i);
  assert.match(
    apply,
    /least\s*\([\s\S]*booking_fee_amount_snapshot[\s\S]*calculate_booking_court_total\s*\(\s*booking\.court_id\s*,\s*booking\.eligible_slots/i,
    'eligible value must be capped by both the full court portion and authoritative eligible slot rates',
  );
});

test('public offer reads use the isolated client, normalize rows, and fail open', () => {
  const config = read('supabase-config.js');
  const method = objectMethod(config, 'getPublicDemandCampaignSlotOffers');
  const normalizer = sourceBetween(
    config,
    'function publicDemandCampaignSlotOfferFromRow(',
    'const PB_RESERVATION_HOLD_MINUTES',
  );

  assert.match(method, /_publicBookingSb\.rpc\s*\(\s*'get_public_demand_campaign_slot_offers'/);
  assert.match(method, /p_date\s*:\s*offerDate/);
  for (const field of [
    'courtId',
    'offerDate',
    'slotHour',
    'discountPercent',
    'regularRate',
    'offerRate',
    'endsAt',
  ]) {
    assert.match(normalizer, new RegExp(`\\b${field}\\b`));
  }
  assert.match(method, /response\.error\s*\)\s*return\s*\[\s*\]/);
  assert.match(method, /catch\s*\([^)]*\)\s*\{[\s\S]*return\s*\[\s*\]/);
  assert.doesNotMatch(method, /response\.error[\s\S]{0,100}throw\s+/);
});

test('initial and refreshed court grids share one Smart Rate slot renderer', () => {
  const index = read('index.html');
  const refresh = sourceBetween(index, 'async function onCardDate(', 'async function ensureCourt(');
  const initial = sourceBetween(index, 'async function renderCourts(', 'function switchCourtTab(');
  const renderer = sourceBetween(index, 'function renderAvailableCourtSlot(', 'async function onCardDate(');
  const rendererHelpers = sourceBetween(index, 'function smartRateBadgeHtml(', 'let _featuredDealOffers');
  const controller = read('demand-campaign-booking.js');

  assert.match(refresh, /renderAvailableCourtSlot\s*\(/);
  assert.match(initial, /renderAvailableCourtSlot\s*\(/);
  assert.match(renderer, /BookingDemandCampaign\?*\.?slotMarkupData|BookingDemandCampaign\.slotMarkupData/);
  assert.match(renderer, /<button[^>]+type=["']button["']/i);
  assert.match(renderer, /aria-pressed/i);
  assert.match(rendererHelpers, /smart-rate-badge/);
  assert.match(rendererHelpers, /smart-rate-prices/);
  assert.match(rendererHelpers, /smart-rate-regular/);
  assert.match(rendererHelpers, /smart-rate-price/);
  assert.match(controller, /className:\s*'smart-rate'/);
  assert.match(controller, /Limited court deal/i);
  assert.match(controller, /badgeText:\s*`\$\{percent\}% OFF`/);
});

test('unavailable slot branches never receive Smart Rate decoration', () => {
  const index = read('index.html');
  const refresh = sourceBetween(index, 'async function onCardDate(', 'async function ensureCourt(');
  const initial = sourceBetween(index, 'async function renderCourts(', 'function switchCourtTab(');

  for (const source of [refresh, initial]) {
    for (const unavailableClass of ['past-slot', 'processing', 'taken', 'maintenance']) {
      const marker = `cc-slot-btn ${unavailableClass}`;
      const markerAt = source.indexOf(marker);
      assert.notEqual(markerAt, -1, `${unavailableClass} branch must remain explicit`);
      const branchStart = source.lastIndexOf('return', markerAt);
      const branchEnd = source.indexOf(';', markerAt);
      assert.ok(branchStart >= 0 && branchEnd > markerAt, `${unavailableClass} branch must be complete`);
      assert.doesNotMatch(source.slice(branchStart, branchEnd + 1), /smart-rate|renderAvailableCourtSlot/);
    }
  }
});

test('slot previews are exact-date reads and never mutate booking selections or totals', async () => {
  const rows = [offer()];
  const { controller } = loadDemandController({
    async getPublicDemandCampaignSlotOffers(date) {
      return date === '2026-09-01' ? rows : [];
    },
  });
  const selection = {
    courtId: 'c2',
    date: '2026-09-01',
    slots: [8, 9],
    courtFee: 600,
    serviceFee: 40,
    total: 640,
  };
  const before = JSON.parse(JSON.stringify(selection));

  await controller.loadOffersForDate(selection.date);
  assert.equal(controller.offersForDate(selection.date).length, 1);
  assert.equal(controller.offersForDate('2026-09-08').length, 0);
  assert.equal(controller.offerForSlot('c2', selection.date, 8).offerRate, 270);
  assert.equal(controller.offerForSlot('c2', selection.date, 9), null);
  assert.equal(controller.offerForSlot('c1', selection.date, 8), null);

  const preview = controller.previewPrice('c2', selection.date, 8, 999);
  assert.deepEqual(
    JSON.parse(JSON.stringify(preview)),
    {
      hasOffer: true,
      regularRate: 300,
      offerRate: 270,
      discountPercent: 10,
      endsAt: '2026-09-23T00:00:00.000Z',
    },
  );
  const markup = controller.slotMarkupData('c2', selection.date, 8, 999);
  assert.equal(markup.className, 'smart-rate');
  assert.equal(markup.badgeText, '10% OFF');
  assert.match(markup.ariaText, /Limited court deal|10% off/i);
  assert.equal(controller.selectionHasPreview([selection]), true);
  assert.deepEqual(selection, before);
});

test('failed and stale preview requests leave normal slot pricing usable', async () => {
  const first = deferred();
  const second = deferred();
  const calls = [];
  const { controller } = loadDemandController({
    getPublicDemandCampaignSlotOffers(date) {
      calls.push(date);
      if (date === '2026-09-01') return first.promise;
      if (date === '2026-09-08') return second.promise;
      return Promise.reject(new Error('preview unavailable'));
    },
  });

  const oldLoad = controller.loadOffersForDate('2026-09-01');
  const currentLoad = controller.loadOffersForDate('2026-09-08');
  second.resolve([offer({ offerDate: '2026-09-08', slotHour: 9, offerRate: 280 })]);
  await currentLoad;
  first.resolve([offer({ offerDate: '2026-09-01', slotHour: 8, offerRate: 270 })]);
  await oldLoad;

  assert.deepEqual(calls, ['2026-09-01', '2026-09-08']);
  assert.equal(controller.offerForSlot('c2', '2026-09-08', 9).offerRate, 280);
  assert.equal(controller.offerForSlot('c2', '2026-09-08', 8), null);
  assert.equal(controller.offerForSlot('c2', '2026-09-01', 8).offerRate, 270);

  await assert.doesNotReject(() => controller.loadOffersForDate('2026-09-15'));
  const normal = controller.slotMarkupData('c2', '2026-09-15', 8, 350);
  assert.equal(normal.hasOffer, false);
  assert.equal(normal.regularRate, 350);
  assert.equal(normal.offerRate, 350);
  assert.equal(normal.className, '');
  assert.equal(normal.badgeText, '');
});

test('server auto-apply remains authoritative and a quota race keeps the gross total', async () => {
  const index = read('index.html');
  const proceed = sourceBetween(index, 'async function proceedToBookOnce(', 'function closeBookModal(');
  assert.match(proceed, /advertisedSmartRate\s*=\s*(?:!!)?window\.BookingDemandCampaign\?\.selectionHasPreview\(selections\)/);
  assert.match(proceed, /smartRateResult\s*=\s*await\s+window\.BookingDemandCampaign\?\.autoApply/);
  assert.match(
    proceed,
    /advertisedSmartRate\s*&&\s*!smartRateResult\?\.applied[\s\S]*showPreviewUnavailableNotice\(/,
  );

  const successItem = {
    ref: 'PB-SMART-1',
    courtId: 'c2',
    date: '2026-09-01',
    slots: [8],
    courtFee: 300,
    serviceFee: 20,
    total: 320,
  };
  let successfulPreviewReads = 0;
  const successful = loadDemandController({
    async getPublicDemandCampaignSlotOffers() {
      successfulPreviewReads += 1;
      return [offer()];
    },
    async applyMatchingDemandCampaign() {
      return {
        applied: true,
        campaign_id: 'campaign-1',
        campaign_name: 'Court 2 Smart Rate',
        discount_percent: 10,
        discount_amount: 30,
        allocations: [{
          ref: successItem.ref,
          gross_total: 320,
          discount_amount: 30,
          total: 290,
        }],
      };
    },
  });

  await successful.controller.loadOffersForDate(successItem.date);
  successful.controller.previewPrice('c2', successItem.date, 8, 300);
  assert.equal(successItem.total, 320, 'preview must not alter the gross hold total');
  await successful.controller.autoApply([successItem.ref], [successItem], { timeoutMs: 50 });
  assert.equal(successItem.demandCampaignGrossTotal, 320);
  assert.equal(successItem.demandCampaignDiscountAmount, 30);
  assert.equal(successItem.total, 290, 'only the server allocation may change the payable total');
  assert.equal(successItem.total, 270 + 20, 'the complete booking fee must remain payable');
  await successful.controller.loadOffersForDate(successItem.date);
  assert.equal(successfulPreviewReads, 2, 'authoritative apply must invalidate the visual preview cache');

  const racedItem = {
    ref: 'PB-SMART-RACE',
    courtId: 'c2',
    date: '2026-09-01',
    slots: [8],
    courtFee: 300,
    serviceFee: 20,
    total: 320,
  };
  const raced = loadDemandController({
    async getPublicDemandCampaignSlotOffers() { return [offer()]; },
    async applyMatchingDemandCampaign() {
      return { applied: false, reason: 'campaign_limit_reached' };
    },
  });
  await raced.controller.loadOffersForDate(racedItem.date);
  await raced.controller.autoApply([racedItem.ref], [racedItem], { timeoutMs: 50 });
  assert.equal(racedItem.total, 320);
  assert.equal(racedItem.demandCampaignDiscountAmount || 0, 0);
  raced.controller.showPreviewUnavailableNotice();
  assert.match(
    raced.elements.bDemandOfferStatus.innerHTML,
    /regular price|no longer available|offer ended|offer unavailable/i,
  );
  assert.equal(raced.elements.bookingVoucherEntry.style.display || '', '');
});

test('Smart Rate remains separate from vouchers and retains replacement safeguards', () => {
  const demandMigration = read('supabase/migrations/20260826120000_demand_growth_campaigns.sql');
  const config = read('supabase-config.js');

  assert.match(demandMigration, /not\s*\(\s*voucher_id\s+is\s+not\s+null\s+and\s+demand_campaign_id\s+is\s+not\s+null\s*\)/i);
  assert.match(
    demandMigration,
    /redemption\.status\s*=\s*'reserved'[\s\S]*demand_campaign_id\s*=\s*null[\s\S]*demand_campaign_discount_amount\s*=\s*0/i,
  );
  assert.match(
    config,
    /demandCampaignRedemptions[\s\S]*redemption\.status\s*===\s*'reserved'[\s\S]*replacedDemandCampaign\s*=\s*true/,
  );
});

test('production verification accepts the migration\'s multiline Manila timezone call', () => {
  const workflow = read('.github/workflows/apply-public-demand-slot-offers-production-migration.yml');

  assert.match(workflow, /position\('pg_catalog\.timezone' in preview_definition\) = 0/);
  assert.match(workflow, /position\('Asia\/Manila' in preview_definition\) = 0/);
  assert.doesNotMatch(
    workflow,
    /position\(\s*'pg_catalog\.timezone\(''Asia\/Manila''' in preview_definition/i,
  );
});
