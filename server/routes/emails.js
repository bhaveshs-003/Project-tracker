/**
 * Queue inspection. Admin-only: the outbox holds recipient addresses and
 * approval comments across every project, so it must not be visible to a
 * partner who can only see one.
 */

var express = require('express');
var db = require('../db').db;
var guards = require('../guards');
var outbox = require('../mail/outbox');
var transport = require('../mail/transport');

var router = express.Router();
router.use(guards.requireAuth, guards.requireRole('admin'));

router.get('/', function (req, res) {
  var rows = db.prepare(`SELECT id, event, dedupe_key, to_email, to_name, subject,
      status, attempts, last_error, created_at, sent_at, project_id, milestone_id
    FROM emails ORDER BY id DESC LIMIT 200`).all();

  res.json({
    transport: transport.config.transport,
    from: transport.config.from,
    stats: outbox.stats(),
    emails: rows
  });
});

// The full body of one message, for reading what actually went out
router.get('/:id', function (req, res) {
  var row = db.prepare('SELECT * FROM emails WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'No such email' });
  res.json(row);
});

// Push anything due through immediately rather than waiting for the next tick
router.post('/drain', function (req, res, next) {
  outbox.drain().then(function (result) { res.json(result); }).catch(next);
});

module.exports = router;
