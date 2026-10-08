/**
 * Boot: work out who is signed in, wire the routes, render the shell.
 */

import { api, ApiError, isFileProtocol } from './api.js';
import { state, isPartner, roleLabel, currentPerson, loadPeople } from './state.js';
import { route, setNotFound, navigate, resolve, bind, rememberIntendedPath, takeIntendedPath, homePath } from './router.js';
import { escapeHtml, initials } from './format.js';
import { closeModal, toast } from './ui.js';

import { renderDashboard } from './views/dashboard.js';
import { renderProjects } from './views/projects.js';
import { renderProject } from './views/project.js';
import { renderPeople } from './views/people.js';
import { renderAudit } from './views/audit.js';
import { renderProfile } from './views/profile.js';
import { wireForgot, wireReset, prepareReset } from './views/reset.js';

const loginView = () => document.getElementById('login-view');
const appView = () => document.getElementById('app-view');
const mount = () => document.getElementById('view');

// Profile is deliberately absent — it lives in the avatar menu instead.
const TABS = [
  { path: '/dashboard', label: 'Dashboard', role: 'any' },
  { path: '/projects', label: 'Projects', role: 'any' },
  { path: '/people', label: 'User Management', role: 'admin' },
  { path: '/audit', label: 'Audit Trail', role: 'admin' }
];

// ---------------------------------------------------------------
// Shell
// ---------------------------------------------------------------
function renderShell() {
  const person = currentPerson();
  document.getElementById('topbar-name').textContent = person.name;
  document.getElementById('topbar-email').textContent = person.email || state.user.email;

  const chip = document.getElementById('role-chip');
  chip.textContent = roleLabel();
  chip.className = 'role-chip' + (isPartner() ? ' partner' : '');
  document.getElementById('topbar-avatar').textContent = initials(person.name);

  document.querySelector('.tabs').innerHTML = TABS
    .filter(t => t.role === 'any' || t.role === state.user.role)
    .map(t => `<a class="tab" href="${t.path}" data-path="${t.path}">${escapeHtml(t.label)}</a>`)
    .join('');
}

// ---------------------------------------------------------------
// Account menu
// ---------------------------------------------------------------
const accountMenu = () => document.getElementById('account-menu');
const accountButton = () => document.getElementById('topbar-avatar');

function closeAccountMenu() {
  accountMenu().classList.add('hidden');
  accountButton().setAttribute('aria-expanded', 'false');
}

function toggleAccountMenu() {
  const open = accountMenu().classList.toggle('hidden');
  accountButton().setAttribute('aria-expanded', String(!open));
}

accountButton().addEventListener('click', (e) => { e.stopPropagation(); toggleAccountMenu(); });
document.addEventListener('click', (e) => {
  if (!accountMenu().classList.contains('hidden') && !e.target.closest('.account')) closeAccountMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !accountMenu().classList.contains('hidden')) closeAccountMenu();
});

function highlightTab() {
  document.querySelectorAll('.tab').forEach(tab => {
    const path = tab.dataset.path;
    tab.classList.toggle('active',
      location.pathname === path || location.pathname.startsWith(path + '/'));
  });
}

/** Wrap a view so failures show up instead of leaving a blank page. */
function view(render) {
  return async (params) => {
    closeModal();
    closeAccountMenu();          // navigating away should not leave it hanging open
    highlightTab();
    try {
      await render(mount(), params);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return showLogin();
      mount().innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
      toast(err.message);
    }
    highlightTab();
  };
}

// ---------------------------------------------------------------
// Routes
// ---------------------------------------------------------------
route('/dashboard', { role: 'any', render: view((m) => renderDashboard(m)) });
route('/projects', { role: 'any', render: view((m) => renderProjects(m)) });
route('/projects/:code', { role: 'any', render: view((m, p) => renderProject(m, p.code)) });
// Sub-tabs are real URLs, so back/forward and a pasted link both work
route('/projects/:code/:tab', { role: 'any', render: view((m, p) => renderProject(m, p.code, p.tab)) });
route('/profile', { role: 'any', render: view((m) => renderProfile(m)) });
route('/people', { role: 'admin', render: view((m) => renderPeople(m)) });
route('/audit', { role: 'admin', render: view((m) => renderAudit(m)) });
route('/login', { role: 'anonymous', render: async () => showLogin() });
route('/forgot-password', { role: 'anonymous', render: async () => showCard('forgot-view') });
// Where the emailed reset link lands, carrying ?token_hash=...
route('/reset-password', {
  role: 'anonymous',
  render: async () => { showCard('reset-view'); prepareReset(); }
});

