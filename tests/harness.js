/**
 * Test bootstrap: the real server, against a real Postgres, with Supabase
 * faked only at its two edges.
 *
 * What is REAL here — so a bug in any of it fails a test:
 *   · the schema, applied from supabase/migrations
 *   · every query, transaction and rule
 *   · JWT verification, including signature, issuer and audience
 *   · cookie handling, rate limiting, validation, error shaping
 *
 * What is FAKED — because it belongs to a hosted service:
 *   · Supabase Auth's password store  (tokens are minted here with HS256,
 *     then verified by the real code path via SUPABASE_JWT_SECRET)
 *   · Supabase Storage                (an in-memory bucket)
 *
 * The fake is deliberately shallow. It is not a reimplementation of Supabase;
 * it only answers the handful of calls the app actually makes.
 */

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var { execFileSync } = require('child_process');
var jose = require('jose');

var ROOT = path.join(__dirname, '..');
var DB_NAME = process.env.TEST_DB || 'functional_tool_test';
var DB_URL = process.env.TEST_DATABASE_URL || ('postgres://localhost:5432/' + DB_NAME);

/**
 * Refuse to run against anything that is not a local database.
 *
 * resetDatabase() runs `dropdb`. Until now that was safe because this file
 * overrides DATABASE_URL with a local one — safe by accident. With production
 * credentials sitting in .env, an override of TEST_DATABASE_URL, a stray
 * export, or someone editing the default would be enough to drop a live
 * database. This makes it impossible rather than unlikely.
 */
(function refuseRemote() {
  var host = '';
  try {
    host = new URL(DB_URL).hostname;
  } catch {
    throw new Error('TEST_DATABASE_URL is not a valid URL: ' + DB_URL);
  }

  var local = ['localhost', '127.0.0.1', '::1', '0.0.0.0', ''];
  if (local.indexOf(host) === -1) {
    console.error('\n  REFUSING TO RUN\n');
    console.error('  The tests create and DROP their database. The configured host is');
    console.error('  "' + host + '", which is not local.\n');
    console.error('  Point TEST_DATABASE_URL at a local Postgres, or unset it.\n');
    process.exit(1);
  }

  if (/supabase|pooler|amazonaws|\.co$|\.io$|\.com$/i.test(DB_URL)) {
    console.error('\n  REFUSING TO RUN — the test database URL looks remote.\n');
    process.exit(1);
  }
})();

var JWT_SECRET = 'test-secret-'.repeat(4);
var SUPABASE_URL = 'http://supabase.test';

// Must be set before anything requires sql.js or supabase.js
process.env.DATABASE_URL = DB_URL;
process.env.SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_ANON_KEY = 'test-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';
process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
process.env.MAIL_TRANSPORT = 'log';
process.env.MAIL_WORKER_MS = 'off';
process.env.CRON_SECRET = 'test-cron-secret';
process.env.NODE_ENV = 'test';
process.env.MIN_PASSWORD_LENGTH = '10';

// ---------------------------------------------------------------
// Database
// ---------------------------------------------------------------
function psql(args, input) {
  return execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q'].concat(args), {
    input: input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
  });
}

function resetDatabase() {
  try { execFileSync('dropdb', ['--if-exists', DB_NAME], { stdio: 'ignore' }); } catch { /* fine */ }
  execFileSync('createdb', [DB_NAME], { stdio: 'inherit' });
  psql(['-d', DB_NAME, '-f', path.join(ROOT, 'supabase', 'local-shim.sql')]);
  psql(['-d', DB_NAME, '-f', path.join(ROOT, 'supabase', 'migrations', '0001_init.sql')]);
}

// ---------------------------------------------------------------
// Fake Supabase Auth
//
// Holds users in memory and mints real HS256 JWTs. The app verifies them with
// its real verifier, so a broken issuer, audience or signature check still
// shows up as a failing test.
// ---------------------------------------------------------------
var authUsers = new Map();      // id -> { id, email, password, app_metadata }

/**
 * The fake also writes through to the local auth.users stand-in.
 *
 * people.user_id has a real foreign key to auth.users. On Supabase that table
 * is maintained by the Auth service; here it is the shim, so the double has to
 * keep it in step — otherwise anything that creates an account (scripts/seed.js,
 * POST /api/people) fails on a constraint that would be perfectly happy in
 * production, and the double would be hiding the real behaviour rather than
 * reproducing it.
 *
 * Required lazily: sql.js reads DATABASE_URL when it loads, and that is not set
 * until a few lines above this one.
 */
function shim() {
  return require(path.join(ROOT, 'server', 'sql.js'));
}

