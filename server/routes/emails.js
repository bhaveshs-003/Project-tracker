/**
 * Queue inspection. Admin-only: the outbox holds recipient addresses and
 * approval comments across every project, so it must not be visible to a
 * partner who can only see one.
 */

var express = require('express');
var sql = require('../sql');
var guards = require('../guards');
var outbox = require('../mail/outbox');
var transport = require('../mail/transport');
var v = require('../validate');

var router = express.Router();
var asyncHandler = v.asyncHandler;

router.use(guards.requireAuth, guards.requireRole('admin'));

router.get('/', asyncHandler(async function (req, res) {
  var page = v.query(v.pagination, req);

  var rows = await sql.many(
    `SELECT id, event, dedupe_key, to_email, to_name, subject, status, attempts,
            last_error, created_at, sent_at, next_attempt_at, locked_until,
            project_id, milestone_id
       FROM emails ORDER BY id DESC LIMIT $1`, [page.limit]);

  res.json({
    transport: transport.config.transport,
    from: transport.config.from,
    stats: await outbox.stats(),
    emails: rows
  });
}));

// The full body of one message, for reading what actually went out
router.get('/:id', asyncHandler(async function (req, res) {
  var id = Number(req.params.id);
  var row = Number.isInteger(id)
    ? await sql.one('SELECT * FROM emails WHERE id = $1', [id]) : null;
  if (!row) return res.status(404).json({ error: 'No such email' });
  res.json(row);
}));

// Push anything due through immediately rather than waiting for the cron
router.post('/drain', asyncHandler(async function (req, res) {
  res.json(await outbox.drain());
}));

module.exports = router;
