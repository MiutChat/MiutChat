/* Miut · placeholder-rotator.js
   Cycles the placeholder text on inputs that have data-placeholders set.
   Extracted from inline script to comply with CSP script-src 'self'. */

(function () {
  'use strict';

  function startRotatingPlaceholder(input) {
    const list = JSON.parse(input.dataset.placeholders || '[]');
    if (!list.length) return;
    let idx = 0;

    function rotate() {
      if (document.activeElement === input || input.value) return;
      input.classList.add('ph-fade');
      setTimeout(function () {
        idx = (idx + 1) % list.length;
        input.placeholder = list[idx];
        input.classList.remove('ph-fade');
      }, 400);
    }

    setInterval(rotate, 2200);
  }

  function init() {
    document.querySelectorAll('[data-placeholders]').forEach(startRotatingPlaceholder);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
