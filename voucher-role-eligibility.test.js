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

test('host summary displays gross court fee, voucher discount, and booking fee separately', () => {
  assert.match(indexSource, /function hostBookingItemsSummaryHtml[\s\S]*bookingItemsGrossCourtFee/);
  assert.match(indexSource, /function hostBookingItemsSummaryHtml[\s\S]*Voucher \(\$\{esc/);
  assert.match(indexSource, /function hostBookingItemsSummaryHtml[\s\S]*Booking fee/);
});
