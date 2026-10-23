'use strict';

import { db, toast, _log, APP_VERSION, $ } from '../app.js';

let _fbRating = 0;
const _fbTags = new Set();

function _fbResolveEls() {
  return {
    overlay:   $('feedback-modal'),
    title:     $('feedback-title'),
    lead:      $('feedback-lead'),
    roomLbl:   $('feedback-room-code'),
    stars:     $('feedback-stars'),
    ratingLbl: $('feedback-rating-label'),
    tagsWrap:  $('feedback-tags'),
    comment:   $('feedback-comment'),
    charCount: $('feedback-charcount'),
    submitBtn: $('feedback-submit-btn'),
    submitLbl: $('feedback-submit-label'),
    skipBtn:   $('feedback-skip-btn'),
    closeBtn:  $('feedback-close-btn'),
  };
}

const _FB_COPY = {
  session: {
    title: 'QUICK FEEDBACK',
    lead: `You've left <strong id="feedback-room-code">the room</strong>. Mind rating your session? It's completely anonymous and helps us improve MiutChat.`,
    submitLabel: 'SEND FEEDBACK',
  },
  live: {
    title: 'REPORT A PROBLEM',
    lead: `Something not working right? Let us know what's going on — this is completely anonymous and goes straight to the people building MiutChat.`,
    submitLabel: 'SEND REPORT',
  },
};

const _FB_RATING_LABELS = { 0: 'Tap a star to rate', 1: 'Poor', 2: 'Fair', 3: 'Good', 4: 'Great', 5: 'Excellent' };

function _fbRenderStars() {
  const { stars, ratingLbl, submitBtn } = _fbResolveEls();
  if (!stars) return;
  stars.querySelectorAll('.star-btn').forEach(btn => {
    btn.classList.toggle('filled', +btn.dataset.value <= _fbRating);
  });
  if (ratingLbl) {
    ratingLbl.textContent = _FB_RATING_LABELS[_fbRating] || '';
    ratingLbl.classList.toggle('rated', _fbRating > 0);
  }
  if (submitBtn) submitBtn.disabled = _fbRating === 0;
}

function _fbReset() {
  _fbRating = 0;
  _fbTags.clear();
  const { tagsWrap, comment, charCount } = _fbResolveEls();
  if (tagsWrap) tagsWrap.querySelectorAll('.tag-chip').forEach(c => c.classList.remove('active'));
  if (comment) comment.value = '';
  if (charCount) charCount.textContent = '0';
  _fbRenderStars();
}

export function showFeedbackModal(roomCode, mode) {
  return new Promise(resolve => {
    const { overlay, title, lead } = _fbResolveEls();
    if (!overlay) { resolve(); return; }
    _fbWireOnce();

    mode = (mode === 'live') ? 'live' : 'session';
    const copy = _FB_COPY[mode];
    if (title) title.textContent = copy.title;
    if (lead) lead.innerHTML = copy.lead;
    const { roomLbl, submitLbl } = _fbResolveEls();
    if (roomLbl) roomLbl.textContent = roomCode ? `“${roomCode}”` : 'the room';
    if (submitLbl) submitLbl.textContent = copy.submitLabel;

    _fbReset();
    overlay.style.display = 'flex';

    const done = () => { overlay.style.display = 'none'; resolve(); };
    overlay.dataset.roomCode = roomCode || '';
    overlay.dataset.mode = mode;
    overlay._fbDone = done;

    setTimeout(() => $('feedback-close-btn')?.focus(), 40);
  });
}

async function _fbSubmit() {
  const { overlay, submitBtn, comment } = _fbResolveEls();
  if (!overlay || _fbRating === 0 || !overlay._fbDone) return;

  const roomCode = overlay.dataset.roomCode || '';
  const mode = overlay.dataset.mode === 'live' ? 'live' : 'session';
  const prefix = mode === 'live' ? '[LIVE] ' : '';
  const commentText = (prefix + (comment?.value || '').trim()).slice(0, 500);

  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'SENDING…'; }

  try {
    if (db) {
      await db.collection('feedback').add({
        roomCode,
        rating:     _fbRating,
        tags:       Array.from(_fbTags),
        comment:    commentText,
        appVersion: APP_VERSION,
        createdAt:  firebase.firestore.FieldValue.serverTimestamp(),
      });
    }
    _fbShowThanks(mode);
    setTimeout(() => overlay._fbDone && overlay._fbDone(), 1400);
  } catch (e) {
    _log('warn', '[MIUT] Feedback submit failed:', e);
    toast('Feedback', "Couldn't send — thanks for trying!", 'alert');
    overlay._fbDone();
  }
}

function _fbShowThanks(mode) {
  const body = document.querySelector('#feedback-modal .modal-body');
  if (!body) return;
  const title = mode === 'live' ? 'REPORT SENT' : 'THANKS FOR THE FEEDBACK';
  const sub   = mode === 'live'
    ? 'Thanks for flagging it — we\'ll take a look.'
    : 'It helps us make MiutChat better for everyone.';
  body.innerHTML = `
    <div class="feedback-submitted">
      <svg viewBox="0 0 24 24" width="40" height="40" fill="none">
        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.6"/>
        <path d="M7.5 12.5l3 3 6-6.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <div class="feedback-submitted-title">${title}</div>
      <div class="feedback-submitted-sub">${sub}</div>
    </div>`;
}

function _fbSkip() {
  const { overlay } = _fbResolveEls();
  if (overlay?._fbDone) overlay._fbDone();
}

function _fbWireOnce() {
  const { overlay, stars, tagsWrap, comment, charCount, submitBtn, skipBtn, closeBtn } = _fbResolveEls();
  if (!overlay || overlay.dataset.wired) return;
  overlay.dataset.wired = '1';

  stars?.addEventListener('click', e => {
    const btn = e.target.closest('.star-btn');
    if (!btn) return;
    const firstRating = _fbRating === 0;
    _fbRating = +btn.dataset.value;
    _fbRenderStars();
    if (firstRating) setTimeout(() => comment?.focus(), 200);
  });

  tagsWrap?.addEventListener('click', e => {
    const chip = e.target.closest('.tag-chip');
    if (!chip) return;
    const tag = chip.dataset.tag;
    if (_fbTags.has(tag)) { _fbTags.delete(tag); chip.classList.remove('active'); }
    else if (_fbTags.size < 6) { _fbTags.add(tag); chip.classList.add('active'); }
  });

  comment?.addEventListener('input', () => {
    if (charCount) charCount.textContent = String(comment.value.length);
  });

  submitBtn?.addEventListener('click', () => _fbSubmit());
  skipBtn?.addEventListener('click', () => _fbSkip());
  closeBtn?.addEventListener('click', () => _fbSkip());
  overlay.addEventListener('click', e => { if (e.target === overlay) _fbSkip(); });

}
