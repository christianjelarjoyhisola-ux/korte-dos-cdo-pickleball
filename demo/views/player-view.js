import { addOpenPlayPlayer, createBookingGroup, formatPeso, getCourt, getState } from "../data.js?v=20260803-9";

const timeSlots = [
  { value: "07:00", label: "7 AM–8 AM", note: "Quiet hours", price: 480 },
  { value: "08:00", label: "8 AM–9 AM", note: "Best value", price: 480 },
  { value: "09:00", label: "9 AM–10 AM", note: "Best value", price: 480 },
  { value: "10:00", label: "10 AM–11 AM", note: "Open", price: 480 },
  { value: "11:00", label: "11 AM–12 PM", note: "Open", price: 480 },
  { value: "12:00", label: "12 PM–1 PM", note: "Open", price: 520 },
  { value: "13:00", label: "1 PM–2 PM", note: "Open", price: 520 },
  { value: "14:00", label: "2 PM–3 PM", note: "Open", price: 520 },
  { value: "15:00", label: "3 PM–4 PM", note: "Open", price: 520 },
  { value: "16:00", label: "4 PM–5 PM", note: "Popular", price: 600 },
  { value: "17:00", label: "5 PM–6 PM", note: "Popular", price: 600 },
  { value: "18:00", label: "6 PM–7 PM", note: "Prime time", price: 720 },
  { value: "19:00", label: "7 PM–8 PM", note: "Prime time", price: 720 },
  { value: "20:00", label: "8 PM–9 PM", note: "Prime time", price: 720 },
  { value: "21:00", label: "9 PM–10 PM", note: "Late play", price: 600 }
];

const addOns = [
  { id: "paddles", name: "Premium paddle pair", note: "Fresh grips, ready courtside", price: 160, icon: "i-plus" },
  { id: "balls", name: "Game ball set", note: "Three outdoor performance balls", price: 90, icon: "i-grid" },
  { id: "hydration", name: "Hydration set", note: "Four chilled mineral waters", price: 140, icon: "i-wallet" }
];

const busyCourts = {
  "07:00": ["c3"], "08:00": ["c3"], "09:00": ["c1"],
  "10:00": ["c1"], "11:00": ["c2"],
  "13:00": ["c4"], "14:00": ["c4"], "15:00": ["c1"],
  "16:00": ["c1"], "17:00": ["c4"], "18:00": ["c4"],
  "19:00": ["c4"], "20:00": ["c2", "c4"], "21:00": ["c3"]
};

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}

function futureDates() {
  return Array.from({ length: 6 }, (_, index) => {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + index + 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return {
      key,
      day: new Intl.DateTimeFormat("en-PH", { weekday: "short" }).format(date),
      date: date.getDate(),
      month: new Intl.DateTimeFormat("en-PH", { month: "short" }).format(date),
      full: new Intl.DateTimeFormat("en-PH", { weekday: "long", month: "long", day: "numeric" }).format(date)
    };
  });
}

function endTime(start, duration = 60) {
  const [hours, minutes] = start.split(":").map(Number);
  const total = hours * 60 + minutes + duration;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function displayTime(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return `${hours % 12 || 12}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""} ${hours >= 12 ? "PM" : "AM"}`;
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).map(part => part[0]).join("").slice(0, 2).toUpperCase();
}

