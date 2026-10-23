'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _test } = require('./telegram-admin.js');

test('escapes all HTML-sensitive characters from server values', () => {
  assert.equal(
    _test.escapeHtml(`<img src=x onerror="alert('x')">&`),
    '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;',
  );
});

test('never returns a full Telegram chat ID', () => {
  const fullChatId = '-1001234567890';
  const masked = _test.maskChatId(fullChatId);
  assert.match(masked, /^••••/);
  assert.notEqual(masked, fullChatId);
  assert.equal(masked.includes(fullChatId), false);
  assert.equal(_test.maskChatId('12'), '••••2');
});

test('accepts only HTTPS Telegram deep links and safely builds a fallback', () => {
  assert.equal(_test.safeStartLink('javascript:alert(1)', 'KorteAlertsBot', 'ABC'), 'https://t.me/KorteAlertsBot?start=ABC');
  assert.equal(_test.safeStartLink('https://evil.example/start', '', 'ABC'), '');
  assert.equal(
    _test.safeStartLink('https://t.me/KorteAlertsBot?start=ABC&token=never-copy-this', '', 'ABC'),
    'https://t.me/KorteAlertsBot?start=ABC',
  );
  assert.equal(_test.safeStartLink('https://t.me/KorteAlertsBot?start=WRONG', '', 'ABC'), '');
});

test('formats dates in Philippine time and defines an exact seven-day lifetime', () => {
  assert.equal(_test.WEEK_MS, 604800000);
  const formatted = _test.formatPhilippineTime('2026-07-31T23:30:00.000Z');
  assert.match(formatted, /Aug 1, 2026/);
  assert.match(formatted, /7:30 AM/);
  assert.match(formatted, /PHT$/);
});

test('admin payments no longer loads or queries the Telegram recipient panel', () => {
  const adminHtml = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
  assert.doesNotMatch(adminHtml, /<script src="telegram-admin\.js/);
  assert.doesNotMatch(adminHtml, /window\.TelegramAdmin\?\.render\(\)/);
});

test('browser notification helpers skip before invoking the Telegram Edge Function', () => {
  const client = fs.readFileSync(path.join(__dirname, 'supabase-config.js'), 'utf8');
  assert.match(client, /const PB_TELEGRAM_BOOKING_NOTIFICATIONS_ENABLED = false;/);
  const methodStart = client.indexOf('async sendTelegramNotification(payload, options = {})');
  const disabledGuard = client.indexOf('if (!PB_TELEGRAM_BOOKING_NOTIFICATIONS_ENABLED)', methodStart);
  const edgeInvocation = client.indexOf("_invokeEdgeFunction('send-telegram-notification'", methodStart);
  assert.ok(methodStart >= 0);
  assert.ok(disabledGuard > methodStart);
  assert.ok(edgeInvocation > disabledGuard);
});

test('receipt verification keeps email review but skips the Telegram dispatcher', () => {
  const verifier = fs.readFileSync(
    path.join(__dirname, 'supabase/functions/verify-gcash-receipt/index.ts'),
    'utf8',
  );
  assert.match(verifier, /const TELEGRAM_BOOKING_NOTIFICATIONS_ENABLED = false;/);
  assert.match(verifier, /deliverPaymentReviewNotification/);
  assert.match(
    verifier,
    /async function dispatchTelegramPaymentReview\(bookingRef: string\) \{\s+if \(!TELEGRAM_BOOKING_NOTIFICATIONS_ENABLED\) return;/,
  );
});

test('cached clients are stopped before booking lookup or Telegram delivery', () => {
  const edge = fs.readFileSync(
    path.join(__dirname, 'supabase/functions/send-telegram-notification/index.ts'),
    'utf8',
  );
  const disabledResponse = edge.indexOf('reason: "Telegram booking notifications are disabled"');
  const referenceLookup = edge.indexOf('const reference = bookingReference(body.bookingRef)');
  const bookingLookup = edge.indexOf('rows = await loadBookingGroup');
  assert.ok(disabledResponse >= 0);
  assert.ok(referenceLookup > disabledResponse);
  assert.ok(bookingLookup > referenceLookup);
});
