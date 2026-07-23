// =============================================
// SUPABASE CONFIGURATION
// Replace these with your actual project credentials.
// Find them at: Supabase Dashboard → Project Settings → API
// =============================================
const SUPABASE_URL = 'https://zcuufcpkgidmaanxjufo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpjdXVmY3BrZ2lkbWFhbnhqdWZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzNjYyODMsImV4cCI6MjA5Nzk0MjI4M30.c_H2mUkyoc8xlA3BONq11t6HwvfaSZbXcs_smTKp2_o';

const PB_REQUEST_TIMEOUT_MS = 45000;
const PB_RECEIPT_TIMEOUT_MS = 90000;

async function _pbFetchWithTimeout(input, init = {}, timeoutMs = PB_REQUEST_TIMEOUT_MS) {
  const supportsAbort = typeof AbortController === 'function';
  const controller = supportsAbort && !init.signal ? new AbortController() : null;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error('The request timed out. Please check your connection and try again.'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetch(input, controller ? { ...init, signal: controller.signal } : init),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Initialize Supabase client (uses UMD global loaded from CDN). A bounded
// fetch prevents embedded browsers from leaving the booking button hanging.
const _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { fetch: (input, init) => _pbFetchWithTimeout(input, init) },
});

// Expose globally so HTML pages can use real-time subscriptions
window._supabase = _sb;

const PB_IS_LOCAL_HOST = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
const PB_DATA_MODE_KEY = 'pb_data_mode';

// Recovery guard: the Backyard Pickle preview was briefly served from the
// Korte domain and could leave its browser-only demo database behind. Korte
// must always use its dedicated Supabase data in production.
const PB_IS_KORTE_PRODUCTION = ['kortedoscdo.club', 'www.kortedoscdo.club']
  .includes(location.hostname.toLowerCase());

if (PB_IS_KORTE_PRODUCTION) {
  try {
    localStorage.removeItem('backyard_pickle_data_mode');
    localStorage.removeItem('backyard_pickle_local_db_v1');
  } catch (_) {
    // Storage can be unavailable in strict privacy modes; remote data still wins.
  }
}

if (PB_IS_LOCAL_HOST) {
  const params = new URLSearchParams(location.search);
  if (['1', 'true', 'local'].includes((params.get('localData') || '').toLowerCase())) {
    localStorage.setItem(PB_DATA_MODE_KEY, 'local');
  }
  if (['1', 'true', 'remote'].includes((params.get('remoteData') || '').toLowerCase())) {
    localStorage.removeItem(PB_DATA_MODE_KEY);
  }
}

window.PB_USE_LOCAL_DATA = !PB_IS_KORTE_PRODUCTION &&
  PB_IS_LOCAL_HOST &&
  localStorage.getItem(PB_DATA_MODE_KEY) === 'local';

const PB_FAST_CACHE_MS = {
  courts: 60000,
  settings: 30000,
  blockedDates: 30000,
  bookings: 3500,
  openPlay: 3500,
};
const _pbFastCache = new Map();

function _pbClone(value) {
  if (value == null) return value;
  try {
    if (typeof structuredClone === 'function') return structuredClone(value);
  } catch(_) {}
  try { return JSON.parse(JSON.stringify(value)); } catch(_) { return value; }
}

function _pbCacheKey(scope, params = {}) {
  const suffix = Object.entries(params || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : String(value)}`)
    .join('&');
  return suffix ? `${scope}:${suffix}` : scope;
}

async function _pbCached(scope, params, ttlMs, loader) {
  const key = _pbCacheKey(scope, params);
  const hit = _pbFastCache.get(key);
  const now = Date.now();
  if (hit?.promise) return _pbClone(await hit.promise);
  if (hit && now - hit.at < ttlMs) return _pbClone(hit.value);

  const promise = Promise.resolve()
    .then(loader)
    .then(value => {
      _pbFastCache.set(key, { at: Date.now(), value });
      return value;
    })
    .catch(err => {
      _pbFastCache.delete(key);
      throw err;
    });
  _pbFastCache.set(key, { at: now, promise });
  return _pbClone(await promise);
}

function _pbClearFastCache(scopes = []) {
  const list = Array.isArray(scopes) ? scopes.filter(Boolean) : [scopes].filter(Boolean);
  if (list.length === 0) { _pbFastCache.clear(); return; }
  for (const key of [..._pbFastCache.keys()]) {
    if (list.some(scope => key === scope || key.startsWith(`${scope}:`))) _pbFastCache.delete(key);
  }
}

function _safeJsonParse(v) {
  try { return JSON.parse(v); } catch(_) { return null; }
}

function _pbFileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) { reject(new Error('Receipt screenshot is required.')); return; }
    if (typeof FileReader !== 'function') { reject(new Error('This browser cannot read the selected receipt.')); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read the selected receipt.'));
    reader.readAsDataURL(file);
  });
}

async function _pbPrepareReceiptImage(file) {
  if (!file) throw new Error('Receipt screenshot is required.');
  const rawType = String(file.type || '').toLowerCase();
  const type = rawType === 'image/jpg' ? 'image/jpeg' : rawType;
  const directlySupported = ['image/jpeg', 'image/png', 'image/webp'].includes(type);
  const targetBytes = 1250 * 1024;

  // Small normal screenshots should stay byte-for-byte unchanged. Normalize
  // the non-standard image/jpg MIME label because Storage expects image/jpeg.
  if (file.size <= targetBytes && directlySupported) {
    if (rawType === type) return file;
    try { return file.slice(0, file.size, type); } catch (_) { return file; }
  }

  // Reduce large phone screenshots before crossing a fragile embedded-browser
  // bridge. If the WebView cannot decode/canvas the image, retain the original
  // and let the multipart/Base64 transport fallback handle it.
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return file;
  let objectUrl = '';
  try {
    objectUrl = URL.createObjectURL(file);
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('The selected receipt image could not be decoded.'));
      el.src = objectUrl;
    });
    const maxDimension = 1800;
    const scale = Math.min(1, maxDimension / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
    const width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
    const height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, width, height);
    const encode = quality => new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    let encoded = await encode(0.84);
    if (encoded?.size > targetBytes) encoded = await encode(0.72);
    return encoded?.size ? encoded : file;
  } catch (_) {
    return file;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

async function _pbVerifyReceiptBase64Fallback(fnUrl, payload, imageFile) {
  const imageBase64 = await _pbFileToDataUrl(imageFile);
  const fallbackPayload = {
    action: 'verify',
    bookingRef: String(payload?.bookingRef || ''),
    provider: String(payload?.provider || 'gcash'),
    contentType: imageFile?.type || payload?.contentType || 'image/jpeg',
    imageBase64,
    ...(payload?.bookingData ? { bookingData: payload.bookingData } : {}),
  };
  const res = await _pbFetchWithTimeout(fnUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(fallbackPayload),
  }, PB_RECEIPT_TIMEOUT_MS);
  const txt = await res.text();
  const json = _safeJsonParse(txt);
  if (!res.ok) throw new Error(json?.error || txt || `HTTP ${res.status}`);
  if (!json) throw new Error('Receipt verification returned an invalid response.');
  return json;
}

function _extractFnError(err, fallback = 'Edge Function request failed') {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message);
  if (err.error_description) return String(err.error_description);
  if (err.error) return String(err.error);
  if (err.context) {
    const parsed = _safeJsonParse(err.context);
    if (parsed?.error) return String(parsed.error);
    if (typeof err.context === 'string') return err.context;
  }
  try { return JSON.stringify(err); } catch(_) { return fallback; }
}

async function _invokePaymentSessionFallback(payload) {
  const fnUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/create-payment-session`;
  const sess = await _sb.auth.getSession();
  const accessToken = sess?.data?.session?.access_token || '';
  const authHeader = accessToken ? `Bearer ${accessToken}` : `Bearer ${SUPABASE_ANON_KEY}`;

  let res;
  try {
    res = await fetch(fnUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': authHeader,
      },
      body: JSON.stringify(payload),
    });
  } catch (networkErr) {
    throw new Error(`Cannot reach Edge Function endpoint (${fnUrl}). ${_extractFnError(networkErr, 'Network error')}`);
  }

  const txt = await res.text();
  const json = _safeJsonParse(txt);
  if (!res.ok) {
    const reason = json?.error || txt || `HTTP ${res.status}`;
    throw new Error(`Edge Function HTTP ${res.status}: ${reason}`);
  }
  if (!json || json.ok !== true || !json.checkoutUrl) {
    throw new Error(`Invalid Edge Function response: ${txt || 'empty body'}`);
  }
  return json;
}

async function _invokeEdgeFunction(name, payload = {}, { allowFailure = false, preferDirect = false } = {}) {
  let data = null;
  let error = null;
  if (!preferDirect) {
    try {
      ({ data, error } = await _sb.functions.invoke(name, { body: payload }));
    } catch (invokeErr) {
      error = invokeErr;
    }
    if (!error && data) return data;
  }

  const fnUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/${name}`;
  const sess = await _sb.auth.getSession();
  const accessToken = sess?.data?.session?.access_token || '';
  const authHeader = accessToken ? `Bearer ${accessToken}` : `Bearer ${SUPABASE_ANON_KEY}`;

  try {
    const res = await fetch(fnUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': authHeader,
      },
      body: JSON.stringify(payload),
    });
    const txt = await res.text();
    const json = _safeJsonParse(txt) || {};
    if (!res.ok) throw new Error(json.error || txt || `HTTP ${res.status}`);
    return json;
  } catch (fallbackErr) {
    const fallbackReason = _extractFnError(fallbackErr, 'Fallback call failed');
    const reason = error ? `${_extractFnError(error, 'Function invoke failed')}. ${fallbackReason}` : fallbackReason;
    if (allowFailure) return { ok: false, error: reason };
    throw new Error(reason);
  }
}

async function _authRestHeaders(extra = {}) {
  const sess = await _sb.auth.getSession();
  const accessToken = sess?.data?.session?.access_token || '';
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${accessToken || SUPABASE_ANON_KEY}`,
    ...extra,
  };
}

function _bookingEmailPayload(b) {
  const items = Array.isArray(b.items) && b.items.length
    ? b.items
    : Array.isArray(b.groupItems) && b.groupItems.length
      ? b.groupItems
      : [];
  return {
    bookingRef: b.displayRef || b.ref,
    email: b.email,
    fullName: b.fullName,
    courtName: b.courtName,
    date: b.date,
    startTime: b.startTime,
    endTime: b.endTime,
    duration: b.duration,
    total: b.total,
    downpayment: b.paymentStatus === 'paid' ? Number(b.total || 0) : (b.downpayment || Math.round((b.total || 0) * 0.5)),
    hostBooking: !!b.hostBooking,
    balanceDueAt: b.balanceDueAt || null,
    remainingBalance: b.paymentStatus === 'paid' ? 0 : Math.max(0, Number(b.total || 0) - Number(b.downpayment || 0)),
    contactNumber: b.contactNumber,
    bookingItems: items.map(item => ({
      courtName: item.courtName,
      date: item.date,
      startTime: item.startTime,
      endTime: item.endTime,
      duration: item.duration,
      total: item.total,
      downpayment: item.downpayment,
    })),
  };
}

function _telegramBookingPayload(b, extras = {}) {
  return {
    bookingRef: b.ref,
    fullName: b.fullName,
    contactNumber: b.contactNumber,
    courtName: b.courtName,
    date: b.date,
    startTime: b.startTime,
    endTime: b.endTime,
    duration: b.duration,
    total: b.total,
    downpayment: b.downpayment || Math.round((b.total || 0) * 0.5),
    paymentMethod: b.paymentMethod,
    paymentStatus: b.paymentStatus,
    bookingStatus: b.status,
    gcashRef: b.gcashRef || null,
    ...extras,
  };
}

// =============================================
// ROW ↔ JS OBJECT MAPPING
// SQL uses snake_case; JS objects use camelCase
// =============================================
const PB_DIGITAL_PAYMENT_METHODS = ['gcash', 'bdopay', 'maya', 'bpi', 'maribank', 'gotyme', 'pnb'];

function normalizePaymentKey(value, fallback = '') {
  return String(value || fallback || '').toLowerCase().trim();
}

function receivedAccountForBooking(b = {}) {
  const explicit = normalizePaymentKey(b.receivedAccount || b.received_account);
  if (explicit) return explicit;

  const method = normalizePaymentKey(b.paymentMethod || b.payment_method, 'cash');
  if (method === 'cash') return 'cash';
  return 'gcash';
}

function _fmtBookingHour(h) {
  const hour = Number(h);
  if (!Number.isFinite(hour)) return '';
  const normalized = ((hour % 24) + 24) % 24;
  const labelHour = normalized % 12 || 12;
  const suffix = normalized < 12 ? 'AM' : 'PM';
  return `${labelHour}:00 ${suffix}`;
}

function _bookingSlotsTimeLabel(slots, fallbackStart = '', fallbackEnd = '') {
  const sorted = [...(slots || [])].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return fallbackStart && fallbackEnd ? `${fallbackStart} - ${fallbackEnd}` : '';
  const groups = [];
  sorted.forEach(h => {
    const last = groups[groups.length - 1];
    if (last && h === last.end) last.end = h + 1;
    else groups.push({ start: h, end: h + 1 });
  });
  return groups.map(g => `${_fmtBookingHour(g.start)} - ${_fmtBookingHour(g.end)}`).join(', ');
}

function rowToBooking(r) {
  const slots = r.slots || [];
  return {
    ref:           r.ref,
    groupRef:      r.booking_group_ref || null,
    fullName:      r.full_name,
    contactNumber: r.contact_number,
    email:         r.email,
    courtId:       r.court_id,
    courtName:     r.court_name,
    date:          r.date,
    slots,
    startTime:     r.start_time,
    endTime:       r.end_time,
    timeLabel:     _bookingSlotsTimeLabel(slots, r.start_time, r.end_time),
    duration:      r.duration,
    rate:          r.rate,
    total:         r.total,
    paymentMethod: r.payment_method,
    receivedAccount: receivedAccountForBooking(r),
    paymentFlow:   r.payment_flow || null,
    paymentStatus: r.payment_status || 'unpaid',
    paymentProvider: r.payment_provider || null,
    paymentSessionId: r.payment_session_id || null,
    paymentCheckoutUrl: r.payment_checkout_url || null,
    paidAt:        r.paid_at || null,
    gcashRef:      r.gcash_ref || null,
    downpayment:   r.downpayment || null,
    balanceDueAt:  r.balance_due_at || null,
    forfeitedAt:   r.forfeited_at || null,
    forfeitureReason: r.forfeiture_reason || null,
    hostBooking:   !!r.host_booking,
    hostUserId:    r.host_user_id || null,
    hostName:      r.host_name || null,
    hostEmail:     r.host_email || null,
    createdVia:    r.created_via || 'customer',
    createdByUserId: r.created_by_user_id || null,
    createdByRole:   r.created_by_role || null,
    createdByName:   r.created_by_name || null,
    createdByEmail:  r.created_by_email || null,
    receiptStatus:     r.receipt_status || 'none',
    receiptFlags:      r.receipt_flags || [],
    receiptExtracted:  r.receipt_extracted || null,
    receiptConfidence: r.receipt_confidence != null ? Number(r.receipt_confidence) : null,
    receiptImageUrl:   r.receipt_image_url || null,
    receiptVerifiedAt: r.receipt_verified_at || null,
    billedAt:      r.billed_at || null,
    weeklyFeeId:   r.weekly_fee_id || null,
    confirmationEmailId: r.confirmation_email_id || null,
    confirmationEmailSentAt: r.confirmation_email_sent_at || null,
    confirmationEmailLastEvent: r.confirmation_email_last_event || null,
    status:        r.status,
    createdAt:     r.created_at,
  };
}

function archivePayloadToBooking(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return Object.prototype.hasOwnProperty.call(payload, 'full_name') || Object.prototype.hasOwnProperty.call(payload, 'court_id')
    ? rowToBooking(payload)
    : payload;
}

function rowToDeletedBookingArchive(r) {
  return {
    id: r.id,
    bookingRef: r.booking_ref,
    source: r.source,
    originalBooking: archivePayloadToBooking(r.original_booking),
    originalBookingRow: r.original_booking || null,
    recoveredBooking: archivePayloadToBooking(r.recovered_booking),
    recoveredBookingRow: r.recovered_booking || null,
    recoveryStatus: r.recovery_status,
    recoveredFrom: r.recovered_from,
    notes: r.notes,
    voidedFeeAmount: r.voided_fee_amount,
    voidReason: r.void_reason,
    voidedAt: r.voided_at,
    voidedBy: r.voided_by,
    deletedAt: r.deleted_at,
    archivedAt: r.archived_at,
    restoredAt: r.restored_at,
    restoredBy: r.restored_by,
    createdAt: r.created_at,
  };
}

const PB_RESERVATION_HOLD_MINUTES = 15;

function bookingHoldsSlotForConflict(b) {
  if (!b || b.status === 'cancelled' || b.status === 'forfeited') return false;
  if (b.status !== 'verifying') return true;

  const created = b.created_at || b.createdAt;
  if (!created) return true;

  const createdMs = new Date(created).getTime();
  if (!Number.isFinite(createdMs)) return true;

  return (Date.now() - createdMs) < PB_RESERVATION_HOLD_MINUTES * 60 * 1000;
}

function hasSlotConflict(existingBookings, booking) {
  const requested = new Set((booking.slots || []).map(Number));
  if (requested.size === 0) return false;

  return (existingBookings || [])
    .filter(bookingHoldsSlotForConflict)
    .flatMap(b => b.slots || [])
    .some(slot => requested.has(Number(slot)));
}

