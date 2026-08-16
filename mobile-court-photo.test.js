const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const indexSource = readFileSync('index.html', 'utf8');
const adminSource = readFileSync('admin.html', 'utf8');

test('mobile court cards expose a full-width 16:9 photo hero', () => {
  assert.match(
    indexSource,
    /@media\(max-width:700px\)\{[\s\S]*?\.cc-photo\s*\{[\s\S]*?display:block; width:100%;[\s\S]*?aspect-ratio:16 \/ 9;/,
  );
  assert.doesNotMatch(
    indexSource,
    /@media\(max-width:700px\)\{[\s\S]{0,500}?\.cc-photo\s*\{\s*display:none;/,
  );
  assert.match(
    indexSource,
    /@media\(max-width:700px\) \{\s*\.cc-mobile-hd\s*\{\s*display:none;/,
  );
});

test('court photos load efficiently and retain an accessible fallback', () => {
  assert.match(indexSource, /class="cc-photo-fallback" aria-hidden="true"/);
  assert.match(indexSource, /alt="\$\{esc\(`Photo of \$\{c\.name\}`\)\}"/);
  assert.match(indexSource, /loading="eager" fetchpriority="high"/);
  assert.match(indexSource, /loading="lazy"/);
  assert.match(indexSource, /decoding="async"/);
  assert.match(indexSource, /onerror="this\.hidden=true;this\.closest\('\.cc-photo'\)\.classList\.add\('photo-error'\)"/);
  assert.match(indexSource, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.cc-photo-img \{ transition:none; \}/);
});

test('court owner photo field explains the recommended mobile crop', () => {
  assert.match(adminSource, /Landscape 16:9 recommended/);
  assert.match(adminSource, /1600 &times; 900 px works best on mobile/);
});
