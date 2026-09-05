(function hostBalanceAdminModule(global) {
  'use strict';

  const state = {
    payments: [],
    loadedAt: 0,
    loading: null,
    current: null,
    receiptLoaded: false,
    lastFocus: null,
    modalVersion: 0,
    busy: false,
    previousOverflow: '',
  };

  const byId = id => document.getElementById(id);

  function paymentId(payment) {
    return String(payment?.paymentId || payment?.id || '').trim();
  }

  function money(value) {
    const amount = Number(value || 0);
    return `₱${Number.isFinite(amount) ? amount.toFixed(2) : '0.00'}`;
  }

  function when(value) {
    const date = new Date(String(value || ''));
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('en-PH', {
      timeZone: 'Asia/Manila',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }

  function role() {
    try {
      return String(global.Auth?.getSession?.()?.role || '').toLowerCase();
    } catch (_) {
      return '';
    }
  }

  function canDecide() {
    return ['owner', 'court_owner'].includes(role());
  }

  function notify(message, kind) {
    if (typeof global.toast === 'function') global.toast(message, kind);
  }

  function supabaseClient() {
    if (global._supabase?.functions?.invoke) return global._supabase;
    try {
      if (typeof _sb !== 'undefined' && _sb?.functions?.invoke) return _sb;
    } catch (_) {
      // The shared client is a global lexical binding on production pages.
    }
    return null;
  }

  function apiCall(action, payload) {
    const api = global.HostBalancePaymentApi || global.HostBalancePayment;
    if (!api) throw new Error('Host balance payment service is unavailable.');

    if (action === 'list_pending') {
      if (typeof api.listPending === 'function') return api.listPending(payload);
      if (typeof api.adminListPending === 'function') return api.adminListPending(payload);
    }
    if (action === 'receipt_url') {
      if (typeof api.receiptUrl === 'function') return api.receiptUrl(payload.paymentId);
      if (typeof api.getReceiptUrl === 'function') return api.getReceiptUrl(payload.paymentId);
    }
    if (action === 'review' && typeof api.review === 'function') {
      return api.review(payload.paymentId, payload.decision, payload.reason || '');
    }
    if (typeof api.invoke === 'function') {
      return api.invoke(supabaseClient(), { action, ...(payload || {}) });
    }
    throw new Error('Host balance payment service is unavailable.');
  }

  function addStyles() {
    if (byId('hostBalanceAdminStyles')) return;
    const style = document.createElement('style');
    style.id = 'hostBalanceAdminStyles';
    style.textContent = `
      .hba-panel{margin-bottom:14px}
      .hba-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 20px;border-bottom:1px solid var(--border)}
      .hba-head h3{margin:0;font-size:1rem}
      .hba-sub{margin-top:4px;color:var(--muted);font-size:.76rem;line-height:1.45}
      .hba-list{display:grid;gap:10px;padding:14px}
      .hba-card{border:1px solid var(--border);border-radius:12px;padding:14px;background:var(--input)}
      .hba-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
      .hba-name{font-weight:850;color:var(--text)}
      .hba-ref{margin-top:3px;color:var(--muted);font-size:.72rem;overflow-wrap:anywhere}
      .hba-amount{font-weight:900;color:var(--yellow);white-space:nowrap}
      .hba-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 14px;margin-top:12px;font-size:.76rem;color:var(--text2)}
      .hba-meta b{display:block;margin-bottom:2px;color:var(--muted);font-size:.65rem;text-transform:uppercase;letter-spacing:.06em}
      .hba-bottom{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:13px;padding-top:11px;border-top:1px solid var(--border)}
      .hba-status{font-size:.72rem;font-weight:850;color:var(--yellow)}
      .hba-empty{padding:24px;text-align:center;color:var(--muted);font-size:.82rem}
      .hba-overlay{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(3,10,18,.82);backdrop-filter:blur(4px)}
      .hba-overlay[hidden]{display:none}
      .hba-modal{width:min(620px,100%);max-height:min(90vh,820px);overflow:auto;border:1px solid var(--border);border-radius:18px;background:var(--panel);box-shadow:0 24px 80px rgba(0,0,0,.5)}
      .hba-modal-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid var(--border);background:var(--panel)}
      .hba-modal-head h3{margin:0;font-size:1rem}
      .hba-close{width:38px;height:38px;border:1px solid var(--border);border-radius:10px;background:var(--input);color:var(--text);font-size:1.2rem;cursor:pointer}
      .hba-modal-body{padding:18px}
      .hba-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:14px}
      .hba-summary>div{padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--input);font-size:.78rem;overflow-wrap:anywhere}
      .hba-summary b{display:block;margin-bottom:3px;color:var(--muted);font-size:.64rem;text-transform:uppercase;letter-spacing:.06em}
      .hba-proof{min-height:220px;display:flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:12px;background:#07111d;overflow:hidden}
      .hba-proof img{display:none;width:100%;max-height:420px;object-fit:contain}
      .hba-proof-status{padding:20px;color:var(--muted);font-size:.8rem;text-align:center}
      .hba-flags{margin-top:10px;color:var(--muted);font-size:.72rem;line-height:1.5;overflow-wrap:anywhere}
      .hba-reason{width:100%;min-height:72px;margin-top:14px;padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--input);color:var(--text);resize:vertical}
      .hba-modal-actions{display:grid;grid-template-columns:1fr 1.4fr;gap:10px;margin-top:12px}
      .hba-modal-actions button{justify-content:center}
      @media(max-width:560px){
        .hba-head,.hba-card-top,.hba-bottom{align-items:stretch}
        .hba-head,.hba-card-top,.hba-bottom{flex-direction:column}
        .hba-meta,.hba-summary{grid-template-columns:1fr}
        .hba-modal-actions{grid-template-columns:1fr}
        .hba-overlay{align-items:flex-end;padding:0}
        .hba-modal{width:100%;max-height:94vh;border-radius:18px 18px 0 0}
      }
    `;
    document.head.appendChild(style);
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function ensurePanel() {
    const section = byId('sec-payreview');
    if (!section) return null;
    let panel = byId('hostBalanceAdminPanel');
    if (panel) return panel;

    addStyles();
    panel = make('section', 'pr-panel hba-panel');
    panel.id = 'hostBalanceAdminPanel';
    panel.setAttribute('aria-labelledby', 'hostBalanceAdminTitle');

    const head = make('div', 'hba-head');
    const heading = make('div');
    const title = make('h3', '', 'Host Balance Payments');
    title.id = 'hostBalanceAdminTitle';
    heading.append(title, make('div', 'hba-sub', 'Remaining-balance receipts awaiting an owner decision'));
    const refresh = make('button', 'btn btn-g btn-sm', 'Refresh balances');
    refresh.type = 'button';
    refresh.addEventListener('click', () => render(true));
    head.append(heading, refresh);

    const list = make('div', 'hba-list');
    list.id = 'hostBalanceAdminList';
    list.setAttribute('aria-live', 'polite');
    list.appendChild(make('div', 'hba-empty', 'Loading balance payments…'));
    panel.append(head, list);

    const firstReviewPanel = section.querySelector('.pr-panel');
    if (firstReviewPanel) section.insertBefore(panel, firstReviewPanel);
    else section.appendChild(panel);
    return panel;
  }

  function ensureModal() {
    let overlay = byId('hostBalanceReviewModal');
    if (overlay) return overlay;

    overlay = make('div', 'hba-overlay');
    overlay.id = 'hostBalanceReviewModal';
    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'hostBalanceReviewTitle');

    const modal = make('div', 'hba-modal');
    const head = make('div', 'hba-modal-head');
    const title = make('h3', '', 'Review Balance Payment');
    title.id = 'hostBalanceReviewTitle';
    const close = make('button', 'hba-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close balance payment review');
    close.addEventListener('click', closeModal);
    head.append(title, close);

    const body = make('div', 'hba-modal-body');
    const summary = make('div', 'hba-summary');
    summary.id = 'hostBalanceReviewSummary';

    const proof = make('div', 'hba-proof');
    const proofStatus = make('div', 'hba-proof-status', 'Loading receipt proof…');
    proofStatus.id = 'hostBalanceProofStatus';
    const image = document.createElement('img');
    image.id = 'hostBalanceProofImage';
    image.alt = 'Uploaded balance payment receipt';
    image.referrerPolicy = 'no-referrer';
    proof.append(proofStatus, image);

    const flags = make('div', 'hba-flags');
    flags.id = 'hostBalanceReviewFlags';
    const reason = document.createElement('textarea');
    reason.id = 'hostBalanceReviewReason';
    reason.className = 'hba-reason';
    reason.placeholder = 'Reason required when rejecting (at least 3 characters)';
    reason.setAttribute('aria-label', 'Review reason');
    reason.addEventListener('input', syncActions);

    const actions = make('div', 'hba-modal-actions');
    const reject = make('button', 'btn btn-r', 'Reject Receipt');
    reject.id = 'hostBalanceRejectBtn';
    reject.type = 'button';
    reject.addEventListener('click', () => decide('reject'));
    const approve = make('button', 'btn btn-p', 'Approve & Mark Fully Paid');
    approve.id = 'hostBalanceApproveBtn';
    approve.type = 'button';
    approve.addEventListener('click', () => decide('approve'));
    actions.append(reject, approve);

    body.append(summary, proof, flags, reason, actions);
    modal.append(head, body);
    overlay.appendChild(modal);
    overlay.addEventListener('mousedown', event => {
      if (event.target === overlay) closeModal();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !overlay.hidden) closeModal();
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function appendSummary(container, label, value) {
    const cell = make('div');
    cell.append(make('b', '', label), document.createTextNode(String(value || '—')));
    container.appendChild(cell);
  }

  function syncActions() {
    const approve = byId('hostBalanceApproveBtn');
    const reject = byId('hostBalanceRejectBtn');
    const reason = String(byId('hostBalanceReviewReason')?.value || '').trim();
    const permitted = canDecide() && Boolean(state.current);
    if (approve) approve.disabled = state.busy || !permitted || !state.receiptLoaded;
    if (reject) reject.disabled = state.busy || !permitted || !state.receiptLoaded || reason.length < 3;
  }

  async function openModal(payment, trigger) {
    if (!canDecide()) throw new Error('Only a Court Owner or System Owner can review host balance payments.');
    if (state.busy) return false;
    if (!paymentId(payment)) throw new Error('Balance payment could not be found.');
    const version = ++state.modalVersion;
    state.current = payment;
    state.receiptLoaded = false;
    state.lastFocus = trigger || document.activeElement;
    const overlay = ensureModal();
    if (overlay.hidden) state.previousOverflow = document.body.style.overflow;
    const summary = byId('hostBalanceReviewSummary');
    summary.replaceChildren();
    appendSummary(summary, 'Customer', payment.customerName);
    appendSummary(summary, 'Booking', payment.bookingGroupRef || payment.bookingRef || payment.bookingKey);
    appendSummary(summary, 'Balance paid', money(payment.balanceAmount || payment.expectedAmount));
    appendSummary(summary, 'Payment', `${String(payment.paymentProvider || '—').toUpperCase()} · ${payment.paymentReference || '—'}`);
    appendSummary(summary, 'Schedule', payment.scheduleLabel || payment.bookingDate);
    appendSummary(summary, 'Submitted', when(payment.submittedAt || payment.createdAt));

    const flags = Array.isArray(payment.receiptFlags) ? payment.receiptFlags : [];
    byId('hostBalanceReviewFlags').textContent = flags.length
      ? `Verification flags: ${flags.join(', ')}`
      : 'Verification flags: none';
    byId('hostBalanceReviewReason').value = '';
    // Each opening gets a fresh image so a previous receipt's delayed load
    // cannot enable approval for the newly selected payment.
    const previousImage = byId('hostBalanceProofImage');
    previousImage.removeAttribute('src');
    const image = document.createElement('img');
    image.id = 'hostBalanceProofImage';
    image.alt = 'Uploaded balance payment receipt';
    image.referrerPolicy = 'no-referrer';
    image.style.display = 'none';
    previousImage.replaceWith(image);
    const proofStatus = byId('hostBalanceProofStatus');
    const isCurrent = () => version === state.modalVersion && state.current === payment && !overlay.hidden;
    image.addEventListener('load', () => {
      if (!isCurrent() || !image.getAttribute('src')) return;
      state.receiptLoaded = true;
      image.style.display = 'block';
      proofStatus.style.display = 'none';
      syncActions();
    });
    image.addEventListener('error', () => {
      if (!isCurrent()) return;
      state.receiptLoaded = false;
      image.removeAttribute('src');
      image.style.display = 'none';
      proofStatus.style.display = '';
      proofStatus.textContent = 'Receipt image could not be loaded. Approval remains disabled.';
      syncActions();
    });
    proofStatus.style.display = '';
    proofStatus.textContent = 'Loading receipt proof…';
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    syncActions();
    overlay.querySelector('.hba-close')?.focus();

    try {
      const result = await apiCall('receipt_url', { paymentId: paymentId(payment) });
      if (!isCurrent()) return false;
      const rawUrl = result?.url || result?.data?.url;
      const url = new URL(String(rawUrl || ''));
      if (url.protocol !== 'https:') throw new Error('Receipt link is not secure.');
      image.src = url.href;
    } catch (error) {
      if (!isCurrent()) return false;
      proofStatus.textContent = error?.message || 'Receipt proof is unavailable.';
      syncActions();
    }
    return true;
  }

  function closeModal() {
    const overlay = byId('hostBalanceReviewModal');
    if (state.busy || !overlay || overlay.hidden) return;
    state.modalVersion += 1;
    overlay.hidden = true;
    document.body.style.overflow = state.previousOverflow;
    const image = byId('hostBalanceProofImage');
    image?.removeAttribute('src');
    state.current = null;
    state.receiptLoaded = false;
    state.lastFocus?.focus?.();
    state.lastFocus = null;
    syncActions();
  }

  async function decide(decision) {
    const payment = state.current;
    if (state.busy || !payment || !canDecide() || !state.receiptLoaded) return;
    if (!['approve', 'reject'].includes(decision)) return;
    const reason = String(byId('hostBalanceReviewReason')?.value || '').trim();
    if (decision === 'reject' && reason.length < 3) {
      notify('Enter a short reason before rejecting the receipt.', 'err');
      return;
    }
    if (
      decision === 'approve' &&
      !global.confirm(`Approve ${money(payment.balanceAmount || payment.expectedAmount)} and mark this booking fully paid?`)
    ) return;

    const approve = byId('hostBalanceApproveBtn');
    const reject = byId('hostBalanceRejectBtn');
    const active = decision === 'approve' ? approve : reject;
    const idleText = active?.textContent || '';
    let saved = false;
    if (active) active.textContent = decision === 'approve' ? 'Approving…' : 'Rejecting…';
    state.busy = true;
    syncActions();
    try {
      await apiCall('review', {
        paymentId: paymentId(payment),
        decision,
        reason,
      });
      saved = true;
      notify(
        decision === 'approve'
          ? 'Balance payment approved. The booking is fully paid.'
          : 'Balance receipt rejected.',
        decision === 'approve' ? 'ok' : 'inf',
      );
      state.busy = false;
      if (active?.isConnected) active.textContent = idleText;
      closeModal();
      // Drain a read started before the decision, then refresh the balance
      // cache before refreshing booking totals and the owner's review queue.
      if (state.loading) await state.loading.catch(() => {});
      state.loadedAt = 0;
      const refreshes = await Promise.allSettled([
        render(true),
        Promise.resolve().then(() => global.renderBookings?.()),
        Promise.resolve().then(() => global.renderPaymentReview?.()),
      ]);
      if (refreshes.some(result => result.status === 'rejected')) {
        notify('Payment decision saved. Refresh Bookings to see the latest totals.', 'inf');
      }
    } catch (error) {
      notify(error?.message || 'Could not save the balance payment decision.', 'err');
    } finally {
      if (!saved) {
        state.busy = false;
        if (active?.isConnected) active.textContent = idleText;
      }
      syncActions();
    }
  }

  function renderCards() {
    const list = byId('hostBalanceAdminList');
    if (!list) return;
    list.replaceChildren();
    if (!state.payments.length) {
      list.appendChild(make('div', 'hba-empty', 'No host balance receipts are waiting for review.'));
      return;
    }

    state.payments.forEach(payment => {
      const card = make('article', 'hba-card');
      const top = make('div', 'hba-card-top');
      const identity = make('div');
      identity.append(
        make('div', 'hba-name', payment.customerName || 'Host booking'),
        make('div', 'hba-ref', payment.bookingGroupRef || payment.bookingRef || payment.bookingKey || '—'),
      );
      top.append(identity, make('div', 'hba-amount', money(payment.balanceAmount || payment.expectedAmount)));

      const meta = make('div', 'hba-meta');
      appendSummary(meta, 'Schedule', payment.scheduleLabel || payment.bookingDate);
      appendSummary(meta, 'Court', payment.courtLabel);
      appendSummary(meta, 'Payment method', String(payment.paymentProvider || '—').toUpperCase());
      appendSummary(meta, 'Reference', payment.paymentReference);

      const bottom = make('div', 'hba-bottom');
      bottom.appendChild(make('div', 'hba-status', 'Balance payment under review'));
      const review = make('button', 'btn btn-p btn-sm', 'Review Receipt');
      review.type = 'button';
      review.addEventListener('click', event => {
        openById(paymentId(payment), event.currentTarget).catch(error => {
          notify(error?.message || 'Could not open the balance receipt.', 'err');
        });
      });
      bottom.appendChild(review);
      card.append(top, meta, bottom);
      list.appendChild(card);
    });
  }

  function loadPending(force = false) {
    if (!canDecide()) {
      state.payments = [];
      state.loadedAt = 0;
      return Promise.reject(new Error('Only a Court Owner or System Owner can review host balance payments.'));
    }
    if (state.loading) return state.loading;
    if (!force && state.loadedAt && Date.now() - state.loadedAt < 15000) {
      return Promise.resolve(state.payments);
    }

    state.loading = Promise.resolve().then(async () => {
      try {
        const result = await apiCall('list_pending', { limit: 100 });
        const rows = result?.payments || result?.data?.payments;
        if (!Array.isArray(rows)) throw new Error('Could not load host balance payments. Please refresh and try again.');
        if (!canDecide()) throw new Error('Only a Court Owner or System Owner can review host balance payments.');
        state.payments = rows;
        state.loadedAt = Date.now();
        return state.payments;
      } catch (error) {
        state.loadedAt = 0;
        throw error;
      } finally {
        state.loading = null;
      }
    });
    return state.loading;
  }

  async function render(force = false) {
    ensurePanel();
    const list = byId('hostBalanceAdminList');
    if (list && !state.loadedAt) {
      list.replaceChildren(make('div', 'hba-empty', 'Loading balance payments…'));
    }
    try {
      const payments = await loadPending(force);
      renderCards();
      return payments;
    } catch (error) {
      if (list) list.replaceChildren(make('div', 'hba-empty', error?.message || 'Could not load host balance payments.'));
      return [];
    }
  }

  async function openById(id, trigger) {
    const target = String(id || '').trim();
    if (!target) throw new Error('Balance payment could not be found.');
    let payments = await loadPending();
    let payment = payments.find(row => paymentId(row) === target);
    if (!payment) {
      payments = await loadPending(true);
      payment = payments.find(row => paymentId(row) === target);
    }
    if (!payment) throw new Error('This balance payment is no longer awaiting review. Refresh Bookings to see its latest status.');
    return openModal(payment, trigger);
  }

  function install() {
    addStyles();
    ensurePanel();
    ensureModal();
  }

  global.HostBalanceAdmin = Object.freeze({
    install,
    render,
    loadPending,
    openById,
    open: openModal,
    close: closeModal,
  });

  install();
})(window);
