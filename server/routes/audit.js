/**
 * The audit trail. Admin-only — it spans the whole platform, including
 * projects a given partner has no business seeing.
 */

var express = require('express');
var db = require('../db').db;
var guards = require('../guards');
var serialise = require('../serialise');

var router = express.Router();
router.use(guards.requireAuth, guards.requireRole('admin'));

router.get('/', function (req, res) {
  var rows = db.prepare('SELECT * FROM audit ORDER BY id DESC').all();
  res.json(rows.map(serialise.auditEntry));
});

module.exports = router;
