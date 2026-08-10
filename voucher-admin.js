/* Owner/court-owner voucher management UI. Loaded before the dashboard script. */
(function () {
  let voucherRows = [];
  let redemptionRows = [];
  let courtRows = [];
  let editingVoucherId = null;

  const byId = id => document.getElementById(id);
  const safe = value => String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[ch]);
  const money = value => `₱${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const localDateTime = value => {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const offset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  };

  function statusFor(voucher, usage) {
    const now = Date.now();
    if (!voucher.active || voucher.archived_at) return 'paused';
    if (voucher.starts_at && new Date(voucher.starts_at).getTime() > now) return 'scheduled';
    if (voucher.ends_at && new Date(voucher.ends_at).getTime() <= now) return 'expired';
    if (voucher.usage_limit != null && usage >= Number(voucher.usage_limit)) return 'exhausted';
    return 'active';
  }

  function usageFor(id) {
    return redemptionRows.filter(row => row.voucher_id === id && ['reserved', 'redeemed'].includes(row.status)).length;
  }

  function ensureEditor() {
    if (byId('voucherEditorModal')) return;
    const overlay = document.createElement('div');
    overlay.id = 'voucherEditorModal';
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:760px;max-height:92vh;overflow:auto">
        <div class="m-hd"><h2 id="voucherEditorTitle">Create Voucher</h2><button class="m-x" type="button" onclick="closeVoucherEditor()">&times;</button></div>
        <div class="m-body">
          <input type="hidden" id="voucherId" />
          <div class="frow">
            <div class="fg"><label class="fl" for="voucherCode">Code *</label><div style="display:flex;gap:8px"><input class="fi" id="voucherCode" maxlength="24" placeholder="PLAY100" oninput="this.value=this.value.toUpperCase().replace(/[^A-Z0-9-]/g,'')"/><button class="btn btn-g btn-sm" type="button" onclick="generateVoucherCode()">Generate</button></div></div>
            <div class="fg"><label class="fl" for="voucherName">Name *</label><input class="fi" id="voucherName" maxlength="80" placeholder="Weekend welcome voucher" /></div>
          </div>
          <div class="fg"><label class="fl" for="voucherDescription">Internal description</label><textarea class="fi" id="voucherDescription" rows="2" placeholder="Why this voucher exists"></textarea></div>
          <div class="frow">
            <div class="fg"><label class="fl" for="voucherDiscountType">Discount type</label><select class="fi" id="voucherDiscountType" onchange="syncVoucherEditor()"><option value="fixed">Fixed amount (₱)</option><option value="percent">Percentage (%)</option></select></div>
            <div class="fg"><label class="fl" for="voucherDiscountValue">Value *</label><input class="fi" id="voucherDiscountValue" type="number" min="0.01" step="0.01" /></div>
            <div class="fg" id="voucherMaxDiscountWrap"><label class="fl" for="voucherMaxDiscount">Maximum discount</label><input class="fi" id="voucherMaxDiscount" type="number" min="0.01" step="0.01" placeholder="Optional cap" /></div>
          </div>
          <div class="frow">
            <div class="fg"><label class="fl" for="voucherMinimumSpend">Minimum court spend</label><input class="fi" id="voucherMinimumSpend" type="number" min="0" step="0.01" value="0" /></div>
            <div class="fg"><label class="fl" for="voucherUsageLimit">Total usage limit</label><input class="fi" id="voucherUsageLimit" type="number" min="1" step="1" placeholder="Blank = unlimited" /></div>
          </div>
          <div class="frow">
            <div class="fg"><label class="fl" for="voucherStartsAt">Starts</label><input class="fi" id="voucherStartsAt" type="datetime-local" /></div>
            <div class="fg"><label class="fl" for="voucherEndsAt">Ends</label><input class="fi" id="voucherEndsAt" type="datetime-local" /></div>
          </div>
          <div class="fg"><label class="fl">Applicable courts</label><div id="voucherCourtPicker" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;padding:10px;border:1px solid var(--border);border-radius:9px"><span style="color:var(--muted)">Loading courts...</span></div><div style="font-size:.72rem;color:var(--muted);margin-top:5px">No selection means all courts.</div></div>
          <label style="display:flex;align-items:center;gap:8px;font-size:.84rem"><input id="voucherActive" type="checkbox" checked /> Active and available to players</label>
        </div>
        <div class="m-foot"><button class="btn btn-g" type="button" onclick="closeVoucherEditor()">Cancel</button><button class="btn btn-p" id="voucherSaveBtn" type="button" onclick="saveVoucherEditor()">Save Voucher</button></div>
      </div>`;
    overlay.addEventListener('click', event => { if (event.target === overlay) closeVoucherEditor(); });
    document.body.appendChild(overlay);
  }

  window.generateVoucherCode = function generateVoucherCode() {
    const token = crypto?.getRandomValues
      ? [...crypto.getRandomValues(new Uint8Array(5))].map(n => (n % 36).toString(36)).join('').toUpperCase()
      : Math.random().toString(36).slice(2, 7).toUpperCase();
    byId('voucherCode').value = `KORTE-${token}`;
  };

  window.syncVoucherEditor = function syncVoucherEditor() {
    byId('voucherMaxDiscountWrap').style.display = byId('voucherDiscountType').value === 'percent' ? '' : 'none';
  };

  window.openVoucherEditor = async function openVoucherEditor(id = null) {
    ensureEditor();
    editingVoucherId = id;
    if (!courtRows.length) courtRows = await DB.getCourts();
    const voucher = id ? voucherRows.find(row => row.id === id) : null;
    byId('voucherEditorTitle').textContent = voucher ? 'Edit Voucher' : 'Create Voucher';
    byId('voucherId').value = voucher?.id || '';
    byId('voucherCode').value = voucher?.code || '';
    byId('voucherName').value = voucher?.name || '';
    byId('voucherDescription').value = voucher?.description || '';
    byId('voucherDiscountType').value = voucher?.discount_type || 'fixed';
    byId('voucherDiscountValue').value = voucher?.discount_value ?? '';
    byId('voucherMaxDiscount').value = voucher?.max_discount ?? '';
    byId('voucherMinimumSpend').value = voucher?.minimum_spend ?? 0;
    byId('voucherUsageLimit').value = voucher?.usage_limit ?? '';
    byId('voucherStartsAt').value = localDateTime(voucher?.starts_at);
    byId('voucherEndsAt').value = localDateTime(voucher?.ends_at);
    byId('voucherActive').checked = voucher?.active !== false;
    const selected = new Set((voucher?.applicable_court_ids || []).map(String));
    byId('voucherCourtPicker').innerHTML = courtRows.map(court => `<label style="display:flex;align-items:center;gap:7px"><input class="voucher-court" type="checkbox" value="${safe(court.id)}" ${selected.has(String(court.id)) ? 'checked' : ''}/> ${safe(court.name)}</label>`).join('') || '<span style="color:var(--muted)">No courts configured.</span>';
    syncVoucherEditor();
    byId('voucherEditorModal').classList.add('show');
  };

  window.closeVoucherEditor = function closeVoucherEditor() {
    byId('voucherEditorModal')?.classList.remove('show');
    editingVoucherId = null;
  };

  window.saveVoucherEditor = async function saveVoucherEditor() {
    const button = byId('voucherSaveBtn');
    const code = byId('voucherCode').value.trim().toUpperCase();
    const name = byId('voucherName').value.trim();
    const type = byId('voucherDiscountType').value;
    const value = Number(byId('voucherDiscountValue').value);
    const maxDiscount = byId('voucherMaxDiscount').value;
    const starts = byId('voucherStartsAt').value;
    const ends = byId('voucherEndsAt').value;
    if (!/^[A-Z0-9][A-Z0-9-]{3,23}$/.test(code)) return toast('Voucher code must be 4–24 letters, numbers, or hyphens.', 'err');
    if (!name) return toast('Enter a voucher name.', 'err');
    if (!(value > 0) || (type === 'percent' && value > 100)) return toast('Enter a valid discount value.', 'err');
    if (starts && ends && new Date(ends) <= new Date(starts)) return toast('The end time must be after the start time.', 'err');
    button.disabled = true;
    button.textContent = 'Saving...';
    try {
      await DB.saveVoucher({
        id: editingVoucherId,
        code,
        name,
        description: byId('voucherDescription').value,
        discountType: type,
        discountValue: value,
        maxDiscount: type === 'percent' ? maxDiscount : null,
        minimumSpend: byId('voucherMinimumSpend').value,
        usageLimit: byId('voucherUsageLimit').value,
        courtIds: [...document.querySelectorAll('.voucher-court:checked')].map(input => input.value),
        startsAt: starts ? new Date(starts).toISOString() : null,
        endsAt: ends ? new Date(ends).toISOString() : null,
        active: byId('voucherActive').checked,
      });
      closeVoucherEditor();
      toast('Voucher saved.');
      await renderVouchers();
    } catch (error) {
      toast(error?.message || 'Voucher could not be saved.', 'err');
    } finally {
      button.disabled = false;
      button.textContent = 'Save Voucher';
    }
  };

  window.toggleVoucherActive = async function toggleVoucherActive(id, active) {
    try {
      await DB.setVoucherActive(id, active);
      toast(active ? 'Voucher activated.' : 'Voucher paused.');
      await renderVouchers();
    } catch (error) { toast(error?.message || 'Voucher status could not be changed.', 'err'); }
  };

  window.renderVouchers = async function renderVouchers() {
    const body = byId('voucherTableBody');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:24px">Loading vouchers...</td></tr>';
    try {
      [voucherRows, redemptionRows, courtRows] = await Promise.all([DB.getVouchers(), DB.getVoucherRedemptions(), DB.getCourts()]);
      const search = (byId('voucherSearch')?.value || '').trim().toLowerCase();
      const filter = byId('voucherStatusFilter')?.value || '';
      const rows = voucherRows.filter(voucher => {
        const usage = usageFor(voucher.id);
        const status = statusFor(voucher, usage);
        return (!search || `${voucher.code} ${voucher.name}`.toLowerCase().includes(search)) && (!filter || filter === status);
      });
      const counts = voucherRows.reduce((out, voucher) => { const key = statusFor(voucher, usageFor(voucher.id)); out[key] = (out[key] || 0) + 1; return out; }, {});
      byId('voucherStats').innerHTML = [
        ['Active', counts.active || 0, '✓'], ['Scheduled', counts.scheduled || 0, '◷'], ['Redeemed', redemptionRows.filter(r => r.status === 'redeemed').length, '#'], ['Expired', counts.expired || 0, '×'],
      ].map(([label, value, icon]) => `<div class="sc"><div class="sc-lbl">${label}</div><div class="sc-val">${value}</div><div class="sc-ic">${icon}</div></div>`).join('');
      body.innerHTML = rows.length ? rows.map(voucher => {
        const usage = usageFor(voucher.id);
        const status = statusFor(voucher, usage);
        const discount = voucher.discount_type === 'percent' ? `${Number(voucher.discount_value)}%${voucher.max_discount ? ` (max ${money(voucher.max_discount)})` : ''}` : money(voucher.discount_value);
        const validity = `${voucher.starts_at ? new Date(voucher.starts_at).toLocaleDateString() : 'Now'} – ${voucher.ends_at ? new Date(voucher.ends_at).toLocaleDateString() : 'No expiry'}`;
        return `<tr><td><strong>${safe(voucher.code)}</strong></td><td><strong>${safe(voucher.name)}</strong><div style="font-size:.72rem;color:var(--muted)">${safe(voucher.description || '')}</div></td><td>${discount}</td><td>${money(voucher.minimum_spend)}</td><td>${safe(validity)}</td><td>${usage} / ${voucher.usage_limit ?? '∞'}</td><td><span class="badge">${safe(status)}</span></td><td><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-g btn-sm" onclick="openVoucherEditor('${voucher.id}')">Edit</button><button class="btn ${voucher.active ? 'btn-d' : 'btn-p'} btn-sm" onclick="toggleVoucherActive('${voucher.id}',${!voucher.active})">${voucher.active ? 'Pause' : 'Activate'}</button></div></td></tr>`;
      }).join('') : '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:28px">No vouchers match this view.</td></tr>';
      const recent = redemptionRows.slice(0, 20);
      byId('voucherRedemptions').innerHTML = recent.length ? `<div class="tbl-scroll"><table><thead><tr><th>Voucher</th><th>Booking</th><th>Customer</th><th>Discount</th><th>Status</th><th>Date</th></tr></thead><tbody>${recent.map(row => { const voucher = voucherRows.find(v => v.id === row.voucher_id); return `<tr><td>${safe(voucher?.code || 'Unknown')}</td><td>${safe((row.booking_refs || []).join(', '))}</td><td>${safe(row.customer_email || 'Reserved')}</td><td>${money(row.discount_amount)}</td><td>${safe(row.status)}</td><td>${new Date(row.created_at).toLocaleString()}</td></tr>`; }).join('')}</tbody></table></div>` : 'No voucher redemptions yet.';
    } catch (error) {
      body.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--red);padding:24px">${safe(error?.message || 'Vouchers could not be loaded.')}</td></tr>`;
    }
  };
})();
