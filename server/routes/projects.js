/**
 * Projects. Reads are scoped in SQL; writes are admin-only and go through
 * rules.js for the status machine.
 */

var express = require('express');
var sql = require('../sql');
var guards = require('../guards');
var scope = require('../scope');
var rules = require('../rules');
var serialise = require('../serialise');
var audit = require('../audit');
var notify = require('../mail/notify');
var v = require('../validate');

var router = express.Router();
var asyncHandler = v.asyncHandler;

router.use(guards.requireAuth);

// ---------------------------------------------------------------
// Reads (scoped)
// ---------------------------------------------------------------

/**
 * The project list.
 *
 * `limit` exists because this used to return every project with every
 * milestone, sub-task and comment nested inside it, unbounded. The hydration
 * is set-based now, so the cost is flat in queries — but the payload is not,
 * and a thousand projects is still a response nobody wants.
 */
router.get('/', asyncHandler(async function (req, res) {
  var page = v.query(v.pagination, req);
  var clause = scope.projectClause(req.user, 'p.id');

  var params = clause.params.slice();
  var where = [clause.sql];
  if (page.before) {
    params.push(page.before);
    where.push('p.id < $' + params.length);
  }
  params.push(page.limit);

  var rows = await sql.many(
    'SELECT p.* FROM projects p WHERE ' + where.join(' AND ') +
    ' ORDER BY p.code LIMIT $' + params.length, params);

  res.json(await serialise.hydrateProjects(rows, req.user));
}));

// Accepts either the numeric id or the project code, so /projects/PRJ-001 works
router.get('/:idOrCode', asyncHandler(async function (req, res) {
  var key = String(req.params.idOrCode);
  var numeric = Number(key);

  var row = await sql.one(
    'SELECT * FROM projects WHERE ($1::bigint IS NOT NULL AND id = $1) OR code = $2',
    [Number.isInteger(numeric) ? numeric : null, key]);

  if (!row) return res.status(404).json({ error: 'No such project' });

  var project = await scope.loadVisibleProject(req.user, row.id);   // 404 if out of scope
  res.json(await serialise.project(project, req.user));
}));

// ---------------------------------------------------------------
// Writes (admin only)
// ---------------------------------------------------------------
var adminOnly = guards.requireRole('admin');

var projectInput = v.z.object({
  code: v.text('Project code', 40),
  title: v.text('Title', 200),
  description: v.optionalText(5000),
  type: v.z.string().trim().max(60).optional().default(''),
  status: v.z.enum(['Not Started', 'In-Progress', 'Completed']).optional(),
  partnerStart: v.dateish, partnerEnd: v.dateish,
  companyStart: v.dateish, companyEnd: v.dateish,
  approvedStart: v.dateish, approvedEnd: v.dateish
});

function datePairs(input) {
  return {
    Partner: [input.partnerStart, input.partnerEnd],
    Company: [input.companyStart, input.companyEnd],
    Approved: [input.approvedStart, input.approvedEnd]
  };
}

var COLUMNS = [
  ['code', 'code'], ['title', 'title'], ['description', 'description'], ['type', 'type'],
  ['partner_start', 'partnerStart'], ['partner_end', 'partnerEnd'],
  ['company_start', 'companyStart'], ['company_end', 'companyEnd'],
  ['approved_start', 'approvedStart'], ['approved_end', 'approvedEnd']
];

router.post('/', adminOnly, asyncHandler(async function (req, res) {
  var input = v.body(projectInput, req);
  if (!input.type) return res.status(400).json({ error: 'Project type is required.' });
  rules.assertValidDatePairs(datePairs(input));

  var status = input.status || 'Not Started';
  rules.assertValidStatus(status);

  if (await sql.exists('SELECT 1 FROM projects WHERE code = $1', [input.code])) {
    return res.status(409).json({ error: 'Project code "' + input.code + '" already exists.' });
  }

  var values = COLUMNS.map(function (c) { return input[c[1]]; }).concat([status]);
  var created = await sql.one(
    'INSERT INTO projects (' + COLUMNS.map(function (c) { return c[0]; }).join(', ') + ', status) ' +
    'VALUES (' + values.map(function (_, i) { return '$' + (i + 1); }).join(', ') + ') RETURNING *',
    values);

  await audit.record(req.user, 'Project', 'Created', input.code + ' — ' + input.title,
    input.type + ' · ' + status, created.id);

  res.status(201).json(await serialise.project(created, req.user));
}));