export function renderPlayerView(root, context) {
  const { view, navigate, switchRole, notify, icon } = context;
  const dates = futureDates();
  const timeouts = new Set();
  const urls = new Set();
  let disposed = false;
  let joinOpen = false;
  let joinedPlayer = null;
  const booking = {
    step: 1, date: dates[0].key, selections: new Set(), addOns: new Set(),
    guest: null, paymentBusy: false, confirmation: null
  };

  function venue() {
    return getState().venue;
  }

  function slotPrice(slot) {
    const hour = Number(slot.value.slice(0, 2));
    const rateKey = hour < 12 ? "offPeak" : hour < 16 ? "standard" : hour < 18 || hour >= 21 ? "popular" : "prime";
    return Number(venue().hourlyRates?.[rateKey] ?? slot.price);
  }

  function scrollToStageTop(focusSelector = "[data-step-heading]") {
    window.requestAnimationFrame(() => {
      const focusTarget = root.querySelector(focusSelector);
      (focusSelector === ".availability-section" ? focusTarget : root)?.scrollIntoView({ block: "start" });
      focusTarget?.focus({ preventScroll: true });
    });
  }

  const venueHeader = (kicker, title, description, hero = false) => `
    <header class="player-hero ${hero ? "player-hero-image" : ""}">
      <div class="player-venue-mark" aria-hidden="true">${escapeHtml(venue().initials)}</div>
      <div class="player-hero-copy">
        <p class="player-kicker">${escapeHtml(kicker)}</p>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(description)}</p>
      </div>
      <div class="player-location">${icon("i-pin")}<span>${escapeHtml(venue().location)}</span></div>
    </header>`;

  function selectionKey(courtId, value) {
    return `${courtId}|${value}`;
  }

  function cellIsSelected(courtId, value) {
    return booking.selections.has(selectionKey(courtId, value));
  }

  function timeInMinutes(value) {
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
  }

  function slotIsBusy(courtId, value, date = booking.date) {
    if (getCourt(courtId)?.state === "maintenance") return true;
    if (busyCourts[value]?.includes(courtId)) return true;
    const start = timeInMinutes(value);
    const finish = timeInMinutes(endTime(value));
    return getState().bookings.some(item => {
      if (item.date !== date || item.court !== courtId || ["cancelled", "forfeited"].includes(item.status)) return false;
      return timeInMinutes(item.start) < finish && timeInMinutes(item.end) > start;
    });
  }

  function removeUnavailableSelections() {
    const removed = [];
    [...booking.selections].forEach(key => {
      const [courtId, value] = key.split("|");
      if (!slotIsBusy(courtId, value)) return;
      booking.selections.delete(key);
      removed.push(`${getCourt(courtId)?.name || courtId}, ${displayTime(value)}`);
    });
    return removed;
  }

  function selectedSlots() {
    return timeSlots.filter(slot => getState().courts.some(court => cellIsSelected(court.id, slot.value)));
  }

  function selectedCourts() {
    return getState().courts.filter(court => timeSlots.some(slot => cellIsSelected(court.id, slot.value)));
  }

  function selectedBookingBlocks() {
    return selectedCourts().flatMap(court => {
      const blocks = [];
      timeSlots.forEach((slot, index) => {
        if (!cellIsSelected(court.id, slot.value)) return;
        const current = blocks.at(-1);
        if (current && current.lastIndex === index - 1) {
          current.lastIndex = index;
          current.end = endTime(slot.value);
          current.hours += 1;
          current.amount += slotPrice(slot);
          return;
        }
        blocks.push({
          courtId: court.id,
          courtName: court.name,
          start: slot.value,
          end: endTime(slot.value),
          hours: 1,
          amount: slotPrice(slot),
          lastIndex: index
        });
      });
      return blocks;
    });
  }

  function selectionScheduleSummary() {
    const blocks = selectedBookingBlocks();
    return selectedCourts().map(court => {
      const times = blocks
        .filter(block => block.courtId === court.id)
        .map(block => `${displayTime(block.start)}–${displayTime(block.end)}`)
        .join(", ");
      return `${court.name}: ${times}`;
    }).join(" · ");
  }

  function courtReservationTotal() {
    return selectedBookingBlocks().reduce((sum, block) => sum + block.amount, 0);
  }

  function addOnTotal() {
    return addOns.filter(item => booking.addOns.has(item.id)).reduce((sum, item) => sum + item.price, 0);
  }

  function bookingTotal() {
    return courtReservationTotal() + addOnTotal();
  }

  function courtNames(courts = selectedCourts()) {
    return courts.map(court => court.name).join(", ");
  }

  function selectionEquation() {
    return `${plural(booking.selections.size, "slot")} selected`;
  }

  function availabilityBoard() {
    const cellMarkup = (court, slot, mobile = false) => {
      const busy = slotIsBusy(court.id, slot.value);
      const selected = cellIsSelected(court.id, slot.value);
      const status = busy ? "Booked" : selected ? "Selected, click to remove" : "Open, click to select";
      return `<button type="button" class="availability-cell ${mobile ? "mobile-availability-cell" : ""} ${busy ? "busy" : selected ? "selected" : ""}" data-slot-court="${court.id}" data-slot-time="${slot.value}" aria-label="${escapeHtml(`${court.name}, ${slot.label}, ${status}`)}" aria-pressed="${selected}" ${busy ? "disabled" : ""}><span></span><small>${busy ? "Booked" : selected ? "Selected" : "Open"}</small></button>`;
    };
    return `<div class="field-group availability-section ${booking.selections.size ? "" : "waiting"}" tabindex="-1">
      <div class="field-group-label availability-heading">
        <div><strong>Court schedule</strong><span>Tap an open slot to select it. Tap again to remove.</span></div>
        <span class="availability-selection-count" data-selection-count role="status" aria-live="polite">${booking.selections.size ? `${plural(booking.selections.size, "slot")} · ${formatPeso(courtReservationTotal())}` : "No slots selected"}</span>
      </div>
      <div class="availability-legend" aria-label="Availability legend"><span><i class="open"></i>Open</span><span><i class="booked"></i>Booked</span><span><i class="chosen"></i>Your selection</span></div>
      <div class="availability-scroll" data-availability-scroll role="region" aria-label="All courts hourly availability. Scroll horizontally to see later times.">
        <div class="availability-grid" style="--slot-count:${timeSlots.length}">
          <div class="availability-corner"><strong>All courts</strong><small>Hourly view</small></div>
          ${timeSlots.map(slot => `<div class="availability-time" data-time-label="${slot.value}"><strong>${displayTime(slot.value)}</strong><small>to ${displayTime(endTime(slot.value))}</small></div>`).join("")}
          ${getState().courts.map(court => {
            const count = timeSlots.filter(slot => cellIsSelected(court.id, slot.value)).length;
            return `<div class="availability-court" data-court-label="${court.id}"><span class="court-number">${court.name.replace("Court ", "")}</span><span><strong>${escapeHtml(court.name)}</strong><small>${escapeHtml(court.type)}</small></span><em>${count ? `${count} selected` : ""}</em></div>${timeSlots.map(slot => cellMarkup(court, slot)).join("")}`;
          }).join("")}
        </div>
      </div>
      <div class="availability-mobile" role="region" aria-label="Mobile all-court availability">
        <div class="mobile-availability-grid" style="--court-count:${getState().courts.length};--mobile-grid-min:${80 + getState().courts.length * 58}px">
          <div class="mobile-availability-corner"><strong>Time</strong><small>Hourly</small></div>
          ${getState().courts.map(court => `<div class="mobile-court-head"><span>${court.name.replace("Court ", "C")}</span><small>${escapeHtml(court.type)}</small></div>`).join("")}
          ${timeSlots.map(slot => `<div class="mobile-time-label"><strong>${displayTime(slot.value)}</strong><small>to ${displayTime(endTime(slot.value))}</small></div>${getState().courts.map(court => cellMarkup(court, slot, true)).join("")}`).join("")}
        </div>
      </div>
    </div>`;
  }

  function bookingFooter() {
    const hasSelection = booking.selections.size > 0;
    return `<div class="stage-footer booking-selection-footer"><span data-booking-footer-copy>${icon("i-check")} ${hasSelection ? escapeHtml(selectionEquation()) : "Select one or more open slots"}</span><button class="button primary" type="button" data-action="continue" ${!booking.date || !hasSelection ? "disabled" : ""}>Continue${hasSelection ? ` · ${formatPeso(courtReservationTotal())}` : ""} ${icon("i-arrow")}</button></div>`;
  }

  function updateBookingSelectionUI() {
    if (booking.step !== 1) return;
    const section = root.querySelector(".availability-section");
    section?.classList.toggle("waiting", !booking.selections.size);

    const selectionCount = root.querySelector("[data-selection-count]");
    if (selectionCount) selectionCount.textContent = booking.selections.size ? `${plural(booking.selections.size, "slot")} · ${formatPeso(courtReservationTotal())}` : "No slots selected";

    root.querySelectorAll("[data-court-label]").forEach(label => {
      const courtId = label.dataset.courtLabel;
      const count = timeSlots.filter(slot => cellIsSelected(courtId, slot.value)).length;
      const status = label.querySelector("em");
      if (status) status.textContent = count ? `${count} selected` : "";
    });

    root.querySelectorAll("[data-slot-court][data-slot-time]").forEach(button => {
      const courtId = button.dataset.slotCourt;
      const value = button.dataset.slotTime;
      const slot = timeSlots.find(item => item.value === value);
      const court = getCourt(courtId);
      const busy = slotIsBusy(courtId, value);
      const selected = cellIsSelected(courtId, value);
      const status = busy ? "Booked" : selected ? "Selected, click to remove" : "Open, click to select";
      button.classList.toggle("busy", Boolean(busy));
      button.classList.toggle("selected", selected);
      button.disabled = Boolean(busy);
      button.setAttribute("aria-pressed", String(selected));
      button.setAttribute("aria-label", `${court?.name || courtId}, ${slot?.label || value}, ${status}`);
      const statusLabel = button.querySelector("small");
      if (statusLabel) statusLabel.textContent = busy ? "Booked" : selected ? "Selected" : "Open";
    });

    const footerCopy = root.querySelector("[data-booking-footer-copy]");
    if (footerCopy) footerCopy.innerHTML = `${icon("i-check")} ${booking.selections.size ? escapeHtml(selectionEquation()) : "Select one or more open slots"}`;
    const continueButton = root.querySelector('[data-action="continue"]');
    if (continueButton) {
      continueButton.disabled = !booking.date || !booking.selections.size;
      continueButton.innerHTML = `Continue${booking.selections.size ? ` · ${formatPeso(courtReservationTotal())}` : ""} ${icon("i-arrow")}`;
    }
  }

  function alignAvailabilityBoard() {
    const firstSlot = selectedSlots()[0];
    if (!firstSlot) return;
    window.requestAnimationFrame(() => {
      const scroller = root.querySelector("[data-availability-scroll]");
      const firstSelected = scroller?.querySelector(`.availability-time[data-time-label="${firstSlot.value}"]`);
      if (scroller && firstSelected) scroller.scrollLeft = Math.max(0, firstSelected.offsetLeft - scroller.clientWidth * 0.32);
    });
  }

  function progress() {
    return `<ol class="booking-progress" aria-label="Booking progress">
      ${["Courts", "Details", "Payment"].map((label, index) => {
        const number = index + 1;
        const state = booking.step > number || booking.confirmation ? "complete" : booking.step === number ? "active" : "";
        return `<li class="${state}" ${booking.step === number ? 'aria-current="step"' : ""}><span>${state === "complete" ? icon("i-check") : number}</span><small>${label}</small></li>`;
      }).join("")}</ol>`;
  }

  function selectionSummary() {
    const date = dates.find(item => item.key === booking.date);
    const courts = selectedCourts();
    if (!date || !courts.length || !booking.selections.size) return "";
    return `<aside class="booking-summary surface-card" aria-label="Booking summary">
      <p class="player-kicker">Your reservation</p><h3>${courts.length === 1 ? escapeHtml(courts[0].name) : `${plural(courts.length, "court")} reserved`}</h3>
      <div class="summary-detail">${icon("i-calendar")}<span><strong>${escapeHtml(date.full)}</strong><small>${escapeHtml(selectionEquation())}</small></span></div>
      <div class="summary-detail">${icon("i-grid")}<span><strong>${escapeHtml(courtNames(courts))}</strong><small>${escapeHtml(selectionScheduleSummary())}</small></span></div>
      <div class="summary-detail">${icon("i-pin")}<span><strong>${escapeHtml(venue().name)}</strong><small>${escapeHtml(venue().location)}</small></span></div>
      <div class="summary-price-lines"><span><small>Court reservation · ${escapeHtml(selectionEquation())}</small><strong>${formatPeso(courtReservationTotal())}</strong></span>${addOns.filter(item => booking.addOns.has(item.id)).map(item => `<span><small>${escapeHtml(item.name)}</small><strong>${formatPeso(item.price)}</strong></span>`).join("")}</div>
      <div class="summary-total"><span>Total</span><strong>${formatPeso(bookingTotal())}</strong></div>
      <p class="summary-note">Free cancellation up to 12 hours before your booking.</p>
    </aside>`;
  }

  function updateCheckoutSummary() {
    const current = root.querySelector(".booking-summary");
    if (current) current.outerHTML = selectionSummary();
  }

  function setPaymentBusyUI() {
    const form = root.querySelector('[data-form="payment"]');
    if (!form) return;
    form.setAttribute("aria-busy", String(booking.paymentBusy));
    root.querySelector('[data-action="back"]')?.toggleAttribute("disabled", booking.paymentBusy);
    form.querySelectorAll("input").forEach(input => { input.disabled = booking.paymentBusy; });
    const button = form.querySelector('button[type="submit"]');
    if (button) {
      button.disabled = booking.paymentBusy;
      button.innerHTML = booking.paymentBusy ? `<span class="payment-spinner"></span> Verifying payment…` : `Confirm & pay ${formatPeso(bookingTotal())} ${icon("i-arrow")}`;
    }
    const status = form.querySelector(".payment-live-status");
    if (status) status.textContent = booking.paymentBusy ? "Verifying payment. Please wait." : "";
  }

  function renderBooking() {
    if (booking.confirmation) {
      const confirmed = booking.confirmation;
      root.innerHTML = `<div class="player-view booking-confirmation-view">
        <section class="confirmation-card surface-card" aria-live="polite">
          <div class="confirmation-orbit"><span>${icon("i-check")}</span></div>
          <p class="player-kicker">Payment received</p><h2 data-step-heading tabindex="-1">Your ${confirmed.courtIds.length === 1 ? "court is" : "courts are"} ready.</h2>
          <p class="confirmation-lead">${confirmed.courtIds.length === 1 ? "A confirmation" : "One grouped confirmation"} has been prepared for ${escapeHtml(confirmed.guest)}. We’ll see you on court.</p>
          <div class="booking-reference"><span>${confirmed.courtIds.length === 1 ? "Booking" : "Group"} reference</span><strong>${escapeHtml(confirmed.id)}</strong></div>
          <div class="confirmation-details">
            <div>${icon("i-calendar")}<span><small>Date & time</small><strong>${escapeHtml(dates.find(item => item.key === confirmed.date)?.full || confirmed.date)} · ${plural(confirmed.slotCount, "slot")}</strong></span></div>
            <div>${icon("i-grid")}<span><small>${plural(confirmed.courtIds.length, "Court")}</small><strong>${escapeHtml(confirmed.scheduleSummary)}</strong></span></div>
            <div>${icon("i-wallet")}<span><small>Paid with GCash</small><strong>${formatPeso(confirmed.amount)} · Payment verified</strong></span></div>
          </div>
          <div class="confirmation-actions"><button class="button primary" type="button" data-action="calendar">${icon("i-calendar")} Add to calendar</button><button class="button secondary" type="button" data-action="share">${icon("i-plus")} Share booking</button></div>
        </section>
        <section class="owner-handoff"><div><p class="player-kicker">Demo story complete</p><h3>See it land in operations</h3><p>Switch back to the Owner view to see this reservation reflected in bookings and revenue.</p></div><button class="button secondary" type="button" data-action="owner">Switch to Owner ${icon("i-arrow")}</button></section>
      </div>`;
      return;
    }

    if (booking.step === 1) {
      root.innerHTML = `<div class="player-view booking-player-view booking-select-view">
        ${venueHeader("Book direct", "Book court time in seconds.", "Tap any open slot. Choose as many courts and times as you need, then check out once.", true)}
        ${progress()}
        <section class="booking-stage surface-card">
          <div class="stage-heading"><span>01</span><div><p class="player-kicker">Court booking</p><h3>Choose your slots</h3></div></div>
          <div class="field-group"><div class="field-group-label"><strong>Select a date</strong><span>Next 6 days</span></div><div class="date-strip" role="radiogroup" aria-label="Select a booking date">
            ${dates.map((date, index) => `<button type="button" class="date-option ${booking.date === date.key ? "selected" : ""}" data-date="${date.key}" role="radio" aria-checked="${booking.date === date.key}" tabindex="${booking.date === date.key ? "0" : "-1"}"><small>${index === 0 ? "Tomorrow" : date.day}</small><strong>${date.date}</strong><span>${date.month}</span></button>`).join("")}
          </div></div>
          ${availabilityBoard()}
          ${bookingFooter()}
        </section>
      </div>`;
      alignAvailabilityBoard();
      return;
    }

    if (booking.step === 2) {
      root.innerHTML = `<div class="player-view">
        <div class="booking-compact-title"><button class="back-link" type="button" data-action="back">${icon("i-arrow")} Back</button><div><p class="player-kicker">Almost yours</p><h2 data-step-heading tabindex="-1">Who’s playing?</h2></div></div>
        ${progress()}
        <div class="checkout-layout"><form class="booking-stage surface-card guest-form" data-form="guest">
          <div class="stage-heading"><span>02</span><div><p class="player-kicker">Player details</p><h3>Tell us who to expect</h3></div></div>
          <div class="form-grid">
            <label class="player-field full"><span>Full name</span><input name="name" autocomplete="name" placeholder="e.g. Gabriela Ramos" value="${escapeHtml(booking.guest?.name || "")}" required></label>
            <label class="player-field"><span>Mobile number</span><div class="phone-field"><b>+63</b><input name="phone" inputmode="tel" autocomplete="tel" placeholder="917 123 4567" pattern="[0-9 ]{10,12}" value="${escapeHtml(booking.guest?.phone || "")}" required></div></label>
            <label class="player-field"><span>Email address</span><input name="email" type="email" autocomplete="email" placeholder="you@example.com" value="${escapeHtml(booking.guest?.email || "")}" required></label>
            <label class="player-field full"><span>Booking note <small>Optional</small></span><input name="note" placeholder="Celebration, coaching session, accessibility request…" value="${escapeHtml(booking.guest?.note || "")}"></label>
          </div>
          <fieldset class="addon-fieldset"><legend><strong>Make it game-ready</strong><span>Optional add-ons</span></legend><div class="addon-list">${addOns.map(item => `<label class="addon-option"><input type="checkbox" name="addon" value="${item.id}" ${booking.addOns.has(item.id) ? "checked" : ""}><span class="addon-icon">${icon(item.icon)}</span><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.note)}</small></span><b>+${formatPeso(item.price)}</b></label>`).join("")}</div></fieldset>
          <div class="stage-footer form-footer"><span>By continuing, you agree to the venue booking policy.</span><button class="button primary" type="submit">Review payment ${icon("i-arrow")}</button></div>
        </form>${selectionSummary()}</div>
      </div>`;
      return;
    }

    const guest = booking.guest;
    root.innerHTML = `<div class="player-view">
      <div class="booking-compact-title"><button class="back-link" type="button" data-action="back" ${booking.paymentBusy ? "disabled" : ""}>${icon("i-arrow")} Back</button><div><p class="player-kicker">Secure checkout</p><h2 data-step-heading tabindex="-1">Pay with GCash</h2></div></div>
      ${progress()}
      <div class="checkout-layout"><form class="booking-stage surface-card payment-panel" data-form="payment" aria-busy="${booking.paymentBusy}">
        <div class="gcash-heading"><div class="gcash-wordmark">G<span>Cash</span></div><span class="status-pill success">Secure</span></div>
        <div class="payment-amount"><span>Amount to pay</span><strong>${formatPeso(bookingTotal())}</strong><small>No booking or processing fees</small></div>
        <div class="demo-payment-note">${icon("i-spark")}<div><strong>Interactive payment demo</strong><span>No real charge will be made. Continue to simulate an approved GCash payment.</span></div></div>
        <label class="player-field"><span>GCash mobile number</span><div class="phone-field"><b>+63</b><input name="gcash" inputmode="numeric" autocomplete="tel" value="${escapeHtml(guest.phone)}" pattern="[0-9 ]{10,12}" required ${booking.paymentBusy ? "disabled" : ""}></div></label>
        <div class="payment-recipient"><span>Paying</span><strong>${escapeHtml(venue().name)}</strong><small>Verified RallyOS merchant</small></div>
        <button class="button gcash-button" type="submit" ${booking.paymentBusy ? "disabled" : ""}>${booking.paymentBusy ? `<span class="payment-spinner"></span> Verifying payment…` : `Confirm & pay ${formatPeso(bookingTotal())} ${icon("i-arrow")}`}</button>
        <p class="payment-live-status" role="status" aria-live="polite">${booking.paymentBusy ? "Verifying payment. Please wait." : ""}</p>
        <p class="payment-security">${icon("i-check")} Payment details are encrypted and never stored by the venue.</p>
      </form>${selectionSummary()}</div>
    </div>`;
  }

  function renderJoin() {
    const play = getState().openPlay;
    const remaining = Math.max(0, 20 - play.checkedIn);
    root.innerHTML = `<div class="player-view">
      ${venueHeader("Social sessions", "Come solo. Leave with a crew.", "Level-matched games, smooth rotations, and all the court time you need.")}
      <section class="open-play-feature surface-card">
        <div class="session-visual"><span class="live-label"><i></i> Friday session</span><div class="session-monogram">2.5<span>–3.0</span></div><p>Beginner-friendly social play</p></div>
        <div class="session-content"><div class="session-topline"><span class="status-pill success">${remaining} spots left</span><span>${formatPeso(200)} / player</span></div><p class="player-kicker">This Friday · 6:00–8:00 PM</p><h2>Beginner Social</h2><p>Friendly round-robin games with a RallyOS host managing pairings, rotations, and scores.</p>
          <div class="session-facts"><span>${icon("i-users")} <b>${play.checkedIn}/20</b> players</span><span>${icon("i-grid")} <b>4</b> courts</span><span>${icon("i-clock")} <b>2 hours</b></span></div>
          ${joinedPlayer ? `<div class="joined-confirmation" role="status">${icon("i-check")}<span><strong>You’re on the list, ${escapeHtml(joinedPlayer)}.</strong><small>Your spot is held. Payment instructions are ready in My visit.</small></span><button class="text-button" type="button" data-view="visit">View visit ${icon("i-arrow")}</button></div>` : joinOpen ? `<form class="join-form" data-form="join"><label class="player-field"><span>Your name</span><input name="name" autocomplete="name" placeholder="Full name" required></label><label class="player-field"><span>Skill level</span><select name="level" required><option value="">Select level</option><option value="2.5">2.5 · Learning rallies</option><option value="3.0">3.0 · Consistent rallies</option></select></label><button class="button primary" type="submit">Hold my spot ${icon("i-arrow")}</button></form>` : `<button class="button primary session-cta" type="button" data-action="open-join">Join for ${formatPeso(200)} ${icon("i-arrow")}</button>`}
        </div>
      </section>
      <section class="player-perks"><article>${icon("i-users")}<div><h3>Balanced games</h3><p>We rotate partners and match players by level.</p></div></article><article>${icon("i-play")}<div><h3>More time playing</h3><p>Live queues keep every court moving smoothly.</p></div></article><article>${icon("i-check")}<div><h3>Just show up</h3><p>Host, balls, and fresh court setup are included.</p></div></article></section>
    </div>`;
  }

  function latestVisit() {
    const bookings = getState().bookings;
    const latest = [...bookings].reverse().find(item => item.source === "Interactive demo") || bookings.find(item => item.id === "BK-2408") || bookings.at(-1);
    if (!latest?.groupId) return latest;
    const grouped = bookings.filter(item => item.groupId === latest.groupId);
    const uniqueCourtIds = [...new Set(grouped.map(item => item.court))];
    const blocks = grouped.map(item => ({
      courtId: item.court,
      courtName: getCourt(item.court)?.name || item.court,
      start: item.start,
      end: item.end,
      hours: (timeInMinutes(item.end) - timeInMinutes(item.start)) / 60
    }));
    const scheduleSummary = uniqueCourtIds.map(courtId => {
      const times = blocks.filter(block => block.courtId === courtId).map(block => `${displayTime(block.start)}–${displayTime(block.end)}`).join(", ");
      return `${getCourt(courtId)?.name || courtId}: ${times}`;
    }).join(" · ");
    return {
      ...latest,
      id: latest.groupId,
      courtIds: uniqueCourtIds,
      courtNames: uniqueCourtIds.map(courtId => getCourt(courtId)?.name || courtId).join(", "),
      blocks,
      scheduleSummary,
      slotCount: blocks.reduce((sum, block) => sum + block.hours, 0),
      amount: grouped.reduce((sum, item) => sum + Number(item.amount || 0), 0)
    };
  }

  function renderVisit() {
    const item = latestVisit();
    const court = getCourt(item.court);
    const visitCourtNames = item.courtNames || court?.name || item.court;
    const visitCourtCount = item.courtIds?.length || 1;
    const dateLabel = item.date ? new Intl.DateTimeFormat("en-PH", { weekday: "long", month: "long", day: "numeric" }).format(new Date(`${item.date}T12:00:00`)) : "Friday, August 7";
    const minutes = timeInMinutes(item.end) - timeInMinutes(item.start);
    const visitHours = item.slotCount || minutes / 60;
    root.innerHTML = `<div class="player-view">
      ${venueHeader("My visit", "Everything for game day.", "Your reservation, arrival details, and venue essentials in one place.")}
      <div class="visit-layout"><section class="visit-ticket surface-card">
        <div class="ticket-head"><span class="status-pill success">Confirmed</span><small>${escapeHtml(item.id)}</small></div><div class="ticket-time"><p>${escapeHtml(dateLabel)}</p>${item.blocks?.length ? `<strong>${plural(visitHours, "slot")}</strong><span>across ${plural(visitCourtCount, "court")}</span>` : `<strong>${displayTime(item.start)}</strong><span>to ${displayTime(item.end)}</span>`}</div><div class="ticket-rule"></div>
        ${item.scheduleSummary ? `<p class="ticket-schedule">${escapeHtml(item.scheduleSummary)}</p>` : ""}
        <div class="ticket-details"><div>${icon("i-grid")}<span><small>${visitCourtCount === 1 ? "Court" : "Courts"}</small><strong>${escapeHtml(visitCourtNames)}</strong></span></div><div>${icon("i-clock")}<span><small>Reserved time</small><strong>${plural(visitHours, "hour")}</strong></span></div><div>${icon("i-wallet")}<span><small>Payment</small><strong>Paid · ${formatPeso(item.amount)}</strong></span></div></div>
        <div class="ticket-actions"><button class="button primary" type="button" data-action="calendar-visit">${icon("i-calendar")} Add to calendar</button><button class="button secondary" type="button" data-action="directions">${icon("i-pin")} Directions</button></div>
      </section><aside class="arrival-card"><p class="player-kicker">Before you arrive</p><h3>Good to know</h3><ol><li><span>01</span><div><strong>Arrive 10 minutes early</strong><small>Check in at the front desk using your booking reference.</small></div></li><li><span>02</span><div><strong>Wear non-marking shoes</strong><small>Changing rooms and secure cubbies are available.</small></div></li><li><span>03</span><div><strong>Paddles are available</strong><small>Rent a premium pair at the desk for ${formatPeso(160)}.</small></div></li></ol><button class="text-button" type="button" data-action="help">Message the venue ${icon("i-arrow")}</button></aside></div>
    </div>`;
  }

  function renderLive() {
    const play = getState().openPlay;
    root.innerHTML = `<div class="player-view live-player-view">
      <div class="live-board-heading"><div><p class="player-kicker"><span class="pulse-dot"></span> Session live</p><h2>Beginner Social</h2><p>${escapeHtml(play.time)} · ${play.checkedIn} players checked in</p></div><div class="rotation-estimate"><small>Next rotation</small><strong>~4 min</strong></div></div>
      <div class="player-score-grid">${play.courts.map(match => `<article class="player-score-card"><header><span>${escapeHtml(match.name)}</span><small>${icon("i-clock")} ${escapeHtml(match.elapsed)}</small></header><div class="matchup"><div><span>${escapeHtml(initials(match.teamA.join(" ")))}</span><strong>${match.teamA.map(escapeHtml).join(" & ")}</strong></div><b>${escapeHtml(match.score)}</b><div><span>${escapeHtml(initials(match.teamB.join(" ")))}</span><strong>${match.teamB.map(escapeHtml).join(" & ")}</strong></div></div><footer>Game to 11 · win by 2</footer></article>`).join("")}<article class="player-score-card court-warming"><div>${icon("i-refresh")}</div><p class="player-kicker">Court 3</p><h3>Next game forming</h3><p>Players being called from the queue.</p></article></div>
      <section class="player-queue surface-card"><div class="section-heading"><div><p class="player-kicker">Rotation queue</p><h2>Up next</h2></div><span class="status-pill info">Auto-balanced</span></div><div class="queue-rows">${play.queue.map((player, index) => `<div class="queue-row ${index < 2 ? "next" : ""}"><span class="queue-position">${String(index + 1).padStart(2, "0")}</span><span class="queue-avatar">${escapeHtml(initials(player.name))}</span><span><strong>${escapeHtml(player.name)}</strong><small>Level ${escapeHtml(player.level)}</small></span><b>${escapeHtml(player.wait)}</b></div>`).join("")}</div></section>
    </div>`;
  }

  function escapeCalendarText(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
  }

  function calendarDownload(item = booking.confirmation) {
    if (!item) return;
    const date = (item.date || booking.date || dates[0].key).replaceAll("-", "");
    const calendarBlocks = item.blocks?.length ? item.blocks : [{
      courtId: item.court,
      courtName: item.courtNames || getCourt(item.court)?.name || item.court,
      start: item.start,
      end: item.end
    }];
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const events = calendarBlocks.flatMap((block, index) => [
      "BEGIN:VEVENT",
      `UID:${item.id}-${index + 1}@rallyos.demo`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Asia/Manila:${date}T${block.start.replace(":", "")}00`,
      `DTEND;TZID=Asia/Manila:${date}T${block.end.replace(":", "")}00`,
      `SUMMARY:${escapeCalendarText(`Pickleball · ${block.courtName || getCourt(block.courtId)?.name || block.courtId}`)}`,
      `LOCATION:${escapeCalendarText(venue().location)}`,
      `DESCRIPTION:${escapeCalendarText(`Booking ${item.id} at ${venue().name}`)}`,
      "END:VEVENT"
    ]);
    const content = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//RallyOS//Booking//EN", "CALSCALE:GREGORIAN", "X-WR-TIMEZONE:Asia/Manila", ...events, "END:VCALENDAR"].join("\r\n");
    const url = URL.createObjectURL(new Blob([content], { type: "text/calendar;charset=utf-8" }));
    urls.add(url);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `${item.id}-rallyos.ics`; anchor.click();
    notify("Calendar file ready", "Your court time has been added to a calendar invite.");
    const id = window.setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); timeouts.delete(id); }, 1000);
    timeouts.add(id);
  }

  async function shareBooking() {
    const item = booking.confirmation;
    if (!item) return;
    const text = `${venue().name} · ${item.id} · ${dates.find(date => date.key === item.date)?.full || item.date} · ${item.scheduleSummary}`;
    try {
      if (navigator.share) await navigator.share({ title: "My RallyOS booking", text });
      else await navigator.clipboard.writeText(text);
      notify("Booking ready to share", navigator.share ? "Your device share sheet was opened." : "Booking details were copied to your clipboard.");
    } catch (error) {
      if (error?.name !== "AbortError") notify("Share unavailable", "Use the booking reference shown on screen instead.");
    }
  }

  function selectAvailabilityCell(courtId, value) {
    if (slotIsBusy(courtId, value)) return;
    const key = selectionKey(courtId, value);
    if (booking.selections.has(key)) booking.selections.delete(key);
    else booking.selections.add(key);
    updateBookingSelectionUI();
  }

  function handleClick(event) {
    const target = event.target.closest("button");
    if (!target || !root.contains(target)) return;
    if (target.dataset.view) { navigate(target.dataset.view); return; }
    if (target.dataset.date) {
      booking.date = target.dataset.date;
      root.querySelectorAll("[data-date]").forEach(button => {
        const selected = button.dataset.date === booking.date;
        button.classList.toggle("selected", selected);
        button.setAttribute("aria-checked", String(selected));
        button.tabIndex = selected ? 0 : -1;
      });
      const removed = removeUnavailableSelections();
      updateBookingSelectionUI();
      if (removed.length) notify("Selection updated", `${plural(removed.length, "slot")} became unavailable on this date and ${removed.length === 1 ? "was" : "were"} removed.`);
      return;
    }
    if (target.dataset.slotCourt && target.dataset.slotTime) { selectAvailabilityCell(target.dataset.slotCourt, target.dataset.slotTime); return; }
    const action = target.dataset.action;
    if (action === "continue") { booking.step = 2; renderBooking(); scrollToStageTop(); }
    if (action === "back") {
      booking.step = Math.max(1, booking.step - 1);
      renderBooking();
      scrollToStageTop(booking.step === 1 ? ".availability-section" : "[data-step-heading]");
    }
    if (action === "calendar") calendarDownload();
    if (action === "calendar-visit") calendarDownload(latestVisit());
    if (action === "share") shareBooking();
    if (action === "owner") switchRole("owner");
    if (action === "open-join") { joinOpen = true; renderJoin(); }
    if (action === "directions") notify("Directions opened", `${venue().name} is in ${venue().location}. This is a preview, so no map was launched.`);
    if (action === "help") notify("Venue message ready", `In the live product, this opens a conversation with ${venue().name}.`);
  }

  function handleChange(event) {
    if (event.target.name !== "addon") return;
    const form = event.target.closest("form");
    const data = new FormData(form);
    booking.guest = {
      name: data.get("name")?.trim() || "",
      phone: data.get("phone")?.trim() || "",
      email: data.get("email")?.trim() || "",
      note: data.get("note")?.trim() || ""
    };
    if (event.target.checked) booking.addOns.add(event.target.value); else booking.addOns.delete(event.target.value);
    updateCheckoutSummary();
  }

  function handleInput(event) {
    if (event.target instanceof HTMLInputElement) event.target.setCustomValidity("");
  }

  function handleKeydown(event) {
    const dateButton = event.target.closest("[data-date]");
    if (!dateButton || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...root.querySelectorAll("[data-date]")];
    const current = buttons.indexOf(dateButton);
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = buttons[(current + direction + buttons.length) % buttons.length];
    next.focus();
    next.click();
  }

  function handleSubmit(event) {
    const form = event.target.closest("form");
    if (!form || !root.contains(form)) return;
    event.preventDefault();
    const data = new FormData(form);
    if (form.dataset.form === "guest") {
      const nameInput = form.elements.namedItem("name");
      const phoneInput = form.elements.namedItem("phone");
      if (!data.get("name")?.trim()) nameInput.setCustomValidity("Enter the player’s full name.");
      if (!/^9\d{9}$/.test(data.get("phone")?.replace(/\s/g, "") || "")) phoneInput.setCustomValidity("Enter a valid 10-digit Philippine mobile number after +63.");
    }
    if (form.dataset.form === "payment") {
      const gcashInput = form.elements.namedItem("gcash");
      if (!/^9\d{9}$/.test(data.get("gcash")?.replace(/\s/g, "") || "")) gcashInput.setCustomValidity("Enter a valid 10-digit GCash mobile number after +63.");
    }
    if (!form.reportValidity()) return;
    if (form.dataset.form === "guest") {
      booking.guest = { name: data.get("name").trim(), phone: data.get("phone").trim(), email: data.get("email").trim(), note: data.get("note").trim() };
      booking.addOns = new Set(data.getAll("addon")); booking.step = 3; renderBooking(); scrollToStageTop();
    }
    if (form.dataset.form === "payment" && !booking.paymentBusy) {
      const initialConflicts = removeUnavailableSelections();
      if (initialConflicts.length) {
        booking.step = 1;
        renderBooking();
        scrollToStageTop(".availability-section");
        notify("Availability changed", `${plural(initialConflicts.length, "slot")} ${initialConflicts.length === 1 ? "was" : "were"} just booked. Review the updated schedule before continuing.`);
        return;
      }
      booking.paymentBusy = true;
      setPaymentBusyUI();
      const id = window.setTimeout(() => {
        timeouts.delete(id);
        if (disposed || booking.confirmation) return;
        const finalConflicts = removeUnavailableSelections();
        if (finalConflicts.length) {
          booking.paymentBusy = false;
          booking.step = 1;
          renderBooking();
          scrollToStageTop(".availability-section");
          notify("Availability changed", `${plural(finalConflicts.length, "slot")} ${finalConflicts.length === 1 ? "was" : "were"} just booked. Nothing was charged.`);
          return;
        }
        const courts = selectedCourts();
        const blocks = selectedBookingBlocks();
        const scheduleSummary = selectionScheduleSummary();
        const groupId = `GRP-${String(2410 + getState().bookings.length)}`;
        const total = bookingTotal();
        const payloads = blocks.map((block, index) => ({
          court: block.courtId,
          guest: booking.guest.name,
          start: block.start,
          end: block.end,
          date: booking.date,
          label: booking.guest.note || `Grouped booking · ${plural(block.hours, "hour")}`,
          amount: block.amount + (index === 0 ? addOnTotal() : 0),
          phone: booking.guest.phone,
          email: booking.guest.email,
          addOns: index === 0 ? [...booking.addOns] : [],
          groupId
        }));
        let created;
        try {
          created = createBookingGroup(payloads);
        } catch (error) {
          booking.paymentBusy = false;
          booking.step = 1;
          removeUnavailableSelections();
          renderBooking();
          scrollToStageTop(".availability-section");
          notify("Booking needs a quick review", `${error.message || "One selected slot is no longer available."} Nothing was charged.`);
          return;
        }
        booking.confirmation = {
          id: groupId,
          bookings: created,
          courtIds: courts.map(court => court.id),
          courtNames: courtNames(courts),
          guest: booking.guest.name,
          date: booking.date,
          blocks: blocks.map(({ lastIndex, ...block }) => block),
          slotCount: booking.selections.size,
          scheduleSummary,
          amount: total
        };
        booking.paymentBusy = false; renderBooking(); scrollToStageTop();
        notify("Grouped booking confirmed", `${booking.confirmation.id} reserved ${plural(booking.confirmation.slotCount, "slot")} across ${plural(courts.length, "court")}.`);
      }, 1050);
      timeouts.add(id);
    }
    if (form.dataset.form === "join") {
      joinedPlayer = data.get("name").trim();
      addOpenPlayPlayer({ name: joinedPlayer, level: data.get("level"), wait: "~18 min" });
      notify("Spot held", `You’re joining Friday’s Beginner Social as a level ${data.get("level")} player.`); renderJoin();
    }
  }

  root.addEventListener("click", handleClick);
  root.addEventListener("change", handleChange);
  root.addEventListener("input", handleInput);
  root.addEventListener("keydown", handleKeydown);
  root.addEventListener("submit", handleSubmit);

  if (view === "join") renderJoin();
  else if (view === "visit") renderVisit();
  else if (view === "live") renderLive();
  else renderBooking();

  return () => {
    disposed = true;
    root.removeEventListener("click", handleClick);
    root.removeEventListener("change", handleChange);
    root.removeEventListener("input", handleInput);
    root.removeEventListener("keydown", handleKeydown);
    root.removeEventListener("submit", handleSubmit);
    timeouts.forEach(id => window.clearTimeout(id));
    urls.forEach(url => URL.revokeObjectURL(url));
  };
}
