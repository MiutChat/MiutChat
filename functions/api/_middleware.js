/**
 * functions/_middleware.js — Cloudflare Pages Middleware
 *
 * ADMIN BYPASS (works during maintenance):
 *   https://miutchat.pages.dev/access?key=YOUR_ADMIN_ACCESS
 *   → Sets cookie miut_admin=1 (1hr) → Redirects to /
 *
 * MAINTENANCE TOGGLE:
 *   POST /api/maintenance {"enabled":true}  Authorization: Bearer ADMIN_ACCESS
 */

const BYPASS_PATHS    = ['/maintenance.html','/404.html','/manifest.json','/robots.txt','/sitemap.xml','/security.txt'];
const BYPASS_PREFIXES = ['/api/','/icons/'];
const BYPASS_EXT      = /\.(png|ico|svg|jpg|jpeg|webp|webmanifest|txt|xml|gz|br|woff2?|css|js|map)$/i;
const CRAWLER_UA      = /googlebot|bingbot|yandexbot|duckduckbot|slurp|baiduspider|facebot|ia_archiver/i;
const COOKIE_NAME     = 'miut_admin';
const COOKIE_MAX      = 3600;

function getCookie(req, name) {
  const h = req.headers.get('Cookie') || '';
  const m = h.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return m ? m.slice(name.length + 1) : null;
}

