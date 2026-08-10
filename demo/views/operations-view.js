import {
  createBooking,
  formatPeso,
  getState,
  resolvePayment,
  setCourtState,
  subscribe,
  updateBooking,
  updatePricing
} from "../data.js?v=20260803-9";

const icon = (context, name) => context.icon ? context.icon(name) : "";
const courtNumber = id => String(id || "").replace("c", "");
const paymentTone = payment => payment === "paid" ? "success" : payment === "review" || payment === "balance" ? "warning" : "neutral";
const titleCase = value => String(value || "").replace(/-/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
const rateBands = [
  { key: "offPeak", label: "Off-peak", hours: "7 AM–12 PM", tone: "mint" },
  { key: "standard", label: "Standard", hours: "12–4 PM", tone: "sky" },
  { key: "popular", label: "Popular", hours: "4–6 PM & 9–10 PM", tone: "amber" },
  { key: "prime", label: "Prime time", hours: "6–9 PM", tone: "violet" }
];

function addMinutes(time, amount) {
  const [hour, minute] = time.split(":").map(Number);
  const total = hour * 60 + minute + Number(amount);
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function timeLabel(value) {
  const [hour, minute] = value.split(":").map(Number);
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function statusPill(label, tone = "neutral") {
  return `<span class="status-pill ${tone}">${label}</span>`;
}

function sectionHeading(title, copy, action = "") {
  return `<div class="section-heading"><div><h2>${title}</h2><p>${copy}</p></div>${action}</div>`;
}

function metricCard(context, label, value, note, tone, iconId, progress = null) {
  return `
    <article class="op-metric-card ${tone}">
      <div class="op-metric-top"><span>${label}</span><i>${icon(context, iconId)}</i></div>
      <strong>${value}</strong>
      <p>${note}</p>
      ${progress === null ? "" : `<div class="op-progress" aria-label="${label}: ${progress}%"><span style="width:${progress}%"></span></div>`}
    </article>`;
}

function disruptionMarkup(context, state) {
  const court = state.courts.find(item => item.id === "c3");
  const affected = state.bookings.find(item => item.id === "BK-2406");
  const isMaintenance = court?.state === "maintenance";
  const wasMoved = affected?.court !== "c3";

  if (isMaintenance && wasMoved) {
    return `
      <aside class="op-disruption resolved" aria-label="Resolved court disruption">
        <div class="op-disruption-icon">${icon(context, "i-check")}</div>
        <div><span class="op-kicker">Disruption resolved</span><h3>Court 3 is blocked and Open Play moved to Court 2</h3><p>Players keep the same 6:00 PM start. The front desk board and player-facing availability are synchronized.</p></div>
        <button class="button secondary" data-op-action="restore-court">Undo change</button>
      </aside>`;
  }

  if (isMaintenance) {
    return `
      <aside class="op-disruption" aria-label="Court disruption preview">
        <div class="op-disruption-icon">${icon(context, "i-refresh")}</div>
        <div class="op-disruption-main">
          <span class="op-kicker">Action needed · Court 3 maintenance</span>
          <h3>Move Beginner Open Play before 6:00 PM</h3>
          <p>A surface inspection affects one booking and 18 players. RallyOS found the cleanest available move.</p>
          <div class="op-move-preview">
            <span><small>Current</small><strong>Court 3 · 6:00–8:00 PM</strong></span>
            <b>${icon(context, "i-arrow")}</b>
            <span><small>Recommended</small><strong>Court 2 · Same time</strong></span>
            <em>No conflicts</em>
          </div>
        </div>
        <div class="op-disruption-actions">
          <button class="button primary" data-op-action="approve-disruption">Approve move</button>
          <button class="button ghost" data-op-action="undo-disruption">Keep Court 3 open</button>
        </div>
      </aside>`;
  }

  return "";
}

function renderToday(context) {
  const state = getState();
  const court3 = state.courts.find(item => item.id === "c3");
  const isDisrupted = court3?.state === "maintenance";
  const courtDetails = {
    c1: { state: "Available", note: "Next: Nica Flores at 8:00 PM", tone: "success", utilization: "6.5h booked" },
    c2: { state: "Turnover", note: "Reset finishes in 8 min", tone: "warning", utilization: "7h booked" },
    c3: isDisrupted
      ? { state: "Maintenance", note: "Surface inspection in progress", tone: "danger", utilization: "Unavailable" }
      : { state: "Ready", note: "Open Play begins at 6:00 PM", tone: "info", utilization: "8h booked" },
    c4: { state: "Available", note: "Next: Luis Tan at 6:30 PM", tone: "success", utilization: "5.5h booked" }
  };

  const reviews = state.paymentReviews.length;
  return `
    <div class="op-view op-today-view">
      <section class="op-hero">
        <div>
          <span class="op-kicker">Friday · 5:38 PM · Uptown</span>
          <h2>The club is moving well.</h2>
          <p>Peak hours start soon. Two items need a quick decision before the evening rush.</p>
        </div>
        <div class="op-hero-actions">
          <button class="button secondary" data-op-action="start-disruption">${icon(context, "i-settings")} Court issue</button>
          <button class="button primary" data-op-action="new-booking">${icon(context, "i-plus")} New booking</button>
        </div>
      </section>

      <section class="op-metrics" aria-label="Today's key metrics">
        ${metricCard(context, "Net sales", formatPeso(state.metrics.revenue), "+12% from last Friday", "revenue", "i-wallet")}
        ${metricCard(context, "Occupancy", `${state.metrics.occupancy}%`, "Prime time is 92% reserved", "occupancy", "i-chart", state.metrics.occupancy)}
        ${metricCard(context, "Bookings", state.metrics.bookings, `${state.metrics.arrivals} arrivals checked in`, "bookings", "i-calendar")}
        ${metricCard(context, "Payment review", reviews, reviews ? `${formatPeso(state.paymentReviews.reduce((sum, item) => sum + item.amount, 0))} awaiting approval` : "Everything is reconciled", "payments", "i-check")}
      </section>

      ${disruptionMarkup(context, state)}

      <div class="op-dashboard-grid">
        <section class="surface-card op-courts-panel">
          ${sectionHeading("Live court status", "A fast read on every playing surface", `<button class="op-link-button" data-op-nav="schedule">Open full schedule ${icon(context, "i-arrow")}</button>`)}
          <div class="op-court-grid">
            ${state.courts.map(court => {
              const detail = courtDetails[court.id];
              return `<article class="op-court-card ${detail.tone}">
                <div class="op-court-visual"><span>${courtNumber(court.id)}</span><i></i><i></i></div>
                <div class="op-court-copy"><span>${court.type} · ${court.surface}</span><h3>${court.name}</h3><p>${detail.note}</p></div>
                <div class="op-court-state">${statusPill(detail.state, detail.tone)}<small>${detail.utilization}</small></div>
              </article>`;
            }).join("")}
          </div>
        </section>

        <aside class="surface-card op-arrivals-panel">
          ${sectionHeading("Next arrivals", "The next 150 minutes", `<span class="op-live-mark"><i></i> Live</span>`)}
          <div class="op-arrival-list">
            ${state.arrivals.map((arrival, index) => `<div class="op-arrival">
              <div class="op-time-rail"><strong>${arrival.time}</strong><i class="${arrival.tone}"></i>${index < state.arrivals.length - 1 ? "<span></span>" : ""}</div>
              <div><strong>${arrival.name}</strong><p>${arrival.court}</p></div>
              ${statusPill(arrival.state, arrival.tone)}
            </div>`).join("")}
          </div>
          <button class="button secondary op-wide-button" data-op-nav="schedule">Manage arrivals</button>
        </aside>
      </div>

      <div class="op-lower-grid">
        <section class="surface-card op-attention-panel">
          ${sectionHeading("Needs attention", "Clear these before the evening rush")}
          <button class="op-attention-row" data-op-nav="money">
            <i class="warning">${icon(context, "i-wallet")}</i><span><strong>${reviews || "No"} payment${reviews === 1 ? "" : "s"} to review</strong><small>${reviews ? "Proof uploaded · highest confidence 94%" : "All uploaded proofs have been resolved"}</small></span>${icon(context, "i-arrow")}
          </button>
          <button class="op-attention-row" data-op-action="start-disruption">
            <i class="info">${icon(context, "i-settings")}</i><span><strong>Run Court 3 disruption demo</strong><small>Preview an affected booking and recover with one decision</small></span>${icon(context, "i-arrow")}
          </button>
        </section>
        <section class="op-quick-card">
          <div><span class="op-kicker">Front desk shortcuts</span><h2>Keep the queue moving.</h2><p>Common actions are one tap away and stay synchronized across the team.</p></div>
          <div class="op-quick-actions">
            <button data-op-action="new-booking">${icon(context, "i-plus")}<span><strong>Add booking</strong><small>Walk-in or phone</small></span></button>
            <button data-op-nav="customers">${icon(context, "i-users")}<span><strong>Find player</strong><small>Visits and notes</small></span></button>
            <button data-op-nav="money">${icon(context, "i-wallet")}<span><strong>Review payments</strong><small>${reviews} waiting</small></span></button>
          </div>
        </section>
      </div>
    </div>`;
}

function scheduleDate(offset) {
  const date = new Date(2026, 7, 7 + offset);
  return new Intl.DateTimeFormat("en-PH", { weekday: "long", month: "short", day: "numeric" }).format(date);
}

function scheduleBlock(booking) {
  const [startHour, startMinute] = booking.start.split(":").map(Number);
  const [endHour, endMinute] = booking.end.split(":").map(Number);
  const start = Math.max(0, Math.round(((startHour * 60 + startMinute) - 8 * 60) / 30));
  const duration = Math.max(1, Math.round(((endHour * 60 + endMinute) - (startHour * 60 + startMinute)) / 30));
  const tone = booking.status === "checked-in" ? "playing" : booking.status === "open-play" ? "program" : booking.payment === "review" ? "review" : "reserved";
  return `<button class="op-booking-block ${tone}" style="--slot:${start + 2};--span:${duration}" data-booking-id="${booking.id}" aria-label="${booking.guest}, ${timeLabel(booking.start)} to ${timeLabel(booking.end)}">
    <strong>${booking.guest}</strong><span>${timeLabel(booking.start).replace(":00", "")}–${timeLabel(booking.end).replace(":00", "")}</span>
  </button>`;
}

function renderSchedule(context, local) {
  const state = getState();
  const court3 = state.courts.find(item => item.id === "c3");
  const slots = Array.from({ length: 15 }, (_, index) => index + 8);
  const isToday = local.scheduleOffset === 0;
  return `
    <div class="op-view op-schedule-view">
      <section class="op-toolbar">
        <div class="op-date-control">
          <button class="icon-button" data-op-action="previous-day" aria-label="Previous day">${icon(context, "i-arrow")}</button>
          <button class="op-date-label" data-op-action="today-date"><span>${isToday ? "Today" : "Selected day"}</span><strong>${scheduleDate(local.scheduleOffset)}</strong></button>
          <button class="icon-button" data-op-action="next-day" aria-label="Next day">${icon(context, "i-arrow")}</button>
        </div>
        <div class="op-toolbar-actions">
          <div class="op-segmented" aria-label="Schedule view"><button class="active">Courts</button><button data-op-action="agenda-view">Agenda</button></div>
          <button class="button secondary" data-op-action="start-disruption">${icon(context, "i-settings")} Court issue</button>
          <button class="button primary" data-op-action="new-booking">${icon(context, "i-plus")} New booking</button>
        </div>
      </section>

      ${disruptionMarkup(context, state)}

      <section class="surface-card op-schedule-board" aria-label="Court schedule for ${scheduleDate(local.scheduleOffset)}">
        <div class="op-board-meta">
          <div><span class="op-live-mark"><i></i> Live coverage</span><strong>8:00 AM–10:00 PM</strong></div>
          <div class="op-schedule-legend"><span><i class="playing"></i>Checked in</span><span><i class="reserved"></i>Confirmed</span><span><i class="program"></i>Program</span><span><i class="review"></i>Review</span></div>
        </div>
        <div class="op-board-scroll" tabindex="0" aria-label="Scroll horizontally through court times">
          <div class="op-time-header">
            <span>COURT</span>${slots.map(hour => `<time style="--time-col:${(hour - 8) * 2 + 2}">${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}</time>`).join("")}
          </div>
          ${state.courts.map(court => `<div class="op-schedule-row ${court.state === "maintenance" ? "maintenance" : ""}">
            <div class="op-row-court"><span>${courtNumber(court.id)}</span><div><strong>${court.name}</strong><small>${court.type}</small></div></div>
            ${state.bookings.filter(booking => booking.court === court.id).map(scheduleBlock).join("")}
            ${court.state === "maintenance" ? `<div class="op-maintenance-band"><strong>Maintenance hold</strong><span>Surface inspection</span></div>` : ""}
          </div>`).join("")}
        </div>
        <div class="op-board-footer"><span><i></i> Current time · 5:38 PM</span><p>Click a reservation to preview booking details</p></div>
      </section>

      <section class="op-schedule-summary">
        <article><span>Booked court hours</span><strong>27h 30m</strong><small>78% of inventory</small></article>
        <article><span>Prime-time yield</span><strong>${formatPeso(6720)}</strong><small>4:00–9:00 PM</small></article>
        <article><span>Open inventory</span><strong>7 slots</strong><small>Best opening: 1:30 PM</small></article>
        <button data-op-action="new-booking"><span>${icon(context, "i-plus")}</span><strong>Fill an open slot</strong><small>Create a booking in under a minute</small></button>
      </section>
    </div>`;
}

const customerSeeds = [
  { name: "Mia Santos", initials: "MS", visits: 24, value: 16840, last: "Today, 9:00 AM", level: "3.5", tag: "Member" },
  { name: "Paolo Reyes", initials: "PR", visits: 18, value: 11320, last: "Today, 10:00 AM", level: "3.0", tag: "Regular" },
  { name: "Ana Lim", initials: "AL", visits: 12, value: 8920, last: "Today, 12:00 PM", level: "3.5", tag: "Member" },
  { name: "Kaye Dizon", initials: "KD", visits: 9, value: 6780, last: "Today, 4:00 PM", level: "2.5", tag: "New regular" },
  { name: "Luis Tan", initials: "LT", visits: 16, value: 12480, last: "Today, 6:30 PM", level: "4.0", tag: "League" },
  { name: "Nica Flores", initials: "NF", visits: 7, value: 5260, last: "Today, 8:00 PM", level: "3.0", tag: "Regular" }
];

function renderCustomers(context, local) {
  const selected = customerSeeds.find(item => item.name === local.selectedCustomer) || customerSeeds[0];
  return `
    <div class="op-view op-customers-view">
      <section class="op-toolbar op-customer-toolbar">
        <label class="op-view-search">${icon(context, "i-search")}<span class="sr-only">Search customers</span><input type="search" data-customer-search placeholder="Search name, phone or note"></label>
        <div class="op-toolbar-actions"><button class="button secondary" data-op-action="customer-filter">All segments ${icon(context, "i-arrow")}</button><button class="button primary" data-op-action="add-customer">${icon(context, "i-plus")} Add customer</button></div>
      </section>
      <section class="op-customer-stats">
        <article><span>Active customers</span><strong>1,284</strong><small><b>+6.8%</b> this month</small></article>
        <article><span>Returning players</span><strong>64%</strong><small>Up 4 points</small></article>
        <article><span>Average guest value</span><strong>${formatPeso(1840)}</strong><small>Last 90 days</small></article>
      </section>
      <div class="op-customers-layout">
        <section class="surface-card op-customer-list">
          <div class="op-list-heading"><div><strong>Customer directory</strong><span data-customer-count>${customerSeeds.length} people</span></div><button class="icon-button" aria-label="Customer list options">${icon(context, "i-settings")}</button></div>
          <div class="op-table-wrap">
            <table>
              <thead><tr><th>Customer</th><th>Visits</th><th>Lifetime value</th><th>Last activity</th><th></th></tr></thead>
              <tbody>${customerSeeds.map((customer, index) => `<tr data-customer-row="${customer.name.toLowerCase()}" class="${customer.name === selected.name ? "selected" : ""}">
                <td><button class="op-customer-name" data-select-customer="${customer.name}"><span class="op-avatar tone-${index % 4}">${customer.initials}</span><span><strong>${customer.name}</strong><small>${customer.tag} · Level ${customer.level}</small></span></button></td>
                <td>${customer.visits}</td><td>${formatPeso(customer.value)}</td><td>${customer.last}</td><td>${icon(context, "i-arrow")}</td>
              </tr>`).join("")}</tbody>
            </table>
          </div>
          <div class="op-empty-search" hidden>No customers match that search.</div>
        </section>
        <aside class="surface-card op-customer-profile">
          <div class="op-profile-top"><span class="op-avatar large">${selected.initials}</span><div><span class="op-kicker">Customer profile</span><h2>${selected.name}</h2><p>${selected.tag} · Level ${selected.level}</p></div><button class="icon-button" aria-label="More profile options">${icon(context, "i-settings")}</button></div>
          <div class="op-contact-row"><span><small>Mobile</small><strong>+63 917 284 09${selected.visits}</strong></span><span><small>Preferred contact</small><strong>Messenger</strong></span></div>
          <div class="op-profile-value"><span><small>Lifetime value</small><strong>${formatPeso(selected.value)}</strong></span><span><small>Total visits</small><strong>${selected.visits}</strong></span></div>
          <div class="op-profile-notes"><span>Front desk note</span><p>Prefers indoor courts and evening doubles. Offer the Friday social when space opens.</p></div>
          <button class="button primary op-wide-button" data-op-action="book-for-customer">${icon(context, "i-calendar")} Book for ${selected.name.split(" ")[0]}</button>
          <button class="button secondary op-wide-button" data-op-action="message-customer">Message customer</button>
        </aside>
      </div>
    </div>`;
}

function renderMoney(context, local) {
  const state = getState();
  const settled = state.metrics.revenue - state.paymentReviews.reduce((sum, item) => sum + item.amount, 0);
  return `
    <div class="op-view op-money-view">
      <section class="op-money-hero">
        <div><span class="op-kicker">Daily settlement</span><h2>${formatPeso(state.metrics.revenue)}</h2><p>Gross payments recorded today</p></div>
        <div class="op-settlement-progress"><div><span>Reconciled</span><strong>${formatPeso(settled)}</strong></div><div class="op-progress"><span style="width:${state.paymentReviews.length ? 93 : 100}%"></span></div><small>${state.paymentReviews.length ? `${state.paymentReviews.length} uploads need a human check` : "All payments are reconciled"}</small></div>
        <button class="button secondary" data-op-action="export-money">Export daily report</button>
      </section>
      <section class="op-money-stats">
        <article><i>${icon(context, "i-check")}</i><span><small>Collected</small><strong>${formatPeso(17140)}</strong></span><em>93.1%</em></article>
        <article><i>${icon(context, "i-clock")}</i><span><small>Pending review</small><strong>${formatPeso(state.paymentReviews.reduce((sum, item) => sum + item.amount, 0))}</strong></span><em>${state.paymentReviews.length} proof${state.paymentReviews.length === 1 ? "" : "s"}</em></article>
        <article><i>${icon(context, "i-wallet")}</i><span><small>Outstanding</small><strong>${formatPeso(1080)}</strong></span><em>1 balance</em></article>
      </section>

      <section class="op-review-section">
        ${sectionHeading("Payment review", "Verify uploaded proof before it reaches the settled total", `<span class="op-count-badge">${state.paymentReviews.length} waiting</span>`)}
        ${state.paymentReviews.length ? `<div class="op-review-grid">${state.paymentReviews.map((review, index) => `<article class="surface-card op-review-card ${local.expandedPayment === review.id ? "expanded" : ""}">
          <div class="op-review-head"><div class="op-proof-mark">${review.provider.slice(0, 1)}</div><div><span>${review.provider} proof · ${review.time}</span><h3>${review.guest}</h3><p>${review.id} · Ref ${review.ref}</p></div><strong>${formatPeso(review.amount)}</strong></div>
          <div class="op-evidence">
            <div class="op-confidence"><span><strong>${review.confidence}%</strong> match confidence</span><div><i style="width:${review.confidence}%"></i></div></div>
            <ul><li class="pass">${icon(context, "i-check")} Amount matches expected booking</li><li class="pass">${icon(context, "i-check")} ${review.reason}</li><li class="${index ? "review" : "pass"}">${icon(context, index ? "i-clock" : "i-check")} ${index ? "Bank timestamp needs a quick visual check" : "Reference has not been used before"}</li></ul>
          </div>
          <div class="op-review-actions"><button class="button ghost" data-op-action="inspect-payment" data-payment-id="${review.id}">${local.expandedPayment === review.id ? "Hide proof" : "Inspect proof"}</button><button class="button primary" data-op-action="approve-payment" data-payment-id="${review.id}">${icon(context, "i-check")} Approve ${formatPeso(review.amount)}</button></div>
          ${local.expandedPayment === review.id ? `<div class="op-proof-preview"><div><span>TRANSFER RECEIPT</span><strong>${review.provider}</strong></div><p>Amount sent</p><h4>${formatPeso(review.amount)}</h4><dl><div><dt>Reference</dt><dd>${review.ref}</dd></div><div><dt>Recipient</dt><dd>Horizon Pickle Club</dd></div><div><dt>Timestamp</dt><dd>${review.time}</dd></div></dl><small>Demo proof · No real financial data</small></div>` : ""}
        </article>`).join("")}</div>` : `<div class="surface-card op-review-empty"><i>${icon(context, "i-check")}</i><h3>Review queue cleared</h3><p>Every uploaded payment proof has been verified and added to today's settlement.</p></div>`}
      </section>

      <section class="surface-card op-transactions">
        ${sectionHeading("Recent transactions", "A unified ledger across payment methods", `<button class="op-link-button" data-op-action="view-ledger">View full ledger ${icon(context, "i-arrow")}</button>`)}
        <div class="op-table-wrap"><table><thead><tr><th>Customer</th><th>Booking</th><th>Method</th><th>Status</th><th>Amount</th></tr></thead><tbody>
          ${state.bookings.slice(0, 6).map(booking => `<tr><td><strong>${booking.guest}</strong><small>${booking.source}</small></td><td>${booking.id}<small>${timeLabel(booking.start)}</small></td><td>${booking.payment === "review" ? "GCash upload" : booking.payment === "mixed" ? "Mixed collection" : "Online payment"}</td><td>${statusPill(titleCase(booking.payment), paymentTone(booking.payment))}</td><td><strong>${formatPeso(booking.amount)}</strong></td></tr>`).join("")}
        </tbody></table></div>
      </section>
    </div>`;
}

function renderVenue(context) {
  const state = getState();
  return `
    <div class="op-view op-venue-view">
      <section class="op-venue-banner">
        <div class="op-venue-mark">${state.venue.initials}</div><div><span class="op-kicker">Live workspace</span><h2>${state.venue.name}</h2><p>${state.venue.location} · ${state.venue.phone}</p></div><button class="button secondary" data-op-action="open-branding">Edit venue profile</button>
      </section>
      <div class="op-settings-layout">
        <nav class="surface-card op-settings-nav" aria-label="Venue settings sections">
          <button type="button" class="active" data-op-action="focus-settings" data-settings-target="courts">${icon(context, "i-grid")} Venue overview</button><button type="button" data-op-action="focus-settings" data-settings-target="pricing">${icon(context, "i-calendar")} Pricing & rules</button><button type="button" data-op-action="open-settings-payments">${icon(context, "i-wallet")} Payments</button><button type="button" data-op-action="team-settings">${icon(context, "i-users")} Team access</button><button type="button" data-op-action="notification-settings">${icon(context, "i-settings")} Notifications</button>
        </nav>
        <div class="op-settings-main">
          <section class="surface-card op-settings-card" data-settings-panel="courts" tabindex="-1">
            ${sectionHeading("Courts", "Manage inventory, surfaces and live availability", `<button class="button secondary" data-op-action="add-court">${icon(context, "i-plus")} Add court</button>`)}
            <div class="op-venue-courts">${state.courts.map(court => `<div><span class="op-court-number">${courtNumber(court.id)}</span><span><strong>${court.name}</strong><small>${court.type} · ${court.surface}</small></span>${statusPill(court.state === "maintenance" ? "Maintenance" : "Taking bookings", court.state === "maintenance" ? "danger" : "success")}<button class="icon-button" aria-label="Configure ${court.name}">${icon(context, "i-arrow")}</button></div>`).join("")}</div>
          </section>
          <section class="surface-card op-settings-card op-pricing-card" data-settings-panel="pricing" tabindex="-1">
            <form data-pricing-form>
              ${sectionHeading("Hourly court pricing", "Set what players pay for each court and hourly time band", `<span class="op-live-setting"><i></i> Live on booking page</span>`)}
              <div class="op-rate-grid">
                ${rateBands.map(band => `<label class="op-rate-card ${band.tone}"><span class="op-rate-name"><i aria-hidden="true"></i><span><strong>${band.label}</strong><small>${band.hours}</small></span></span><span class="op-rate-input"><b aria-hidden="true">&#8369;</b><input type="number" name="${band.key}" value="${Number(state.venue.hourlyRates?.[band.key] || 0)}" min="100" max="10000" step="10" inputmode="numeric" required aria-label="${band.label} hourly court rate"><em>/ hour</em></span></label>`).join("")}
              </div>
              <div class="op-pricing-footer"><span>${icon(context, "i-check")}<span><strong>Charged per selected court</strong><small>Three courts for three hours are billed as nine hourly slots.</small></span></span><button class="button primary" type="submit">Save pricing</button></div>
            </form>
          </section>
          <section class="surface-card op-settings-card">
            ${sectionHeading("Operating hours", "Customer-facing availability for a standard week")}
            <div class="op-hours-list"><div><strong>Monday–Thursday</strong><span>7:00 AM</span><i>to</i><span>10:00 PM</span></div><div><strong>Friday</strong><span>7:00 AM</span><i>to</i><span>11:00 PM</span></div><div><strong>Saturday–Sunday</strong><span>6:00 AM</span><i>to</i><span>11:00 PM</span></div></div>
            <button class="op-link-button" data-op-action="edit-hours">Edit regular and holiday hours ${icon(context, "i-arrow")}</button>
          </section>
          <section class="surface-card op-settings-card">
            ${sectionHeading("Booking experience", "Small rules that shape the guest journey")}
            <div class="op-toggle-list"><label><span><strong>Instant confirmation</strong><small>Confirm when online payment succeeds</small></span><input type="checkbox" checked data-setting="Instant confirmation"><i></i></label><label><span><strong>Waitlist</strong><small>Offer released slots to interested players</small></span><input type="checkbox" checked data-setting="Waitlist"><i></i></label><label><span><strong>Require player level</strong><small>Ask for level on Open Play registration</small></span><input type="checkbox" data-setting="Player level"><i></i></label></div>
          </section>
        </div>
        <aside class="surface-card op-venue-health">
          <span class="op-kicker">Setup health</span><strong>92%</strong><div class="op-progress"><span style="width:92%"></span></div><p>Your venue is ready to accept bookings. Two optional details can improve conversion.</p><ul><li>${icon(context, "i-check")} Courts and pricing</li><li>${icon(context, "i-check")} Payments connected</li><li class="open">${icon(context, "i-plus")} Add venue photos</li><li class="open">${icon(context, "i-plus")} Publish house rules</li></ul><button class="button primary op-wide-button" data-op-action="preview-booking">Preview booking page</button>
        </aside>
      </div>
    </div>`;
}

function modalMarkup(context, local) {
  if (local.modal === "booking") {
    const state = getState();
    return `<div class="op-modal" role="dialog" aria-modal="true" aria-labelledby="opBookingTitle" data-modal-backdrop>
      <form class="op-modal-card" data-booking-form>
        <div class="dialog-header"><div><p class="eyebrow">Front desk</p><h2 id="opBookingTitle">Create a new booking</h2></div><button type="button" class="icon-button" data-op-action="close-modal" aria-label="Close">${icon(context, "i-x")}</button></div>
        <div class="op-form-grid">
          <label class="field full"><span>Guest name</span><input name="guest" required autocomplete="name" placeholder="Full name" autofocus></label>
          <label class="field"><span>Court</span><select name="court">${state.courts.filter(court => court.state !== "maintenance").map(court => `<option value="${court.id}">${court.name} · ${court.type}</option>`).join("")}</select></label>
          <label class="field"><span>Start time</span><select name="start"><option>09:00</option><option>11:00</option><option>13:30</option><option>17:00</option><option>20:00</option></select></label>
          <label class="field"><span>Duration</span><select name="duration"><option value="60">1 hour</option><option value="90">1.5 hours</option><option value="120">2 hours</option></select></label>
          <label class="field"><span>Hourly rate</span><select name="amount">${rateBands.map(band => `<option value="${state.venue.hourlyRates[band.key]}">${band.label} · ${formatPeso(state.venue.hourlyRates[band.key])}</option>`).join("")}</select></label>
          <label class="field full"><span>Front desk note <small>Optional</small></span><input name="note" placeholder="Equipment rental, arrival note…"></label>
        </div>
        <div class="op-form-assurance">${icon(context, "i-check")} This demo booking will appear instantly on the court board.</div>
        <div class="dialog-actions"><button type="button" class="button secondary" data-op-action="close-modal">Cancel</button><button class="button primary" type="submit">Create booking</button></div>
      </form>
    </div>`;
  }

  if (local.modal === "booking-detail" && local.selectedBooking) {
    const booking = getState().bookings.find(item => item.id === local.selectedBooking);
    if (!booking) return "";
    return `<div class="op-modal" role="dialog" aria-modal="true" aria-labelledby="opDetailTitle" data-modal-backdrop><div class="op-modal-card op-booking-detail">
      <div class="dialog-header"><div><p class="eyebrow">${booking.id}</p><h2 id="opDetailTitle">${booking.guest}</h2></div><button class="icon-button" data-op-action="close-modal" aria-label="Close">${icon(context, "i-x")}</button></div>
      <div class="op-detail-hero"><span class="op-avatar">${booking.initials}</span><div><strong>${booking.label}</strong><p>Court ${courtNumber(booking.court)} · ${timeLabel(booking.start)}–${timeLabel(booking.end)}</p></div>${statusPill(titleCase(booking.status), booking.status === "checked-in" ? "success" : "info")}</div>
      <dl class="op-detail-list"><div><dt>Payment</dt><dd>${titleCase(booking.payment)} · ${formatPeso(booking.amount)}</dd></div><div><dt>Source</dt><dd>${booking.source}</dd></div><div><dt>Contact</dt><dd>+63 917 555 0128</dd></div></dl>
      <div class="dialog-actions"><button class="button secondary" data-op-action="close-modal">Close</button><button class="button primary" data-op-action="check-in-booking" data-booking-id="${booking.id}">${icon(context, "i-check")} Check in</button></div>
    </div></div>`;
  }
  return "";
}

export function renderOperationsView(root, context) {
  const local = { scheduleOffset: 0, modal: null, selectedBooking: null, selectedCustomer: "Mia Santos", expandedPayment: null };
  let disposed = false;

  function draw() {
    if (disposed) return;
    const renderers = {
      today: () => renderToday(context),
      schedule: () => renderSchedule(context, local),
      customers: () => renderCustomers(context, local),
      money: () => renderMoney(context, local),
      venue: () => renderVenue(context)
    };
    root.innerHTML = (renderers[context.view] || renderers.today)() + modalMarkup(context, local);
  }

  function openBooking(prefillName = "") {
    local.modal = "booking";
    draw();
    const input = root.querySelector("[name='guest']");
    if (input && prefillName) input.value = prefillName;
    window.setTimeout(() => input?.focus(), 0);
  }

  function closeModal() {
    local.modal = null;
    local.selectedBooking = null;
    draw();
  }

  function onClick(event) {
    const nav = event.target.closest("[data-op-nav]");
    if (nav) { context.navigate(nav.dataset.opNav); return; }

    if (event.target.matches("[data-modal-backdrop]")) { closeModal(); return; }

    const customer = event.target.closest("[data-select-customer]");
    if (customer) { local.selectedCustomer = customer.dataset.selectCustomer; draw(); return; }

    const booking = event.target.closest("[data-booking-id]");
    const actionElement = event.target.closest("[data-op-action]");
    if (booking && !actionElement) {
      local.selectedBooking = booking.dataset.bookingId;
      local.modal = "booking-detail";
      draw();
      return;
    }

    if (!actionElement) return;
    const action = actionElement.dataset.opAction;
    if (action === "new-booking") openBooking();
    else if (action === "close-modal") closeModal();
    else if (action === "previous-day") { local.scheduleOffset -= 1; draw(); }
    else if (action === "next-day") { local.scheduleOffset += 1; draw(); }
    else if (action === "today-date") { local.scheduleOffset = 0; draw(); }
    else if (action === "start-disruption") {
      setCourtState("c3", "maintenance");
      context.notify("Court 3 marked unavailable", "One affected booking is ready for review before anything moves.");
    } else if (action === "undo-disruption") {
      setCourtState("c3", "ready");
      context.notify("Court 3 restored", "The proposed booking move was discarded.");
    } else if (action === "approve-disruption") {
      setCourtState("c3", "maintenance");
      updateBooking("BK-2406", { court: "c2", label: "Moved from Court 3 · 18 / 20 players" });
      context.notify("Move approved", "Beginner Open Play is now on Court 2 at the same time. Court 3 remains blocked.");
    } else if (action === "restore-court") {
      updateBooking("BK-2406", { court: "c3", label: "18 / 20 players" });
      setCourtState("c3", "ready");
      context.notify("Court plan restored", "Open Play is back on Court 3 and the maintenance hold is removed.");
    } else if (action === "approve-payment") {
      const resolved = resolvePayment(actionElement.dataset.paymentId, "approved");
      if (resolved) context.notify("Payment approved", `${resolved.guest}'s ${formatPeso(resolved.amount)} payment is now reconciled.`);
    } else if (action === "inspect-payment") {
      local.expandedPayment = local.expandedPayment === actionElement.dataset.paymentId ? null : actionElement.dataset.paymentId;
      draw();
    } else if (action === "check-in-booking") {
      local.modal = null;
      local.selectedBooking = null;
      updateBooking(actionElement.dataset.bookingId, { status: "checked-in" });
      context.notify("Guest checked in", "The live court board has been updated.");
    } else if (action === "book-for-customer") openBooking(local.selectedCustomer);
    else if (action === "open-branding") document.querySelector("[data-action='brand-preview']")?.click();
    else if (action === "focus-settings") {
      const targetName = actionElement.dataset.settingsTarget;
      root.querySelectorAll(".op-settings-nav [data-settings-target]").forEach(button => button.classList.toggle("active", button === actionElement));
      const panel = root.querySelector(`[data-settings-panel="${targetName}"]`);
      panel?.scrollIntoView({ behavior: "smooth", block: "start" });
      panel?.focus({ preventScroll: true });
    } else if (action === "open-settings-payments") context.navigate("money");
    else if (action === "team-settings") context.notify("Team access ready", "Invite managers and staff, then control what each role can view or change.");
    else if (action === "notification-settings") context.notify("Notification settings ready", "Choose which booking, payment and court alerts reach your team.");
    else if (["agenda-view", "customer-filter", "add-customer", "message-customer", "export-money", "view-ledger", "add-court", "edit-hours", "preview-booking"].includes(action)) {
      const messages = {
        "agenda-view": ["Agenda view preview", "The timeline stays selected in this showroom."],
        "customer-filter": ["Segments ready", "Filter by members, regulars, league players or new guests."],
        "add-customer": ["Customer form ready", "A live system would collect contact and consent details here."],
        "message-customer": ["Message drafted", `A booking follow-up for ${local.selectedCustomer} is ready to review.`],
        "export-money": ["Report prepared", "Today's settlement summary is ready for export."],
        "view-ledger": ["Ledger preview", "All payment methods reconcile into one searchable timeline."],
        "add-court": ["Court setup ready", "Add surface, hours and rate rules in one guided flow."],
        "edit-hours": ["Hours editor ready", "Regular and holiday availability can be managed together."],
        "preview-booking": ["Player preview ready", "Switch to the Player persona to see the live booking journey."]
      };
      context.notify(...messages[action]);
    }
  }

  function onSubmit(event) {
    if (event.target.matches("[data-pricing-form]")) {
      event.preventDefault();
      const form = new FormData(event.target);
      try {
        updatePricing(Object.fromEntries(rateBands.map(band => [band.key, form.get(band.key)])));
        context.notify("Hourly pricing saved", "The player booking page and checkout now use these rates.");
      } catch (error) {
        context.notify("Pricing was not saved", error.message || "Review each hourly rate and try again.");
      }
      return;
    }
    if (!event.target.matches("[data-booking-form]")) return;
    event.preventDefault();
    const form = new FormData(event.target);
    local.modal = null;
    const duration = Number(form.get("duration"));
    const booking = createBooking({
      guest: String(form.get("guest")).trim(),
      court: form.get("court"),
      start: form.get("start"),
      end: addMinutes(form.get("start"), duration),
      label: form.get("note") || "Front desk booking",
      amount: Number(form.get("amount")) * duration / 60
    });
    context.notify("Booking created", `${booking.guest} is confirmed on Court ${courtNumber(booking.court)} at ${timeLabel(booking.start)}.`);
  }

  function onInput(event) {
    if (!event.target.matches("[data-customer-search]")) return;
    const query = event.target.value.trim().toLowerCase();
    const rows = [...root.querySelectorAll("[data-customer-row]")];
    let visible = 0;
    rows.forEach(row => {
      const match = row.dataset.customerRow.includes(query);
      row.hidden = !match;
      if (match) visible += 1;
    });
    const count = root.querySelector("[data-customer-count]");
    if (count) count.textContent = `${visible} ${visible === 1 ? "person" : "people"}`;
    const empty = root.querySelector(".op-empty-search");
    if (empty) empty.hidden = visible !== 0;
  }

  function onChange(event) {
    if (!event.target.matches("[data-setting]")) return;
    context.notify(`${event.target.dataset.setting} ${event.target.checked ? "enabled" : "disabled"}`, "The demo setting has been updated for this preview.");
  }

  function onKeydown(event) {
    if (event.key === "Escape" && local.modal) closeModal();
  }

  root.addEventListener("click", onClick);
  root.addEventListener("submit", onSubmit);
  root.addEventListener("input", onInput);
  root.addEventListener("change", onChange);
  document.addEventListener("keydown", onKeydown);
  const unsubscribe = subscribe(() => draw());
  draw();

  return () => {
    disposed = true;
    unsubscribe();
    root.removeEventListener("click", onClick);
    root.removeEventListener("submit", onSubmit);
    root.removeEventListener("input", onInput);
    root.removeEventListener("change", onChange);
    document.removeEventListener("keydown", onKeydown);
  };
}
