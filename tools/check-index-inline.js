'use strict';

const fs = require('node:fs');
const vm = require('node:vm');

for (const file of ['index.html', 'admin.html']) {
  const html = fs.readFileSync(file, 'utf8');
  const scriptPattern = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  let parsed = 0;
  while ((match = scriptPattern.exec(html))) {
    const attributes = match[1] || '';
    if (/\bsrc\s*=/.test(attributes)) continue;
    if (/type\s*=\s*["'](?:application\/ld\+json|application\/json)["']/i.test(attributes)) continue;
    parsed += 1;
    new vm.Script(match[2], { filename: `${file}-inline-${parsed}.js` });
  }
  if (!parsed) throw new Error(`No executable inline scripts found in ${file}.`);
  console.log(`Parsed ${parsed} inline ${file} script${parsed === 1 ? '' : 's'}.`);
}
