/**
 * Password recovery: asking for a link, and using one.
 *
 * Both live outside the signed-in shell, so they render into their own cards
 * beside the login card rather than into #view — #view is inside #app-view,
 * which is hidden for anyone who is not signed in.
 *
 * The emailed link lands on /reset-password?token_hash=...&type=recovery. The
 * hash alone identifies the account, so there is no address to re-type and no
 * second field that can be filled in wrongly.
 */

import { api } from '../api.js';

const MIN_PASSWORD = 10;        // matches MIN_PASSWORD_LENGTH on the server

const el = (id) => document.getElementById(id);

function show(message, node, kind) {
  node.textContent = message;
  node.className = kind + (message ? '' : ' hidden');
}

const clear = (node) => { node.textContent = ''; node.classList.add('hidden'); };

// ---------------------------------------------------------------
// Ask for a link
// ---------------------------------------------------------------
export function wireForgot() {
  const form = el('forgot-form');
  const error = el('forgot-error');
  const sent = el('forgot-sent');
  const button = el('forgot-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(error);
    clear(sent);
    button.disabled = true;

    try {
      const answer = await api.post('/api/auth/forgot', { email: el('forgot-email').value.trim() });
      // The server answers identically whether or not the address exists, so
      // this screen must not imply one way or the other either.
      show(answer.message || 'If that address has an account, a reset link is on its way.',
        sent, 'notice');
      form.reset();
    } catch (err) {
      show(err.message, error, 'error');
    }
    button.disabled = false;
  });
}

// ---------------------------------------------------------------
// Use a link
// ---------------------------------------------------------------
export function wireReset(onSignedIn) {
  const form = el('reset-form');
  const error = el('reset-error');
  const button = el('reset-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(error);

    const tokenHash = new URLSearchParams(location.search).get('token_hash');
    if (!tokenHash) {
      return show('That link is incomplete. Request a new one from the sign-in page.',
        error, 'error');
    }

    const password = el('reset-password').value;
    if (password.length < MIN_PASSWORD) {
      return show(`Use at least ${MIN_PASSWORD} characters.`, error, 'error');
    }
    if (password !== el('reset-confirm').value) {
      return show('The two passwords do not match.', error, 'error');
    }

    button.disabled = true;
    try {
      const user = await api.post('/api/auth/reset', { tokenHash, newPassword: password });
      form.reset();
      // The response carries a signed-in session, so go straight in rather
      // than making someone who just proved who they are type it all again.
      await onSignedIn(user);
    } catch (err) {
      button.disabled = false;
      show(err.message, error, 'error');
    }
  });
}

/** Called when /reset-password is opened, to sanity-check the link first. */
export function prepareReset() {
  const params = new URLSearchParams(location.search);
  const error = el('reset-error');

  // Supabase can redirect here with its own failure rather than a token
  const supabaseError = params.get('error_description') || params.get('error');
  if (supabaseError) {
    show(decodeURIComponent(supabaseError).replace(/\+/g, ' '), error, 'error');
    el('reset-submit').disabled = true;
    return;
  }

  if (!params.get('token_hash')) {
    show('That link is incomplete or has already been used. Request a new one below.',
      error, 'error');
    el('reset-submit').disabled = true;
    return;
  }

  clear(error);
  el('reset-submit').disabled = false;
  el('reset-password').focus();
}
