/**
 * Sign in, sign out, "who am I", and password recovery.
 *
 * Express brokers Supabase Auth: the browser posts credentials here, this
 * exchanges them for a session, and the tokens go back as httpOnly cookies.
 * The page never holds a token, so an injected script cannot read or replay
 * one — the property the hand-rolled session system had, kept.
 *
 * The client's API surface is unchanged. /login, /logout and /me behave
 * exactly as before; /forgot and /reset are new, because the app previously
 * had no way to recover an account at all.
 */

var express = require('express');
var sql = require('../sql');
var guards = require('../guards');
var supabase = require('../supabase');
var audit = require('../audit');
var v = require('../validate');

var router = express.Router();
var asyncHandler = v.asyncHandler;

var MIN_PASSWORD = Number(process.env.MIN_PASSWORD_LENGTH || 10);

var credentials = v.z.object({
  email: v.z.string().trim().toLowerCase().email('Enter a valid email address').max(320),
  password: v.z.string().min(1, 'Enter your password').max(200)
});

// One message for "no such account" and "wrong password" alike, so the
// response cannot be used to discover which emails are registered.
var INVALID = 'Invalid email or password';

router.post('/login', asyncHandler(async function (req, res) {
  var input = v.body(credentials, req);

  if (await guards.isRateLimited('login', input.email, req)) {
    await guards.recordAttempt('login', input.email, req, false);
    return res.status(429).json({
      error: 'Too many sign-in attempts. Wait ' +
        guards.LIMITS.login.windowMinutes + ' minutes and try again.'
    });
  }

  var result = await supabase.signInWithPassword(input.email, input.password);
  if (result.error || !result.data || !result.data.session) {
    await guards.recordAttempt('login', input.email, req, false);
    return res.status(401).json({ error: INVALID });
  }

  // Authenticated with Supabase, but this app only knows people who have a
  // directory row. An auth user without one cannot be placed on a project and
  // must not be let in.
  var person = await guards.loadPerson(result.data.user.id);
  if (!person) {
    await guards.recordAttempt('login', input.email, req, false);
    return res.status(401).json({ error: INVALID });
  }

  var role = (result.data.user.app_metadata && result.data.user.app_metadata.role) || person.role;
  person.role = role;

  await guards.recordAttempt('login', input.email, req, true);
  guards.setSessionCookies(res, result.data.session);
  res.json(guards.publicUser(person));
}));

router.post('/logout', asyncHandler(async function (req, res) {
  var token = guards.readCookie(req, guards.ACCESS_COOKIE);
  if (token) {
    // Revoke the refresh token server-side so the cookie being stolen earlier
    // does not keep working after the user signs out.
    try {
      await supabase.admin.auth.admin.signOut(token, 'local');
    } catch { /* already expired or revoked; clearing the cookie is enough */ }
  }
  guards.clearSessionCookies(res);
  res.json({ ok: true });
}));

router.get('/me', guards.requireAuth, function (req, res) {
  res.json(req.user);
});

// ---------------------------------------------------------------
// Password recovery
// ---------------------------------------------------------------
router.post('/forgot', asyncHandler(async function (req, res) {
  var input = v.body(v.z.object({
    email: v.z.string().trim().toLowerCase().email('Enter a valid email address').max(320)
  }), req);

  // Always the same answer, whether or not the address exists. Anything else
  // turns this endpoint into a way to enumerate accounts.
  var answer = {
    ok: true,
    message: 'If that address has an account, a reset link is on its way.'
  };

  if (await guards.isRateLimited('forgot', input.email, req)) return res.json(answer);
  await guards.recordAttempt('forgot', input.email, req, false);

  var person = await sql.one('SELECT * FROM people WHERE email = $1 AND user_id IS NOT NULL',
    [input.email]);
  if (!person) return res.json(answer);

  var redirectTo = (process.env.APP_URL || '').replace(/\/$/, '') + '/reset-password';
  var sent = await supabase.anon.auth.resetPasswordForEmail(input.email, { redirectTo: redirectTo });
  if (sent.error) console.error('[auth] reset email failed:', sent.error.message);

  await audit.record({ id: person.id, name: person.name, role: person.role },
    'User', 'Requested password reset', person.name, '', null);
  res.json(answer);
}));

/**
 * Complete a reset. The recovery token arrives from the emailed link; the
 * client posts it here rather than holding a session, so the new password is
 * set and the browser gets ordinary httpOnly cookies like any other sign-in.
 */
router.post('/reset', asyncHandler(async function (req, res) {
  var input = v.body(v.z.object({
    token: v.z.string().min(1, 'The reset link is incomplete').max(4000),
    email: v.z.string().trim().toLowerCase().email().max(320),
    newPassword: v.z.string()
      .min(MIN_PASSWORD, 'Use at least ' + MIN_PASSWORD + ' characters')
      .max(200)
  }), req);

  if (await guards.isRateLimited('reset', input.email, req)) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }

  var verified = await supabase.anon.auth.verifyOtp({
    email: input.email, token: input.token, type: 'recovery'
  });
  if (verified.error || !verified.data || !verified.data.session) {
    await guards.recordAttempt('reset', input.email, req, false);
    return res.status(400).json({ error: 'That reset link is invalid or has expired.' });
  }

  var updated = await supabase.admin.auth.admin.updateUserById(
    verified.data.user.id, { password: input.newPassword });
  if (updated.error) {
    return res.status(400).json({ error: updated.error.message });
  }

  var person = await guards.loadPerson(verified.data.user.id);
  if (!person) return res.status(400).json({ error: 'That account cannot sign in.' });

  await guards.recordAttempt('reset', input.email, req, true);
  await audit.record({ id: person.id, name: person.name, role: person.role },
    'User', 'Reset password', person.name, '', null);

  guards.setSessionCookies(res, verified.data.session);
  res.json(guards.publicUser(person));
}));

/**
 * Change your own password. There is no route to change anyone else's here —
 * that stays with user management.
 *
 * Supabase revokes the other sessions; this browser keeps working because it
 * is handed the fresh pair that comes back.
 */
router.post('/password', guards.requireAuth, asyncHandler(async function (req, res) {
  var input = v.body(v.z.object({
    currentPassword: v.z.string().min(1, 'Enter your current password').max(200),
    newPassword: v.z.string()
      .min(MIN_PASSWORD, 'Use at least ' + MIN_PASSWORD + ' characters')
      .max(200)
  }), req);

  if (input.newPassword === input.currentPassword) {
    return res.status(400).json({ error: 'The new password must be different from the current one.' });
  }

  // Re-authenticate rather than trusting the cookie alone: a stolen session
  // must not be enough to take the account over permanently.
  var check = await supabase.signInWithPassword(req.user.email, input.currentPassword);
  if (check.error || !check.data.session) {
    await guards.recordAttempt('login', req.user.email, req, false);
    return res.status(400).json({ error: 'That is not your current password.' });
  }

  var updated = await supabase.admin.auth.admin.updateUserById(
    req.authUserId, { password: input.newPassword });
  if (updated.error) return res.status(400).json({ error: updated.error.message });

  // Everything else signed out; this browser gets a new pair.
  try {
    await supabase.admin.auth.admin.signOut(check.data.session.access_token, 'others');
  } catch { /* best effort */ }

  var fresh = await supabase.signInWithPassword(req.user.email, input.newPassword);
  if (!fresh.error && fresh.data.session) guards.setSessionCookies(res, fresh.data.session);

  await audit.record(req.user, 'User', 'Changed password', req.user.name, '', null);
  res.json({ ok: true });
}));

module.exports = router;
