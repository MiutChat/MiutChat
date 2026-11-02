'use strict';

// Decides whether a screen swap should go through the native View
// Transitions API (a smooth native cross-fade/morph between the old and
// new screen, with zero extra animation code) or fall back to the app's
// existing hand-built morph-exit CSS animation.
//
// Two independent reasons to say no:
//  - the API isn't there (startViewTransition undefined) — most non-
//    Chromium browsers as of this writing.
//  - the user has asked for reduced motion — View Transitions' automatic
//    cross-fade is itself motion, so it's skipped exactly like every
//    other animation in this app already is (see the global
//    prefers-reduced-motion rule in style.css, which only covers normal
//    elements — it can't reach the ::view-transition-* pseudo-elements,
//    so this check is what actually keeps those off for such users).
//
// `doc` and `media` are injected (not read from globals) so this stays
// unit-testable without a real DOM — same reasoning as media-swap.js.
(function (global) {
  function shouldUseViewTransition(doc, media) {
    if (typeof doc?.startViewTransition !== 'function') return false;
    if (media?.matches) return false;
    return true;
  }

  // Applies the actual screen swap. `legacy` runs the existing morph-exit/
  // active class choreography (unchanged app behavior); the non-legacy
  // path does an instant class swap, because the fade/morph itself is
  // then handled natively by the browser's view transition — animating
  // it again here would just double up on top of that.
  function applyScreenSwitch(doc, id, next, activeScreens, legacy) {
    if (legacy) {
      activeScreens.forEach(function (s) {
        if (s.id === id) return;
        s.classList.add('morph-exit');
        s.classList.remove('active');
        setTimeout(function () { s.classList.remove('morph-exit'); }, 350);
      });
      requestAnimationFrame(function () {
        next.classList.add('active');
        next.querySelectorAll('.nx-anim').forEach(function (el) {
          el.style.animation = 'none';
          el.style.opacity   = '';
          requestAnimationFrame(function () { el.style.animation = ''; });
        });
      });
      return;
    }
    activeScreens.forEach(function (s) { if (s.id !== id) s.classList.remove('active'); });
    next.classList.add('active');
    next.querySelectorAll('.nx-anim').forEach(function (el) { el.style.opacity = ''; el.style.animation = ''; });
  }

  var api = { shouldUseViewTransition: shouldUseViewTransition, applyScreenSwitch: applyScreenSwitch };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.MiutScreenTransition = api;
})(typeof window !== 'undefined' ? window : globalThis);
