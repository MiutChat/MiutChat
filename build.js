#!/usr/bin/env node
'use strict';

const fs    = require('fs');
const path  = require('path');
const zlib  = require('zlib');
const crypto= require('crypto');
const { spawnSync } = require('child_process');

const ROOT   = __dirname;
const DIST   = path.join(ROOT, 'dist');
const isProd = process.env.NODE_ENV !== 'development';
const START  = Date.now();
const ESB    = path.join(ROOT, 'node_modules/.bin/esbuild');

const { getVersion } = require('./version.js');
// Single source of truth for the app version — see version.js. build.js only
// READS it here; the automatic bump itself happens in the GitHub Action at
// .github/workflows/bump-version.yml, which commits the new number back to
// the repo on every push. (An earlier version of this file tried bumping
// during the build itself — that didn't persist across separate CI builds,
// see version.js for why.) Every file below that shows/embeds a version
// gets THIS value stamped in, so they can never drift out of sync again.
const VERSION = getVersion();

const C = { reset:'\x1b[0m',bold:'\x1b[1m',green:'\x1b[32m',teal:'\x1b[36m',red:'\x1b[31m',gray:'\x1b[90m',yellow:'\x1b[33m' };
const log = (tag, msg, col) => {
  col = col||C.teal;
  const ts = ((Date.now()-START)/1000).toFixed(2).padStart(5);
  process.stdout.write(C.gray+'['+ts+'s]'+C.reset+' '+col+C.bold+tag.padEnd(10)+C.reset+' '+msg+'\n');
};
const die = msg => { log('ERROR', msg, C.red); process.exit(1); };

if (!fs.existsSync(ESB)) die('esbuild not found — run: npm install');

if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'functions', 'api'), { recursive: true });
log('CLEAN', 'dist/ wiped');
log('VERSION', VERSION + '  (bumped by the GitHub Action on push, not by this build step)');

function run(cmd) {
  const r = spawnSync(cmd, { shell:true, stdio:['ignore','pipe','pipe'] });
  if (r.status !== 0) die('esbuild:\n'+(r.stderr||r.stdout||Buffer.alloc(0)).toString().slice(0,800));
  return (r.stdout||Buffer.alloc(0)).toString();
}

function sha256(data) { return 'sha256-'+crypto.createHash('sha256').update(data).digest('base64'); }

function stripBlockComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\n{3,}/g, '\n')
    .replace(/^\s*\n/gm, '')
    .trimStart();
}

function prepTmp(relPath, transform) {
  let txt = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  if (transform) txt = transform(txt);
  txt = stripBlockComments(txt);
  const tmp = path.join(ROOT, '_tmp_'+path.basename(relPath));
  fs.writeFileSync(tmp, txt, 'utf8');
  return tmp;
}

function fmt(b) { return (b/1024).toFixed(1)+' KB'; }
function pct(o,n) { return C.green+'-'+(((o-n)/o)*100).toFixed(0)+'%'+C.reset; }

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const s=path.join(src,f), d=path.join(dest,f);
    fs.statSync(s).isDirectory() ? copyDir(s,d) : fs.copyFileSync(s,d);
  }
}

function compress(fp) {
  const d = fs.readFileSync(fp);
  fs.writeFileSync(fp+'.gz', zlib.gzipSync(d, { level:9 }));
  fs.writeFileSync(fp+'.br', zlib.brotliCompressSync(d, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 }
  }));
}

const tmps = [];
const sri  = {};

const baseFlags =
  '--bundle=false --minify --minify-whitespace --minify-identifiers --minify-syntax'+
  ' --tree-shaking=true --charset=utf8'+
  (isProd ? ' --drop:console --drop:debugger' : '')+
  (!isProd ? ' --sourcemap=inline' : '');

