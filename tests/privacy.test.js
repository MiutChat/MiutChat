const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const nodeCrypto = require('crypto');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');

function loadRoomId() {
  const src = fs.readFileSync(path.join(root, 'src', 'core', 'db-manager.js'), 'utf8');
  const a = src.indexOf('/* ROOM-ID-BEGIN */');
  const b = src.indexOf('/* ROOM-ID-END */');
  assert.ok(a > 0 && b > a);
  const win = {};
  new Function('window', src.slice(a, b) + '\nwindow.__test = { roomDocId, roomHashId, installRoomIds, resolveRoom };')(win);
  return win.__test;
}

const refId = code => 'r' + nodeCrypto.createHash('sha256').update('miut-room-doc-v1\u0000' + code).digest('base64url');

test('room document ids are SHA-256 based, deterministic and never contain the code', () => {
  const { roomDocId } = loadRoomId();
  const codes = ['abcdef', 'Correct-Horse_9!', 'ünïcödé-ключ-密码-🔑', 'x'.repeat(64), 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63)];
  for (const c of codes) {
    const id = roomDocId(c);
    assert.strictEqual(id, refId(c), c);
    assert.strictEqual(roomDocId(c), id);
    assert.strictEqual(roomDocId(id), id);
    assert.ok(!id.includes(c));
    assert.match(id, /^r[A-Za-z0-9_-]{43}$/);
  }
  assert.notStrictEqual(roomDocId('abcdef'), roomDocId('abcdeg'));
});

test('installRoomIds maps only the rooms collection', () => {
  const { installRoomIds } = loadRoomId();
  const seen = [];
  const fs2 = {
    collection(name) {
      return { doc(id) { seen.push([name, id]); return { id }; } };
    }
  };
  installRoomIds(fs2);
  installRoomIds(fs2);
  fs2.collection('rooms').doc('my-secret-room');
  fs2.collection('config').doc('announcement');
  assert.strictEqual(seen[0][1], refId('my-secret-room'));
  assert.deepStrictEqual(seen[1], ['config', 'announcement']);
});

let ipMod;
test.before(async () => {
  const out = esbuild.buildSync({
    entryPoints: [path.join(root, 'functions', '_lib', 'ip-token.js')],
    bundle: true, format: 'esm', write: false, platform: 'node', target: 'es2020'
  });
  const file = path.join(os.tmpdir(), 'miut-ip-' + process.pid + '.mjs');
  fs.writeFileSync(file, out.outputFiles[0].text);
  ipMod = await import('file://' + file);
});

function fakeKv() {
  const m = new Map();
  return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); } };
}
const req = ip => ({ headers: { get: h => (h === 'CF-Connecting-IP' ? ip : null) } });

test('ip tokens are stable per day, differ per ip, and never contain the ip', async () => {
  const env = { MIUT_RL: fakeKv() };
  const a1 = await ipMod.ipToken(req('203.0.113.7'), env);
  const a2 = await ipMod.ipToken(req('203.0.113.7'), env);
  const b = await ipMod.ipToken(req('203.0.113.8'), env);
  assert.strictEqual(a1, a2);
  assert.notStrictEqual(a1, b);
  assert.ok(!a1.includes('203'));
  assert.ok(![...env.MIUT_RL.m.values()].some(v => String(v).includes('203.0.113')));
  assert.ok([...env.MIUT_RL.m.keys()].every(k => k.startsWith('salt:')));
});

