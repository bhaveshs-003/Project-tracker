/**
 * The audit trail. Admin-only — it spans the whole platform, including
 * projects a given partner has no business seeing.
 *
 * Paginated, because the table is no longer capped at 500 rows: retention is
 * by age now, so "every entry" could be years of them.
 */

var express = require('express');
var sql = require('../sql');
var guards = require('../guards');
var serialise = require('../serialise');
var v = require('../validate');

var router = express.Router();

router.use(guards.requireAuth, guards.requireRole('admin'));

router.get('/', v.asyncHandler(async function (req, res) {
  var page = v.query(v.pagination, req);

  // Keyset, not OFFSET: the id is monotonic, so paging stays constant-time
  // however deep it goes, and a row inserted mid-scroll cannot shift the page.
  var rows = page.before
    ? await sql.many('SELECT * FROM audit WHERE id < $1 ORDER BY id DESC LIMIT $2',
      [page.before, page.limit])
    : await sql.many('SELECT * FROM audit ORDER BY id DESC LIMIT $1', [page.limit]);

  res.json({
    entries: rows.map(serialise.auditEntry),
    nextBefore: rows.length === page.limit ? rows[rows.length - 1].id : null
  });
}));

module.exports = router;
