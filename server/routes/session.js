/**
 * Sign in, sign out, and "who am I". The only routes reachable without a session.
 */

var express = require('express');
var guards = require('../guards');
var db = require('../db').db;
var audit = require('../audit');

var router = express.Router();

router.post('/login', function (req, res) {
  var body = req.body || {};
  var user = guards.findUserByEmail(body.email);

  // One message for "no such account" and "wrong password" alike, so the
  // response cannot be used to discover which emails are registered.
  var invalid = { error: 'Invalid email or password' };
  if (!user || !body.password) return res.status(401).json(invalid);
  if (!guards.passwordMatches(String(body.password), user)) return res.status(401).json(invalid);

  res.setHeader('Set-Cookie', guards.cookieHeader(guards.createSession(user.id)));
  res.json(guards.publicUser(user));
});

router.post('/logout', function (req, res) {
  var id = guards.readCookie(req);
  if (id) guards.destroySession(id);
  res.setHeader('Set-Cookie', guards.clearCookieHeader());
  res.json({ ok: true });
});

router.get('/me', guards.requireAuth, function (req, res) {
  res.json(guards.publicUser(req.user));
});

var MIN_PASSWORD = 8;

/**
 * Change your own password. There is no route to change anyone else's here —
 * that stays with user management.
 *
 * A successful change ends every other session and issues a fresh one for the
 * browser making the request, so the device you changed it on keeps working and
 * everything else has to sign in again.
 */
router.post('/password', guards.requireAuth, function (req, res) {
  var body = req.body || {};
  var current = String(body.currentPassword || '');
  var next = String(body.newPassword || '');

  if (!guards.passwordMatches(current, req.user)) {
    return res.status(400).json({ error: 'That is not your current password.' });
  }
  if (next.length < MIN_PASSWORD) {
    return res.status(400).json({ error: 'Use at least ' + MIN_PASSWORD + ' characters.' });
  }
  if (next === current) {
    return res.status(400).json({ error: 'The new password must be different from the current one.' });
  }

  var creds = guards.hashPassword(next);
  var fresh;
  db.transaction(function () {
    db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?')
      .run(creds.salt, creds.hash, req.user.id);
    guards.destroySessionsForUser(req.user.id);     // including this one
    fresh = guards.createSession(req.user.id);      // …then hand this browser a new one
  })();

  audit.record(req.user, 'User', 'Changed password', req.user.name, '', null);
  res.setHeader('Set-Cookie', guards.cookieHeader(fresh));
  res.json({ ok: true });
});

module.exports = router;
