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

  function addDays(date, days) {
    const value = new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + number(days));
    return value.toISOString().slice(0, 10);
  }

  function trendGrainForDays(days) {
    const count = Math.max(0, number(days));
    if (count <= 28) return 'day';
    if (count <= 180) return 'week';
    return 'month';
  }

  function buildRecommendations(snapshot) {
    const kpis = snapshot?.kpis || {};
    const operationalDate = snapshot?.forward_outlook?.as_of || snapshot?.period?.generated_at || new Date().toISOString();
    const forward30 = (Array.isArray(snapshot?.forward_outlook?.horizons) ? snapshot.forward_outlook.horizons : [])
      .find(item => number(item?.days) === 30)?.kpis || {};
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

    if (number(forward30.outstanding_balance) > 0) {
      recommendations.push({
        type: 'future_payment_recovery', priority: 220,
        confidence: { code:'high', label:'Directly measured' },
        title: 'Protect upcoming revenue by collecting balances',
        summary: 'Resolve confirmed future booking balances before launching a demand experiment.',
        evidence: `₱${number(forward30.outstanding_balance).toLocaleString('en-PH',{maximumFractionDigits:0})} is outstanding across the next 30 play days.`,
        plan: 'Contact confirmed customers with upcoming balances and reconcile payment against the reservation.',
        guardrail: 'Do not mark any balance paid without matching payment evidence.',
        successMetric: 'Reduce the measured 30-day future outstanding balance.',
        reviewDate: addDays(operationalDate, 3), action:'Review balances', actionSection:'bookings',
      });
    }

    if (number(forward30.payment_review_reservations) > 0) {
      const futureReview = number(forward30.payment_review_reservations);
      recommendations.push({
        type:'future_payment_review', priority:210,
        confidence:{code:'high',label:'Directly measured'},
        title:'Review payments for upcoming play dates',
        summary:'Clear receipt-backed future payments before running a growth experiment.',
        evidence:`${futureReview} future reservation${futureReview===1?'':'s'} in the next 30 days ${futureReview===1?'has':'have'} stored evidence awaiting review.`,
        plan:'Resolve each item from Payment Review while preserving unclear receipts as pending.',
        guardrail:'Never reject only because OCR missed a field.',
        successMetric:'All receipt-backed future reviews resolved accurately.',
        reviewDate:addDays(operationalDate,1), action:'Open Payment Review', actionSection:'payreview',
      });
    }

    if (number(kpis.outstanding_balance) > 0) {
      recommendations.push({
        type: 'payment_recovery',
        priority: 200,
        confidence: { code: 'high', label: 'Directly measured' },
        title: 'Recover confirmed booking balances',
        summary: 'Follow up on outstanding balances before offering additional discounts.',
        evidence: `₱${number(kpis.outstanding_balance).toLocaleString('en-PH', { maximumFractionDigits: 0 })} remains outstanding on active bookings.`,
        plan: 'Contact the affected customers and reconcile each balance against its confirmed reservation.',
        guardrail: 'Do not change a booking or mark it paid without matching payment evidence.',
        successMetric: 'Outstanding balance reduced with no payment mismatch.',
        reviewDate: addDays(operationalDate, 3),
        action: 'Review balances',
        actionSection: 'bookings',
      });
    }

    if (number(kpis.payment_review_reservations) > 0) {
      const reviewCount = number(kpis.payment_review_reservations);
      recommendations.push({
        type: 'payment_review',
        priority: 180,
        confidence: { code: 'high', label: 'Directly measured' },
        title: 'Review submitted payments',
        summary: 'Resolve receipt-backed payments before testing new discounts or acquisition offers.',
        evidence: `${reviewCount} reservation${reviewCount === 1 ? '' : 's'} ${reviewCount === 1 ? 'has' : 'have'} durable receipt evidence awaiting review.`,
        plan: 'Review the stored receipt evidence and decide each payment from the Payment Review queue.',
        guardrail: 'Keep unclear receipts pending; never reject only because OCR missed a field.',
        successMetric: 'All receipt-backed reviews resolved accurately.',
        reviewDate: addDays(operationalDate, 1),
        action: 'Open Payment Review',
        actionSection: 'payreview',
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
        title: `Run a 14-day demand experiment for ${cellLabel(cell)}`,
        summary: `This window is ${utilization.toFixed(0)}% utilized. Test focused awareness and clearer availability messaging before considering any price change.`,
        evidence: `${evidence(cell)}; ${openHours.toFixed(1)} historical court-hours were unfilled.`,
        plan: 'Feature this exact play window in organic posts and booking-page messaging for 14 days, then compare like-for-like bookings.',
        guardrail: 'Keep the current court price and peak windows unchanged during the test.',
        successMetric: 'At least 2 additional confirmed bookings versus the prior comparable 14-day baseline, or a 10-point utilization lift.',
        reviewDate: addDays(operationalDate, 14),
        action: '',
        actionSection: '',
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
        plan: 'Maintain current pricing and monitor whether the window continues to fill at the same pace.',
        guardrail: 'Do not include this window in broad promotions while utilization remains above 70%.',
        successMetric: 'Utilization remains at or above 70% without reducing yield.',
        reviewDate: addDays(operationalDate, 14),
        action: '',
        actionSection: '',
        context: cell,
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
        plan: 'Keep booking availability accurate and collect more comparable operating days.',
        guardrail: 'Do not infer demand or change price from zero or low-sample data.',
        successMetric: 'At least 6 comparable days and 18 available court-hours for a target window.',
        reviewDate: addDays(operationalDate, 14),
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
    const allReliable = allRows.filter(row =>
      String(row.createdVia || row.created_via || '').toLowerCase() !== 'import'
      && !String(row.ref || '').toUpperCase().startsWith('MANUAL-')
      && String(row.paymentMethod || row.payment_method || '').toLowerCase() !== 'manual'
      && String(row.email || '').toLowerCase() !== 'reserve@hold.internal'
    );
    const reliable = allReliable.filter(row => String(row.date || '').slice(0, 10) <= today);
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
      const paymentReview = items.some(row => {
        const bookingStatus = String(row.status || '').toLowerCase();
        const paymentStatus = String(row.paymentStatus || row.payment_status || '').toLowerCase();
        const receiptStatus = String(row.receiptStatus || row.receipt_status || '').toLowerCase();
        const hasStoredReceipt = Boolean(
          String(row.receiptImageUrl || row.receipt_image_url || '').trim()
          && /^[a-f0-9]{64}$/i.test(String(row.receiptImageHash || row.receipt_image_hash || '').trim())
        );
        const hasAuditEvidence = Boolean(row.receiptVerificationId || row.receipt_verification_id || row.hasReceiptVerification);
        return ['pending','verifying'].includes(bookingStatus)
          && paymentStatus === 'for_verification'
          && (hasStoredReceipt || receiptStatus === 'manual_review' || hasAuditEvidence);
      });
      const customer = String(items[0]?.email || items[0]?.contactNumber || items[0]?.contact_number || items[0]?.reservationKey || '').toLowerCase();
      return {
        lifecycleStatus,
        paymentReview,
        customer,
        grossRevenue: items.reduce((sum, row) => sum + (['confirmed','completed'].includes(String(row.status).toLowerCase()) ? number(row.total) : 0), 0),
        collectedRevenue: items.reduce((sum, row) => sum + (['confirmed','completed'].includes(String(row.status).toLowerCase()) ? paidAmount(row) : 0), 0),
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
    const trendGrain = trendGrainForDays(daysAnalyzed);
    const trendKey = date => {
      if (trendGrain === 'month') return `${date.slice(0,7)}-01`;
      if (trendGrain === 'week') {
        const value = new Date(`${date}T00:00:00Z`); const day = (value.getUTCDay()+6)%7; value.setUTCDate(value.getUTCDate()-day); return value.toISOString().slice(0,10);
      }
      return date;
    };
    const trendMap = new Map();
    dateRange.forEach(date => {
      const key = trendKey(date);
      const item = trendMap.get(key) || { date:key, bucket_start:date, bucket_end:date, is_partial:false, reservations:0, booked_hours:0, collected_revenue:0 };
      item.bucket_end = date;
      trendMap.set(key, item);
    });
    trendMap.forEach(item => {
      let fullEnd = item.date;
      if (trendGrain === 'week') fullEnd = addDays(item.date, 6);
      if (trendGrain === 'month') fullEnd = addDays(`${addDays(`${item.date.slice(0,7)}-28`, 4).slice(0,7)}-01`, -1);
      item.is_partial = item.bucket_start !== item.date || item.bucket_end !== fullEnd;
    });
    rows.forEach(row => {
      const key = trendKey(String(row.date).slice(0,10));
      const item = trendMap.get(key) || { date:key, bucket_start:String(row.date).slice(0,10), bucket_end:String(row.date).slice(0,10), is_partial:true, reservations:0, booked_hours:0, collected_revenue:0 };
      if (['confirmed','completed'].includes(String(row.status).toLowerCase())) item.booked_hours += Math.max(0, number(row.duration));
      if (['confirmed','completed'].includes(String(row.status).toLowerCase())) item.collected_revenue += paidAmount(row);
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
      return { court_id:court.id, court_name:court.name, booked_hours:booked, available_hours:capacity, utilization_pct:capacity?Math.min(100,booked*100/capacity):0, gross_revenue:courtRows.reduce((sum,row)=>sum+(['confirmed','completed'].includes(String(row.status).toLowerCase())?number(row.total):0),0), collected_revenue:courtRows.reduce((sum,row)=>sum+(['confirmed','completed'].includes(String(row.status).toLowerCase())?paidAmount(row):0),0) };
    }).sort((a,b)=>b.collected_revenue-a.collected_revenue);
    const grossRevenue = reservations.reduce((sum,item)=>sum+item.grossRevenue,0);
    const collectedRevenue = reservations.reduce((sum,item)=>sum+item.collectedRevenue,0);
    const outstandingBalance = reservations.reduce((sum,item)=>sum+item.outstandingBalance,0);
    const bookedHours = reservations.reduce((sum,item)=>sum+item.bookedHours,0);
    const paymentReviewReservations = reservations.filter(item => item.paymentReview).length;
    const lifecycle = [
      { status:'completed', count:reservations.filter(item=>item.lifecycleStatus==='completed').length },
      { status:'confirmed', count:reservations.filter(item=>item.lifecycleStatus==='confirmed').length },
      { status:'payment_review', count:paymentReviewReservations },
    ];
    const forwardEnd = addDays(today, 60);
    const forwardLogical = new Map();
    allReliable
      .filter(row => String(row.date || '').slice(0,10) > today && String(row.date || '').slice(0,10) <= forwardEnd)
      .filter(row => !input.courtId || String(row.courtId || row.court_id) === String(input.courtId))
      .forEach(row => {
        const reservationKey = String(row.groupRef || row.booking_group_ref || row.ref || '');
        const slots = Array.isArray(row.slots) ? row.slots.join(',') : '';
        const key = `${reservationKey}|${row.courtId || row.court_id}|${row.date}|${slots || row.startTime || row.start_time || ''}`;
        if (!forwardLogical.has(key)) forwardLogical.set(key, { ...row, reservationKey });
      });
    const forwardRows = [...forwardLogical.values()];
    const forwardDailyMap = new Map();
    for (let day = 1; day <= 60; day += 1) {
      const date = addDays(today, day);
      let capacity = 0;
      if (!blockedDates.has(date)) courts.forEach(court => {
        const createdDate = String(court.createdAt || court.created_at || '').slice(0,10);
        if (!createdDate || createdDate <= date) capacity += closeHour - openHour;
      });
      forwardDailyMap.set(date, { date, secured_revenue:0, outstanding_balance:0, committed_booking_value:0, confirmed_reservations:0, payment_review_reservations:0, booked_hours:0, available_hours:capacity });
    }
    forwardRows.forEach(row => {
      const date = String(row.date || '').slice(0,10);
      const day = forwardDailyMap.get(date);
      if (!day) return;
      const status = String(row.status || '').toLowerCase();
      if (status === 'confirmed') {
        day.secured_revenue += paidAmount(row);
        day.committed_booking_value += Math.max(0, number(row.total));
        day.outstanding_balance += Math.max(0, number(row.total) - paidAmount(row));
        day.booked_hours += Math.max(0, number(row.duration));
      }
    });
    const forwardReservations = new Map();
    forwardRows.forEach(row => {
      if (!forwardReservations.has(row.reservationKey)) forwardReservations.set(row.reservationKey, []);
      forwardReservations.get(row.reservationKey).push(row);
    });
    forwardReservations.forEach(items => {
      const date = String(items[0]?.date || '').slice(0,10);
      const day = forwardDailyMap.get(date);
      if (!day) return;
      if (items.some(row => String(row.status || '').toLowerCase() === 'confirmed')) day.confirmed_reservations += 1;
      if (items.some(row => {
        const status = String(row.status || '').toLowerCase();
        const paymentStatus = String(row.paymentStatus || row.payment_status || '').toLowerCase();
        const receiptStatus = String(row.receiptStatus || row.receipt_status || '').toLowerCase();
        const stored = Boolean(String(row.receiptImageUrl || row.receipt_image_url || '').trim() && /^[a-f0-9]{64}$/i.test(String(row.receiptImageHash || row.receipt_image_hash || '').trim()));
        return ['pending','verifying'].includes(status) && paymentStatus === 'for_verification' && (stored || receiptStatus === 'manual_review' || row.receiptVerificationId || row.receipt_verification_id || row.hasReceiptVerification);
      })) day.payment_review_reservations += 1;
    });
    const forwardDaily = [...forwardDailyMap.values()];
    const forwardHorizons = [7,30,60].map(days => {
      const selected = forwardDaily.slice(0, days);
      const sum = field => selected.reduce((total, item) => total + number(item[field]), 0);
      const horizonAvailable = sum('available_hours');
      const horizonBooked = sum('booked_hours');
      return { days, from:addDays(today,1), to:addDays(today,days), kpis:{ secured_revenue:sum('secured_revenue'), committed_booking_value:sum('committed_booking_value'), outstanding_balance:sum('outstanding_balance'), confirmed_reservations:sum('confirmed_reservations'), payment_review_reservations:sum('payment_review_reservations'), booked_hours:horizonBooked, available_hours:horizonAvailable, booked_utilization_pct:horizonAvailable?Math.min(100,horizonBooked*100/horizonAvailable):0 } };
    });
    const trackedReservations = lifecycle.reduce((sum, item) => sum + item.count, 0);
    return {
      period: { from:rangeStart, to:rangeEnd, earliest_reliable_booking_date:earliest, generated_at:new Date().toISOString(), days_analyzed:daysAnalyzed, operating_days:operatingDays, trend_grain:trendGrain },
      settings: { open_hour:openHour, close_hour:closeHour, court_id:input.courtId || null },
      kpis: { gross_revenue:grossRevenue, collected_revenue:collectedRevenue, outstanding_balance:outstandingBalance, booked_hours:bookedHours, available_hours:availableHours, utilization_pct:availableHours?Math.min(100,bookedHours*100/availableHours):0, completed_reservations:reservations.filter(item=>item.lifecycleStatus==='completed').length, active_reservations:reservations.filter(item=>['confirmed','completed'].includes(item.lifecycleStatus)).length, payment_review_reservations:paymentReviewReservations, total_reservations:trackedReservations, revenue_per_booked_hour:bookedHours?collectedRevenue/bookedHours:0, revenue_per_available_hour:availableHours?collectedRevenue/availableHours:0, repeat_customer_rate:activeCustomers.length?activeCustomers.filter(count=>count>1).length*100/activeCustomers.length:0 },
      forward_outlook: { as_of:today, horizons:forwardHorizons, daily:forwardDaily },
      lifecycle, trend:[...trendMap.values()].sort((a,b)=>a.date.localeCompare(b.date)), heatmap, courts:courtPerformance,
      data_quality: { reliable_booking_rows:rows.length, excluded_import_rows:excludedImport, excluded_placeholder_rows:excludedHolds, historical_capacity_exact:false, capacity_basis:'local operating hours and saved court state', capacity_note:'Local demo mode estimates historical capacity from saved operating hours, court creation dates, venue block dates, and current-day court state.', pipeline_note:'Cancelled, rejected, expired, and forfeited operational records are excluded from booking pipeline and revenue-efficiency metrics. Receipt-backed payments awaiting an owner decision are counted as Needs payment review.' },
    };
  }

  return {
    number,
    confidenceFor,
    timeLabel,
    cellLabel,
    evidence,
    trendGrainForDays,
    buildRecommendations,
    buildLocalSnapshot,
  };
});
