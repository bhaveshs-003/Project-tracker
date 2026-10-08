/**
 * The outbox.
 *
 * enqueue() is an ordinary INSERT, so it runs inside the same transaction as
 * the state change that caused it: the approval and the intent to notify
 * commit together, or neither does. That property is the whole point and is
 * unchanged from the SQLite version — which is why enqueue takes the
 * transaction handle.
 *
 * What changed is draining. There is no long-running process on serverless, so
 * setInterval is gone and a cron calls drain() instead. Two cron invocations
 * can overlap, so rows are now *claimed* before they are sent:
 *
 *   UNIQUE dedupe_key  stops the same message being enqueued twice.
 *   locked_until       stops a queued message being sent twice.
 *
 * Those are different races. The old worker only had the first.
 */

var sql = require('../sql');
var transport = require('./transport');

var MAX_ATTEMPTS = 5;
var BATCH = 20;
var LOCK_MINUTES = 2;

/**
 * Queue one message. Returns true if it was queued, false if an identical one
 * already exists — the UNIQUE dedupe_key does the work, so callers do not need
 * to check first and cannot race.
 *
 * `runner` is a sql.tx handle when enqueueing inside a transaction.
 */
async function enqueue(entry, runner) {
  var db = runner || sql;
  var inserted = await db.run(
    `INSERT INTO emails
       (event, dedupe_key, to_email, to_name, subject, text_body, html_body,
        project_id, milestone_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      entry.event,
      entry.dedupeKey,
      entry.to,
      entry.toName || '',
      entry.subject,
      entry.text,
      entry.html || '',
      entry.projectId || null,
      entry.milestoneId || null
    ]);
  return inserted > 0;
}

/** Exponential backoff: ~1, 2, 4, 8, 16 minutes. */
function backoffMinutes(attempts) {
  return Math.pow(2, attempts - 1);
}

/**
 * Take ownership of up to `limit` due messages.
 *
 * SKIP LOCKED is what makes concurrent drains safe: a second invocation walks
 * past rows the first is already holding instead of blocking on them or — far
 * worse — selecting them and sending a duplicate.
 */
async function claim(runner, limit) {
  return runner.many(
    `UPDATE emails SET locked_until = now() + ($2 || ' minutes')::interval
      WHERE id IN (
        SELECT id FROM emails
         WHERE status <> 'sent'
           AND attempts < $3
           AND next_attempt_at <= now()
           AND (locked_until IS NULL OR locked_until < now())
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [limit || BATCH, String(LOCK_MINUTES), MAX_ATTEMPTS]);
}

async function deliver(row) {
  try {
    await transport.send({
      to: row.to_email,
      toName: row.to_name,
      subject: row.subject,
      text: row.text_body,
      html: row.html_body
    });
    await sql.run(
      `UPDATE emails SET status = 'sent', attempts = attempts + 1, last_error = '',
              sent_at = now(), locked_until = NULL
        WHERE id = $1`, [row.id]);
    return true;
  } catch (err) {
    var attempts = row.attempts + 1;
    await sql.run(
      `UPDATE emails SET status = 'failed', attempts = $2, last_error = $3,
              next_attempt_at = now() + ($4 || ' minutes')::interval,
              locked_until = NULL
        WHERE id = $1`,
      [row.id, attempts, String(err && err.message || err).slice(0, 500),
        String(backoffMinutes(attempts))]);

    console.error('[mail] attempt ' + attempts + '/' + MAX_ATTEMPTS +
      ' failed for #' + row.id + ' → ' + row.to_email + ': ' + (err && err.message));
    return false;
  }
}

/** Send whatever is due. Returns { sent, failed, considered }. */
async function drain(limit) {
  // The claim commits before any sending starts, so the lock is visible to a
  // concurrent drain even while this one is still talking to the mail server.
  var rows = await sql.tx(function (t) { return claim(t, limit); });

  var sent = 0, failed = 0;
  for (var i = 0; i < rows.length; i++) {
    // Sequential on purpose: a queue this size gains nothing from concurrency,
    // and one connection at a time is kinder to rate-limited providers.
    /* eslint-disable no-await-in-loop */
    (await deliver(rows[i])) ? sent++ : failed++;
  }
  return { sent: sent, failed: failed, considered: rows.length };
}

/** Release locks held by an invocation that died mid-send. */
async function releaseStaleLocks() {
  return sql.run(
    "UPDATE emails SET locked_until = NULL WHERE locked_until IS NOT NULL AND locked_until < now()");
}

async function stats() {
  var rows = await sql.many('SELECT status, count(*)::int AS n FROM emails GROUP BY status');
  var out = { queued: 0, sent: 0, failed: 0 };
  rows.forEach(function (r) { out[r.status] = r.n; });
  return out;
}

module.exports = {
  enqueue: enqueue,
  drain: drain,
  releaseStaleLocks: releaseStaleLocks,
  stats: stats,
  MAX_ATTEMPTS: MAX_ATTEMPTS,
  BATCH: BATCH
};
