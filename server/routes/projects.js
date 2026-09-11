/**
 * Projects. Reads are scoped in SQL; writes are admin-only and go through
 * rules.js for the status machine.
 */

var express = require('express');
var db = require('../db').db;
var guards = require('../guards');
var scope = require('../scope');
var rules = require('../rules');
var serialise = require('../serialise');
var audit = require('../audit');
var notify = require('../mail/notify');

var router = express.Router();
router.use(guards.requireAuth);

// ---- Reads (scoped) ----
router.get('/', function (req, res) {
  var clause = scope.projectClause(req.user, 'p.id');
  var statement = db.prepare('SELECT p.* FROM projects p WHERE ' + clause.sql + ' ORDER BY p.code');
  var rows = statement.all.apply(statement, clause.params);
  res.json(rows.map(function (row) { return serialise.project(row, req.user); }));
});

// Accepts either the numeric id or the project code, so /projects/PRJ-001 works
router.get('/:idOrCode', function (req, res, next) {
  try {
    var row = db.prepare('SELECT * FROM projects WHERE id = ? OR code = ? COLLATE NOCASE')
      .get(Number(req.params.idOrCode) || -1, req.params.idOrCode);
    if (!row) return res.status(404).json({ error: 'No such project' });

    var project = scope.loadVisibleProject(req.user, row.id);   // 404 if out of scope
    res.json(serialise.project(project, req.user));
  } catch (e) { next(e); }
});

// ---- Writes (admin only) ----
var adminOnly = guards.requireRole('admin');

function readProjectBody(body) {
  return {
    code: String(body.code || '').trim(),
    title: String(body.title || '').trim(),
    description: String(body.description || '').trim(),
    type: String(body.type || '').trim(),
    partner_start: body.partnerStart || '',
    partner_end: body.partnerEnd || '',
    company_start: body.companyStart || '',
    company_end: body.companyEnd || '',
    approved_start: body.approvedStart || '',
    approved_end: body.approvedEnd || ''
  };
}

function validateDates(fields, res) {
  var pairs = [
    ['partner_start', 'partner_end', 'Partner'],
    ['company_start', 'company_end', 'Company'],
    ['approved_start', 'approved_end', 'Approved']
  ];
  for (var i = 0; i < pairs.length; i++) {
    var a = fields[pairs[i][0]], b = fields[pairs[i][1]];
    if (a && b && b < a) {
      res.status(400).json({ error: pairs[i][2] + ' end date cannot be before its start date.' });
      return false;
    }
  }
  return true;
}

router.post('/', adminOnly, function (req, res, next) {
  try {
    var fields = readProjectBody(req.body || {});
    if (!fields.code) return res.status(400).json({ error: 'Project code is required.' });
    if (!fields.title) return res.status(400).json({ error: 'Title is required.' });
    if (!fields.type) return res.status(400).json({ error: 'Project type is required.' });
    if (!validateDates(fields, res)) return;

    if (db.prepare('SELECT 1 FROM projects WHERE code = ? COLLATE NOCASE').get(fields.code)) {
      return res.status(409).json({ error: 'Project code "' + fields.code + '" already exists.' });
    }

    var status = (req.body || {}).status || 'Not Started';
    rules.assertValidStatus(status);

    var now = new Date().toISOString();
    var id = db.prepare(`INSERT INTO projects
      (code, title, description, type, status, partner_start, partner_end,
       company_start, company_end, approved_start, approved_end, created_at, updated_at)
      VALUES (@code, @title, @description, @type, @status, @partner_start, @partner_end,
              @company_start, @company_end, @approved_start, @approved_end, @created_at, @updated_at)`)
      .run(Object.assign({}, fields, { status: status, created_at: now, updated_at: now })).lastInsertRowid;

    audit.record(req.user, 'Project', 'Created', fields.code + ' — ' + fields.title,
      fields.type + ' · ' + status, id);

    res.status(201).json(serialise.project(
      db.prepare('SELECT * FROM projects WHERE id = ?').get(id), req.user));
  } catch (e) { next(e); }
});

