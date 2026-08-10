import test from "node:test";
import assert from "node:assert/strict";
import {
  createBooking,
  createBookingGroup,
  getState,
  resetDemo,
  resolvePayment,
  setCourtState,
  updateBooking,
  updateBrand,
  updatePricing
} from "./data.js";

test("demo booking updates shared owner metrics and can be edited", () => {
  resetDemo();
  const beforeBookings = getState().metrics.bookings;
  const beforeRevenue = getState().metrics.revenue;
  const booking = createBooking({
    court: "c2",
    guest: "Demo Player",
    start: "18:30",
    end: "20:00",
    amount: 1240
  });

  assert.equal(booking.guest, "Demo Player");
  assert.equal(getState().metrics.bookings, beforeBookings + 1);
  assert.equal(getState().metrics.revenue, beforeRevenue + 1240);
  assert.equal(updateBooking(booking.id, { status: "checked-in" }).status, "checked-in");
});

test("grouped bookings are atomic and reject overlapping court times", () => {
  resetDemo();
  const beforeBookings = getState().bookings.length;
  const beforeRevenue = getState().metrics.revenue;
  const created = createBookingGroup([
    { court: "c1", guest: "Demo Player", date: "2026-08-10", start: "12:00", end: "14:00", amount: 1040 },
    { court: "c2", guest: "Demo Player", date: "2026-08-10", start: "12:00", end: "13:00", amount: 520 }
  ]);

  assert.equal(created.length, 2);
  assert.equal(getState().bookings.length, beforeBookings + 2);
  assert.equal(getState().metrics.revenue, beforeRevenue + 1560);

  const countAfterSuccess = getState().bookings.length;
  const revenueAfterSuccess = getState().metrics.revenue;
  assert.throws(() => createBookingGroup([
    { court: "c1", guest: "Second Player", date: "2026-08-10", start: "13:00", end: "15:00", amount: 1040 },
    { court: "c3", guest: "Second Player", date: "2026-08-10", start: "12:00", end: "13:00", amount: 520 }
  ]), /no longer available/);
  assert.equal(getState().bookings.length, countAfterSuccess);
  assert.equal(getState().metrics.revenue, revenueAfterSuccess);
});

test("payment review, maintenance, branding, and reset remain deterministic", () => {
  resetDemo();
  const resolved = resolvePayment("PAY-1841");
  assert.equal(resolved.guest, "Ana Lim");
  assert.equal(getState().paymentReviews.length, 1);

  setCourtState("c3", "maintenance");
  assert.equal(getState().courts.find(court => court.id === "c3").state, "maintenance");

  updateBrand({ name: "North Point Pickle", primary: "#146c5b" });
  assert.equal(getState().venue.name, "North Point Pickle");
  assert.equal(getState().venue.initials, "NP");

  resetDemo();
  assert.equal(getState().paymentReviews.length, 2);
  assert.equal(getState().courts.find(court => court.id === "c3").state, "ready");
  assert.equal(getState().venue.name, "Horizon Pickle Club");
});

test("owner hourly pricing updates atomically and resets with the demo", () => {
  resetDemo();
  const saved = updatePricing({ offPeak: 450, standard: 550, popular: 650, prime: 800 });

  assert.deepEqual(saved, { offPeak: 450, standard: 550, popular: 650, prime: 800 });
  assert.deepEqual(getState().venue.hourlyRates, saved);

  assert.throws(() => updatePricing({ offPeak: 500, standard: 600, popular: 700, prime: 10001 }), /between/);
  assert.deepEqual(getState().venue.hourlyRates, saved);

  resetDemo();
  assert.deepEqual(getState().venue.hourlyRates, { offPeak: 480, standard: 520, popular: 600, prime: 720 });
});
