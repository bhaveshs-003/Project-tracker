/**
 * The database seam.
 *
 * Everything that touches Postgres goes through here, so connection policy is
 * decided once rather than in 135 places.
 *
 * Two things in this file exist specifically because the app runs serverless,
 * and both are the kind of problem that only appears under load:
 *
 *  1. Connect through Supavisor's TRANSACTION pooler (port 6543), not the
 *     direct port. Every cold start opens a connection; direct connections are
 *     a small fixed pool and would be exhausted by a traffic spike.
 *
 *  2. Transaction-mode pooling multiplexes one backend across many clients, so
 *     a named prepared statement created by one request is not there for the
 *     next — and worse, the name collides. `pg` names statements automatically
 *     whenever you pass a `name`, and some helpers do it implicitly, so the
 *     rule here is: never name a statement. Symptom if this is got wrong:
 *     intermittent `prepared statement "S_1" already exists`, only under
 *     concurrency, impossible to reproduce serially.
 */

var pg = require('pg');

// node-postgres hands back `bigint` as a string because a 64-bit integer does
// not fit a JS number. Every id in this schema is a bigint and the client
// compares them with ===, so parse them. Safe up to 2^53, which this app will
// not reach; beyond that the string would be the correct answer anyway.
pg.types.setTypeParser(pg.types.builtins.INT8, function (value) {
  var n = Number(value);
  return Number.isSafeInteger(n) ? n : value;
});

// `date` columns must stay calendar dates. The default parser turns them into
// a JS Date at local midnight, which shifts to the previous day the moment the
// server runs west of UTC — exactly the bug the move off string dates was
// meant to remove.
pg.types.setTypeParser(pg.types.builtins.DATE, function (value) { return value; });

var connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. See .env.example.');
}

var isLocal = /localhost|127\.0\.0\.1/.test(connectionString);

/**
 * TLS for the remote connection.
 *
 * Certificates are verified against the system CA store. The usual
 * `rejectUnauthorized: false` advice accepts *any* certificate, which means a
 * machine between here and Supabase can read every query and every row — not
 * a trade worth making for a database on the public internet.
 *
 * SUPABASE_CA_CERT pins a specific CA if the system store does not cover the
 * pooler. PGSSL_INSECURE=true turns verification off, and is deliberately
 * named so that choosing it is visible in the environment rather than hidden
 * in a source file.
 */
function tlsOptions() {
  if (isLocal) return false;

  if (process.env.PGSSL_INSECURE === 'true') {
    console.warn('[pg] PGSSL_INSECURE=true — the server certificate is NOT being verified');
    return { rejectUnauthorized: false };
  }

  var options = { rejectUnauthorized: true };
  if (process.env.SUPABASE_CA_CERT) {
    options.ca = process.env.SUPABASE_CA_CERT.replace(/\\n/g, '\n');
  }
  return options;
}

var pool = new pg.Pool({
  connectionString: connectionString,
  ssl: tlsOptions(),
  // Serverless: each instance handles one request at a time, so a large pool
  // per instance just holds connections open across the whole fleet.
  max: Number(process.env.PG_POOL_MAX || (process.env.VERCEL ? 1 : 10)),
  idleTimeoutMillis: Number(process.env.PG_IDLE_MS || 10000),
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000),
  // Without this a hung query holds the connection until the socket dies
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 15000),
  query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 15000),
  allowExitOnIdle: true
});

// An idle client erroring out must not take the process with it
pool.on('error', function (err) {
  console.error('[pg] idle client error:', err.message);
});

var SLOW_MS = Number(process.env.PG_SLOW_QUERY_MS || 500);

function describe(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** Run one statement. `runner` is the pool, or a client inside a transaction. */
async function exec(runner, text, params) {
  var started = Date.now();
  try {
    // No `name` property, ever — see the note at the top of this file.
    var result = await runner.query({ text: text, values: params || [] });
    var elapsed = Date.now() - started;
    if (elapsed >= SLOW_MS) {
      console.warn('[pg] slow ' + elapsed + 'ms: ' + describe(text));
    }
    return result;
  } catch (err) {
    // The driver's message alone ("duplicate key value violates unique
    // constraint") does not say which query, which is useless in a log.
    err.query = describe(text);
    throw err;
  }
}

function wrap(runner) {
  return {
    /** The single row, or null. Throws if the query returned more than one. */
    one: async function (text, params) {
      var result = await exec(runner, text, params);
      if (result.rows.length > 1) {
        throw new Error('sql.one matched ' + result.rows.length + ' rows: ' + describe(text));
      }
      return result.rows[0] || null;
    },

    many: async function (text, params) {
      return (await exec(runner, text, params)).rows;
    },

    /** Number of rows affected. */
    run: async function (text, params) {
      return (await exec(runner, text, params)).rowCount;
    },

    /** First column of the first row, or null — for COUNT(*) and friends. */
    value: async function (text, params) {
      var row = (await exec(runner, text, params)).rows[0];
      if (!row) return null;
      return row[Object.keys(row)[0]];
    },

    exists: async function (text, params) {
      return (await exec(runner, text, params)).rows.length > 0;
    }
  };
}

var base = wrap(pool);

/**
 * Run `fn` inside one transaction on one checked-out client.
 *
 * The callback receives a sql-shaped object bound to that client, so calls
 * inside look identical to calls outside — which matters, because the outbox
 * relies on enqueueing in the same transaction as the state change that caused
 * it, and that only holds if both run on the same connection.
 */
async function tx(fn) {
  var client = await pool.connect();
  var scoped = wrap(client);
  try {
    await client.query('BEGIN');
    var out = await fn(scoped);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // A failed rollback means the connection is unusable; releasing it with
      // an error argument destroys it rather than returning it to the pool.
      client.release(rollbackErr);
      throw err;
    }
    throw err;
  } finally {
    // release() is idempotent; if the catch above already destroyed it this
    // is a no-op.
    client.release();
  }
}

async function healthy() {
  try {
    await base.value('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function close() {
  await pool.end();
}

module.exports = {
  one: base.one,
  many: base.many,
  run: base.run,
  value: base.value,
  exists: base.exists,
  tx: tx,
  healthy: healthy,
  close: close,
  pool: pool
};
