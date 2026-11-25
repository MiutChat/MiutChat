const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const esbuild = require('esbuild');

let engine;
test.before(async () => {
  const lazy = path.join(__dirname, '..', 'src', 'app', 'lazy');
  const out = esbuild.buildSync({
    stdin: {
      contents: "import { configure, analyze, analyzeFile } from './moderation-engine.js'; import { LISTS, BLOCK, EXEMPT } from './moderation-data.js'; const data = { LISTS, BLOCK, EXEMPT }; configure({ ...data, PROFANITY: 'mask' }); export { analyze, analyzeFile, configure, data };",
      resolveDir: lazy, loader: 'js'
    },
    bundle: true, format: 'esm', write: false, target: 'es2020', platform: 'node'
  });
  const file = path.join(os.tmpdir(), 'miut-mod-' + process.pid + '.mjs');
  fs.writeFileSync(file, out.outputFiles[0].text);
  engine = await import('file://' + file);
});

const L = new Set(['en', 'hi', 'bn']);
const run = t => engine.analyze(t, L);

test('clean messages pass untouched', () => {
  for (const t of ['hello how are you', 'Scunthorpe is a town', 'class assignment due tomorrow', 'I passed the assessment', 'see you at 5xx', 'xx', 'happy swastika festival', 'my kutta is cute', 'sex education class', 'cocktail party', 'Hello! 😊', 'The kids are playing at the park', 'a b c d e', 'send the c v please']) {
    const r = run(t);
    assert.strictEqual(r.action, 'allow', t + ' -> ' + r.action + ' ' + r.category);
    assert.strictEqual(r.text, t);
  }
});

test('basic bad words are starred out by default', () => {
  const cases = [['you are a bitch lol', 'you are a ***** lol'], ['oh shit that is crazy', 'oh **** that is crazy'], ['what the fuck', 'what the ****']];
  for (const [input, expected] of cases) {
    const r = engine.analyze(input, L);
    assert.strictEqual(r.action, 'mask', input);
    assert.strictEqual(r.text, expected);
  }
  assert.strictEqual(engine.analyze('you are a faggot', L).action, 'block');
  assert.strictEqual(engine.analyze('i will kill you', L).action, 'block');
});

test('profanity off option leaves text untouched', () => {
  engine.configure({ ...engine.data, PROFANITY: 'off' });
  const r = engine.analyze('you are a bitch lol', L);
  assert.strictEqual(r.action, 'allow');
  assert.strictEqual(r.text, 'you are a bitch lol');
  engine.configure({ ...engine.data, PROFANITY: 'mask' });
});

test('profanity is masked, not blocked', () => {
  const r = run('you are a bitch');
  assert.strictEqual(r.action, 'mask');
  assert.ok(!/bitch/.test(r.text));
  assert.ok(r.text.startsWith('you are a '));
});

test('evasion variants are caught', () => {
  for (const t of ['b!tch', 'bitchhhh', 'b i t c h', 'b.i.t.c.h', 'B1TCH', 'bítch', 'bitсh', 'b*tch', 'ＢＩＴＣＨ', 'bi\u200btch', 'fagg0t', 'n1gger', 'f a g g o t']) {
    assert.notStrictEqual(run('x ' + t + ' y').action, 'allow', t);
  }
});

test('masking preserves surrounding text and positions', () => {
  const r = run('well, f u c k that!');
  assert.strictEqual(r.action, 'mask');
  assert.ok(r.text.startsWith('well, '));
  assert.ok(r.text.endsWith(' that!'));
});

test('hate slurs block', () => {
  assert.strictEqual(run('you are a faggot').action, 'block');
  assert.strictEqual(run('you are a faggot').category, 'hate');
});

test('threats and self-harm incitement block', () => {
  for (const t of ['i will kill you', 'I am going to shoot them', 'go kill yourself', 'mar dunga tujhe', 'jaan se maar dunga']) {
    const r = run(t);
    assert.strictEqual(r.action, 'block', t);
    assert.strictEqual(r.category, 'threat', t);
  }
  assert.strictEqual(run('this game will kill my battery').action, 'allow');
  for (const t of ['kys lol', 'hope you die haha', 'omg i am dead', 'you deserve better']) assert.strictEqual(run(t).action, 'allow', t);
});

test('sexualised-minor content blocks', () => {
  for (const t of ['underage porn', 'loli nudes', 'send 14yo nudes', 'child porn', 'teen xxx']) {
    const r = run(t);
    assert.strictEqual(r.action, 'block', t);
    assert.strictEqual(r.category, 'csam', t);
  }
  assert.strictEqual(run('the kids are at school').action, 'allow');
});

