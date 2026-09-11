/**
 * Sessions and the guards every route is registered with.
 *
 * Sessions live in SQLite, so a restart does not sign anyone out, and the
 * cookie is httpOnly so no script — ours or an injected one — can read it.
 */

var crypto = require('crypto');
var store = require('./db');
var db = store.db;

var SESSION_COOKIE = 'ft_session';
var SESSION_MS = 8 * 60 * 60 * 1000;   // 8 hours

function cookieHeader(sessionId) {
  // Add '; Secure' once this is served over HTTPS.
  return SESSION_COOKIE + '=' + sessionId +
    '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + (SESSION_MS / 1000);
}

function clearCookieHeader() {
  return SESSION_COOKIE + '=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
}

function createSession(userId) {
  var id = crypto.randomUUID();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(id, userId, Date.now() + SESSION_MS, new Date().toISOString());
  return id;
}

function destroySession(id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

function destroySessionsForUser(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function readCookie(req) {
  var raw = req.headers.cookie || '';
  var match = raw.split(';').map(function (c) { return c.trim(); })
    .filter(function (c) { return c.indexOf(SESSION_COOKIE + '=') === 0; })[0];
  return match ? match.slice(SESSION_COOKIE.length + 1) : null;
}

function findUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE')
    .get(String(email || '').trim()) || null;
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

/**
 * Resolve the session, refresh it if it is over halfway to expiry, and hang the
 * user off the request. Anything without a valid session gets 401 — there is no
 * route in this app registered without this guard.
 */
function requireAuth(req, res, next) {
  var id = readCookie(req);
  if (!id) return res.status(401).json({ error: 'Not signed in' });

  var session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!session) return res.status(401).json({ error: 'Not signed in' });

  if (session.expires_at < Date.now()) {
    destroySession(id);
    return res.status(401).json({ error: 'Session expired' });
  }

  var user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
  if (!user) {                       // account deleted while signed in
    destroySession(id);
    return res.status(401).json({ error: 'Not signed in' });
  }

  // Sliding expiry: somebody actively working is never kicked out mid-session
  if (session.expires_at - Date.now() < SESSION_MS / 2) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .run(Date.now() + SESSION_MS, id);
    res.setHeader('Set-Cookie', cookieHeader(id));
  }

  req.user = user;
  req.sessionId = id;
  next();
}

function requireRole(role) {
  return function (req, res, next) {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: 'Not permitted' });
    }
    next();
  };
}

function pruneExpiredSessions() {
  return db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()).changes;
}

module.exports = {
  SESSION_COOKIE: SESSION_COOKIE,
  SESSION_MS: SESSION_MS,
  cookieHeader: cookieHeader,
  clearCookieHeader: clearCookieHeader,
  createSession: createSession,
  destroySession: destroySession,
  destroySessionsForUser: destroySessionsForUser,
  readCookie: readCookie,
  findUserByEmail: findUserByEmail,
  publicUser: publicUser,
  requireAuth: requireAuth,
  requireRole: requireRole,
  pruneExpiredSessions: pruneExpiredSessions,
  hashPassword: store.hashPassword,
  passwordMatches: store.passwordMatches
};
