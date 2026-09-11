/**
 * Delay negotiation: accept, deny, reply, and the attachments that go with it.
 *
 * The shape mirrors every other route file here — resolve through scope.js
 * first, so an item the caller may not see 404s before any rule runs, then ask
 * rules.js whether the move is legal. The upload is written to disk by multer
 * before we get here, so anything that rejects the request has to discard it.
 */

var express = require('express');
var fs = require('fs');
var db = require('../db').db;
var guards = require('../guards');
var scope = require('../scope');
var rules = require('../rules');
var uploads = require('../uploads');
var serialise = require('../serialise');
var audit = require('../audit');
var notify = require('../mail/notify');

var router = express.Router();
router.use(guards.requireAuth);

var now = function () { return new Date().toISOString(); };
var today = function () { return new Date().toISOString().slice(0, 10); };

/**
 * Resolve :itemType/:itemId to the delayed row plus its milestone and project,
 * or throw. A sub-task id is looked up through its own milestone, so an id from
 * a different project cannot be smuggled in.
 */
function resolveTarget(user, itemType, itemId) {
  var milestone;
  if (itemType === 'milestone') {
    milestone = scope.loadVisibleMilestone(user, itemId);
  } else if (itemType === 'subtask') {
    milestone = scope.loadVisibleSubtask(user, itemId).milestone;
  } else {
    var bad = new Error('No such item');
    bad.status = 404;
    throw bad;
  }
  var project = db.prepare('SELECT * FROM projects WHERE id = ?').get(milestone.project_id);
  return {
    milestone: milestone,
    project: project,
    item: rules.findDelayedItem(milestone, itemType, itemId)
  };
}

/** Insert the comment and its attachment together, or neither. */
function writeComment(target, user, fields) {
  var commentId = db.prepare(`INSERT INTO delay_comments
    (item_type, item_id, milestone_id, project_id, author_id, author_role, decision, body, created_at)
    VALUES (@item_type, @item_id, @milestone_id, @project_id, @author_id, @author_role,
            @decision, @body, @created_at)`).run({
    item_type: fields.itemType,
    item_id: Number(fields.itemId),
    milestone_id: target.milestone.id,
    project_id: target.project.id,
    author_id: user.id,
    author_role: user.role,
    decision: fields.decision || '',
    body: fields.body,
    created_at: now()
  }).lastInsertRowid;

  if (fields.file) {
    var described = uploads.describe(fields.file);
    db.prepare(`INSERT INTO attachments
      (comment_id, filename, stored_name, mime, bytes, created_at)
      VALUES (@comment_id, @filename, @stored_name, @mime, @bytes, @created_at)`)
      .run(Object.assign({ comment_id: commentId, created_at: now() }, described));
  }
  return commentId;
}

function sendMilestone(res, user, milestoneId) {
  res.json(serialise.milestone(
    db.prepare('SELECT * FROM milestones WHERE id = ?').get(milestoneId), user));
}

// ---------------------------------------------------------------
// Accept or deny — Partner POC only, while the milestone is pending
// ---------------------------------------------------------------
router.post('/:itemType/:itemId/decision', uploads.accept, function (req, res, next) {
  try {
    var body = req.body || {};
    var target = resolveTarget(req.user, req.params.itemType, req.params.itemId);
    var decision = String(body.decision || '');

    rules.assertCanDecideDelay(req.user, target.milestone, target.item, decision,
      scope.isProjectPoc(req.user, target.project.id));

    // A denial has to say why. An acceptance may simply be an acceptance.
    var text = String(body.body || '').trim();
    if (decision === 'denied' && !text) {
      var err = new Error('Say why you are denying this delay.');
      err.status = 409;
      throw err;
    }

    var table = req.params.itemType === 'milestone' ? 'milestones' : 'subtasks';
    var commentId;

    db.transaction(function () {
      db.prepare('UPDATE ' + table + ' SET delay_status = ?, delay_decided_by = ?, delay_decided_at = ? WHERE id = ?')
        .run(decision, req.user.id, today(), target.item.row.id);

      commentId = writeComment(target, req.user, {
        itemType: req.params.itemType, itemId: req.params.itemId,
        decision: decision, body: text, file: req.file
      });

      if (decision === 'denied') {
        notify.delayDenied(target.project, target.milestone, req.user, target.item, text, commentId, !!req.file);
      }
    })();

    audit.record(req.user, 'Approval', decision === 'denied' ? 'Delay denied' : 'Delay accepted',
      target.item.title, target.project.code, target.project.id);
    sendMilestone(res, req.user, target.milestone.id);
  } catch (e) {
    uploads.discard(req.file);          // multer already wrote it; nothing owns it now
    next(e);
  }
});

// ---------------------------------------------------------------
// Reply — admin on a denied delay, or the partner on their own open thread
// ---------------------------------------------------------------
router.post('/:itemType/:itemId/comments', uploads.accept, function (req, res, next) {
  try {
    var body = req.body || {};
    var target = resolveTarget(req.user, req.params.itemType, req.params.itemId);

    if (req.user.role === 'partner' && !scope.isProjectPoc(req.user, target.project.id)) {
      var forbidden = new Error('You are not a Partner POC on this project.');
      forbidden.status = 403;
      throw forbidden;
    }

    rules.assertCanReplyToDelay(req.user, target.milestone, target.item);
    rules.assertCommentHasSubstance(body.body, !!req.file);

    var text = String(body.body || '').trim();
    var commentId;

    db.transaction(function () {
      commentId = writeComment(target, req.user, {
        itemType: req.params.itemType, itemId: req.params.itemId,
        decision: '', body: text, file: req.file
      });

      if (req.user.role === 'admin') {
        notify.delayReplied(target.project, target.milestone, req.user, target.item, text, commentId, !!req.file);
      }
    })();

    audit.record(req.user, 'Approval', 'Delay comment', target.item.title,
      target.project.code, target.project.id);
    sendMilestone(res, req.user, target.milestone.id);
  } catch (e) {
    uploads.discard(req.file);
    next(e);
  }
});

// ---------------------------------------------------------------
// Download — the only way an uploaded file is ever reachable
// ---------------------------------------------------------------
router.get('/attachments/:id', function (req, res, next) {
  try {
    var row = db.prepare(`SELECT a.*, c.project_id FROM attachments a
      JOIN delay_comments c ON c.id = a.comment_id WHERE a.id = ?`).get(req.params.id);

    // 404 rather than 403 for an out-of-scope project, matching scope.js: an
    // attachment id should not reveal that somebody else's project exists.
    if (!row) return res.status(404).json({ error: 'No such attachment' });
    scope.loadVisibleProject(req.user, row.project_id);

    var file = uploads.pathOf(row.stored_name);
    if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'No such attachment' });

    // Always a download, never rendered. A stored file served inline from this
    // origin would be script execution with our cookies attached.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition',
      'attachment; filename="' + row.filename.replace(/[^\w.\- ]/g, '_') + '"; ' +
      "filename*=UTF-8''" + encodeURIComponent(row.filename));
    res.sendFile(file);
  } catch (e) { next(e); }
});

module.exports = router;
