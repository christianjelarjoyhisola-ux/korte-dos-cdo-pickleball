const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'supabase-config.js'), 'utf8');
const match = source.match(
  /const PB_PRIVATE_DATA_SURFACE = (\/\^[^\r\n]+?\/[a-z]*)\.test\(location\.pathname\);/
);

assert.ok(match, 'private-data surface route matcher must remain discoverable');
const privateDataRoute = vm.runInNewContext(match[1]);

test('private data surfaces accept Cloudflare extensionless and HTML routes', () => {
  for (const pathname of ['/admin', '/admin/', '/admin.html', '/signature-view', '/signature-view.html']) {
    assert.equal(privateDataRoute.test(pathname), true, pathname);
  }
});

test('private data surfaces reject public and lookalike routes', () => {
  for (const pathname of ['/', '/index.html', '/host', '/admin-malicious', '/public/admin', '/admin.html/extra']) {
    assert.equal(privateDataRoute.test(pathname), false, pathname);
  }
});
