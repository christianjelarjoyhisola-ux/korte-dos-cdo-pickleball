const seed = {
  venue: {
    name: "Horizon Pickle Club",
    initials: "HP",
    location: "Uptown, Cagayan de Oro",
    courts: 4,
    primary: "#6558e8",
    phone: "+63 917 555 0184",
    hourlyRates: {
      offPeak: 480,
      standard: 520,
      popular: 600,
      prime: 720
    }
  },
  metrics: {
    revenue: 18420,
    occupancy: 78,
    bookings: 31,
    arrivals: 18,
    pendingReviews: 2,
    openPlayPlayers: 26
  },
  courts: [
    { id: "c1", name: "Court 1", surface: "ProShield", type: "Indoor", state: "ready" },
    { id: "c2", name: "Court 2", surface: "ProShield", type: "Indoor", state: "ready" },
    { id: "c3", name: "Court 3", surface: "Acrylic", type: "Covered", state: "ready" },
    { id: "c4", name: "Court 4", surface: "Acrylic", type: "Covered", state: "ready" }
  ],
  bookings: [
    { id: "BK-2401", court: "c1", guest: "Mia Santos", initials: "MS", start: "09:00", end: "10:30", label: "Morning doubles", status: "checked-in", payment: "paid", amount: 720, source: "Public link" },
    { id: "BK-2402", court: "c2", guest: "Paolo Reyes", initials: "PR", start: "10:00", end: "11:00", label: "Private court", status: "confirmed", payment: "paid", amount: 480, source: "Messenger" },
    { id: "BK-2403", court: "c4", guest: "Ana Lim", initials: "AL", start: "12:00", end: "13:30", label: "Lunch rally", status: "confirmed", payment: "review", amount: 720, source: "Google" },
    { id: "BK-2404", court: "c1", guest: "John Mercado", initials: "JM", start: "15:00", end: "17:00", label: "Team practice", status: "confirmed", payment: "paid", amount: 960, source: "Repeat" },
    { id: "BK-2405", court: "c2", guest: "Kaye Dizon", initials: "KD", start: "16:00", end: "17:00", label: "After-work game", status: "arriving", payment: "paid", amount: 560, source: "Public link" },
    { id: "BK-2406", court: "c3", guest: "Beginner Open Play", initials: "OP", start: "18:00", end: "20:00", label: "18 / 20 players", status: "open-play", payment: "mixed", amount: 3600, source: "Program" },
    { id: "BK-2407", court: "c4", guest: "Luis Tan", initials: "LT", start: "18:30", end: "20:00", label: "Prime-time booking", status: "confirmed", payment: "paid", amount: 1080, source: "Instagram" },
    { id: "BK-2408", court: "c1", guest: "Nica Flores", initials: "NF", start: "20:00", end: "21:30", label: "Evening singles", status: "confirmed", payment: "balance", amount: 1080, source: "Public link" }
  ],
  arrivals: [
    { name: "Kaye Dizon", time: "5:45 PM", court: "Court 2", state: "Arriving", tone: "info" },
    { name: "Beginner Open Play", time: "6:00 PM", court: "Court 3", state: "18 of 20", tone: "success" },
    { name: "Luis Tan", time: "6:30 PM", court: "Court 4", state: "Confirmed", tone: "neutral" },
    { name: "Nica Flores", time: "8:00 PM", court: "Court 1", state: "Balance due", tone: "warning" }
  ],
  paymentReviews: [
    { id: "PAY-1841", guest: "Ana Lim", provider: "GCash", amount: 720, confidence: 94, reason: "Receiver and amount matched", ref: "4310 882 147", time: "12:04 PM" },
    { id: "PAY-1842", guest: "Carlo Uy", provider: "BPI", amount: 560, confidence: 71, reason: "Reference needs confirmation", ref: "BPI-884102", time: "4:16 PM" }
  ],
  openPlay: {
    session: "Beginner Social · 2.5–3.0",
    time: "6:00–8:00 PM",
    checkedIn: 18,
    capacity: 20,
    courts: [
      { id: 1, name: "Court 1", teamA: ["Mia S.", "Carlo U."], teamB: ["Nica F.", "Paolo R."], score: "7 — 5", elapsed: "08:42" },
      { id: 2, name: "Court 2", teamA: ["Ana L.", "Jessa V."], teamB: ["Luis T.", "Mark C."], score: "4 — 6", elapsed: "06:18" }
    ],
    queue: [
      { name: "Bea P.", level: "2.5", wait: "Next" },
      { name: "Jon M.", level: "3.0", wait: "Next" },
      { name: "Faye R.", level: "2.5", wait: "~9 min" },
      { name: "Gio A.", level: "3.0", wait: "~9 min" },
      { name: "Rina D.", level: "2.5", wait: "~18 min" },
      { name: "Ken B.", level: "3.0", wait: "~18 min" }
    ]
  }
};

const pricingStorageKey = "rallyos-demo-hourly-rates";

