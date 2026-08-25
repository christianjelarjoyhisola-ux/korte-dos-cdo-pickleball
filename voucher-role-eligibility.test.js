const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const voucherSource = readFileSync('voucher-booking.js', 'utf8');
const configSource = readFileSync('supabase-config.js', 'utf8');
const indexSource = readFileSync('index.html', 'utf8');
const migrationSource = readFileSync(
  'supabase/migrations/20260814154500_vouchers_for_all_booking_roles.sql',
  'utf8',
);
const demandMigrationSource = readFileSync(
  'supabase/migrations/20260826120000_demand_growth_campaigns.sql',
  'utf8',
);
const demandWorkflowSource = readFileSync(
  '.github/workflows/apply-demand-growth-production-migration.yml',
  'utf8',
);

function loadVoucherController({ host = false } = {}) {
  const elements = {
    bVoucherCode: { value: 'COURT100', disabled: false, focus() {} },
    bVoucherApply: { disabled: false, style: {}, textContent: '' },
    bVoucherRemove: { disabled: false, style: {} },
    bVoucherStatus: { textContent: '', className: '' },
  };
  const booking = {
    ref: 'PB-ROLE-TEST',
    courtFee: 350,
    serviceFee: 10,
    total: 360,
    voucherDiscountAmount: 0,
  };
  const calls = [];
  const context = {
    document: { getElementById: id => elements[id] || null },
    window: {},
    reservedRefs: () => [booking.ref],
    activeBookingItems: () => [booking],
    isVerifiedHostBooking: () => host,
    updatePrice() {},
    updateWiz3Summary() {},
    saveGuestBookingResume() {},
    fmt: value => `PHP ${Number(value).toFixed(2)}`,
    DB: {
      async applyBookingVoucher(code, refs, options) {
        calls.push({ code, refs: [...refs], options });
        return {
          id: 'voucher-id',
          code,
          discountAmount: 100,
          allocations: [{
            ref: booking.ref,
            grossTotal: 360,
            discountAmount: 100,
            total: 260,
          }],
        };
      },
      async removeBookingVoucher() {},
      async finalizeBookingVoucher() {},
    },
  };
  vm.createContext(context);
  vm.runInContext(voucherSource, context);
  return { controller: context.window.BookingVoucher, elements, booking, calls };
}

test('an authenticated host can apply a voucher to a held court booking', async () => {
  const { controller, elements, booking, calls } = loadVoucherController({ host: true });

  await controller.apply();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.asHost, true);
  assert.equal(booking.total, 260);
  assert.equal(booking.voucherDiscountAmount, 100);
  assert.match(elements.bVoucherStatus.textContent, /off the court fee/i);
  assert.doesNotMatch(elements.bVoucherStatus.textContent, /regular court bookings only/i);
});

test('guest and administrator-style public bookings keep using the public voucher path', async () => {
  const { controller, calls } = loadVoucherController({ host: false });

  await controller.apply();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.asHost, false);
});

test('voucher RPC routing uses host auth only for verified host bookings', () => {
  assert.match(
    configSource,
    /async applyBookingVoucher\(code, bookingRefs, options = \{\}\) \{\s*const client = options\.asHost === true \? _sb : _publicBookingSb;/,
  );
  assert.match(
    configSource,
    /async removeBookingVoucher\(bookingRefs, options = \{\}\) \{\s*const client = options\.asHost === true \? _sb : _publicBookingSb;/,
  );
  assert.match(
    configSource,
    /async finalizeBookingVoucher\(bookingRefs, customerEmail, options = \{\}\) \{\s*const client = options\.asHost === true \? _sb : _publicBookingSb;/,
  );
});

test('database voucher eligibility permits guest and owned host holds', () => {
  assert.match(migrationSource, /request_role = 'anon'[\s\S]*created_via = 'customer'/);
  assert.match(migrationSource, /request_role = 'authenticated'[\s\S]*account_role = 'host'/);
  assert.equal((migrationSource.match(/host_user_id = auth\.uid\(\)/g) || []).length, 3);
  assert.equal((migrationSource.match(/created_by_user_id = auth\.uid\(\)/g) || []).length, 3);
});

test('database voucher math removes the booking fee from the discount basis', () => {
  assert.match(
    migrationSource,
    /coalesce\(voucher_gross_total, total\)[\s\S]*booking_fee_amount_snapshot/,
  );
  assert.match(migrationSource, /discount_amount := greatest\(least\(discount_amount, eligible_amount\), 0\)/);
});

test('a voucher atomically replaces only a reserved automatic demand offer', () => {
  assert.match(demandMigrationSource, /create or replace function public\.apply_booking_voucher/i);
  assert.match(
    demandMigrationSource,
    /update public\.demand_campaign_redemptions redemption[\s\S]*redemption\.status = 'reserved'[\s\S]*redemption\.booking_refs && clean_refs/,
  );
  assert.match(
    demandMigrationSource,
    /set total = coalesce\(booking\.demand_campaign_gross_total, booking\.total\)[\s\S]*demand_campaign_id = null[\s\S]*demand_campaign_discount_amount = 0/,
  );
  assert.ok(
    demandMigrationSource.indexOf("redemption.status = 'reserved'")
      < demandMigrationSource.lastIndexOf('insert into public.voucher_redemptions'),
  );
  assert.match(configSource, /demandCampaignRedemptions[\s\S]*redemption\.status === 'reserved'/);
  assert.match(configSource, /demandCampaignGrossTotal \?\? booking\.grossTotal[\s\S]*replacedDemandCampaign = true/);
});

test('production demand migration uses read-only preflight and one non-retried DDL call', () => {
  assert.match(demandWorkflowSource, /Read-only production schema preflight/);
  assert.match(demandWorkflowSource, /skip_apply=true/);
  assert.match(demandWorkflowSource, /refusing a second or partial DDL run/);
  assert.doesNotMatch(demandWorkflowSource, /rollback rehearsal/i);
  assert.doesNotMatch(demandWorkflowSource, /group by true/i);
  assert.match(demandWorkflowSource, /select count\(\*\) from pg_class[\s\S]*\) <> 2 then/);
  assert.match(demandWorkflowSource, /select count\(\*\) from pg_proc[\s\S]*\) <> 4 then/);
  const applyStep = demandWorkflowSource.slice(
    demandWorkflowSource.indexOf('- name: Apply Demand Growth migration exactly once'),
    demandWorkflowSource.indexOf('- name: Verify production database state'),
  );
  assert.doesNotMatch(applyStep, /--retry/);
  assert.match(demandMigrationSource, /set local lock_timeout = '5s'/);
  assert.match(demandMigrationSource, /check \(demand_campaign_discount_amount >= 0\) not valid/);
  assert.match(demandMigrationSource, /validate constraint bookings_no_voucher_campaign_stacking/);
});

test('host summary displays gross court fee, voucher discount, and booking fee separately', () => {
  assert.match(indexSource, /function hostBookingItemsSummaryHtml[\s\S]*bookingItemsGrossCourtFee/);
  assert.match(indexSource, /function hostBookingItemsSummaryHtml[\s\S]*Voucher \(\$\{esc/);
  assert.match(indexSource, /function hostBookingItemsSummaryHtml[\s\S]*Booking fee/);
});
