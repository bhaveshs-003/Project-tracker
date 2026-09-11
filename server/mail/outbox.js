/**
 * The outbox.
 *
 * enqueue() is a local SQLite insert, so it can safely run inside the same
 * transaction as the state change that caused it: the approval and the intent
 * to notify commit together, or neither does.
 *
 * drain() runs separately on a timer. Nothing in the request path ever waits on
 * a mail server, and a failed send is retried rather than lost.
 */

var db = require('../db').db;
var transport = require('./transport');

var MAX_ATTEMPTS = 5;
var BATCH = 20;

/**
 * Queue one message. Returns true if it was queued, false if an identical one
 * already exists — the UNIQUE dedupe_key does the work, so callers do not need
 * to check first and cannot race.
 */
function enqueue(entry) {
  var result = db.prepare(`
    INSERT OR IGNORE INTO emails
      (event, dedupe_key, to_email, to_name, subject, text_body, html_body,
       project_id, milestone_id, created_at, next_attempt_at)
    VALUES (@event, @dedupeKey, @to, @toName, @subject, @text, @html,
            @projectId, @milestoneId, @createdAt, 0)`).run({
    event: entry.event,
    dedupeKey: entry.dedupeKey,
    to: entry.to,
    toName: entry.toName || '',
    subject: entry.subject,
    text: entry.text,
    html: entry.html || '',
    projectId: entry.projectId || null,
    milestoneId: entry.milestoneId || null,
    createdAt: new Date().toISOString()
  });
  return result.changes > 0;
}

/** Exponential backoff: ~1, 2, 4, 8, 16 minutes. */
function backoffMs(attempts) {
  return Math.pow(2, attempts - 1) * 60 * 1000;
}

function pending(limit) {
  return db.prepare(`SELECT * FROM emails
    WHERE status != 'sent' AND attempts < ? AND next_attempt_at <= ?
    ORDER BY id LIMIT ?`).all(MAX_ATTEMPTS, Date.now(), limit || BATCH);
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
    db.prepare(`UPDATE emails SET status = 'sent', attempts = attempts + 1,
      last_error = '', sent_at = ? WHERE id = ?`).run(new Date().toISOString(), row.id);
    return true;
  } catch (err) {
    var attempts = row.attempts + 1;
    db.prepare(`UPDATE emails SET status = 'failed', attempts = ?, last_error = ?,
      next_attempt_at = ? WHERE id = ?`)
      .run(attempts, String(err && err.message || err).slice(0, 500),
        Date.now() + backoffMs(attempts), row.id);
    console.error('[mail] attempt ' + attempts + '/' + MAX_ATTEMPTS +
      ' failed for #' + row.id + ' → ' + row.to_email + ': ' + (err && err.message));
    return false;
  }
}

/** Send whatever is due. Returns { sent, failed }. */
async function drain(limit) {
  var rows = pending(limit);
  var sent = 0, failed = 0;
  for (var i = 0; i < rows.length; i++) {
    // Sequential on purpose: a queue this size gains nothing from concurrency,
    // and one connection at a time is kinder to rate-limited providers.
    /* eslint-disable no-await-in-loop */
    (await deliver(rows[i])) ? sent++ : failed++;
  }
  return { sent: sent, failed: failed, considered: rows.length };
}

var timer = null;

function startWorker(intervalMs) {
  if (timer) return timer;
  var every = intervalMs || 15000;

  var tick = function () {
    drain().catch(function (err) { console.error('[mail] worker error:', err.message); });
  };

  tick();                                   // pick up anything left from a previous run
  timer = setInterval(tick, every);
  if (timer.unref) timer.unref();           // never hold the process open
  console.log('[mail] outbox worker every ' + Math.round(every / 1000) + 's, transport=' +
    transport.config.transport);
  return timer;
}

function stopWorker() {
  if (timer) { clearInterval(timer); timer = null; }
}

function stats() {
  var rows = db.prepare('SELECT status, COUNT(*) AS n FROM emails GROUP BY status').all();
  var out = { queued: 0, sent: 0, failed: 0 };
  rows.forEach(function (r) { out[r.status] = r.n; });
  return out;
}

module.exports = {
  enqueue: enqueue,
  drain: drain,
  pending: pending,
  startWorker: startWorker,
  stopWorker: stopWorker,
  stats: stats,
  MAX_ATTEMPTS: MAX_ATTEMPTS
};
