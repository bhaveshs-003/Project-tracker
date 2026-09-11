/**
 * The scenario layer: who gets told what, when.
 *
 * Routes call these. Each resolves recipients from the existing join tables and
 * enqueues — no sending happens here, so these are safe to call inside a
 * transaction.
 *
 * Every function is defensive about missing email addresses: a person without
 * one is skipped rather than queued with an empty recipient.
 */

var db = require('../db').db;
var outbox = require('./outbox');
var templates = require('./templates');

function person(id) {
  return db.prepare('SELECT * FROM people WHERE id = ?').get(id) || null;
}

function peopleOn(table, projectId) {
  return db.prepare(
    'SELECT p.* FROM people p JOIN ' + table + ' j ON j.person_id = p.id WHERE j.project_id = ?'
  ).all(projectId);
}

function actorPerson(user) {
  return person(user.id) || { id: user.id, name: user.name, email: user.email };
}

/** Queue one templated message, skipping anyone with no address. */
function queue(event, dedupeKey, recipient, built, ids) {
  if (!recipient || !recipient.email) return false;
  return outbox.enqueue({
    event: event,
    dedupeKey: dedupeKey,
    to: recipient.email,
    toName: recipient.name,
    subject: built.subject,
    text: built.text,
    html: built.html,
    projectId: (ids && ids.projectId) || null,
    milestoneId: (ids && ids.milestoneId) || null
  });
}

// ---------------------------------------------------------------
// 1. Submitted for approval → every POC on the project
// ---------------------------------------------------------------
function milestoneSubmitted(project, milestone, user) {
  var actor = actorPerson(user);
  var queued = 0;

  peopleOn('project_pocs', project.id).forEach(function (recipient) {
    var built = templates.milestoneSubmitted({ project: project, milestone: milestone, actor: actor, recipient: recipient });
    if (queue('milestone.submitted', 'milestone.submitted:' + milestone.id + ':' + recipient.id,
      recipient, built, { projectId: project.id, milestoneId: milestone.id })) queued++;
  });

  return queued;
}

// ---------------------------------------------------------------
// 2. Approved → whoever submitted it
// ---------------------------------------------------------------
function milestoneApproved(project, milestone, user, feedback) {
  var approver = actorPerson(user);
  var recipient = milestone.submitted_by ? person(milestone.submitted_by) : null;
  if (!recipient) return 0;   // submitted before the column existed, or the person is gone

  var built = templates.milestoneApproved({
    project: project, milestone: milestone, approver: approver, recipient: recipient,
    rating: feedback.rating, comment: feedback.comment
  });
  return queue('milestone.approved', 'milestone.approved:' + milestone.id,
    recipient, built, { projectId: project.id, milestoneId: milestone.id }) ? 1 : 0;
}

// ---------------------------------------------------------------
// 3. Mentioned in approval feedback → each mentioned person
// ---------------------------------------------------------------
function mentioned(project, milestone, user, personIds, comment) {
  var approver = actorPerson(user);
  var queued = 0;

  personIds.forEach(function (id) {
    var recipient = person(id);
    if (!recipient || recipient.id === user.id) return;   // no self-notifications
    var built = templates.mentioned({
      project: project, milestone: milestone, approver: approver, recipient: recipient, comment: comment
    });
    if (queue('feedback.mention', 'feedback.mention:' + milestone.id + ':' + recipient.id,
      recipient, built, { projectId: project.id, milestoneId: milestone.id })) queued++;
  });

  return queued;
}

// ---------------------------------------------------------------
// 4. Project completed → everyone on it (resources and POCs, once each)
// ---------------------------------------------------------------
function projectCompleted(project, user) {
  var actor = actorPerson(user);

  var counts = db.prepare(`SELECT
      COUNT(*) AS milestones,
      SUM(CASE WHEN outcome = 'Delayed' THEN 1 ELSE 0 END) AS delayed
    FROM milestones WHERE project_id = ? AND completed = 1`).get(project.id);
  var summary = {
    milestones: counts.milestones || 0,
    delayed: counts.delayed || 0,
    onTime: (counts.milestones || 0) - (counts.delayed || 0)
  };

  // Someone who is both a resource and a POC should hear once
  var seen = {};
  var everyone = peopleOn('project_resources', project.id)
    .concat(peopleOn('project_pocs', project.id))
    .filter(function (p) {
      if (seen[p.id]) return false;
      seen[p.id] = true;
      return true;
    });

  var queued = 0;
  everyone.forEach(function (recipient) {
    var built = templates.projectCompleted({ project: project, actor: actor, recipient: recipient, summary: summary });
    if (queue('project.completed', 'project.completed:' + project.id + ':' + recipient.id,
      recipient, built, { projectId: project.id })) queued++;
  });

  return queued;
}

// ---------------------------------------------------------------
// 5. Newly named as POC → only the people actually added
// ---------------------------------------------------------------
function pocAssigned(project, user, addedIds) {
  var actor = actorPerson(user);
  var queued = 0;

  addedIds.forEach(function (id) {
    var recipient = person(id);
    var built = templates.pocAssigned({ project: project, actor: actor, recipient: recipient });
    if (queue('poc.assigned', 'poc.assigned:' + project.id + ':' + id,
      recipient, built, { projectId: project.id })) queued++;
  });

  return queued;
}

// ---------------------------------------------------------------
// 6. A delay was denied → whoever submitted the milestone for approval
// ---------------------------------------------------------------
function delayDenied(project, milestone, user, item, comment, commentId, hasAttachment) {
  var actor = actorPerson(user);
  var recipient = milestone.submitted_by ? person(milestone.submitted_by) : null;
  if (!recipient) return 0;

  var built = templates.delayDenied({
    project: project, milestone: milestone, actor: actor, recipient: recipient,
    itemLabel: item.title, comment: comment, hasAttachment: !!hasAttachment
  });

  // Keyed on the comment, not the item: a delay can be denied, accepted and
  // denied again, and an item-keyed dedupe would swallow every denial after
  // the first.
  return queue('delay.denied', 'delay.denied:' + commentId, recipient, built,
    { projectId: project.id, milestoneId: milestone.id }) ? 1 : 0;
}

// ---------------------------------------------------------------
// 7. The admin replied on a denial → the POC who denied it
// ---------------------------------------------------------------
function delayReplied(project, milestone, user, item, comment, commentId, hasAttachment) {
  var actor = actorPerson(user);
  var recipient = item.row.delay_decided_by ? person(item.row.delay_decided_by) : null;
  if (!recipient || recipient.id === user.id) return 0;

  var built = templates.delayReplied({
    project: project, milestone: milestone, actor: actor, recipient: recipient,
    itemLabel: item.title, comment: comment, hasAttachment: !!hasAttachment
  });

  return queue('delay.replied', 'delay.replied:' + commentId, recipient, built,
    { projectId: project.id, milestoneId: milestone.id }) ? 1 : 0;
}

module.exports = {
  milestoneSubmitted: milestoneSubmitted,
  milestoneApproved: milestoneApproved,
  mentioned: mentioned,
  projectCompleted: projectCompleted,
  pocAssigned: pocAssigned,
  delayDenied: delayDenied,
  delayReplied: delayReplied
};
