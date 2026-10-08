/**
 * Delay negotiation: accept, deny, reply, and the attachments that go with it.
 *
 * The shape mirrors every other route file here — resolve through scope.js
 * first, so an item the caller may not see 404s before any rule runs, then ask
 * rules.js whether the move is legal.
 *
 * Attachments no longer pass through this process. The browser asks for a
 * signed upload URL (permission is checked there, before anything is issued),
 * PUTs the bytes straight to Supabase Storage, and then names the object when
 * it posts the comment. See server/uploads.js for why.
 */

var express = require('express');
var sql = require('../sql');
var guards = require('../guards');
var scope = require('../scope');
var rules = require('../rules');
var uploads = require('../uploads');
var serialise = require('../serialise');
var audit = require('../audit');
var notify = require('../mail/notify');
var v = require('../validate');

var router = express.Router();
var asyncHandler = v.asyncHandler;

router.use(guards.requireAuth);

/**
 * Resolve :itemType/:itemId to the delayed row plus its milestone and project,
 * or throw. A sub-task id is looked up through its own milestone, so an id
 * from a different project cannot be smuggled in.
 */
async function resolveTarget(user, itemType, itemId) {
  var milestone;
  if (itemType === 'milestone') {
    milestone = await scope.loadVisibleMilestone(user, itemId);
  } else if (itemType === 'subtask') {
    milestone = (await scope.loadVisibleSubtask(user, itemId)).milestone;
  } else {
    var bad = new Error('No such item');
    bad.status = 404;
    throw bad;
  }

  return {
    milestone: milestone,
    project: await sql.one('SELECT * FROM projects WHERE id = $1', [milestone.project_id]),
    item: await rules.findDelayedItem(milestone, itemType, itemId)
  };
}

