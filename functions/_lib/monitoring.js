/**
 * functions/_lib/monitoring.js
 *
 * READ-ONLY. Fetches each shard's EXACT today-so-far Firestore read, write and
 * delete counts from the Cloud Monitoring API — the same data source
 * Firebase's own Usage tab is built from, not an estimate or a proxy.
 *
 * This module changes NOTHING about how the app behaves. It only writes
 * three new, previously-nonexistent fields (readsToday/writesToday/
 * deletesToday) plus a timestamp into shardLoad/{name}. Nothing in
 * shard-registry.js's resolve() reads these fields, so room placement is
 * completely unaffected — this is purely visibility, for now.
 *
 * SETUP (per shard project, cannot be done from code):
 *   1. Cloud Monitoring API enabled (usually on by default with Firebase).
 *   2. Grant the shard's existing service account (the same one already used
 *      for cleanup/wipes — its email is in that shard's FIREBASE_*_SA_JSON)
 *      the "Monitor Viewer" role (roles/monitoring.viewer) in that project's
 *      IAM & Admin console. No new key, no new credential.
 * Until that grant exists on a given shard, calls here fail with 403 and
 * that shard's exact fields simply stay null — handled, never thrown.
 *
 * DEBUGGING: when a shard's metrics cannot be read, the returned object also
 * carries `diagnostic` ({ status, reason, message, hint, ... }) naming the
 * exact cause. It is returned by /api/cleanup, never written to Firestore.
 *
 * COST: free in practice at this app's scale. Cloud Monitoring's Read API
 * has a free allotment of 1,000,000 "time series returned" per month per
 * billing account; beyond that it's $0.50/million. 3 metrics x a handful of
 * shards x 4 calls/hour (riding the existing 15-min cleanup cron) is on the
 * order of tens of thousands a month — comfortably inside the free tier.
 * Write API calls (not used here) are free outright. (Verified against
 * Google's current pricing page, not assumed — prices can change; worth a
 * glance at cloud.google.com/monitoring/pricing if this is ever revisited.)
 */

'use strict';

const METRICS = {
  readsToday:   'firestore.googleapis.com/document/read_count',
  writesToday:  'firestore.googleapis.com/document/write_count',
  deletesToday: 'firestore.googleapis.com/document/delete_count',
};

const FATAL_STATUSES = new Set([401, 403, 404]);

/**
 * Start of "today" in US Pacific time, as an ISO instant — matches
 * Firestore's own daily free-quota reset boundary. Correct across DST: the
 * Pacific UTC offset is either -7 (PDT) or -8 (PST), so both candidate
 * instants for "00:00 Pacific on today's date" are tried, and whichever one
 * actually reads back as 00:00 on that date IN Pacific time is the answer —
 * no hardcoded DST transition dates to keep up to date.
 */
function pacificMidnightISO(now = new Date()) {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const [y, m, d] = ymd.split('-').map(Number);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  for (const utcOffsetHours of [7, 8]) {               // PDT then PST
    const candidate = Date.UTC(y, m - 1, d, utcOffsetHours, 0, 0);
    const parts = Object.fromEntries(fmt.formatToParts(new Date(candidate)).map(p => [p.type, p.value]));
    if (parts.hour === '00' && Number(parts.day) === d) return new Date(candidate).toISOString();
  }
  // Should be unreachable (one of the two offsets always matches) — fail
  // safe to UTC midnight rather than throw, since a slightly-off window is
  // harmless for a usage number, never used for anything that gates access.
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0)).toISOString();
}

function parseGoogleError(text) {
  let body = null;
  try { body = JSON.parse(text); } catch {}
  const err = body && body.error ? body.error : null;
  const details = err && Array.isArray(err.details) ? err.details : [];
  const info = details.find(d => d && d.reason) || {};
  const meta = info.metadata || {};
  return {
    googleStatus: err && err.status ? err.status : null,
    reason: info.reason || null,
    service: meta.service || null,
    activationUrl: meta.activationUrl || null,
    message: String((err && err.message) || text || '').slice(0, 300),
  };
}

