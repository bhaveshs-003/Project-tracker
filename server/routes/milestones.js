/**
 * Milestones, sub-tasks, completion and the approval trip.
 *
 * Every handler resolves the project through scope.js first (404 if the caller
 * may not see it) and then asks rules.js whether the transition is legal.
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
var adminOnly = guards.requireRole('admin');

function projectOf(milestone, runner) {
  return (runner || sql).one('SELECT * FROM projects WHERE id = $1', [milestone.project_id]);
}

// The three negotiated pairs
var dateFields = {
  companyStart: 'company_start', companyEnd: 'company_end',
  partnerStart: 'partner_start', partnerEnd: 'partner_end',
  approvedStart: 'approved_start', approvedEnd: 'approved_end'
};

var dateSchema = v.z.object({
  companyStart: v.dateish, companyEnd: v.dateish,
  partnerStart: v.dateish, partnerEnd: v.dateish,
  approvedStart: v.dateish, approvedEnd: v.dateish
});

/** Merge the submitted dates over whatever the milestone already has. */
function readDates(input, existing) {
  var out = {};
  Object.keys(dateFields).forEach(function (key) {
    var column = dateFields[key];
    out[column] = input[key] !== undefined && input[key] !== null
      ? input[key]
      : (existing ? (existing[column] || null) : null);
  });
  return out;
}

function checkDates(dates) {
  rules.assertValidDatePairs({
    Company: [dates.company_start, dates.company_end],
    Partner: [dates.partner_start, dates.partner_end],
    Approved: [dates.approved_start, dates.approved_end]
  });
}

async function sendMilestone(res, user, milestoneId) {
  var row = await sql.one('SELECT * FROM milestones WHERE id = $1', [milestoneId]);
  res.json(await serialise.milestone(row, user));
}

var titleOnly = v.z.object({ title: v.text('Title', 200) });

// ---------------------------------------------------------------
// Milestone CRUD — admin only
// ---------------------------------------------------------------
router.post('/', adminOnly, asyncHandler(async function (req, res) {
  var input = v.body(dateSchema.extend({
    projectId: v.id,
    title: v.text('Title', 200)
  }), req);

  var project = await scope.loadVisibleProject(req.user, input.projectId);
  var dates = readDates(input, null);
  checkDates(dates);

  var created = await sql.one(
    `INSERT INTO milestones
       (project_id, title, company_start, company_end, partner_start, partner_end,
        approved_start, approved_end, position)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             (SELECT coalesce(max(position), -1) + 1 FROM milestones WHERE project_id = $1))
     RETURNING *`,
    [project.id, input.title, dates.company_start, dates.company_end,
      dates.partner_start, dates.partner_end, dates.approved_start, dates.approved_end]);

  await audit.record(req.user, 'Milestone', 'Created', input.title, project.code, project.id);
  res.status(201).json(await serialise.milestone(created, req.user));
}));

router.patch('/:id', adminOnly, asyncHandler(async function (req, res) {
  var milestone = await scope.loadVisibleMilestone(req.user, req.params.id);
  var input = v.body(dateSchema.extend({ title: v.text('Title', 200).optional() }), req);

  var title = input.title !== undefined ? input.title : milestone.title;
  var dates = readDates(Object.assign({}, req.body || {}, input), milestone);
  checkDates(dates);

  var saved = await sql.one(
    `UPDATE milestones SET title = $1,
            company_start = $2, company_end = $3,
            partner_start = $4, partner_end = $5,
            approved_start = $6, approved_end = $7
      WHERE id = $8 RETURNING *`,
    [title, dates.company_start, dates.company_end, dates.partner_start,
      dates.partner_end, dates.approved_start, dates.approved_end, milestone.id]);

  await audit.record(req.user, 'Milestone', 'Updated', title, '', milestone.project_id);
  res.json(await serialise.milestone(saved, req.user));
}));