test('ipv6 addresses in the same /64 share a token and v4-mapped matches v4', async () => {
  const env = { MIUT_RL: fakeKv() };
  const t1 = await ipMod.ipToken(req('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), env);
  const t2 = await ipMod.ipToken(req('2001:db8:1:2::1'), env);
  const t3 = await ipMod.ipToken(req('2001:db8:1:3::1'), env);
  assert.strictEqual(t1, t2);
  assert.notStrictEqual(t1, t3);
  assert.strictEqual(await ipMod.ipToken(req('::ffff:198.51.100.4'), env), await ipMod.ipToken(req('198.51.100.4'), env));
});

test('tokens change on the next day and a missing ip yields unknown', async () => {
  const env = { MIUT_RL: fakeKv() };
  const realNow = Date.now;
  try {
    Date.now = () => Date.UTC(2026, 5, 1, 12);
    const day1 = await ipMod.ipToken(req('203.0.113.7'), env);
    Date.now = () => Date.UTC(2026, 5, 2, 12);
    const day2 = await ipMod.ipToken(req('203.0.113.7'), env);
    assert.notStrictEqual(day1, day2);
    assert.ok(env.MIUT_RL.m.has('salt:2026-06-01') && env.MIUT_RL.m.has('salt:2026-06-02'));
  } finally {
    Date.now = realNow;
  }
  assert.strictEqual(await ipMod.ipToken(req(''), env), 'unknown');
});

test('no function reads the raw client ip except the token helper', () => {
  const dir = path.join(root, 'functions');
  const hits = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.js$/.test(f.name) && /CF-Connecting-IP|X-Forwarded-For/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p));
    }
  })(dir);
  assert.deepStrictEqual(hits.filter(h => !h.endsWith('ip-token.js')), []);
});

async function loadFn(file) {
  const out = esbuild.buildSync({
    entryPoints: [path.join(root, 'functions', 'api', file)],
    bundle: true, format: 'esm', write: false, platform: 'node', target: 'es2020'
  });
  const f = path.join(os.tmpdir(), 'miut-fn-' + file.replace('.js', '') + '-' + process.pid + '.mjs');
  fs.writeFileSync(f, out.outputFiles[0].text);
  return import('file://' + f);
}

const post = (ip, body) => new Request('https://x.test/api/x', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
  body: JSON.stringify(body)
});

test('automatic flags hide a message only after enough distinct apps flag it, without any content', async () => {
  const mod = await loadFn('flag.js');
  const env = { MIUT_RL: fakeKv() };
  const base = { roomId: 'rRoomHash12345', docId: 'doc123456', category: 'hate' };
  const call = (ip, from, extra = {}) => mod.onRequest({ request: post(ip, { ...base, from, ...extra }), env }).then(r => r.json());

  assert.strictEqual((await call('198.51.100.1', 'zzflagger-alpha')).hidden, false);
  assert.strictEqual((await call('198.51.100.1', 'zzflagger-alpha')).hidden, false);
  assert.strictEqual((await call('198.51.100.1', 'zzflagger-bravo')).hidden, false);
  assert.strictEqual((await call('198.51.100.1', 'zzflagger-charlie')).hidden, false);
  const final = await call('198.51.100.2', 'zzflagger-delta');
  assert.strictEqual(final.hidden, true);

  const listRes = await mod.onRequest({ request: new Request('https://x.test/api/flag?room=rRoomHash12345'), env });
  assert.deepStrictEqual((await listRes.json()).hidden, ['doc123456']);

  const stored = JSON.stringify([...env.MIUT_RL.m.entries()]);
  assert.ok(!stored.includes('198.51.100'));
  assert.ok(!/zzflagger/.test(stored));

  const sens = { ...base, docId: 'doc999999', category: 'child-safety' };
  const r1 = await mod.onRequest({ request: post('198.51.100.9', { ...sens, from: 'a' }), env }).then(r => r.json());
  const r2 = await mod.onRequest({ request: post('198.51.100.9', { ...sens, from: 'b' }), env }).then(r => r.json());
  assert.strictEqual(r1.hidden, false);
  assert.strictEqual(r2.hidden, true);

  const bad = await mod.onRequest({ request: post('198.51.100.9', { ...base, category: 'fraud', from: 'a' }), env });
  assert.strictEqual(bad.status, 400);
});

test('safety strikes escalate into a persistent cooldown and report it back', async () => {
  const mod = await loadFn('rate-limit.js');
  const env = { MIUT_RL: fakeKv(), MIUT_BAN: fakeKv() };
  const call = action => mod.onRequestPost({ request: post('203.0.113.50', { action }), env }).then(r => r.json());
  assert.strictEqual((await call('strike')).cooldown, 0);
  assert.strictEqual((await call('strike')).cooldown, 0);
  const third = await call('strike');
  assert.strictEqual(third.cooldown, 60);
  const status = await call('strike-status');
  assert.ok(status.cooldown > 0 && status.cooldown <= 60);
  const other = await mod.onRequestPost({ request: post('203.0.113.51', { action: 'strike-status' }), env }).then(r => r.json());
  assert.strictEqual(other.cooldown, 0);
  const keys = [...env.MIUT_RL.m.keys()];
  assert.ok(keys.every(k => /^(salt|st|cd|lv):/.test(k)));
  assert.ok(!keys.some(k => k.includes('203.0.113')));
});

