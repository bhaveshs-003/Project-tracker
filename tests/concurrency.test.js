/**
 * The races. Both of these only appear under concurrency, which is exactly
 * why they need a test rather than a careful read.
 *
 *   node tests/concurrency.test.js
 *
 * 1. Connection pooling. Supabase's transaction pooler multiplexes one backend
 *    across many clients, so a *named* prepared statement created by one
 *    request is not there for the next — and the name collides. The symptom is
 *    intermittent `prepared statement "S_1" already exists` under load and
 *    nothing at all when testing serially.
 *
 * 2. Duplicate sends. The UNIQUE dedupe_key stops a message being enqueued
 *    twice. It does nothing about two overlapping cron invocations both
 *    picking up the same queued row and sending it. That is what the
 *    claim/SKIP LOCKED path exists for.
 */

var harness = require('./harness');

var pass = 0, fail = 0;
var failures = [];

function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else {
    fail++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  FAIL  ' + name + (detail ? '  ' + detail : ''));
  }
}

(async function () {
  harness.resetDatabase();
  var supabase = harness.install();

  var sql = require('../server/sql');
  var outbox = require('../server/mail/outbox');
  var transport = require('../server/mail/transport');

  // ---------------------------------------------------------------
  console.log('\n--- 1. pooling under concurrency ---');
  var admin = await harness.createAccount(sql, supabase, {
    email: 'conc@example.test', password: 'AdminPassword1', name: 'Conc Admin', role: 'admin'
  });

  await sql.run(
    `INSERT INTO projects (code, title, type, status) VALUES ('CONC-1','Concurrency','Migration','In-Progress')`);

  var PARALLEL = 50;
  var started = Date.now();
  var results = await Promise.allSettled(Array.from({ length: PARALLEL }, function (_, i) {
    // Deliberately varied shapes: identical SQL would let a single cached plan
    // paper over the problem this is looking for.
    return i % 3 === 0
      ? sql.many('SELECT * FROM projects WHERE code = $1', ['CONC-1'])
      : i % 3 === 1
        ? sql.one('SELECT count(*)::int AS n FROM people WHERE role = $1', ['admin'])
        : sql.value('SELECT $1::int + $2::int', [i, 1]);
  }));

  var rejected = results.filter(function (r) { return r.status === 'rejected'; });
  check(PARALLEL + ' parallel queries all succeed', rejected.length === 0,
    rejected.length ? rejected[0].reason.message : (Date.now() - started) + 'ms');
  check('  no prepared-statement collisions',
    !rejected.some(function (r) { return /prepared statement/i.test(r.reason.message); }),
    rejected.map(function (r) { return r.reason.message; }).slice(0, 2).join(' | '));

  // Concurrent transactions must not interleave on one connection
  var txResults = await Promise.allSettled(Array.from({ length: 20 }, function (_, i) {
    return sql.tx(async function (t) {
      await t.run(
        `INSERT INTO projects (code, title, type) VALUES ($1, $2, 'Migration')`,
        ['TX-' + i, 'Tx project ' + i]);
      return t.value('SELECT count(*)::int FROM projects');
    });
  }));
  check('20 concurrent transactions all commit',
    txResults.filter(function (r) { return r.status === 'rejected'; }).length === 0,
    (txResults.find(function (r) { return r.status === 'rejected'; }) || {}).reason);
  check('  and every row landed',
    Number(await sql.value("SELECT count(*)::int FROM projects WHERE code LIKE 'TX-%'")) === 20);

  // A failing transaction must roll back without poisoning the pool
  var failures_ = await Promise.allSettled(Array.from({ length: 10 }, function (_, i) {
    return sql.tx(async function (t) {
      await t.run(`INSERT INTO projects (code, title, type) VALUES ($1,'Doomed','Migration')`,
        ['ROLL-' + i]);
      throw new Error('deliberate');
    });
  }));
  check('10 concurrent rollbacks all throw',
    failures_.every(function (r) { return r.status === 'rejected'; }));
  check('  and wrote nothing',
    Number(await sql.value("SELECT count(*)::int FROM projects WHERE code LIKE 'ROLL-%'")) === 0);
  check('  leaving the pool usable', (await sql.value('SELECT 1')) === 1);

  // ---------------------------------------------------------------
  console.log('\n--- 2. the outbox duplicate-send race ---');

  var QUEUED = 30;
  for (var i = 0; i < QUEUED; i++) {
    /* eslint-disable no-await-in-loop */
    await outbox.enqueue({
      event: 'test.message',
      dedupeKey: 'test:' + i,
      to: 'someone' + i + '@example.test',
      toName: 'Someone ' + i,
      subject: 'Message ' + i,
      text: 'Body ' + i
    });
  }
  check(QUEUED + ' messages queued',
    Number(await sql.value("SELECT count(*)::int FROM emails WHERE status = 'queued'")) === QUEUED);

  check('enqueueing the same dedupe_key twice is a no-op',
    (await outbox.enqueue({
      event: 'test.message', dedupeKey: 'test:0',
      to: 'someone0@example.test', subject: 'Message 0', text: 'Body 0'
    })) === false);

  // Count every delivery attempt, whoever makes it
  var deliveries = new Map();
  transport.setTransportForTesting(async function (message) {
    deliveries.set(message.subject, (deliveries.get(message.subject) || 0) + 1);
    // Hold the "connection" open so the drains genuinely overlap rather than
    // finishing one after another
    await new Promise(function (r) { setTimeout(r, 5); });
    return { transport: 'test' };
  });

  // Four overlapping cron invocations, the shape pg_cron produces if one run
  // is slow and the next fires anyway.
  var drains = await Promise.all([outbox.drain(), outbox.drain(), outbox.drain(), outbox.drain()]);
  var totalSent = drains.reduce(function (sum, d) { return sum + d.sent; }, 0);

  var duplicated = [...deliveries.entries()].filter(function (e) { return e[1] > 1; });
  check('four concurrent drains send each message exactly once',
    duplicated.length === 0,
    duplicated.length ? JSON.stringify(duplicated.slice(0, 3)) : 'no duplicates');
  check('  and between them cover the whole queue',
    deliveries.size === QUEUED, deliveries.size + ' of ' + QUEUED);
  check('  with the totals agreeing', totalSent === QUEUED, totalSent + ' reported sent');
  check('  nothing left queued',
    Number(await sql.value("SELECT count(*)::int FROM emails WHERE status <> 'sent'")) === 0);
  check('  and no lock left held',
    Number(await sql.value('SELECT count(*)::int FROM emails WHERE locked_until IS NOT NULL')) === 0);

  // ---------------------------------------------------------------
  console.log('\n--- 3. a failing send backs off rather than spinning ---');
  await outbox.enqueue({
    event: 'test.failing', dedupeKey: 'failing:1',
    to: 'broken@example.test', subject: 'Will fail', text: 'x'
  });
  transport.setTransportForTesting(async function () { throw new Error('mail server is down'); });

  var first = await outbox.drain();
  check('the failure is recorded, not thrown', first.failed === 1, JSON.stringify(first));

  var row = await sql.one("SELECT * FROM emails WHERE dedupe_key = 'failing:1'");
  check('  status is failed with the reason kept',
    row.status === 'failed' && /mail server is down/.test(row.last_error), row.last_error);
  check('  attempts incremented', row.attempts === 1, String(row.attempts));
  check('  the lock was released', row.locked_until === null);
  check('  and it is not retried immediately',
    (await outbox.drain()).considered === 0, 'backoff should hold it');

  await sql.run("UPDATE emails SET next_attempt_at = now() - interval '1 hour' WHERE dedupe_key = 'failing:1'");
  check('  but is retried once the backoff elapses', (await outbox.drain()).considered === 1);

  await sql.run("UPDATE emails SET attempts = 5, next_attempt_at = now() - interval '1 hour' WHERE dedupe_key = 'failing:1'");
  check('  and is abandoned after the attempt limit', (await outbox.drain()).considered === 0);

  console.log('\n================  ' + pass + ' passed, ' + fail + ' failed  ================');
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(function (f) { console.log('  · ' + f); });
  }

  await sql.close();
  process.exit(fail ? 1 : 0);
})().catch(function (err) {
  console.error('\nHARNESS ERROR:', err.stack || err.message);
  process.exit(2);
});
