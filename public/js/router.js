/**
 * History API routing with role guards.
 *
 * Routes declare who may reach them. A partner typing /audit is redirected
 * rather than shown an empty page, and an unauthenticated visit remembers where
 * it was headed so sign-in lands you there.
 */

import { state } from './state.js';

const routes = [];
let notFound = null;
let pendingPath = null;      // where an unauthenticated visitor was headed

export function route(pattern, { role = 'any', render }) {
  // '/projects/:code' -> /^\/projects\/([^/]+)$/
  const names = [];
  const regex = new RegExp('^' + pattern.replace(/:[A-Za-z]+/g, m => {
    names.push(m.slice(1));
    return '([^/]+)';
  }).replace(/\//g, '\\/') + '$');
  routes.push({ pattern, regex, names, role, render });
}

export function setNotFound(render) { notFound = render; }

export function match(path) {
  for (const r of routes) {
    const found = path.match(r.regex);
    if (!found) continue;
    const params = {};
    r.names.forEach((name, i) => { params[name] = decodeURIComponent(found[i + 1]); });
    return { route: r, params };
  }
  return null;
}

export function navigate(path, { replace = false } = {}) {
  if (location.pathname === path && !replace) return resolve();
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  return resolve();
}

// Nowhere to come back to: these are the signed-out cards themselves, and
// remembering one would bounce a user straight back to it after they signed in.
const NOT_A_DESTINATION = ['/', '/login', '/forgot-password', '/reset-password'];

export function rememberIntendedPath() {
  const path = location.pathname;
  if (!NOT_A_DESTINATION.includes(path)) pendingPath = path;
}

export function takeIntendedPath() {
  const path = pendingPath;
  pendingPath = null;
  return path;
}

/** Where this user should land when they have nowhere specific to go. */
export const homePath = () => '/dashboard';

function allowed(role) {
  if (role === 'any') return true;
  if (role === 'anonymous') return !state.user;
  return state.user?.role === role;
}

export async function resolve() {
  const path = location.pathname === '/' ? homePath() : location.pathname;
  const found = match(path);

  if (!found) {
    if (notFound) await notFound(path);
    return;
  }

  if (!allowed(found.route.role)) {
    // Signed in but not permitted, or signed out and the route needs a session
    return navigate(state.user ? homePath() : '/login', { replace: true });
  }

  await found.route.render(found.params);
}

/** Bind navigation listeners. Call once, before the first resolve(). */
export function bind() {
  window.addEventListener('popstate', resolve);

  // Intercept in-app links so navigation stays client-side
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href^="/"]');
    if (!link || link.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    navigate(link.getAttribute('href'));
  });
}
