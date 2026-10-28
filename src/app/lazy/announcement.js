'use strict';
/**
 * Announcement Components System
 * ------------------------------------------------------------------
 * Firestore stores configuration, StoreGit serves assets, MiutChat renders.
 * Admins never write HTML: config/announcement holds a list of typed
 * components ("blocks"), each validated and normalised here before it is
 * rendered. Anything invalid is dropped silently — a bad block can never
 * break the popup, and unknown types (written by a newer admin than this
 * client) are skipped, so the format can grow without breaking old clients.
 *
 *   config/announcement = {
 *     message: "<one plain string, one component per line — see parseAnnouncementText>",   // simplest
 *     // or, for full control, typed blocks:
 *     id: "oct-launch", rev: 2, title: "WHAT'S NEW", blocks: [ { type: "...", ... }, ... ]
 *   }
 *
 * Adding a new component = add one entry to COMPONENTS ({ normalize, render }).
 * Adding a new button action = add one entry to ACTIONS. Nothing else changes.
 */

import { _log, toast, ensureAuth, renderTextContent } from '../app.js';

const LIMITS = { blocks: 30, text: 4000, notice: 600, label: 80, question: 200, caption: 200, alt: 160, options: 8, img: 1200 };
const ID_RE       = /^[A-Za-z0-9_-]{1,32}$/;
const SHORT_ID_RE = /^[A-Za-z0-9_-]{3,8}$/;
const DEFAULT_BASE = 'https://storegit.pages.dev';

