/* Automatic, schedule-scoped demand campaign pricing for new booking holds. */
(function () {
  let applied = null;
  let previewNotice = null;
  const PRICE_CHECK_TIMEOUT_MS = 2500;
  const OFFER_PREVIEW_CACHE_MS = 20000;
  const offerPreviewCache = new Map();
  const offerPreviewLoads = new Map();

  const el = id => document.getElementById(id);
  const php = value => typeof fmt === 'function' ? fmt(value) : `₱${Number(value || 0).toFixed(2)}`;

  function cleanDate(value) {
    const date = String(value || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
  }

  function finiteNumber(...values) {
    for (const value of values) {
      if (value === null || value === undefined || value === '') continue;
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return null;
  }

  function offerKey(courtId, date, slotHour) {
    return `${String(courtId || '')}|${cleanDate(date)}|${Number(slotHour)}`;
  }

  function normalizeOffer(row, requestedDate) {
    const courtId = row?.courtId ?? row?.court_id;
    const date = cleanDate(row?.offerDate ?? row?.offer_date ?? row?.date ?? requestedDate);
    const slotHour = finiteNumber(row?.slotHour, row?.slot_hour);
    const discountPercent = finiteNumber(row?.discountPercent, row?.discount_percent);
    const regularRate = finiteNumber(row?.regularRate, row?.regular_rate, row?.grossRate, row?.gross_rate);
    const offerRate = finiteNumber(row?.offerRate, row?.offer_rate, row?.netRate, row?.net_rate);
    const endsAt = row?.endsAt || row?.ends_at || null;
    if (courtId == null || !date || !Number.isInteger(slotHour) || slotHour < 0 || slotHour > 23) return null;
    if (!(discountPercent > 0 && discountPercent <= 100)) return null;
    if (endsAt) {
      const endsAtMs = new Date(endsAt).getTime();
      if (!Number.isFinite(endsAtMs) || endsAtMs <= Date.now()) return null;
    }
    return {
      courtId: String(courtId),
      date,
      slotHour,
      discountPercent,
      regularRate,
      offerRate,
      endsAt,
    };
  }

  function normalizedOfferRows(payload, requestedDate) {
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.offers) ? payload.offers
        : Array.isArray(payload?.slots) ? payload.slots
          : Array.isArray(payload?.data) ? payload.data : [];
    const unique = new Map();
    rows.forEach(row => {
      const normalized = normalizeOffer(row, requestedDate);
      if (normalized) unique.set(offerKey(normalized.courtId, normalized.date, normalized.slotHour), normalized);
    });
    return [...unique.values()];
  }

  function offersForDate(date) {
    const clean = cleanDate(date);
    const cached = offerPreviewCache.get(clean);
    if (!cached) return [];
    const now = Date.now();
    return cached.offers.filter(offer => !offer.endsAt || new Date(offer.endsAt).getTime() > now);
  }

  async function loadOffersForDate(date, options = {}) {
    const clean = cleanDate(date);
    if (!clean) return [];
    const cached = offerPreviewCache.get(clean);
    if (!options.force && cached && Date.now() - cached.loadedAt < OFFER_PREVIEW_CACHE_MS) {
      return offersForDate(clean);
    }
    if (!options.force && offerPreviewLoads.has(clean)) return offerPreviewLoads.get(clean);
    if (typeof DB?.getPublicDemandCampaignSlotOffers !== 'function') {
      offerPreviewCache.set(clean, { loadedAt: Date.now(), offers: [] });
      return [];
    }

    const load = Promise.resolve()
      .then(() => DB.getPublicDemandCampaignSlotOffers(clean))
      .then(payload => {
        const offers = normalizedOfferRows(payload, clean);
        offerPreviewCache.set(clean, { loadedAt: Date.now(), offers });
        return offers;
      })
      .catch(error => {
        // Offer discovery is an enhancement only. Ordinary availability and
        // booking must continue when this small public read is unavailable.
        console.warn('Smart Rate preview unavailable; showing regular rates.', error);
        offerPreviewCache.set(clean, { loadedAt: Date.now(), offers: [] });
        return [];
      })
      .finally(() => offerPreviewLoads.delete(clean));
    offerPreviewLoads.set(clean, load);
    return load;
  }

  function offerForSlot(courtId, date, slotHour) {
    const key = offerKey(courtId, date, slotHour);
    return offersForDate(date).find(offer => offerKey(offer.courtId, offer.date, offer.slotHour) === key) || null;
  }

  function previewPrice(courtId, date, slotHour, fallbackRegularRate = 0) {
    const offer = offerForSlot(courtId, date, slotHour);
    const fallback = Math.max(0, Number(fallbackRegularRate) || 0);
    if (!offer) return { hasOffer: false, regularRate: fallback, offerRate: fallback, discountPercent: 0 };
    const regularRate = Math.max(0, finiteNumber(offer.regularRate, fallback) ?? fallback);
    const calculatedOffer = Math.round(regularRate * (1 - offer.discountPercent / 100) * 100) / 100;
    const offerRate = Math.max(0, finiteNumber(offer.offerRate, calculatedOffer) ?? calculatedOffer);
    if (!(offerRate < regularRate)) {
      return { hasOffer: false, regularRate: fallback, offerRate: fallback, discountPercent: 0 };
    }
    return {
      hasOffer: true,
      regularRate,
      offerRate,
      discountPercent: offer.discountPercent,
      endsAt: offer.endsAt,
    };
  }

  function slotMarkupData(courtId, date, slotHour, fallbackRegularRate = 0) {
    const preview = previewPrice(courtId, date, slotHour, fallbackRegularRate);
    if (!preview.hasOffer) return { ...preview, className: '', badgeText: '', ariaText: '' };
    const percent = Number.isInteger(preview.discountPercent)
      ? String(preview.discountPercent)
      : preview.discountPercent.toFixed(1).replace(/\.0$/, '');
    return {
      ...preview,
      className: 'smart-rate',
      badgeText: `${percent}% OFF`,
      ariaText: `Smart Rate ${percent} percent off, ${php(preview.offerRate)}, regular ${php(preview.regularRate)}`,
    };
  }

  function selectionHasPreview(selections = []) {
    return (selections || []).some(selection => (selection?.slots || []).some(slotHour =>
      !!offerForSlot(selection?.courtId, selection?.date, slotHour)));
  }

  function invalidateOfferDates(items = []) {
    (items || []).forEach(item => {
      const date = cleanDate(item?.date);
      if (date) offerPreviewCache.delete(date);
    });
  }

  function withTimeout(promise, timeoutMs = PRICE_CHECK_TIMEOUT_MS) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Smart offer price check timed out.');
        error.code = 'DEMAND_CAMPAIGN_TIMEOUT';
        reject(error);
      }, timeoutMs);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
  }

  function setBookingUi() {
    const status = el('bDemandOfferStatus');
    const voucherEntry = el('bookingVoucherEntry');
    if (status) {
      status.classList.toggle('show', !!applied || !!previewNotice);
      status.classList.toggle('notice', !applied && !!previewNotice);
      status.innerHTML = applied
        ? `<span aria-hidden="true">✦</span><div><strong>Smart Rate applied automatically</strong>You saved ${php(applied.discountAmount)} on the highlighted time. No code is needed.</div>`
        : previewNotice
          ? `<span aria-hidden="true">i</span><div><strong>Smart Rate updated</strong>${previewNotice}</div>`
          : '';
    }
    if (voucherEntry) voucherEntry.style.display = applied ? 'none' : '';
  }

  function applyAllocations(result, items = []) {
    const byRef = new Map((result?.allocations || []).map(row => [String(row.ref), row]));
    items.forEach(item => {
      const allocation = byRef.get(String(item.ref));
      if (!allocation) return;
      item.demandCampaignGrossTotal = Number(allocation.grossTotal ?? allocation.gross_total ?? item.total ?? 0);
      item.demandCampaignDiscountAmount = Number(allocation.discountAmount ?? allocation.discount_amount ?? 0);
      item.demandCampaignId = result.campaignId || result.campaign_id || result.id || null;
      item.demandCampaignName = 'Smart Rate';
      item.total = Number(allocation.total ?? (item.demandCampaignGrossTotal - item.demandCampaignDiscountAmount));
    });
  }

  function hydrateFromItems(items = []) {
    const matched = items.filter(item => item.demandCampaignId || Number(item.demandCampaignDiscountAmount || 0) > 0);
    if (!matched.length) return null;
    applied = {
      campaignId: matched[0].demandCampaignId || null,
      name: 'Smart Rate',
      discountAmount: matched.reduce((sum, item) => sum + Number(item.demandCampaignDiscountAmount || 0), 0),
    };
    setBookingUi();
    return applied;
  }

  window.BookingDemandCampaign = {
    current: () => applied,
    discount(items = []) {
      return items.reduce((sum, item) => sum + Number(item.demandCampaignDiscountAmount || 0), 0);
    },
    netCourtFee(item) {
      return Math.max(0, Number(item?.courtFee || 0) - Number(item?.demandCampaignDiscountAmount || 0));
    },
    async autoApply(bookingRefs, items = [], options = {}) {
      if (!Array.isArray(bookingRefs) || !bookingRefs.length || typeof DB?.applyMatchingDemandCampaign !== 'function') return null;
      let result;
      try {
        try {
          result = await withTimeout(DB.applyMatchingDemandCampaign(bookingRefs, options), options.timeoutMs);
        } catch (firstError) {
          if (firstError?.code !== 'DEMAND_CAMPAIGN_TIMEOUT' && !/network|fetch|connection/i.test(String(firstError?.message || ''))) throw firstError;
          // The database operation is idempotent. A second call reconciles an
          // offer that committed when the first network response was lost.
          result = await withTimeout(DB.applyMatchingDemandCampaign(bookingRefs, options), options.timeoutMs);
        }
      } finally {
        // The authoritative check may consume quota or end an offer. Force the
        // next calendar render to request fresh badges instead of showing a
        // just-used preview for the remainder of the short UI cache window.
        invalidateOfferDates(items);
      }
      if (!result?.applied) return null;
      previewNotice = null;
      applied = {
        ...result,
        campaignId: result.campaignId || result.campaign_id || result.id || null,
        name: 'Smart Rate',
        discountAmount: Number(result.discountAmount ?? result.discount_amount ?? 0),
      };
      applyAllocations(applied, items);
      setBookingUi();
      return result;
    },
    loadOffersForDate,
    offersForDate,
    offerForSlot,
    previewPrice,
    slotMarkupData,
    selectionHasPreview,
    showPreviewUnavailableNotice(message = 'This limited offer was no longer available when your slot was reserved, so the regular rate is shown below. Your reservation is still secure.') {
      if (applied) return;
      previewNotice = message;
      setBookingUi();
    },
    hydrate(items = []) { return hydrateFromItems(items); },
    reset() {
      applied = null;
      previewNotice = null;
      setBookingUi();
    },
  };
})();