async function readTokenInfo(token, fetchImpl) {
  try {
    const res = await fetchImpl('https://oauth2.googleapis.com/tokeninfo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'access_token=' + encodeURIComponent(token),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return { email: j.email || null, scope: String(j.scope || '') };
  } catch { return null; }
}

function buildHint(failure, projectId, saEmail, tokenInfo) {
  const { status, info } = failure;
  const who = saEmail || 'the shard service account';
  const apiUrl = info.activationUrl || `https://console.cloud.google.com/apis/library/monitoring.googleapis.com?project=${projectId}`;
  if (info.reason === 'SERVICE_DISABLED' || /has not been used|is disabled/i.test(info.message)) {
    return `Cloud Monitoring API is disabled on ${projectId}. Enable it: ${apiUrl}`;
  }
  if (info.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' || /insufficient authentication scopes/i.test(info.message)) {
    return 'Access token is missing the monitoring.read scope.';
  }
  if (tokenInfo && tokenInfo.scope && !/monitoring/.test(tokenInfo.scope)) {
    return `Token for ${who} has no monitoring scope (scopes: ${tokenInfo.scope}).`;
  }
  if (status === 403) {
    return `API and scope look fine, so ${who} lacks permission monitoring.timeSeries.list on ${projectId}. Grant it roles/monitoring.viewer on THAT project.`;
  }
  if (status === 401) return 'Token rejected (401): the service-account key may be revoked, deleted or malformed.';
  if (status === 404) return `Monitoring cannot find project ${projectId}: check project_id inside the service-account secret.`;
  if (status === 429) return 'Monitoring API rate-limited this call. Retry later.';
  return `Unexpected response ${status} from Cloud Monitoring.`;
}

async function fetchMetricTotal(projectId, token, metricType, since, fetchImpl) {
  const now = new Date();
  const windowSeconds = Math.max(60, Math.floor((now - new Date(since)) / 1000));
  const url = `https://monitoring.googleapis.com/v3/projects/${projectId}/timeSeries?` + new URLSearchParams({
    filter: `metric.type="${metricType}"`,
    'interval.startTime': since,
    'interval.endTime': now.toISOString(),
    'aggregation.alignmentPeriod': `${windowSeconds}s`,
    'aggregation.perSeriesAligner': 'ALIGN_SUM',
    'aggregation.crossSeriesReducer': 'REDUCE_SUM',
    view: 'FULL',
  });
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    let text = '';
    try { text = await res.text(); } catch {}
    return { ok: false, status: res.status, info: parseGoogleError(text) };
  }
  const body = await res.json();
  const points = body.timeSeries?.[0]?.points || [];
  let total = 0;
  for (const p of points) total += Number(p.value?.int64Value ?? p.value?.doubleValue ?? 0);
  return { ok: true, total, series: (body.timeSeries || []).length };
}

/** Exact read/write/delete totals for one shard, since Pacific midnight. Never throws. */
export async function fetchShardUsage(projectId, token, fetchImpl = fetch, saEmail = null) {
  const since = pacificMidnightISO();
  const out = { metricsAsOf: new Date().toISOString() };
  let anyGranted = false, anyDenied = false, failure = null;
  for (const [field, metricType] of Object.entries(METRICS)) {
    if (failure && FATAL_STATUSES.has(failure.status)) { out[field] = null; continue; }
    try {
      const r = await fetchMetricTotal(projectId, token, metricType, since, fetchImpl);
      if (r.ok) { out[field] = r.total; anyGranted = true; }
      else {
        out[field] = null;
        if (r.status === 403) anyDenied = true;
        if (!failure) failure = { ...r, metric: metricType };
      }
    } catch (e) {
      out[field] = null;
      if (!failure) failure = { ok: false, status: 0, metric: metricType, info: { googleStatus: null, reason: 'NETWORK_ERROR', service: null, activationUrl: null, message: String(e && e.message || e).slice(0, 300) } };
    }
  }
  out.monitoringGranted = anyGranted;
  out.monitoringDenied = anyDenied && !anyGranted;
  if (failure && !anyGranted) {
    const tokenInfo = failure.status === 403 || failure.status === 401 ? await readTokenInfo(token, fetchImpl) : null;
    out.diagnostic = {
      projectId,
      serviceAccount: saEmail,
      metric: failure.metric,
      status: failure.status,
      googleStatus: failure.info.googleStatus,
      reason: failure.info.reason,
      message: failure.info.message,
      tokenEmail: tokenInfo ? tokenInfo.email : null,
      tokenScopes: tokenInfo ? tokenInfo.scope : null,
      hint: buildHint(failure, projectId, saEmail, tokenInfo),
    };
  }
  return out;
}

/**
 * Writes only {readsToday, writesToday, deletesToday, metricsAsOf,
 * monitoringGranted, monitoringDenied} into shardLoad/{name} via a field
 * mask — every other field already on that document (count, degradedUntil,
 * anything else written there now or later) is left completely untouched.
 * Uses the registry's own service account (same one analytics-store.js
 * uses), via Firestore's REST :commit, independent of any Firestore client
 * SDK. Auto-creates the document if it doesn't exist yet, same as every
 * other partial-update helper in this codebase.
 */
export async function writeShardUsageToRegistry(reg, shardName, usage, fetchImpl = fetch) {
  const { getAccessTokenCached } = await import('./firebase-admin.js');
  const token = await getAccessTokenCached(reg.sa, fetchImpl);
  const root = `projects/${reg.projectId}/databases/(default)/documents`;
  const enc = v => v === null ? { nullValue: null }
    : typeof v === 'boolean' ? { booleanValue: v }
    : typeof v === 'number' ? { integerValue: String(Math.round(v)) }
    : { timestampValue: v };
  const fields = {
    readsToday: enc(usage.readsToday), writesToday: enc(usage.writesToday), deletesToday: enc(usage.deletesToday),
    metricsAsOf: enc(usage.metricsAsOf), monitoringGranted: enc(usage.monitoringGranted), monitoringDenied: enc(usage.monitoringDenied),
  };
  const res = await fetchImpl(`https://firestore.googleapis.com/v1/${root}:commit`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes: [{
      update: { name: `${root}/shardLoad/${shardName}`, fields },
      updateMask: { fieldPaths: Object.keys(fields) },
    }] }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch {}
    throw new Error('registry write ' + res.status + (detail ? ': ' + detail : ''));
  }
}