function bookingToRow(b) {
  return {
    ref:            b.ref,
    booking_group_ref: b.groupRef || null,
    full_name:      b.fullName,
    contact_number: b.contactNumber,
    email:          b.email,
    court_id:       b.courtId,
    court_name:     b.courtName,
    date:           b.date,
    slots:          b.slots,
    start_time:     b.startTime,
    end_time:       b.endTime,
    duration:       b.duration,
    rate:           b.rate,
    total:          b.total,
    payment_method: b.paymentMethod,
    received_account: receivedAccountForBooking(b),
    payment_flow:   b.paymentFlow || null,
    payment_status: b.paymentStatus || 'unpaid',
    payment_provider: b.paymentProvider || null,
    payment_session_id: b.paymentSessionId || null,
    payment_checkout_url: b.paymentCheckoutUrl || null,
    paid_at:        b.paidAt || null,
    gcash_ref:      b.gcashRef || null,
    downpayment:    b.downpayment || null,
    host_booking:   !!b.hostBooking,
    host_user_id:   b.hostUserId || null,
    host_name:      b.hostName || null,
    host_email:     b.hostEmail || null,
    created_via:    b.createdVia || 'customer',
    created_by_user_id: b.createdByUserId || null,
    created_by_role:    b.createdByRole || null,
    created_by_name:    b.createdByName || null,
    created_by_email:   b.createdByEmail || null,
    status:         b.status,
    created_at:     b.createdAt,
  };
}

function withoutOptionalBookingColumns(row) {
  const copy = { ...row };
  delete copy.host_booking;
  delete copy.host_user_id;
  delete copy.host_name;
  delete copy.host_email;
  delete copy.created_via;
  delete copy.created_by_user_id;
  delete copy.created_by_role;
  delete copy.created_by_name;
  delete copy.created_by_email;
  return copy;
}

function isMissingOptionalBookingColumnError(error) {
  return /host_booking|host_user_id|host_name|host_email|created_via|created_by_user_id|created_by_role|created_by_name|created_by_email/i.test(error?.message || '');
}

function rowToCourt(r) {
  return {
    id:           r.id,
    name:         r.name,
    desc:         r.description,
    rate:         r.rate,
    blocked:      r.blocked,
    feats:        r.feats || [],
    photo:        r.photo || '',
    rateSchedule: r.rate_schedule || null,
  };
}

function courtToRow(c) {
  return {
    id:            c.id,
    name:          c.name,
    description:   c.desc,
    rate:          c.rate,
    blocked:       c.blocked,
    feats:         c.feats || [],
    photo:         c.photo || null,
    rate_schedule: c.rateSchedule || null,
  };
}

function rowToAccount(r) {
  return {
    id:        r.id,
    username:  r.username,
    role:      r.role,
    status:    r.status || 'active',
    fullName:  r.full_name,
    email:     r.email,
    createdAt: r.created_at,
  };
}

function _remittanceProofUpload(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i);
  if (!match) throw new Error('Choose a valid receipt image.');
  const mimeType = match[1].toLowerCase();
  const binary = atob(match[2].replace(/\s/g, ''));
  if (!binary.length) throw new Error('The receipt image is empty.');
  if (binary.length > 5 * 1024 * 1024) throw new Error('Receipt image must be 5 MB or smaller.');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const extByType = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
  };
  if (!extByType[mimeType]) {
    throw new Error('Receipt must be a JPG, PNG, WebP, HEIC, or HEIF image.');
  }
  return { bytes, mimeType, extension: extByType[mimeType] };
}

