'use strict';

const PT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
const cells = new Map();

export const pacificDay = (t = Date.now()) => PT.format(t);

export function shiftDay(day, delta) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function ledgerAdd(shard, cat, r = 0, w = 0, d = 0, x = 0) {
  if (!(r || w || d || x)) return;
  const key = `${pacificDay()}|${shard}|${cat}`;
  const c = cells.get(key) || [0, 0, 0, 0];
  c[0] += r; c[1] += w; c[2] += d; c[3] += x;
  cells.set(key, c);
}

export function ledgerTake() {
  const out = [];
  for (const [key, c] of cells) {
    const [day, shard, cat] = key.split('|');
    out.push({ day, shard, cat, c });
  }
  cells.clear();
  return out;
}

export function ledgerRestore(items) {
  for (const it of items) {
    const key = `${it.day}|${it.shard}|${it.cat}`;
    const c = cells.get(key) || [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) c[i] += it.c[i];
    cells.set(key, c);
  }
}

export const ledgerSize = () => cells.size;
