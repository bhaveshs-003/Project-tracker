/**
 * Visibility, expressed as SQL rather than as a filter applied after the fact.
 *
 * A partner asking for a project they are not POC on gets nothing back — the
 * row never enters the result set, so the route returns 404 rather than a
 * partially-redacted page. Admins see everything.
 */

var db = require('./db').db;

function isAdmin(user) {
  return user.role === 'admin';
}

// SQL fragment + params that restrict a query to what this user may see.
// Used as: 'SELECT ... FROM projects p WHERE ' + clause
function projectClause(user, column) {
  var col = column || 'p.id';
  if (isAdmin(user)) return { sql: '1 = 1', params: [] };
  return {
    sql: col + ' IN (SELECT project_id FROM project_pocs WHERE person_id = ?)',
    params: [user.id]
  };
}

function visibleProjectIds(user) {
  if (isAdmin(user)) {
    return db.prepare('SELECT id FROM projects').all().map(function (r) { return r.id; });
  }
  return db.prepare('SELECT project_id AS id FROM project_pocs WHERE person_id = ?')
    .all(user.id).map(function (r) { return r.id; });
}

function canSeeProject(user, projectId) {
  if (isAdmin(user)) {
    return !!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
  }
  return !!db.prepare(
    'SELECT 1 FROM project_pocs WHERE project_id = ? AND person_id = ?'
  ).get(projectId, user.id);
}

// Is this user a POC on this project? The only people allowed to approve.
function isProjectPoc(user, projectId) {
  return !!db.prepare(
    'SELECT 1 FROM project_pocs WHERE project_id = ? AND person_id = ?'
  ).get(projectId, user.id);
}

/**
 * Resolve a project the caller is allowed to see, or throw a 404. Deliberately
 * 404 and not 403: a partner should not be able to discover which project codes
 * exist by watching the status change.
 */
function loadVisibleProject(user, projectId) {
  var project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project || !canSeeProject(user, project.id)) {
    var err = new Error('No such project');
    err.status = 404;
    throw err;
  }
  return project;
}

// Same, starting from a milestone id
function loadVisibleMilestone(user, milestoneId) {
  var milestone = db.prepare('SELECT * FROM milestones WHERE id = ?').get(milestoneId);
  if (!milestone) {
    var err = new Error('No such milestone');
    err.status = 404;
    throw err;
  }
  loadVisibleProject(user, milestone.project_id);   // throws 404 if out of scope
  return milestone;
}

function loadVisibleSubtask(user, subtaskId) {
  var subtask = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(subtaskId);
  if (!subtask) {
    var err = new Error('No such sub-task');
    err.status = 404;
    throw err;
  }
  var milestone = loadVisibleMilestone(user, subtask.milestone_id);
  return { subtask: subtask, milestone: milestone };
}

module.exports = {
  isAdmin: isAdmin,
  projectClause: projectClause,
  visibleProjectIds: visibleProjectIds,
  canSeeProject: canSeeProject,
  isProjectPoc: isProjectPoc,
  loadVisibleProject: loadVisibleProject,
  loadVisibleMilestone: loadVisibleMilestone,
  loadVisibleSubtask: loadVisibleSubtask
};