test('no email addresses or placeholders anywhere in shipped pages, docs or functions', () => {
  const dirs = ['src/pages', 'public', 'docs', 'functions', 'src/app', 'src/core'];
  const files = ['SECURITY.md'];
  const walk = d => {
    for (const f of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
      const rel = path.join(d, f.name);
      if (f.isDirectory()) walk(rel);
      else if (/\.(html|js|md|txt|json)$/.test(f.name)) files.push(rel);
    }
  };
  dirs.forEach(walk);
  const bad = [];
  for (const rel of files) {
    const t = fs.readFileSync(path.join(root, rel), 'utf8');
    const stripped = t.replace(/mailto:/g, '');
    if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(stripped) && !/\/\/.*@gmail\.com/.test(stripped)) bad.push(rel + ' (email)');
    if (/\[Full name|operator to add|PLACEHOLDER|CHANGEME/.test(t)) bad.push(rel + ' (placeholder)');
  }
  assert.deepStrictEqual(bad, []);
});

test('invite link tag is a short PBKDF2 hash and never contains the room code', async () => {
  const src = fs.readFileSync(path.join(root, 'src', 'app', 'app.js'), 'utf8');
  const a = src.indexOf('/* INVITE-TAG-BEGIN */');
  const b = src.indexOf('/* INVITE-TAG-END */');
  assert.ok(a > 0 && b > a);
  const api = new Function(src.slice(a, b) + '\nreturn { _inviteTagOf };')();
  const code = 'correct horse battery staple';
  const tag = await api._inviteTagOf(code);
  const expected = nodeCrypto.pbkdf2Sync(code, 'miut-invite-tag-v1', 200000, 6, 'sha256').toString('base64url');
  assert.strictEqual(tag, expected);
  assert.match(tag, /^[A-Za-z0-9_-]{8}$/);
  assert.ok(!code.split(' ').some(w => tag.includes(w)));
  assert.notStrictEqual(await api._inviteTagOf(code + '!'), tag);
});

test('share link uses the hashed tag fragment and the app never puts the code in a url', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'app', 'app.js'), 'utf8');
  assert.ok(src.includes('const url = `${base}#j=${tag}`;'));
  assert.ok(!/#r=\$\{encodeURIComponent\(state\.roomCode\)\}/.test(src));
  assert.ok(src.includes('id="msa-info"') && src.includes("on('msg-info-close-btn'"));
});

function fakeFs(existing) {
  const reads = [];
  const mkRef = (name, id, parent = '') => ({
    path: parent + name + '/' + id,
    async get() { reads.push(this.path); return { exists: existing.has(this.path), path: this.path }; },
    collection(sub) { return { doc: sid => mkRef(sub, sid, this.path + '/') }; }
  });
  return { reads, collection(name) { return { doc: id => mkRef(name, id === undefined ? 'auto' : id) }; } };
}

test('new rooms use the hashed id and cost a single read', async () => {
  const { installRoomIds, roomHashId, resolveRoom } = loadRoomId();
  const code = 'fresh-room-code';
  const fsx = installRoomIds(fakeFs(new Set(['rooms/' + roomHashId(code)])));
  const snap = await fsx.collection('rooms').doc(code).get();
  assert.strictEqual(snap.exists, true);
  assert.strictEqual(fsx.reads.length, 1);
  assert.strictEqual(await resolveRoom(fsx, code), false);
  assert.strictEqual(fsx.collection('rooms').doc(code).path, 'rooms/' + roomHashId(code));
});

