(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HostBalancePayment = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FUNCTION_NAME = 'integration-status';
  const API_NAME = 'host_booking_balance_payment';
  const BALANCE_LEAD_DAYS = 5;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const APPROVED_STATES = new Set(['approved', 'auto_approved', 'paid', 'completed', 'confirmed']);
  const PENDING_STATES = new Set(['pending', 'manual_review', 'for_verification', 'verifying', 'processing', 'submitted']);
  const REJECTED_STATES = new Set(['rejected', 'failed', 'declined', 'cancelled', 'canceled']);

  function cleanText(value) {
    return String(value == null ? '' : value).trim();
  }

  function lower(value) {
    return cleanText(value).toLowerCase();
  }

  function money(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100) / 100) : 0;
  }

  function itemsFor(booking) {
    return Array.isArray(booking?.items) && booking.items.length ? booking.items.filter(Boolean) : [booking].filter(Boolean);
  }

  function paymentStatusOf(booking) {
    return lower(booking?.paymentStatus ?? booking?.payment_status ?? 'unpaid');
  }

  function bookingStatusOf(booking) {
    return lower(booking?.status);
  }

  function directPaidAmount(booking) {
    const total = money(booking?.total);
    const paymentStatus = paymentStatusOf(booking);
    if (paymentStatus === 'paid') return total;
    if (paymentStatus === 'downpayment_paid' || paymentStatus === 'deposit_retained') {
      return Math.min(total, money(booking?.downpayment));
    }
    return 0;
  }

  function paidAmount(booking) {
    const items = itemsFor(booking);
    if (items.length > 1) return money(items.reduce((sum, item) => sum + directPaidAmount(item), 0));
    return directPaidAmount(booking);
  }

  function balanceAmount(booking) {
    return money(money(booking?.total) - paidAmount(booking));
  }

  function parseHour(value) {
    const text = cleanText(value);
    const twelveHour = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
    if (twelveHour) {
      let hour = Number(twelveHour[1]) % 12;
      if (twelveHour[3].toUpperCase() === 'PM') hour += 12;
      return { hour, minute: Number(twelveHour[2] || 0) };
    }
    const twentyFourHour = text.match(/^(\d{1,2})(?::(\d{2}))?$/);
    if (!twentyFourHour) return null;
    const hour = Number(twentyFourHour[1]);
    const minute = Number(twentyFourHour[2] || 0);
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? { hour, minute } : null;
  }

  function bookingStart(booking) {
    const date = cleanText(booking?.date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    let time = parseHour(booking?.startTime ?? booking?.start_time);
    if (!time && Array.isArray(booking?.slots) && booking.slots.length) {
      const hour = Math.min(...booking.slots.map(Number).filter(Number.isFinite));
      if (Number.isFinite(hour)) time = { hour, minute: 0 };
    }
    if (!time) return null;
    const parsed = new Date(`${date}T${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}:00+08:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function endOfBalanceDueDate(dateValue) {
    const date = cleanText(dateValue).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const calendar = new Date(`${date}T12:00:00Z`);
    if (Number.isNaN(calendar.getTime())) return null;
    calendar.setUTCDate(calendar.getUTCDate() - BALANCE_LEAD_DAYS);
    return new Date(`${calendar.toISOString().slice(0, 10)}T23:59:59.999+08:00`);
  }

  function balanceDeadline(booking) {
    const candidates = itemsFor(booking)
      .map(item => item?.balanceDueAt ?? item?.balance_due_at)
      .concat([booking?.balanceDueAt ?? booking?.balance_due_at])
      .filter(Boolean)
      .map(value => new Date(value))
      .filter(value => !Number.isNaN(value.getTime()))
      .sort((a, b) => a - b);
    if (candidates.length) return candidates[0];

    const dates = itemsFor(booking)
      .map(item => cleanText(item?.date).slice(0, 10))
      .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value))
      .sort();
    return dates.length ? endOfBalanceDueDate(dates[0]) : null;
  }

  function bookingKey(booking) {
    return cleanText(
      booking?.bookingKey ??
      booking?.groupRef ??
      booking?.booking_group_ref ??
      booking?.displayRef ??
      booking?.ref
    );
  }

  function primaryBookingRef(booking) {
    const childRef = itemsFor(booking).map(item => cleanText(item?.ref)).find(Boolean);
    return cleanText(booking?.primaryRef ?? booking?.primary_ref ?? childRef ?? booking?.ref);
  }

  function bookingMatchesKey(booking, key) {
    const target = cleanText(key);
    if (!target || !booking) return false;
    const candidates = new Set([
      bookingKey(booking),
      primaryBookingRef(booking),
      cleanText(booking.ref),
      cleanText(booking.displayRef),
      cleanText(booking.groupRef),
      cleanText(booking.booking_group_ref),
    ].filter(Boolean));
    itemsFor(booking).forEach(item => {
      [item?.ref, item?.groupRef, item?.booking_group_ref].map(cleanText).filter(Boolean).forEach(value => candidates.add(value));
    });
    return candidates.has(target);
  }

  function eligibility(booking, now = new Date()) {
    const rows = itemsFor(booking);
    const balance = balanceAmount(booking);
    const deadline = balanceDeadline(booking);
    const result = {
      eligible: false,
      reason: '',
      balance,
      deadline,
      bookingKey: bookingKey(booking),
      bookingRef: primaryBookingRef(booking),
    };
    if (!rows.every(row => row?.hostBooking || row?.host_booking)) return { ...result, reason: 'not_host_booking' };
    if (!rows.every(row => bookingStatusOf(row) === 'confirmed')) return { ...result, reason: 'not_confirmed' };
    if (!rows.every(row => paymentStatusOf(row) === 'downpayment_paid')) return { ...result, reason: 'not_balance_due' };
    if (balance <= 0) return { ...result, reason: 'settled' };
    if (!deadline) return { ...result, reason: 'missing_deadline' };
    const nowValue = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(nowValue.getTime()) || nowValue.getTime() >= deadline.getTime()) {
      return { ...result, reason: 'deadline_passed' };
    }
    if (!result.bookingKey || !result.bookingRef) return { ...result, reason: 'missing_reference' };
    return { ...result, eligible: true, reason: 'eligible' };
  }

  function buildQuotePayload(booking) {
    return {
      action: 'quote',
      bookingRef: bookingKey(booking) || primaryBookingRef(booking),
    };
  }

  function buildCreatePayload(quoteOrBooking, idempotencyKey, input = {}) {
    const ref = cleanText(
      quoteOrBooking?.bookingKey ??
      quoteOrBooking?.booking_key ??
      quoteOrBooking?.bookingGroupRef ??
      quoteOrBooking?.booking_group_ref
    ) || bookingKey(quoteOrBooking) ||
      cleanText(quoteOrBooking?.bookingRef ?? quoteOrBooking?.booking_ref) ||
      primaryBookingRef(quoteOrBooking);
    const provider = lower(input.paymentMethod ?? input.method);
    return {
      action: 'create',
      bookingKey: ref,
      bookingRef: ref,
      idempotencyKey: cleanText(idempotencyKey),
      paymentProvider: provider,
      provider,
      paymentReference: cleanText(input.paymentReference ?? input.reference),
    };
  }

  function unwrapResponse(value) {
    if (!value || typeof value !== 'object') return {};
    const quote = value.quote && typeof value.quote === 'object' ? value.quote : {};
    const payment = value.payment && typeof value.payment === 'object' ? value.payment : {};
    const attempt = value.currentAttempt && typeof value.currentAttempt === 'object'
      ? value.currentAttempt
      : value.current_attempt && typeof value.current_attempt === 'object'
        ? value.current_attempt
        : value.currentPayment && typeof value.currentPayment === 'object'
          ? value.currentPayment
          : value.current_payment && typeof value.current_payment === 'object'
            ? value.current_payment
            : value.attempt && typeof value.attempt === 'object'
              ? value.attempt
              : {};
    return { ...value, ...quote, ...payment, ...attempt };
  }

  function normalizeQuote(value, booking) {
    const source = unwrapResponse(value);
    const amount = money(
      source.balanceAmount ??
      source.balance_amount ??
      source.expectedAmount ??
      source.expected_amount ??
      source.balance ??
      source.remainingBalance ??
      source.remaining_balance ??
      source.amount ??
      source.amountPhp ??
      source.amount_php
    );
    const paymentId = cleanText(
      source.paymentId ??
      source.payment_id ??
      source.balancePaymentId ??
      source.balance_payment_id ??
      source.id
    );
    const verificationRef = cleanText(
      source.verificationRef ??
      source.verification_ref ??
      source.receiptVerificationRef ??
      source.receipt_verification_ref
    );
    return {
      ...source,
      amount,
      balance: amount,
      paymentId,
      verificationRef,
      bookingKey: cleanText(source.bookingKey ?? source.booking_key ?? source.bookingGroupRef ?? source.booking_group_ref ?? bookingKey(booking)),
      bookingRef: cleanText(source.bookingRef ?? source.booking_ref ?? primaryBookingRef(booking)),
      groupRef: cleanText(source.bookingGroupRef ?? source.booking_group_ref ?? source.groupRef ?? source.group_ref ?? booking?.groupRef ?? booking?.booking_group_ref),
      deadline: source.deadline ?? source.balanceDueAt ?? source.balance_due_at ?? balanceDeadline(booking)?.toISOString() ?? null,
      date: cleanText(source.bookingDate ?? source.booking_date ?? source.date ?? booking?.date),
      courtName: cleanText(source.courtLabel ?? source.court_label ?? source.courtName ?? source.court_name ?? booking?.courtName ?? booking?.court_name),
      timeLabel: cleanText(source.scheduleLabel ?? source.schedule_label ?? source.timeLabel ?? source.time_label ?? booking?.timeLabel ?? booking?.time_label),
      fullName: cleanText(source.customerName ?? source.customer_name ?? source.fullName ?? source.full_name ?? booking?.fullName ?? booking?.full_name),
      status: cleanText(source.status ?? source.paymentStatus ?? source.payment_status),
      createdAt: source.createdAt ?? source.created_at ?? null,
      expiresAt: source.expiresAt ?? source.expires_at ?? null,
      paymentProvider: lower(source.paymentProvider ?? source.payment_provider ?? source.provider),
      paymentReference: cleanText(source.paymentReference ?? source.payment_reference),
      totalAmount: money(source.totalAmount ?? source.total_amount),
      paidAmount: money(source.paidAmount ?? source.paid_amount),
      verificationBookingData:
        source.verificationBookingData ??
        source.verification_booking_data ??
        source.bookingData ??
        source.booking_data ??
        null,
    };
  }

  function buildVerificationBookingData(quote) {
    const template = quote?.verificationBookingData && typeof quote.verificationBookingData === 'object'
      ? { ...quote.verificationBookingData }
      : null;
    const amount = money(quote?.amount ?? quote?.balance);
    const paymentId = cleanText(quote?.paymentId);
    if (!template) return null;
    if (
      lower(template.verification_context) !== 'host_booking_balance' ||
      cleanText(template.balance_payment_id) !== paymentId ||
      money(template.total) !== amount ||
      money(template.downpayment) !== amount
    ) {
      throw new Error('Secure balance verification details do not match this payment.');
    }
    return template;
  }

  function buildSubmitPayload(quote, receiptResult) {
    return {
      action: 'submit',
      paymentId: cleanText(quote?.paymentId),
      receiptVerificationId: Number(receiptResult?.receiptVerificationId ?? receiptResult?.receipt_verification_id) || null,
    };
  }

  function statusState(value) {
    const source = unwrapResponse(value);
    const raw = lower(
      source.finalStatus ??
      source.final_status ??
      source.paymentStatus ??
      source.payment_status ??
      source.receiptStatus ??
      source.receipt_status ??
      source.status
    );
    if (APPROVED_STATES.has(raw)) return 'approved';
    if (REJECTED_STATES.has(raw)) return 'rejected';
    if (PENDING_STATES.has(raw)) return 'pending';
    return 'pending';
  }

  function safeImageUrl(value) {
    const url = cleanText(value);
    if (!url) return '';
    if (/^https?:\/\/[^\s]+$/i.test(url)) return url;
    if (/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(url)) return url;
    if (/^(?:\/|\.\/|\.\.\/)[^<>"']+$/.test(url)) return url;
    if (/^[a-z0-9][a-z0-9_./?=&%+-]*$/i.test(url) && !url.includes(':')) return url;
    return '';
  }

  function errorMessage(error, fallback = 'Balance payment request failed.') {
    if (typeof error === 'string' && error.trim()) return error.trim();
    const message = error?.message ?? error?.error?.message ?? error?.context?.message;
    return cleanText(message) || fallback;
  }

  async function invokeErrorMessage(error, fallback = 'Balance payment request failed.') {
    const generic = errorMessage(error, '');
    const context = error?.context;
    if (context && (typeof context.json === 'function' || typeof context.text === 'function')) {
      try {
        const response = typeof context.clone === 'function' ? context.clone() : context;
        if (typeof response.json === 'function') {
          const payload = await response.json();
          const detailed = errorMessage(payload?.error ?? payload?.message ?? payload, '');
          if (detailed) return detailed;
        }
      } catch (_) {
        try {
          const response = typeof context.clone === 'function' ? context.clone() : context;
          const detailed = cleanText(await response.text?.());
          if (detailed) return detailed;
        } catch (_) {}
      }
    }
    return generic || fallback;
  }

  async function invoke(client, payload) {
    if (!client?.functions?.invoke) throw new Error('Secure balance payment is unavailable.');
    const { data, error } = await client.functions.invoke(FUNCTION_NAME, {
      body: { ...(payload || {}), api: API_NAME },
    });
    if (error) throw new Error(await invokeErrorMessage(error));
    if (!data || data.ok === false) throw new Error(errorMessage(data?.error ?? data, 'Balance payment request was not accepted.'));
    return data;
  }

  return {
    FUNCTION_NAME,
    API_NAME,
    money,
    paidAmount,
    balanceAmount,
    balanceDeadline,
    bookingKey,
    primaryBookingRef,
    bookingMatchesKey,
    eligibility,
    buildQuotePayload,
    buildCreatePayload,
    normalizeQuote,
    buildVerificationBookingData,
    buildSubmitPayload,
    statusState,
    safeImageUrl,
    errorMessage,
    invokeErrorMessage,
    invoke,
  };
});
