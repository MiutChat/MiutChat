const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'config', 'moderation');
const curated = JSON.parse(fs.readFileSync(path.join(dir, 'curated.json'), 'utf8'));
const lists = {};

for (const f of fs.readdirSync(path.join(dir, 'lists')).sort()) {
  if (!f.endsWith('.txt')) continue;
  const lang = f.slice(0, -4);
  const terms = fs.readFileSync(path.join(dir, 'lists', f), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  lists[lang] = terms;
}

for (const [lang, terms] of Object.entries(curated.langs || {})) {
  lists[lang] = [...new Set([...(lists[lang] || []), ...terms])];
}

const out =
  'export const LISTS = ' + JSON.stringify(lists) + ';\n' +
  'export const BLOCK = ' + JSON.stringify(curated.block || {}) + ';\n' +
  'export const EXEMPT = ' + JSON.stringify(curated.exempt || []) + ';\n';

fs.writeFileSync(path.join(root, 'src', 'app', 'lazy', 'moderation-data.js'), out);
console.log('moderation-data.js:', Object.keys(lists).length, 'languages,', Object.values(lists).reduce((n, a) => n + a.length, 0), 'terms');
