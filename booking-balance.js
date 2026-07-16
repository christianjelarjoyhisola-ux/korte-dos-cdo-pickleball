(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BookingBalance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const BALANCE_LEAD_DAYS = 5;

  function parseHour(value) {
    const text = String(value || '').trim();
    const twelve = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
    if (twelve) {
      let hour = Number(twelve[1]) % 12;
      if (twelve[3].toUpperCase() === 'PM') hour += 12;
      return { hour, minute: Number(twelve[2] || 0) };
    }
    const twentyFour = text.match(/^(\d{1,2})(?::(\d{2}))?$/);
    if (!twentyFour) return null;
    const hour = Number(twentyFour[1]);
    const minute = Number(twentyFour[2] || 0);
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? { hour, minute } : null;
  }

  function bookingStart(booking) {
    const date = String(booking?.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    let time = parseHour(booking?.startTime || booking?.start_time);
    if (!time && Array.isArray(booking?.slots) && booking.slots.length) {
      const hour = Math.min(...booking.slots.map(Number).filter(Number.isFinite));
      if (Number.isFinite(hour)) time = { hour, minute: 0 };
    }
    if (!time) return null;
    const value = new Date(`${date}T${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}:00+08:00`);
    return Number.isNaN(value.getTime()) ? null : value;
  }

  function groupStart(items) {
    const starts = (Array.isArray(items) ? items : [items])
      .map(bookingStart)
      .filter(Boolean)
      .sort((a, b) => a - b);
    return starts[0] || null;
  }

  function balanceDeadline(bookingOrItems) {
    const explicit = Array.isArray(bookingOrItems)
      ? bookingOrItems.map(item => item?.balanceDueAt || item?.balance_due_at).find(Boolean)
      : bookingOrItems?.balanceDueAt || bookingOrItems?.balance_due_at;
    if (explicit) {
      const parsed = new Date(explicit);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    const start = groupStart(bookingOrItems);
    return start ? new Date(start.getTime() - BALANCE_LEAD_DAYS * DAY_MS) : null;
  }

  function depositEligible(bookingOrItems, now = new Date()) {
    const deadline = balanceDeadline(bookingOrItems);
    return !!deadline && new Date(now).getTime() < deadline.getTime();
  }

  function paidAmount(booking) {
    if (Array.isArray(booking?.items) && booking.items.length > 1) {
      return booking.items.reduce((sum, item) => sum + paidAmount(item), 0);
    }
    const total = Math.max(0, Number(booking?.total || 0));
    const payment = String(booking?.paymentStatus || booking?.payment_status || 'unpaid').toLowerCase();
    if (payment === 'paid') return total;
    if (payment === 'downpayment_paid' || payment === 'deposit_retained') {
      return Math.min(total, Math.max(0, Number(booking?.downpayment || 0)));
    }
    return 0;
  }

  function balanceAmount(booking) {
    return Math.max(0, Number(booking?.total || 0) - paidAmount(booking));
  }

  function isForfeited(booking) {
    return String(booking?.status || '').toLowerCase() === 'forfeited';
  }

  function holdsSlot(booking) {
    const status = String(booking?.status || '').toLowerCase();
    return status !== 'cancelled' && status !== 'forfeited';
  }

  function deadlineState(booking, now = new Date()) {
    const deadline = balanceDeadline(booking);
    const balance = balanceAmount(booking);
    if (!deadline || !booking?.hostBooking || balance <= 0 || isForfeited(booking)) {
      return { deadline, balance, code: balance <= 0 ? 'paid' : isForfeited(booking) ? 'forfeited' : 'none', label: '' };
    }
    const remainingMs = deadline.getTime() - new Date(now).getTime();
    if (remainingMs <= 0) return { deadline, balance, remainingMs, code: 'overdue', label: 'Payment overdue' };
    const days = Math.ceil(remainingMs / DAY_MS);
    if (days === 1) return { deadline, balance, remainingMs, days, code: 'final', label: 'Due within 24 hours' };
    return { deadline, balance, remainingMs, days, code: days <= 3 ? 'urgent' : 'open', label: `${days} days remaining` };
  }

  function formatDeadline(value, options = {}) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '--';
    return new Intl.DateTimeFormat('en-PH', {
      timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true, ...options,
    }).format(date);
  }

  return {
    DAY_MS,
    BALANCE_LEAD_DAYS,
    parseHour,
    bookingStart,
    groupStart,
    balanceDeadline,
    depositEligible,
    paidAmount,
    balanceAmount,
    isForfeited,
    holdsSlot,
    deadlineState,
    formatDeadline,
  };
});
