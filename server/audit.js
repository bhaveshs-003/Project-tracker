/**
 * Audit log. Written server-side, so the actor is whoever the session says it
 * is — not whoever the client claims to be.
 *
 * The SQLite version kept only the newest 500 rows and DELETEd the rest on
 * every single write. That makes it a recent-activity feed wearing an audit
 * trail's name: the moment anything interesting is being investigated, the
 * evidence has already been overwritten by routine traffic.
 *
 * Retention is now by age and runs on the cron, not in the request path.
 */

var sql = require('./sql');

// Long enough to still be evidence. Deletion is a scheduled job, so changing
// this does not change the cost of a write.
var RETENTION_DAYS = Number(process.env.AUDIT_RETENTION_DAYS || 730);

/**
 * Record one action.
 *
 * Deliberately swallows its own failures: an audit write that throws would
 * roll back the business action that succeeded, which is a worse outcome than
 * a missing log line. The failure is logged loudly instead.
 *
 * Pass `runner` (a transaction handle from sql.tx) to record inside the same
 * transaction as the change being recorded.
 */
async function record(user, category, action, target, detail, projectId, runner) {
  var db = runner || sql;
  try {
    await db.run(
      `INSERT INTO audit (category, action, target, detail, project_id,
                          actor_id, actor_name, actor_role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        category,
        action,
        target || '',
        detail || '',
        projectId || null,
        user.id,
        user.name,
        user.role === 'admin' ? 'Admin' : 'Partner POC'
      ]);
  } catch (err) {
    if (runner) throw err;   // inside a transaction the caller decides
    console.error('[audit] failed to record "' + category + '/' + action + '":', err.message);
  }
}

/** Delete entries past the retention window. Called by the cron, not by writes. */
async function prune() {
  return sql.run(
    "DELETE FROM audit WHERE at < now() - ($1 || ' days')::interval",
    [String(RETENTION_DAYS)]);
}

module.exports = { record: record, prune: prune, RETENTION_DAYS: RETENTION_DAYS };
