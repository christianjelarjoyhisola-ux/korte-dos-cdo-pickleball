/* Coalesce live updates without fetching unrelated or background views. */
(function (root) {
  'use strict';
  const publicTables = ['bookings', 'courts', 'settings', 'blocked_dates', 'open_play_registrations'];
  const offerScopes = ['publicDemandCampaignSlotOffers', 'publicDemandCampaignFeaturedOffers', 'publicFeaturedCourtHour'];
  const tableScopes = {
    bookings: ['bookings', 'publicBookingSlots', ...offerScopes],
    courts: ['courts', ...offerScopes],
    settings: ['settings', ...offerScopes],
    blocked_dates: ['blockedDates', ...offerScopes],
    open_play_registrations: ['openPlayRegistrations', 'openPlayCount', 'openPlayCounts'],
  };
  // These dependencies mirror the section loaders, not the sidebar labels.
  const sectionTables = {
    dash: ['bookings', 'settings'],
    insights: ['bookings', 'courts', 'settings', 'blocked_dates', 'open_play_registrations'],
    bookings: ['bookings', 'host_booking_balance_payments', 'courts', 'settings'],
    deleted: ['deleted_booking_archive'],
    payreview: ['bookings', 'host_booking_balance_payments', 'open_play_registrations', 'open_play_host_sessions', 'open_play_host_session_registrations'],
    reports: ['bookings'],
    courts: ['courts', 'settings'],
    accounts: ['accounts'],
    remittances: ['bookings', 'settings', 'weekly_fees', 'booking_fee_remittances', 'booking_fee_remittance_items', 'booking_fee_remittance_payments'],
    blocked: ['settings', 'courts', 'blocked_dates', 'open_play_registrations'],
    hosts: ['courts', 'open_play_host_applications', 'open_play_host_sessions', 'open_play_host_session_registrations'],
    gamemgr: ['courts', 'open_play_registrations', 'open_play_game_sessions', 'open_play_game_players', 'open_play_game_rounds'],
    maintenance: ['settings', 'courts'],
    payments: ['settings'],
    notifications: [],
    vouchers: ['courts', 'vouchers', 'voucher_redemptions'],
  };
  const adminTables = [...new Set(Object.values(sectionTables).flat())];
  const cacheScopes = tables => [...new Set(tables.flatMap(table => tableScopes[table] || []))];
  const sectionsFor = table => Object.keys(sectionTables).filter(section => sectionTables[section].includes(table));
  const scopesForSection = section => cacheScopes(sectionTables[section] || []);

  function affectsDate(payload, date) {
    if (!date) return false;
    const type = String(payload?.eventType || '').toUpperCase();
    const before = payload?.old?.date;
    const after = payload?.new?.date;
    // UPDATE/DELETE may expose only the old primary key under RLS. We cannot
    // exclude the displayed date without both sides of a reschedule.
    if (type === 'INSERT' && after) return after === date;
    if (type === 'DELETE' && before) return before === date;
    if (type === 'UPDATE' && before && after) return before === date || after === date;
    return true;
  }

  function publicViewsFor(table, payload, dates = {}) {
    if (table === 'bookings') {
      return [
        ...(affectsDate(payload, dates.courts) ? ['courts'] : []),
        ...(affectsDate(payload, dates.slots) ? ['slots'] : []),
        // Featured offers can span other dates and newly released slots.
        'promotions',
      ];
    }
    if (table === 'open_play_registrations') {
      return [
        ...(affectsDate(payload, dates.courts) ? ['courts'] : []),
        ...(affectsDate(payload, dates.slots) ? ['slots'] : []),
      ];
    }
    return publicTables.includes(table) ? ['courts', 'slots', 'promotions'] : [];
  }

  function createQueue(options) {
    const pending = new Set();
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    let timer = null, running = false, disposed = false;
    function schedule(delay = options.delay ?? 150) {
      if (disposed || running || !pending.size || options.isHidden?.()) return;
      if (timer !== null) clearTimer(timer);
      timer = setTimer(flush, delay);
    }
    async function flush() {
      timer = null;
      if (disposed || running || !pending.size || options.isHidden?.()) return;
      if (options.isBlocked?.()) { schedule(options.retryDelay ?? 1000); return; }
      const keys = [...pending];
      pending.clear();
      running = true;
      try { await options.refresh(keys); }
      catch (error) { options.onError?.(error); }
      finally {
        running = false;
        // Events that arrived during a read remain queued for a fresh read.
        schedule();
      }
    }
    return {
      request(keys) { keys.forEach(key => pending.add(key)); schedule(); },
      wake() { schedule(); },
      dispose() { disposed = true; pending.clear(); if (timer !== null) clearTimer(timer); },
    };
  }

  const PROMOTION_DISCOVERY_MS = 5 * 60 * 1000;
  function createDiscoveryCache(options) {
    const now = options.now || Date.now;
    const ttlMs = options.ttlMs ?? PROMOTION_DISCOVERY_MS;
    let epoch = 0, savedEpoch = -1, activeEpoch = -1, activeForced = false, pendingForce = false;
    let value, expiresAt = 0, flight = null;
    const remainingMs = () => savedEpoch === epoch ? Math.max(0, expiresAt - now()) : 0;
    function refresh({ force = false } = {}) {
      // Repeated force requests share the already queued fresh pass. A click
      // during an older discovery read must wait for a read started after it.
      if (force) {
        if (!flight || (activeEpoch === epoch && !activeForced)) { epoch++; pendingForce = true; }
        else if (activeEpoch !== epoch) pendingForce = true;
      }
      if (!force && remainingMs() > 0) return Promise.resolve(value);
      if (flight) return flight;
      activeEpoch = -1;
      const task = Promise.resolve().then(async () => {
        while (true) {
          const readEpoch = epoch;
          activeEpoch = readEpoch;
          activeForced = pendingForce;
          pendingForce = false;
          const next = await options.load();
          if (readEpoch !== epoch) {
            if (options.isHidden?.()) return options.emptyValue;
            continue;
          }
          value = next;
          savedEpoch = readEpoch;
          const itemExpiry = Number(options.expiresAt?.(next));
          expiresAt = Math.min(now() + ttlMs, Number.isFinite(itemExpiry) && itemExpiry > now() ? itemExpiry : Infinity);
          // Release before rendering; an automatically opened offer may request
          // its own fresh validation while the render callback is running.
          flight = null;
          options.apply?.(next);
          return next;
        }
      }).finally(() => { if (flight === task) flight = null; });
      flight = task;
      return task;
    }
    return { refresh, remainingMs, invalidate: () => { epoch++; }, pending: () => !!flight };
  }

  function promotionsAffected(table, payload, displayed = [], loading = false) {
    if (['courts', 'settings', 'blocked_dates'].includes(table)) return true;
    if (table !== 'bookings' || String(payload?.eventType).toUpperCase() === 'DELETE') return false;
    // Released/newly available opportunities are found on the bounded discovery
    // timer. A newly occupied advertised slot needs immediate revalidation.
    if (loading) return true;
    const row = payload?.new || {};
    if (!row.date) return displayed.length > 0;
    const hours = Array.isArray(row.slots) ? row.slots.map(Number) : null;
    return displayed.some(offer => (offer.date || offer.playDate) === row.date
      && (row.court_id == null || String(row.court_id) === String(offer.courtId))
      && (!hours || hours.includes(Number(offer.slotHour))));
  }

  const api = { publicTables, adminTables, cacheScopes, sectionsFor, scopesForSection, publicViewsFor, affectsDate, createQueue,
    PROMOTION_DISCOVERY_MS, createDiscoveryCache, promotionsAffected };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RealtimeRefresh = api;
})(typeof window === 'undefined' ? globalThis : window);
