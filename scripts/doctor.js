/**
 * Read-only health check for a configured environment.
 *
 *   node scripts/doctor.js
 *
 * Writes nothing and changes nothing — safe to run against production, which
 * is the point: most of what it reports is specific to a given Supabase
 * project and cannot be known from the source.
 *
 * The one that matters most is the JWT algorithm. If a project signs with the
 * legacy HS256 shared secret and SUPABASE_JWT_SECRET is not set, every request
 * fails authentication with a message that does not say why. This names it.
 *
 * Environment variables are reported by NAME and never by value.
 */

require('../server/env');

var jose = require('jose');

var checks = [];
var warnings = [];

function record(ok, label, detail) {
  checks.push({ ok: ok, label: label, detail: detail });
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  return ok;
}
function note(label, detail) {
  console.log('  --    ' + label + (detail ? '   ' + detail : ''));
}
function warn(label) {
  warnings.push(label);
  console.log('  warn  ' + label);
}
function section(title) { console.log('\n' + title); console.log('  ' + '-'.repeat(60)); }

// ---------------------------------------------------------------
var REQUIRED = [
  'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'
];
var OPTIONAL = [
  'DIRECT_DATABASE_URL', 'SUPABASE_JWT_SECRET', 'SUPABASE_STORAGE_BUCKET',
  'APP_URL', 'CRON_SECRET', 'MAIL_TRANSPORT', 'MAIL_FROM', 'SMTP_HOST', 'SMTP_USER',
  'MAIL_ALLOWLIST', 'NODE_ENV'
];

var SEED_VARS = [
  'SEED_ADMIN_EMAIL', 'SEED_ADMIN_PASSWORD', 'SEED_PARTNER_EMAIL', 'SEED_PARTNER_PASSWORD'
];

var TABLES = [
  'people', 'projects', 'project_resources', 'project_pocs', 'milestones', 'subtasks',
  'milestone_mentions', 'delay_comments', 'attachments', 'pending_uploads',
  'emails', 'audit', 'auth_attempts'
];

/**
 * What is safe to print for a given variable.
 *
 * Deny-listing by name alone was not enough: DIRECT_DATABASE_URL contains
 * neither "SECRET" nor "KEY", so it printed its first 48 characters — which is
 * precisely the part holding the database password. Anything that parses as a
 * URL with credentials is redacted on its shape, not its name.
 */
function safeValue(name, value) {
  if (/SECRET|KEY|PASS|TOKEN/i.test(name)) return '(set)';
  if (value.indexOf('://') > -1) return redactUrl(value);
  return value.slice(0, 48);
}

function redactUrl(raw) {
  try {
    var u = new URL(raw);
    return u.protocol + '//' + (u.username ? u.username + ':****@' : '') +
      u.hostname + ':' + (u.port || '5432') + u.pathname;
  } catch { return '(unparseable)'; }
}

