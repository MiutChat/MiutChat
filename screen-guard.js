'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   screen-guard.js  v2.0  — Production Anti-Screenshot / Anti-Recording
   ═══════════════════════════════════════════════════════════════════════════ */
window.ScreenGuard = (function () {
  const Z = '2147483647';
  const BLUR_MS      = 5000;
  const HIDDEN_MS    = 0;
  const UNBLUR_DELAY = 650;
  const DEVTOOLS_THR = 160;
  const WM_MS        = 1500;
  const WEAK_WIN     = 1200;
  const WEAK_N       = 2;
  const KILL_CLS     = '__sg_kill';

  let _active = true, _blurred = false, _username = '';
  let _unblurT = null, _autoT = null, _wmT = null, _reapplyT = null;
  let _weakN = 0, _weakTs = 0, _maxTouch = 0, _lastBlurTs = 0;
  let _lastFrame = 0, _rafOn = false;

  /* ── DOM: inject synchronously ─────────────────────────────────────────── */
  const _ov  = document.createElement('div');
  const _wm  = document.createElement('div');
  const _sty = document.createElement('style');

  _ov.id = '__sg_ov';
  _ov.setAttribute('aria-hidden', 'true');
  _wm.id = '__sg_wm';
  _sty.id = '__sg_sty';

  function _ovStyle(active) {
    _ov.style.cssText = 'position:fixed;inset:0;z-index:' + Z +
      ';opacity:' + (active ? '1' : '0') +
      ';pointer-events:' + (active ? 'all' : 'none') +
      ';background:rgba(5,13,12,.97);transition:' +
      (active ? 'none' : 'opacity 260ms ease') + ';contain:strict;will-change:opacity';
  }
  _ovStyle(false);

  _wm.style.cssText = 'position:fixed;inset:-40%;z-index:' + (Z - 1) +
    ';pointer-events:none;user-select:none;-webkit-user-select:none' +
    ';transform:rotate(-22deg);display:grid;grid-template-columns:repeat(5,1fr)' +
    ';opacity:.055;will-change:transform';

  _sty.textContent =
    '.' + KILL_CLS + ',.' + KILL_CLS + ' *{' +
      'filter:blur(24px) brightness(.04)!important;' +
      'pointer-events:none!important;user-select:none!important;' +
      '-webkit-user-select:none!important}' +
    '#__sg_ov.__sg_on{opacity:1!important;pointer-events:all!important}';

  const _root = document.body || document.documentElement;
  _root.appendChild(_ov);
  _root.appendChild(_wm);
  (document.head || document.documentElement).appendChild(_sty);

  /* ── Blur / Unblur ─────────────────────────────────────────────────────── */
  function _blur(why, ms) {
    if (!_active) return;
    _blurred = true;
    document.documentElement.classList.add(KILL_CLS);
    _ovStyle(true);
    _ov.classList.add('__sg_on');
    if (_autoT)   { clearTimeout(_autoT);   _autoT   = null; }
    if (_unblurT) { clearTimeout(_unblurT); _unblurT = null; }
    const t = ms === undefined ? BLUR_MS : ms;
    if (t > 0) _autoT = setTimeout(() => _unblur('auto'), t);
    document.dispatchEvent(new CustomEvent('sg:blur', { detail: why }));
  }

  function _unblur(why) {
    if (!_blurred) return;
    _blurred = false;
    document.documentElement.classList.remove(KILL_CLS);
    _ovStyle(false);
    _ov.classList.remove('__sg_on');
    if (_autoT)   { clearTimeout(_autoT);   _autoT   = null; }
    if (_unblurT) { clearTimeout(_unblurT); _unblurT = null; }
    document.dispatchEvent(new CustomEvent('sg:unblur', { detail: why }));
  }

  function _sched(ms) {
    if (_unblurT) clearTimeout(_unblurT);
    _unblurT = setTimeout(() => _unblur('sched'), ms);
  }

  function _sig(s) {
    if (!_active) return;
    if (s === 'S') { _blur('strong'); return; }
    const n = Date.now();
    if (n - _weakTs > WEAK_WIN) _weakN = 0;
    _weakTs = n;
    if (++_weakN >= WEAK_N) { _weakN = 0; _blur('weak'); }
  }

  /* ── Watermark ─────────────────────────────────────────────────────────── */
  let _cells = null;
  function _buildWm() {
    const f = document.createDocumentFragment();
    _cells = Array.from({ length: 60 }, (_, i) => {
      const c = document.createElement('div');
      c.style.cssText = 'display:flex;align-items:center;justify-content:center' +
        ';padding:26px 0;font:9px/1.3 monospace;color:#4ecdc4;white-space:nowrap';
      f.appendChild(c);
      return c;
    });
    _wm.appendChild(f);
  }

  function _refreshWm() {
    if (!_cells) _buildWm();
    const ts   = new Date().toLocaleTimeString('en-US', { hour12: false });
    const line = (_username || 'ANONYMOUS') + ' \u00b7 ' + ts;
    _cells.forEach((c, i) => { c.textContent = i % 2 ? '\u00b7 \u00b7 \u00b7' : line; });
    _wmT = setTimeout(_refreshWm, WM_MS);
  }

  /* ── MutationObserver — prevent removal / override ─────────────────────── */
  new MutationObserver(ms => {
    for (const m of ms) {
      for (const n of m.removedNodes) {
        if (n === _ov)  { _root.appendChild(_ov); }
        if (n === _wm)  { _root.appendChild(_wm); }
        if (n === _sty) { (document.head || document.documentElement).appendChild(_sty); }
      }
      if (m.type === 'attributes' && m.target === _ov && _blurred) {
        _ovStyle(true); _ov.classList.add('__sg_on');
      }
    }
  }).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['style', 'class'],
  });

  /* Style reapply loop */
  ;(function _loop() {
    if (_blurred && !document.documentElement.classList.contains(KILL_CLS))
      document.documentElement.classList.add(KILL_CLS);
    _reapplyT = setTimeout(_loop, 800);
  })();

  /* ── Signals ───────────────────────────────────────────────────────────── */
  /* 1. Multi-touch */
  document.addEventListener('touchstart', e => {
    const n = e.touches.length;
    if (n > _maxTouch) _maxTouch = n;
    if (n >= 3) _sig('S');
  }, { passive: true, capture: true });

  document.addEventListener('touchmove', e => {
    if (e.touches.length >= 3 && !_blurred) _sig('S');
  }, { passive: true, capture: true });

  document.addEventListener('touchend', e => {
    if (!e.touches.length) _maxTouch = 0;
  }, { passive: true });

  /* 2. Visibility */
  document.addEventListener('visibilitychange', () => {
    document.visibilityState === 'hidden' ? _blur('hidden', HIDDEN_MS) : _sched(UNBLUR_DELAY);
  });

  /* 3. Blur/focus timing */
  window.addEventListener('blur', () => {
    const now = Date.now(), d = now - _lastBlurTs;
    _lastBlurTs = now;
    _sig(d > 0 && d < 150 ? 'S' : 'W');
  });
  window.addEventListener('focus', () => _sched(UNBLUR_DELAY));

  /* 4. Keyboard */
  window.addEventListener('keydown', e => {
    const k = (e.key || '').toLowerCase();
    if (k === 'printscreen' || k === 'sysrq' ||
        (e.metaKey && e.shiftKey && '345s'.includes(k)) ||
        (e.ctrlKey && k === 'printscreen')) _sig('S');
  }, { capture: true });

  /* 5. DevTools */
  setInterval(() => {
    const wd = window.outerWidth - window.innerWidth;
    const hd = window.outerHeight - window.innerHeight;
    if (wd > DEVTOOLS_THR || hd > DEVTOOLS_THR) _sig('S');
  }, 2000);

  /* 6. Device change */
  try { navigator.mediaDevices?.addEventListener('devicechange', () => _sig('W')); } catch {}

  /* 7. rAF frame-drop */
  function _raf(ts) {
    if (!_rafOn) return;
    const g = ts - _lastFrame; _lastFrame = ts;
    if (g > 800 && document.visibilityState === 'visible' && !_blurred) _sig('W');
    requestAnimationFrame(_raf);
  }
  function _startRaf() {
    if (_rafOn) return; _rafOn = true;
    _lastFrame = performance.now(); requestAnimationFrame(_raf);
  }
  if (document.visibilityState === 'visible') _startRaf();

  /* ── Auto re-enable guard ─────────────────────────────────────────────── */
  setInterval(() => {
    if (!document.getElementById('__sg_sty'))
      (document.head || document.documentElement).appendChild(_sty);
  }, 4000);

  /* ── Init ─────────────────────────────────────────────────────────────── */
  const _init = () => {
    if (!document.body.contains(_ov))  document.body.appendChild(_ov);
    if (!document.body.contains(_wm))  document.body.appendChild(_wm);
    _refreshWm();
  };
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', _init, { once: true })
    : _init();

  /* ── API ──────────────────────────────────────────────────────────────── */
  return {
    blur:      (ms) => _blur('api', ms),
    unblur:    ()   => _unblur('api'),
    enable:    ()   => { _active = true; },
    disable:   ()   => { _active = false; _unblur('off'); },
    isActive:  ()   => _active,
    isBlurred: ()   => _blurred,
    setUser:   (u)  => { _username = (u || '').toUpperCase(); },
  };
})();
