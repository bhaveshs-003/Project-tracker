/**
 * Authentication, and the guards every route is registered with.
 *
 * Supabase Auth owns credentials now, but the browser never sees a token.
 * Express brokers the exchange and keeps both tokens in httpOnly cookies:
 *
 *   browser --POST /api/auth/login--> Express --signInWithPassword--> Supabase
 *           <------ Set-Cookie (httpOnly) -----+
 *
 * The obvious alternative — supabase-js in the page — defaults to localStorage,
 * where any XSS can read the token and replay it. Brokering keeps the property
 * the app already had: no script, ours or injected, can read the session.
 *
 * Access tokens are verified locally against the JWKS, so authentication costs
 * no network round-trip. Role comes from the token's app_metadata, so it costs
 * no database query either.
 */

var crypto = require('crypto');
var sql = require('./sql');
var supabase = require('./supabase');

var ACCESS_COOKIE = 'ft_at';
var REFRESH_COOKIE = 'ft_rt';

// Refresh tokens are long-lived; the cookie should outlive the access token by
// enough that a user returning the next morning is still signed in.
var REFRESH_MAX_AGE = Number(process.env.SESSION_MAX_AGE_SECONDS || 60 * 60 * 24 * 14);

var isProduction = process.env.NODE_ENV === 'production';

function cookie(name, value, maxAgeSeconds) {
  return [
    name + '=' + value,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    // Secure unconditionally in production. The SQLite version carried this as
    // a TODO comment, which meant the cookie travelled in clear over any
    // accidental http:// hop.
    isProduction ? 'Secure' : null,
    'Max-Age=' + maxAgeSeconds
  ].filter(Boolean).join('; ');
}

function readCookie(req, name) {
  var raw = req.headers.cookie || '';
  var match = raw.split(';')
    .map(function (c) { return c.trim(); })
    .filter(function (c) { return c.indexOf(name + '=') === 0; })[0];
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

/** Set both cookies from a Supabase session. */
function setSessionCookies(res, session) {
  // The access cookie's lifetime tracks the token's own expiry, so a stale one
  // is simply not sent rather than being sent and rejected.
  var accessMaxAge = Math.max(60, (session.expires_in || 3600));
  res.append('Set-Cookie', cookie(ACCESS_COOKIE, session.access_token, accessMaxAge));
  res.append('Set-Cookie', cookie(REFRESH_COOKIE, session.refresh_token, REFRESH_MAX_AGE));
}

function clearSessionCookies(res) {
  res.append('Set-Cookie', cookie(ACCESS_COOKIE, '', 0));
  res.append('Set-Cookie', cookie(REFRESH_COOKIE, '', 0));
}

/**
 * The app's view of a signed-in person: the auth user joined to their people
 * row. `id` is the people id, because that is what every project join uses.
 */
async function loadPerson(authUserId) {
  return sql.one('SELECT * FROM people WHERE user_id = $1', [authUserId]);
}

function publicUser(person) {
  return {
    id: person.id,
    name: person.name,
    email: person.email,
    role: person.role
  };
}

/**
 * Resolve the session, refreshing it transparently if the access token has
 * expired, and hang the user off the request.
 *
 * Anything without a valid session gets 401 — there is no route in this app
 * registered without this guard, except the auth endpoints themselves.
 */
async function requireAuth(req, res, next) {
  try {
    var accessToken = readCookie(req, ACCESS_COOKIE);
    var claims = null;

    if (accessToken) {
      try {
        claims = await supabase.verifyAccessToken(accessToken);
      } catch {
        claims = null;        // expired or tampered; fall through to refresh
      }
    }

    // Sliding expiry: somebody actively working is never kicked out mid-session
    if (!claims) {
      var refreshToken = readCookie(req, REFRESH_COOKIE);
      if (!refreshToken) return res.status(401).json({ error: 'Not signed in' });

      var refreshed = await supabase.refreshSession(refreshToken);
      if (refreshed.error || !refreshed.data || !refreshed.data.session) {
        clearSessionCookies(res);
        return res.status(401).json({ error: 'Session expired' });
      }
      setSessionCookies(res, refreshed.data.session);
      claims = await supabase.verifyAccessToken(refreshed.data.session.access_token);
    }

    var person = await loadPerson(claims.sub);
    if (!person) {
      // The auth user exists but has no directory record — deleted while
      // signed in, or a half-finished seed. Treat as signed out.
      clearSessionCookies(res);
      return res.status(401).json({ error: 'Not signed in' });
    }

    // Role comes from the token, not the row: the token is signed, so it
    // cannot be edited, and reading it costs nothing.
    var tokenRole = (claims.app_metadata && claims.app_metadata.role) || null;
    person.role = tokenRole || person.role;

    req.authUserId = claims.sub;
    req.user = publicUser(person);
    req.person = person;
    next();
  } catch (err) {
    next(err);
  }
}

function requireRole(role) {
  return function (req, res, next) {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: 'Not permitted' });
    }
    next();
  };
}