router.patch('/:id', adminOnly, asyncHandler(async function (req, res) {
  var id = Number(req.params.id);
  var project = Number.isInteger(id)
    ? await sql.one('SELECT * FROM projects WHERE id = $1', [id]) : null;
  if (!project) return res.status(404).json({ error: 'No such project' });

  // A PATCH only carries what is changing; everything absent keeps its value.
  var current = {
    code: project.code, title: project.title, description: project.description,
    type: project.type,
    partnerStart: project.partner_start || '', partnerEnd: project.partner_end || '',
    companyStart: project.company_start || '', companyEnd: project.company_end || '',
    approvedStart: project.approved_start || '', approvedEnd: project.approved_end || ''
  };
  req.body = Object.assign(current, req.body || {});

  var input = v.body(projectInput, req);
  rules.assertValidDatePairs(datePairs(input));

  if (await sql.exists('SELECT 1 FROM projects WHERE code = $1 AND id <> $2',
    [input.code, project.id])) {
    return res.status(409).json({ error: 'Project code "' + input.code + '" already exists.' });
  }

  var nextStatus = input.status !== undefined ? input.status : project.status;
  await rules.assertStatusTransition(project, nextStatus);   // throws 409

  var saved = await sql.tx(async function (t) {
    var values = COLUMNS.map(function (c) { return input[c[1]]; })
      .concat([nextStatus, project.id]);

    var updated = await t.one(
      'UPDATE projects SET ' +
      COLUMNS.map(function (c, i) { return c[0] + ' = $' + (i + 1); }).join(', ') +
      ', status = $' + (COLUMNS.length + 1) +
      ' WHERE id = $' + (COLUMNS.length + 2) + ' RETURNING *', values);

    if (nextStatus === 'Completed' && project.status !== 'Completed') {
      await notify.projectCompleted(t, updated, req.user);
    }
    return updated;
  });

  if (nextStatus !== project.status) {
    await audit.record(req.user, 'Project', 'Status changed', project.code + ' — ' + input.title,
      project.status + ' → ' + nextStatus, project.id);
  } else {
    await audit.record(req.user, 'Project', 'Updated', project.code + ' — ' + input.title,
      input.type, project.id);
  }

  res.json(await serialise.project(saved, req.user));
}));

router.delete('/:id', adminOnly, asyncHandler(async function (req, res) {
  var id = Number(req.params.id);
  var project = Number.isInteger(id)
    ? await sql.one('SELECT * FROM projects WHERE id = $1', [id]) : null;
  if (!project) return res.status(404).json({ error: 'No such project' });

  var input = v.body(v.z.object({
    reason: v.z.string().trim().min(5, 'Give a reason for deleting this project (at least 5 characters)').max(500)
  }), req);

  // Milestones, sub-tasks and join rows go with it via ON DELETE CASCADE
  await sql.run('DELETE FROM projects WHERE id = $1', [project.id]);

  await audit.record(req.user, 'Project', 'Deleted', project.code + ' — ' + project.title,
    input.reason, null);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------
// Assignments (admin only)
// ---------------------------------------------------------------
router.put('/:id/:kind(resources|pocs)', adminOnly, asyncHandler(async function (req, res) {
  var id = Number(req.params.id);
  var project = Number.isInteger(id)
    ? await sql.one('SELECT * FROM projects WHERE id = $1', [id]) : null;
  if (!project) return res.status(404).json({ error: 'No such project' });

  var input = v.body(v.z.object({
    personIds: v.z.array(v.uuid).max(100).optional().default([])
  }), req);

  var table = req.params.kind === 'pocs' ? 'project_pocs' : 'project_resources';
  var wantKind = req.params.kind === 'pocs' ? 'partner' : 'company';

  // Only people of the right kind may be assigned to each list. One query,
  // which also silently drops ids that do not exist at all.
  var valid = (await sql.many(
    'SELECT id FROM people WHERE id = ANY($1::uuid[]) AND kind = $2',
    [input.personIds, wantKind])).map(function (r) { return r.id; });

  var before = (await sql.many(
    'SELECT person_id FROM ' + table + ' WHERE project_id = $1', [project.id]))
    .map(function (r) { return r.person_id; });
  var added = valid.filter(function (pid) { return before.indexOf(pid) === -1; });

  await sql.tx(async function (t) {
    await t.run('DELETE FROM ' + table + ' WHERE project_id = $1', [project.id]);
    if (valid.length) {
      await t.run(
        'INSERT INTO ' + table + ' (project_id, person_id) ' +
        'SELECT $1, unnest($2::uuid[])', [project.id, valid]);
    }
    // Only newly added POCs hear about it — re-saving the same list is silent
    if (wantKind === 'partner' && added.length) {
      await notify.pocAssigned(t, project, req.user, added);
    }
  });

  await audit.record(req.user, 'People', 'Assigned', project.code + ' — ' + project.title,
    (wantKind === 'partner' ? 'Partner POC' : 'Organisation resources') + ': ' +
    (valid.length ? valid.length : 'none'), project.id);

  res.json(await serialise.project(
    await sql.one('SELECT * FROM projects WHERE id = $1', [project.id]), req.user));
}));

module.exports = router;
