/* Player booking voucher controller. The database RPC is authoritative. */
(function () {
  let applied = null;
  let busy = false;

  const el = id => document.getElementById(id);
  const refs = () => typeof reservedRefs === 'function' ? reservedRefs() : [];
  const items = () => typeof activeBookingItems === 'function' ? activeBookingItems() : [];
  const php = value => typeof fmt === 'function' ? fmt(value) : `₱${Number(value || 0).toFixed(2)}`;

  function status(message = '', type = '') {
    const node = el('bVoucherStatus');
    if (!node) return;
    node.textContent = message;
    node.className = `voucher-status${message ? ' show' : ''}${type ? ` ${type}` : ''}`;
  }

  function refresh() {
    const input = el('bVoucherCode');
    const applyButton = el('bVoucherApply');
    const removeButton = el('bVoucherRemove');
    if (input) input.disabled = busy || !!applied;
    if (applyButton) {
      applyButton.disabled = busy || !!applied;
      applyButton.style.display = applied ? 'none' : '';
      applyButton.textContent = busy ? 'Checking…' : 'Apply';
    }
    if (removeButton) {
      removeButton.disabled = busy;
      removeButton.style.display = applied ? '' : 'none';
    }
    if (typeof updatePrice === 'function') updatePrice();
    if (typeof updateWiz3Summary === 'function') updateWiz3Summary();
    if (typeof saveGuestBookingResume === 'function') saveGuestBookingResume({ voucherCode: applied?.code || null });
  }

  function applyAllocations(result) {
    const byRef = new Map((result?.allocations || []).map(row => [String(row.ref), row]));
    items().forEach(item => {
      const allocation = byRef.get(String(item.ref));
      if (!allocation) return;
      item.grossTotal = Number(allocation.grossTotal ?? item.total ?? 0);
      item.voucherDiscountAmount = Number(allocation.discountAmount || 0);
      item.voucherCode = result.code;
      item.voucherId = result.id;
      item.total = Number(allocation.total ?? (item.grossTotal - item.voucherDiscountAmount));
    });
  }

  function restoreItems() {
    items().forEach(item => {
      if (item.grossTotal != null) item.total = Number(item.grossTotal);
      item.grossTotal = null;
      item.voucherDiscountAmount = 0;
      item.voucherCode = null;
      item.voucherId = null;
    });
  }

  window.BookingVoucher = {
    current: () => applied,
    discount(list = items()) { return list.reduce((sum, item) => sum + Number(item.voucherDiscountAmount || 0), 0); },
    grossTotal(list = items()) { return list.reduce((sum, item) => sum + Number(item.grossTotal ?? item.total ?? 0), 0); },
    netCourtFee(item) { return Math.max(0, Number(item?.courtFee || 0) - Number(item?.voucherDiscountAmount || 0)); },
    codeInput(input) {
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
      status();
    },
    async apply() {
      if (busy) return;
      const code = (el('bVoucherCode')?.value || '').trim().toUpperCase();
      if (!code) { status('Enter a voucher code first.', 'err'); el('bVoucherCode')?.focus(); return; }
      if (typeof isVerifiedHostBooking === 'function' && isVerifiedHostBooking()) {
        status('Vouchers are currently available for regular court bookings only.', 'err');
        return;
      }
      const bookingRefs = refs();
      if (!bookingRefs.length) { status('Select and reserve your court slots first.', 'err'); return; }
      busy = true; status('Checking this voucher…'); refresh();
      try {
        const result = await DB.applyBookingVoucher(code, bookingRefs);
        applied = result;
        applyAllocations(result);
        status(`${result.code} applied — ${php(result.discountAmount)} off the court fee.`, 'ok');
      } catch (error) {
        status(error?.message || 'Code is not valid for this booking.', 'err');
      } finally { busy = false; refresh(); }
    },
    async remove(options = {}) {
      if (busy || !applied) return;
      busy = true; refresh();
      try {
        const bookingRefs = refs();
        if (bookingRefs.length) await DB.removeBookingVoucher(bookingRefs);
        restoreItems();
        applied = null;
        if (el('bVoucherCode')) el('bVoucherCode').value = '';
        status(options.silent ? '' : 'Voucher removed.');
      } catch (error) {
        if (!options.silent) status(error?.message || 'Voucher could not be removed.', 'err');
        throw error;
      } finally { busy = false; refresh(); }
    },
    async finalize(customerEmail) {
      if (!applied) return;
      await DB.finalizeBookingVoucher(refs(), customerEmail);
    },
    hydrate(list = items()) {
      const first = list.find(item => item.voucherCode || item.voucherDiscountAmount > 0);
      if (!first) return;
      applied = {
        id: first.voucherId || null,
        code: first.voucherCode,
        discountAmount: list.reduce((sum, item) => sum + Number(item.voucherDiscountAmount || 0), 0),
      };
      if (el('bVoucherCode')) el('bVoucherCode').value = applied.code || '';
      status(`${applied.code} applied — ${php(applied.discountAmount)} off the court fee.`, 'ok');
      refresh();
    },
    reset() {
      applied = null;
      if (el('bVoucherCode')) el('bVoucherCode').value = '';
      status();
      refresh();
    },
  };
})();