log('BUILD JS', 'browser bundles');
const JS_JOBS = [
  ['app.js',                 'app.min.js',                 'es2020'],
  ['db-manager.js',          'db-manager.min.js',          'es2020'],
  ['crypto-engine.js',       'crypto-engine.min.js',       'es2020'],
  ['crypto-bridge.js',       'crypto-bridge.min.js',       'es2020'],
  ['placeholder-rotator.js', 'placeholder-rotator.min.js', 'es2017'],
  ['security.js',            'security.min.js',            'es2020'],
];
for (const [inp, out, tgt] of JS_JOBS) {
  if (!fs.existsSync(path.join(ROOT, inp))) { log('  skip', inp+' not found', C.yellow); continue; }
  // app.js declares `const APP_VERSION = '...'` — stamp the unified VERSION
  // in at build time so it's never hand-edited out of sync (see version.js).
  const versionTransform = inp === 'app.js'
    ? t => t.replace(/const APP_VERSION\s*=\s*'[^']*';/, `const APP_VERSION = '${VERSION}';`)
    : undefined;
  const tmp = prepTmp(inp, versionTransform); tmps.push(tmp);
  const orig = fs.statSync(path.join(ROOT,inp)).size;
  run(ESB+' '+tmp+' '+baseFlags+' --target='+tgt+' --platform=browser --outfile='+DIST+'/'+out);
  const min = fs.statSync(DIST+'/'+out).size;
  log('  js', inp+'  '+fmt(orig)+' -> '+fmt(min)+' '+pct(orig,min));
}