setNotFound((path) => {
  highlightTab();
  mount().innerHTML = `<p class="empty">Nothing lives at <code>${escapeHtml(path)}</code>.
    <a href="${homePath()}">Go to the dashboard</a>.</p>`;
});

// ---------------------------------------------------------------
// Sign in / out
// ---------------------------------------------------------------
// The three signed-out cards. Exactly one is ever visible, and all of them
// live outside #app-view, which is hidden to anyone without a session.
const SIGNED_OUT_CARDS = ['login-view', 'forgot-view', 'reset-view'];

function showCard(id) {
  state.user = null;
  appView().classList.add('hidden');
  SIGNED_OUT_CARDS.forEach(card => {
    document.getElementById(card).classList.toggle('hidden', card !== id);
  });
}

function showLogin() {
  showCard('login-view');
  document.getElementById('login-form').reset();
  document.getElementById('login-email').focus();
}

function loginError(message) {
  const el = document.getElementById('login-error');
  el.textContent = message;
  el.classList.remove('hidden');
}

const SIGNED_OUT_PATHS = ['/login', '/forgot-password', '/reset-password'];

async function enterApp(user) {
  state.user = user;
  await loadPeople();               // names are needed by nearly every view
  SIGNED_OUT_CARDS.forEach(card => document.getElementById(card).classList.add('hidden'));
  appView().classList.remove('hidden');
  document.getElementById('login-error').classList.add('hidden');
  renderShell();

  // Landing on the dashboard after a reset rather than back on the card that
  // just succeeded — and the token_hash leaves the address bar with it.
  const intended = takeIntendedPath();
  const here = SIGNED_OUT_PATHS.includes(location.pathname) ? homePath() : location.pathname;
  await navigate(intended || here, { replace: true });
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (isFileProtocol) return;

  const button = document.getElementById('login-submit');
  document.getElementById('login-error').classList.add('hidden');
  button.disabled = true;

  try {
    const user = await api.post('/api/auth/login', {
      email: document.getElementById('login-email').value.trim(),
      password: document.getElementById('login-password').value
    });
    button.disabled = false;
    await enterApp(user);
  } catch (err) {
    button.disabled = false;
    document.getElementById('login-password').value = '';
    loginError(err.message);
  }
});

document.getElementById('logout').addEventListener('click', async () => {
  try { await api.post('/api/auth/logout'); } catch { /* sign out locally regardless */ }
  history.pushState({}, '', '/login');
  showLogin();
});

// ---------------------------------------------------------------
// Boot
// ---------------------------------------------------------------
async function boot() {
  // Opened by double-clicking index.html: every /api call resolves against
  // file:// and can never succeed, however healthy the server is.
  if (isFileProtocol) {
    showLogin();
    document.getElementById('file-warning').classList.remove('hidden');
    document.getElementById('login-submit').disabled = true;
    document.getElementById('login-email').disabled = true;
    document.getElementById('login-password').disabled = true;
    return;
  }

  rememberIntendedPath();

  // Only a 401 means "signed out". A blip gets one retry, then says so plainly.
  const restore = async (isRetry) => {
    try {
      return await api.get('/api/auth/me');
    } catch (err) {
      if (err.status === 401) return null;
      if (!isRetry) {
        await new Promise(r => setTimeout(r, 800));
        return restore(true);
      }
      throw err;
    }
  };

  let user = null;
  try {
    user = await restore(false);
  } catch (err) {
    showLogin();
    return loginError('Could not reach the server. Check it is running, then sign in again.');
  }

  if (!user) {
    // Signed out is the *expected* state on the recovery cards — someone
    // following a reset link has no session by definition. Forcing /login
    // here would throw away the token_hash in the URL and strand them.
    if (SIGNED_OUT_PATHS.includes(location.pathname)) return resolve();

    showLogin();
    history.replaceState({}, '', '/login');
    return;
  }

  await enterApp(user);
}

// The recovery cards wire themselves once; enterApp is how a successful reset
// turns straight into a session.
wireForgot();
wireReset(enterApp);

bind();           // popstate + in-app link interception, once
boot();
