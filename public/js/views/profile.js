/**
 * Profile — whoever is signed in, and a place to change their password.
 *
 * Reached from the avatar menu rather than a tab of its own.
 */

import { api } from '../api.js';
import { state, currentPerson, roleLabel, isPartner } from '../state.js';
import { escapeHtml, initials } from '../format.js';
import { toast } from '../ui.js';

const MIN_PASSWORD = 8;   // matches the server

export async function renderProfile(mount) {
  const person = currentPerson();

  mount.innerHTML = `
    <h2>Profile</h2>
    <div class="profile">
      <div class="avatar">${escapeHtml(initials(person.name))}</div>
      <div>
        <h3>${escapeHtml(person.name)}</h3>
        <p class="muted">${escapeHtml(person.email || state.user.email)}</p>
      </div>
      <span class="role-chip${isPartner() ? ' partner' : ''}">${roleLabel()}</span>
    </div>

    <div class="box profile-form">
      <label>Full name</label>
      <input type="text" value="${escapeHtml(person.name)}" readonly />

      <label>Role</label>
      <input type="text" value="${escapeHtml(person.role)}" readonly />

      <p class="day-hint">Profile details are managed by an administrator under User Management.</p>
    </div>

    <div class="section-head"><h3 id="password">Change password</h3></div>
    <form class="box profile-form" id="password-form">
      <label for="pw-current">Current password</label>
      <input type="password" id="pw-current" autocomplete="current-password" required />

      <label for="pw-new">New password</label>
      <input type="password" id="pw-new" autocomplete="new-password" required />

      <label for="pw-confirm">Confirm new password</label>
      <input type="password" id="pw-confirm" autocomplete="new-password" required />

      <p class="error hidden" id="pw-error"></p>
      <p class="day-hint">At least ${MIN_PASSWORD} characters. Changing it signs you out
        everywhere else, but keeps you signed in here.</p>

      <button type="submit" class="btn-primary" id="pw-submit">Change password</button>
    </form>`;

  const form = mount.querySelector('#password-form');
  const error = mount.querySelector('#pw-error');
  const button = mount.querySelector('#pw-submit');
  const field = id => mount.querySelector('#pw-' + id);

  const fail = (message) => {
    error.textContent = message;
    error.classList.remove('hidden');
    button.disabled = false;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.classList.add('hidden');
    button.disabled = true;

    const current = field('current').value;
    const next = field('new').value;

    if (next.length < MIN_PASSWORD) return fail(`Use at least ${MIN_PASSWORD} characters.`);
    if (next !== field('confirm').value) return fail('The two new passwords do not match.');

    try {
      await api.post('/api/auth/password', { currentPassword: current, newPassword: next });
      form.reset();
      button.disabled = false;
      toast('Password changed. Other devices have been signed out.', 'info');
    } catch (err) {
      field('current').value = '';
      fail(err.message);
    }
  });

  // Arriving from the avatar menu's "Change password" item
  if (location.hash === '#password') {
    mount.querySelector('#password').scrollIntoView({ block: 'start' });
    field('current').focus();
  }
}
