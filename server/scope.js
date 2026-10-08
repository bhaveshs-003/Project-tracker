/**
 * Visibility, expressed as SQL rather than as a filter applied after the fact.
 *
 * A partner asking for a project they are not POC on gets nothing back — the
 * row never enters the result set, so the route returns 404 rather than a
 * partially-redacted page. Admins see everything.
 *
 * Unchanged in meaning from the SQLite version; every function is now async
 * because the database is across a network.
 */

var sql = require('./sql');

function isAdmin(user) {
  return user.role === 'admin';
}

function notFound(message) {
  var err = new Error(message);
  err.status = 404;
  return err;
}

/**
 * A SQL fragment plus its parameters, restricting a query to what this user may
 * see. Placeholders start at $1, which is safe because this is always the whole
 * WHERE clause — if that ever stops being true, take an offset argument rather
 * than renumbering by hand at the call site.
 */
function projectClause(user, column) {
  var col = column || 'p.id';
  if (isAdmin(user)) return { sql: 'true', params: [] };
  return {
    sql: col + ' IN (SELECT project_id FROM project_pocs WHERE person_id = $1)',
    params: [user.id]
  };
}

async function visibleProjectIds(user) {
  var rows = isAdmin(user)
    ? await sql.many('SELECT id FROM projects')
    : await sql.many('SELECT project_id AS id FROM project_pocs WHERE person_id = $1', [user.id]);
  return rows.map(function (r) { return r.id; });
}

async function canSeeProject(user, projectId) {
  if (isAdmin(user)) {
    return sql.exists('SELECT 1 FROM projects WHERE id = $1', [projectId]);
  }
  return sql.exists(
    'SELECT 1 FROM project_pocs WHERE project_id = $1 AND person_id = $2',
    [projectId, user.id]);
}

/** Is this user a POC on this project? The only people allowed to approve. */
async function isProjectPoc(user, projectId) {
  return sql.exists(
    'SELECT 1 FROM project_pocs WHERE project_id = $1 AND person_id = $2',
    [projectId, user.id]);
}

/**
 * Resolve a project the caller is allowed to see, or throw a 404. Deliberately
 * 404 and not 403: a partner should not be able to discover which project codes
 * exist by watching the status change.
 */
async function loadVisibleProject(user, projectId) {
  // A non-numeric id would make Postgres throw a type error rather than simply
  // not matching, which would surface as a 500 instead of a 404.
  var id = Number(projectId);
  if (!Number.isInteger(id)) throw notFound('No such project');

  var project = await sql.one('SELECT * FROM projects WHERE id = $1', [id]);
  if (!project || !(await canSeeProject(user, project.id))) throw notFound('No such project');
  return project;
}

async function loadVisibleMilestone(user, milestoneId) {
  var id = Number(milestoneId);
  if (!Number.isInteger(id)) throw notFound('No such milestone');

  var milestone = await sql.one('SELECT * FROM milestones WHERE id = $1', [id]);
  if (!milestone) throw notFound('No such milestone');
  await loadVisibleProject(user, milestone.project_id);   // throws 404 if out of scope
  return milestone;
}

async function loadVisibleSubtask(user, subtaskId) {
  var id = Number(subtaskId);
  if (!Number.isInteger(id)) throw notFound('No such sub-task');

  var subtask = await sql.one('SELECT * FROM subtasks WHERE id = $1', [id]);
  if (!subtask) throw notFound('No such sub-task');
  var milestone = await loadVisibleMilestone(user, subtask.milestone_id);
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