async function timingSafeEq(a, b) {
  if (!a || !b) return false;
  const key = await crypto.subtle.generateKey({ name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  const enc = new TextEncoder();
  const [sa, sb] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(a)),
    crypto.subtle.sign('HMAC', key, enc.encode(b)),
  ]);
  const va = new Uint8Array(sa), vb = new Uint8Array(sb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

const MAINTENANCE_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Maintenance — MiutChat</title><meta name="robots" content="noindex,nofollow"/><meta http-equiv="refresh" content="60"/><meta name="theme-color" content="#050d0c"/><style>:root{--t:#4ecdc4;--bg:#050d0c;--bdr:rgba(78,205,196,.12);--tb:rgba(78,205,196,.17);--tdim:rgba(78,205,196,.08);--tx:#cdeae7;--tx2:#4e7a77}*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}html,body{height:100%;background:var(--bg);color:var(--tx);font-family:'Space Mono',monospace;-webkit-font-smoothing:antialiased}body{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:40px 6%;text-align:center;position:relative}.bg{position:absolute;inset:0;background:radial-gradient(ellipse 55% 50% at 50% 50%,rgba(78,205,196,.07) 0%,transparent 65%);pointer-events:none}.card{position:relative;z-index:1;max-width:480px;padding:48px 40px;background:rgba(12,22,21,.92);border:1px solid var(--bdr);border-radius:24px}.icon{width:64px;height:64px;border-radius:18px;background:var(--tdim);border:1px solid var(--tb);display:flex;align-items:center;justify-content:center;margin:0 auto 24px}@keyframes spin{to{transform:rotate(360deg)}}.ring{width:36px;height:36px;border:2px solid rgba(78,205,196,.15);border-top-color:var(--t);border-radius:50%;animation:spin 1.2s linear infinite}.label{font-size:.55rem;font-weight:700;letter-spacing:5px;color:var(--t);margin-bottom:14px}h1{font-size:1.5rem;font-weight:700;color:#fff;margin-bottom:12px}p{font-size:.76rem;color:var(--tx2);line-height:1.85;margin-bottom:20px}.badge{display:inline-flex;align-items:center;gap:7px;padding:6px 14px;background:var(--tdim);border:1px solid var(--tb);border-radius:100px;font-size:.58rem;letter-spacing:2px;color:var(--t)}@keyframes pd{0%,100%{opacity:1}50%{opacity:.35}}.pulse{width:6px;height:6px;border-radius:50%;background:var(--t);animation:pd 1.6s ease-in-out infinite}#cd{color:var(--t);font-weight:700}</style></head><body><div class="bg"></div><div class="card"><div class="icon"><div class="ring"></div></div><div class="label">MAINTENANCE</div><h1>We'll be back soon.</h1><p>MiutChat is undergoing scheduled maintenance. No data is lost.</p><div class="badge"><span class="pulse"></span>WORKING ON IT</div><p style="font-size:.65rem;margin-top:16px;margin-bottom:0">Refreshes in <span id="cd">60</span>s</p></div><script>var t=60,e=document.getElementById('cd');setInterval(function(){t--;e&&(e.textContent=t);t<=0&&location.reload()},1000);</script></body></html>`;

export async function onRequest(ctx) {
  const { request, env, next } = ctx;
  const url  = new URL(request.url);
  const path = url.pathname;

  // ══════════════════════════════════════════════════════════
  // /vault and /vault.html — BLOCK direct URL access
  // Vault is only accessible by entering VAULT_PASSKEY in the app
  // ══════════════════════════════════════════════════════════
  if (path === '/vault' || path === '/vault.html' || path === '/vault/') {
    return new Response(null, {
      status: 302,
      headers: { 'Location': '/', 'Cache-Control': 'no-store' },
    });
  }

  // ══════════════════════════════════════════════════════════
  // /access?key=ADMIN_ACCESS — MUST be FIRST before anything
  // Sets bypass cookie and redirects to /
  // Works even during maintenance
  // ══════════════════════════════════════════════════════════
  if (path === '/access') {
    const key    = url.searchParams.get('key') || '';
    const secret = env?.ADMIN_ACCESS || '';

    if (!secret) {
      return new Response('ADMIN_ACCESS env var not set.', { status: 500 });
    }

    const valid = await timingSafeEq(key, secret);

    if (!valid) {
      return new Response(
        '<!DOCTYPE html><html><head><meta name="robots" content="noindex"/><title>401</title></head><body style="font-family:monospace;background:#050d0c;color:#ff5f5f;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center"><div><div style="font-size:3rem;margin-bottom:8px">401</div><div style="color:#4e7a77;font-size:.8rem">Invalid key</div></div></body></html>',
        { status: 401, headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' } }
      );
    }

    // Valid — set 1hr bypass cookie and redirect to /
    return new Response(null, {
      status: 302,
      headers: {
        'Location': '/',
        'Set-Cookie': `${COOKIE_NAME}=1; Path=/; Max-Age=${COOKIE_MAX}; HttpOnly; Secure; SameSite=Strict`,
        'Cache-Control': 'no-store',
      },
    });
  }

  // ══════════════════════════════════════════════════════════
  // Static assets + crawlers — always pass through
  // ══════════════════════════════════════════════════════════
  const isExempt =
    BYPASS_PATHS.includes(path) ||
    BYPASS_PREFIXES.some(p => path.startsWith(p)) ||
    BYPASS_EXT.test(path) ||
    CRAWLER_UA.test(request.headers.get('User-Agent') || '');

  if (isExempt) return next();

  // ══════════════════════════════════════════════════════════
  // Admin bypass cookie — skip maintenance check
  // ══════════════════════════════════════════════════════════
  if (getCookie(request, COOKIE_NAME) === '1') return next();

  // ══════════════════════════════════════════════════════════
  // Maintenance mode KV check
  // ══════════════════════════════════════════════════════════
  if (env?.MIUT_KV) {
    try {
      const mode = await env.MIUT_KV.get('maintenance_mode');
      if (mode === 'true') {
        return new Response(MAINTENANCE_HTML, {
          status: 503,
          headers: {
            'Content-Type': 'text/html;charset=UTF-8',
            'Retry-After': '60',
            'Cache-Control': 'no-store, no-cache',
            'X-Robots-Tag': 'noindex',
          },
        });
      }
    } catch { /* KV down — fail open */ }
  }

  return next();
}