/**
 * Shared secret for the cron endpoint. Compared with timingSafeEqual so the
 * comparison itself cannot be used to recover the secret a byte at a time.
 */
function requireCronSecret(req, res, next) {
  var expected = process.env.CRON_SECRET;
  if (!expected) return res.status(503).json({ error: 'CRON_SECRET is not configured' });

  var header = String(req.headers.authorization || '');
  var provided = header.indexOf('Bearer ') === 0 ? header.slice(7) : '';

  var a = Buffer.from(provided);
  var b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Not permitted' });
  }
  next();
}

// ---------------------------------------------------------------
// Rate limiting
//
// Counted in Postgres, not in memory. On serverless each request may land on a
// different instance, so an in-process counter protects nothing.
// ---------------------------------------------------------------
/**
 * Two budgets per action, not one.
 *
 * The obvious implementation — "N failures from this email OR this IP" — locks
 * out a whole office the moment one person mistypes their password six times,
 * because everyone behind a NAT shares an address. So the per-email budget is
 * tight (it stops credential stuffing against one account) and the per-IP
 * budget is loose enough to absorb a floor of people having a bad morning
 * while still catching a machine spraying passwords.
 */
var LIMITS = {
  login: { perEmail: 6, perIp: 40, windowMinutes: 15 },
  forgot: { perEmail: 4, perIp: 20, windowMinutes: 60 },
  reset: { perEmail: 8, perIp: 30, windowMinutes: 60 }
};

function clientIp(req) {
  // Behind Vercel; `trust proxy` makes req.ip the real client address.
  return req.ip || null;
}

async function recordAttempt(kind, email, req, successful) {
  try {
    await sql.run(
      'INSERT INTO auth_attempts (kind, email, ip, successful) VALUES ($1, $2, $3, $4)',
      [kind, email || null, clientIp(req), !!successful]);
  } catch (err) {
    console.error('[auth] could not record attempt:', err.message);
  }
}

/**
 * True if either budget is spent. Successful attempts do not count, so a
 * legitimate user is never locked out by their own activity.
 */
async function isRateLimited(kind, email, req) {
  var limit = LIMITS[kind];
  if (!limit) return false;

  var counts = await sql.one(
    `SELECT
       count(*) FILTER (WHERE email = $3) AS by_email,
       count(*) FILTER (WHERE ip = $4)    AS by_ip
     FROM auth_attempts
      WHERE kind = $1 AND successful = false
        AND at > now() - ($2 || ' minutes')::interval`,
    [kind, String(limit.windowMinutes), email || null, clientIp(req)]);

  return Number(counts.by_email) >= limit.perEmail || Number(counts.by_ip) >= limit.perIp;
}

/** Housekeeping for the attempts table; called by the cron. */
async function pruneAuthAttempts() {
  return sql.run("DELETE FROM auth_attempts WHERE at < now() - interval '7 days'");
}

module.exports = {
  ACCESS_COOKIE: ACCESS_COOKIE,
  REFRESH_COOKIE: REFRESH_COOKIE,
  readCookie: readCookie,
  setSessionCookies: setSessionCookies,
  clearSessionCookies: clearSessionCookies,
  loadPerson: loadPerson,
  publicUser: publicUser,
  requireAuth: requireAuth,
  requireRole: requireRole,
  requireCronSecret: requireCronSecret,
  recordAttempt: recordAttempt,
  isRateLimited: isRateLimited,
  pruneAuthAttempts: pruneAuthAttempts,
  LIMITS: LIMITS
};
