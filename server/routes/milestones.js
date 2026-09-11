/**
 * Milestones, sub-tasks, completion and the approval trip.
 *
 * Every handler resolves the project through scope.js first (404 if the caller
 * may not see it) and then asks rules.js whether the transition is legal.
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

var adminOnly = guards.requireRole('admin');
var today = function () { return new Date().toISOString().slice(0, 10); };

function projectOf(milestone) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(milestone.project_id);
}

// The three negotiated pairs, defaulting to whatever the milestone already has
function readDates(body, existing) {
  var current = existing || {};
  var pick = function (key, column) {
    return body[key] !== undefined ? (body[key] || '') : (current[column] || '');
  };
  return {
    company_start: pick('companyStart', 'company_start'),
    company_end: pick('companyEnd', 'company_end'),
    partner_start: pick('partnerStart', 'partner_start'),
    partner_end: pick('partnerEnd', 'partner_end'),
    approved_start: pick('approvedStart', 'approved_start'),
    approved_end: pick('approvedEnd', 'approved_end')
  };
}

function checkDates(dates) {
  rules.assertValidDatePairs({
    Company: [dates.company_start, dates.company_end],
    Partner: [dates.partner_start, dates.partner_end],
    Approved: [dates.approved_start, dates.approved_end]
  });
}

function sendMilestone(res, user, id) {
  res.json(serialise.milestone(db.prepare('SELECT * FROM milestones WHERE id = ?').get(id), user));
}

// ---------------------------------------------------------------
// Milestone CRUD — admin only
// ---------------------------------------------------------------
router.post('/', adminOnly, function (req, res, next) {
  try {
    var body = req.body || {};
    var project = scope.loadVisibleProject(req.user, Number(body.projectId));
    var title = String(body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Title is required.' });

    var dates = readDates(body, null);
    checkDates(dates);

    var position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM milestones WHERE project_id = ?')
      .get(project.id).n;
    var id = db.prepare(`INSERT INTO milestones
      (project_id, title, company_start, company_end, partner_start, partner_end,
       approved_start, approved_end, position)
      VALUES (@projectId, @title, @company_start, @company_end, @partner_start, @partner_end,
              @approved_start, @approved_end, @position)`)
      .run(Object.assign({ projectId: project.id, title: title, position: position }, dates))
      .lastInsertRowid;

    audit.record(req.user, 'Milestone', 'Created', title, project.code, project.id);
    sendMilestone(res.status(201), req.user, id);
  } catch (e) { next(e); }
});

router.patch('/:id', adminOnly, function (req, res, next) {
  try {
    var milestone = scope.loadVisibleMilestone(req.user, req.params.id);
    var body = req.body || {};
    var title = body.title !== undefined ? String(body.title).trim() : milestone.title;
    if (!title) return res.status(400).json({ error: 'Title is required.' });

    var dates = readDates(body, milestone);
    checkDates(dates);

    db.prepare(`UPDATE milestones SET title = @title,
      company_start = @company_start, company_end = @company_end,
      partner_start = @partner_start, partner_end = @partner_end,
      approved_start = @approved_start, approved_end = @approved_end
      WHERE id = @id`).run(Object.assign({ title: title, id: milestone.id }, dates));

    audit.record(req.user, 'Milestone', 'Updated', title, '', milestone.project_id);
    sendMilestone(res, req.user, milestone.id);
  } catch (e) { next(e); }
});

router.delete('/:id', adminOnly, function (req, res, next) {
  try {
    var milestone = scope.loadVisibleMilestone(req.user, req.params.id);
    var subtasks = rules.subtasksOf(milestone.id).length;

    db.prepare('DELETE FROM milestones WHERE id = ?').run(milestone.id);   // cascades to sub-tasks

    audit.record(req.user, 'Milestone', 'Deleted', milestone.title,
      subtasks ? 'with ' + subtasks + ' sub-task' + (subtasks === 1 ? '' : 's') : '',
      milestone.project_id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------
// Sub-tasks — admin only
// ---------------------------------------------------------------
router.post('/:id/subtasks', adminOnly, function (req, res, next) {
  try {
    var milestone = scope.loadVisibleMilestone(req.user, req.params.id);
    rules.assertCanAddSubtask(milestone);            // 409 if the milestone is closed

    var title = String((req.body || {}).title || '').trim();
    if (!title) return res.status(400).json({ error: 'Title is required.' });

    var position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM subtasks WHERE milestone_id = ?')
      .get(milestone.id).n;
    db.prepare('INSERT INTO subtasks (milestone_id, title, position) VALUES (?, ?, ?)')
      .run(milestone.id, title, position);

    audit.record(req.user, 'Sub-task', 'Created', title, milestone.title, milestone.project_id);
    sendMilestone(res.status(201), req.user, milestone.id);
  } catch (e) { next(e); }
});

router.patch('/subtasks/:subtaskId', adminOnly, function (req, res, next) {
  try {
    var found = scope.loadVisibleSubtask(req.user, req.params.subtaskId);
    var title = String((req.body || {}).title || '').trim();
    if (!title) return res.status(400).json({ error: 'Title is required.' });

    db.prepare('UPDATE subtasks SET title = ? WHERE id = ?').run(title, found.subtask.id);
    audit.record(req.user, 'Sub-task', 'Updated', title, found.milestone.title, found.milestone.project_id);
    sendMilestone(res, req.user, found.milestone.id);
  } catch (e) { next(e); }
});

router.delete('/subtasks/:subtaskId', adminOnly, function (req, res, next) {
  try {
    var found = scope.loadVisibleSubtask(req.user, req.params.subtaskId);
    db.prepare('DELETE FROM subtasks WHERE id = ?').run(found.subtask.id);
    audit.record(req.user, 'Sub-task', 'Deleted', found.subtask.title,
      found.milestone.title, found.milestone.project_id);
    sendMilestone(res, req.user, found.milestone.id);
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------
// Completion — admin only, and only while the project is In-Progress
// ---------------------------------------------------------------
router.post('/subtasks/:subtaskId/complete', adminOnly, function (req, res, next) {
  try {
    var found = scope.loadVisibleSubtask(req.user, req.params.subtaskId);
    var project = projectOf(found.milestone);
    var body = req.body || {};

    rules.assertProjectInProgress(project, 'marking a sub-task complete');
    rules.assertCanCompleteSubtask(found.subtask);
    rules.assertValidCompletion(body);

    db.prepare(`UPDATE subtasks SET completed = 1, outcome = ?, delay_side = ?,
      delay_notes = ?, completed_at = ? WHERE id = ?`).run(
      body.outcome,
      body.outcome === 'Delayed' ? body.delaySide : '',
      body.outcome === 'Delayed' ? String(body.delayNotes || '').trim() : '',
      today(), found.subtask.id);

    audit.record(req.user, 'Sub-task', 'Completed', found.subtask.title,
      body.outcome + (body.outcome === 'Delayed' ? ' · ' + body.delaySide : ''),
      found.milestone.project_id);
    sendMilestone(res, req.user, found.milestone.id);
  } catch (e) { next(e); }
});

router.post('/:id/complete', adminOnly, function (req, res, next) {
  try {
    var milestone = scope.loadVisibleMilestone(req.user, req.params.id);
    var project = projectOf(milestone);
    var body = req.body || {};

    rules.assertProjectInProgress(project, 'marking a milestone complete');
    rules.assertCanCompleteMilestone(milestone);     // 409 while sub-tasks are open
    rules.assertValidCompletion(body);

    db.prepare(`UPDATE milestones SET completed = 1, outcome = ?, delay_side = ?,
      delay_notes = ?, completed_at = ? WHERE id = ?`).run(
      body.outcome,
      body.outcome === 'Delayed' ? body.delaySide : '',
      body.outcome === 'Delayed' ? String(body.delayNotes || '').trim() : '',
      today(), milestone.id);

    audit.record(req.user, 'Milestone', 'Completed', milestone.title,
      body.outcome + (body.outcome === 'Delayed' ? ' · ' + body.delaySide : ''),
      milestone.project_id);
    sendMilestone(res, req.user, milestone.id);
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------
// Approval trip
// ---------------------------------------------------------------
router.post('/:id/submit', adminOnly, function (req, res, next) {
  try {
    var milestone = scope.loadVisibleMilestone(req.user, req.params.id);
    var project = projectOf(milestone);

    rules.assertCanSubmitForApproval(project, milestone);

    // State change and the intent to notify commit together, or neither does
    db.transaction(function () {
      db.prepare("UPDATE milestones SET approval = 'pending', submitted_at = ?, submitted_by = ? WHERE id = ?")
        .run(today(), req.user.id, milestone.id);

      var fresh = db.prepare('SELECT * FROM milestones WHERE id = ?').get(milestone.id);
      notify.milestoneSubmitted(project, fresh, req.user);
    })();

    audit.record(req.user, 'Approval', 'Submitted', milestone.title, project.code, project.id);
    sendMilestone(res, req.user, milestone.id);
  } catch (e) { next(e); }
});

// The one write a partner may make — and only on their own project
router.post('/:id/approve', function (req, res, next) {
  try {
    var milestone = scope.loadVisibleMilestone(req.user, req.params.id);
    var project = projectOf(milestone);
    var body = req.body || {};

    rules.assertCanApprove(req.user, project, milestone, scope.isProjectPoc(req.user, project.id));
    rules.assertValidFeedback(body);

    // The gate. This reads the decisions already persisted against each delayed
    // item — there is no longer a payload here for a crafted request to lie
    // about, because accepting a delay is its own authorised write.
    rules.assertDelaysAccepted(milestone);

    var mentions = rules.filterMentions(project.id, body.mentions);
    var comment = String(body.comment).trim();

    db.transaction(function () {
      db.prepare(`UPDATE milestones SET approval = 'approved', approved_by = ?, approved_at = ?,
        feedback_rating = ?, feedback_comment = ? WHERE id = ?`)
        .run(req.user.id, today(), Number(body.rating), comment, milestone.id);

      db.prepare('DELETE FROM milestone_mentions WHERE milestone_id = ?').run(milestone.id);
      var mention = db.prepare('INSERT INTO milestone_mentions (milestone_id, person_id) VALUES (?, ?)');
      mentions.forEach(function (id) { mention.run(milestone.id, id); });

      // Nothing to record about the delays here any more — each was accepted by
      // its own request, which stamped who and when at the time.

      var fresh = db.prepare('SELECT * FROM milestones WHERE id = ?').get(milestone.id);
      notify.milestoneApproved(project, fresh, req.user, { rating: Number(body.rating), comment: comment });
      notify.mentioned(project, fresh, req.user, mentions, comment);
    })();

    audit.record(req.user, 'Approval', 'Approved', milestone.title,
      Number(body.rating) + '/5 · ' + project.code, project.id);
    sendMilestone(res, req.user, milestone.id);
  } catch (e) { next(e); }
});

module.exports = router;