async function run() {
  // ---------------------------------------------------------------
  section('Configuration');
  var missing = REQUIRED.filter(function (name) { return !process.env[name]; });
  record(missing.length === 0, 'required variables set',
    missing.length ? 'missing: ' + missing.join(', ') : REQUIRED.length + ' present');

  OPTIONAL.forEach(function (name) {
    if (process.env[name]) note(name, safeValue(name, process.env[name]));
  });

  // Reported but not required: these are read by scripts/seed.js only, and a
  // gap here fails at the seed step rather than here. Better to say so now.
  var seedMissing = SEED_VARS.filter(function (name) { return !process.env[name]; });
  if (seedMissing.length) {
    warn('seed variables not set (needed by npm run seed): ' + seedMissing.join(', '));
  }

  // Present is not the same as usable. Checking only for emptiness let
  // admin@example.com and a too-short password through to fail at the seed.
  var minPassword = Number(process.env.MIN_PASSWORD_LENGTH || 10);
  SEED_VARS.forEach(function (name) {
    var value = process.env[name];
    if (!value) return;
    if (/PASSWORD/.test(name)) {
      var ok = value.length >= minPassword;
      note(name, value.length + ' characters' +
        (ok ? '' : '  — shorter than the ' + minPassword + '-character minimum'));
      if (!ok) warn(name + ' is too short; npm run seed will refuse it');
    } else {
      note(name, value);
      if (/example\.(com|test|org)$/i.test(value)) {
        warn(name + ' is still the template address (' + value + ')');
      }
    }
  });

  var placeholders = Object.keys(process.env).filter(function (name) {
    return (REQUIRED.indexOf(name) > -1 || OPTIONAL.indexOf(name) > -1) &&
      /PROJECT_REF|YOUR-PASSWORD|\[PASSWORD\]|REGION\.|example\.com|CHANGEME/i.test(
        process.env[name]);
  });
  if (placeholders.length) {
    warn('still holding template text, not a real value: ' + placeholders.join(', '));
  }

  if (missing.length) {
    console.log('\n  Cannot continue without those. See .env.example.\n');
    process.exit(1);
  }

  if (process.env.NODE_ENV === 'production' && process.env.PGSSL_INSECURE === 'true') {
    warn('PGSSL_INSECURE=true in production — the database certificate is not verified');
  }

  note('DATABASE_URL', redactUrl(process.env.DATABASE_URL));
  if (process.env.DIRECT_DATABASE_URL) {
    note('DIRECT_DATABASE_URL', redactUrl(process.env.DIRECT_DATABASE_URL));
  } else {
    warn('DIRECT_DATABASE_URL not set — migrations will run over the transaction pooler');
  }

  var port = (new URL(process.env.DATABASE_URL).port) || '5432';
  if (port !== '6543') {
    warn('DATABASE_URL is on port ' + port + ', not 6543 — the app expects the ' +
      'TRANSACTION pooler');
  }

  // ---------------------------------------------------------------
  section('Database');
  var sql = require('../server/sql');

  var version;
  try {
    version = await sql.value('SELECT version()');
    record(true, 'reachable', String(version).split(' ').slice(0, 2).join(' '));
  } catch (err) {
    record(false, 'reachable', err.message);
    console.log('\n  Cannot continue.\n');
    process.exit(1);
  }

  record(await sql.exists("SELECT 1 FROM pg_extension WHERE extname = 'citext'"),
    'citext installed');

  var present = (await sql.many(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"))
    .map(function (r) { return r.tablename; });
  var absent = TABLES.filter(function (t) { return present.indexOf(t) === -1; });
  record(absent.length === 0, 'all ' + TABLES.length + ' tables present',
    absent.length ? 'missing: ' + absent.join(', ') : '');

  // Must be scoped to public: Supabase keeps its own auth.schema_migrations and
  // realtime.schema_migrations, so an unscoped lookup reports the ledger as
  // present on a completely empty database.
  record(await sql.exists(
    "SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'schema_migrations'"),
  'migration ledger exists');
  if (present.indexOf('schema_migrations') > -1) {
    var applied = await sql.many('SELECT name FROM schema_migrations ORDER BY name');
    note('applied', applied.map(function (r) { return r.name; }).join(', ') || 'none');
  }

  var unprotected = (await sql.many(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = false
        AND c.relname <> 'schema_migrations'`)).map(function (r) { return r.relname; });
  record(unprotected.length === 0, 'RLS enabled on every table',
    unprotected.length ? 'off for: ' + unprotected.join(', ') : '');

  // The foreign key that only exists where Supabase Auth does
  record(await sql.exists(`
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_class f ON f.oid = c.confrelid
      JOIN pg_namespace fn ON fn.oid = f.relnamespace
     WHERE t.relname = 'people' AND f.relname = 'users' AND fn.nspname = 'auth'`),
    'people.user_id → auth.users');

  var counts = await sql.one(`SELECT
      (SELECT count(*) FROM people)   AS people,
      (SELECT count(*) FROM projects) AS projects,
      (SELECT count(*) FROM emails WHERE status <> 'sent') AS queued_mail,
      (SELECT count(*) FROM pending_uploads WHERE claimed_at IS NULL) AS unclaimed`);
  note('rows', 'people ' + counts.people + ' · projects ' + counts.projects +
    ' · queued mail ' + counts.queued_mail + ' · unclaimed uploads ' + counts.unclaimed);

  var admins = Number(await sql.value("SELECT count(*) FROM people WHERE role = 'admin'"));
  record(admins > 0, 'at least one admin account', admins + ' admin(s)');

  // ---------------------------------------------------------------
  section('Auth');
  var supabase = require('../server/supabase');
  var issuer = supabase.issuer;
  note('issuer', issuer);

  // Which algorithm does this project sign with? Everything depends on it.
  var jwksOk = false;
  try {
    var res = await fetch(issuer + '/.well-known/jwks.json');
    if (res.ok) {
      var body = await res.json();
      var keys = body.keys || [];
      jwksOk = keys.length > 0;
      if (jwksOk) {
        record(true, 'JWKS published', keys.length + ' key(s): ' +
          keys.map(function (k) { return k.alg || k.kty; }).join(', '));
      } else {
        note('JWKS endpoint answered but published no keys');
      }
    } else {
      note('JWKS endpoint returned ' + res.status);
    }
  } catch (err) {
    note('JWKS endpoint unreachable', err.message);
  }

  if (!jwksOk) {
    // No asymmetric keys means the project is on the legacy shared secret.
    if (process.env.SUPABASE_JWT_SECRET) {
      record(true, 'legacy HS256 signing, and SUPABASE_JWT_SECRET is set');
    } else {
      record(false, 'legacy HS256 signing but SUPABASE_JWT_SECRET is NOT set',
        'every request will fail authentication');
    }
  }

  // Prove it rather than infer it: sign in and inspect the real token.
  if (process.env.DOCTOR_EMAIL && process.env.DOCTOR_PASSWORD) {
    var signIn = await supabase.signInWithPassword(
      process.env.DOCTOR_EMAIL, process.env.DOCTOR_PASSWORD);

    if (signIn.error || !signIn.data.session) {
      record(false, 'test sign-in', signIn.error ? signIn.error.message : 'no session');
    } else {
      var token = signIn.data.session.access_token;
      var header = jose.decodeProtectedHeader(token);
      record(true, 'test sign-in succeeded', 'token alg=' + header.alg);

      try {
        var claims = await supabase.verifyAccessToken(token);
        record(true, 'the app can verify its own tokens',
          'role=' + ((claims.app_metadata || {}).role || 'none'));
        if (!(claims.app_metadata || {}).role) {
          warn('app_metadata.role is missing — run the seed, which sets it');
        }
      } catch (err) {
        record(false, 'the app can verify its own tokens', err.message);
      }
    }
  } else {
    note('set DOCTOR_EMAIL and DOCTOR_PASSWORD to test a real sign-in');
  }

  // ---------------------------------------------------------------
  section('Storage');
  var uploads = require('../server/uploads');
  var bucket = await supabase.admin.storage.getBucket(uploads.BUCKET);

  if (bucket.error || !bucket.data) {
    record(false, 'bucket "' + uploads.BUCKET + '" exists',
      (bucket.error && bucket.error.message) || 'not found — run npm run setup:storage');
  } else {
    record(true, 'bucket "' + uploads.BUCKET + '" exists');
    record(bucket.data.public === false, 'bucket is private',
      bucket.data.public ? 'PUBLIC — every uploaded file is world-readable' : '');
    record(Number(bucket.data.file_size_limit) === uploads.MAX_BYTES, 'size limit',
      bucket.data.file_size_limit
        ? Math.round(Number(bucket.data.file_size_limit) / 1024 / 1024) + 'MB'
        : 'none set');
    record((bucket.data.allowed_mime_types || []).length > 0, 'MIME allowlist',
      (bucket.data.allowed_mime_types || []).length + ' types');
  }

  // ---------------------------------------------------------------
  section('Mail');
  var transport = require('../server/mail/transport');
  note('transport', transport.config.transport);
  note('from', transport.config.from);

  if (transport.config.transport === 'log') {
    warn('MAIL_TRANSPORT=log — notifications are written to disk, not sent');
  } else {
    var smtp = transport.smtpSettings();
    record(!!smtp.passLength, 'SMTP password set',
      smtp.user + ' @ ' + smtp.host + ':' + smtp.port);
  }
  if (transport.config.allowlist.length) {
    warn('MAIL_ALLOWLIST is set — mail to anyone else is silently skipped');
  }

  if (process.env.NODE_ENV === 'production' && !process.env.CRON_SECRET) {
    warn('CRON_SECRET is not set — scheduled work cannot run');
  }

  // ---------------------------------------------------------------
  var failed = checks.filter(function (c) { return !c.ok; });
  console.log('\n' + '='.repeat(64));
  console.log('  ' + (checks.length - failed.length) + '/' + checks.length + ' checks passed' +
    (warnings.length ? ', ' + warnings.length + ' warning(s)' : ''));
  if (failed.length) {
    console.log('\n  Problems:');
    failed.forEach(function (c) { console.log('   · ' + c.label + (c.detail ? ' — ' + c.detail : '')); });
  }
  if (warnings.length) {
    console.log('\n  Warnings:');
    warnings.forEach(function (w) { console.log('   · ' + w); });
  }
  console.log('');

  await sql.close();
  process.exit(failed.length ? 1 : 0);
}

run().catch(function (err) {
  console.error('\n  DOCTOR FAILED  ' + err.message + '\n');
  process.exit(2);
});
