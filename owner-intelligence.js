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
    if (days >= 16 && hours >= 48) return { code: 'high', label: 'High confidence' };
    if (days >= 8 && hours >= 24) return { code: 'medium', label: 'Medium confidence' };
    if (days >= 4 && hours >= 12) return { code: 'low', label: 'Low confidence' };
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
    if (explicit.length) return explicit.map(hour => ({ hour, hours: 1 }));
    const duration = Math.max(0, number(row?.duration));
    const start = parseStartHour(row?.startTime || row?.start_time, fallbackOpen);
    return duration ? [{ hour: start, hours: duration }] : [];
  }

  function isSuccessful(row) {
    const status = String(row?.status || '').toLowerCase();
    const eligible = row?.analyticsEligible ?? row?.analytics_eligible;
    return eligible !== false
      && ['confirmed', 'completed'].includes(status)
      && String(row?.email || '').toLowerCase() !== 'reserve@hold.internal';
  }

  function logicalSuccessfulRows(rows, throughDate, courtId = null) {
    const logical = new Map();
    (Array.isArray(rows) ? rows : [])
      .filter(isSuccessful)
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
      'demand-v1', signal.court_id, signal.weekday, signal.start_hour,
      signal.end_hour, throughDate, Math.round(number(signal.utilization_pct) * 10),
    ].join(':');
  }

  function recommendationFromSignals(snapshot) {
    if (snapshot?.recommendation) return snapshot.recommendation;
    const learningDays = number(snapshot?.period?.learning_days ?? snapshot?.period?.days_analyzed);
    if (learningDays < MINIMUM_LEARNING_DAYS || (snapshot?.active_campaigns || []).some(item => item.status === 'active')) return null;
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
      discount_percent: 10,
      valid_days: FORECAST_DAYS,
      max_redemptions: 20,
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
    const blockedDates = new Set((Array.isArray(input.blockedDates) ? input.blockedDates : []).map(dateOnly));
    const openHour = clamp(parseInt(input.settings?.open_hour || 6, 10) || 6, 0, 23);
    const closeHour = clamp(parseInt(input.settings?.close_hour || 22, 10) || 22, openHour + 1, 24);
    const venueRows = logicalSuccessfulRows(input.bookings, throughDate, null);
    const rows = logicalSuccessfulRows(input.bookings, throughDate, input.courtId);
    const earliest = venueRows.map(row => dateOnly(row.date)).filter(Boolean).sort()[0] || null;
    const historyDates = earliest ? datesBetween(earliest, throughDate) : [];
    const bands = [];
    for (let start = openHour; start < closeHour; start += 3) bands.push({ start, end: Math.min(start + 3, closeHour) });

    const courtCells = new Map();
    selectedCourts.forEach(court => bands.forEach(band => {
      for (let weekday = 1; weekday <= 7; weekday += 1) {
        const key = `${court.id}:${weekday}:${band.start}`;
        courtCells.set(key, {
          court_id: String(court.id), court_name: court.name || `Court ${court.id}`, rate: number(court.rate),
          weekday, weekday_label: WEEKDAYS[weekday - 1], start_hour: band.start, end_hour: band.end,
          booked_hours: 0, available_hours: 0, weighted_booked_hours: 0, weighted_available_hours: 0,
          comparable_days: 0, open_future_hours: 0,
        });
      }
    }));

    historyDates.forEach(date => {
      if (blockedDates.has(date)) return;
      const weekday = isoWeekday(date);
      const age = daysApart(date, throughDate);
      const recencyWeight = Math.pow(0.5, age / RECENCY_HALF_LIFE_DAYS);
      selectedCourts.forEach(court => {
        const createdDate = dateOnly(court.createdAt || court.created_at);
        if (createdDate && createdDate > date) return;
        bands.forEach(band => {
          const cell = courtCells.get(`${court.id}:${weekday}:${band.start}`);
          const hours = band.end - band.start;
          cell.available_hours += hours;
          cell.weighted_available_hours += hours * recencyWeight;
          cell.comparable_days += 1;
        });
      });
    });

    rows.forEach(row => {
      const courtId = String(row.courtId || row.court_id);
      const date = dateOnly(row.date);
      const weekday = isoWeekday(date);
      const age = daysApart(date, throughDate);
      const recencyWeight = Math.pow(0.5, age / RECENCY_HALF_LIFE_DAYS);
      normalizedSlots(row, openHour).forEach(piece => {
        const band = bands.find(item => piece.hour >= item.start && piece.hour < item.end);
        const cell = band && courtCells.get(`${courtId}:${weekday}:${band.start}`);
        if (!cell) return;
        cell.booked_hours += piece.hours;
        cell.weighted_booked_hours += piece.hours * recencyWeight;
      });
    });

    const futureOccupied = new Set();
    (Array.isArray(input.bookings) ? input.bookings : []).forEach(row => {
      const date = dateOnly(row.date);
      if (!date || date <= today || date > addDays(today, FORECAST_DAYS)) return;
      const status = String(row.status || '').toLowerCase();
      const createdMs = new Date(row.createdAt || row.created_at || '').getTime();
      const freshHold = status === 'verifying' && Number.isFinite(createdMs) && nowMs >= createdMs && nowMs - createdMs < 15 * 60000;
      if (!['pending', 'confirmed', 'completed'].includes(status) && !freshHold) return;
      normalizedSlots(row, openHour).forEach(piece => futureOccupied.add(`${row.courtId || row.court_id}:${date}:${piece.hour}`));
    });
    datesBetween(addDays(today, 1), addDays(today, FORECAST_DAYS)).forEach(date => {
      if (blockedDates.has(date)) return;
      const weekday = isoWeekday(date);
      selectedCourts.forEach(court => bands.forEach(band => {
        const cell = courtCells.get(`${court.id}:${weekday}:${band.start}`);
        for (let hour = band.start; hour < band.end; hour += 1) {
          if (!futureOccupied.has(`${court.id}:${date}:${hour}`)) cell.open_future_hours += 1;
        }
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
    bands.forEach(band => {
      for (let weekday = 1; weekday <= 7; weekday += 1) {
        const pieces = courtSignals.filter(cell => cell.weekday === weekday && cell.start_hour === band.start);
        const booked = pieces.reduce((sum, cell) => sum + number(cell.booked_hours), 0);
        const available = pieces.reduce((sum, cell) => sum + number(cell.available_hours), 0);
        const weightedBooked = pieces.reduce((sum, cell) => sum + number(cell.weighted_booked_hours), 0);
        const weightedAvailable = pieces.reduce((sum, cell) => sum + number(cell.weighted_available_hours), 0);
        const cell = {
          weekday, weekday_label: WEEKDAYS[weekday - 1], start_hour: band.start, end_hour: band.end,
          booked_hours: booked, available_hours: available,
          comparable_days: pieces.reduce((max, item) => Math.max(max, number(item.comparable_days)), 0),
          utilization_pct: weightedAvailable > 0 ? clamp(weightedBooked * 100 / weightedAvailable) : 0,
        };
        cell.confidence = confidenceFor(cell).code;
        cell.state = demandState(cell);
        heatmap.push(cell);
      }
    });

    const reservationIds = new Set(rows.map(row => String(row.groupRef || row.booking_group_ref || row.ref || '')));
    const bookedHours = rows.reduce((sum, row) => sum + normalizedSlots(row, openHour).reduce((hours, piece) => hours + piece.hours, 0), 0);
    const availableHours = courtSignals.reduce((sum, cell) => sum + number(cell.available_hours), 0);
    const forecastOpenHours = courtSignals.reduce((sum, cell) => sum + number(cell.open_future_hours), 0);
    const expectedFilledHours = courtSignals.reduce((sum, cell) => sum + number(cell.open_future_hours) * number(cell.utilization_pct) / 100, 0);
    const expectedUnsoldHours = Math.max(0, forecastOpenHours - expectedFilledHours);
    const opportunityValue = courtSignals.reduce((sum, cell) => sum + number(cell.opportunity_value), 0);
    const learningDays = historyDates.length;
    const activeCampaigns = (Array.isArray(input.campaigns) ? input.campaigns : [])
      .filter(item => item.status === 'active' && (!input.courtId || String(item.court_id || item.courtId) === String(input.courtId)));
    const snapshot = {
      period: {
        from: earliest, to: throughDate, generated_at: new Date().toISOString(),
        days_analyzed: historyDates.length, learning_days: learningDays,
        minimum_learning_days: MINIMUM_LEARNING_DAYS,
      },
      settings: { open_hour: openHour, close_hour: closeHour, court_id: input.courtId || null },
      kpis: {
        successful_reservations: reservationIds.size,
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
      data_quality: {
        successful_booking_rows: rows.length,
        excluded_operational_rows: Math.max(0, (Array.isArray(input.bookings) ? input.bookings.length : 0) - rows.length),
        capacity_note: 'Demand uses successful confirmed or completed bookings only. Blocked dates are removed; historical maintenance is estimated from saved venue state.',
        model_note: `Recent comparable weeks carry more weight (${RECENCY_HALF_LIFE_DAYS}-day half-life). Failed attempts and payment states never influence demand.`,
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
    confidenceFor,
    wilsonBounds,
    demandState,
    timeLabel,
    cellLabel,
    evidence,
    recommendationFromSignals,
    buildRecommendations,
    buildLocalSnapshot,
  };
});
