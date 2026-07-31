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

test('admin payments loads and renders the Telegram recipient panel', () => {
  const adminHtml = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
  assert.match(
    adminHtml,
    /<script src="telegram-admin\.js\?v=20260731-owner-link-v1"><\/script>/,
  );
  assert.match(adminHtml, /await window\.TelegramAdmin\?\.render\(\);/);
});