log('BUILD SW', 'service worker');
const swFiles = [
  ['sw.js', 'sw.min.js', 'es2020'],
];
for (const [inp, out, tgt] of swFiles) {
  if (!fs.existsSync(path.join(ROOT, inp))) { log('  skip', inp, C.yellow); continue; }
  const tmp = prepTmp(inp, t => t.replace(/const SW_VERSION\s*=\s*'[^']*';/, `const SW_VERSION = '${VERSION}';`));
  tmps.push(tmp);
  const orig = fs.statSync(path.join(ROOT,inp)).size;
  run(ESB+' '+tmp+' '+baseFlags+' --target='+tgt+' --platform=browser --outfile='+DIST+'/'+out);
  const min = fs.statSync(DIST+'/'+out).size;
  log('  sw', inp+'  '+fmt(orig)+' -> '+fmt(min)+' '+pct(orig,min));
}

const brTmp = prepTmp('sw-bridge.js', t =>
  t.replace(/'sw\.js'/g,"'sw.min.js'").replace(/"sw\.js"/g,'"sw.min.js"')
   .replace(/'crypto-engine\.js'/g,"'crypto-engine.min.js'")
);
tmps.push(brTmp);
run(ESB+' '+brTmp+' '+baseFlags+' --target=es2017 --platform=browser --outfile='+DIST+'/sw-bridge.min.js');
log('  sw', 'sw-bridge.js -> sw-bridge.min.js');

if (fs.existsSync(path.join(ROOT, 'crypto-worker.js'))) {
  const cwTmp = prepTmp('crypto-worker.js', t =>
    t.replace(/'crypto-engine\.js'/g,"'crypto-engine.min.js'")
  );
  tmps.push(cwTmp);
  run(ESB+' '+cwTmp+' '+baseFlags+' --target=es2020 --platform=browser --outfile='+DIST+'/crypto-worker.min.js');
  log('  worker', 'crypto-worker.js -> crypto-worker.min.js');
}

log('BUILD CSS', 'style.css');
const cssTmp = prepTmp('style.css'); tmps.push(cssTmp);
const cssO = fs.statSync(path.join(ROOT,'style.css')).size;
run(ESB+' '+cssTmp+' --bundle=false --minify --outfile='+DIST+'/style.min.css');
const cssM = fs.statSync(DIST+'/style.min.css').size;
log('  css', fmt(cssO)+' -> '+fmt(cssM)+' '+pct(cssO,cssM));

log('BUILD CF', 'edge functions');
const CF_JOBS = [
  'functions/api/rate-limit.js',
  'functions/api/csp-report.js',
  'functions/api/health.js',
  'functions/api/canary.js',
  'functions/api/validate-room.js',
];
for (const f of CF_JOBS) {
  if (!fs.existsSync(path.join(ROOT, f))) continue;
  // health.js has a hardcoded fallback version literal for when
  // MIUT_VERSION isn't set as an env var — keep it in sync too.
  const versionTransform = f.endsWith('health.js')
    ? t => t.replace(/env\.MIUT_VERSION\s*\|\|\s*'[^']*'/, `env.MIUT_VERSION || '${VERSION}'`)
    : undefined;
  const tmp = prepTmp(f, versionTransform); tmps.push(tmp);
  run(ESB+' '+tmp+' --bundle=false --minify --platform=neutral --format=esm --target=es2020 --outfile='+DIST+'/'+f);
  log('  cf', f.replace('functions/api/',''));
}

log('HASH', 'SRI sha256');
const SRI_FILES = [
  'app.min.js','db-manager.min.js','sw-bridge.min.js','placeholder-rotator.min.js',
  'style.min.css','crypto-engine.min.js','crypto-bridge.min.js','storage-engine.min.js',
  'crypto-worker.min.js','security.min.js',
];
for (const f of SRI_FILES) {
  const fp = DIST+'/'+f;
  if (fs.existsSync(fp)) sri[f] = sha256(fs.readFileSync(fp));
}
fs.writeFileSync(DIST+'/sri-manifest.json', JSON.stringify({ ts: new Date().toISOString(), hashes: sri }, null, 2));
log('  done', Object.keys(sri).length+' hashes');

log('PATCH', 'index.html');
let html = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
html = html
  .replace(/href="style\.css"/g,             'href="style.min.css"')
  .replace(/src="app\.js"/g,                 'src="app.min.js"')
  .replace(/src="db-manager\.js"/g,          'src="db-manager.min.js"')
  .replace(/src="sw-bridge\.js"/g,           'src="sw-bridge.min.js"')
  .replace(/src="placeholder-rotator\.js"/g, 'src="placeholder-rotator.min.js"')
  .replace(/src="crypto-engine\.js"/g,       'src="crypto-engine.min.js"')
  .replace(/src="crypto-bridge\.js"/g,       'src="crypto-bridge.min.js"')
  .replace(/src="storage-engine\.js"/g,      'src="storage-engine.min.js"')
  .replace(/src="security\.js"/g,            'src="security.min.js"');

if (isProd) {
  for (const [f, h] of Object.entries(sri)) {
    const e = f.replace(/\./g,'\\.').replace(/\//g,'\\/');
    html = html
      .replace(new RegExp('(src="'+e+'")', 'g'), '$1 integrity="'+h+'" crossorigin="anonymous"')
      .replace(new RegExp('(href="'+e+'")', 'g'), '$1 integrity="'+h+'" crossorigin="anonymous"');
  }
}
html = html
  .replace(/<!--[\s\S]*?-->/g,'')
  .replace(/[ \t]{2,}/g,' ')
  .replace(/>\s+</g,'><')
  .trim()+'\n';
// Stamp version into HTML
html = html.replace(/<meta name="application-version"[^>]*\/>/,
  `<meta name="application-version" content="${VERSION}"/>`);
// Stamp any {{APP_VERSION}} placeholders too (e.g. a visible "vX.Y.Z" label)
html = html.replace(/\{\{APP_VERSION\}\}/g, VERSION);
fs.writeFileSync(DIST+'/index.html', html);
log('  stamp', 'version '+VERSION+' applied to index.html');

log('STATIC', 'copy assets');
const STATIC = [
  'manifest.json','offline.html','.nojekyll','firestore.rules',
  '_headers','_redirects','_middleware.js','config.js','privacy.html','landing.html',
  'terms.html','about.html','404.html','maintenance.html',
  'secure-chat-for-journalists.html','ephemeral-chat-for-support-groups.html',
  'robots.txt','ads.txt','sitemap.xml','wrangler.toml','CNAME',
];
// Files that need the unified VERSION text-stamped in rather than a plain
// byte copy. manifest.json/wrangler.toml carry their own version fields;
// the marketing pages get a {{APP_VERSION}} placeholder replaced (same
// convention as index.html above) wherever a "vX.Y.Z" credit is shown.
const VERSIONED_STATIC = new Set([
  'manifest.json', 'wrangler.toml',
  'privacy.html', 'landing.html', 'terms.html', 'about.html',
]);
let nc = 0;
for (const f of STATIC) {
  const s = path.join(ROOT, f);
  if (!fs.existsSync(s)) continue;
  if (VERSIONED_STATIC.has(f)) {
    let txt = fs.readFileSync(s, 'utf8');
    txt = txt.replace(/\{\{APP_VERSION\}\}/g, VERSION);
    if (f === 'manifest.json') {
      txt = txt
        .replace(/"version"\s*:\s*"[^"]*"/, `"version": "${VERSION}"`)
        .replace(/MiutChat v[\d.]+/g, `MiutChat v${VERSION}`);
    } else if (f === 'wrangler.toml') {
      txt = txt.replace(/MIUT_VERSION\s*=\s*"[^"]*"/, `MIUT_VERSION  = "${VERSION}"`);
    }
    fs.writeFileSync(DIST + '/' + f, txt);
  } else {
    fs.copyFileSync(s, DIST + '/' + f);
  }
  nc++;
}
copyDir(path.join(ROOT,'icons'), DIST+'/icons');
// Copy functions/ raw EXCEPT the files CF_JOBS already built above (minified
// + version-stamped for health.js) — a plain copyDir here used to silently
// clobber that work by overwriting it with the untouched source right after,
// which meant every edge function was always shipping unminified and, for
// health.js specifically, with a stale hardcoded version fallback no matter
// what build.js stamped in above.
const CF_JOBS_SET = new Set(CF_JOBS.map(f => path.join(ROOT, f)));
function copyDirExcept(src, dest, exclude) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f), d = path.join(dest, f);
    if (fs.statSync(s).isDirectory()) { copyDirExcept(s, d, exclude); continue; }
    if (exclude.has(s)) continue; // already built by CF_JOBS — don't clobber it
    fs.copyFileSync(s, d);
  }
}
copyDirExcept(path.join(ROOT,'functions'), DIST+'/functions', CF_JOBS_SET);
log('  done', nc+' files + icons/ + functions/');
log('  stamp', 'version '+VERSION+' applied to manifest.json, wrangler.toml, marketing pages');