/**
 * auth.users is the store, not an in-memory Map.
 *
 * Supabase's user store outlives a process; a Map does not. With a Map, a
 * second run of scripts/seed.js saw no users, tried to create them again, and
 * collided on the email — so the script's "idempotent" claim could never be
 * tested. Reading and writing the shim table reproduces what Supabase
 * actually does across invocations.
 */
async function loadAuthUser(where, param) {
  var row = await shim().one(
    'SELECT * FROM auth.users WHERE ' + where + ' LIMIT 1', [param]);
  return row ? fromRow(row) : null;
}

function fromRow(row) {
  return {
    id: row.id,
    email: row.email,
    password: row.encrypted_password,     // the double stores it in clear; Supabase does not
    app_metadata: row.raw_app_meta_data || {}
  };
}

async function mintAccessToken(user, expiresInSeconds) {
  return new jose.SignJWT({
    role: 'authenticated',
    email: user.email,
    app_metadata: user.app_metadata || {}
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(user.id)
    .setIssuer(SUPABASE_URL + '/auth/v1')
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + (expiresInSeconds || 3600))
    .sign(new TextEncoder().encode(JWT_SECRET));
}

var refreshTokens = new Map();   // refresh token -> user id
var recoveryHashes = new Map();  // token_hash -> email, as the reset email carries

async function sessionFor(user, expiresIn) {
  var refresh = crypto.randomUUID();
  refreshTokens.set(refresh, user.id);
  return {
    access_token: await mintAccessToken(user, expiresIn),
    refresh_token: refresh,
    expires_in: expiresIn || 3600,
    user: { id: user.id, email: user.email, app_metadata: user.app_metadata || {} }
  };
}

var ok = function (data) { return { data: data, error: null }; };
var fail = function (message, status) {
  return { data: { user: null, session: null }, error: { message: message, status: status || 400 } };
};

function fakeAuthClient() {
  return {
    auth: {
      signInWithPassword: async function (c) {
        var user = await loadAuthUser('email = $1', String(c.email).toLowerCase());
        if (!user || user.password !== c.password) return fail('Invalid login credentials', 400);
        authUsers.set(user.id, user);
        return ok({ user: user, session: await sessionFor(user) });
      },
      refreshSession: async function (c) {
        var id = refreshTokens.get(c.refresh_token);
        var user = id ? await loadAuthUser('id = $1', id) : null;
        if (!user) return fail('Invalid refresh token', 401);
        refreshTokens.delete(c.refresh_token);
        return ok({ user: user, session: await sessionFor(user) });
      },
      resetPasswordForEmail: async function (email) {
        // Stand in for the emailed link: mint a hash the test can use
        recoveryHashes.set('recovery-' + email, String(email).toLowerCase());
        return ok({});
      },
      // The real flow hands back a token_hash in the emailed link; the hash
      // alone identifies the account, so no email is supplied.
      verifyOtp: async function (c) {
        var hash = c.token_hash || c.token;
        var email = recoveryHashes.get(hash);
        if (!email) return fail('Token has expired or is invalid', 401);
        var user = await loadAuthUser('email = $1', email);
        if (!user) return fail('User not found', 404);
        recoveryHashes.delete(hash);        // single use, as Supabase does
        return ok({ user: user, session: await sessionFor(user) });
      },
      admin: {
        createUser: async function (attrs) {
          var email = String(attrs.email).toLowerCase();
          if (await loadAuthUser('email = $1', email)) {
            return { data: { user: null },
              error: { message: 'A user with this email already exists', status: 422 } };
          }
          var user = {
            id: crypto.randomUUID(),
            email: email,
            password: attrs.password,
            app_metadata: attrs.app_metadata || {}
          };
          await shim().run(
            `INSERT INTO auth.users (id, email, encrypted_password, raw_app_meta_data)
             VALUES ($1, $2, $3, $4)`,
            [user.id, user.email, user.password, JSON.stringify(user.app_metadata)]);
          authUsers.set(user.id, user);
          return ok({ user: user });
        },
        updateUserById: async function (id, attrs) {
          var user = await loadAuthUser('id = $1', id);
          if (!user) return { data: { user: null }, error: { message: 'User not found', status: 404 } };

          if (attrs.password) user.password = attrs.password;
          if (attrs.email) user.email = String(attrs.email).toLowerCase();
          if (attrs.app_metadata) user.app_metadata = attrs.app_metadata;

          await shim().run(
            `UPDATE auth.users SET email = $2, encrypted_password = $3, raw_app_meta_data = $4
              WHERE id = $1`,
            [id, user.email, user.password, JSON.stringify(user.app_metadata)]);
          authUsers.set(user.id, user);
          return ok({ user: user });
        },
        deleteUser: async function (id) {
          if (!(await loadAuthUser('id = $1', id))) {
            return { data: { user: null }, error: { message: 'User not found', status: 404 } };
          }
          authUsers.delete(id);
          await shim().run('DELETE FROM auth.users WHERE id = $1', [id]);
          return ok({ user: null });
        },
        listUsers: async function () {
          var rows = await shim().many('SELECT * FROM auth.users ORDER BY created_at');
          rows.forEach(function (r) { authUsers.set(r.id, fromRow(r)); });
          return ok({ users: rows.map(fromRow) });
        },
        signOut: async function () { return { data: null, error: null }; }
      }
    }
  };
}

// ---------------------------------------------------------------
// Fake Supabase Storage — an in-memory bucket
// ---------------------------------------------------------------
var objects = new Map();        // path -> { size, body }
var uploadTokens = new Map();   // token -> path

function fakeStorage() {
  return {
    from: function () {
      return {
        createSignedUploadUrl: async function (objectPath) {
          var token = crypto.randomUUID();
          uploadTokens.set(token, objectPath);
          return ok({ signedUrl: '/__test_upload/' + token, token: token, path: objectPath });
        },
        createSignedUrl: async function (objectPath, ttl, opts) {
          if (!objects.has(objectPath)) {
            return { data: null, error: { message: 'Object not found', status: 404 } };
          }
          var name = opts && opts.download ? String(opts.download) : '';
          // The browser suite points this at its own server so a click can
          // actually fetch bytes; otherwise the host does not resolve and a
          // download test would fail for the wrong reason.
          var base = process.env.TEST_STORAGE_BASE || SUPABASE_URL;
          return ok({
            signedUrl: base + '/storage/v1/object/sign/' + objectPath +
              '?token=test&download=' + encodeURIComponent(name)
          });
        },
        list: async function (dir, opts) {
          var prefix = dir ? dir + '/' : '';
          var search = (opts && opts.search) || '';
          var found = [];
          objects.forEach(function (meta, key) {
            if (key.indexOf(prefix) !== 0) return;
            var name = key.slice(prefix.length);
            if (name.indexOf('/') > -1) return;
            if (search && name !== search) return;
            found.push({ name: name, metadata: { size: meta.size } });
          });
          return ok(found);
        },
        remove: async function (paths) {
          paths.forEach(function (p) { objects.delete(p); });
          return ok(paths.map(function (p) { return { name: p }; }));
        }
      };
    }
  };
}

/** Stand in for the browser's PUT to the signed URL. */
function putObject(token, bytes) {
  var objectPath = uploadTokens.get(token);
  if (!objectPath) throw new Error('unknown upload token');
  objects.set(objectPath, { size: bytes, body: Buffer.alloc(0) });
  return objectPath;
}

// ---------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------
function install() {
  var supabase = require(path.join(ROOT, 'server', 'supabase.js'));
  var client = fakeAuthClient();
  client.storage = fakeStorage();
  supabase.__setForTesting({ admin: client, anon: client });
  return supabase;
}

/**
 * Create an auth user and its people row, the way scripts/seed.js would.
 *
 * The row in auth.users is written too: people.user_id has a real foreign key
 * to it, and on Supabase that table is populated by the Auth service. The
 * local shim has to be filled in by hand or the constraint fires — which is
 * the constraint doing exactly its job.
 */
async function createAccount(sql, supabase, attrs) {
  var created = await supabase.admin.auth.admin.createUser({
    email: attrs.email,
    password: attrs.password,
    app_metadata: { role: attrs.role }
  });
  if (created.error) throw new Error(created.error.message);

  // The fake's createUser already wrote the auth.users row
  return sql.one(
    `INSERT INTO people (user_id, name, job_title, email, kind, role)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [created.data.user.id, attrs.name, attrs.jobTitle || 'Tester',
      String(attrs.email).toLowerCase(), attrs.role === 'admin' ? 'company' : 'partner',
      attrs.role]);
}

module.exports = {
  DB_URL: DB_URL,
  DB_NAME: DB_NAME,
  JWT_SECRET: JWT_SECRET,
  SUPABASE_URL: SUPABASE_URL,
  resetDatabase: resetDatabase,
  install: install,
  recoveryHashes: recoveryHashes,
  createAccount: createAccount,
  mintAccessToken: mintAccessToken,
  putObject: putObject,
  objects: objects,
  authUsers: authUsers
};