function _remittanceIdempotencyKey(prefix = 'remit') {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

function rowToHostFinanceAccount(r = {}) {
  const id = r.id || r.host_user_id || r.hostUserId || null;
  return {
    id,
    fullName:  r.full_name ?? r.fullName ?? '',
    email:     r.email ?? '',
    role:      'host',
    status:    r.status || 'active',
    createdAt: r.created_at ?? r.createdAt ?? null,
  };
}

function accountToRow(a) {
  return {
    id:         a.id,
    username:   a.username,
    role:       a.role,
    status:     a.status || 'active',
    full_name:  a.fullName,
    email:      a.email,
    created_at: a.createdAt,
  };
}

function rowToOpenPlayHostApplication(r) {
  return {
    id: r.id,
    fullName: r.full_name,
    contactNumber: r.contact_number,
    email: r.email,
    hostUserId: r.host_user_id || null,
    gcashNumber: r.gcash_number || '',
    validIdFileName: r.valid_id_file_name || '',
    validIdFileType: r.valid_id_file_type || '',
    validIdFileSize: r.valid_id_file_size || null,
    validIdPath: r.valid_id_path || '',
    preferredSchedule: r.preferred_schedule || '',
    notes: r.notes || '',
    status: r.status || 'pending',
    reviewedBy: r.reviewed_by || null,
    reviewedAt: r.reviewed_at || null,
    reviewNote: r.review_note || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function hostApplicationToRow(app) {
  return {
    full_name: app.fullName,
    contact_number: app.contactNumber,
    email: app.email,
    gcash_number: app.gcashNumber || null,
    valid_id_file_name: app.validIdFileName || null,
    valid_id_file_type: app.validIdFileType || null,
    valid_id_file_size: app.validIdFileSize || null,
    valid_id_path: app.validIdPath || null,
    preferred_schedule: app.preferredSchedule || null,
    notes: app.notes || null,
    status: app.status || 'pending',
    review_note: app.reviewNote || null,
  };
}

function rowToOpenPlayHostSession(r) {
  return {
    id: r.id,
    hostUserId: r.host_user_id || null,
    hostName: r.host_name,
    hostEmail: r.host_email || '',
    title: r.title,
    date: r.date,
    startHour: Number(r.start_hour),
    endHour: Number(r.end_hour),
    courtIds: r.court_ids || [],
    courtNames: r.court_names || [],
    maxPlayers: Number(r.max_players || 0),
    feePerPlayer: Number(r.fee_per_player || 0),
    status: r.status || 'published',
    notes: r.notes || '',
    paymentInstructions: r.payment_instructions || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function hostSessionToRow(session) {
  return {
    host_user_id: session.hostUserId || null,
    host_name: session.hostName,
    host_email: session.hostEmail || null,
    title: session.title,
    date: session.date,
    start_hour: session.startHour,
    end_hour: session.endHour,
    court_ids: session.courtIds || [],
    court_names: session.courtNames || [],
    max_players: session.maxPlayers || 16,
    fee_per_player: session.feePerPlayer || 0,
    status: session.status || 'published',
    notes: session.notes || null,
    payment_instructions: session.paymentInstructions || null,
  };
}

function rowToOpenPlayHostSessionRegistration(r) {
  return {
    id: r.id,
    sessionId: r.session_id,
    fullName: r.full_name,
    contactNumber: r.contact_number || '',
    paymentMethod: r.payment_method || 'gcash',
    gcashRef: r.gcash_ref || null,
    paymentStatus: r.payment_status || 'pending',
    amount: Number(r.amount || 0),
    receiptImageUrl: r.receipt_image_url || null,
    receiptImageHash: r.receipt_image_hash || null,
    receiptVerificationId: r.receipt_verification_id ?? null,
    receiptPhash: r.receipt_phash || null,
    receiptStatus: r.receipt_status || 'none',
    receiptFlags: r.receipt_flags || [],
    receiptExtracted: r.receipt_extracted || null,
    receiptConfidence: r.receipt_confidence != null ? Number(r.receipt_confidence) : null,
    receiptVerifiedAt: r.receipt_verified_at || null,
    capacityException: Boolean(r.capacity_exception),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// =============================================
// DB — Async Data Layer (replaces localStorage)
// =============================================
window.DB = {

  // ---- COURTS ----
  async getCourts() {
    return _pbCached('courts', {}, PB_FAST_CACHE_MS.courts, async () => {
      const { data, error } = await _sb.from('courts').select('*').order('id');
      if (error) { console.error('getCourts:', error); return []; }
      return data.map(rowToCourt);
    });
  },

  async saveCourt(court) {
    const { error } = await _sb.from('courts').upsert(courtToRow(court));
    if (error) { console.error('saveCourt:', error); throw error; }
    _pbClearFastCache(['courts']);
  },

  async deleteCourt(id) {
    const { error } = await _sb.from('courts').delete().eq('id', id);
    if (error) console.error('deleteCourt:', error);
    _pbClearFastCache(['courts']);
  },

  // ---- BOOKINGS ----
  async getBookings(filters = {}) {
    const opts = filters || {};
    return _pbCached('bookings', opts, PB_FAST_CACHE_MS.bookings, async () => {
      let query = _sb.from('bookings').select('*').order('created_at', { ascending: false });
      if (opts.date) query = query.eq('date', opts.date);
      if (opts.courtId) query = query.eq('court_id', String(opts.courtId));
      if (opts.hostUserId) query = query.eq('host_user_id', String(opts.hostUserId));
      if (opts.activeOnly) query = query.neq('status', 'cancelled').neq('status', 'forfeited');
      const { data, error } = await query;
      if (error) {
        console.error('getBookings:', error);
        // Host history is an authenticated, identity-scoped view. Surface an
        // RLS/schema failure instead of presenting it as an empty history.
        if (opts.hostUserId) throw error;
        return [];
      }
      return data.map(rowToBooking);
    });
  },

  async addBooking(booking) {
    // Check for slot conflicts before inserting
    const { data: existing } = await _sb
      .from('bookings')
      .select('ref, status, slots, created_at')
      .eq('court_id', booking.courtId)
      .eq('date', booking.date)
      .neq('status', 'cancelled')
      .neq('status', 'forfeited');

    if (hasSlotConflict(existing, booking)) {
      throw new Error('One or more time slots are no longer available. Please refresh and choose a different time.');
    }

    const row = bookingToRow(booking);
    let { error } = await _sb.from('bookings').insert(row);
    if (error && isMissingOptionalBookingColumnError(error) && !booking.hostBooking) {
      ({ error } = await _sb.from('bookings').insert(withoutOptionalBookingColumns(row)));
    }
    if (error) { console.error('addBooking:', error); throw error; }
    _pbClearFastCache(['bookings']);
  },

  async getBookingByRef(ref) {
    const { data, error } = await _sb.from('bookings').select('*').eq('ref', ref).single();
    if (error) { console.error('getBookingByRef:', error); return null; }
    return rowToBooking(data);
  },

  async updateBooking(ref, updates) {
    // Map only the fields provided (camelCase → snake_case)
    const row = {};
    if (updates.status    !== undefined) row.status = updates.status;
    if (updates.groupRef  !== undefined) row.booking_group_ref = updates.groupRef;
    if (updates.fullName  !== undefined) row.full_name = updates.fullName;
    if (updates.contactNumber !== undefined) row.contact_number = updates.contactNumber;
    if (updates.email     !== undefined) row.email = updates.email;
    if (updates.total     !== undefined) row.total = updates.total;
    if (updates.paymentMethod !== undefined) row.payment_method = updates.paymentMethod;
    if (updates.receivedAccount !== undefined) row.received_account = receivedAccountForBooking(updates);
    else if (updates.paymentMethod !== undefined) row.received_account = receivedAccountForBooking(updates);
    if (updates.paymentStatus !== undefined) row.payment_status = updates.paymentStatus;
    if (updates.paymentFlow !== undefined) row.payment_flow = updates.paymentFlow;
    if (updates.paymentProvider !== undefined) row.payment_provider = updates.paymentProvider;
    if (updates.paymentSessionId !== undefined) row.payment_session_id = updates.paymentSessionId;
    if (updates.paymentCheckoutUrl !== undefined) row.payment_checkout_url = updates.paymentCheckoutUrl;
    if (updates.paidAt !== undefined) row.paid_at = updates.paidAt;
    if (updates.gcashRef !== undefined) row.gcash_ref = updates.gcashRef;
    if (updates.downpayment !== undefined) row.downpayment = updates.downpayment;
    if (updates.balanceDueAt !== undefined) row.balance_due_at = updates.balanceDueAt;
    if (updates.forfeitedAt !== undefined) row.forfeited_at = updates.forfeitedAt;
    if (updates.forfeitureReason !== undefined) row.forfeiture_reason = updates.forfeitureReason;
    if (updates.hostBooking !== undefined) row.host_booking = !!updates.hostBooking;
    if (updates.hostUserId !== undefined) row.host_user_id = updates.hostUserId;
    if (updates.hostName !== undefined) row.host_name = updates.hostName;
    if (updates.hostEmail !== undefined) row.host_email = updates.hostEmail;
    if (updates.createdVia !== undefined) row.created_via = updates.createdVia;
    if (updates.createdByUserId !== undefined) row.created_by_user_id = updates.createdByUserId;
    if (updates.createdByRole !== undefined) row.created_by_role = updates.createdByRole;
    if (updates.createdByName !== undefined) row.created_by_name = updates.createdByName;
    if (updates.createdByEmail !== undefined) row.created_by_email = updates.createdByEmail;
    if (updates.date !== undefined) row.date = updates.date;
    if (updates.startTime !== undefined) row.start_time = updates.startTime;
    if (updates.endTime !== undefined) row.end_time = updates.endTime;
    if (updates.duration !== undefined) row.duration = updates.duration;
    if (updates.slots !== undefined) row.slots = updates.slots;
    if (updates.billedAt !== undefined) row.billed_at = updates.billedAt;
    if (updates.weeklyFeeId !== undefined) row.weekly_fee_id = updates.weeklyFeeId;
    if (updates.confirmationEmailId !== undefined) row.confirmation_email_id = updates.confirmationEmailId;
    if (updates.confirmationEmailSentAt !== undefined) row.confirmation_email_sent_at = updates.confirmationEmailSentAt;
    if (updates.confirmationEmailLastEvent !== undefined) row.confirmation_email_last_event = updates.confirmationEmailLastEvent;
    let { data, error } = await _sb.from('bookings').update(row).eq('ref', ref).select('ref');
    if (error && isMissingOptionalBookingColumnError(error) && !updates.hostBooking && updates.createdVia !== 'host') {
      ({ data, error } = await _sb.from('bookings').update(withoutOptionalBookingColumns(row)).eq('ref', ref).select('ref'));
    }
    if (error) { console.error('updateBooking:', error); throw error; }
    if (!Array.isArray(data) || data.length === 0) {
      const denied = new Error(`Booking ${ref} was not updated. It may have expired or this account does not have permission to change it.`);
      denied.code = 'BOOKING_UPDATE_NOT_ALLOWED';
      console.error('updateBooking:', denied);
      throw denied;
    }
    _pbClearFastCache(['bookings']);
  },

  // Stamp a set of bookings as billed on a given weekly statement (idempotent
  // audit trail; a booking is only ever billed once).
  async markBookingsBilled(refs, weeklyFeeId) {
    if (!Array.isArray(refs) || refs.length === 0) return;
    const { error } = await _sb.from('bookings')
      .update({ billed_at: new Date().toISOString(), weekly_fee_id: weeklyFeeId })
      .in('ref', refs);
    if (error) { console.error('markBookingsBilled:', error); throw error; }
    _pbClearFastCache(['bookings']);
  },

  async deleteBooking(ref) {
    const { error } = await _sb.from('bookings').delete().eq('ref', ref);
    if (error) { console.error('deleteBooking:', error); throw error; }
    _pbClearFastCache(['bookings']);
  },

  async voidDeleteBookingGroup(ref, reason) {
    const { data, error } = await _sb.rpc('void_delete_booking_group', {
      p_booking_ref: ref,
      p_reason: reason,
    });
    if (error) { console.error('voidDeleteBookingGroup:', error); throw error; }
    _pbClearFastCache(['bookings']);
    return data || null;
  },

  async getDeletedBookingArchive(filters = {}) {
    const opts = filters || {};
    let query = _sb
      .from('deleted_booking_archive')
      .select('*')
      .order('deleted_at', { ascending: false })
      .limit(Number(opts.limit || 250));
    if (opts.status) query = query.eq('recovery_status', opts.status);
    if (opts.bookingRef) query = query.eq('booking_ref', opts.bookingRef);
    const { data, error } = await query;
    if (error) { console.error('getDeletedBookingArchive:', error); throw error; }
    return (data || []).map(rowToDeletedBookingArchive);
  },

  async restoreDeletedBookingArchive(id) {
    const { data, error } = await _sb.rpc('restore_deleted_booking_archive', { p_archive_id: id });
    if (error) { console.error('restoreDeletedBookingArchive:', error); throw error; }
    _pbClearFastCache(['bookings']);
    return data ? rowToBooking(data) : null;
  },

  // ---- OPEN PLAY REGISTRATIONS ----
  async getOpenPlayRegistrations() {
    return _pbCached('openPlayRegistrations', {}, PB_FAST_CACHE_MS.openPlay, async () => {
      const { data, error } = await _sb.from('open_play_registrations').select('*').order('created_at', { ascending: false });
      if (error) { console.error('getOpenPlayRegistrations:', error); return []; }
      return data;
    });
  },

  async addOpenPlayRegistration(reg) {
    const method = normalizePaymentKey(reg.paymentMethod, 'cash');
    if (PB_DIGITAL_PAYMENT_METHODS.includes(method)) {
      const receiptVerificationId = Number(reg.receiptVerificationId);
      if (!Number.isSafeInteger(receiptVerificationId) || receiptVerificationId <= 0) {
        throw new Error('The receipt verification expired or is incomplete. Please upload the receipt again.');
      }
      const result = await _invokeEdgeFunction('verify-gcash-receipt', {
        action: 'persist_open_play_registration',
        registration: {
          fullName: reg.fullName,
          courtId: String(reg.courtId),
          courtName: reg.courtName,
          date: reg.date,
          hour: reg.hour,
          timeLabel: reg.timeLabel,
          paymentType: reg.paymentType,
          paymentMethod: method,
          gcashRef: reg.gcashRef || null,
          amount: reg.amount,
          receiptVerificationId,
          receiptImageUrl: reg.receiptImageUrl || null,
          receiptImageHash: reg.receiptImageHash || null,
        },
      }, { preferDirect: true });
      const saved = result?.registration || result?.data ||
        (result?.id ? result : null);
      if (!result?.ok || !saved?.id) {
        throw new Error(result?.error || 'Open Play registration was not saved.');
      }
      _pbClearFastCache(['openPlayRegistrations', 'openPlayCount', 'openPlayCounts']);
      return saved;
    }

    const { data, error } = await _sb.from('open_play_registrations').insert({
      full_name: reg.fullName,
      court_id: String(reg.courtId),
      court_name: reg.courtName,
      date: reg.date,
      hour: reg.hour,
      time_label: reg.timeLabel,
      payment_type: reg.paymentType,
      payment_method: reg.paymentMethod || 'cash',
      gcash_ref: reg.gcashRef || null,
      payment_status: reg.paymentStatus || 'pending',
      amount: reg.amount,
      receipt_image_url: reg.receiptImageUrl || null,
      receipt_image_hash: reg.receiptImageHash || null,
      receipt_phash: reg.receiptPhash || null,
      receipt_status: reg.receiptStatus || 'none',
      receipt_flags: reg.receiptFlags || [],
      receipt_extracted: reg.receiptExtracted || null,
      receipt_confidence: reg.receiptConfidence ?? null,
      receipt_verified_at: reg.receiptVerifiedAt || null,
      created_at: new Date().toISOString(),
    }).select('id,court_id,date,payment_status').single();
    if (error) { console.error('addOpenPlayRegistration:', error); throw error; }
    _pbClearFastCache(['openPlayRegistrations', 'openPlayCount', 'openPlayCounts']);
    return data;
  },

  async updateOpenPlayRegistration(id, updates) {
    const row = {};
    if (updates.paymentStatus !== undefined) row.payment_status = updates.paymentStatus;
    if (updates.gcashRef      !== undefined) row.gcash_ref      = updates.gcashRef;
    if (updates.receiptImageUrl !== undefined) row.receipt_image_url = updates.receiptImageUrl;
    if (updates.receiptImageHash !== undefined) row.receipt_image_hash = updates.receiptImageHash;
    if (updates.receiptPhash !== undefined) row.receipt_phash = updates.receiptPhash;
    if (updates.receiptStatus !== undefined) row.receipt_status = updates.receiptStatus;
    if (updates.receiptFlags !== undefined) row.receipt_flags = updates.receiptFlags;
    if (updates.receiptExtracted !== undefined) row.receipt_extracted = updates.receiptExtracted;
    if (updates.receiptConfidence !== undefined) row.receipt_confidence = updates.receiptConfidence;
    if (updates.receiptVerifiedAt !== undefined) row.receipt_verified_at = updates.receiptVerifiedAt;
    const { error } = await _sb.from('open_play_registrations').update(row).eq('id', id);
    if (error) { console.error('updateOpenPlayRegistration:', error); throw error; }
    _pbClearFastCache(['openPlayRegistrations', 'openPlayCount', 'openPlayCounts']);
  },

  async getOpenPlayCountForDate(date, courtId = null) {
    return _pbCached('openPlayCount', { date, courtId: courtId || '' }, PB_FAST_CACHE_MS.openPlay, async () => {
      let query = _sb.from('open_play_registrations')
        .select('id', { count: 'exact', head: true })
        .eq('date', date)
        .or('payment_status.is.null,payment_status.neq.rejected');
      if (courtId) query = query.eq('court_id', String(courtId));
      const { count, error } = await query;
      if (error) { console.error('getOpenPlayCountForDate:', error); return 0; }
      return count || 0;
    });
  },

  async getOpenPlayCountsForDate(date) {
    return _pbCached('openPlayCounts', { date }, PB_FAST_CACHE_MS.openPlay, async () => {
      const { data, error } = await _sb.from('open_play_registrations')
        .select('court_id')
        .eq('date', date)
        .or('payment_status.is.null,payment_status.neq.rejected');
      if (error) { console.error('getOpenPlayCountsForDate:', error); return {}; }
      return (data || []).reduce((counts, row) => {
        const key = String(row.court_id || '');
        counts[key] = (counts[key] || 0) + 1;
        return counts;
      }, {});
    });
  },

  async deleteOpenPlayRegistration(id) {
    const { error } = await _sb.from('open_play_registrations').delete().eq('id', id);
    if (error) console.error('deleteOpenPlayRegistration:', error);
    _pbClearFastCache(['openPlayRegistrations', 'openPlayCount', 'openPlayCounts']);
  },

  // ---- OPEN PLAY HOSTS ----
  async getOpenPlayHostApplications() {
    const { data, error } = await _sb.from('open_play_host_applications').select('*').order('created_at', { ascending: false });
    if (error) { console.error('getOpenPlayHostApplications:', error); return []; }
    return (data || []).map(rowToOpenPlayHostApplication);
  },

  async addOpenPlayHostApplication(app) {
    if (app.password || app.validIdBase64) {
      return this.submitOpenPlayHostSignup(app);
    }
    const row = {
      ...hostApplicationToRow(app),
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    let { error } = await _sb.from('open_play_host_applications').insert(row);
    if (error && /gcash_number|valid_id_|host_user_id/i.test(error.message || '')) {
      const fallback = {
        full_name: row.full_name,
        contact_number: row.contact_number,
        email: row.email,
        preferred_schedule: row.preferred_schedule,
        notes: row.notes,
        status: row.status,
        created_at: row.created_at,
      };
      ({ error } = await _sb.from('open_play_host_applications').insert(fallback));
    }
    if (error) { console.error('addOpenPlayHostApplication:', error); throw error; }
  },

  async submitOpenPlayHostSignup(app) {
    const data = await _invokeEdgeFunction('host-application', {
      action: 'signup',
      fullName: app.fullName,
      contactNumber: app.contactNumber,
      email: app.email,
      password: app.password,
      gcashNumber: app.gcashNumber,
      validIdBase64: app.validIdBase64,
      validIdFileName: app.validIdFileName,
      validIdFileType: app.validIdFileType,
      validIdFileSize: app.validIdFileSize,
      notes: app.notes || '',
    }, { preferDirect: true });
    if (data?.error) throw new Error(data.error);
    return data;
  },

  async getOpenPlayHostIdSignedUrl(applicationId) {
    const data = await _invokeEdgeFunction('host-application', { action: 'sign-valid-id', applicationId }, { preferDirect: true });
    if (!data?.url) throw new Error(data?.error || 'No valid ID available.');
    return data.url;
  },

  async updateOpenPlayHostApplication(id, updates) {
    const row = {};
    if (updates.status !== undefined) row.status = updates.status;
    if (updates.reviewNote !== undefined) row.review_note = updates.reviewNote;
    if (updates.reviewedBy !== undefined) row.reviewed_by = updates.reviewedBy;
    if (updates.reviewedAt !== undefined) row.reviewed_at = updates.reviewedAt;
    const { data, error } = await _sb.from('open_play_host_applications').update(row).eq('id', id).select('*').single();
    if (error) { console.error('updateOpenPlayHostApplication:', error); throw error; }
    return data ? rowToOpenPlayHostApplication(data) : null;
  },

  async reviewOpenPlayHostApplication(id, status, reviewNote = '') {
    const data = await _invokeEdgeFunction('host-application', { action: 'review', applicationId: id, status, reviewNote }, { preferDirect: true });
    if (data?.error) throw new Error(data.error);
    if (!data?.ok) throw new Error('Host review did not return a successful activation result.');
    return data;
  },

  async repairOpenPlayHostActivation(id) {
    const data = await _invokeEdgeFunction('host-application', {
      action: 'repair-activation',
      applicationId: id,
    }, { preferDirect: true });
    if (data?.error) throw new Error(data.error);
    if (!data?.ok) throw new Error('Host login repair did not complete successfully.');
    return data;
  },

  async getOpenPlayHostSessions() {
    const { data, error } = await _sb.from('open_play_host_sessions').select('*').order('date', { ascending: true }).order('start_hour', { ascending: true });
    if (error) { console.error('getOpenPlayHostSessions:', error); return []; }
    return (data || []).map(rowToOpenPlayHostSession);
  },

  async createOpenPlayHostSession(session) {
    const { data, error } = await _sb.from('open_play_host_sessions').insert(hostSessionToRow(session)).select('*').single();
    if (error) { console.error('createOpenPlayHostSession:', error); throw error; }
    return rowToOpenPlayHostSession(data);
  },

  async updateOpenPlayHostSession(id, updates) {
    const row = {};
    if (updates.status !== undefined) row.status = updates.status;
    if (updates.title !== undefined) row.title = updates.title;
    if (updates.date !== undefined) row.date = updates.date;
    if (updates.startHour !== undefined) row.start_hour = updates.startHour;
    if (updates.endHour !== undefined) row.end_hour = updates.endHour;
    if (updates.courtIds !== undefined) row.court_ids = updates.courtIds;
    if (updates.courtNames !== undefined) row.court_names = updates.courtNames;
    if (updates.maxPlayers !== undefined) row.max_players = updates.maxPlayers;
    if (updates.feePerPlayer !== undefined) row.fee_per_player = updates.feePerPlayer;
    if (updates.notes !== undefined) row.notes = updates.notes;
    if (updates.paymentInstructions !== undefined) row.payment_instructions = updates.paymentInstructions;
    const { data, error } = await _sb.from('open_play_host_sessions').update(row).eq('id', id).select('*').single();
    if (error) { console.error('updateOpenPlayHostSession:', error); throw error; }
    return data ? rowToOpenPlayHostSession(data) : null;
  },

  async getOpenPlayHostSessionRegistrations(sessionId = null) {
    let query = _sb.from('open_play_host_session_registrations').select('*').order('created_at', { ascending: false });
    if (sessionId) query = query.eq('session_id', sessionId);
    const { data, error } = await query;
    if (error) { console.error('getOpenPlayHostSessionRegistrations:', error); return []; }
    return (data || []).map(rowToOpenPlayHostSessionRegistration);
  },

  async getOpenPlayHostSessionRegistrationCount(sessionId) {
    const { data, error } = await _sb.rpc('count_open_play_host_session_registrations', { p_session_id: sessionId });
    if (error) { console.error('getOpenPlayHostSessionRegistrationCount:', error); return 0; }
    return Number(data || 0);
  },

  async addOpenPlayHostSessionRegistration(reg) {
    const method = normalizePaymentKey(reg.paymentMethod, 'gcash');
    const digital = PB_DIGITAL_PAYMENT_METHODS.includes(method) && Number(reg.amount || 0) > 0;
    const receiptVerificationId = Number(reg.receiptVerificationId);
    if (
      digital &&
      (!Number.isSafeInteger(receiptVerificationId) || receiptVerificationId <= 0)
    ) {
      throw new Error('The receipt verification expired or is incomplete. Please upload the receipt again.');
    }
    if (digital) {
      const result = await _invokeEdgeFunction('verify-gcash-receipt', {
        action: 'persist_host_session_registration',
        registration: {
          sessionId: reg.sessionId,
          fullName: reg.fullName,
          contactNumber: reg.contactNumber || null,
          paymentMethod: method,
          gcashRef: reg.gcashRef || null,
          amount: reg.amount || 0,
          receiptVerificationId,
          receiptImageUrl: reg.receiptImageUrl || null,
          receiptImageHash: reg.receiptImageHash || null,
        },
      }, { preferDirect: true });
      const saved = result?.registration || result?.data ||
        (result?.id ? result : null);
      if (!result?.ok || !saved?.id) {
        throw new Error(result?.error || 'Host-session registration was not saved.');
      }
      return rowToOpenPlayHostSessionRegistration(saved);
    }

    const insertRow = {
      session_id: reg.sessionId,
      full_name: reg.fullName,
      contact_number: reg.contactNumber || null,
      payment_method: method,
      gcash_ref: reg.gcashRef || null,
      payment_status: reg.paymentStatus || 'pending',
      amount: reg.amount || 0,
      receipt_image_url: reg.receiptImageUrl || null,
      receipt_image_hash: reg.receiptImageHash || null,
      receipt_phash: reg.receiptPhash || null,
      receipt_status: reg.receiptStatus || 'none',
      receipt_flags: reg.receiptFlags || [],
      receipt_extracted: reg.receiptExtracted || null,
      receipt_confidence: reg.receiptConfidence ?? null,
      receipt_verified_at: reg.receiptVerifiedAt || null,
    };
    const { data, error } = await _sb.from('open_play_host_session_registrations')
      .insert(insertRow);
    if (error) {
      console.error('addOpenPlayHostSessionRegistration:', error);
      throw error;
    }
    return rowToOpenPlayHostSessionRegistration(data?.[0] || insertRow);
  },

  // ---- OPEN PLAY GAME MANAGER ----
  async getOpenPlayGameSessions() {
    const { data, error } = await _sb.from('open_play_game_sessions').select('*').order('date', { ascending: false }).order('created_at', { ascending: false });
    if (error) { console.error('getOpenPlayGameSessions:', error); return []; }
    return data || [];
  },

  async createOpenPlayGameSession(session) {
    const row = {
      date: session.date,
      time_label: session.timeLabel || null,
      court_ids: session.courtIds || [],
      court_names: session.courtNames || [],
      mode: session.mode || 'smart_random_mixer',
      status: session.status || 'draft',
      current_round: session.currentRound || 0,
    };
    const { data, error } = await _sb.from('open_play_game_sessions').insert(row).select('*').single();
    if (error) { console.error('createOpenPlayGameSession:', error); throw error; }
    return data;
  },

  async updateOpenPlayGameSession(id, updates) {
    const row = {};
    if (updates.date !== undefined) row.date = updates.date;
    if (updates.timeLabel !== undefined) row.time_label = updates.timeLabel;
    if (updates.courtIds !== undefined) row.court_ids = updates.courtIds;
    if (updates.courtNames !== undefined) row.court_names = updates.courtNames;
    if (updates.mode !== undefined) row.mode = updates.mode;
    if (updates.status !== undefined) row.status = updates.status;
    if (updates.currentRound !== undefined) row.current_round = updates.currentRound;
    const { data, error } = await _sb.from('open_play_game_sessions').update(row).eq('id', id).select('*').single();
    if (error) { console.error('updateOpenPlayGameSession:', error); throw error; }
    return data;
  },

  async getOpenPlayGamePlayers(sessionId) {
    const { data, error } = await _sb.from('open_play_game_players').select('*').eq('session_id', sessionId).order('seed_order');
    if (error) { console.error('getOpenPlayGamePlayers:', error); return []; }
    return data || [];
  },

  async replaceOpenPlayGamePlayers(sessionId, players) {
    const { error: delError } = await _sb.from('open_play_game_players').delete().eq('session_id', sessionId);
    if (delError) { console.error('replaceOpenPlayGamePlayers delete:', delError); throw delError; }
    if (!players.length) return [];
    const rows = players.map((p, i) => ({
      session_id: sessionId,
      full_name: p.fullName || p.full_name,
      source_registration_id: p.sourceRegistrationId || p.source_registration_id || null,
      status: p.status || 'active',
      seed_order: i,
    }));
    const { data, error } = await _sb.from('open_play_game_players').insert(rows).select('*').order('seed_order');
    if (error) { console.error('replaceOpenPlayGamePlayers insert:', error); throw error; }
    return data || [];
  },

  async getOpenPlayGameRounds(sessionId) {
    const { data, error } = await _sb.from('open_play_game_rounds').select('*').eq('session_id', sessionId).order('round_no');
    if (error) { console.error('getOpenPlayGameRounds:', error); return []; }
    return data || [];
  },

  async addOpenPlayGameRound(round) {
    const row = {
      session_id: round.sessionId,
      round_no: round.roundNo,
      assignments: round.assignments || [],
      queue_snapshot: round.queueSnapshot || [],
      partner_history: round.partnerHistory || {},
      opponent_history: round.opponentHistory || {},
      completed_at: round.completedAt || null,
    };
    const { data, error } = await _sb.from('open_play_game_rounds').insert(row).select('*').single();
    if (error) { console.error('addOpenPlayGameRound:', error); throw error; }
    await this.updateOpenPlayGameSession(round.sessionId, { currentRound: round.roundNo, status: 'active' }).catch(() => {});
    return data;
  },

  async updateOpenPlayGameRound(id, updates) {
    const row = {};
    if (updates.assignments !== undefined) row.assignments = updates.assignments;
    if (updates.queueSnapshot !== undefined) row.queue_snapshot = updates.queueSnapshot;
    if (updates.partnerHistory !== undefined) row.partner_history = updates.partnerHistory;
    if (updates.opponentHistory !== undefined) row.opponent_history = updates.opponentHistory;
    if (updates.completedAt !== undefined) row.completed_at = updates.completedAt;
    const { data, error } = await _sb.from('open_play_game_rounds').update(row).eq('id', id).select('*').single();
    if (error) { console.error('updateOpenPlayGameRound:', error); throw error; }
    return data;
  },

  async deleteLatestOpenPlayGameRound(sessionId) {
    const rounds = await this.getOpenPlayGameRounds(sessionId);
    const last = rounds[rounds.length - 1];
    if (!last) return null;
    const { error } = await _sb.from('open_play_game_rounds').delete().eq('id', last.id);
    if (error) { console.error('deleteLatestOpenPlayGameRound:', error); throw error; }
    await this.updateOpenPlayGameSession(sessionId, { currentRound: Math.max(0, Number(last.round_no || 1) - 1) }).catch(() => {});
    return last;
  },

  async clearOpenPlayGameRounds(sessionId) {
    const { error } = await _sb.from('open_play_game_rounds').delete().eq('session_id', sessionId);
    if (error) { console.error('clearOpenPlayGameRounds:', error); throw error; }
    await this.updateOpenPlayGameSession(sessionId, { currentRound: 0, status: 'draft' }).catch(() => {});
  },

  // ---- BLOCKED DATES ----
  async getBlockedDates() {
    return _pbCached('blockedDates', {}, PB_FAST_CACHE_MS.blockedDates, async () => {
      const { data, error } = await _sb.from('blocked_dates').select('date').order('date');
      if (error) { console.error('getBlockedDates:', error); return []; }
      return data.map(r => r.date);
    });
  },

  async addBlockedDate(date) {
    const { error } = await _sb.from('blocked_dates').insert({ date, created_at: new Date().toISOString() });
    if (error) console.error('addBlockedDate:', error);
    _pbClearFastCache(['blockedDates']);
  },

  async removeBlockedDate(date) {
    const { error } = await _sb.from('blocked_dates').delete().eq('date', date);
    if (error) console.error('removeBlockedDate:', error);
    _pbClearFastCache(['blockedDates']);
  },

  // ---- ACCOUNTS ----
  async getAccounts() {
    const { data, error } = await _sb.from('accounts').select('*').order('created_at');
    if (error) { console.error('getAccounts:', error); return []; }
    return data.map(rowToAccount);
  },

  async getHostFinanceAccounts() {
    const { data, error } = await _sb.rpc('get_host_finance_accounts');
    if (error) {
      console.error('getHostFinanceAccounts:', error);
      throw error;
    }
    return (data || []).map(rowToHostFinanceAccount).filter(account => account.id);
  },

  async getHostFinanceBookings(hostUserId) {
    const id = String(hostUserId || '').trim();
    if (!id) throw new Error('A host account is required to load finance bookings.');
    const { data, error } = await _sb.rpc('get_host_finance_bookings', { p_host_user_id: id });
    if (error) {
      console.error('getHostFinanceBookings:', error);
      throw error;
    }
    return (data || []).map(rowToBooking);
  },

  async saveAccount(account) {
    const { error } = await _sb.from('accounts').upsert(accountToRow(account));
    if (error) { console.error('saveAccount:', error); throw error; }
  },

  async deleteAccount(id) {
    const { error } = await _sb.from('accounts').delete().eq('id', id);
    if (error) console.error('deleteAccount:', error);
  },

  // ---- SETTINGS ----
  async getSettings() {
    return _pbCached('settings', {}, PB_FAST_CACHE_MS.settings, async () => {
      const { data, error } = await _sb.from('settings').select('*');
      if (error) { console.error('getSettings:', error); return {}; }
      const out = {};
      data.forEach(r => out[r.key] = r.value);
      return out;
    });
  },

  async saveSetting(key, value) {
    const { error } = await _sb.from('settings').upsert({ key, value });
    if (error) { console.error('saveSetting:', error); throw error; }
    _pbClearFastCache(['settings']);
  },

  async getPaymentReviewNotificationSettings() {
    return _invokeEdgeFunction('manage-payment-review-notification', { action: 'get' });
  },

  async savePaymentReviewNotificationEmail(email) {
    return _invokeEdgeFunction('manage-payment-review-notification', {
      action: 'save',
      email: String(email || ''),
    });
  },

  async sendPaymentReviewNotificationTest() {
    return _invokeEdgeFunction('manage-payment-review-notification', { action: 'test' });
  },

  clearCache(scopes = []) {
    _pbClearFastCache(scopes);
  },

  async createPaymentSession(payload) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error('Supabase configuration missing (SUPABASE_URL / SUPABASE_ANON_KEY).');
    }
    const { data, error } = await _sb.functions.invoke('create-payment-session', { body: payload });
    if (!error && data) return data;

    // Fallback path: direct HTTP call to the function endpoint. This helps diagnose
    // invoke-wrapper issues and still allows checkout if endpoint is reachable.
    try {
      return await _invokePaymentSessionFallback(payload);
    } catch (fallbackErr) {
      const baseReason = _extractFnError(error, 'Failed to send a request to the Edge Function');
      const fbReason = _extractFnError(fallbackErr, 'Fallback call failed');
      console.error('createPaymentSession.invokeError:', error);
      console.error('createPaymentSession.fallbackError:', fallbackErr);
      throw new Error(`${baseReason}. Fallback failed: ${fbReason}`);
    }
  },

  async sendConfirmationEmail(booking, options = {}) {
    if (!booking?.email) return { ok: false, skipped: true, reason: 'No customer email' };
    return _invokeEdgeFunction('send-confirmation-email', _bookingEmailPayload(booking), {
      allowFailure: !!options.allowFailure,
    });
  },

  async sendRescheduleEmail(payload, options = {}) {
    if (!payload?.email) return { ok: false, skipped: true, reason: 'No customer email' };
    return _invokeEdgeFunction('send-reschedule-email', payload, {
      allowFailure: !!options.allowFailure,
    });
  },

  async sendTelegramNotification(payload, options = {}) {
    return _invokeEdgeFunction('send-telegram-notification', payload, {
      allowFailure: options.allowFailure !== false,
    });
  },

  async notifyBookingSubmitted(booking) {
    if (window.PB_USE_LOCAL_DATA) return { ok: true, skipped: true, reason: 'Local data mode' };
    return this.sendTelegramNotification(_telegramBookingPayload(booking, { event: 'new_booking' }), { allowFailure: true });
  },

  async notifyBookingUpdate(booking, event, note = '') {
    if (window.PB_USE_LOCAL_DATA) return { ok: true, skipped: true, reason: 'Local data mode' };
    return this.sendTelegramNotification(_telegramBookingPayload(booking, { type: 'booking_update', event, note }), { allowFailure: true });
  },

  async reviewPaymentReceipt(bookingRef, decision, reason = '') {
    const normalizedDecision = String(decision || '').trim().toLowerCase();
    if (!['approve', 'reject'].includes(normalizedDecision)) {
      throw new Error('Choose a valid payment-review decision.');
    }
    const result = await _invokeEdgeFunction('review-payment-receipt', {
      bookingRef: String(bookingRef || '').trim(),
      decision: normalizedDecision,
      reason: String(reason || '').trim(),
    });
    if (result?.ok) _pbClearFastCache(['bookings']);
    return result;
  },

  async reviewOpenPlayPaymentReceipt(registrationId, decision, reason = '') {
    const id = Number(registrationId);
    const normalizedDecision = String(decision || '').trim().toLowerCase();
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error('Choose a valid Open Play registration.');
    }
    if (!['approve', 'reject'].includes(normalizedDecision)) {
      throw new Error('Choose a valid payment-review decision.');
    }
    const result = await _invokeEdgeFunction('review-payment-receipt', {
      contextType: 'open_play',
      registrationId: id,
      decision: normalizedDecision,
      reason: String(reason || '').trim(),
    });
    if (result?.ok) {
      _pbClearFastCache([
        'openPlayRegistrations',
        'openPlayCount',
        'openPlayCounts',
      ]);
    }
    return result;
  },

  async reviewHostSessionPaymentReceipt(registrationId, decision, reason = '') {
    const id = String(registrationId || '').trim().toLowerCase();
    const normalizedDecision = String(decision || '').trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
      throw new Error('Choose a valid host-session registration.');
    }
    if (!['approve', 'reject'].includes(normalizedDecision)) {
      throw new Error('Choose a valid payment-review decision.');
    }
    const result = await _invokeEdgeFunction('review-payment-receipt', {
      contextType: 'host_session',
      registrationId: id,
      decision: normalizedDecision,
      reason: String(reason || '').trim(),
    });
    return result;
  },

  async getIntegrationStatus() {
    return _invokeEdgeFunction('integration-status', { action: 'status' }, { allowFailure: true });
  },

  // Verify an uploaded GCash/GoTyme/PNB receipt image via the Edge Function.
  // payload: { bookingRef, provider, imageFile, contentType }.
  // imageBase64 remains supported for older deployed clients.
  // Returns: { ok, status, flags, extracted, confidence, message }
  async verifyGcashReceipt(payload) {
    // Do not use `instanceof Blob` here. Facebook/Messenger WebViews can hand
    // us a File from a different JavaScript realm, where that check is false.
    if (payload?.imageFile) {
      const fnUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/verify-gcash-receipt`;
      const imageFile = await _pbPrepareReceiptImage(payload.imageFile);
      const form = new FormData();
      form.append('action', 'verify');
      form.append('bookingRef', String(payload.bookingRef || ''));
      form.append('provider', String(payload.provider || 'gcash'));
      form.append('contentType', imageFile.type || payload.contentType || 'image/jpeg');
      if (payload.bookingData) form.append('bookingData', JSON.stringify(payload.bookingData));
      try {
        form.append('receipt', imageFile, imageFile.name || 'receipt.jpg');
      } catch (_) {
        // Older embedded WebViews may expose a file-like object that FormData
        // refuses. Base64 is a compatibility fallback, not the normal path.
        return _pbVerifyReceiptBase64Fallback(fnUrl, payload, imageFile);
      }

      const res = await _pbFetchWithTimeout(fnUrl, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: form,
      }, PB_RECEIPT_TIMEOUT_MS);
      const txt = await res.text();
      const json = _safeJsonParse(txt);
      if (!res.ok) {
        const reason = String(json?.error || txt || `HTTP ${res.status}`);
        // A small set of WebViews sends multipart headers but drops the File
        // part. Retry only when the server explicitly says it got no image;
        // never retry an uncertain timeout/network request.
        const missingMultipartImage = [400, 415, 422].includes(res.status) &&
          /receipt file|multipart body|empty image/i.test(reason);
        if (missingMultipartImage) return _pbVerifyReceiptBase64Fallback(fnUrl, payload, imageFile);
        throw new Error(reason);
      }
      if (!json) throw new Error('Receipt verification returned an invalid response.');
      return json;
    }

    const { data, error } = await _sb.functions.invoke('verify-gcash-receipt', { body: payload });
    if (!error && data) return data;

    // Fallback: direct HTTP call (mirrors createPaymentSession fallback).
    const fnUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/verify-gcash-receipt`;
    const sess = await _sb.auth.getSession();
    const accessToken = sess?.data?.session?.access_token || '';
    const authHeader = accessToken ? `Bearer ${accessToken}` : `Bearer ${SUPABASE_ANON_KEY}`;
    const res = await _pbFetchWithTimeout(fnUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': authHeader },
      body: JSON.stringify(payload),
    }, PB_RECEIPT_TIMEOUT_MS);
    const txt = await res.text();
    const json = _safeJsonParse(txt);
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
    return json;
  },

  // Request a short-lived signed URL to view a stored receipt (admin only).
  async getReceiptSignedUrl(bookingRef) {
    const { data, error } = await _sb.functions.invoke('verify-gcash-receipt', {
      body: { action: 'sign', bookingRef },
    });
    if (error) throw new Error(_extractFnError(error, 'Could not load receipt'));
    if (!data?.url) throw new Error(data?.error || 'No receipt available');
    return data.url;
  },

  async getOpenPlayReceiptSignedUrl(registrationId) {
    const { data, error } = await _sb.functions.invoke('verify-gcash-receipt', {
      body: { action: 'sign', openPlayRegistrationId: registrationId },
    });
    if (error) throw new Error(_extractFnError(error, 'Could not load receipt'));
    if (!data?.url) throw new Error(data?.error || 'No receipt available');
    return data.url;
  },

  async getHostSessionReceiptSignedUrl(registrationId) {
    const { data, error } = await _sb.functions.invoke('verify-gcash-receipt', {
      body: { action: 'sign', hostSessionRegistrationId: registrationId },
    });
    if (error) throw new Error(_extractFnError(error, 'Could not load receipt'));
    if (!data?.url) throw new Error(data?.error || 'No receipt available');
    return data.url;
  },

  // ---- SEED DEFAULT DATA (runs once on first load) ----
  async seedDefaultData() {
    const courts = await this.getCourts();
    if (courts.length === 0) {
      await _sb.from('courts').insert([
        { id: 'c1', name: 'Court Alpha', description: 'Outdoor · Air passing through · Standard Flooring', rate: 350, blocked: false, feats: ['Outdoor','Open Air','Standard Floor'], photo: null },
        { id: 'c2', name: 'Court Beta',  description: 'Outdoor · Air passing through · Standard Flooring', rate: 280, blocked: false, feats: ['Outdoor','Open Air','Standard Floor'], photo: null },
      ]);
    }
  },

  // Check if user has accepted the current agreement version
  async getAgreement(userId, version = 1) {
    const { data } = await _sb.from('agreements').select('id, full_name, agreed_at').eq('user_id', userId).eq('version', version).maybeSingle();
    return data || null;
  },

  // Save signed agreement
  async saveAgreement({ userId, email, fullName, role, signatureData, ipAddress, userAgent, version = 1 }) {
    const { error } = await _sb.from('agreements').upsert({
      user_id:        userId,
      email,
      full_name:      fullName,
      role,
      version,
      signature_data: signatureData,
      ip_address:     ipAddress || null,
      user_agent:     userAgent || null,
      agreed_at:      new Date().toISOString(),
    }, { onConflict: 'user_id,version' });
    if (error) throw error;
  },

  // ---- ACCUMULATED BOOKING-FEE REMITTANCE ----
  // Financial mutations are RPC-only so the cutoff, immutable booking items,
  // proof attempts, and audit events are committed in one database transaction.
  async getBookingFeeRemittanceDashboard() {
    const [dashboardResult, historyResult, legacyResult] = await Promise.all([
      _sb.rpc('get_booking_fee_remittance_dashboard'),
      _sb.rpc('get_booking_fee_remittance_history', { p_limit: 100, p_before: null }),
      _sb.from('weekly_fees')
        .select('id,court_owner_email,week_start,week_end,bookings_count,fee_per_booking,amount_due,status,billed_refs,generated_at,sent_at,due_at,paid_at,paid_ref,paid_note,paid_by_user_id')
        .eq('status', 'paid')
        .order('paid_at', { ascending: false }),
    ]);
    if (dashboardResult.error) throw new Error(_extractFnError(dashboardResult.error, 'Could not load remittance dashboard'));
    if (historyResult.error) throw new Error(_extractFnError(historyResult.error, 'Could not load remittance history'));
    const dashboard = dashboardResult.data || {};
    const allHistory = Array.isArray(historyResult.data) ? historyResult.data : [];
    const active = Array.isArray(dashboard.open_remittances) ? dashboard.open_remittances : [];
    const legacyPaid = legacyResult.error ? [] : (legacyResult.data || []).map(row => {
      const refs = Array.isArray(row.billed_refs) ? row.billed_refs : [];
      const amount = Number(row.amount_due) || 0;
      return {
        id: `legacy-${row.id}`,
        legacy_weekly_fee_id: row.id,
        is_legacy: true,
        remittance_ref: `LEGACY-${String(row.week_start || '').replace(/-/g, '')}-${String(row.id || '').slice(0, 6).toUpperCase()}`,
        status: 'settled',
        coverage_start_at: row.week_start ? `${row.week_start}T00:00:00+08:00` : null,
        cutoff_at: row.week_end ? `${row.week_end}T23:59:59+08:00` : null,
        cycle_due_on: String(row.due_at || row.week_end || '').slice(0, 10) || null,
        bookings_count: Number(row.bookings_count) || refs.length,
        amount_due: amount,
        amount_settled: amount,
        remaining_balance: 0,
        prepared_at: row.generated_at || row.sent_at || null,
        prepared_by_email: row.court_owner_email || null,
        settled_at: row.paid_at || null,
        billed_refs: refs,
        latest_payment: {
          amount_submitted: amount,
          amount_accepted: amount,
          payment_method: 'legacy',
          payment_reference: row.paid_ref || '',
          note: row.paid_note || 'Imported from the previous statement ledger.',
          status: 'accepted',
          reviewed_at: row.paid_at || null,
          reviewed_by_user_id: row.paid_by_user_id || null,
        },
      };
    });
    const history = [
      ...allHistory.filter(row => ['settled', 'cancelled'].includes(String(row?.status || '').toLowerCase())),
      ...legacyPaid,
    ].sort((a, b) => new Date(b.settled_at || b.prepared_at || 0) - new Date(a.settled_at || a.prepared_at || 0));
    const historySettledTotal = history
      .filter(row => String(row?.status || '').toLowerCase() === 'settled')
      .reduce((sum, row) => sum + (Number(row?.amount_settled ?? row?.amount_due) || 0), 0);
    const legacySettledTotal = legacyPaid.reduce((sum, row) => sum + (Number(row.amount_settled) || 0), 0);
    const newSettledTotal = dashboard.settled_total == null
      ? historySettledTotal - legacySettledTotal
      : (Number(dashboard.settled_total) || 0);
    return {
      ...dashboard,
      live: dashboard.accumulated || {},
      active,
      history,
      settled_total: newSettledTotal + legacySettledTotal,
    };
  },

  async sendHostBalanceNotice(bookingRef, eventType = 'reminder_1d', options = {}) {
    return _invokeEdgeFunction('process-host-balance-deadlines', {
      action: 'manual', bookingRef, eventType,
    }, { allowFailure: !!options.allowFailure });
  },

  async processHostBalanceDeadlines(options = {}) {
    return _invokeEdgeFunction('process-host-balance-deadlines', {
      action: 'process', source: 'admin',
    }, { allowFailure: options.allowFailure !== false });
  },

  async getBookingBalanceNotifications(bookingKey) {
    if (!bookingKey) return [];
    const { data, error } = await _sb.from('booking_balance_notifications')
      .select('*').eq('booking_key', bookingKey).order('created_at', { ascending: false });
    if (error) { console.error('getBookingBalanceNotifications:', error); return []; }
    return data || [];
  },

  async getBookingFeeRemittanceHistory({ limit = 30, before = null } = {}) {
    const { data, error } = await _sb.rpc('get_booking_fee_remittance_history', {
      p_limit: Math.max(1, Math.min(100, Number(limit) || 30)),
      p_before: before || null,
    });
    if (error) throw new Error(_extractFnError(error, 'Could not load remittance history'));
    return Array.isArray(data) ? data : (data || []);
  },

  async getBookingFeeRemittanceDetail(remittanceId) {
    const { data, error } = await _sb.rpc('get_booking_fee_remittance_detail', {
      p_remittance_id: remittanceId,
    });
    if (error) throw new Error(_extractFnError(error, 'Could not load remittance details'));
    return data || null;
  },

  async prepareBookingFeeRemittance({ ownerOverride = false, overrideDueOn = null, overrideReason = null } = {}) {
    const { data, error } = await _sb.rpc('prepare_booking_fee_remittance', {
      p_idempotency_key: _remittanceIdempotencyKey('prepare'),
      p_owner_override: ownerOverride === true,
      p_override_due_on: overrideDueOn || null,
      p_override_reason: overrideReason || null,
    });
    if (error) throw new Error(_extractFnError(error, 'Could not prepare remittance'));
    return data || null;
  },

  async submitBookingFeeRemittance(remittanceId, {
    amount = null,
    paymentMethod = 'gcash',
    paymentRef = '',
    proofUrl = '',
    proofData = '',
    note = '',
  } = {}) {
    const image = _remittanceProofUpload(proofData || proofUrl);
    const { data: authData, error: authError } = await _sb.auth.getUser();
    if (authError || !authData?.user?.id) throw new Error('Your session expired. Please sign in again.');

    const safeRemittanceId = String(remittanceId || '').replace(/[^a-z0-9-]/gi, '');
    if (!safeRemittanceId) throw new Error('Remittance record is missing.');
    const objectName = `${Date.now()}-${_remittanceIdempotencyKey('proof').replace(/[^a-z0-9-]/gi, '')}.${image.extension}`;
    const proofPath = `${safeRemittanceId}/${authData.user.id}/${objectName}`;
    const { error: uploadError } = await _sb.storage
      .from('remittance-proofs')
      .upload(proofPath, image.bytes, { contentType: image.mimeType, upsert: false });
    if (uploadError) throw new Error(_extractFnError(uploadError, 'Could not upload remittance receipt'));

    const { data, error } = await _sb.rpc('submit_booking_fee_remittance', {
      p_remittance_id: remittanceId,
      p_amount: amount == null ? null : Number(amount),
      p_payment_method: String(paymentMethod || 'gcash').toLowerCase(),
      p_payment_reference: String(paymentRef || '').trim(),
      p_proof_path: proofPath,
      p_note: String(note || '').trim() || null,
      p_idempotency_key: _remittanceIdempotencyKey('submit'),
    });
    if (error) {
      throw new Error(_extractFnError(error, 'Could not submit remittance proof'));
    }
    return data || null;
  },

  async getBookingFeeRemittanceProofUrl(proofPath, expiresIn = 300) {
    const path = String(proofPath || '').trim();
    if (!path) throw new Error('No remittance receipt is attached.');
    const { data, error } = await _sb.storage
      .from('remittance-proofs')
      .createSignedUrl(path, Math.max(60, Math.min(900, Number(expiresIn) || 300)));
    if (error || !data?.signedUrl) throw new Error(_extractFnError(error, 'Could not open remittance receipt'));
    return data.signedUrl;
  },

  async getBookingFeeRemittanceProofSignedUrl(proofPath, expiresIn = 300) {
    return this.getBookingFeeRemittanceProofUrl(proofPath, expiresIn);
  },

  async reviewBookingFeeRemittancePayment(paymentId, {
    approve = false,
    decision = null,
    amountAccepted = null,
    note = '',
  } = {}) {
    const requestedDecision = String(decision || (approve ? 'accept' : 'reject')).toLowerCase();
    const normalizedDecision = requestedDecision === 'approve' ? 'accept' : requestedDecision;
    const { data, error } = await _sb.rpc('review_booking_fee_remittance_payment', {
      p_payment_id: paymentId,
      p_decision: normalizedDecision,
      p_amount_accepted: amountAccepted == null ? null : Number(amountAccepted),
      p_review_note: String(note || '').trim() || null,
      p_idempotency_key: _remittanceIdempotencyKey('review'),
    });
    if (error) throw new Error(_extractFnError(error, 'Could not review remittance payment'));
    return data || null;
  },

  async cancelBookingFeeRemittance(remittanceId, reason = '') {
    const { data, error } = await _sb.rpc('cancel_booking_fee_remittance', {
      p_remittance_id: remittanceId,
      p_reason: String(reason || '').trim(),
      p_idempotency_key: _remittanceIdempotencyKey('cancel'),
    });
    if (error) throw new Error(_extractFnError(error, 'Could not cancel remittance'));
    return data || null;
  },

  // ---- LEGACY MONTHLY BILLING (read-only compatibility) ----
  async getWeeklyFees() {
    try {
      // Use REST API directly to bypass schema cache
      const res = await fetch(`${SUPABASE_URL}/rest/v1/weekly_fees?order=week_start.desc,created_at.desc`, {
        headers: await _authRestHeaders(),
      });
      if (!res.ok) {
        console.error('getWeeklyFees REST error:', res.status, res.statusText);
        return [];
      }
      return await res.json();
    } catch (err) {
      console.error('getWeeklyFees:', err);
      return [];
    }
  },

  async saveWeeklyFee(statement) {
    const row = {
      court_owner_user_id: statement.courtOwnerUserId,
      court_owner_email: statement.courtOwnerEmail || null,
      week_start: statement.weekStart,
      week_end: statement.weekEnd,
      bookings_count: statement.bookingsCount || 0,
      fee_per_booking: statement.feePerBooking,
      amount_due: statement.amountDue,
      billed_refs: statement.billedRefs || [],
      status: statement.status || 'sent',
      generated_at: statement.generatedAt || new Date().toISOString(),
      due_at: statement.dueAt || null,
      sent_at: statement.sentAt || null,
      paid_at: statement.paidAt || null,
      paid_ref: statement.paidRef || null,
      paid_note: statement.paidNote || null,
      paid_by_user_id: statement.paidByUserId || null,
    };

    try {
      // Use REST API directly to bypass schema cache
      const res = await fetch(`${SUPABASE_URL}/rest/v1/weekly_fees`, {
        method: 'POST',
        headers: await _authRestHeaders({
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        }),
        body: JSON.stringify(row),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error('saveWeeklyFee error:', res.status, errText);
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }
      const data = await res.json();
      return Array.isArray(data) ? data[0] : data;
    } catch (err) {
      console.error('saveWeeklyFee:', err);
      throw err;
    }
  },

  async updateWeeklyFee(id, updates) {
    const row = {};
    if (updates.courtOwnerUserId !== undefined) row.court_owner_user_id = updates.courtOwnerUserId;
    if (updates.courtOwnerEmail !== undefined) row.court_owner_email = updates.courtOwnerEmail;
    if (updates.status !== undefined) row.status = updates.status;
    if (updates.paidAt !== undefined) row.paid_at = updates.paidAt;
    if (updates.paidRef !== undefined) row.paid_ref = updates.paidRef;
    if (updates.paidNote !== undefined) row.paid_note = updates.paidNote;
    if (updates.paidByUserId !== undefined) row.paid_by_user_id = updates.paidByUserId;
    if (updates.sentAt !== undefined) row.sent_at = updates.sentAt;
    if (updates.dueAt !== undefined) row.due_at = updates.dueAt;
    if (updates.bookingsCount !== undefined) row.bookings_count = updates.bookingsCount;
    if (updates.amountDue !== undefined) row.amount_due = updates.amountDue;
    if (updates.feePerBooking !== undefined) row.fee_per_booking = updates.feePerBooking;
    if (updates.billedRefs !== undefined) row.billed_refs = updates.billedRefs;
    if (updates.generatedAt !== undefined) row.generated_at = updates.generatedAt;

    try {
      // Use REST API directly to bypass schema cache
      const res = await fetch(`${SUPABASE_URL}/rest/v1/weekly_fees?id=eq.${id}`, {
        method: 'PATCH',
        headers: await _authRestHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(row),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error('updateWeeklyFee error:', res.status, errText);
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }
    } catch (err) {
      console.error('updateWeeklyFee:', err);
      throw err;
    }
  },

  // Court owner submits a payment proof for their statement
  async submitWeeklyFeePayment(id, { submittedRef, submittedNote, submittedProofUrl }) {
    const row = {
      status: 'submitted',
      submitted_at: new Date().toISOString(),
      submitted_ref: submittedRef || null,
      submitted_note: submittedNote || null,
      submitted_proof_url: submittedProofUrl || null,
    };
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/weekly_fees?id=eq.${id}`, {
        method: 'PATCH',
        headers: await _authRestHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(row),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error('submitWeeklyFeePayment error:', res.status, errText);
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }
    } catch (err) {
      console.error('submitWeeklyFeePayment:', err);
      throw err;
    }
  },
};

// =============================================
// AUTH — Supabase Auth (email + password)
// Admin accounts are managed in Supabase Dashboard → Authentication → Users
// The accounts table stores role/display info linked by email.
// =============================================
// =============================================
// LOCAL DATA MODE
// Enable only on localhost with localStorage.setItem('pb_data_mode', 'local')
// or by opening a local page with ?localData=1. Disable with ?remoteData=1.
// =============================================
(function installLocalDataMode() {
  if (!window.PB_USE_LOCAL_DATA) return;

  const STORE_KEY = 'pb_local_db_v1';
  const nowIso = () => new Date().toISOString();
  const localRef = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`.toUpperCase();

  const defaultCourts = () => Array.from({ length: 10 }, (_, i) => {
    const n = i + 1;
    return {
      id: `c${n}`,
      name: n === 1 ? 'Korte DOS' : `Court ${n}`,
      desc: 'Outdoor',
      rate: n <= 5 ? 60 : 90,
      blocked: false,
      feats: ['Outdoor'],
      photo: '',
      rateSchedule: [
        { from: 6, to: 18, rate: 60 },
        { from: 18, to: 23, rate: 90 },
      ],
    };
  });

  const defaultSettings = () => ({
    open_hour: '6',
    close_hour: '24',
    open_play_config: JSON.stringify({
      enabled: true,
      start: 6,
      end: 23,
      days: [0, 6],
      specificDates: ['2026-06-20'],
      courtIds: [],
      fee: 25,
      maxPlayers: 16,
    }),
    payment_acceptance_mode: 'full_payment_only',
    payment_method_cash: '0',
    payment_method_gcash: '1',
    payment_method_bdopay: '1',
    payment_method_maya: '1',
    payment_method_bpi: '1',
    payment_method_maribank: '1',
    payment_method_gotyme: '0',
    payment_method_pnb: '0',
    payment_review_notification_email: '',
    gcash_merchant_number: '09XXXXXXXXX',
    gcash_merchant_name: 'Court Owner Name',
    gcash_qr_account_id: 'DWQM4TK496R3UA1BS',
    service_fee_rate: '15',
    maintenance_fee: '5',
    fee_type: 'per_hour',
  });

  const defaultAccounts = () => ([
    {
      id: 'owner_001',
      username: 'developer',
      password: 'dev123',
      role: 'owner',
      status: 'active',
      fullName: 'System Owner',
      email: 'owner@kortedos.local',
      createdAt: nowIso(),
    },
    {
      id: 'host_test_001',
      username: 'host.test',
      password: 'HostTest123!',
      role: 'host',
      status: 'active',
      fullName: 'Open Play Test Host',
      email: 'host.test@kortedos.local',
      createdAt: nowIso(),
    },
  ]);

  const defaultHostDemoBookings = () => {
    const makeHostBooking = ({ ref, groupRef = null, courtId, courtName, date, slots, rate, method = 'gcash', gcashRef = '', paymentStatus = 'downpayment_paid', status = 'confirmed', createdDaysAgo = 0 }) => {
      const duration = slots.length;
      const courtFee = duration * rate;
      const serviceFee = duration * 5;
      const total = courtFee + serviceFee;
      const downpayment = Math.round((courtFee * 0.25) + serviceFee);
      const start = Math.min(...slots);
      const end = Math.max(...slots) + 1;
      return {
        ref,
        groupRef,
        fullName: 'Open Play Test Host',
        contactNumber: '09171234567',
        email: 'host.test@kortedos.local',
        courtId,
        courtName,
        date,
        slots,
        startTime: _fmtBookingHour(start),
        endTime: _fmtBookingHour(end),
        timeLabel: `${_fmtBookingHour(start)} - ${_fmtBookingHour(end)}`,
        duration,
        rate,
        total,
        paymentMethod: method,
        paymentFlow: method,
        gcashRef,
        downpayment: paymentStatus === 'paid' ? total : downpayment,
        hostBooking: true,
        hostUserId: 'host_test_001',
        hostName: 'Open Play Test Host',
        hostEmail: 'host.test@kortedos.local',
        paymentStatus,
        status,
        createdAt: new Date(Date.now() - createdDaysAgo * 86400000).toISOString(),
      };
    };
    return [
      makeHostBooking({ ref: 'HOST-DEMO-001', courtId: 'c1', courtName: 'Korte DOS', date: '2026-07-12', slots: [14, 15], rate: 60, gcashRef: '1234567890123', createdDaysAgo: 1 }),
      makeHostBooking({ ref: 'HOST-DEMO-002', courtId: 'c2', courtName: 'Court 2', date: '2026-07-14', slots: [18, 19, 20], rate: 90, gcashRef: '9876543210123', createdDaysAgo: 2 }),
      makeHostBooking({ ref: 'HOST-DEMO-003', courtId: 'c3', courtName: 'Court 3', date: '2026-07-18', slots: [8, 9], rate: 60, method: 'cash', paymentStatus: 'unpaid', status: 'pending', createdDaysAgo: 0 }),
      makeHostBooking({ ref: 'HOST-DEMO-004', courtId: 'c4', courtName: 'Court 4', date: '2026-07-04', slots: [16, 17], rate: 60, gcashRef: '2223334445556', paymentStatus: 'paid', createdDaysAgo: 6 }),
      makeHostBooking({ ref: 'HOST-DEMO-005', courtId: 'c5', courtName: 'Court 5', date: '2026-06-29', slots: [19, 20, 21], rate: 90, gcashRef: '3334445556667', paymentStatus: 'downpayment_paid', createdDaysAgo: 12 }),
      makeHostBooking({ ref: 'HOST-DEMO-006', courtId: 'c6', courtName: 'Court 6', date: '2026-07-20', slots: [10, 11, 12], rate: 90, gcashRef: '4445556667778', paymentStatus: 'for_verification', status: 'verifying', createdDaysAgo: 0 }),
      makeHostBooking({ ref: 'HOST-DEMO-MULTI-001-A', groupRef: 'HOST-DEMO-MULTI-001', courtId: 'c7', courtName: 'Court 7', date: '2026-07-25', slots: [17, 18, 19, 20], rate: 90, gcashRef: '5556667778889', createdDaysAgo: 0 }),
      makeHostBooking({ ref: 'HOST-DEMO-MULTI-001-B', groupRef: 'HOST-DEMO-MULTI-001', courtId: 'c8', courtName: 'Court 8', date: '2026-07-25', slots: [17, 18, 19, 20], rate: 90, gcashRef: '5556667778889', createdDaysAgo: 0 }),
      makeHostBooking({ ref: 'HOST-DEMO-MULTI-001-C', groupRef: 'HOST-DEMO-MULTI-001', courtId: 'c9', courtName: 'Court 9', date: '2026-07-25', slots: [17, 18, 19, 20], rate: 90, gcashRef: '5556667778889', createdDaysAgo: 0 }),
    ];
  };

  function freshDb() {
    return {
      courts: defaultCourts(),
      bookings: defaultHostDemoBookings(),
      openPlayRegistrations: [],
      openPlayHostApplications: [],
      openPlayHostSessions: [],
      openPlayHostSessionRegistrations: [],
      openPlayGameSessions: [],
      openPlayGamePlayers: [],
      openPlayGameRounds: [],
      blockedDates: [],
      deletedBookingArchive: [],
      accounts: defaultAccounts(),
      settings: defaultSettings(),
      agreements: [],
      weeklyFees: [],
    };
  }

  function readDb() {
    const parsed = _safeJsonParse(localStorage.getItem(STORE_KEY));
    if (!parsed || typeof parsed !== 'object') {
      const db = freshDb();
      localStorage.setItem(STORE_KEY, JSON.stringify(db));
      return db;
    }
    const accounts = Array.isArray(parsed.accounts) && parsed.accounts.length ? parsed.accounts : defaultAccounts();
    const bookings = Array.isArray(parsed.bookings) ? parsed.bookings : [];
    let localSeedChanged = false;
    for (const defaultAccount of defaultAccounts()) {
      if (!accounts.some(a => String(a.id) === String(defaultAccount.id))) {
        accounts.push(defaultAccount);
        localSeedChanged = true;
      }
    }
    for (const demoBooking of defaultHostDemoBookings()) {
      if (!bookings.some(b => String(b.ref) === String(demoBooking.ref))) {
        bookings.push(demoBooking);
        localSeedChanged = true;
      }
    }
    const db = {
      ...freshDb(),
      ...parsed,
      settings: { ...defaultSettings(), ...(parsed.settings || {}) },
      courts: Array.isArray(parsed.courts) && parsed.courts.length ? parsed.courts : defaultCourts(),
      bookings,
      openPlayRegistrations: Array.isArray(parsed.openPlayRegistrations) ? parsed.openPlayRegistrations : [],
      openPlayHostApplications: Array.isArray(parsed.openPlayHostApplications) ? parsed.openPlayHostApplications : [],
      openPlayHostSessions: Array.isArray(parsed.openPlayHostSessions) ? parsed.openPlayHostSessions : [],
      openPlayHostSessionRegistrations: Array.isArray(parsed.openPlayHostSessionRegistrations) ? parsed.openPlayHostSessionRegistrations : [],
      openPlayGameSessions: Array.isArray(parsed.openPlayGameSessions) ? parsed.openPlayGameSessions : [],
      openPlayGamePlayers: Array.isArray(parsed.openPlayGamePlayers) ? parsed.openPlayGamePlayers : [],
      openPlayGameRounds: Array.isArray(parsed.openPlayGameRounds) ? parsed.openPlayGameRounds : [],
      blockedDates: Array.isArray(parsed.blockedDates) ? parsed.blockedDates : [],
      deletedBookingArchive: Array.isArray(parsed.deletedBookingArchive) ? parsed.deletedBookingArchive : [],
      accounts,
      agreements: Array.isArray(parsed.agreements) ? parsed.agreements : [],
      weeklyFees: Array.isArray(parsed.weeklyFees) ? parsed.weeklyFees : [],
    };
    if (localSeedChanged) writeDb(db);
    return db;
  }

  function writeDb(db) {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  }

  window.DB = {
    async getCourts() { return readDb().courts; },
    async saveCourt(court) {
      const db = readDb();
      const row = { ...court, id: String(court.id || localRef('court')).toLowerCase() };
      const idx = db.courts.findIndex(c => String(c.id) === String(row.id));
      if (idx >= 0) db.courts[idx] = { ...db.courts[idx], ...row };
      else db.courts.push(row);
      writeDb(db);
    },
    async deleteCourt(id) {
      const db = readDb();
      db.courts = db.courts.filter(c => String(c.id) !== String(id));
      writeDb(db);
    },

    async getBookings(filters = {}) {
      const opts = filters || {};
      return readDb().bookings
        .filter(b => !opts.date || b.date === opts.date)
        .filter(b => !opts.courtId || String(b.courtId) === String(opts.courtId))
        .filter(b => !opts.hostUserId || String(b.hostUserId) === String(opts.hostUserId))
        .filter(b => !opts.activeOnly || (b.status !== 'cancelled' && b.status !== 'forfeited'))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },
    async addBooking(booking) {
      const db = readDb();
      const existing = db.bookings
        .filter(b => String(b.courtId) === String(booking.courtId) && b.date === booking.date && b.status !== 'cancelled' && b.status !== 'forfeited');
      if (hasSlotConflict(existing, booking)) {
        throw new Error('One or more time slots are no longer available. Please refresh and choose a different time.');
      }
      const row = {
        ...booking,
        ref: booking.ref || localRef('PB'),
        receivedAccount: receivedAccountForBooking(booking),
        createdAt: booking.createdAt || nowIso(),
      };
      db.bookings.push(row);
      writeDb(db);
    },
    async getBookingByRef(ref) { return readDb().bookings.find(b => String(b.ref) === String(ref)) || null; },
    async updateBooking(ref, updates) {
      const db = readDb();
      let updated = false;
      db.bookings = db.bookings.map(b => {
        if (String(b.ref) !== String(ref)) return b;
        updated = true;
        const next = { ...b, ...updates };
        if (updates.receivedAccount === undefined && updates.paymentMethod !== undefined) {
          next.receivedAccount = receivedAccountForBooking(next);
        }
        if (!next.receivedAccount) next.receivedAccount = receivedAccountForBooking(next);
        return next;
      });
      if (!updated) {
        const missing = new Error(`Booking ${ref} was not updated because it no longer exists.`);
        missing.code = 'BOOKING_UPDATE_NOT_ALLOWED';
        throw missing;
      }
      writeDb(db);
    },
    async markBookingsBilled(refs, weeklyFeeId) {
      if (!Array.isArray(refs) || refs.length === 0) return;
      const db = readDb();
      db.bookings = db.bookings.map(b => refs.includes(b.ref) ? { ...b, billedAt: nowIso(), weeklyFeeId } : b);
      writeDb(db);
    },
    async deleteBooking(ref) {
      const db = readDb();
      const existing = db.bookings.find(b => String(b.ref) === String(ref));
      if (existing) {
        db.deletedBookingArchive.unshift({
          id: localRef('del'),
          bookingRef: existing.ref,
          source: 'local_delete',
          originalBooking: { ...existing },
          originalBookingRow: { ...existing },
          recoveredBooking: null,
          recoveredBookingRow: null,
          recoveryStatus: 'deleted',
          recoveredFrom: null,
          notes: 'Automatically archived before local delete.',
          deletedAt: nowIso(),
          archivedAt: nowIso(),
          restoredAt: null,
          restoredBy: null,
          createdAt: nowIso(),
        });
      }
      db.bookings = db.bookings.filter(b => String(b.ref) !== String(ref));
      writeDb(db);
    },

    async voidDeleteBookingGroup(ref, reason) {
      if (Auth.getSession()?.role !== 'owner') throw new Error('Only the System Owner can void and delete a booking.');
      if (String(reason || '').trim().length < 3) throw new Error('A void reason of at least 3 characters is required.');
      const db = readDb();
      const target = db.bookings.find(b => String(b.ref) === String(ref));
      if (!target) throw new Error('Booking not found.');
      const groupKey = target.groupRef || target.bookingGroupRef || target.ref;
      const matches = db.bookings.filter(b => String(b.groupRef || b.bookingGroupRef || b.ref) === String(groupKey));
      const refs = new Set(matches.map(b => String(b.ref)));
      const now = nowIso();
      let voidedFee = 0;
      matches.forEach(b => {
        const fee = b.bookingFeeEarnedAt || b.booking_fee_earned_at
          ? Number(b.bookingFeeAmountSnapshot ?? b.booking_fee_amount_snapshot ?? 0) : 0;
        voidedFee += Math.max(fee, 0);
        db.deletedBookingArchive.unshift({
          id: localRef('del'), bookingRef: b.ref, source: 'owner_void',
          originalBooking: { ...b }, originalBookingRow: { ...b },
          recoveryStatus: 'voided',
          notes: `System Owner voided and deleted this booking. Fee excluded from future computation. Reason: ${String(reason).trim()}`,
          voidedFeeAmount: Math.max(fee, 0), voidReason: String(reason).trim(),
          voidedAt: now, voidedBy: Auth.getSession()?.id || null,
          deletedAt: now, archivedAt: now, createdAt: now,
        });
      });
      db.bookings = db.bookings.filter(b => !refs.has(String(b.ref)));
      writeDb(db);
      return { deleted_count: matches.length, voided_fee_amount: voidedFee };
    },

    async getDeletedBookingArchive(filters = {}) {
      const opts = filters || {};
      return readDb().deletedBookingArchive
        .filter(r => !opts.status || r.recoveryStatus === opts.status)
        .filter(r => !opts.bookingRef || String(r.bookingRef) === String(opts.bookingRef))
        .sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')))
        .slice(0, Number(opts.limit || 250));
    },

    async restoreDeletedBookingArchive(id) {
      const db = readDb();
      const idx = db.deletedBookingArchive.findIndex(r => String(r.id) === String(id));
      if (idx < 0) throw new Error('Deleted booking archive row not found.');
      const entry = db.deletedBookingArchive[idx];
      if (entry.recoveryStatus === 'voided' || entry.source === 'owner_void') {
        throw new Error('A voided booking is final and cannot be restored.');
      }
      const booking = { ...(entry.originalBooking || entry.originalBookingRow || {}) };
      if (!booking.ref) throw new Error('Archive row has no booking reference.');
      if (db.bookings.some(b => String(b.ref) === String(booking.ref))) {
        throw new Error(`Booking ${booking.ref} already exists in active bookings.`);
      }
      const existing = db.bookings
        .filter(b => String(b.courtId) === String(booking.courtId) && b.date === booking.date && b.status !== 'cancelled' && b.status !== 'forfeited');
      if (hasSlotConflict(existing, booking)) {
        throw new Error('Cannot restore because one or more slots are already booked.');
      }
      db.bookings.push(booking);
      db.deletedBookingArchive[idx] = {
        ...entry,
        recoveryStatus: 'restored',
        recoveredBooking: { ...booking },
        recoveredBookingRow: { ...booking },
        recoveredFrom: entry.recoveredFrom || 'archive_restore',
        restoredAt: nowIso(),
        restoredBy: Auth.getSession()?.id || null,
        notes: [entry.notes, 'Restored from deleted booking archive.'].filter(Boolean).join('\n'),
      };
      writeDb(db);
      return booking;
    },

    async getOpenPlayRegistrations() {
      return readDb().openPlayRegistrations.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    },
    async addOpenPlayRegistration(reg) {
      const db = readDb();
      const method = normalizePaymentKey(reg.paymentMethod, 'cash');
      const digital = PB_DIGITAL_PAYMENT_METHODS.includes(method);
      const receiptVerificationId = Number(reg.receiptVerificationId);
      if (
        digital &&
        (
          !Number.isSafeInteger(receiptVerificationId) ||
          receiptVerificationId <= 0 ||
          !String(reg.receiptImageUrl || '').trim() ||
          !String(reg.receiptImageHash || '').trim()
        )
      ) {
        throw new Error('The receipt verification expired or is incomplete. Please upload the receipt again.');
      }
      if (digital) {
        const recovered = db.openPlayRegistrations.find(row =>
          Number(row.receipt_verification_id) === receiptVerificationId ||
          (
            String(row.receipt_image_hash || '').toLowerCase() ===
              String(reg.receiptImageHash || '').toLowerCase() &&
            String(row.receipt_image_url || '') === String(reg.receiptImageUrl || '')
          )
        );
        if (recovered) return recovered;
      }
      const row = {
        id: localRef('op'),
        full_name: reg.fullName,
        court_id: String(reg.courtId),
        court_name: reg.courtName,
        date: reg.date,
        hour: reg.hour,
        time_label: reg.timeLabel,
        payment_type: reg.paymentType,
        payment_method: method,
        gcash_ref: reg.gcashRef || null,
        payment_status: reg.paymentStatus || 'pending',
        amount: reg.amount,
        receipt_verification_id: digital ? receiptVerificationId : null,
        receipt_image_url: reg.receiptImageUrl || null,
        receipt_image_hash: reg.receiptImageHash || null,
        receipt_phash: reg.receiptPhash || null,
        receipt_status: reg.receiptStatus || 'none',
        receipt_flags: reg.receiptFlags || [],
        receipt_extracted: reg.receiptExtracted || null,
        receipt_confidence: reg.receiptConfidence ?? null,
        receipt_verified_at: reg.receiptVerifiedAt || null,
        created_at: nowIso(),
      };
      db.openPlayRegistrations.push(row);
      writeDb(db);
      return row;
    },
    async updateOpenPlayRegistration(id, updates) {
      const db = readDb();
      db.openPlayRegistrations = db.openPlayRegistrations.map(r => {
        if (String(r.id) !== String(id)) return r;
        return {
          ...r,
          payment_status: updates.paymentStatus !== undefined ? updates.paymentStatus : r.payment_status,
          gcash_ref: updates.gcashRef !== undefined ? updates.gcashRef : r.gcash_ref,
          receipt_image_url: updates.receiptImageUrl !== undefined ? updates.receiptImageUrl : r.receipt_image_url,
          receipt_image_hash: updates.receiptImageHash !== undefined ? updates.receiptImageHash : r.receipt_image_hash,
          receipt_phash: updates.receiptPhash !== undefined ? updates.receiptPhash : r.receipt_phash,
          receipt_status: updates.receiptStatus !== undefined ? updates.receiptStatus : r.receipt_status,
          receipt_flags: updates.receiptFlags !== undefined ? updates.receiptFlags : r.receipt_flags,
          receipt_extracted: updates.receiptExtracted !== undefined ? updates.receiptExtracted : r.receipt_extracted,
          receipt_confidence: updates.receiptConfidence !== undefined ? updates.receiptConfidence : r.receipt_confidence,
          receipt_verified_at: updates.receiptVerifiedAt !== undefined ? updates.receiptVerifiedAt : r.receipt_verified_at,
        };
      });
      writeDb(db);
    },
    async getOpenPlayCountForDate(date, courtId = null) {
      return readDb().openPlayRegistrations.filter(r =>
        r.date === date &&
        (!courtId || String(r.court_id) === String(courtId)) &&
        r.payment_status !== 'rejected'
      ).length;
    },
    async getOpenPlayCountsForDate(date) {
      return readDb().openPlayRegistrations
        .filter(r => r.date === date && r.payment_status !== 'rejected')
        .reduce((counts, row) => {
          const key = String(row.court_id || '');
          counts[key] = (counts[key] || 0) + 1;
          return counts;
        }, {});
    },
    async deleteOpenPlayRegistration(id) {
      const db = readDb();
      db.openPlayRegistrations = db.openPlayRegistrations.filter(r => String(r.id) !== String(id));
      writeDb(db);
    },

    async getOpenPlayHostApplications() {
      return readDb().openPlayHostApplications.sort((a, b) => String(b.createdAt || b.created_at || '').localeCompare(String(a.createdAt || a.created_at || '')));
    },
    async addOpenPlayHostApplication(app) {
      const db = readDb();
      db.openPlayHostApplications.unshift({
        id: localRef('hostapp'),
        fullName: app.fullName,
        contactNumber: app.contactNumber,
        email: app.email,
        gcashNumber: app.gcashNumber || '',
        validIdFileName: app.validIdFileName || '',
        validIdFileType: app.validIdFileType || '',
        validIdFileSize: app.validIdFileSize || null,
        validIdPath: app.validIdPath || '',
        preferredSchedule: app.preferredSchedule || '',
        notes: app.notes || '',
        status: 'pending',
        reviewNote: '',
        reviewedBy: null,
        reviewedAt: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      writeDb(db);
    },
    async updateOpenPlayHostApplication(id, updates) {
      const db = readDb();
      let saved = null;
      db.openPlayHostApplications = db.openPlayHostApplications.map(app => {
        if (String(app.id) !== String(id)) return app;
        saved = { ...app, ...updates, updatedAt: nowIso() };
        return saved;
      });
      writeDb(db);
      return saved;
    },
    async reviewOpenPlayHostApplication(id, status, reviewNote = '') {
      const db = readDb();
      const appIndex = db.openPlayHostApplications.findIndex(app => String(app.id) === String(id));
      if (appIndex < 0) throw new Error('Host application not found.');
      const existing = db.openPlayHostApplications[appIndex];
      const account = db.accounts.find(acc =>
        acc.role === 'host' && (
          (existing.hostUserId && String(acc.id) === String(existing.hostUserId)) ||
          String(acc.email || '').toLowerCase() === String(existing.email || '').toLowerCase()
        )
      );
      if (status === 'approved' && !account) {
        throw new Error('No matching host login exists for this application.');
      }
      if (account) account.status = status === 'approved' ? 'active' : 'suspended';
      const saved = {
        ...existing,
        hostUserId: account?.id || existing.hostUserId || null,
        status,
        reviewNote,
        reviewedBy: Auth.getSession()?.id || null,
        reviewedAt: nowIso(),
        updatedAt: nowIso(),
      };
      db.openPlayHostApplications[appIndex] = saved;
      writeDb(db);
      return {
        ok: true,
        status,
        hostUserId: saved?.hostUserId || null,
        loginLinked: !!account,
        accountStatus: account?.status || null,
      };
    },
    async repairOpenPlayHostActivation(id) {
      const db = readDb();
      const appIndex = db.openPlayHostApplications.findIndex(app => String(app.id) === String(id));
      if (appIndex < 0) throw new Error('Host application not found.');
      const app = db.openPlayHostApplications[appIndex];
      const account = db.accounts.find(acc =>
        acc.role === 'host' && (
          (app.hostUserId && String(acc.id) === String(app.hostUserId)) ||
          String(acc.email || '').toLowerCase() === String(app.email || '').toLowerCase()
        )
      );
      if (!account) throw new Error('No matching host login exists for this application.');
      account.status = 'active';
      app.hostUserId = account.id;
      app.status = 'approved';
      app.updatedAt = nowIso();
      writeDb(db);
      return {
        ok: true,
        status: app.status,
        hostUserId: account.id,
        loginLinked: true,
        accountStatus: 'active',
      };
    },
    async getOpenPlayHostSessions() {
      return readDb().openPlayHostSessions.sort((a, b) =>
        String(a.date || '').localeCompare(String(b.date || '')) ||
        Number(a.startHour || a.start_hour || 0) - Number(b.startHour || b.start_hour || 0)
      );
    },
    async createOpenPlayHostSession(session) {
      const db = readDb();
      const row = {
        id: localRef('hosts'),
        hostUserId: session.hostUserId || null,
        hostName: session.hostName,
        hostEmail: session.hostEmail || '',
        title: session.title,
        date: session.date,
        startHour: session.startHour,
        endHour: session.endHour,
        courtIds: session.courtIds || [],
        courtNames: session.courtNames || [],
        maxPlayers: session.maxPlayers || 16,
        feePerPlayer: session.feePerPlayer || 0,
        status: session.status || 'published',
        notes: session.notes || '',
        paymentInstructions: session.paymentInstructions || '',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      db.openPlayHostSessions.unshift(row);
      writeDb(db);
      return row;
    },
    async updateOpenPlayHostSession(id, updates) {
      const db = readDb();
      let saved = null;
      db.openPlayHostSessions = db.openPlayHostSessions.map(session => {
        if (String(session.id) !== String(id)) return session;
        saved = { ...session, ...updates, updatedAt: nowIso() };
        return saved;
      });
      writeDb(db);
      return saved;
    },

    async getOpenPlayHostSessionRegistrations(sessionId = null) {
      return (readDb().openPlayHostSessionRegistrations || [])
        .filter(r => !sessionId || String(r.sessionId || r.session_id) === String(sessionId))
        .sort((a, b) => String(b.createdAt || b.created_at || '').localeCompare(String(a.createdAt || a.created_at || '')));
    },
    async getOpenPlayHostSessionRegistrationCount(sessionId) {
      return (readDb().openPlayHostSessionRegistrations || [])
        .filter(r => String(r.sessionId || r.session_id) === String(sessionId) && r.paymentStatus !== 'rejected' && r.payment_status !== 'rejected')
        .length;
    },
    async addOpenPlayHostSessionRegistration(reg) {
      const db = readDb();
      if (!Array.isArray(db.openPlayHostSessionRegistrations)) db.openPlayHostSessionRegistrations = [];
      const digital = PB_DIGITAL_PAYMENT_METHODS.includes(
        normalizePaymentKey(reg.paymentMethod, 'gcash')
      ) && Number(reg.amount || 0) > 0;
      const receiptVerificationId = Number(reg.receiptVerificationId);
      if (
        digital &&
        (
          !Number.isSafeInteger(receiptVerificationId) ||
          receiptVerificationId <= 0 ||
          !String(reg.receiptImageUrl || '').trim() ||
          !String(reg.receiptImageHash || '').trim()
        )
      ) {
        throw new Error('The receipt verification expired or is incomplete. Please upload the receipt again.');
      }
      if (digital) {
        const recovered = db.openPlayHostSessionRegistrations.find(row =>
          Number(row.receiptVerificationId ?? row.receipt_verification_id) ===
            receiptVerificationId ||
          (
            String(row.receiptImageHash ?? row.receipt_image_hash ?? '').toLowerCase() ===
              String(reg.receiptImageHash || '').toLowerCase() &&
            String(row.receiptImageUrl ?? row.receipt_image_url ?? '') ===
              String(reg.receiptImageUrl || '')
          )
        );
        if (recovered) return recovered;
      }
      const row = {
        id: localRef('hostreg'),
        sessionId: reg.sessionId,
        fullName: reg.fullName,
        contactNumber: reg.contactNumber || '',
        paymentMethod: reg.paymentMethod || 'gcash',
        gcashRef: reg.gcashRef || null,
        paymentStatus: reg.paymentStatus || 'pending',
        amount: reg.amount || 0,
        receiptVerificationId: digital ? receiptVerificationId : null,
        receiptImageUrl: reg.receiptImageUrl || null,
        receiptImageHash: reg.receiptImageHash || null,
        receiptPhash: reg.receiptPhash || null,
        receiptStatus: reg.receiptStatus || 'none',
        receiptFlags: reg.receiptFlags || [],
        receiptExtracted: reg.receiptExtracted || null,
        receiptConfidence: reg.receiptConfidence ?? null,
        receiptVerifiedAt: reg.receiptVerifiedAt || null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      db.openPlayHostSessionRegistrations.unshift(row);
      writeDb(db);
      return row;
    },

    async getOpenPlayGameSessions() {
      return readDb().openPlayGameSessions.sort((a, b) =>
        String(b.date || '').localeCompare(String(a.date || '')) ||
        String(b.created_at || '').localeCompare(String(a.created_at || ''))
      );
    },
    async createOpenPlayGameSession(session) {
      const db = readDb();
      const row = {
        id: localRef('gm'),
        date: session.date,
        time_label: session.timeLabel || null,
        court_ids: session.courtIds || [],
        court_names: session.courtNames || [],
        mode: session.mode || 'smart_random_mixer',
        status: session.status || 'draft',
        current_round: session.currentRound || 0,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      db.openPlayGameSessions.unshift(row);
      writeDb(db);
      return row;
    },
    async updateOpenPlayGameSession(id, updates) {
      const db = readDb();
      let saved = null;
      db.openPlayGameSessions = db.openPlayGameSessions.map(s => {
        if (String(s.id) !== String(id)) return s;
        saved = {
          ...s,
          date: updates.date !== undefined ? updates.date : s.date,
          time_label: updates.timeLabel !== undefined ? updates.timeLabel : s.time_label,
          court_ids: updates.courtIds !== undefined ? updates.courtIds : s.court_ids,
          court_names: updates.courtNames !== undefined ? updates.courtNames : s.court_names,
          mode: updates.mode !== undefined ? updates.mode : s.mode,
          status: updates.status !== undefined ? updates.status : s.status,
          current_round: updates.currentRound !== undefined ? updates.currentRound : s.current_round,
          updated_at: nowIso(),
        };
        return saved;
      });
      writeDb(db);
      return saved;
    },
    async getOpenPlayGamePlayers(sessionId) {
      return readDb().openPlayGamePlayers
        .filter(p => String(p.session_id) === String(sessionId))
        .sort((a, b) => Number(a.seed_order || 0) - Number(b.seed_order || 0));
    },
    async replaceOpenPlayGamePlayers(sessionId, players) {
      const db = readDb();
      db.openPlayGamePlayers = db.openPlayGamePlayers.filter(p => String(p.session_id) !== String(sessionId));
      const rows = players.map((p, i) => ({
        id: localRef('gmp'),
        session_id: sessionId,
        full_name: p.fullName || p.full_name,
        source_registration_id: p.sourceRegistrationId || p.source_registration_id || null,
        status: p.status || 'active',
        seed_order: i,
        created_at: nowIso(),
      }));
      db.openPlayGamePlayers.push(...rows);
      writeDb(db);
      return rows;
    },
    async getOpenPlayGameRounds(sessionId) {
      return readDb().openPlayGameRounds
        .filter(r => String(r.session_id) === String(sessionId))
        .sort((a, b) => Number(a.round_no || 0) - Number(b.round_no || 0));
    },
    async addOpenPlayGameRound(round) {
      const db = readDb();
      const row = {
        id: localRef('gmr'),
        session_id: round.sessionId,
        round_no: round.roundNo,
        assignments: round.assignments || [],
        queue_snapshot: round.queueSnapshot || [],
        partner_history: round.partnerHistory || {},
        opponent_history: round.opponentHistory || {},
        created_at: nowIso(),
        completed_at: round.completedAt || null,
      };
      db.openPlayGameRounds.push(row);
      db.openPlayGameSessions = db.openPlayGameSessions.map(s =>
        String(s.id) === String(round.sessionId)
          ? { ...s, current_round: round.roundNo, status: 'active', updated_at: nowIso() }
          : s
      );
      writeDb(db);
      return row;
    },
    async updateOpenPlayGameRound(id, updates) {
      const db = readDb();
      let saved = null;
      db.openPlayGameRounds = db.openPlayGameRounds.map(r => {
        if (String(r.id) !== String(id)) return r;
        saved = {
          ...r,
          assignments: updates.assignments !== undefined ? updates.assignments : r.assignments,
          queue_snapshot: updates.queueSnapshot !== undefined ? updates.queueSnapshot : r.queue_snapshot,
          partner_history: updates.partnerHistory !== undefined ? updates.partnerHistory : r.partner_history,
          opponent_history: updates.opponentHistory !== undefined ? updates.opponentHistory : r.opponent_history,
          completed_at: updates.completedAt !== undefined ? updates.completedAt : r.completed_at,
        };
        return saved;
      });
      writeDb(db);
      return saved;
    },
    async deleteLatestOpenPlayGameRound(sessionId) {
      const db = readDb();
      const rounds = db.openPlayGameRounds
        .filter(r => String(r.session_id) === String(sessionId))
        .sort((a, b) => Number(a.round_no || 0) - Number(b.round_no || 0));
      const last = rounds[rounds.length - 1];
      if (!last) return null;
      db.openPlayGameRounds = db.openPlayGameRounds.filter(r => String(r.id) !== String(last.id));
      db.openPlayGameSessions = db.openPlayGameSessions.map(s =>
        String(s.id) === String(sessionId)
          ? { ...s, current_round: Math.max(0, Number(last.round_no || 1) - 1), updated_at: nowIso() }
          : s
      );
      writeDb(db);
      return last;
    },
    async clearOpenPlayGameRounds(sessionId) {
      const db = readDb();
      db.openPlayGameRounds = db.openPlayGameRounds.filter(r => String(r.session_id) !== String(sessionId));
      db.openPlayGameSessions = db.openPlayGameSessions.map(s =>
        String(s.id) === String(sessionId)
          ? { ...s, current_round: 0, status: 'draft', updated_at: nowIso() }
          : s
      );
      writeDb(db);
    },

    async getBlockedDates() { return readDb().blockedDates; },
    async addBlockedDate(date) {
      const db = readDb();
      if (!db.blockedDates.includes(date)) db.blockedDates.push(date);
      db.blockedDates.sort();
      writeDb(db);
    },
    async removeBlockedDate(date) {
      const db = readDb();
      db.blockedDates = db.blockedDates.filter(d => d !== date);
      writeDb(db);
    },

    async getAccounts() { return readDb().accounts; },
    async getHostFinanceAccounts() {
      const role = window.Auth?.getSession?.()?.role || '';
      if (!['owner', 'court_owner'].includes(role)) {
        const error = new Error('Only system owners and court owners can view host finance accounts.');
        error.code = 'HOST_ACCOUNTS_VIEW_NOT_ALLOWED';
        throw error;
      }
      return readDb().accounts
        .filter(account => account.role === 'host')
        .map(rowToHostFinanceAccount)
        .filter(account => account.id)
        .sort((a, b) =>
          String(a.fullName || '').localeCompare(String(b.fullName || '')) ||
          String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
        );
    },
    async getHostFinanceBookings(hostUserId) {
      const role = window.Auth?.getSession?.()?.role || '';
      if (!['owner', 'court_owner'].includes(role)) {
        const error = new Error('Only system owners and court owners can view host finance bookings.');
        error.code = 'HOST_FINANCE_VIEW_NOT_ALLOWED';
        throw error;
      }
      const id = String(hostUserId || '').trim();
      if (!id || !readDb().accounts.some(account => account.role === 'host' && String(account.id) === id)) {
        throw new Error('Host account not found.');
      }
      return readDb().bookings
        .filter(booking => booking.hostBooking && booking.email !== 'reserve@hold.internal')
        .filter(booking => String(booking.hostUserId || booking.createdByUserId || '') === id)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },
    async saveAccount(account) {
      const db = readDb();
      const idx = db.accounts.findIndex(a => String(a.id) === String(account.id));
      if (idx >= 0) db.accounts[idx] = { ...db.accounts[idx], ...account };
      else db.accounts.push({ ...account, id: account.id || localRef('acc'), createdAt: account.createdAt || nowIso() });
      writeDb(db);
    },
    async deleteAccount(id) {
      const db = readDb();
      db.accounts = db.accounts.filter(a => String(a.id) !== String(id));
      writeDb(db);
    },

    async getSettings() { return readDb().settings; },
    async saveSetting(key, value) {
      const db = readDb();
      db.settings[key] = value;
      writeDb(db);
    },
    async getPaymentReviewNotificationSettings() {
      const email = String(readDb().settings.payment_review_notification_email || '').trim().toLowerCase();
      return { ok: true, email, configured: Boolean(email) };
    },
    async savePaymentReviewNotificationEmail(email) {
      const normalized = String(email || '').trim().toLowerCase();
      const db = readDb();
      db.settings.payment_review_notification_email = normalized;
      writeDb(db);
      return { ok: true, email: normalized, configured: Boolean(normalized) };
    },
    async sendPaymentReviewNotificationTest() {
      const email = String(readDb().settings.payment_review_notification_email || '').trim().toLowerCase();
      if (!email) return { ok: false, sent: false, error: 'Save a notification email before sending a test.' };
      return { ok: true, sent: true, skipped: true };
    },
    clearCache() {},

    async createPaymentSession() { throw new Error('Online checkout is disabled in local data mode.'); },
    async sendConfirmationEmail() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async sendHostBalanceNotice() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async processHostBalanceDeadlines() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async getBookingBalanceNotifications() { return []; },
    async sendRescheduleEmail() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async sendTelegramNotification() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async notifyBookingSubmitted() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async notifyBookingUpdate() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async reviewPaymentReceipt(bookingRef, decision, reason = '') {
      const normalizedDecision = String(decision || '').trim().toLowerCase();
      const normalizedReason = String(reason || '').trim();
      if (!['approve', 'reject'].includes(normalizedDecision)) throw new Error('Choose a valid payment-review decision.');
      if (normalizedDecision === 'reject' && normalizedReason.length < 3) {
        throw new Error('Enter a rejection reason of at least 3 characters.');
      }

      const db = readDb();
      const primary = db.bookings.find(b =>
        String(b.ref) === String(bookingRef) || String(b.groupRef || '') === String(bookingRef)
      );
      if (!primary) throw new Error('Booking not found.');
      const rows = primary.groupRef
        ? db.bookings.filter(b => String(b.groupRef || '') === String(primary.groupRef))
        : [primary];
      if (rows.some(b => b.status !== 'pending' || b.paymentStatus !== 'for_verification')) {
        throw new Error('This payment is no longer awaiting review. Refresh the dashboard to see its latest status.');
      }
      if (rows.some(b => !String(b.receiptImageUrl || '').trim())) {
        throw new Error('Cannot review this digital payment because no receipt image is stored.');
      }

      const total = rows.reduce((sum, b) => sum + Number(b.total || 0), 0);
      const collected = rows.reduce((sum, b) => sum + Number(b.downpayment || 0), 0);
      const status = normalizedDecision === 'approve' ? 'confirmed' : 'cancelled';
      const paymentStatus = normalizedDecision === 'approve'
        ? (collected >= total - 0.01 ? 'paid' : 'downpayment_paid')
        : 'rejected';
      const refs = new Set(rows.map(b => String(b.ref)));
      db.bookings = db.bookings.map(b => refs.has(String(b.ref)) ? { ...b, status, paymentStatus } : b);
      writeDb(db);
      return {
        ok: true,
        local: true,
        decision: normalizedDecision,
        bookingRef: primary.groupRef || primary.ref,
        refs: [...refs],
        status,
        paymentStatus,
      };
    },
    async reviewOpenPlayPaymentReceipt(registrationId, decision, reason = '') {
      const id = String(registrationId || '');
      const normalizedDecision = String(decision || '').trim().toLowerCase();
      const normalizedReason = String(reason || '').trim();
      if (!['approve', 'reject'].includes(normalizedDecision)) {
        throw new Error('Choose a valid payment-review decision.');
      }
      if (normalizedDecision === 'reject' && normalizedReason.length < 3) {
        throw new Error('Enter a rejection reason of at least 3 characters.');
      }
      const db = readDb();
      const index = db.openPlayRegistrations.findIndex(row =>
        String(row.id) === id
      );
      if (index < 0) throw new Error('Open Play registration not found.');
      const row = db.openPlayRegistrations[index];
      if (
        row.payment_status !== 'pending' ||
        !PB_DIGITAL_PAYMENT_METHODS.includes(
          normalizePaymentKey(row.payment_method)
        )
      ) {
        throw new Error('This Open Play payment is no longer awaiting review.');
      }
      if (
        !String(row.receipt_image_url || '').trim() ||
        !String(row.receipt_image_hash || '').trim() ||
        !row.receipt_verification_id
      ) {
        throw new Error('Cannot review this payment because no verified receipt image is stored.');
      }
      const paymentStatus = normalizedDecision === 'approve'
        ? 'paid'
        : 'rejected';
      db.openPlayRegistrations[index] = {
        ...row,
        payment_status: paymentStatus,
      };
      writeDb(db);
      return {
        ok: true,
        local: true,
        contextType: 'open_play',
        registrationId: row.id,
        decision: normalizedDecision,
        paymentStatus,
      };
    },
    async reviewHostSessionPaymentReceipt(registrationId, decision, reason = '') {
      const id = String(registrationId || '').trim().toLowerCase();
      const normalizedDecision = String(decision || '').trim().toLowerCase();
      const normalizedReason = String(reason || '').trim();
      if (!['approve', 'reject'].includes(normalizedDecision)) {
        throw new Error('Choose a valid payment-review decision.');
      }
      if (normalizedDecision === 'reject' && normalizedReason.length < 3) {
        throw new Error('Enter a rejection reason of at least 3 characters.');
      }
      const db = readDb();
      const rows = db.openPlayHostSessionRegistrations || [];
      const index = rows.findIndex(row => String(row.id).toLowerCase() === id);
      if (index < 0) throw new Error('Host-session registration not found.');
      const row = rows[index];
      const paymentStatus = String(row.paymentStatus || row.payment_status || '');
      const paymentMethod = normalizePaymentKey(row.paymentMethod || row.payment_method);
      if (
        paymentStatus !== 'pending' ||
        !PB_DIGITAL_PAYMENT_METHODS.includes(paymentMethod)
      ) {
        throw new Error('This host-session payment is no longer awaiting review.');
      }
      const receiptUrl = row.receiptImageUrl || row.receipt_image_url;
      const receiptHash = row.receiptImageHash || row.receipt_image_hash;
      const verificationId = row.receiptVerificationId || row.receipt_verification_id;
      if (!String(receiptUrl || '').trim() || !String(receiptHash || '').trim() || !verificationId) {
        throw new Error('Cannot review this payment because no verified receipt image is stored.');
      }
      const nextPaymentStatus = normalizedDecision === 'approve' ? 'paid' : 'rejected';
      rows[index] = {
        ...row,
        paymentStatus: nextPaymentStatus,
        payment_status: nextPaymentStatus,
      };
      db.openPlayHostSessionRegistrations = rows;
      writeDb(db);
      return {
        ok: true,
        local: true,
        contextType: 'host_session',
        registrationId: row.id,
        decision: normalizedDecision,
        paymentStatus: nextPaymentStatus,
      };
    },
    async getIntegrationStatus() {
      return {
        ok: true,
        local: true,
        services: [
          { id: 'email', label: 'Email confirmations', configured: false, required: ['RESEND_API_KEY'], missing: ['RESEND_API_KEY'], note: 'Local data mode' },
          { id: 'telegram', label: 'Telegram admin alerts', configured: false, required: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'], missing: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'], note: 'Local data mode' },
          { id: 'payments', label: 'PayMongo checkout', configured: false, required: ['PAYMONGO_SECRET_KEY', 'PAYMENT_SUCCESS_URL', 'PAYMENT_CANCEL_URL'], missing: ['PAYMONGO_SECRET_KEY', 'PAYMENT_SUCCESS_URL', 'PAYMENT_CANCEL_URL'], note: 'Local data mode' },
          { id: 'ocr', label: 'Receipt OCR', configured: false, required: ['GOOGLE_VISION_API_KEY'], missing: ['GOOGLE_VISION_API_KEY'], note: 'Local data mode' },
          { id: 'service_role', label: 'Server database access', configured: false, required: ['SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY'], missing: ['SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY'], note: 'Local data mode' },
        ],
      };
    },
    async verifyGcashReceipt(payload = {}) {
      const bookingRef = String(payload.bookingRef || '').trim();
      if (!bookingRef) throw new Error('A booking reference is required.');
      const receiptFile = await _pbPrepareReceiptImage(payload.imageFile);
      const receiptImageUrl = await _pbFileToDataUrl(receiptFile);
      const receiptVerifiedAt = nowIso();
      const receiptVerificationId =
        Date.now() * 1000 + Math.floor(Math.random() * 1000);
      let localHashBytes;
      if (globalThis.crypto?.subtle?.digest && typeof receiptFile.arrayBuffer === 'function') {
        localHashBytes = new Uint8Array(
          await globalThis.crypto.subtle.digest('SHA-256', await receiptFile.arrayBuffer())
        );
      } else {
        localHashBytes = new Uint8Array(32);
        if (globalThis.crypto?.getRandomValues) {
          globalThis.crypto.getRandomValues(localHashBytes);
        }
        for (let i = 0; i < localHashBytes.length; i += 1) {
          if (!localHashBytes[i]) localHashBytes[i] = Math.floor(Math.random() * 256);
        }
      }
      const receiptImageHash = Array.from(
        localHashBytes,
        byte => byte.toString(16).padStart(2, '0')
      ).join('');
      const flags = ['local_data_mode'];
      const extracted = {
        provider: String(payload.provider || 'gcash').toLowerCase(),
        localDataMode: true,
      };
      const db = readDb();
      const primary = db.bookings.find(b =>
        String(b.ref) === bookingRef || String(b.groupRef || '') === bookingRef
      );
      if (primary) {
        const refs = new Set((primary.groupRef
          ? db.bookings.filter(b => String(b.groupRef || '') === String(primary.groupRef))
          : [primary]).map(b => String(b.ref)));
        db.bookings = db.bookings.map(b => refs.has(String(b.ref)) ? {
          ...b,
          status: 'pending',
          paymentStatus: 'for_verification',
          receiptImageUrl,
          receiptImageHash,
          receiptVerificationId,
          receiptStatus: 'manual_review',
          receiptFlags: flags,
          receiptExtracted: extracted,
          receiptConfidence: 0,
          receiptVerifiedAt,
        } : b);
        writeDb(db);
      }
      return {
        ok: true,
        status: 'manual_review',
        flags,
        extracted,
        confidence: 0,
        receiptImageUrl,
        receiptImageHash,
        receiptVerificationId,
        receiptVerifiedAt,
        message: 'Local data mode: receipt stored for manual review; OCR was not sent to Supabase.',
      };
    },
    async getReceiptSignedUrl(bookingRef) {
      const ref = String(bookingRef || '').trim();
      const booking = readDb().bookings.find(b =>
        String(b.ref) === ref || String(b.groupRef || '') === ref
      );
      if (!String(booking?.receiptImageUrl || '').trim()) throw new Error('No stored receipt in local data mode.');
      return booking.receiptImageUrl;
    },
    async getOpenPlayReceiptSignedUrl(registrationId) {
      const row = readDb().openPlayRegistrations.find(item =>
        String(item.id) === String(registrationId)
      );
      if (!String(row?.receipt_image_url || '').trim()) {
        throw new Error('No stored receipt in local data mode.');
      }
      return row.receipt_image_url;
    },
    async getHostSessionReceiptSignedUrl(registrationId) {
      const row = (readDb().openPlayHostSessionRegistrations || []).find(item =>
        String(item.id) === String(registrationId)
      );
      const receiptUrl = row?.receiptImageUrl || row?.receipt_image_url || '';
      if (!String(receiptUrl).trim()) {
        throw new Error('No stored receipt in local data mode.');
      }
      return receiptUrl;
    },

    async seedDefaultData() { readDb(); },
    async getAgreement(userId, version = 1) {
      return readDb().agreements.find(a => String(a.userId) === String(userId) && Number(a.version) === Number(version)) || null;
    },
    async saveAgreement(data) {
      const db = readDb();
      const version = data.version || 1;
      const idx = db.agreements.findIndex(a => String(a.userId) === String(data.userId) && Number(a.version || 1) === Number(version));
      const row = { ...data, version, agreedAt: nowIso() };
      if (idx >= 0) db.agreements[idx] = row;
      else db.agreements.push(row);
      writeDb(db);
    },
    async getBookingFeeRemittanceDashboard() {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth() + (now.getDate() > 14 ? 1 : 0), 14);
      return {
        server_now: now.toISOString(),
        role: Auth.getSession()?.role || 'court_owner',
        next_due_on: `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-14`,
        can_prepare: false,
        live: { booking_groups_count: 0, booking_rows_count: 0, total_billable_hours: 0, amount: 0 },
        active: null,
        history: [],
      };
    },
    async getBookingFeeRemittanceHistory() { return []; },
    async getBookingFeeRemittanceDetail() { return null; },
    async prepareBookingFeeRemittance() { throw new Error('Remittance preparation requires Supabase.'); },
    async submitBookingFeeRemittance() { throw new Error('Remittance submission requires Supabase.'); },
    async getBookingFeeRemittanceProofUrl() { throw new Error('No remittance receipt is stored in local data mode.'); },
    async getBookingFeeRemittanceProofSignedUrl() { throw new Error('No remittance receipt is stored in local data mode.'); },
    async reviewBookingFeeRemittancePayment() { throw new Error('Remittance review requires Supabase.'); },
    async cancelBookingFeeRemittance() { throw new Error('Remittance cancellation requires Supabase.'); },
    async getWeeklyFees() { return readDb().weeklyFees; },
    async saveWeeklyFee(statement) {
      const db = readDb();
      const row = { ...statement, id: statement.id || localRef('fee'), generatedAt: statement.generatedAt || nowIso() };
      db.weeklyFees.unshift(row);
      writeDb(db);
      return row;
    },
    async updateWeeklyFee(id, updates) {
      const db = readDb();
      db.weeklyFees = db.weeklyFees.map(f => String(f.id) === String(id) ? { ...f, ...updates } : f);
      writeDb(db);
    },
    async submitWeeklyFeePayment(id, data) {
      await this.updateWeeklyFee(id, { ...data, status: 'submitted', submittedAt: nowIso() });
    },
  };

  window.PB_RESET_LOCAL_DATA = function resetLocalData() {
    localStorage.removeItem(STORE_KEY);
    return readDb();
  };

  console.info('[Korte DOS] Local data mode enabled. Supabase writes are bypassed in this browser.');
})();

window.Auth = {

  // ── Role model ──────────────────────────────────────────
  // owner       → System Owner   (full access: everything + accounts)
  // court_owner → Court Owner    (operations + payment settings, no account mgmt)
  // staff       → Court Staff    (front-desk: bookings, payment review, open play)
  ROLES: ['owner', 'court_owner', 'staff', 'host'],
  ROLE_LABELS: { owner: 'System Owner', court_owner: 'Court Owner', staff: 'Court Staff', host: 'Open Play Host' },
  ROLE_PERMISSIONS: {
    owner:       ['dashboard', 'bookings', 'payment_review', 'reports', 'courts', 'open_play', 'host_open_play', 'host_accounts_view', 'remittances', 'maintenance', 'payments', 'accounts', 'booking_delete', 'export', 'settings', 'owner_only'],
    court_owner: ['dashboard', 'bookings', 'payment_review', 'reports', 'courts', 'open_play', 'host_open_play', 'host_accounts_view', 'remittances', 'maintenance', 'payments', 'export', 'settings', 'court_owner_only'],
    staff:       ['bookings', 'open_play', 'payment_review'],
    host:        ['host_open_play'],
  },

  permissionsFor(role) {
    return this.ROLE_PERMISSIONS[role] || [];
  },

  can(action, role) {
    const r = role || (this.getSession() && this.getSession().role);
    return this.permissionsFor(r).includes(action);
  },

  hasRole(role) {
    const sess = this.getSession();
    if (!sess) return false;
    if (sess.role === 'owner') return true; // system owner has all access
    return sess.role === role;
  },

  async refreshSessionFromAuth({ remember = null } = {}) {
    const { data: authData, error } = await _sb.auth.getUser();
    if (error || !authData?.user) {
      this._lastLoginMessage = error
        ? 'Could not verify your sign-in right now. Please check your connection and try again.'
        : 'Your sign-in session is no longer available. Please log in again.';
      return null;
    }

    const { data: acc, error: accountErr } = await _sb
      .from('accounts')
      .select('*')
      .eq('id', authData.user.id)
      .maybeSingle();

    if (accountErr) {
      console.error('refreshSessionFromAuth account lookup:', accountErr);
      this._lastLoginMessage = 'Could not verify your account status right now. Please try again in a moment.';
      sessionStorage.removeItem('pb_session');
      localStorage.removeItem('pb_session');
      return null;
    }

    if (!acc) {
      const meta = authData.user.user_metadata || {};
      if (meta.role === 'host' && meta.account_status === 'pending') {
        this._lastLoginMessage = 'Your host application is pending review.';
      } else if (meta.role === 'host' && meta.account_status === 'suspended') {
        this._lastLoginMessage = 'Your host application was not approved. Please contact the court owner.';
      } else {
        this._lastLoginMessage = 'This login is not linked to a dashboard account.';
      }
      await _sb.auth.signOut();
      sessionStorage.removeItem('pb_session');
      localStorage.removeItem('pb_session');
      return null;
    }

    const session = { ...rowToAccount(acc), loginAt: new Date().toISOString() };

    if (session.status && session.status !== 'active') {
      this._lastLoginMessage = session.status === 'pending'
        ? 'Your host application is pending review.'
        : 'This account is not active. Please contact the court owner.';
      await _sb.auth.signOut();
      sessionStorage.removeItem('pb_session');
      localStorage.removeItem('pb_session');
      return null;
    }

    const shouldRemember = remember === null ? localStorage.getItem('pb_remember') === '1' : !!remember;
    sessionStorage.removeItem('pb_session');
    localStorage.removeItem('pb_session');
    const store = shouldRemember ? localStorage : sessionStorage;
    store.setItem('pb_session', JSON.stringify(session));
    if (shouldRemember) localStorage.setItem('pb_remember', '1');
    else localStorage.removeItem('pb_remember');
    return session;
  },

  async login(email, password, remember = false) {
    // Sign in via Supabase Auth — establishes a verified JWT session.
    const { data, error } = await _sb.auth.signInWithPassword({ email, password });
    if (error || !data.user) return { ok: false, msg: error?.message || 'Invalid email or password.' };
    this._lastLoginMessage = '';
    const session = await this.refreshSessionFromAuth({ remember });
    return session ? { ok: true } : { ok: false, msg: this._lastLoginMessage || 'Account is not active.' };
  },

  getSession() {
    // Check localStorage first (remembered), then sessionStorage (tab-only).
    const s = localStorage.getItem('pb_session') || sessionStorage.getItem('pb_session');
    if (!s) return null;
    try { return JSON.parse(s); }
    catch (_) {
      localStorage.removeItem('pb_session');
      sessionStorage.removeItem('pb_session');
      return null;
    }
  },

  requireAuth() {
    const sess = this.getSession();
    if (!sess) { window.location.href = 'login.html'; return null; }
    return sess;
  },

  async logout() {
    await _sb.auth.signOut();
    sessionStorage.removeItem('pb_session');
    localStorage.removeItem('pb_session');
    localStorage.removeItem('pb_remember');
    window.location.href = 'login.html';
  },

  // Used by admin.html account management
  async getAll() {
    return DB.getAccounts();
  },

  async add(d) {
    try {
      await _invokeEdgeFunction('manage-account', {
        action: 'create',
        fullName: d.fullName,
        username: d.username,
        email: d.email,
        password: d.password,
        role: this.ROLES.includes(d.role) ? d.role : 'staff',
        status: d.status || 'active',
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: _extractFnError(e, 'Account create failed.') };
    }
  },

  async update(id, d) {
    try {
      await _invokeEdgeFunction('manage-account', {
        action: 'update',
        id,
        fullName: d.fullName,
        username: d.username,
        email: d.email,
        password: d.password || '',
        role: this.ROLES.includes(d.role) ? d.role : 'staff',
        status: d.status || 'active',
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: _extractFnError(e, 'Account update failed.') };
    }
  },

  // Self-service password change for the currently signed-in user.
  // Verifies the current password first, then updates Supabase Auth (the source
  // of truth for login). Any signed-in role (owner / court_owner / staff) can use it.
  async changePassword(currentPassword, newPassword) {
    const sess = this.getSession();
    if (!sess || !sess.email) return { ok: false, msg: 'No active session. Please sign in again.' };
    if (!newPassword || newPassword.length < 6) return { ok: false, msg: 'New password must be at least 6 characters.' };

    // Re-authenticate to confirm the current password is correct.
    const { error: authErr } = await _sb.auth.signInWithPassword({ email: sess.email, password: currentPassword });
    if (authErr) return { ok: false, msg: 'Current password is incorrect.' };

    // Update the password in Supabase Auth.
    const { error: updErr } = await _sb.auth.updateUser({ password: newPassword });
    if (updErr) return { ok: false, msg: updErr.message || 'Could not update password.' };

    return { ok: true };
  },

  async del(id) {
    try {
      await _invokeEdgeFunction('manage-account', { action: 'delete', id });
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: _extractFnError(e, 'Account delete failed.') };
    }
  },
};

if (window.PB_USE_LOCAL_DATA) {
  Object.assign(window.Auth, {
    async login(usernameOrEmail, password, remember = false) {
      const accounts = await DB.getAccounts();
      const user = accounts.find(a =>
        (a.username === usernameOrEmail || a.email === usernameOrEmail) &&
        (!a.password || a.password === password)
      );
      if (!user) return { ok: false, msg: 'Invalid email or password.' };
      if (user.status && user.status !== 'active') {
        return {
          ok: false,
          msg: user.status === 'pending'
            ? 'Your host application is pending review.'
            : 'This account is not active. Please contact the court owner.',
        };
      }
      const session = { ...user, loginAt: new Date().toISOString(), isLocalData: true };
      const store = remember ? localStorage : sessionStorage;
      store.setItem('pb_session', JSON.stringify(session));
      if (remember) localStorage.setItem('pb_remember', '1');
      return { ok: true };
    },

    async logout() {
      sessionStorage.removeItem('pb_session');
      localStorage.removeItem('pb_session');
      localStorage.removeItem('pb_remember');
      window.location.href = 'login.html';
    },

    async add(d) {
      const all = await DB.getAccounts();
      if (all.find(x => x.username === d.username || x.email === d.email)) return { ok: false, msg: 'Username or email already exists.' };
      const acc = {
        id: `local_${Date.now().toString(36)}`,
        fullName: d.fullName,
        username: d.username,
        password: d.password,
        email: d.email,
        role: this.ROLES.includes(d.role) ? d.role : 'staff',
        status: d.status || 'active',
        createdAt: new Date().toISOString(),
      };
      await DB.saveAccount(acc);
      return { ok: true };
    },

    async changePassword(currentPassword, newPassword) {
      const sess = this.getSession();
      if (!sess) return { ok: false, msg: 'No active session. Please sign in again.' };
      const accounts = await DB.getAccounts();
      const user = accounts.find(a => String(a.id) === String(sess.id));
      if (user?.password && user.password !== currentPassword) return { ok: false, msg: 'Current password is incorrect.' };
      if (!newPassword || newPassword.length < 6) return { ok: false, msg: 'New password must be at least 6 characters.' };
      await DB.saveAccount({ ...user, password: newPassword });
      return { ok: true };
    },
  });
}