router.delete('/:id', adminOnly, asyncHandler(async function (req, res) {
  var milestone = await scope.loadVisibleMilestone(req.user, req.params.id);
  var subtasks = Number(await sql.value(
    'SELECT count(*) FROM subtasks WHERE milestone_id = $1', [milestone.id]));

  await sql.run('DELETE FROM milestones WHERE id = $1', [milestone.id]);   // cascades to sub-tasks

  await audit.record(req.user, 'Milestone', 'Deleted', milestone.title,
    subtasks ? 'with ' + subtasks + ' sub-task' + (subtasks === 1 ? '' : 's') : '',
    milestone.project_id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------
// Sub-tasks — admin only
// ---------------------------------------------------------------
router.post('/:id/subtasks', adminOnly, asyncHandler(async function (req, res) {
  var milestone = await scope.loadVisibleMilestone(req.user, req.params.id);
  rules.assertCanAddSubtask(milestone);            // 409 if the milestone is closed

  var input = v.body(titleOnly, req);

  await sql.run(
    `INSERT INTO subtasks (milestone_id, title, position)
     VALUES ($1, $2, (SELECT coalesce(max(position), -1) + 1 FROM subtasks WHERE milestone_id = $1))`,
    [milestone.id, input.title]);

  await audit.record(req.user, 'Sub-task', 'Created', input.title,
    milestone.title, milestone.project_id);
  await sendMilestone(res.status(201), req.user, milestone.id);
}));

router.patch('/subtasks/:subtaskId', adminOnly, asyncHandler(async function (req, res) {
  var found = await scope.loadVisibleSubtask(req.user, req.params.subtaskId);
  var input = v.body(titleOnly, req);

  await sql.run('UPDATE subtasks SET title = $1 WHERE id = $2', [input.title, found.subtask.id]);
  await audit.record(req.user, 'Sub-task', 'Updated', input.title,
    found.milestone.title, found.milestone.project_id);
  await sendMilestone(res, req.user, found.milestone.id);
}));

router.delete('/subtasks/:subtaskId', adminOnly, asyncHandler(async function (req, res) {
  var found = await scope.loadVisibleSubtask(req.user, req.params.subtaskId);

  await sql.run('DELETE FROM subtasks WHERE id = $1', [found.subtask.id]);
  await audit.record(req.user, 'Sub-task', 'Deleted', found.subtask.title,
    found.milestone.title, found.milestone.project_id);
  await sendMilestone(res, req.user, found.milestone.id);
}));

// ---------------------------------------------------------------
// Completion — admin only, and only while the project is In-Progress
// ---------------------------------------------------------------
var completion = v.z.object({
  outcome: v.z.enum(['On-Time', 'Delayed'], {
    errorMap: function () { return { message: 'Choose whether it finished On-Time or was Delayed.' }; }
  }),
  delaySide: v.z.enum(['', 'Company Side', 'Partner Side']).optional().default(''),
  delayNotes: v.optionalText(2000)
});

/** Completion is recorded with the database's own date, not the server's clock. */
function completionValues(input) {
  return [
    input.outcome,
    input.outcome === 'Delayed' ? input.delaySide : '',
    input.outcome === 'Delayed' ? input.delayNotes : ''
  ];
}

router.post('/subtasks/:subtaskId/complete', adminOnly, asyncHandler(async function (req, res) {
  var found = await scope.loadVisibleSubtask(req.user, req.params.subtaskId);
  var project = await projectOf(found.milestone);
  var input = v.body(completion, req);

  rules.assertProjectInProgress(project, 'marking a sub-task complete');
  rules.assertCanCompleteSubtask(found.subtask);
  rules.assertValidCompletion(input);

  await sql.run(
    `UPDATE subtasks SET completed = true, outcome = $1, delay_side = $2,
            delay_notes = $3, completed_at = current_date
      WHERE id = $4`, completionValues(input).concat([found.subtask.id]));

  await audit.record(req.user, 'Sub-task', 'Completed', found.subtask.title,
    input.outcome + (input.outcome === 'Delayed' ? ' · ' + input.delaySide : ''),
    found.milestone.project_id);
  await sendMilestone(res, req.user, found.milestone.id);
}));

router.post('/:id/complete', adminOnly, asyncHandler(async function (req, res) {
  var milestone = await scope.loadVisibleMilestone(req.user, req.params.id);
  var project = await projectOf(milestone);
  var input = v.body(completion, req);

  rules.assertProjectInProgress(project, 'marking a milestone complete');
  await rules.assertCanCompleteMilestone(milestone);     // 409 while sub-tasks are open
  rules.assertValidCompletion(input);

  var saved = await sql.one(
    `UPDATE milestones SET completed = true, outcome = $1, delay_side = $2,
            delay_notes = $3, completed_at = current_date
      WHERE id = $4 RETURNING *`, completionValues(input).concat([milestone.id]));

  await audit.record(req.user, 'Milestone', 'Completed', milestone.title,
    input.outcome + (input.outcome === 'Delayed' ? ' · ' + input.delaySide : ''),
    milestone.project_id);
  res.json(await serialise.milestone(saved, req.user));
}));

// ---------------------------------------------------------------
// Approval trip
// ---------------------------------------------------------------
router.post('/:id/submit', adminOnly, asyncHandler(async function (req, res) {
  var milestone = await scope.loadVisibleMilestone(req.user, req.params.id);
  var project = await projectOf(milestone);

  await rules.assertCanSubmitForApproval(project, milestone);

  // State change and the intent to notify commit together, or neither does
  var saved = await sql.tx(async function (t) {
    var fresh = await t.one(
      `UPDATE milestones SET approval = 'pending', submitted_at = current_date, submitted_by = $1
        WHERE id = $2 RETURNING *`, [req.user.id, milestone.id]);
    await notify.milestoneSubmitted(t, project, fresh, req.user);
    return fresh;
  });

  await audit.record(req.user, 'Approval', 'Submitted', milestone.title, project.code, project.id);
  res.json(await serialise.milestone(saved, req.user));
}));

// The one write a partner may make — and only on their own project
router.post('/:id/approve', asyncHandler(async function (req, res) {
  var milestone = await scope.loadVisibleMilestone(req.user, req.params.id);
  var project = await projectOf(milestone);

  var input = v.body(v.z.object({
    rating: v.z.coerce.number().int().min(1, 'Give a rating between 1 and 5').max(5),
    comment: v.text('Comment', 5000),
    mentions: v.z.array(v.uuid).max(50).optional().default([])
  }), req);

  rules.assertCanApprove(req.user, project, milestone, await scope.isProjectPoc(req.user, project.id));
  rules.assertValidFeedback(input);

  // The gate. This reads the decisions already persisted against each delayed
  // item — there is no payload here for a crafted request to lie about,
  // because accepting a delay is its own authorised write.
  await rules.assertDelaysAccepted(milestone);

  var mentions = await rules.filterMentions(project.id, input.mentions);

  var saved = await sql.tx(async function (t) {
    var fresh = await t.one(
      `UPDATE milestones SET approval = 'approved', approved_by = $1, approved_at = current_date,
              feedback_rating = $2, feedback_comment = $3
        WHERE id = $4 RETURNING *`,
      [req.user.id, input.rating, input.comment, milestone.id]);

    await t.run('DELETE FROM milestone_mentions WHERE milestone_id = $1', [milestone.id]);
    if (mentions.length) {
      await t.run(
        'INSERT INTO milestone_mentions (milestone_id, person_id) SELECT $1, unnest($2::uuid[])',
        [milestone.id, mentions]);
    }

    // Nothing to record about the delays here — each was accepted by its own
    // request, which stamped who and when at the time.

    await notify.milestoneApproved(t, project, fresh, req.user,
      { rating: input.rating, comment: input.comment });
    await notify.mentioned(t, project, fresh, req.user, mentions, input.comment);
    return fresh;
  });

  await audit.record(req.user, 'Approval', 'Approved', milestone.title,
    input.rating + '/5 · ' + project.code, project.id);
  res.json(await serialise.milestone(saved, req.user));
}));

module.exports = router;
