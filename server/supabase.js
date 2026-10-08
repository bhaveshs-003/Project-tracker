/**
 * Supabase clients and JWT verification.
 *
 * Two clients, for two different jobs:
 *
 *   admin  — service-role key. Creates users, issues signed Storage URLs.
 *            Bypasses RLS. Must never be exposed to a browser.
 *   anon   — anon key. Used only to exchange a password for a session, which
 *            is the one operation that must run with no privileges.
 *
 * Both are built on first use rather than at import. A missing key then fails
 * the request that needed it, with a message naming the variable — instead of
 * throwing during `require` and taking the health endpoint down with it.
 *
 * Tokens are verified LOCALLY rather than by calling supabase.auth.getUser().
 * That call is a network round-trip, and putting one in front of every request
 * roughly quintuples latency on serverless.
 */

var createClient = require('@supabase/supabase-js').createClient;
var jose = require('jose');

function required(name) {
  var value = process.env[name];
  if (!value) {
    var err = new Error(name + ' is not configured on the server.');
    err.status = 503;
    throw err;
  }
  return value;
}

function baseUrl() {
  return required('SUPABASE_URL').replace(/\/$/, '');
}

// No session persistence on either client: this process is stateless and may
// be a different instance on the next request. Persisting would leak one
// caller's session into another's.
var CLIENT_OPTIONS = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
};

var cache = {};

function admin() {
  if (!cache.admin) {
    cache.admin = createClient(baseUrl(), required('SUPABASE_SERVICE_ROLE_KEY'), CLIENT_OPTIONS);
  }
  return cache.admin;
}

function anon() {
  if (!cache.anon) {
    cache.anon = createClient(baseUrl(), required('SUPABASE_ANON_KEY'), CLIENT_OPTIONS);
  }
  return cache.anon;
}

// ---------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------
function issuer() {
  return baseUrl() + '/auth/v1';
}

function jwks() {
  if (!cache.jwks) {
    cache.jwks = jose.createRemoteJWKSet(new URL(issuer() + '/.well-known/jwks.json'), {
      cooldownDuration: 30000,
      cacheMaxAge: 600000
    });
  }
  return cache.jwks;
}

function sharedSecret() {
  if (!process.env.SUPABASE_JWT_SECRET) return null;
  if (!cache.secret) {
    cache.secret = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET);
  }
  return cache.secret;
}

/**
 * Verify an access token and return its claims, or throw.
 *
 * The verifier is chosen by the token's own `alg` header: current Supabase
 * projects sign asymmetrically (verified against the JWKS), older ones with
 * the shared HS256 secret. Picking by algorithm avoids a doomed network fetch
 * on every request for projects still on the legacy scheme.
 *
 * `audience: 'authenticated'` matters. Without it a token minted for a
 * different audience — a service token, say — would pass on signature alone.
 */
async function verifyAccessToken(token) {
  var options = { issuer: issuer(), audience: 'authenticated' };

  var header;
  try {
    header = jose.decodeProtectedHeader(token);
  } catch {
    throw new Error('Malformed token');
  }

  if (header.alg && header.alg.indexOf('HS') === 0) {
    var secret = sharedSecret();
    if (!secret) throw new Error('Token is HS-signed but SUPABASE_JWT_SECRET is not set');
    return (await jose.jwtVerify(token, secret, options)).payload;
  }

  return (await jose.jwtVerify(token, jwks(), options)).payload;
}

/** Exchange email and password for a session. Never uses the service key. */
function signInWithPassword(email, password) {
  return anon().auth.signInWithPassword({ email: email, password: password });
}

/** Swap a refresh token for a fresh pair. */
function refreshSession(refreshToken) {
  return anon().auth.refreshSession({ refresh_token: refreshToken });
}

/** True when enough is configured to talk to Supabase at all. */
function configured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY &&
    process.env.SUPABASE_ANON_KEY);
}

/**
 * Substitute the clients, so the suites can exercise every route against a
 * local Postgres without a Supabase project. Same seam the mail transport
 * already has. Only ever called from tests/.
 */
function __setForTesting(fakes) {
  if (fakes.admin) cache.admin = fakes.admin;
  if (fakes.anon) cache.anon = fakes.anon;
}

module.exports = {
  get admin() { return admin(); },
  get anon() { return anon(); },
  __setForTesting: __setForTesting,
  get url() { return baseUrl(); },
  get issuer() { return issuer(); },
  configured: configured,
  verifyAccessToken: verifyAccessToken,
  signInWithPassword: signInWithPassword,
  refreshSession: refreshSession
};
