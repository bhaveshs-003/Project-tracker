/**
 * Audit log. Written server-side, so the actor is whoever the session says it
 * is — not whoever the client claims to be.
 */

var db = require('./db').db;

var AUDIT_LIMIT = 500;

function record(user, category, action, target, detail, projectId) {
  db.prepare(`INSERT INTO audit
    (at, category, action, target, detail, project_id, actor_id, actor_name, actor_role)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    new Date().toISOString(),
    category,
    action,
    target || '',
    detail || '',
    projectId || null,
    user.id,
    user.name,
    user.role === 'admin' ? 'Admin' : 'Partner POC'
  );

  // Keep the table bounded
  db.prepare(`DELETE FROM audit WHERE id NOT IN
    (SELECT id FROM audit ORDER BY id DESC LIMIT ?)`).run(AUDIT_LIMIT);
}

module.exports = { record: record, AUDIT_LIMIT: AUDIT_LIMIT };