/* ── helpers ──────────────────────────────────────────────────────── */
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v, lo, hi) => {
  if (v === '' || v == null) return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
};
function _httpsUrl(u) {
  try {
    const x = new URL(String(u).trim());
    if (x.protocol !== 'https:' || x.username || x.password) return null;
    return x;
  } catch { return null; }
}
function _hostAllowed(host, hosts) {
  host = String(host).toLowerCase();
  for (const h of hosts) {
    if (h === host) return true;
    if (h.startsWith('*.') && host.endsWith(h.slice(1)) && host.length > h.length - 1) return true;
  }
  return false;
}
function _time(v) {
  if (v == null || v === '') return null;
  if (typeof v.toMillis === 'function') return v.toMillis();                 // Firestore Timestamp
  if (typeof v === 'object' && typeof v.seconds === 'number') return v.seconds * 1000;
  if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;                 // seconds or ms
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Runtime settings: StoreGit base + allowed image hosts come from /api/config (ANNOUNCE_IMG_HOSTS, STOREGIT_BASE). */
export function _cfg() {
  const c = (typeof window !== 'undefined' && window.__MIUT_ANNOUNCE__) || {};
  const base = _httpsUrl(c.storegitBase) || new URL(DEFAULT_BASE);
  const list = Array.isArray(c.imgHosts) ? c.imgHosts : [];
  const hosts = new Set([base.hostname, ...list].map(h => String(h).toLowerCase()).filter(Boolean));
  return { base, hosts };
}

/** "aBcD" | StoreGit share URL | allowed-host https URL  →  safe image URL (or null). */
export function resolveImageSrc(src, cfg) {
  const s = String(src || '').trim();
  if (SHORT_ID_RE.test(s)) return `${cfg.base.origin}/api/raw/${s}`;
  const u = _httpsUrl(s);
  if (!u || u.port || !_hostAllowed(u.hostname, cfg.hosts)) return null;
  if (u.origin === cfg.base.origin) {
    const m = /^\/([A-Za-z0-9_-]{3,8})\/?$/.exec(u.pathname);
    if (m && !u.search) return `${u.origin}/api/raw/${m[1]}`;               // share page → raw image
  }
  return u.href;
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
function _extLink(href, cls) {
  const a = el('a', cls);
  a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
  return a;
}

/* ── approved button actions ──────────────────────────────────────── */
// validate(value) → normalised value, or null when invalid.
export const ACTIONS = {
  dismiss:    { validate: () => '',                                      run: (_v, ctx) => ctx.close() },
  reload:     { validate: () => '',                                      run: () => location.reload() },
  'open-url': { validate: v => _httpsUrl(v)?.href || null,               run: v => window.open(v, '_blank', 'noopener,noreferrer') },
  copy: {
    validate: v => (typeof v === 'string' && v.trim() && v.length <= 200 ? v.trim() : null),
    run: async v => {
      try { await navigator.clipboard.writeText(v); toast('Copied', ''); }
      catch { toast('Couldn\u2019t copy', 'Copy it manually instead', 'err'); }
    },
  },
};

/* ── poll store (shared by the Poll and Results components) ───────── */
// announcementPolls/{annId__pollId}/votes/{uid}  → { choices:[optId], ts }
// announcementPolls/{annId__pollId}/tally/{optId} → { n }       (+ tally/_total = voters)
function _pollStore(ctx, poll) {
  const hit = ctx.polls.get(poll.id);
  if (hit) return hit;
  const s = { my: undefined, counts: {}, total: 0, err: null, busy: false, subs: new Set(), started: false };
  const fs   = () => firebase.firestore(firebase.app(ctx.dbName));
  const base = () => fs().collection('announcementPolls').doc(`${ctx.annId}__${poll.id}`);
  const valid = new Set(poll.options.map(o => o.id));
  s.notify = () => s.subs.forEach(f => { try { f(s); } catch (e) { _log('warn', '[ann] poll view', e?.message); } });

  s.init = async () => {
    try {
      const uid = await ensureAuth(ctx.dbName);
      const snap = await base().collection('votes').doc(uid).get();
      const ch = snap.exists && Array.isArray(snap.data()?.choices) ? snap.data().choices.filter(c => valid.has(c)) : [];
      s.my = snap.exists ? ch : null;
    } catch (e) { s.err = 'unavailable'; s.my = null; _log('warn', '[ann] vote lookup failed', e?.message); }
    s.notify();
  };

  s.watch = live => {                                     // one listener per poll, however many views want it
    if (s.started) return;
    s.started = true;
    const apply = snap => {
      const counts = {}; let total = 0;
      snap.forEach(d => {
        const n = Number(d.data()?.n) || 0;
        if (d.id === '_total') total = n; else if (valid.has(d.id)) counts[d.id] = n;
      });
      s.counts = counts; s.total = total; s.notify();
    };
    const col = base().collection('tally');
    if (live) ctx.cleanup.push(col.onSnapshot(apply, e => { s.err = 'unavailable'; _log('warn', '[ann] tally', e?.message); s.notify(); }));
    else col.get().then(apply).catch(() => { s.err = 'unavailable'; s.notify(); });
  };

  s.vote = async choices => {
    if (s.busy || s.my) return false;
    choices = [...new Set(choices)].filter(c => valid.has(c));
    const max = poll.multi ? poll.max : 1;
    if (!choices.length || choices.length > max) return false;
    s.busy = true; s.notify();
    try {
      const uid = await ensureAuth(ctx.dbName);
      const F = firebase.firestore.FieldValue, b = base(), batch = fs().batch();
      batch.set(b.collection('votes').doc(uid), { choices, ts: F.serverTimestamp() });
      for (const c of choices) batch.set(b.collection('tally').doc(c), { n: F.increment(1) }, { merge: true });
      batch.set(b.collection('tally').doc('_total'), { n: F.increment(1) }, { merge: true });
      await batch.commit();
      s.my = choices; s.err = null;
      return true;
    } catch (e) {
      _log('warn', '[ann] vote failed', e?.code || e?.message);
      toast('Vote not sent', e?.code === 'permission-denied' ? 'You may have voted already' : 'Check your connection', 'err');
      return false;
    } finally { s.busy = false; s.notify(); }
  };

  ctx.polls.set(poll.id, s);
  s.init();
  return s;
}

/* ── components ───────────────────────────────────────────────────── */
export const COMPONENTS = {
  text: {
    normalize: r => { const text = str(r.text, LIMITS.text); return text ? { type: 'text', text } : null; },
    render: b => { const d = el('div', 'ann-text'); d.innerHTML = renderTextContent(b.text, true); return d; },
  },

  image: {
    normalize: (r, ctx) => {
      const src = resolveImageSrc(r.src, ctx.cfg);
      if (!src) return null;
      const href = r.href ? _httpsUrl(r.href)?.href : null;
      return { type: 'image', src, alt: str(r.alt, LIMITS.alt), caption: str(r.caption, LIMITS.caption),
               w: int(r.w ?? r.width, 1, LIMITS.img), h: int(r.h ?? r.height, 1, LIMITS.img), href: href || null };
    },
    render: b => {
      const fig = el('figure', 'ann-figure');
      const img = new Image();
      img.className = 'ann-img' + (b.h ? '' : ' ann-img-auto');
      img.alt = b.alt; img.src = b.src; img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
      if (b.w) img.width = b.w;
      if (b.h) img.height = b.h;
      img.addEventListener('error', () => img.replaceWith(el('div', 'ann-img-fail', b.alt || 'Image unavailable')), { once: true });
      if (b.href) { const a = _extLink(b.href, 'ann-img-link'); a.append(img); fig.append(a); } else fig.append(img);
      if (b.caption) fig.append(el('figcaption', 'ann-caption', b.caption));
      return fig;
    },
  },

  link: {
    normalize: r => {
      const u = _httpsUrl(r.url), label = str(r.label, LIMITS.label);
      return u && label ? { type: 'link', label, url: u.href, host: u.hostname, desc: str(r.desc, 200) } : null;
    },
    render: b => {
      const a = _extLink(b.url, 'ann-link');
      a.append(el('span', 'ann-link-label', b.label));
      if (b.desc) a.append(el('span', 'ann-link-desc', b.desc));
      a.append(el('span', 'ann-link-host', b.host + ' \u2197'));
      return a;
    },
  },

  notice: {
    normalize: r => {
      const text = str(r.text, LIMITS.notice), title = str(r.title, LIMITS.label);
      if (!text && !title) return null;
      const level = ['info', 'success', 'warn', 'danger'].includes(r.level) ? r.level : 'info';
      return { type: 'notice', level, title, text };
    },
    render: b => {
      const d = el('div', 'ann-notice ann-notice-' + b.level);
      d.setAttribute('role', b.level === 'danger' || b.level === 'warn' ? 'alert' : 'note');
      if (b.title) d.append(el('div', 'ann-notice-title', b.title));
      if (b.text) { const t = el('div', 'ann-notice-text'); t.innerHTML = renderTextContent(b.text); d.append(t); }
      return d;
    },
  },

  button: {
    normalize: r => {
      const label = str(r.label, 40), act = ACTIONS[r.action];
      if (!label || !act || !Object.prototype.hasOwnProperty.call(ACTIONS, r.action)) return null;
      const value = act.validate(r.value);
      if (value === null) return null;
      return { type: 'button', label, action: r.action, value, style: r.style === 'ghost' ? 'ghost' : 'primary' };
    },
    render: (b, ctx) => {
      const btn = el('button', 'ann-btn ann-btn-' + b.style, b.label);
      btn.type = 'button';
      btn.addEventListener('click', () => { try { ACTIONS[b.action].run(b.value, ctx); } catch (e) { _log('warn', '[ann] action', e?.message); } });
      return btn;
    },
  },

  countdown: {
    normalize: r => {
      const to = _time(r.to);
      return to == null ? null : { type: 'countdown', to, label: str(r.label, LIMITS.label), doneText: str(r.doneText, LIMITS.label) || 'Time\u2019s up' };
    },
    render: (b, ctx) => {
      const box = el('div', 'ann-countdown');
      if (b.label) box.append(el('div', 'ann-countdown-label', b.label));
      const row = el('div', 'ann-countdown-row'), cells = {};
      for (const k of ['d', 'h', 'm', 's']) {
        const c = el('div', 'ann-cd-cell'); cells[k] = el('span', 'ann-cd-num', '0');
        c.append(cells[k], el('span', 'ann-cd-unit', k)); row.append(c);
      }
      const done = el('div', 'ann-countdown-done', b.doneText); done.hidden = true;
      box.append(row, done);
      let timer = null;
      const tick = () => {
        const left = b.to - Date.now();
        if (left <= 0) { row.hidden = true; done.hidden = false; clearInterval(timer); return; }
        const t = Math.floor(left / 1000);
        cells.d.textContent = String(Math.floor(t / 86400));
        cells.h.textContent = String(Math.floor(t % 86400 / 3600)).padStart(2, '0');
        cells.m.textContent = String(Math.floor(t % 3600 / 60)).padStart(2, '0');
        cells.s.textContent = String(t % 60).padStart(2, '0');
      };
      tick();
      if (b.to - Date.now() > 0) { timer = setInterval(tick, 1000); ctx.cleanup.push(() => clearInterval(timer)); }
      return box;
    },
  },

  poll: {
    normalize: (r, ctx) => {
      if (!ctx.annId || !ID_RE.test(String(r.id || ''))) return null;        // polls need an announcement id + poll id
      const question = str(r.question, LIMITS.question);
      if (!question || !Array.isArray(r.options)) return null;
      const options = [], seen = new Set();
      r.options.slice(0, LIMITS.options).forEach((o, i) => {
        const label = str(typeof o === 'string' ? o : o?.label, LIMITS.label);
        const id = typeof o === 'string' ? 'o' + (i + 1) : String(o?.id ?? 'o' + (i + 1));
        if (label && ID_RE.test(id) && !seen.has(id)) { seen.add(id); options.push({ id, label }); }
      });
      if (options.length < 2) return null;
      const multi = r.multi === true;
      return { type: 'poll', id: r.id, question, options, multi,
               max: multi ? (int(r.max, 1, options.length) || options.length) : 1, closesAt: _time(r.closesAt) };
    },
    render: (b, ctx) => {
      const store = _pollStore(ctx, b);
      const box = el('div', 'ann-poll');
      box.append(el('div', 'ann-poll-q', b.question));
      const list = el('div', 'ann-poll-opts'), msg = el('div', 'ann-poll-msg'), go = el('button', 'ann-btn ann-btn-primary', 'VOTE');
      go.type = 'button';
      const inputs = b.options.map(o => {
        const row = el('label', 'ann-opt'), inp = document.createElement('input');
        inp.type = b.multi ? 'checkbox' : 'radio'; inp.name = 'ann-' + b.id; inp.value = o.id;
        row.append(inp, el('span', 'ann-opt-label', o.label)); list.append(row);
        return inp;
      });
      const picked = () => inputs.filter(i => i.checked).map(i => i.value);
      const closed = () => b.closesAt != null && Date.now() > b.closesAt;
      const sync = () => {
        const voted = Array.isArray(store.my), n = picked().length;
        inputs.forEach(i => {
          i.disabled = voted || closed() || store.busy || store.my === undefined;
          if (voted) i.checked = store.my.includes(i.value);
          else if (b.multi && n >= b.max && !i.checked) i.disabled = true;
        });
        go.hidden = voted || closed();
        go.disabled = store.busy || store.my === undefined || n === 0;
        go.textContent = store.busy ? 'SENDING\u2026' : 'VOTE';
        msg.textContent = voted ? 'Thanks \u2014 your vote is in.' : closed() ? 'Voting is closed.'
          : store.err ? 'Voting is unavailable right now.' : b.multi ? `Choose up to ${b.max}.` : '';
      };
      list.addEventListener('change', sync);
      go.addEventListener('click', () => store.vote(picked()));
      store.subs.add(sync); ctx.cleanup.push(() => store.subs.delete(sync));
      box.append(list, go, msg); sync();
      return box;
    },
  },

  results: {
    normalize: r => (ID_RE.test(String(r.pollId || ''))
      ? { type: 'results', pollId: r.pollId, live: r.live !== false, visibility: r.visibility === 'after-vote' ? 'after-vote' : 'always' } : null),
    render: (b, ctx) => {
      const poll = ctx.pollDefs.get(b.pollId);
      const store = _pollStore(ctx, poll);
      store.watch(b.live);
      const box = el('div', 'ann-results');
      box.append(el('div', 'ann-poll-q', poll.question));
      const rows = poll.options.map(o => {
        const row = el('div', 'ann-res-row'), top = el('div', 'ann-res-top'), bar = el('div', 'ann-res-bar'), fill = el('div', 'ann-res-fill');
        const name = el('span', 'ann-res-name', o.label), val = el('span', 'ann-res-val', '0');
        top.append(name, val); bar.append(fill); row.append(top, bar); box.append(row);
        return { o, fill, val, row };
      });
      const foot = el('div', 'ann-res-foot');
      box.append(foot);
      const sync = () => {
        const hidden = b.visibility === 'after-vote' && !Array.isArray(store.my);
        rows.forEach(r => r.row.hidden = hidden);
        if (hidden) { foot.textContent = store.my === undefined ? '' : 'Vote to see the results.'; return; }
        const total = store.total || 0;
        rows.forEach(({ o, fill, val, row }) => {
          const n = store.counts[o.id] || 0, pct = total ? Math.round(n * 100 / total) : 0;
          fill.style.width = pct + '%'; val.textContent = `${pct}% \u00B7 ${n}`;
          row.classList.toggle('mine', Array.isArray(store.my) && store.my.includes(o.id));
        });
        foot.textContent = store.err ? 'Live results unavailable.' : `${total} vote${total === 1 ? '' : 's'}`;
      };
      store.subs.add(sync); ctx.cleanup.push(() => store.subs.delete(sync));
      sync();
      return box;
    },
  },
};


/* ── plain-string format ──────────────────────────────────────────────
 * Admins can write the whole announcement as ONE string (the `message` field), one component per line:
 *
 *   ![Banner](waRt =320x)                       image: StoreGit id or URL, optional =WxH / =Wx / =xH
 *   [![Banner](waRt =320x)](https://site.com)   clickable image
 *   [!title WHAT'S NEW]                         modal title            ([!id oct] / [!rev 2] also exist)
 *   [!notice warn | Maintenance | Sunday 02:00] level (info|success|warn|danger) | title | text
 *   [!countdown 2026-11-01T02:00:00Z | MAINTENANCE IN | In progress]
 *   [!poll next | What next? | Voice notes | Themes | Threads]     add  multi=2  or  closes=2026-11-01T00:00:00Z
 *   [!results next]                             add  show=after-vote  or  live=false
 *   [!link Release notes | https://example.com | optional description]
 *   [!button dismiss | GOT IT]                  [!button open-url | Open | https://…]  [!button copy | Copy | CODE]
 *   anything else                               normal text (Markdown-style), consecutive lines = one text block
 *
 * Use \| for a literal pipe. Everything still goes through the same validators as typed blocks.
 */
const OPT_KEYS = new Set(['w', 'h', 'style', 'multi', 'closes', 'live', 'show', 'caption', 'href', 'alt']);
const LEVELS = ['info', 'success', 'warn', 'danger'];
const TAG_RE = /^\[!([a-z]+)(?:[ \t]+(.*))?\]$/i;
const IMG_RE = /^(\[)?!\[([^\]]*)\]\(([^\s)]+)(?:[ \t]+=(\d*)x(\d*))?\)(?:\]\(([^\s)]+)\))?$/;
const COMPONENT_LINE = /^[ \t]*(?:\[!|!\[|\[!\[)/m;

export function looksLikeComponentText(s) { return COMPONENT_LINE.test(String(s || '')); }

function _pipes(s) {
  const out = []; let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; }
    else if (c === '|') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(x => x.trim());
}
function _split(rest) {
  const opts = {}, pos = [];
  for (const part of _pipes(rest || '')) {
    const m = /^([a-z]+)=(.*)$/i.exec(part);
    if (m && OPT_KEYS.has(m[1].toLowerCase())) opts[m[1].toLowerCase()] = m[2].trim(); else pos.push(part);
  }
  return { opts, pos };
}

export function parseAnnouncementText(text) {
  const meta = {}, blocks = [];
  let buf = [];
  const flush = () => { const t = buf.join('\n').trim(); buf = []; if (t) blocks.push({ type: 'text', text: t }); };
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    const im = IMG_RE.exec(line);
    if (im && !!im[1] === !!im[6]) {
      flush(); blocks.push({ type: 'image', alt: im[2], src: im[3], w: im[4], h: im[5], href: im[6] || undefined }); continue;
    }
    const tm = TAG_RE.exec(line);
    if (!tm) { buf.push(raw); continue; }
    const tag = tm[1].toLowerCase(), rest = tm[2] || '';
    if (tag === 'id' || tag === 'rev' || tag === 'title') { meta[tag] = rest.trim(); continue; }
    const { opts, pos } = _split(rest);
    let b = null;
    switch (tag) {
      case 'image':     b = { type: 'image', src: pos[0], alt: opts.alt ?? pos[1], caption: opts.caption ?? pos[2], w: opts.w, h: opts.h, href: opts.href }; break;
      case 'notice': {
        const level = LEVELS.includes((pos[0] || '').toLowerCase()) ? pos.shift().toLowerCase() : 'info';
        b = pos.length > 1 ? { type: 'notice', level, title: pos[0], text: pos.slice(1).join(' | ') } : { type: 'notice', level, text: pos[0] }; break;
      }
      case 'link':      b = { type: 'link', label: pos[0], url: pos[1], desc: pos[2] }; break;
      case 'button':    b = { type: 'button', action: (pos[0] || '').toLowerCase(), label: pos[1], value: pos[2], style: opts.style }; break;
      case 'countdown': b = { type: 'countdown', to: pos[0], label: pos[1], doneText: pos[2] }; break;
      case 'poll':      b = { type: 'poll', id: pos[0], question: pos[1], options: pos.slice(2), multi: opts.multi != null, max: opts.multi, closesAt: opts.closes }; break;
      case 'results': {                                                // "[!results next]" or "[!results next show=after-vote live=false]"
        const toks = (pos[0] || '').split(/\s+/), o = { ...opts };
        for (const t of toks.slice(1)) { const m = /^([a-z]+)=(.*)$/i.exec(t); if (m) o[m[1].toLowerCase()] = m[2]; }
        b = { type: 'results', pollId: toks[0], live: o.live !== 'false', visibility: o.show === 'after-vote' ? 'after-vote' : 'always' }; break;
      }
      default:          buf.push(raw); continue;                      // unknown tag → show as plain text
    }
    flush(); blocks.push(b);
  }
  flush();
  return { meta, blocks };
}

function _hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

/** Source of truth for "what is this announcement": typed `blocks` win; otherwise a component-string `message`. */
function _expand(data) {
  let blocks = Array.isArray(data?.blocks) ? data.blocks : [];
  let id = data?.id, rev = data?.rev, title = data?.title;
  if (!blocks.length && typeof data?.message === 'string' && looksLikeComponentText(data.message)) {
    const p = parseAnnouncementText(data.message);
    blocks = p.blocks; id = id || p.meta.id; rev = rev ?? p.meta.rev; title = title || p.meta.title;
  }
  const explicit = ID_RE.test(String(id || ''));
  if (!explicit) {                                   // polls need an id: derive it from the poll definitions only,
    const polls = blocks.filter(b => b?.type === 'poll');   // so editing the text around a poll never resets its votes
    id = polls.length ? 'p' + _hash(JSON.stringify(polls.map(b => [b.id, b.question, b.options]))) : '';
  }
  return { id: String(id || ''), explicit, rev, title, blocks };
}

/* ── normalise + render ───────────────────────────────────────────── */
export function normalizeAnnouncement(data, cfg = _cfg()) {
  const x = _expand(data);
  const ctx = { cfg, annId: x.id };
  const raw = x.blocks.slice(0, LIMITS.blocks);
  const out = [], polls = new Set();
  for (const r of raw) {
    const comp = r && Object.prototype.hasOwnProperty.call(COMPONENTS, r.type) ? COMPONENTS[r.type] : null;
    if (!comp) { _log('warn', '[ann] skipping unknown block type:', String(r?.type).slice(0, 30)); continue; }
    let b = null;
    try { b = comp.normalize(r, ctx); } catch (e) { _log('warn', '[ann] bad block', e?.message); }
    if (!b) { _log('warn', '[ann] dropped invalid', r.type, 'block'); continue; }
    if (b.type === 'poll') { if (polls.has(b.id)) continue; polls.add(b.id); }
    out.push(b);
  }
  const blocks = out.filter(b => b.type !== 'results' || polls.has(b.pollId));
  return { id: x.id, keyId: x.explicit ? x.id : '', rev: x.rev != null ? String(x.rev).slice(0, 20) : '', title: str(x.title, 60) || 'ANNOUNCEMENT', blocks };
}

/** Identity used to remember "already seen": explicit id(+rev) when given, otherwise a hash of the content. */
export function announcementKey(data, cfg) {
  const a = normalizeAnnouncement(data, cfg);
  if (a.keyId) return 'ann:' + a.keyId + (a.rev ? '@' + a.rev : '');
  return 'ann:h' + _hash(JSON.stringify(a.blocks));
}

export function renderAnnouncement(data, { dbName = 'miut-db0', close = () => {}, cfg } = {}) {
  const c = cfg || _cfg();
  const ann = normalizeAnnouncement(data, c);
  const ctx = { cfg: c, annId: ann.id, dbName, close, cleanup: [], polls: new Map(),
                pollDefs: new Map(ann.blocks.filter(b => b.type === 'poll').map(b => [b.id, b])) };
  const root = el('div', 'ann-root');
  for (const b of ann.blocks) {
    try { root.append(COMPONENTS[b.type].render(b, ctx)); }
    catch (e) { _log('warn', '[ann] render failed for', b.type, e?.message); }
  }
  return {
    root, title: ann.title, hasBlocks: ann.blocks.length > 0, blocks: ann.blocks,
    destroy() { ctx.cleanup.splice(0).forEach(f => { try { f(); } catch {} }); },
  };
}