test('illegal trade blocks', () => {
  for (const t of ['selling cocaine dm me', 'glock pistols available', 'buy fake passports', 'ak47 for sale']) {
    assert.strictEqual(run(t).action, 'block', t);
    assert.strictEqual(run(t).category, 'illegal-trade', t);
  }
  assert.strictEqual(run('I want to buy a ticket').action, 'allow');
});

test('multilingual: hindi, bengali, cyrillic, arabic, cjk', () => {
  assert.notStrictEqual(run('tu bada chutiya hai').action, 'allow');
  assert.notStrictEqual(run('তুই একটা হারামজাদা').action, 'allow');
  assert.notStrictEqual(run('tui ekta haramjada').action, 'allow');
  assert.notStrictEqual(run('तू चूतिया है').action, 'allow');
  const ru = fs.readFileSync(path.join(__dirname, '..', 'config', 'moderation', 'lists', 'ru.txt'), 'utf8').split('\n').filter(w => /^[\u0400-\u04ff]+$/.test(w))[0];
  assert.notStrictEqual(run('привет ' + ru + ' пока').action, 'allow');
  const zh = fs.readFileSync(path.join(__dirname, '..', 'config', 'moderation', 'lists', 'zh.txt'), 'utf8').split('\n').filter(Boolean)[5];
  assert.notStrictEqual(run('你好' + zh + '再见').action, 'allow');
  const ar = fs.readFileSync(path.join(__dirname, '..', 'config', 'moderation', 'lists', 'ar.txt'), 'utf8').split('\n').filter(w => w && !/\s/.test(w))[0];
  assert.notStrictEqual(run('مرحبا ' + ar + ' شكرا').action, 'allow');
});

test('latin-script languages only apply for the user locales', () => {
  const read = f => fs.readFileSync(path.join(__dirname, '..', 'config', 'moderation', 'lists', f + '.txt'), 'utf8').split('\n');
  const en = new Set(read('en'));
  const de = read('de').find(w => /^[a-z]{6,}$/.test(w) && !en.has(w));
  assert.strictEqual(engine.analyze('hallo ' + de + ' tschuss', new Set(['en'])).action, 'allow');
  assert.notStrictEqual(engine.analyze('hallo ' + de + ' tschuss', new Set(['en', 'de'])).action, 'allow');
});

test('file screening', () => {
  assert.strictEqual(engine.analyzeFile('setup.exe', null).action, 'block');
  assert.strictEqual(engine.analyzeFile('photo.jpg.apk', null).action, 'block');
  assert.strictEqual(engine.analyzeFile('holiday.jpg', Uint8Array.from([0x4d, 0x5a, 0, 0])).action, 'block');
  assert.strictEqual(engine.analyzeFile('doc\u202egpj.exe', null).category, 'spoofed-filename');
  assert.strictEqual(engine.analyzeFile('notes.pdf', Uint8Array.from([0x25, 0x50, 0x44, 0x46])).action, 'allow');
  assert.strictEqual(engine.analyzeFile('photo.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47])).action, 'allow');
});

test('performance: 1000 messages under 1.5s after warmup', () => {
  run('warm up');
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) run('hey this is a normal message number ' + i + ' about lunch plans and the weekend');
  assert.ok(Date.now() - t0 < 1500, 'took ' + (Date.now() - t0));
});

test('there is no manual report option and flagging is automatic and content-free', () => {
  const root = path.join(__dirname, '..');
  const app = fs.readFileSync(path.join(root, 'src', 'app', 'app.js'), 'utf8');
  assert.ok(!fs.existsSync(path.join(root, 'src', 'app', 'lazy', 'report.js')));
  assert.ok(!app.includes('msa-report') && !app.includes('_reportSelected') && !app.includes('lazy/report.js'));
  assert.ok(app.includes('_autoFlag(docId, r.category, senderId)'));
  const flagFn = fs.readFileSync(path.join(root, 'functions', 'api', 'flag.js'), 'utf8');
  assert.ok(!/excerpt|note/.test(flagFn));
  const fnCats = flagFn.match(/CATEGORIES = \[([^\]]+)\]/)[1].split(',').map(s => s.trim().replace(/'/g, '')).sort();
  const mapped = [...app.matchAll(/_FLAG_CATEGORY = \{([^}]+)\}/g)][0][1].match(/'?[a-z-]+'?: '([a-z-]+)'/g).map(x => x.split(": ")[1].replace(/'/g, '')).sort();
  assert.deepStrictEqual([...new Set(mapped)].sort(), fnCats);
  const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
  assert.ok(html.includes('hidden automatically') && html.includes('tell us here'));
  const terms = fs.readFileSync(path.join(root, 'src', 'pages', 'terms.html'), 'utf8');
  assert.ok(terms.includes('id="safety"') && terms.includes('There is no manual reporting option'));
});