test('old rooms stored under the raw code are found and keep working', async () => {
  const { installRoomIds, roomHashId, roomDocId, resolveRoom } = loadRoomId();
  const code = 'old room code 42';
  const fsx = installRoomIds(fakeFs(new Set(['rooms/' + code, 'rooms/' + code + '/members/u1'])));
  assert.strictEqual(fsx.collection('rooms').doc(code).path, 'rooms/' + roomHashId(code));
  const snap = await fsx.collection('rooms').doc(code).get();
  assert.strictEqual(snap.exists, true);
  assert.strictEqual(snap.path, 'rooms/' + code);
  assert.strictEqual(roomDocId(code), code);
  assert.strictEqual(fsx.collection('rooms').doc(code).path, 'rooms/' + code);
  assert.strictEqual(fsx.collection('rooms').doc(code).collection('members').doc('u1').path, 'rooms/' + code + '/members/u1');
  const before = fsx.reads.length;
  await fsx.collection('rooms').doc(code).get();
  assert.strictEqual(fsx.reads.length, before + 1);
  assert.strictEqual(await resolveRoom(fsx, code), true);
});

test('resolveRoom switches an old room to its raw path before any sub-collection read', async () => {
  const { installRoomIds, roomHashId, resolveRoom } = loadRoomId();
  const code = 'legacy-resolve-me';
  const fsx = installRoomIds(fakeFs(new Set(['rooms/' + code])));
  assert.strictEqual(await resolveRoom(fsx, code), true);
  assert.strictEqual(fsx.collection('rooms').doc(code).collection('members').doc('u').path, 'rooms/' + code + '/members/u');
  assert.notStrictEqual(fsx.collection('rooms').doc(code).path, 'rooms/' + roomHashId(code));
});

test('a code that exists nowhere stays on the hashed id and the flag id is always hashed', async () => {
  const { installRoomIds, roomHashId, roomDocId, resolveRoom } = loadRoomId();
  const code = 'nobody-made-this';
  const fsx = installRoomIds(fakeFs(new Set()));
  const snap = await fsx.collection('rooms').doc(code).get();
  assert.strictEqual(snap.exists, false);
  assert.strictEqual(fsx.reads.length, 2);
  assert.strictEqual(await resolveRoom(fsx, code), false);
  assert.strictEqual(roomDocId(code), roomHashId(code));
  const legacyFs = installRoomIds(fakeFs(new Set(['rooms/legacy-flag-code'])));
  await legacyFs.collection('rooms').doc('legacy-flag-code').get();
  assert.strictEqual(roomDocId('legacy-flag-code'), 'legacy-flag-code');
  assert.match(roomHashId('legacy-flag-code'), /^r[A-Za-z0-9_-]{43}$/);
});

test('no ad scripts or ad files remain anywhere', () => {
  const hits = [];
  const walk = d => {
    for (const f of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
      const rel = path.join(d, f.name);
      if (f.isDirectory()) walk(rel);
      else if (/\.(html|js|json|txt|toml)$/.test(f.name) && !rel.includes('moderation-data') && !rel.startsWith('tests')) {
        if (/googlesyndication|adsbygoogle|pagead2|google-adsense|doubleclick/i.test(fs.readFileSync(path.join(root, rel), 'utf8'))) hits.push(rel);
      }
    }
  };
  ['src', 'public', 'functions', 'scripts'].forEach(walk);
  assert.deepStrictEqual(hits, []);
  assert.ok(!fs.existsSync(path.join(root, 'public', 'ads.txt')));
  assert.ok(!fs.readFileSync(path.join(root, 'scripts', 'build.js'), 'utf8').includes('ads.txt'));
});


function loadPresence() {
  const src = fs.readFileSync(path.join(root, 'src', 'app', 'app.js'), 'utf8');
  const a = src.indexOf('/* PRESENCE-BEGIN */');
  const b = src.indexOf('/* PRESENCE-END */');
  assert.ok(a > 0 && b > a);
  return new Function('CONFIG', src.slice(a, b) + '\nreturn { _isLiveMember, _liveDocs, _liveSnap, _hbMillis };')({ PRESENCE_STALE_MS: 300000 });
}

const doc = (id, data) => ({ id, data: () => data });