router.patch('/:id', adminOnly, function (req, res, next) {
  try {
    var project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'No such project' });

    var body = req.body || {};
    var fields = readProjectBody(Object.assign({
      code: project.code, title: project.title, description: project.description,
      type: project.type,
      partnerStart: project.partner_start, partnerEnd: project.partner_end,
      companyStart: project.company_start, companyEnd: project.company_end,
      approvedStart: project.approved_start, approvedEnd: project.approved_end
    }, body));

    if (!fields.code) return res.status(400).json({ error: 'Project code is required.' });
    if (!fields.title) return res.status(400).json({ error: 'Title is required.' });
    if (!validateDates(fields, res)) return;

    var clash = db.prepare('SELECT id FROM projects WHERE code = ? COLLATE NOCASE AND id != ?')
      .get(fields.code, project.id);
    if (clash) return res.status(409).json({ error: 'Project code "' + fields.code + '" already exists.' });

    var nextStatus = body.status !== undefined ? body.status : project.status;
    rules.assertStatusTransition(project, nextStatus);   // throws 409

    db.transaction(function () {
      db.prepare(`UPDATE projects SET code=@code, title=@title, description=@description,
        type=@type, status=@status, partner_start=@partner_start, partner_end=@partner_end,
        company_start=@company_start, company_end=@company_end,
        approved_start=@approved_start, approved_end=@approved_end, updated_at=@updated_at
        WHERE id=@id`).run(Object.assign({}, fields, {
          status: nextStatus, updated_at: new Date().toISOString(), id: project.id
        }));

      if (nextStatus === 'Completed' && project.status !== 'Completed') {
        var fresh = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
        notify.projectCompleted(fresh, req.user);
      }
    })();

    if (nextStatus !== project.status) {
      audit.record(req.user, 'Project', 'Status changed', project.code + ' — ' + fields.title,
        project.status + ' → ' + nextStatus, project.id);
    } else {
      audit.record(req.user, 'Project', 'Updated', project.code + ' — ' + fields.title,
        fields.type, project.id);
    }

    res.json(serialise.project(db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id), req.user));
  } catch (e) { next(e); }
});

router.delete('/:id', adminOnly, function (req, res, next) {
  try {
    var project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'No such project' });

    var reason = String((req.body || {}).reason || '').trim();
    if (reason.length < 5) {
      return res.status(400).json({ error: 'Give a reason for deleting this project (at least 5 characters).' });
    }

    // Milestones, sub-tasks and join rows go with it via ON DELETE CASCADE
    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);

    audit.record(req.user, 'Project', 'Deleted', project.code + ' — ' + project.title, reason, null);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- Assignments (admin only) ----
router.put('/:id/:kind(resources|pocs)', adminOnly, function (req, res, next) {
  try {
    var project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'No such project' });

    var table = req.params.kind === 'pocs' ? 'project_pocs' : 'project_resources';
    var wantKind = req.params.kind === 'pocs' ? 'partner' : 'company';
    var ids = Array.isArray((req.body || {}).personIds) ? req.body.personIds : [];

    // Only people of the right kind may be assigned to each list
    var valid = ids.filter(function (id) {
      var person = db.prepare('SELECT kind FROM people WHERE id = ?').get(id);
      return person && person.kind === wantKind;
    });

    var before = db.prepare('SELECT person_id FROM ' + table + ' WHERE project_id = ?')
      .all(project.id).map(function (r) { return r.person_id; });
    var added = valid.filter(function (id) { return before.indexOf(id) === -1; });

    db.transaction(function () {
      db.prepare('DELETE FROM ' + table + ' WHERE project_id = ?').run(project.id);
      var link = db.prepare('INSERT INTO ' + table + ' (project_id, person_id) VALUES (?, ?)');
      valid.forEach(function (id) { link.run(project.id, id); });

      // Only newly added POCs hear about it — re-saving the same list is silent
      if (wantKind === 'partner' && added.length) {
        notify.pocAssigned(project, req.user, added);
      }
    })();

    audit.record(req.user, 'People', 'Assigned', project.code + ' — ' + project.title,
      (wantKind === 'partner' ? 'Partner POC' : 'Organisation resources') + ': ' +
      (valid.length ? valid.length : 'none'), project.id);

    res.json(serialise.project(db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id), req.user));
  } catch (e) { next(e); }
});

module.exports = router;