/** Insert the comment and its attachment together, or neither. */
async function writeComment(t, target, user, fields) {
  var comment = await t.one(
    `INSERT INTO delay_comments
       (item_type, item_id, milestone_id, project_id, author_id, author_role, decision, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [fields.itemType, Number(fields.itemId), target.milestone.id, target.project.id,
      user.id, user.role, fields.decision || '', fields.body]);

  if (fields.attachment) {
    await t.run(
      `INSERT INTO attachments (comment_id, filename, object_path, mime, bytes)
       VALUES ($1, $2, $3, $4, $5)`,
      [comment.id, fields.attachment.filename, fields.attachment.object_path,
        fields.attachment.mime, fields.attachment.bytes]);
  }
  return comment.id;
}

async function sendMilestone(res, user, milestoneId) {
  res.json(await serialise.milestone(
    await sql.one('SELECT * FROM milestones WHERE id = $1', [milestoneId]), user));
}

var commentBody = v.z.object({
  body: v.optionalText(5000),
  objectPath: v.z.string().max(300).optional().default('')
});

// ---------------------------------------------------------------
// Step 1 of an upload — permission first, signed URL second
// ---------------------------------------------------------------
router.post('/:itemType/:itemId/upload-url', asyncHandler(async function (req, res) {
  var input = v.body(v.z.object({
    filename: v.text('File name', 255),
    bytes: v.z.coerce.number().int().positive()
  }), req);

  var target = await resolveTarget(req.user, req.params.itemType, req.params.itemId);

  // The same gates as the write that will follow. Issuing an upload URL to
  // somebody who could not then post the comment would let any signed-in user
  // put objects in the bucket.
  if (req.user.role === 'partner') {
    rules.assertCanReplyToDelay(req.user, target.milestone, target.item);
    if (!(await scope.isProjectPoc(req.user, target.project.id))) {
      var forbidden = new Error('You are not a Partner POC on this project.');
      forbidden.status = 403;
      throw forbidden;
    }
  } else {
    rules.assertCanReplyToDelay(req.user, target.milestone, target.item);
  }

  res.json(await uploads.createUploadTicket(req.person, input.filename, input.bytes));
}));

// ---------------------------------------------------------------
// Accept or deny — Partner POC only, while the milestone is pending
// ---------------------------------------------------------------
router.post('/:itemType/:itemId/decision', asyncHandler(async function (req, res) {
  var input = v.body(commentBody.extend({
    decision: v.z.enum(['accepted', 'denied'], {
      errorMap: function () { return { message: 'Choose whether you accept or deny this delay.' }; }
    })
  }), req);

  var target = await resolveTarget(req.user, req.params.itemType, req.params.itemId);

  rules.assertCanDecideDelay(req.user, target.milestone, target.item, input.decision,
    await scope.isProjectPoc(req.user, target.project.id));

  // A denial has to say why. An acceptance may simply be an acceptance.
  if (input.decision === 'denied' && !input.body) {
    var err = new Error('Say why you are denying this delay.');
    err.status = 409;
    throw err;
  }

  var table = req.params.itemType === 'milestone' ? 'milestones' : 'subtasks';

  await sql.tx(async function (t) {
    var attachment = input.objectPath
      ? await uploads.claimUpload(req.person, input.objectPath, t) : null;

    await t.run(
      'UPDATE ' + table + ' SET delay_status = $1, delay_decided_by = $2, ' +
      'delay_decided_at = current_date WHERE id = $3',
      [input.decision, req.user.id, target.item.row.id]);

    var commentId = await writeComment(t, target, req.user, {
      itemType: req.params.itemType, itemId: req.params.itemId,
      decision: input.decision, body: input.body, attachment: attachment
    });

    if (input.decision === 'denied') {
      await notify.delayDenied(t, target.project, target.milestone, req.user,
        target.item, input.body, commentId, !!attachment);
    }
  });

  await audit.record(req.user, 'Approval',
    input.decision === 'denied' ? 'Delay denied' : 'Delay accepted',
    target.item.title, target.project.code, target.project.id);
  await sendMilestone(res, req.user, target.milestone.id);
}));

// ---------------------------------------------------------------
// Reply — admin on a denied delay, or the partner on their own open thread
// ---------------------------------------------------------------
router.post('/:itemType/:itemId/comments', asyncHandler(async function (req, res) {
  var input = v.body(commentBody, req);
  var target = await resolveTarget(req.user, req.params.itemType, req.params.itemId);

  if (req.user.role === 'partner' && !(await scope.isProjectPoc(req.user, target.project.id))) {
    var forbidden = new Error('You are not a Partner POC on this project.');
    forbidden.status = 403;
    throw forbidden;
  }

  rules.assertCanReplyToDelay(req.user, target.milestone, target.item);
  rules.assertCommentHasSubstance(input.body, !!input.objectPath);

  await sql.tx(async function (t) {
    var attachment = input.objectPath
      ? await uploads.claimUpload(req.person, input.objectPath, t) : null;

    var commentId = await writeComment(t, target, req.user, {
      itemType: req.params.itemType, itemId: req.params.itemId,
      decision: '', body: input.body, attachment: attachment
    });

    if (req.user.role === 'admin') {
      await notify.delayReplied(t, target.project, target.milestone, req.user,
        target.item, input.body, commentId, !!attachment);
    }
  });

  await audit.record(req.user, 'Approval', 'Delay comment', target.item.title,
    target.project.code, target.project.id);
  await sendMilestone(res, req.user, target.milestone.id);
}));

// ---------------------------------------------------------------
// Download — the only way an uploaded file is ever reachable
// ---------------------------------------------------------------
router.get('/attachments/:id', asyncHandler(async function (req, res) {
  var id = Number(req.params.id);
  var row = Number.isInteger(id) ? await sql.one(
    `SELECT a.*, c.project_id FROM attachments a
       JOIN delay_comments c ON c.id = a.comment_id
      WHERE a.id = $1`, [id]) : null;

  // 404 rather than 403 for an out-of-scope project, matching scope.js: an
  // attachment id should not reveal that somebody else's project exists.
  if (!row) return res.status(404).json({ error: 'No such attachment' });
  await scope.loadVisibleProject(req.user, row.project_id);

  // A 60-second link, issued only after that check. `download` makes Supabase
  // send Content-Disposition: attachment, so a stored file can never render in
  // this app's origin — the protection the streaming version provided.
  var url = await uploads.signedDownloadUrl(row.object_path, row.filename);

  // 302 for a plain <a download>; JSON for a fetch that wants the URL itself.
  if (String(req.query.json) === '1') return res.json({ url: url, filename: row.filename });
  res.redirect(302, url);
}));

module.exports = router;
