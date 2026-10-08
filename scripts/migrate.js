/**
 * Apply the SQL migrations.
 *
 *   node scripts/migrate.js              apply anything not yet applied
 *   node scripts/migrate.js --status     list what is applied and what is not
 *   node scripts/migrate.js --local      also apply supabase/local-shim.sql first
 *
 * Deliberately tiny. Files in supabase/migrations run once each, in name
 * order, inside a transaction, and are recorded in schema_migrations. A file
 * whose checksum has changed since it ran is reported rather than re-applied —
 * editing an applied migration is how two environments silently diverge.
 *
 * 0002_cron.sql needs pg_cron and pg_net, which only exist on Supabase. It is
 * skipped automatically where they are unavailable.
 */

require('../server/env');

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var sql = require('../server/sql');

var DIR = path.join(__dirname, '..', 'supabase', 'migrations');
var STATUS = process.argv.indexOf('--status') > -1;
var LOCAL = process.argv.indexOf('--local') > -1;

function checksum(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function files() {
  return fs.readdirSync(DIR)
    .filter(function (f) { return f.endsWith('.sql'); })
    .sort()
    .map(function (name) {
      var body = fs.readFileSync(path.join(DIR, name), 'utf8');
      return { name: name, body: body, checksum: checksum(body) };
    });
}

async function ensureLedger() {
  await sql.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name        text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )`);
}

async function hasExtension(name) {
  return sql.exists('SELECT 1 FROM pg_available_extensions WHERE name = $1', [name]);
}

async function run() {
  if (LOCAL) {
    var shim = path.join(__dirname, '..', 'supabase', 'local-shim.sql');
    console.log('  applying local-shim.sql (auth.users stand-in)');
    await sql.run(fs.readFileSync(shim, 'utf8'));
  }

  await ensureLedger();

  var applied = {};
  (await sql.many('SELECT * FROM schema_migrations')).forEach(function (r) {
    applied[r.name] = r;
  });

  var list = files();

  if (STATUS) {
    console.log('\n  migration                 state');
    console.log('  ' + '-'.repeat(52));
    list.forEach(function (m) {
      var was = applied[m.name];
      var state = !was ? 'pending'
        : was.checksum === m.checksum ? 'applied ' + was.applied_at.toISOString().slice(0, 10)
          : 'APPLIED BUT EDITED SINCE';
      console.log('  ' + m.name.padEnd(26) + state);
    });
    console.log('');
    return;
  }

  var cronReady = await hasExtension('pg_cron');
  var ran = 0;

  for (var i = 0; i < list.length; i++) {
    /* eslint-disable no-await-in-loop */
    var migration = list[i];
    var previous = applied[migration.name];

    if (previous) {
      if (previous.checksum !== migration.checksum) {
        console.log('  !  ' + migration.name +
          ' was edited after it ran. Add a new migration instead of changing this one.');
      }
      continue;
    }

    if (/cron/.test(migration.name) && !cronReady) {
      console.log('  -  ' + migration.name + ' skipped (pg_cron not available here)');
      continue;
    }

    process.stdout.write('  .  ' + migration.name + ' … ');
    await sql.tx(async function (t) {
      await t.run(migration.body);
      await t.run('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
        [migration.name, migration.checksum]);
    });
    console.log('applied');
    ran++;
  }

  console.log(ran ? '\n  ' + ran + ' migration(s) applied\n' : '\n  Already up to date\n');
}

run()
  .then(function () { return sql.close(); })
  .then(function () { process.exit(0); })
  .catch(function (err) {
    console.error('\n  FAILED  ' + err.message);
    if (err.query) console.error('  query: ' + err.query);
    console.error('');
    process.exit(1);
  });
