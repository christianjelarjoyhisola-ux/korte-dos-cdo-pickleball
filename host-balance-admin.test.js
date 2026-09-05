const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync('host-balance-admin.js', 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const payment = id => ({
  paymentId: id,
  customerName: 'Test Host',
  bookingGroupRef: `GROUP-${id}`,
  balanceAmount: 2362.50,
  paymentProvider: 'gcash',
  paymentReference: 'TEST-REFERENCE',
  submittedAt: '2026-09-05T13:12:00Z',
});

function harness(options = {}) {
  let document;
  class Element {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.parentNode = null;
      this.style = {};
      this.attributes = {};
      this.listeners = {};
      this.value = '';
      this.hidden = false;
      this.disabled = false;
      this._text = '';
    }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    insertBefore(child, before) {
      child.parentNode = this;
      this.children.splice(this.children.indexOf(before), 0, child);
    }
    replaceChildren(...children) {
      this.children.forEach(child => { child.parentNode = null; });
      this.children = [];
      this._text = '';
      this.append(...children);
    }
    replaceWith(replacement) {
      const parent = this.parentNode;
      parent.children[parent.children.indexOf(this)] = replacement;
      replacement.parentNode = parent;
      this.parentNode = null;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    set src(value) { this.setAttribute('src', value); }
    get src() { return this.getAttribute('src') || ''; }
    get isConnected() {
      return this === document.head || this === document.body || Boolean(this.parentNode?.isConnected);
    }
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
    fire(name, detail = {}) {
      return Promise.all((this.listeners[name] || []).map(callback => callback({ target: this, currentTarget: this, ...detail })));
    }
    focus() { document.activeElement = this; }
    querySelector(selector) {
      return find(this, child => selector.startsWith('.') && String(child.className || '').split(' ').includes(selector.slice(1)));
    }
  }
  function find(root, predicate) {
    for (const child of root.children) {
      if (predicate(child)) return child;
      const result = find(child, predicate);
      if (result) return result;
    }
    return null;
  }
  document = {
    head: new Element('head'),
    body: new Element('body'),
    activeElement: null,
    createElement: tag => new Element(tag),
    createTextNode: text => { const node = new Element('#text'); node.textContent = text; return node; },
    getElementById: id => find(document.head, child => child.id === id) || find(document.body, child => child.id === id),
    addEventListener() {},
  };
  const section = document.createElement('section');
  section.id = 'sec-payreview';
  document.body.appendChild(section);
  const calls = { list: [], receipt: [], review: [], toast: [], bookings: 0, paymentReview: 0, confirm: 0 };
  let currentRole = options.role || 'owner';
  const api = {
    listPending(payload) { calls.list.push(payload); return options.list ? options.list(payload) : Promise.resolve({ payments: [payment('one')] }); },
    receiptUrl(id) { calls.receipt.push(id); return options.receipt ? options.receipt(id) : Promise.resolve({ url: `https://receipts.example/${id}.png` }); },
    review(...args) { calls.review.push(args); return options.review ? options.review(...args) : Promise.resolve({ ok: true }); },
  };
  const originalPaymentReview = async () => { calls.paymentReview += 1; };
  const window = {
    Auth: { getSession: () => ({ role: currentRole }) },
    HostBalancePaymentApi: api,
    toast: (...args) => calls.toast.push(args),
    confirm: () => { calls.confirm += 1; return options.confirm !== false; },
    renderBookings: async () => { calls.bookings += 1; },
    renderPaymentReview: originalPaymentReview,
  };
  vm.runInNewContext(source, { window, document, URL, Date, console });
  return {
    admin: window.HostBalanceAdmin,
    window,
    document,
    calls,
    originalPaymentReview,
    byId: id => document.getElementById(id),
    setRole: value => { currentRole = value; },
  };
}

test('pending data shares in-flight reads, caches briefly, and force refreshes the supported list contract', async () => {
  const pending = deferred();
  const h = harness({ list: () => pending.promise });
  const first = h.admin.loadPending();
  const concurrent = h.admin.loadPending(true);
  assert.equal(first, concurrent);
  pending.resolve({ payments: [payment('one')] });
  assert.equal((await first)[0].paymentId, 'one');
  await h.admin.loadPending();
  assert.equal(h.calls.list.length, 1);
  assert.equal(h.calls.list[0].limit, 100);
  await h.admin.loadPending(true);
  assert.equal(h.calls.list.length, 2);
  assert.equal(h.window.renderPaymentReview, h.originalPaymentReview, 'installation must not wrap a captured section loader');
});

test('data errors reject for booking consumers, remain visible in the panel, and allow retries', async () => {
  let unavailable = true;
  const h = harness({ list: () => {
    if (unavailable) throw new Error('Balance service unavailable');
    return { payments: [] };
  } });
  await assert.rejects(h.admin.loadPending(), /Balance service unavailable/);
  await h.admin.render();
  assert.match(h.byId('hostBalanceAdminList').textContent, /Balance service unavailable/);
  unavailable = false;
  await h.admin.render(true);
  assert.match(h.byId('hostBalanceAdminList').textContent, /No host balance receipts/);
  assert.equal(h.calls.list.length, 3);
  const malformed = harness({ list: async () => ({ ok: true }) });
  await assert.rejects(malformed.admin.loadPending(), /Could not load host balance payments/);
});

test('owner authorization applies to reads, opening receipts, and decisions', async () => {
  const h = harness({ role: 'staff' });
  await assert.rejects(h.admin.loadPending(), /Only a Court Owner or System Owner/);
  await assert.rejects(h.admin.openById('one'), /Only a Court Owner or System Owner/);
  assert.equal(h.calls.list.length, 0);
  h.setRole('court_owner');
  await h.admin.openById('one');
  await h.byId('hostBalanceProofImage').fire('load');
  h.setRole('staff');
  await h.byId('hostBalanceApproveBtn').fire('click');
  assert.equal(h.calls.review.length, 0);
});

test('opening by payment ID displays the proof before enabling approval and restores focus on close', async () => {
  const h = harness();
  const trigger = h.document.createElement('button');
  h.document.body.appendChild(trigger);
  h.document.body.style.overflow = 'auto';
  await h.admin.openById('one', trigger);
  assert.match(h.byId('hostBalanceReviewSummary').textContent, /Test Host/);
  assert.equal(h.byId('hostBalanceApproveBtn').disabled, true);
  await h.byId('hostBalanceApproveBtn').fire('click');
  assert.equal(h.calls.review.length, 0);
  const image = h.byId('hostBalanceProofImage');
  assert.equal(image.src, 'https://receipts.example/one.png');
  await image.fire('load');
  assert.equal(image.style.display, 'block', 'inline display must override the hidden image CSS');
  assert.equal(h.byId('hostBalanceApproveBtn').disabled, false);
  h.admin.close();
  assert.equal(h.document.activeElement, trigger);
  assert.equal(h.document.body.style.overflow, 'auto');
  assert.equal(h.byId('hostBalanceApproveBtn').disabled, true);
});

test('missing payment IDs refresh once and fail without opening an unrelated receipt', async () => {
  const h = harness();
  await assert.rejects(h.admin.openById('missing'), /no longer awaiting review/);
  assert.equal(h.calls.list.length, 2);
  assert.equal(h.calls.receipt.length, 0);
  assert.equal(h.byId('hostBalanceReviewModal').hidden, true);
});

test('insecure receipt URLs and failed images keep approval disabled', async () => {
  const insecure = harness({ receipt: async () => ({ url: 'http://receipts.example/proof.png' }) });
  await insecure.admin.openById('one');
  assert.equal(insecure.byId('hostBalanceProofImage').src, '');
  assert.match(insecure.byId('hostBalanceProofStatus').textContent, /not secure/);
  assert.equal(insecure.byId('hostBalanceApproveBtn').disabled, true);
  const h = harness();
  await h.admin.openById('one');
  await h.byId('hostBalanceProofImage').fire('error');
  assert.equal(h.byId('hostBalanceApproveBtn').disabled, true);
  assert.match(h.byId('hostBalanceProofStatus').textContent, /could not be loaded/);
});

test('late receipt requests and image events cannot approve a different or closed payment', async () => {
  const firstReceipt = deferred();
  const secondReceipt = deferred();
  const h = harness({
    list: async () => ({ payments: [payment('one'), payment('two')] }),
    receipt: id => id === 'one' ? firstReceipt.promise : secondReceipt.promise,
  });
  const firstOpen = h.admin.openById('one');
  await tick();
  const firstImage = h.byId('hostBalanceProofImage');
  const secondOpen = h.admin.openById('two');
  await tick();
  const secondImage = h.byId('hostBalanceProofImage');
  assert.notEqual(firstImage, secondImage);
  secondReceipt.resolve({ url: 'https://receipts.example/two.png' });
  await secondOpen;
  firstImage.src = 'https://receipts.example/one.png';
  await firstImage.fire('load');
  assert.equal(h.byId('hostBalanceApproveBtn').disabled, true);
  await secondImage.fire('load');
  assert.equal(h.byId('hostBalanceApproveBtn').disabled, false);
  firstReceipt.resolve({ url: 'https://receipts.example/one.png' });
  await firstOpen;
  assert.equal(secondImage.src, 'https://receipts.example/two.png');
  h.admin.close();
  await secondImage.fire('load');
  assert.equal(h.byId('hostBalanceApproveBtn').disabled, true);
});

test('approval submits once while busy and refreshes booking totals plus payment review after success', async () => {
  const decision = deferred();
  const h = harness({ review: () => decision.promise });
  await h.admin.openById('one');
  await h.byId('hostBalanceProofImage').fire('load');
  const approve = h.byId('hostBalanceApproveBtn');
  const saving = approve.fire('click');
  await approve.fire('click');
  h.byId('hostBalanceReviewReason').value = 'Reason while saving';
  await h.byId('hostBalanceReviewReason').fire('input');
  assert.equal(approve.disabled, true);
  assert.equal(h.byId('hostBalanceRejectBtn').disabled, true);
  h.admin.close();
  assert.equal(h.byId('hostBalanceReviewModal').hidden, false, 'keep the review stable until its write finishes');
  assert.equal(h.calls.review.length, 1);
  assert.deepEqual(h.calls.review[0], ['one', 'approve', '']);
  assert.equal(h.calls.confirm, 1);
  decision.resolve({ ok: true });
  await saving;
  assert.equal(h.byId('hostBalanceReviewModal').hidden, true);
  assert.equal(h.calls.bookings, 1);
  assert.equal(h.calls.paymentReview, 1);
  assert.equal(h.calls.list.length, 2);
});

test('a failed save leaves the receipt available for retry and rejection requires a reason', async () => {
  let fail = true;
  const h = harness({ review: async () => {
    if (fail) throw new Error('Review could not be saved');
    return { ok: true };
  } });
  await h.admin.openById('one');
  await h.byId('hostBalanceProofImage').fire('load');
  await h.byId('hostBalanceRejectBtn').fire('click');
  assert.equal(h.calls.review.length, 0);
  h.byId('hostBalanceReviewReason').value = ' Wrong amount ';
  await h.byId('hostBalanceReviewReason').fire('input');
  assert.equal(h.byId('hostBalanceRejectBtn').disabled, false);
  await h.byId('hostBalanceRejectBtn').fire('click');
  assert.equal(h.byId('hostBalanceReviewModal').hidden, false);
  assert.equal(h.byId('hostBalanceRejectBtn').disabled, false);
  assert.equal(h.calls.bookings, 0);
  assert.match(h.calls.toast.at(-1)[0], /could not be saved/);
  fail = false;
  await h.byId('hostBalanceRejectBtn').fire('click');
  assert.deepEqual(h.calls.review.at(-1), ['one', 'reject', 'Wrong amount']);
  assert.equal(h.calls.bookings, 1);
});
