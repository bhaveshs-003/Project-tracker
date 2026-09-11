/**
 * Shared UI machinery: modals, the type-to-confirm dialog, inline errors and a
 * toast for API failures that have nowhere better to go.
 */

import { escapeHtml } from './format.js';

const root = () => document.getElementById('modal-root');

export function closeModal() {
  root().innerHTML = '';
  root().classList.add('hidden');
}

/**
 * Open a modal. `body` is HTML; `onMount` receives the modal element so the
 * caller can wire its own fields. Returns the element.
 */
export function openModal({ title, body, actions = [], onMount, narrow = false }) {
  const el = root();
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="modal-overlay">
      <div class="modal${narrow ? ' narrow' : ''}">
        <div class="modal-head">
          <h3>${escapeHtml(title)}</h3>
          <button class="close" data-close>&times;</button>
        </div>
        ${body}
        <p class="error hidden" data-error></p>
        <div class="modal-actions">
          ${actions.map((a, i) =>
            `<button type="button" class="${a.className || 'btn-ghost'}" data-action="${i}"
               ${a.disabled ? 'disabled' : ''}>${escapeHtml(a.label)}</button>`).join('')}
        </div>
      </div>
    </div>`;

  const modal = el.querySelector('.modal');
  const overlay = el.querySelector('.modal-overlay');

  el.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

  actions.forEach((a, i) => {
    modal.querySelector(`[data-action="${i}"]`).addEventListener('click', () => a.onClick(modal));
  });

  if (onMount) onMount(modal);
  return modal;
}

export function modalError(modal, message) {
  const el = modal.querySelector('[data-error]');
  el.textContent = message;
  el.classList.remove('hidden');
}

export function clearModalError(modal) {
  modal.querySelector('[data-error]').classList.add('hidden');
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !root().classList.contains('hidden')) closeModal();
});

/**
 * Irreversible actions ask you to type something out first.
 */
export function confirmDialog({ title, message, warning, confirmLabel = 'Confirm', requireText, onConfirm }) {
  const modal = openModal({
    title,
    narrow: true,
    body: `
      <p class="confirm-message">${escapeHtml(message)}</p>
      ${warning ? `<p class="warn-note">${escapeHtml(warning)}</p>` : ''}
      ${requireText ? `
        <div id="confirm-typebox">
          <label for="confirm-input">Type ${escapeHtml(requireText)} below to enable the button</label>
          <input type="text" id="confirm-input" autocomplete="off" spellcheck="false"
                 placeholder="${escapeHtml(requireText)}" />
        </div>` : ''}`,
    actions: [
      { label: 'Cancel', className: 'btn-ghost', onClick: closeModal },
      {
        label: confirmLabel, className: 'btn-primary', disabled: !!requireText,
        onClick: async (m) => {
          const btn = m.querySelector('[data-action="1"]');
          btn.disabled = true;
          try {
            await onConfirm(m);
          } catch (err) {
            btn.disabled = false;
            modalError(m, err.message);
          }
        }
      }
    ],
    onMount(m) {
      if (!requireText) return;
      const input = m.querySelector('#confirm-input');
      const button = m.querySelector('[data-action="1"]');
      const matches = () => input.value.trim().toLowerCase() === requireText.toLowerCase();
      input.addEventListener('input', () => { button.disabled = !matches(); });
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); if (matches()) button.click(); }
      });
      input.focus();
    }
  });
  return modal;
}

let toastTimer = null;

export function toast(message, kind = 'error') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast hidden'; }, 5000);
}

/** Run an API call, showing failures rather than swallowing them. */
export async function attempt(fn, { modal } = {}) {
  try {
    return await fn();
  } catch (err) {
    if (modal) modalError(modal, err.message);
    else toast(err.message);
    throw err;
  }
}
