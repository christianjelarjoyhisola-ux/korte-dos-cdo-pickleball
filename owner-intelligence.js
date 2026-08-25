(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerIntelligence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function confidenceFor(cell) {
    const days = number(cell?.comparable_days ?? cell?.comparableDays);
    const hours = number(cell?.available_hours ?? cell?.availableHours);
    if (days >= 12 && hours >= 24) return { code: 'high', label: 'High confidence' };
    if (days >= 6 && hours >= 12) return { code: 'medium', label: 'Medium confidence' };
    return { code: 'learning', label: 'Still learning' };
  }

  function timeLabel(startHour, endHour) {
    const format = hour => {
      const normalized = ((number(hour) % 24) + 24) % 24;
      const suffix = normalized >= 12 ? 'PM' : 'AM';
      const display = normalized % 12 || 12;
      return `${display} ${suffix}`;
    };
    return `${format(startHour)}–${format(endHour)}`;
  }

  function cellLabel(cell) {
    return `${cell?.weekday_label || cell?.weekdayLabel || 'Selected day'} ${timeLabel(cell?.start_hour, cell?.end_hour)}`;
  }

  function evidence(cell) {
    const days = number(cell?.comparable_days ?? cell?.comparableDays);
    const booked = number(cell?.booked_hours ?? cell?.bookedHours);
    const available = number(cell?.available_hours ?? cell?.availableHours);
    return `${days} comparable operating day${days === 1 ? '' : 's'}, ${booked.toFixed(1)} of ${available.toFixed(1)} court-hours booked`;
  }

  function buildRecommendations(snapshot) {
    const kpis = snapshot?.kpis || {};
    const cells = (Array.isArray(snapshot?.heatmap) ? snapshot.heatmap : [])
      .filter(cell => number(cell?.available_hours ?? cell?.availableHours) > 0);
    const recommendations = [];
    const weakCandidates = cells
      .filter(cell => confidenceFor(cell).code !== 'learning')
      .filter(cell => number(cell?.booked_hours ?? cell?.bookedHours) > 0)
      .filter(cell => number(cell?.utilization_pct ?? cell?.utilizationPct) <= 35)
      .sort((a, b) =>
        number(a?.utilization_pct ?? a?.utilizationPct) - number(b?.utilization_pct ?? b?.utilizationPct)
        || number(b?.available_hours ?? b?.availableHours) - number(a?.available_hours ?? a?.availableHours)
      );
    const peakCandidates = cells
      .filter(cell => confidenceFor(cell).code !== 'learning')
      .filter(cell => number(cell?.utilization_pct ?? cell?.utilizationPct) >= 70)
      .sort((a, b) => number(b?.utilization_pct ?? b?.utilizationPct) - number(a?.utilization_pct ?? a?.utilizationPct));

    if (number(kpis.outstanding_balance) > 0) {
      recommendations.push({
        type: 'payment_recovery',
        priority: 200,
        confidence: { code: 'high', label: 'Directly measured' },
        title: 'Recover confirmed booking balances',
        summary: 'Follow up on outstanding balances before offering additional discounts.',
        evidence: `₱${number(kpis.outstanding_balance).toLocaleString('en-PH', { maximumFractionDigits: 0 })} remains outstanding on active bookings.`,
        action: 'Review balances',
        actionSection: 'bookings',
      });
    }

    if (weakCandidates.length) {
      const cell = weakCandidates[0];
      const utilization = number(cell?.utilization_pct ?? cell?.utilizationPct);
      const openHours = Math.max(0, number(cell?.available_hours ?? cell?.availableHours) - number(cell?.booked_hours ?? cell?.bookedHours));
      recommendations.push({
        type: 'off_peak',
        priority: 80 + Math.max(0, 35 - utilization),
        confidence: confidenceFor(cell),
        title: `Test an off-peak offer for ${cellLabel(cell)}`,
        summary: `This window is ${utilization.toFixed(0)}% utilized. Create a short, owner-approved voucher draft and measure incremental bookings before extending it.`,
        evidence: `${evidence(cell)}; ${openHours.toFixed(1)} historical court-hours were unfilled.`,
        action: 'Open vouchers',
        actionSection: 'vouchers',
        context: cell,
      });
    }

    if (peakCandidates.length) {
      const cell = peakCandidates[0];
      const utilization = number(cell?.utilization_pct ?? cell?.utilizationPct);
      recommendations.push({
        type: 'protect_peak',
        priority: 65 + utilization / 10,
        confidence: confidenceFor(cell),
        title: `Protect pricing for ${cellLabel(cell)}`,
        summary: `Demand is already strong at ${utilization.toFixed(0)}% utilization. Avoid broad discounts in this window and keep capacity for full-price bookings.`,
        evidence: evidence(cell),
        action: 'View vouchers',
        actionSection: 'vouchers',
        context: cell,
      });
    }

    const totalReservations = number(kpis.total_reservations);
    const cancellationRate = number(kpis.cancellation_rate);
    if (totalReservations >= 10 && cancellationRate >= 10) {
      recommendations.push({
        type: 'cancellation',
        priority: 70 + cancellationRate,
        confidence: totalReservations >= 30
          ? { code: 'high', label: 'High confidence' }
          : { code: 'medium', label: 'Medium confidence' },
        title: 'Reduce booking loss from cancellations',
        summary: 'Review cancellation timing and payment completion before spending on acquisition discounts.',
        evidence: `${cancellationRate.toFixed(1)}% of ${totalReservations} recorded reservations were cancelled or forfeited.`,
        action: 'Review lifecycle',
        actionSection: 'bookings',
      });
    }

    if (!recommendations.length) {
      const bestLearningCell = cells
        .sort((a, b) => number(b?.comparable_days ?? b?.comparableDays) - number(a?.comparable_days ?? a?.comparableDays))[0];
      const analyzedDays = number(snapshot?.period?.operating_days);
      recommendations.push({
        type: 'learning',
        priority: 1,
        confidence: { code: 'learning', label: 'Still learning' },
        title: 'Building a reliable demand baseline',
        summary: 'Korte DOS is using all reliable historical bookings, but this segment does not yet have enough comparable operating days for a safe action.',
        evidence: bestLearningCell ? evidence(bestLearningCell) : `${analyzedDays} operating day${analyzedDays === 1 ? '' : 's'} analyzed.`,
        action: '',
        actionSection: '',
      });
    }

    return recommendations
      .sort((a, b) => b.priority - a.priority)
      .slice(0, 4);
  }

  function buildLocalSnapshot(input = {}) {
    const today = String(input.now || new Date().toISOString()).slice(0, 10);
    const courts = (Array.isArray(input.courts) ? input.courts : [])
      .filter(court => !input.courtId || String(court.id) === String(input.courtId));
    const blockedDates = new Set(Array.isArray(input.blockedDates) ? input.blockedDates : []);
    const openHour = Math.max(0, Math.min(23, parseInt(input.settings?.open_hour || 6, 10) || 6));
    const closeHour = Math.max(openHour + 1, Math.min(24, parseInt(input.settings?.close_hour || 22, 10) || 22));
    const allRows = (Array.isArray(input.bookings) ? input.bookings : []);
    const excludedImport = allRows.filter(row =>
      String(row.createdVia || row.created_via || '').toLowerCase() === 'import'
      || String(row.ref || '').toUpperCase().startsWith('MANUAL-')
      || String(row.paymentMethod || row.payment_method || '').toLowerCase() === 'manual'
    ).length;
    const excludedHolds = allRows.filter(row => String(row.email || '').toLowerCase() === 'reserve@hold.internal').length;
    const reliable = allRows.filter(row =>
      String(row.createdVia || row.created_via || '').toLowerCase() !== 'import'
      && !String(row.ref || '').toUpperCase().startsWith('MANUAL-')
      && String(row.paymentMethod || row.payment_method || '').toLowerCase() !== 'manual'
      && String(row.email || '').toLowerCase() !== 'reserve@hold.internal'
      && String(row.date || '').slice(0, 10) <= today
    );
    const earliest = reliable.map(row => String(row.date || '').slice(0,10)).filter(Boolean).sort()[0] || today;
    const rangeEnd = [String(input.to || today).slice(0,10), today].sort()[0];
    const rangeStart = String(input.from || earliest || rangeEnd).slice(0,10);
    const logical = new Map();
    reliable
      .filter(row => String(row.date || '').slice(0,10) >= rangeStart && String(row.date || '').slice(0,10) <= rangeEnd)
      .filter(row => !input.courtId || String(row.courtId || row.court_id) === String(input.courtId))
      .forEach(row => {
        const reservationKey = String(row.groupRef || row.booking_group_ref || row.ref || '');
        const slots = Array.isArray(row.slots) ? row.slots.join(',') : '';
        const key = `${reservationKey}|${row.courtId || row.court_id}|${row.date}|${slots || row.startTime || row.start_time || ''}`;
        if (!logical.has(key)) logical.set(key, { ...row, reservationKey });
      });
    const rows = [...logical.values()];
    const paidAmount = row => {
      const total = Math.max(0, number(row.total));
      const status = String(row.paymentStatus || row.payment_status || 'unpaid').toLowerCase();
      if (status === 'paid') return total;
      if (status === 'downpayment_paid' || status === 'deposit_retained') return Math.min(total, Math.max(0, number(row.downpayment)));
      return 0;
    };
    const reservationMap = new Map();
    rows.forEach(row => {
      if (!reservationMap.has(row.reservationKey)) reservationMap.set(row.reservationKey, []);
      reservationMap.get(row.reservationKey).push(row);
    });
    const lifecycleOrder = ['completed','confirmed','verifying','pending','forfeited','cancelled'];
    const reservations = [...reservationMap.values()].map(items => {
      const statuses = new Set(items.map(row => String(row.status || 'pending').toLowerCase()));
      const lifecycleStatus = lifecycleOrder.find(status => statuses.has(status)) || 'cancelled';
      const customer = String(items[0]?.email || items[0]?.contactNumber || items[0]?.contact_number || items[0]?.reservationKey || '').toLowerCase();
      return {
        lifecycleStatus,
        customer,
        grossRevenue: items.reduce((sum, row) => sum + (['confirmed','completed'].includes(String(row.status).toLowerCase()) ? number(row.total) : (String(row.status).toLowerCase() === 'forfeited' && String(row.paymentStatus || row.payment_status).toLowerCase() === 'deposit_retained' ? paidAmount(row) : 0)), 0),
        collectedRevenue: items.reduce((sum, row) => sum + (['confirmed','completed','forfeited'].includes(String(row.status).toLowerCase()) ? paidAmount(row) : 0), 0),
        outstandingBalance: items.reduce((sum, row) => sum + (['confirmed','completed'].includes(String(row.status).toLowerCase()) ? Math.max(0, number(row.total) - paidAmount(row)) : 0), 0),
        bookedHours: items.reduce((sum, row) => sum + (['confirmed','completed'].includes(String(row.status).toLowerCase()) ? Math.max(0, number(row.duration)) : 0), 0),
      };
    });
    const dateRange = [];
    for (let cursor = new Date(`${rangeStart}T00:00:00Z`), end = new Date(`${rangeEnd}T00:00:00Z`); cursor <= end; cursor.setUTCDate(cursor.getUTCDate()+1)) {
      dateRange.push(cursor.toISOString().slice(0,10));
    }
    const capacityByCourt = new Map(courts.map(court => [String(court.id), 0]));
    let availableHours = 0;
    let operatingDays = 0;
    const heat = new Map();
    const bands = [];
    for (let start = openHour; start < closeHour; start += 3) bands.push({ start, end: Math.min(start + 3, closeHour) });
    dateRange.forEach(date => {
      let dayAvailable = 0;
      let availableCourtCount = 0;
      const weekday = ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
      courts.forEach(court => {
        const createdDate = String(court.createdAt || court.created_at || '').slice(0,10);
        const exists = !createdDate || createdDate <= date;
        const available = exists && !blockedDates.has(date) && !(date === today && court.blocked);
        if (!available) return;
        const hours = closeHour - openHour;
        availableCourtCount += 1;
        availableHours += hours;
        dayAvailable += hours;
        capacityByCourt.set(String(court.id), number(capacityByCourt.get(String(court.id))) + hours);
      });
      if (dayAvailable > 0) {
        operatingDays += 1;
        bands.forEach(band => {
          const key = `${weekday}:${band.start}`;
          const cell = heat.get(key) || { weekday, weekday_label: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][weekday-1], start_hour: band.start, end_hour: band.end, booked_hours: 0, available_hours: 0, comparable_days: 0 };
          cell.available_hours += (band.end - band.start) * availableCourtCount;
          cell.comparable_days += 1;
          heat.set(key, cell);
        });
      }
    });
    const parseStart = value => {
      const match = String(value || '').trim().match(/^(\d{1,2})(?::\d{2})?\s*(AM|PM)?/i);
      if (!match) return openHour;
      let hour = Number(match[1]);
      if (match[2]) { hour %= 12; if (match[2].toUpperCase() === 'PM') hour += 12; }
      return hour;
    };
    rows.filter(row => ['confirmed','completed'].includes(String(row.status).toLowerCase())).forEach(row => {
      const weekday = ((new Date(`${row.date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
      const slots = Array.isArray(row.slots) ? row.slots.map(Number).filter(Number.isFinite) : [];
      const pieces = slots.length ? slots.map(hour => ({ hour, hours: 1 })) : [{ hour: parseStart(row.startTime || row.start_time), hours: Math.max(0, number(row.duration)) }];
      pieces.forEach(piece => {
        const band = bands.find(item => piece.hour >= item.start && piece.hour < item.end);
        if (!band) return;
        const key = `${weekday}:${band.start}`;
        const cell = heat.get(key) || { weekday, weekday_label: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][weekday-1], start_hour: band.start, end_hour: band.end, booked_hours: 0, available_hours: 0, comparable_days: 0 };
        cell.booked_hours += piece.hours;
        heat.set(key, cell);
      });
    });
    const heatmap = [];
    bands.forEach(band => { for (let weekday=1; weekday<=7; weekday++) {
      const cell = heat.get(`${weekday}:${band.start}`) || { weekday, weekday_label: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][weekday-1], start_hour: band.start, end_hour: band.end, booked_hours: 0, available_hours: 0, comparable_days: 0 };
      cell.utilization_pct = cell.available_hours > 0 ? Math.min(100, cell.booked_hours * 100 / cell.available_hours) : 0;
      heatmap.push(cell);
    }});
    const daysAnalyzed = dateRange.length;
    const trendGrain = daysAnalyzed > 180 ? 'month' : daysAnalyzed > 60 ? 'week' : 'day';
    const trendKey = date => {
      if (trendGrain === 'month') return `${date.slice(0,7)}-01`;
      if (trendGrain === 'week') {
        const value = new Date(`${date}T00:00:00Z`); const day = (value.getUTCDay()+6)%7; value.setUTCDate(value.getUTCDate()-day); return value.toISOString().slice(0,10);
      }
      return date;
    };
    const trendMap = new Map();
    dateRange.forEach(date => trendMap.set(trendKey(date), { date: trendKey(date), reservations: 0, booked_hours: 0, collected_revenue: 0 }));
    rows.forEach(row => {
      const key = trendKey(String(row.date).slice(0,10));
      const item = trendMap.get(key) || { date: key, reservations: 0, booked_hours: 0, collected_revenue: 0 };
      if (['confirmed','completed'].includes(String(row.status).toLowerCase())) item.booked_hours += Math.max(0, number(row.duration));
      if (['confirmed','completed','forfeited'].includes(String(row.status).toLowerCase())) item.collected_revenue += paidAmount(row);
      trendMap.set(key, item);
    });
    reservationMap.forEach(items => {
      if (!items.some(row => ['confirmed','completed'].includes(String(row.status).toLowerCase()))) return;
      const key = trendKey(String(items[0].date).slice(0,10));
      const item = trendMap.get(key); if (item) item.reservations += 1;
    });
    const customerCounts = new Map();
    reservations.filter(item => ['confirmed','completed'].includes(item.lifecycleStatus)).forEach(item => customerCounts.set(item.customer, number(customerCounts.get(item.customer)) + 1));
    const activeCustomers = [...customerCounts.values()];
    const courtPerformance = courts.map(court => {
      const courtRows = rows.filter(row => String(row.courtId || row.court_id) === String(court.id));
      const booked = courtRows.reduce((sum,row)=>sum+(['confirmed','completed'].includes(String(row.status).toLowerCase())?number(row.duration):0),0);
      const capacity = number(capacityByCourt.get(String(court.id)));
      return { court_id:court.id, court_name:court.name, booked_hours:booked, available_hours:capacity, utilization_pct:capacity?Math.min(100,booked*100/capacity):0, gross_revenue:courtRows.reduce((sum,row)=>sum+(['confirmed','completed'].includes(String(row.status).toLowerCase())?number(row.total):0),0), collected_revenue:courtRows.reduce((sum,row)=>sum+(['confirmed','completed','forfeited'].includes(String(row.status).toLowerCase())?paidAmount(row):0),0) };
    }).sort((a,b)=>b.collected_revenue-a.collected_revenue);
    const grossRevenue = reservations.reduce((sum,item)=>sum+item.grossRevenue,0);
    const collectedRevenue = reservations.reduce((sum,item)=>sum+item.collectedRevenue,0);
    const outstandingBalance = reservations.reduce((sum,item)=>sum+item.outstandingBalance,0);
    const bookedHours = reservations.reduce((sum,item)=>sum+item.bookedHours,0);
    const lifecycle = ['confirmed','completed','pending','verifying','cancelled','forfeited'].map(status => ({ status, count: reservations.filter(item=>item.lifecycleStatus===status).length }));
    const cancelled = reservations.filter(item=>['cancelled','forfeited'].includes(item.lifecycleStatus)).length;
    return {
      period: { from:rangeStart, to:rangeEnd, earliest_reliable_booking_date:earliest, generated_at:new Date().toISOString(), days_analyzed:daysAnalyzed, operating_days:operatingDays, trend_grain:trendGrain },
      settings: { open_hour:openHour, close_hour:closeHour, court_id:input.courtId || null },
      kpis: { gross_revenue:grossRevenue, collected_revenue:collectedRevenue, outstanding_balance:outstandingBalance, booked_hours:bookedHours, available_hours:availableHours, utilization_pct:availableHours?Math.min(100,bookedHours*100/availableHours):0, completed_reservations:reservations.filter(item=>item.lifecycleStatus==='completed').length, active_reservations:reservations.filter(item=>['confirmed','completed'].includes(item.lifecycleStatus)).length, total_reservations:reservations.length, revenue_per_booked_hour:bookedHours?collectedRevenue/bookedHours:0, revenue_per_available_hour:availableHours?collectedRevenue/availableHours:0, cancellation_rate:reservations.length?cancelled*100/reservations.length:0, repeat_customer_rate:activeCustomers.length?activeCustomers.filter(count=>count>1).length*100/activeCustomers.length:0 },
      lifecycle, trend:[...trendMap.values()].sort((a,b)=>a.date.localeCompare(b.date)), heatmap, courts:courtPerformance,
      data_quality: { reliable_booking_rows:rows.length, excluded_import_rows:excludedImport, excluded_placeholder_rows:excludedHolds, historical_capacity_exact:false, capacity_basis:'local operating hours and saved court state', capacity_note:'Local demo mode estimates historical capacity from saved operating hours, court creation dates, venue block dates, and current-day court state.' },
    };
  }

  return {
    number,
    confidenceFor,
    timeLabel,
    cellLabel,
    evidence,
    buildRecommendations,
    buildLocalSnapshot,
  };
});