test('a member with a stuck online flag but an old heartbeat does not count as online', () => {
  const { _isLiveMember, _liveDocs, _liveSnap } = loadPresence();
  const now = Date.now();
  const ts = ms => ({ toMillis: () => ms });
  assert.strictEqual(_isLiveMember({ online: true, lastSeen: ts(now - 60000) }, 'a', 'me', now), true);
  assert.strictEqual(_isLiveMember({ online: true, lastSeen: ts(now - 3600000) }, 'a', 'me', now), false);
  assert.strictEqual(_isLiveMember({ online: true, lastSeen: now - 1000 }, 'a', 'me', now), true);
  assert.strictEqual(_isLiveMember({ online: true }, 'a', 'me', now), false);
  assert.strictEqual(_isLiveMember({ online: false, lastSeen: ts(now) }, 'a', 'me', now), false);
  assert.strictEqual(_isLiveMember({ online: true, lastSeen: ts(now - 9999999) }, 'me', 'me', now), true);
  const snap = { docs: [doc('me', { online: true }), doc('dead', { online: true, lastSeen: ts(now - 7200000) }), doc('live', { online: true, lastSeen: ts(now - 1000) })], docChanges: () => [] };
  const live = _liveDocs(snap, 'me', now);
  assert.deepStrictEqual(live.map(d => d.id), ['me', 'live']);
  const wrapped = _liveSnap(snap, live);
  const seen = [];
  wrapped.forEach(d => seen.push(d.id));
  assert.deepStrictEqual(seen, ['me', 'live']);
  assert.strictEqual(wrapped.size, 2);
});

test('leaving checks fresh presence instead of the cached online count', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'app', 'app.js'), 'utf8');
  assert.ok(src.includes('_liveOthersCount(_leavingRoomCode, _leavingMe.id)'));
  assert.ok(src.includes('const _realOnlineCount = _liveNow.length;'));
  assert.ok(!/_onlineCount = snap\.size/.test(src));
  assert.ok(src.includes('_presenceTimer = setInterval'));
});

let admin;
test.before(async () => {
  const out = esbuild.buildSync({
    entryPoints: [path.join(root, 'functions', '_lib', 'firebase-admin.js')],
    bundle: true, format: 'esm', write: false, platform: 'node', target: 'es2020'
  });
  const f = path.join(os.tmpdir(), 'miut-admin-' + process.pid + '.mjs');
  fs.writeFileSync(f, out.outputFiles[0].text);
  admin = await import('file://' + f);
});

const iso = ms => ({ timestampValue: new Date(ms).toISOString() });
const NAME = c => 'projects/p/databases/(default)/documents/rooms/' + encodeURIComponent(c);

function fakeStore(rooms) {
  const store = new Map(Object.entries(rooms).map(([code, r]) => [code, {
    fields: r.fields,
    subs: { members: (r.members || []).map((m, i) => ({ name: NAME(code) + '/members/m' + i, fields: m })), messages: [{ name: NAME(code) + '/messages/x', fields: {} }], typing: [] }
  }]));
  return {
    store,
    async runQuery(parent, q) {
      const sub = q.from[0].collectionId;
      if (!parent) {
        const codes = [...store.keys()].sort().slice(q.offset || 0, (q.offset || 0) + q.limit);
        return codes.map(c => ({ document: { name: NAME(c), fields: store.get(c).fields } }));
      }
      const code = decodeURIComponent(parent.split('/')[1]);
      const room = store.get(code);
      let rows = room ? room.subs[sub].slice() : [];
      if (q.orderBy && q.orderBy[0].field.fieldPath === 'lastSeen') {
        rows = rows.filter(r => r.fields.lastSeen).sort((a, b) => Date.parse(b.fields.lastSeen.timestampValue) - Date.parse(a.fields.lastSeen.timestampValue));
      }
      return rows.slice(0, q.limit || 300).map(r => ({ document: r }));
    },
    async batchDelete(names) {
      for (const n of names) {
        const code = decodeURIComponent(n.split('/rooms/')[1].split('/')[0]);
        const room = store.get(code);
        if (!room) continue;
        for (const k of Object.keys(room.subs)) room.subs[k] = room.subs[k].filter(r => r.name !== n);
      }
    },
    async deleteDoc(pathStr) { store.delete(decodeURIComponent(pathStr.split('/')[1])); }
  };
}

