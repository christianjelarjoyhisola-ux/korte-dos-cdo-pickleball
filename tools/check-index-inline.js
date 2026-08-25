'use strict';

const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');
const scriptPattern = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
let match;
let parsed = 0;

while ((match = scriptPattern.exec(html))) {
  const attributes = match[1] || '';
  if (/\bsrc\s*=/.test(attributes)) continue;
  if (/type\s*=\s*["'](?:application\/ld\+json|application\/json)["']/i.test(attributes)) {
    continue;
  }
  parsed += 1;
  new vm.Script(match[2], { filename: `index-inline-${parsed}.js` });
}

if (!parsed) throw new Error('No executable inline scripts found in index.html.');
console.log(`Parsed ${parsed} inline index.html script${parsed === 1 ? '' : 's'}.`);
