'use strict';

import { toast, _log } from '../app.js';

const CATEGORIES = [
  ['child-safety', 'Child safety'],
  ['threat', 'Threat or violence'],
  ['hate', 'Hate speech'],
  ['intimate-image', 'Intimate image without consent'],
  ['illegal', 'Illegal goods or activity'],
  ['fraud', 'Scam or fraud'],
  ['other', 'Something else']
];

let overlay = null;

function close() {
  if (overlay) overlay.remove();
  overlay = null;
  document.removeEventListener('keydown', onKey);
}

function onKey(e) {
  if (e.key === 'Escape') close();
}

export function showReportModal(ctx) {
  close();
  let category = '';

  overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'report-modal';
  overlay.innerHTML = `
    <div class="modal feedback-modal" role="dialog" aria-modal="true" aria-labelledby="report-title">
      <div class="modal-header">
        <h3 id="report-title">REPORT MESSAGE</h3>
        <button class="icon-btn" id="report-close" title="Cancel">
          <svg viewBox="0 0 20 20" fill="none" width="16" height="16"><path d="M15 5L5 15M5 5l10 10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <p class="feedback-lead">What is wrong with this message?</p>
        <div class="feedback-tags" id="report-cats">
          ${CATEGORIES.map(([v, l]) => `<button type="button" class="tag-chip" data-cat="${v}">${l}</button>`).join('')}
        </div>
        <div class="feedback-actions">
          <button class="btn-skip" id="report-cancel">CANCEL</button>
          <button class="btn-join" id="report-submit" disabled>SEND REPORT</button>
        </div>
        <p class="feedback-privacy-note">Only the message ID and your choice are sent. The message stays encrypted and nobody at MiutChat reads it. If enough members report the same message, it is hidden for everyone automatically.</p>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey);

  const submit = overlay.querySelector('#report-submit');
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('#report-close').addEventListener('click', close);
  overlay.querySelector('#report-cancel').addEventListener('click', close);

  overlay.querySelector('#report-cats').addEventListener('click', e => {
    const chip = e.target.closest('.tag-chip');
    if (!chip) return;
    category = chip.dataset.cat;
    overlay.querySelectorAll('.tag-chip').forEach(c => c.classList.toggle('active', c === chip));
    submit.disabled = false;
  });

  submit.addEventListener('click', async () => {
    if (!category) return;
    submit.disabled = true;
    submit.textContent = 'SENDING…';
    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: ctx.roomId, docId: ctx.docId, category, reporter: ctx.reporter })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (window.__miutHideDoc) window.__miutHideDoc(ctx.docId);
      toast('Report sent', data.hidden ? 'The message is now hidden for everyone.' : 'Thank you. It is hidden for you now.', 'ok');
      close();
    } catch (e) {
      _log('warn', '[MIUT] Report submit failed:', e);
      toast('Report failed', "Couldn't send the report. Please try again.", 'err');
      submit.disabled = false;
      submit.textContent = 'SEND REPORT';
    }
  });

  setTimeout(() => overlay && overlay.querySelector('.tag-chip')?.focus(), 40);
}
