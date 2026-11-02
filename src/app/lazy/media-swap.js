'use strict';

// Swaps a decrypted <img> into its placeholder only once the image has
// actually loaded — never the instant img.src is set.
//
// Why: .msg-media.loading carries the placeholder's fixed width/height
// (see style.css). Stripping that class before the image has decoded
// collapses the box to zero height, then snaps it to the image's natural
// size the moment it paints — a layout shift (CLS) on every single image
// message, every time. Waiting for 'load' before touching the DOM keeps
// the placeholder's box in place across the swap, so nothing around it
// jumps.
//
// Deliberately has zero imports — this stays unit-testable in plain Node
// without a DOM.
export function wireImageSwap(img, el, hint) {
  const swapIn = () => {
    el.innerHTML = '';
    el.appendChild(img);
    el.appendChild(hint);
    el.classList.remove('loading');
  };
  img.addEventListener('load', swapIn, { once: true });
  return swapIn;
}
