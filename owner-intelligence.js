(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerIntelligence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MINIMUM_LEARNING_DAYS = 30;
  const FORECAST_DAYS = 28;
  const RECENCY_HALF_LIFE_DAYS = 56;
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function clamp(value, minimum = 0, maximum = 100) {
    return Math.max(minimum, Math.min(maximum, number(value)));
  }

  function dateOnly(value) {
    return String(value || '').slice(0, 10);
  }

  function addDays(value, amount) {
    const date = new Date(`${dateOnly(value)}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + number(amount));
    return date.toISOString().slice(0, 10);
  }

  function isoWeekday(value) {
    return ((new Date(`${dateOnly(value)}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
  }

  function datesBetween(from, to) {
    if (!from || !to || from > to) return [];
    const values = [];
    for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) values.push(cursor);
    return values;
  }

  function daysApart(from, to) {
    return Math.max(0, Math.round((new Date(`${dateOnly(to)}T00:00:00Z`) - new Date(`${dateOnly(from)}T00:00:00Z`)) / 86400000));
  }

  function timeLabel(startHour, endHour) {
    const format = hour => {
      const normalized = ((number(hour) % 24) + 24) % 24;
      return `${normalized % 12 || 12} ${normalized >= 12 ? 'PM' : 'AM'}`;
    };
    return `${format(startHour)}–${format(endHour)}`;
  }

  function confidenceFor(cell) {
    const supplied = String(cell?.confidence || '').toLowerCase();
    if (['high', 'medium', 'low', 'learning'].includes(supplied)) {
      return {
        code: supplied,
        label: supplied === 'learning' ? 'Still learning' : `${supplied[0].toUpperCase()}${supplied.slice(1)} confidence`,
      };
    }
    const days = number(cell?.comparable_days ?? cell?.comparableDays);
    const hours = number(cell?.available_hours ?? cell?.availableHours);
    if (days >= 16 && hours >= 16) return { code: 'high', label: 'High confidence' };
    if (days >= 8 && hours >= 8) return { code: 'medium', label: 'Medium confidence' };
    if (days >= 4 && hours >= 4) return { code: 'low', label: 'Low confidence' };
    return { code: 'learning', label: 'Still learning' };
  }

  function wilsonBounds(bookedHours, availableHours, z = 1.645) {
    const n = Math.max(0, number(availableHours));
    if (!n) return { low: 0, high: 100 };
    const p = clamp(number(bookedHours) / n, 0, 1);
    const denominator = 1 + (z * z / n);
    const centre = (p + z * z / (2 * n)) / denominator;
    const margin = z * Math.sqrt((p * (1 - p) / n) + (z * z / (4 * n * n))) / denominator;
    return { low: clamp((centre - margin) * 100), high: clamp((centre + margin) * 100) };
  }

  function demandState(cell) {
    const confidence = confidenceFor(cell).code;
    const utilization = clamp(cell?.utilization_pct ?? cell?.utilizationPct);
    const interval = {
      low: number(cell?.expected_occupancy_low ?? cell?.expectedOccupancyLow),
      high: number(cell?.expected_occupancy_high ?? cell?.expectedOccupancyHigh),
    };
    const bounds = interval.high > 0 || interval.low > 0
      ? interval
      : wilsonBounds(cell?.booked_hours ?? cell?.bookedHours, cell?.available_hours ?? cell?.availableHours);
    if (confidence === 'learning') return 'learning';
    if (bounds.low >= 60 || (utilization >= 75 && ['medium', 'high'].includes(confidence))) return 'protected_peak';
    if (utilization >= 55 || bounds.high >= 55) return 'healthy';
    if (confidence === 'low' || utilization >= 40) return 'watch';
    if (utilization < 15 && bounds.high < 30) return 'persistent_vacancy';
    if (utilization < 40 && bounds.high < 50) return 'underused';
    return 'watch';
  }

  function cellLabel(cell) {
    return `${cell?.weekday_label || cell?.weekdayLabel || 'Selected day'} ${timeLabel(cell?.start_hour, cell?.end_hour)}`;
  }

  function evidence(cell) {
    const days = number(cell?.comparable_days ?? cell?.comparableDays);
    const booked = number(cell?.booked_hours ?? cell?.bookedHours);
    const available = number(cell?.available_hours ?? cell?.availableHours);
    return `${days} comparable ${days === 1 ? 'day' : 'days'}, ${booked.toFixed(1)} of ${available.toFixed(1)} court-hours booked`;
  }

  function parseStartHour(value, fallback = 6) {
    const match = String(value || '').trim().match(/^(\d{1,2})(?::\d{2})?\s*(AM|PM)?/i);
    if (!match) return fallback;
    let hour = Number(match[1]);
    if (match[2]) {
      hour %= 12;
      if (match[2].toUpperCase() === 'PM') hour += 12;
    }
    return clamp(hour, 0, 23);
  }

  function normalizedSlots(row, fallbackOpen = 6) {
    const explicit = Array.isArray(row?.slots)
      ? row.slots.map(Number).filter(Number.isFinite)
      : [];
    if (explicit.length) return explicit.map(hour => ({ hour: Math.floor(hour), hours: 1 }));
    const duration = Math.max(0, number(row?.duration));
    const start = parseStartHour(row?.startTime || row?.start_time, fallbackOpen);
    return Array.from({ length: Math.ceil(duration) }, (_, offset) => ({
      hour: start + offset,
      hours: Math.min(1, Math.max(duration - offset, 0)),
    })).filter(piece => piece.hour < 24 && piece.hours > 0);
  }

  function parseScheduleSetting(settings, key) {
    const raw = settings?.[key];
    if (!raw) return {};
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
    try {
      const parsed = JSON.parse(String(raw));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function isEnabled(value) {
    return value === true || String(value || '').toLowerCase() === 'true';
  }

  function scheduleAppliesToCourt(config, courtId) {
    const configured = Array.isArray(config?.courtIds)
      ? config.courtIds
      : Array.isArray(config?.court_ids) ? config.court_ids : [];
    const courtIds = configured.map(String).filter(Boolean);
    return courtIds.length === 0 || courtIds.includes(String(courtId));
  }

  function scheduleHourInRange(hour, startValue, endValue) {
    const slotHour = Number(hour);
    const start = Number(startValue);
    const end = Number(endValue);
    if (!Number.isInteger(slotHour) || slotHour < 0 || slotHour > 23
      || !Number.isInteger(start) || start < 0 || start > 23
      || !Number.isInteger(end) || end < 0 || end > 24
      || start === end) return false;
    return start < end
      ? slotHour >= start && slotHour < end
      : slotHour >= start || slotHour < end;
  }

  function scheduleCalendarDay(value) {
    const date = dateOnly(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const parsed = new Date(`${date}T12:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getUTCDay();
  }

  function scheduleOccurrenceDate(value, hour, startValue, endValue) {
    const date = dateOnly(value);
    const start = Number(startValue);
    const end = Number(endValue);
    const slotHour = Number(hour);
    return start > end && slotHour < end ? addDays(date, -1) : date;
  }

  function openPlayConfigMatches(value, hour, courtId, config) {
    if (!config || !isEnabled(config.enabled)
      || !scheduleAppliesToCourt(config, courtId)
      || !scheduleHourInRange(hour, config.start, config.end)) return false;
    const occurrenceDate = scheduleOccurrenceDate(value, hour, config.start, config.end);
    const calendarDay = scheduleCalendarDay(occurrenceDate);
    const weekdays = Array.isArray(config.days) ? config.days.map(Number) : [];
    const specificDates = Array.isArray(config.specificDates)
      ? config.specificDates.map(String)
      : Array.isArray(config.specific_dates) ? config.specific_dates.map(String) : [];
    return weekdays.includes(calendarDay) || specificDates.includes(occurrenceDate);
  }

  function maintenanceRuleMatches(value, hour, courtId, rule) {
    if (!rule || !isEnabled(rule.enabled)
      || !scheduleAppliesToCourt(rule, courtId)
      || !scheduleHourInRange(hour, rule.start, rule.end)) return false;
    const occurrenceDate = scheduleOccurrenceDate(value, hour, rule.start, rule.end);
    const calendarDay = scheduleCalendarDay(occurrenceDate);
    const mode = String(rule.mode || 'specific').toLowerCase();
    if (mode === 'monthly') return Number(rule.recurring?.day) === Number(occurrenceDate.slice(8, 10));
    if (mode === 'weekly') {
      const weekdays = Array.isArray(rule.recurring?.days) ? rule.recurring.days.map(Number) : [];
      return weekdays.includes(calendarDay);
    }
    if (mode !== 'specific') return false;
    const dates = Array.isArray(rule.dates) ? rule.dates.map(String) : [];
    return dates.includes(occurrenceDate);
  }

  function scheduleHourIsOpenPlay(value, hour, courtId, settings = {}) {
    const date = dateOnly(value);
    if (scheduleCalendarDay(date) === null) return false;
    const openPlay = parseScheduleSetting(settings, 'open_play_config');
    if (openPlayConfigMatches(date, hour, courtId, openPlay)) return true;
    const maintenance = parseScheduleSetting(settings, 'maintenance_config');
    const rules = Array.isArray(maintenance.rules)
      ? maintenance.rules
      : Object.keys(maintenance).length ? [maintenance] : [];
    return rules.some(rule => {
      const label = String(rule?.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      return ['openplay', 'openplaysession'].includes(label)
        && maintenanceRuleMatches(date, hour, courtId, rule);
    });
  }

  function scheduleHourUnavailable(value, hour, courtId, settings = {}) {
    const date = dateOnly(value);
    if (scheduleCalendarDay(date) === null) return false;

    const openPlay = parseScheduleSetting(settings, 'open_play_config');
    if (openPlayConfigMatches(date, hour, courtId, openPlay)) return true;

    const maintenance = parseScheduleSetting(settings, 'maintenance_config');
    const maintenanceRules = Array.isArray(maintenance.rules)
      ? maintenance.rules
      : Object.keys(maintenance).length ? [maintenance] : [];
    return maintenanceRules.some(rule => maintenanceRuleMatches(date, hour, courtId, rule));
  }

  function pricingTiers(value) {
    let parsed = value;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch (_) { parsed = []; }
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.map(tier => ({
      from: number(tier?.from),
      to: number(tier?.to),
      rate: Number(tier?.rate),
    })).filter(tier => Number.isInteger(tier.from)
      && tier.from >= 0 && tier.from <= 23
      && Number.isInteger(tier.to) && tier.to >= 0 && tier.to <= 24
      && tier.from !== tier.to
      && Number.isFinite(tier.rate) && tier.rate >= 0);
  }

  function rateForSlot(input, court, hour) {
    const slotHour = Math.floor(number(hour));
    const suppliedValue = typeof input?.slotRate === 'function'
      ? input.slotRate(court, slotHour, input.settings || {})
      : null;
    const supplied = suppliedValue === null || suppliedValue === undefined || suppliedValue === ''
      ? NaN
      : Number(suppliedValue);
    if (Number.isFinite(supplied) && supplied >= 0) return supplied;

    const courtSchedule = pricingTiers(court?.rateSchedule ?? court?.rate_schedule);
    const venueSchedule = pricingTiers(input?.settings?.pricing_tiers);
    const tiers = courtSchedule.length ? courtSchedule : venueSchedule;
    const matching = tiers.find(tier => tier.from < tier.to
      ? slotHour >= tier.from && slotHour < tier.to
      : slotHour >= tier.from || slotHour < tier.to);
    if (matching) return matching.rate;
    return Math.max(0, number(court?.rate));
  }

  function isPaidSuccessfulBooking(row, options = {}) {
    const status = String(row?.status || '').toLowerCase();
    const paymentStatus = String(row?.paymentStatus ?? row?.payment_status ?? '').trim().toLowerCase();
    const eligible = row?.analyticsEligible ?? row?.analytics_eligible;
    return eligible !== false
      && ['confirmed', 'completed'].includes(status)
      && (['paid', 'downpayment_paid'].includes(paymentStatus)
        || (!paymentStatus && options.allowLegacyMissingPaymentStatus === true))
      && String(row?.email || '').toLowerCase() !== 'reserve@hold.internal';
  }

  function logicalSuccessfulRows(rows, throughDate, courtId = null, options = {}) {
    const logical = new Map();
    (Array.isArray(rows) ? rows : [])
      .filter(row => isPaidSuccessfulBooking(row, options))
      .filter(row => dateOnly(row.date) && dateOnly(row.date) <= throughDate)
      .filter(row => !courtId || String(row.courtId || row.court_id) === String(courtId))
      .forEach(row => {
        const reservation = String(row.groupRef || row.booking_group_ref || row.ref || '');
        const slots = Array.isArray(row.slots) ? row.slots.map(Number).sort((a, b) => a - b).join(',') : '';
        const key = `${reservation}|${row.courtId || row.court_id}|${dateOnly(row.date)}|${slots || row.startTime || row.start_time || ''}`;
        if (!logical.has(key)) logical.set(key, row);
      });
    return [...logical.values()];
  }

  function signalId(signal, throughDate) {
    return [
      'profit-v2', signal.court_id, signal.weekday, signal.start_hour,
      signal.end_hour, signal.rate, throughDate, Math.round(number(signal.utilization_pct) * 10),
    ].join(':');
  }

  function hasActiveGrowthTest(snapshot) {
    return [...(snapshot?.active_experiments || []), ...(snapshot?.active_campaigns || [])]
      .some(item => String(item?.status || '').toLowerCase() === 'active');
  }

  function recommendationFromSignals(snapshot) {
    const learningDays = number(snapshot?.period?.learning_days ?? snapshot?.period?.days_analyzed);
    if (learningDays < MINIMUM_LEARNING_DAYS || hasActiveGrowthTest(snapshot)) return null;
    if (snapshot?.recommendation) return snapshot.recommendation;
    const candidates = (Array.isArray(snapshot?.court_signals) ? snapshot.court_signals : [])
      .map(signal => ({ ...signal, confidence: confidenceFor(signal).code, state: signal.state || demandState(signal) }))
      .filter(signal => ['medium', 'high'].includes(signal.confidence))
      .filter(signal => ['persistent_vacancy', 'underused'].includes(signal.state))
      .filter(signal => number(signal.open_future_hours) > 0)
      .sort((a, b) => number(b.opportunity_value) - number(a.opportunity_value)
        || number(b.open_future_hours) - number(a.open_future_hours)
        || number(a.utilization_pct) - number(b.utilization_pct));
    const best = candidates[0];
    if (!best) return null;
    return {
      id: signalId(best, snapshot?.period?.to || ''),
      court_id: best.court_id,
      court_name: best.court_name,
      weekday: best.weekday,
      weekday_label: best.weekday_label || WEEKDAYS[number(best.weekday) - 1],
      start_hour: best.start_hour,
      end_hour: best.end_hour,
      utilization_pct: number(best.utilization_pct),
      expected_empty_pct: 100 - number(best.utilization_pct),
      comparable_days: number(best.comparable_days),
      booked_hours: number(best.booked_hours),
      available_hours: number(best.available_hours),
      confidence: best.confidence,
      state: best.state,
      rate: number(best.rate),
      hourly_rate: number(best.rate),
      action_type: 'facebook_regular_price',
      discount_percent: 0,
      // One Best Move is one exact, bookable court-hour. Historical demand is
      // already the baseline, so owners never need to wait months for pairs.
      target_occurrences: 1,
      horizon_days: 28,
      target_pairs: 1,
      open_future_hours: number(best.open_future_hours),
      opportunity_value: number(best.opportunity_value),
    };
  }

  function buildRecommendations(snapshot) {
    const recommendation = recommendationFromSignals(snapshot);
    if (recommendation) return [{
      type: 'demand_growth',
      title: `${recommendation.weekday_label} ${timeLabel(recommendation.start_hour, recommendation.end_hour)} has room to grow`,
      summary: `${number(recommendation.expected_empty_pct).toFixed(0)}% of this window has historically remained open.`,
      evidence: `${recommendation.comparable_days} comparable ${recommendation.weekday_label} periods`,
      confidence: confidenceFor(recommendation),
      context: recommendation,
    }];
    return [{
      type: 'learning',
      title: 'Learning Korte DOS demand patterns',
      summary: 'No safe growth action is ready yet.',
      evidence: `${number(snapshot?.period?.learning_days ?? snapshot?.period?.days_analyzed)} of ${MINIMUM_LEARNING_DAYS} learning days complete`,
      confidence: { code: 'learning', label: 'Still learning' },
    }];
  }

  function buildLocalSnapshot(input = {}) {
    const nowValue = input.now || new Date().toISOString();
    const nowMs = new Date(nowValue).getTime();
    const today = dateOnly(nowValue);
    const throughDate = addDays(today, -1);
    const selectedCourts = (Array.isArray(input.courts) ? input.courts : [])
      .filter(court => !input.courtId || String(court.id) === String(input.courtId));
    const blockedDates = new Set((Array.isArray(input.blockedDates) ? input.blockedDates : [])
      .map(value => dateOnly(value?.date || value)));
    const openHour = clamp(parseInt(input.settings?.open_hour || 6, 10) || 6, 0, 23);
    const closeHour = clamp(parseInt(input.settings?.close_hour || 22, 10) || 22, openHour + 1, 24);
    const successfulOptions = {
      allowLegacyMissingPaymentStatus: input.allowLegacyMissingPaymentStatus === true,
    };
    const venueRows = logicalSuccessfulRows(input.bookings, throughDate, null, successfulOptions);
    const rows = logicalSuccessfulRows(input.bookings, throughDate, input.courtId, successfulOptions);
    const allCourtMap = new Map((Array.isArray(input.courts) ? input.courts : [])
      .map(court => [String(court.id), court]));
    const rowHasEligibleHistoricalHour = row => {
      const courtId = String(row.courtId || row.court_id);
      const court = allCourtMap.get(courtId);
      const date = dateOnly(row.date);
      const createdDate = dateOnly(court?.createdAt || court?.created_at);
      if (!court || !date || blockedDates.has(date) || (createdDate && createdDate > date)) return false;
      return normalizedSlots(row, openHour).some(piece =>
        piece.hour >= openHour
        && piece.hour < closeHour
        && (!scheduleHourUnavailable(date, piece.hour, courtId, input.settings)
          || scheduleHourIsOpenPlay(date, piece.hour, courtId, input.settings)));
    };
    const earliest = venueRows.filter(rowHasEligibleHistoricalHour)
      .map(row => dateOnly(row.date)).filter(Boolean).sort()[0] || null;
    const historyDates = earliest ? datesBetween(earliest, throughDate) : [];
    const slots = [];
    for (let start = openHour; start < closeHour; start += 1) slots.push({ start, end: start + 1 });

    const courtCells = new Map();
    const selectedCourtMap = new Map(selectedCourts.map(court => [String(court.id), court]));
    const venueComparableDates = new Map();
    selectedCourts.forEach(court => slots.forEach(slot => {
      for (let weekday = 1; weekday <= 7; weekday += 1) {
        const key = `${court.id}:${weekday}:${slot.start}`;
        courtCells.set(key, {
          court_id: String(court.id), court_name: court.name || `Court ${court.id}`,
          rate: rateForSlot(input, court, slot.start),
          weekday, weekday_label: WEEKDAYS[weekday - 1], start_hour: slot.start, end_hour: slot.end,
          booked_hours: 0, available_hours: 0, weighted_booked_hours: 0, weighted_available_hours: 0,
          comparable_days: 0, open_future_hours: 0,
        });
      }
    }));

    let scheduledOpenPlayHours = 0;
    historyDates.forEach(date => {
      if (blockedDates.has(date)) return;
      const weekday = isoWeekday(date);
      const age = daysApart(date, throughDate);
      const recencyWeight = Math.pow(0.5, age / RECENCY_HALF_LIFE_DAYS);
      selectedCourts.forEach(court => {
        const createdDate = dateOnly(court.createdAt || court.created_at);
        if (createdDate && createdDate > date) return;
        slots.forEach(slot => {
          const cell = courtCells.get(`${court.id}:${weekday}:${slot.start}`);
          const isOpenPlay = scheduleHourIsOpenPlay(date, slot.start, court.id, input.settings);
          if (scheduleHourUnavailable(date, slot.start, court.id, input.settings) && !isOpenPlay) return;
          cell.available_hours += 1;
          cell.weighted_available_hours += recencyWeight;
          cell.comparable_days += 1;
          if (isOpenPlay) {
            cell.booked_hours += 1;
            cell.weighted_booked_hours += recencyWeight;
            scheduledOpenPlayHours += 1;
          }
          const venueKey = `${weekday}:${slot.start}`;
          if (!venueComparableDates.has(venueKey)) venueComparableDates.set(venueKey, new Set());
          venueComparableDates.get(venueKey).add(date);
        });
      });
    });

    const eligibleReservationIds = new Set();
    let eligibleBookingRows = 0;
    let eligibleBookedHours = scheduledOpenPlayHours;
    rows.forEach((row, rowIndex) => {
      const courtId = String(row.courtId || row.court_id);
      const date = dateOnly(row.date);
      if (!date || blockedDates.has(date)) return;
      const court = selectedCourtMap.get(courtId);
      const createdDate = dateOnly(court?.createdAt || court?.created_at);
      if (!court || (createdDate && createdDate > date)) return;
      const weekday = isoWeekday(date);
      const age = daysApart(date, throughDate);
      const recencyWeight = Math.pow(0.5, age / RECENCY_HALF_LIFE_DAYS);
      let rowContributed = false;
      normalizedSlots(row, openHour).forEach(piece => {
        const cell = courtCells.get(`${courtId}:${weekday}:${piece.hour}`);
        const isOpenPlay = scheduleHourIsOpenPlay(date, piece.hour, courtId, input.settings);
        if (!cell || scheduleHourUnavailable(date, piece.hour, courtId, input.settings) && !isOpenPlay) return;
        if (isOpenPlay) return;
        cell.booked_hours += piece.hours;
        cell.weighted_booked_hours += piece.hours * recencyWeight;
        eligibleBookedHours += piece.hours;
        rowContributed = true;
      });
      if (!rowContributed) return;
      eligibleBookingRows += 1;
      eligibleReservationIds.add(String(row.groupRef || row.booking_group_ref || row.ref || `row-${rowIndex}`));
    });

    const futureOccupied = new Map();
    (Array.isArray(input.bookings) ? input.bookings : []).forEach(row => {
      const date = dateOnly(row.date);
      if (!date || date <= today || date > addDays(today, FORECAST_DAYS)) return;
      const status = String(row.status || '').toLowerCase();
      const createdMs = new Date(row.createdAt || row.created_at || '').getTime();
      const freshHold = status === 'verifying' && Number.isFinite(createdMs) && nowMs >= createdMs && nowMs - createdMs < 15 * 60000;
      if (!['pending', 'confirmed', 'completed'].includes(status) && !freshHold) return;
      normalizedSlots(row, openHour).forEach(piece => {
        const key = `${row.courtId || row.court_id}:${date}:${piece.hour}`;
        futureOccupied.set(key, Math.min(1, number(futureOccupied.get(key)) + piece.hours));
      });
    });
    datesBetween(addDays(today, 1), addDays(today, FORECAST_DAYS)).forEach(date => {
      if (blockedDates.has(date)) return;
      const weekday = isoWeekday(date);
      selectedCourts.filter(court => !court.blocked).forEach(court => slots.forEach(slot => {
        const cell = courtCells.get(`${court.id}:${weekday}:${slot.start}`);
        if (scheduleHourUnavailable(date, slot.start, court.id, input.settings)) return;
        const occupiedHours = number(futureOccupied.get(`${court.id}:${date}:${slot.start}`));
        cell.open_future_hours += Math.max(0, 1 - occupiedHours);
      }));
    });

    const courtSignals = [...courtCells.values()].map(cell => {
      const weightedAvailable = number(cell.weighted_available_hours);
      const utilization = weightedAvailable > 0 ? clamp(number(cell.weighted_booked_hours) * 100 / weightedAvailable) : 0;
      const interval = wilsonBounds(cell.booked_hours, cell.available_hours);
      const signal = {
        ...cell,
        utilization_pct: utilization,
        expected_occupancy_low: interval.low,
        expected_occupancy_high: interval.high,
      };
      signal.confidence = confidenceFor(signal).code;
      signal.state = demandState(signal);
      signal.opportunity_value = number(signal.open_future_hours) * (1 - utilization / 100) * number(signal.rate);
      return signal;
    });

    const heatmap = [];
    slots.forEach(slot => {
      for (let weekday = 1; weekday <= 7; weekday += 1) {
        const pieces = courtSignals.filter(cell => cell.weekday === weekday && cell.start_hour === slot.start);
        const booked = pieces.reduce((sum, cell) => sum + number(cell.booked_hours), 0);
        const available = pieces.reduce((sum, cell) => sum + number(cell.available_hours), 0);
        const weightedBooked = pieces.reduce((sum, cell) => sum + number(cell.weighted_booked_hours), 0);
        const weightedAvailable = pieces.reduce((sum, cell) => sum + number(cell.weighted_available_hours), 0);
        const cell = {
          weekday, weekday_label: WEEKDAYS[weekday - 1], start_hour: slot.start, end_hour: slot.end,
          booked_hours: booked, available_hours: available,
          comparable_days: venueComparableDates.get(`${weekday}:${slot.start}`)?.size || 0,
          utilization_pct: weightedAvailable > 0 ? clamp(weightedBooked * 100 / weightedAvailable) : 0,
        };
        cell.confidence = confidenceFor(cell).code;
        cell.state = demandState(cell);
        heatmap.push(cell);
      }
    });

    const bookedHours = eligibleBookedHours;
    const availableHours = courtSignals.reduce((sum, cell) => sum + number(cell.available_hours), 0);
    const forecastOpenHours = courtSignals.reduce((sum, cell) => sum + number(cell.open_future_hours), 0);
    const expectedFilledHours = courtSignals.reduce((sum, cell) => sum + number(cell.open_future_hours) * number(cell.utilization_pct) / 100, 0);
    const expectedUnsoldHours = Math.max(0, forecastOpenHours - expectedFilledHours);
    const opportunityValue = courtSignals.reduce((sum, cell) => sum + number(cell.opportunity_value), 0);
    const learningDays = historyDates.length;
    const activeCampaigns = (Array.isArray(input.campaigns) ? input.campaigns : [])
      .filter(item => String(item.status || '').toLowerCase() === 'active');
    const experimentRows = input.experiments || input.profitExperiments || input.profit_experiments || [];
    const activeExperiments = (Array.isArray(experimentRows) ? experimentRows : [])
      .filter(item => String(item.status || '').toLowerCase() === 'active');
    const snapshot = {
      period: {
        from: earliest, to: throughDate, generated_at: new Date().toISOString(),
        days_analyzed: historyDates.length, learning_days: learningDays,
        minimum_learning_days: MINIMUM_LEARNING_DAYS,
      },
      settings: { open_hour: openHour, close_hour: closeHour, court_id: input.courtId || null },
      kpis: {
        successful_reservations: eligibleReservationIds.size,
        booked_hours: bookedHours,
        available_hours: availableHours,
        utilization_pct: availableHours ? clamp(bookedHours * 100 / availableHours) : 0,
        predicted_28d_fill_pct: forecastOpenHours ? clamp(expectedFilledHours * 100 / forecastOpenHours) : 0,
        expected_unsold_hours: expectedUnsoldHours,
        opportunity_value: opportunityValue,
        action_ready_windows: courtSignals.filter(cell => ['medium', 'high'].includes(cell.confidence) && ['underused', 'persistent_vacancy'].includes(cell.state)).length,
      },
      heatmap,
      court_signals: courtSignals,
      active_campaigns: activeCampaigns,
      active_experiments: activeExperiments,
      data_quality: {
        successful_booking_rows: eligibleBookingRows,
        excluded_operational_rows: Math.max(0, (Array.isArray(input.bookings) ? input.bookings.length : 0) - rows.length),
        capacity_note: 'Demand uses sellable court-hours only. Blocked dates, all enabled Maintenance rule types, and Open Play hours are excluded using the currently saved venue schedules.',
        model_note: `Recent comparable weeks carry more weight (${RECENCY_HALF_LIFE_DAYS}-day half-life). Only paid or downpayment-paid confirmed/completed bookings influence demand; failed operational and payment states never do.`,
      },
    };
    snapshot.recommendation = recommendationFromSignals(snapshot);
    return snapshot;
  }

  return {
    MINIMUM_LEARNING_DAYS,
    FORECAST_DAYS,
    RECENCY_HALF_LIFE_DAYS,
    number,
    pricingTiers,
    rateForSlot,
    isPaidSuccessfulBooking,
    confidenceFor,
    wilsonBounds,
    demandState,
    timeLabel,
    cellLabel,
    evidence,
    scheduleHourUnavailable,
    scheduleHourIsOpenPlay,
    recommendationFromSignals,
    buildRecommendations,
    buildLocalSnapshot,
  };
});
