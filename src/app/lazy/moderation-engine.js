let LISTS = {};
let BLOCK = {};
let EXEMPT = [];
let PROFANITY = 'mask';

const FORMAT = /\p{Cf}/u;
const WORD = /[\p{L}\p{N}\p{M}@$!|+*#%]+/gu;
const EDGE_SYMS = /^[@$!|+*#%]+|[@$!|+*#%]+$/g;
const LEET_RE = /[013457$@!|+]/g;
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '$': 's', '@': 'a', '!': 'i', '|': 'i', '+': 't' };
const WILDCARD = /[*#%]/;
const NOSPACE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Hangul}]/u;
const LATINISH = /^[\u0000-\u024f]+$/;
const PURE_LATIN = /^[a-z]+$/;
const LATIN_TOKEN = /^[\p{Script=Latin}\p{N}\p{M}@$!|+*#%]+$/u;
const HAS_LATIN = /\p{Script=Latin}/u;
const SINGLE = /^[\p{L}\p{N}]$/u;
const SPACER = /^[\s.\-_*\u2022\u00b7]{1,3}$/u;
const CONFUSABLES = {
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0445': 'x', '\u0443': 'y',
  '\u0456': 'i', '\u0458': 'j', '\u0455': 's', '\u04bb': 'h', '\u0501': 'd', '\u03bf': 'o', '\u03b1': 'a',
  '\u03b9': 'i', '\u03c1': 'p', '\u03bd': 'v', '\u0261': 'g'
};
const CONF_RE = new RegExp('[' + Object.keys(CONFUSABLES).join('') + ']', 'g');
const W = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';
const rule = s => new RegExp(W + '(?:' + s + ')' + E, 'u');

const THREATS = [
  rule('(?:i|we)\\s+(?:will|ll|am going to|m going to|gonna|wanna|want to|shall)\\s+(?:kill|murder|shoot|stab|rape|bomb|burn|behead|slit)\\s+(?:you|u|ur|your|him|her|them|everyone|all)'),
  rule('(?:kill|murder|shoot|stab|hang)\\s+(?:yourself|urself|yourselves)'),
  rule('(?:mar|maar)\\s+(?:dunga|dungi|denge|dalunga|dalenge|dalna)'),
  rule('jaan\\s+se\\s+(?:mar|maar)'),
  rule('\u09ae\u09c7\u09b0\u09c7\\s+\u09ab\u09c7\u09b2\u09ac')
];

const set = (...xs) => new Set(xs);
const STRONG_MINOR = set('loli', 'lolita', 'shota', 'preteen', 'pre teen', 'underage', 'under age', 'jailbait', 'jail bait');
const WEAK_MINOR = set('child', 'children', 'kid', 'kids', 'minor', 'minors', 'toddler', 'toddlers', 'infant', 'teen', 'teens', 'teenager', 'schoolgirl', 'schoolgirls', 'schoolboy', 'schoolboys', 'school girl', 'school boy', 'little girl', 'little girls', 'little boy', 'little boys');
const STRONG_SEX = set('porn', 'porno', 'pornography', 'nude', 'nudes', 'naked', 'xxx', 'molest', 'molested', 'molesting', 'erotic', 'fuck', 'fucking', 'masturbate', 'sexting', 'sex video', 'sex videos', 'sex pic', 'sex pics');
const ANY_SEX = new Set([...STRONG_SEX, 'sex', 'sexual', 'sexy', 'rape', 'raped', 'raping', 'horny', 'cum']);
const AGE = /^(?:[5-9]|1[0-7])(?:yo|yr|yrs|yrold|yearold|yearsold|y)$/;
const TRADE_VERBS = set('sell', 'selling', 'sale', 'for sale', 'buy', 'buying', 'supply', 'supplying', 'deliver', 'delivery', 'available', 'plug', 'wholesale', 'shipping', 'ship', 'dm me', 'hit me up');
const TRADE_ITEMS = set('heroin', 'cocaine', 'meth', 'methamphetamine', 'mdma', 'lsd', 'fentanyl', 'ketamine', 'opium', 'ak47', 'ak 47', 'glock', 'firearm', 'firearms', 'pistol', 'pistols', 'handgun', 'handguns', 'ammo', 'ammunition', 'grenade', 'grenades', 'explosive', 'explosives', 'hitman', 'ransomware', 'botnet', 'cvv', 'carding', 'fake passport', 'fake passports', 'fake id', 'fake ids', 'fake aadhaar', 'fake aadhar', 'forged documents', 'stolen cards');

const norm1 = s => s.normalize('NFKC').toLowerCase().trim();
const collapse = s => s.replace(/(\p{L})\1+/gu, '$1');
const leet = s => (/\p{L}/u.test(s) ? s.replace(LEET_RE, c => LEET[c]) : s);
const deaccent = s => (LATIN_TOKEN.test(s) ? s.normalize('NFD').replace(/\p{M}/gu, '') : s);

function normalize(text) {
  let norm = '';
  const map = [];
  let i = 0;
  for (const ch of text) {
    const start = i;
    i += ch.length;
    for (const c of ch.normalize('NFKC').toLowerCase()) {
      if (FORMAT.test(c)) continue;
      norm += c;
      for (let k = 0; k < c.length; k++) map.push([start, i]);
    }
  }
  return { norm, map };
}

const indexCache = new Map();

export function configure(data) {
  LISTS = data.LISTS || {};
  BLOCK = data.BLOCK || {};
  EXEMPT = data.EXEMPT || [];
  PROFANITY = data.PROFANITY === 'off' ? 'off' : 'mask';
  indexCache.clear();
}

function buildIndex(langs) {
  const exempt = new Set(EXEMPT.map(norm1));
  const exact = new Map();
  const collapsed = new Map();
  const phrases = new Map();
  const phraseLens = new Set();
  const nospace = [];
  const byLen = new Map();

  const add = (raw, tier, cat) => {
    const term = norm1(raw);
    if (!term || exempt.has(term)) return;
    const meta = { tier, cat };
    if (NOSPACE.test(term)) { nospace.push({ term, ...meta }); return; }
    if (term.includes(' ')) {
      if (!phrases.has(term) || tier === 'block') phrases.set(term, meta);
      phraseLens.add(term.split(' ').length);
      return;
    }
    if (!exact.has(term) || tier === 'block') exact.set(term, meta);
    const c = collapse(term);
    if (c.length >= 4 && (!collapsed.has(c) || tier === 'block')) collapsed.set(c, meta);
    if (PURE_LATIN.test(term) && term.length >= 4) {
      if (!byLen.has(term.length)) byLen.set(term.length, []);
      byLen.get(term.length).push({ term, ...meta });
    }
  };

  for (const [cat, terms] of Object.entries(BLOCK)) for (const t of terms) add(t, 'block', cat);
  for (const [lang, terms] of Object.entries(LISTS)) {
    for (const t of terms) if (!LATINISH.test(t) || langs.has(lang)) add(t, 'mask', 'profanity');
  }
  return { exact, collapsed, phrases, phraseLens, nospace, byLen };
}

function getIndex(langs) {
  const key = [...langs].sort().join(',');
  if (!indexCache.has(key)) indexCache.set(key, buildIndex(langs));
  return indexCache.get(key);
}

function candidates(token) {
  const out = new Set();
  const stripped = token.replace(EDGE_SYMS, '');
  const bases = new Set([token]);
  if (stripped) bases.add(stripped);
  for (const b of bases) {
    out.add(b);
    const l = leet(b);
    out.add(l);
    const d = deaccent(l);
    out.add(d);
    if (HAS_LATIN.test(d) && CONF_RE.test(d)) out.add(d.replace(CONF_RE, c => CONFUSABLES[c]));
    CONF_RE.lastIndex = 0;
  }
  return out;
}

function wildLookup(index, cand) {
  const list = index.byLen.get(cand.length);
  if (!list) return null;
  const fixed = [...cand].filter(c => !WILDCARD.test(c)).length;
  if (fixed < 3) return null;
  for (const e of list) {
    let ok = true;
    for (let i = 0; i < cand.length; i++) {
      const c = cand[i];
      if (!WILDCARD.test(c) && c !== e.term[i]) { ok = false; break; }
    }
    if (ok) return e;
  }
  return null;
}

function lookup(index, token) {
  for (const c of candidates(token)) {
    const direct = index.exact.get(c);
    if (direct) return direct;
    if (WILDCARD.test(c)) {
      const w = wildLookup(index, c);
      if (w) return w;
    } else {
      const k = collapse(c);
      if (k.length >= 4) {
        const h = index.collapsed.get(k);
        if (h) return h;
      }
    }
  }
  return null;
}

function flatToken(t) {
  return deaccent(leet(t.replace(EDGE_SYMS, '') || t));
}

function positions(flat, raw, wanted, extra) {
  const out = [];
  for (let i = 0; i < flat.length; i++) {
    const pair = i + 1 < flat.length && (wanted.has(flat[i] + ' ' + flat[i + 1]) || wanted.has(raw[i] + ' ' + raw[i + 1]));
    if (wanted.has(flat[i]) || wanted.has(raw[i]) || pair || (extra && extra(raw[i]))) out.push(i);
  }
  return out;
}

function near(a, b, gap) {
  for (const i of a) for (const j of b) if (Math.abs(i - j) <= gap && i !== j) return true;
  return false;
}

function ruleCategory(flat, raw) {
  const joined = flat.join(' ');
  for (const r of THREATS) if (r.test(joined)) return 'threat';
  const pos = (set, extra) => positions(flat, raw, set, extra);
  const strong = pos(STRONG_MINOR, t => AGE.test(t));
  const weak = pos(WEAK_MINOR);
  if (strong.length && near(strong, pos(ANY_SEX), 5)) return 'csam';
  if (weak.length && near(weak, pos(STRONG_SEX), 5)) return 'csam';
  const verbs = pos(TRADE_VERBS);
  if (verbs.length && near(verbs, pos(TRADE_ITEMS), 6)) return 'illegal-trade';
  return null;
}

export function analyze(text, langs) {
  const result = { action: 'allow', category: null, spans: [], text };
  if (typeof text !== 'string' || !text) return result;
  const index = getIndex(langs instanceof Set ? langs : new Set(langs || ['en']));
  const { norm, map } = normalize(text);
  const tokens = [];
  for (const m of norm.matchAll(WORD)) tokens.push({ t: m[0], a: m.index, b: m.index + m[0].length });

  const hits = [];
  const hit = (a, b, meta) => hits.push({ a, b, tier: meta.tier, cat: meta.cat });

  for (const tk of tokens) {
    const meta = lookup(index, tk.t);
    if (meta) hit(tk.a, tk.b, meta);
  }

  if (index.phraseLens.size) {
    const flatForms = tokens.map(tk => flatToken(tk.t));
    for (let i = 0; i < tokens.length; i++) {
      for (const n of index.phraseLens) {
        if (i + n > tokens.length) continue;
        const meta = index.phrases.get(flatForms.slice(i, i + n).join(' '));
        if (meta) hit(tokens[i].a, tokens[i + n - 1].b, meta);
      }
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    if (!SINGLE.test(tokens[i].t)) continue;
    let j = i;
    while (j + 1 < tokens.length && SINGLE.test(tokens[j + 1].t) && SPACER.test(norm.slice(tokens[j].b, tokens[j + 1].a))) j++;
    if (j - i + 1 >= 3) {
      const last = Math.min(j, i + 15);
      for (let s = i; s <= last - 2; s++) {
        let joined = tokens[s].t;
        for (let e = s + 1; e <= last; e++) {
          joined += tokens[e].t;
          if (e - s + 1 < 3) continue;
          const meta = lookup(index, joined);
          if (meta) hit(tokens[s].a, tokens[e].b, meta);
        }
      }
    }
    i = j;
  }

  if (index.nospace.length && NOSPACE.test(norm)) {
    for (const e of index.nospace) {
      let from = 0;
      let p;
      while ((p = norm.indexOf(e.term, from)) !== -1) {
        hit(p, p + e.term.length, e);
        from = p + e.term.length;
      }
    }
  }

  const flat = tokens.map(tk => flatToken(tk.t));
  const raw = tokens.map(tk => tk.t.replace(EDGE_SYMS, '') || tk.t);
  const ruleCat = ruleCategory(flat, raw);
  const blockHit = hits.find(h => h.tier === 'block');
  if (ruleCat || blockHit) {
    result.action = 'block';
    result.category = ruleCat || blockHit.cat;
    return result;
  }
  if (!hits.length || PROFANITY === 'off') return result;

  const spans = hits
    .map(h => ({ start: map[h.a][0], end: map[h.b - 1][1] }))
    .sort((x, y) => x.start - y.start || y.end - x.end);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  let out = '';
  let cursor = 0;
  for (const s of merged) {
    out += text.slice(cursor, s.start) + '*'.repeat(Math.max(3, Math.min(s.end - s.start, 8)));
    cursor = s.end;
  }
  out += text.slice(cursor);
  result.action = 'mask';
  result.category = 'profanity';
  result.spans = merged;
  result.text = out;
  return result;
}

const BLOCKED_EXT = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'lnk', 'dll', 'sys', 'jar', 'apk', 'apkm', 'xapk', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'reg', 'hta', 'cpl', 'msc']);
const BIDI = /[\u202a-\u202e\u2066-\u2069]/;
const MAGIC = [
  [0x4d, 0x5a],
  [0x7f, 0x45, 0x4c, 0x46],
  [0xca, 0xfe, 0xba, 0xbe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0x64, 0x65, 0x78, 0x0a]
];

export function analyzeFile(name, head) {
  const fileName = String(name || '');
  if (BIDI.test(fileName)) return { action: 'block', category: 'spoofed-filename' };
  const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase().trim() : '';
  if (BLOCKED_EXT.has(ext)) return { action: 'block', category: 'executable' };
  if (head && head.length) {
    for (const sig of MAGIC) {
      if (head.length >= sig.length && sig.every((b, i) => head[i] === b)) return { action: 'block', category: 'executable' };
    }
  }
  return { action: 'allow', category: null };
}