test('abandoned rooms are wiped by heartbeat age, never by the stuck online flag', async () => {
  const now = Date.now();
  const H = 3600000;
  const rooms = {
    'a-never': { fields: { inactivityTtlMs: { integerValue: '-1' }, createdAt: iso(now - 240 * H) }, members: [{ online: { booleanValue: true }, lastSeen: iso(now - 200 * H) }] },
    'b-recent': { fields: { inactivityTtlMs: { integerValue: '300000' }, createdAt: iso(now - 5 * H) }, members: [{ online: { booleanValue: true }, lastSeen: iso(now - 600000) }] },
    'c-stuck-flag': { fields: { inactivityTtlMs: { integerValue: '300000' }, createdAt: iso(now - 30 * H) }, members: [{ online: { booleanValue: true }, lastSeen: iso(now - 2 * H) }, { online: { booleanValue: false }, lastSeen: iso(now - 5 * H) }] },
    'd-instant': { fields: { inactivityTtlMs: { integerValue: '0' }, createdAt: iso(now - 10 * H) }, members: [{ online: { booleanValue: true }, lastSeen: iso(now - 40 * 60000) }] },
    'e-scheduled': { fields: { inactivityTtlMs: { integerValue: '300000' }, autoDeleteAt: iso(now + H), createdAt: iso(now - 30 * H) }, members: [{ online: { booleanValue: true }, lastSeen: iso(now - 20 * H) }] },
    'f-empty-old': { fields: { inactivityTtlMs: { integerValue: '300000' }, createdAt: iso(now - 3 * H) }, members: [] },
  };
  const client = fakeStore(rooms);
  const res = await admin.sweepAbandonedRooms(client, new admin.Budget(200), 0);
  assert.deepStrictEqual([...client.store.keys()].sort(), ['a-never', 'b-recent', 'e-scheduled']);
  assert.strictEqual(res.wiped, 3);
  assert.strictEqual(res.more, true);
  assert.strictEqual(res.nextCursor, res.processed - res.wiped);
});

test('abandoned sweep resumes from its cursor, respects the budget and wraps around', async () => {
  const now = Date.now();
  const fresh = { fields: { inactivityTtlMs: { integerValue: '300000' }, createdAt: iso(now - 60000) }, members: [{ online: { booleanValue: true }, lastSeen: iso(now - 30000) }] };
  const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['room-' + i, fresh]));
  const client = fakeStore(many);
  const first = await admin.sweepAbandonedRooms(client, new admin.Budget(200), 0);
  assert.strictEqual(first.wiped, 0);
  assert.strictEqual(first.nextCursor, 6);
  const second = await admin.sweepAbandonedRooms(client, new admin.Budget(200), first.nextCursor);
  assert.strictEqual(second.processed, 2);
  assert.strictEqual(second.more, false);
  assert.strictEqual(second.nextCursor, 0);
  const starved = await admin.sweepAbandonedRooms(client, new admin.Budget(0), 0).catch(e => e);
  assert.ok(starved instanceof Error || starved.more === true);
});

test('abandonedVerdict covers the edge cases', () => {
  const now = Date.now();
  const H = 3600000;
  assert.strictEqual(admin.abandonedVerdict({ inactivityTtlMs: { integerValue: '-1' } }, now - 99 * H, now), 'keep');
  assert.strictEqual(admin.abandonedVerdict({}, now - 5 * H, now), 'wipe');
  assert.strictEqual(admin.abandonedVerdict({ createdAt: iso(now - 20 * 60000) }, 0, now), 'keep');
  assert.strictEqual(admin.abandonedVerdict({ inactivityTtlMs: { integerValue: '86400000' }, createdAt: iso(now - 10 * H) }, now - 10 * H, now), 'keep');
  assert.strictEqual(admin.abandonedVerdict({ inactivityTtlMs: { integerValue: '86400000' }, createdAt: iso(now - 30 * H) }, now - 30 * H, now), 'wipe');
  assert.strictEqual(admin.abandonedVerdict({ autoDeleteAt: iso(now + H), createdAt: iso(now - 99 * H) }, 0, now), 'keep');
});
