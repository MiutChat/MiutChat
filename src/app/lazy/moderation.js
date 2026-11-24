import { analyze, analyzeFile, configure } from './moderation-engine.js';
import { LISTS, BLOCK, EXEMPT } from './moderation-data.js';

configure({ LISTS, BLOCK, EXEMPT, PROFANITY: 'mask' });

const MESSAGES = {
  profanity: 'Bad words were replaced with stars.',
  hate: 'Hate speech and slurs are not allowed on MiutChat.',
  threat: 'Threats and encouraging violence or self-harm are not allowed on MiutChat.',
  csam: 'Content that sexualises minors is strictly prohibited and illegal.',
  'illegal-trade': 'Offering illegal goods or services is not allowed on MiutChat.',
  executable: 'Executable and installer files cannot be shared on MiutChat.',
  'spoofed-filename': 'This file name uses hidden characters to disguise its type.'
};

const STORE_KEY = 'miut_safety';
const STRIKE_WINDOW_MS = 10 * 60 * 1000;
const STRIKE_LIMIT = 3;
const LOCAL_COOLDOWN_MS = 60 * 1000;

function loadState() {
  try {
    const st = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return { strikes: Array.isArray(st.strikes) ? st.strikes : [], until: Number(st.until) || 0 };
  } catch {
    return { strikes: [], until: 0 };
  }
}

function saveState(st) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(st)); } catch {}
}

function adoptCooldown(untilMs) {
  const st = loadState();
  if (untilMs > st.until) {
    st.until = untilMs;
    saveState(st);
  }
}

function serverCall(action) {
  try {
    fetch('/api/rate-limit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
      keepalive: true
    })
      .then(r => r.json())
      .then(d => { if (d && d.cooldown > 0) adoptCooldown(Date.now() + d.cooldown * 1000); })
      .catch(() => {});
  } catch {}
}

function activeLangs() {
  const langs = new Set(['en', 'hi', 'bn']);
  try {
    for (const l of navigator.languages || [navigator.language]) langs.add(String(l || '').toLowerCase().split('-')[0]);
  } catch {}
  return langs;
}

function strike() {
  const now = Date.now();
  const st = loadState();
  st.strikes = st.strikes.filter(t => now - t < STRIKE_WINDOW_MS);
  st.strikes.push(now);
  if (st.strikes.length >= STRIKE_LIMIT) {
    st.until = Math.max(st.until, now + LOCAL_COOLDOWN_MS);
    st.strikes = [];
  }
  saveState(st);
  serverCall('strike');
}

export function cooldownLeft() {
  return Math.max(0, Math.ceil((loadState().until - Date.now()) / 1000));
}

serverCall('strike-status');

export function screenOutgoing(text) {
  const r = analyze(text, activeLangs());
  if (r.action === 'block') {
    strike();
    return { action: 'block', category: r.category, text, message: MESSAGES[r.category] || 'This message breaks MiutChat rules.' };
  }
  if (r.action === 'mask') return { action: 'mask', category: r.category, text: r.text, message: MESSAGES.profanity };
  return { action: 'allow', category: null, text, message: '' };
}

export function screenIncoming(text) {
  const r = analyze(text, activeLangs());
  if (r.action === 'block') {
    return { blocked: true, category: r.category, text: '\u26a0 Hidden by MiutChat safety \u2014 ' + (MESSAGES[r.category] || 'this message breaks MiutChat rules.') };
  }
  if (r.action === 'mask') return { blocked: false, category: r.category, text: r.text };
  return { blocked: false, category: null, text };
}

export async function screenFile(file) {
  let head = null;
  try {
    head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  } catch {}
  const r = analyzeFile(file && file.name, head);
  if (r.action === 'block') {
    strike();
    return { action: 'block', category: r.category, message: MESSAGES[r.category] };
  }
  return { action: 'allow', category: null, message: '' };
}

export function screenFileName(name) {
  const r = analyzeFile(name, null);
  return r.action === 'block'
    ? { blocked: true, category: r.category, message: MESSAGES[r.category] }
    : { blocked: false, category: null, message: '' };
}
