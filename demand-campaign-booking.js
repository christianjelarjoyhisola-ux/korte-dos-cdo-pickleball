/* Automatic, schedule-scoped demand campaign pricing for new booking holds. */
(function () {
  let applied = null;
  const PRICE_CHECK_TIMEOUT_MS = 2500;

  const el = id => document.getElementById(id);
  const php = value => typeof fmt === 'function' ? fmt(value) : `₱${Number(value || 0).toFixed(2)}`;

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
      status.classList.toggle('show', !!applied);
      status.innerHTML = applied
        ? `<span aria-hidden="true">✦</span><div><strong>Smart growth offer applied automatically</strong>${php(applied.discountAmount)} saved on this weak-demand window. No code is needed.</div>`
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
      item.demandCampaignName = result.name || result.campaign_name || 'Smart growth offer';
      item.total = Number(allocation.total ?? (item.demandCampaignGrossTotal - item.demandCampaignDiscountAmount));
    });
  }

  function hydrateFromItems(items = []) {
    const matched = items.filter(item => item.demandCampaignId || Number(item.demandCampaignDiscountAmount || 0) > 0);
    if (!matched.length) return null;
    applied = {
      campaignId: matched[0].demandCampaignId || null,
      name: matched[0].demandCampaignName || 'Smart growth offer',
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
        result = await withTimeout(DB.applyMatchingDemandCampaign(bookingRefs, options), options.timeoutMs);
      } catch (firstError) {
        if (firstError?.code !== 'DEMAND_CAMPAIGN_TIMEOUT' && !/network|fetch|connection/i.test(String(firstError?.message || ''))) throw firstError;
        // The database operation is idempotent. A second call reconciles an
        // offer that committed when the first network response was lost.
        result = await withTimeout(DB.applyMatchingDemandCampaign(bookingRefs, options), options.timeoutMs);
      }
      if (!result?.applied) return null;
      applied = {
        ...result,
        campaignId: result.campaignId || result.campaign_id || result.id || null,
        name: result.name || result.campaign_name || 'Smart growth offer',
        discountAmount: Number(result.discountAmount ?? result.discount_amount ?? 0),
      };
      applyAllocations(applied, items);
      setBookingUi();
      return result;
    },
    hydrate(items = []) { return hydrateFromItems(items); },
    reset() {
      applied = null;
      setBookingUi();
    },
  };
})();
