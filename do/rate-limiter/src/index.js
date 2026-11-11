const MAX_TRACKED_ACTIONS = 128;

function evictOldest(map) {
  if (map.size <= MAX_TRACKED_ACTIONS) return;
  let oldestKey = null;
  let oldestAt = Infinity;
  for (const [key, value] of map) {
    const at = value.at ?? value.windowStart;
    if (at < oldestAt) { oldestAt = at; oldestKey = key; }
  }
  if (oldestKey !== null) map.delete(oldestKey);
}

export class RateLimiter {
  constructor() {
    this.windows = new Map();
    this.buckets = new Map();
  }

  async fetch(request) {
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
    }

    let body;
    try { body = await request.json(); }
    catch { return new Response(JSON.stringify({ error: 'bad_request' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }

    const { mode, action } = body || {};
    if (typeof action !== 'string' || !action) {
      return new Response(JSON.stringify({ error: 'bad_params' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    return mode === 'bucket' ? this._bucket(action, body) : this._window(action, body);
  }

  _window(action, { maxCount, windowMs }) {
    if (!(maxCount > 0) || !(windowMs > 0)) {
      return new Response(JSON.stringify({ error: 'bad_params' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const now = Date.now();
    let w = this.windows.get(action);
    if (!w || now - w.windowStart >= windowMs) w = { count: 0, windowStart: now };
    w.count++;
    this.windows.set(action, w);
    evictOldest(this.windows);

    const allowed = w.count <= maxCount;
    const retryAfter = allowed ? 0 : Math.max(1, Math.ceil((w.windowStart + windowMs - now) / 1000));
    return new Response(JSON.stringify({ allowed, count: w.count, retryAfter }), { headers: { 'Content-Type': 'application/json' } });
  }

  _bucket(action, { burst, perMin }) {
    if (!(burst > 0) || !(perMin > 0)) {
      return new Response(JSON.stringify({ error: 'bad_params' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const now = Date.now();
    const rate = perMin / 60000;
    let b = this.buckets.get(action);
    if (b) { b.t = Math.min(burst, b.t + (now - b.at) * rate); b.at = now; }
    else { b = { t: burst, at: now }; }

    let wait = 0;
    if (b.t >= 1) b.t -= 1;
    else wait = Math.max(1, Math.ceil((1 - b.t) / rate / 1000));
    this.buckets.set(action, b);
    evictOldest(this.buckets);

    return new Response(JSON.stringify({ allowed: wait === 0, wait }), { headers: { 'Content-Type': 'application/json' } });
  }
}

export default {
  async fetch() {
    return new Response('miut-rate-limiter-do: POST a Durable Object stub request, see functions/api/rate-limit.js and functions/_middleware.js', { status: 200 });
  },
};