function storedHourlyRates() {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(pricingStorageKey));
    const keys = ["offPeak", "standard", "popular", "prime"];
    if (!parsed || !keys.every(key => Number.isFinite(Number(parsed[key])) && Number(parsed[key]) >= 100 && Number(parsed[key]) <= 10000)) return null;
    return Object.fromEntries(keys.map(key => [key, Math.round(Number(parsed[key]))]));
  } catch {
    return null;
  }
}

let state = structuredClone(seed);
const savedHourlyRates = storedHourlyRates();
if (savedHourlyRates) state.venue.hourlyRates = savedHourlyRates;
const listeners = new Set();

export const formatPeso = value => new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP", maximumFractionDigits: 0 }).format(value);
export const getState = () => state;
export const getCourt = id => state.courts.find(court => court.id === id);
export const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };

function publish(reason) {
  listeners.forEach(listener => listener(state, reason));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("rally:state", { detail: { state, reason } }));
  }
}

export function createBooking(booking) {
  const next = {
    id: `BK-${String(2410 + state.bookings.length)}`,
    initials: booking.guest.split(/\s+/).map(part => part[0]).join("").slice(0, 2).toUpperCase(),
    status: "confirmed",
    payment: "paid",
    source: "Interactive demo",
    ...booking
  };
  state.bookings.push(next);
  state.metrics.bookings += 1;
  state.metrics.revenue += Number(next.amount || 0);
  publish("booking-created");
  return next;
}

function minutes(time) {
  const [hours, value] = time.split(":").map(Number);
  return hours * 60 + value;
}

function overlaps(left, right) {
  return minutes(left.start) < minutes(right.end) && minutes(left.end) > minutes(right.start);
}

export function createBookingGroup(bookings) {
  if (!Array.isArray(bookings) || !bookings.length) throw new Error("A booking group needs at least one court time.");
  const activeBookings = state.bookings.filter(item => !["cancelled", "forfeited"].includes(item.status));

  bookings.forEach((candidate, index) => {
    if (!candidate.date || !candidate.court || !candidate.start || !candidate.end) throw new Error("Every booking block needs a date, court, start, and end time.");
    const existingConflict = activeBookings.some(item => item.date === candidate.date && item.court === candidate.court && overlaps(item, candidate));
    const groupConflict = bookings.slice(0, index).some(item => item.date === candidate.date && item.court === candidate.court && overlaps(item, candidate));
    if (existingConflict || groupConflict) throw new Error(`${candidate.court} is no longer available for one of the selected times.`);
  });

  const baseIndex = state.bookings.length;
  const created = bookings.map((booking, index) => ({
    id: `BK-${String(2410 + baseIndex + index)}`,
    initials: booking.guest.split(/\s+/).map(part => part[0]).join("").slice(0, 2).toUpperCase(),
    status: "confirmed",
    payment: "paid",
    source: "Interactive demo",
    ...booking
  }));
  state.bookings.push(...created);
  state.metrics.bookings += created.length;
  state.metrics.revenue += created.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  publish("booking-group-created");
  return created;
}

export function updateBooking(id, patch) {
  const booking = state.bookings.find(item => item.id === id);
  if (!booking) return null;
  Object.assign(booking, patch);
  publish("booking-updated");
  return booking;
}

export function resolvePayment(id, decision = "approved") {
  const review = state.paymentReviews.find(item => item.id === id);
  if (!review) return null;
  state.paymentReviews = state.paymentReviews.filter(item => item.id !== id);
  state.metrics.pendingReviews = state.paymentReviews.length;
  publish(`payment-${decision}`);
  return review;
}

export function setCourtState(courtId, courtState) {
  const court = getCourt(courtId);
  if (!court) return null;
  court.state = courtState;
  publish("court-state");
  return court;
}

export function addOpenPlayPlayer(player) {
  state.openPlay.queue.push(player);
  state.openPlay.checkedIn += 1;
  state.metrics.openPlayPlayers += 1;
  publish("open-play-player");
}

export function updateBrand({ name, primary }) {
  if (name) {
    state.venue.name = name;
    state.venue.initials = name.split(/\s+/).map(word => word[0]).join("").slice(0, 2).toUpperCase();
  }
  if (primary) state.venue.primary = primary;
  publish("brand-updated");
}

export function updatePricing(rates) {
  const keys = ["offPeak", "standard", "popular", "prime"];
  const next = { ...state.venue.hourlyRates };
  if (!rates || typeof rates !== "object") throw new Error("Pricing details are required.");

  keys.forEach(key => {
    const value = Number(rates[key]);
    if (!Number.isFinite(value) || value < 100 || value > 10000) {
      throw new Error("Each hourly rate must be between ₱100 and ₱10,000.");
    }
    next[key] = Math.round(value);
  });

  state.venue.hourlyRates = next;
  if (typeof window !== "undefined") {
    try { window.localStorage.setItem(pricingStorageKey, JSON.stringify(next)); } catch { /* Storage may be unavailable in private contexts. */ }
  }
  publish("pricing-updated");
  return next;
}

export function resetDemo() {
  state = structuredClone(seed);
  if (typeof window !== "undefined") {
    try { window.localStorage.removeItem(pricingStorageKey); } catch { /* Storage may be unavailable in private contexts. */ }
  }
  publish("reset");
  return state;
}