if (isProd) {
  log('COMPRESS', 'brotli-11 + gzip-9');
  const re = /\.(js|css|html|json|xml|txt|svg|webmanifest)$/;
  let nz = 0;
  function compressDir(dir) {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      if (fs.statSync(fp).isDirectory()) { compressDir(fp); continue; }
      if (re.test(f) && !/\.(gz|br)$/.test(f)) { compress(fp); nz++; }
    }
  }
  compressDir(DIST);
  log('  done', nz+' files compressed');
}

for (const t of tmps) { try { fs.unlinkSync(t); } catch {} }

const elapsed = ((Date.now()-START)/1000).toFixed(2);
console.log('');
log('REPORT', elapsed+'s total', C.green);
console.log('');

const rows = [];
function collectRows(dir, prefix) {
  for (const f of fs.readdirSync(dir).sort()) {
    const fp = path.join(dir, f);
    const rel = prefix ? prefix+'/'+f : f;
    if (fs.statSync(fp).isDirectory()) { collectRows(fp, rel); continue; }
    if (/\.(gz|br)$/.test(f)) continue;
    const size = fs.statSync(fp).size;
    const brp = fp+'.br';
    const br = fs.existsSync(brp) ? fs.statSync(brp).size : null;
    rows.push({ f: rel, size, br });
  }
}
collectRows(DIST, '');
const w = Math.max(...rows.map(r=>r.f.length)) + 2;
const totalDist = rows.reduce((s,r)=>s+r.size,0);
for (const r of rows) {
  const brStr  = r.br ? '  '+C.green+'br:'+fmt(r.br)+C.reset : '';
  const sriStr = sri[r.f] ? '  '+C.gray+'[sri]'+C.reset : '';
  console.log('  '+C.teal+r.f.padEnd(w)+C.reset+fmt(r.size).padStart(9)+brStr+sriStr);
}
console.log('');
log('TOTAL', fmt(totalDist)+' uncompressed dist', C.green);
log('DONE', C.green+C.bold+'Build successful'+C.reset, C.green);
