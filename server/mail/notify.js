/**
 * The scenario layer: who gets told what, when.
 *
 * Routes call these from inside a transaction and pass the handle through, so
 * the intent to notify commits with the change that caused it.
 *
 * Every function is defensive about missing email addresses: a person without
 * one is skipped rather than queued with an empty recipient.
 */

var sql = require('../sql');
var outbox = require('./outbox');
var templates = require('./templates');

function person(id, runner) {
  return (runner || sql).one('SELECT * FROM people WHERE id = $1', [id]);
}

function peopleOn(table, projectId, runner) {
  return (runner || sql).many(
    'SELECT p.* FROM people p JOIN ' + table + ' j ON j.person_id = p.id WHERE j.project_id = $1',
    [projectId]);
}

/** Queue one templated message, skipping anyone with no address. */
function queue(runner, event, dedupeKey, recipient, built, ids) {
  if (!recipient || !recipient.email) return Promise.resolve(false);
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
  }, runner);
}

// ---------------------------------------------------------------
// 1. Submitted for approval → every POC on the project
// ---------------------------------------------------------------
async function milestoneSubmitted(runner, project, milestone, actor) {
  var recipients = await peopleOn('project_pocs', project.id, runner);
  var queued = 0;

  for (var i = 0; i < recipients.length; i++) {
    var recipient = recipients[i];
    var built = templates.milestoneSubmitted({
      project: project, milestone: milestone, actor: actor, recipient: recipient
    });
    /* eslint-disable no-await-in-loop */
    if (await queue(runner, 'milestone.submitted',
      'milestone.submitted:' + milestone.id + ':' + recipient.id, recipient, built,
      { projectId: project.id, milestoneId: milestone.id })) queued++;
  }
  return queued;
}

// ---------------------------------------------------------------
// 2. Approved → whoever submitted it
// ---------------------------------------------------------------
async function milestoneApproved(runner, project, milestone, approver, feedback) {
  if (!milestone.submitted_by) return 0;
  var recipient = await person(milestone.submitted_by, runner);
  if (!recipient) return 0;

  var built = templates.milestoneApproved({
    project: project, milestone: milestone, approver: approver, recipient: recipient,
    rating: feedback.rating, comment: feedback.comment
  });
  return (await queue(runner, 'milestone.approved', 'milestone.approved:' + milestone.id,
    recipient, built, { projectId: project.id, milestoneId: milestone.id })) ? 1 : 0;
}

// ---------------------------------------------------------------
// 3. Mentioned in approval feedback → each mentioned person
// ---------------------------------------------------------------
async function mentioned(runner, project, milestone, approver, personIds, comment) {
  var queued = 0;
  for (var i = 0; i < personIds.length; i++) {
    /* eslint-disable no-await-in-loop */
    var recipient = await person(personIds[i], runner);
    if (!recipient || recipient.id === approver.id) continue;   // no self-notifications

    var built = templates.mentioned({
      project: project, milestone: milestone, approver: approver,
      recipient: recipient, comment: comment
    });
    if (await queue(runner, 'feedback.mention',
      'feedback.mention:' + milestone.id + ':' + recipient.id, recipient, built,
      { projectId: project.id, milestoneId: milestone.id })) queued++;
  }
  return queued;
}

// ---------------------------------------------------------------
// 4. Project completed → everyone on it (resources and POCs, once each)
// ---------------------------------------------------------------
async function projectCompleted(runner, project, actor) {
  var counts = await (runner || sql).one(
    `SELECT count(*)::int AS milestones,
            coalesce(sum(CASE WHEN outcome = 'Delayed' THEN 1 ELSE 0 END), 0)::int AS delayed
       FROM milestones WHERE project_id = $1 AND completed = true`, [project.id]);

  var summary = {
    milestones: counts.milestones,
    delayed: counts.delayed,
    onTime: counts.milestones - counts.delayed
  };

  // Someone who is both a resource and a POC should hear once
  var seen = {};
  var everyone = (await peopleOn('project_resources', project.id, runner))
    .concat(await peopleOn('project_pocs', project.id, runner))
    .filter(function (p) {
      if (seen[p.id]) return false;
      seen[p.id] = true;
      return true;
    });

  var queued = 0;
  for (var i = 0; i < everyone.length; i++) {
    var recipient = everyone[i];
    var built = templates.projectCompleted({
      project: project, actor: actor, recipient: recipient, summary: summary
    });
    /* eslint-disable no-await-in-loop */
    if (await queue(runner, 'project.completed',
      'project.completed:' + project.id + ':' + recipient.id, recipient, built,
      { projectId: project.id })) queued++;
  }
  return queued;
}

// ---------------------------------------------------------------
// 5. Newly named as POC → only the people actually added
// ---------------------------------------------------------------
async function pocAssigned(runner, project, actor, addedIds) {
  var queued = 0;
  for (var i = 0; i < addedIds.length; i++) {
    /* eslint-disable no-await-in-loop */
    var recipient = await person(addedIds[i], runner);
    if (!recipient) continue;
    var built = templates.pocAssigned({ project: project, actor: actor, recipient: recipient });
    if (await queue(runner, 'poc.assigned', 'poc.assigned:' + project.id + ':' + recipient.id,
      recipient, built, { projectId: project.id })) queued++;
  }
  return queued;
}

// ---------------------------------------------------------------
// 6. A delay was denied → whoever submitted the milestone for approval
// ---------------------------------------------------------------
async function delayDenied(runner, project, milestone, actor, item, comment, commentId, hasAttachment) {
  if (!milestone.submitted_by) return 0;
  var recipient = await person(milestone.submitted_by, runner);
  if (!recipient) return 0;

  var built = templates.delayDenied({
    project: project, milestone: milestone, actor: actor, recipient: recipient,
    itemLabel: item.title, comment: comment, hasAttachment: !!hasAttachment
  });

  // Keyed on the comment, not the item: a delay can be denied, accepted and
  // denied again, and an item-keyed dedupe would swallow every denial after
  // the first.
  return (await queue(runner, 'delay.denied', 'delay.denied:' + commentId, recipient, built,
    { projectId: project.id, milestoneId: milestone.id })) ? 1 : 0;
}

// ---------------------------------------------------------------
// 7. The admin replied on a denial → the POC who denied it
// ---------------------------------------------------------------
async function delayReplied(runner, project, milestone, actor, item, comment, commentId, hasAttachment) {
  if (!item.row.delay_decided_by) return 0;
  var recipient = await person(item.row.delay_decided_by, runner);
  if (!recipient || recipient.id === actor.id) return 0;

  var built = templates.delayReplied({
    project: project, milestone: milestone, actor: actor, recipient: recipient,
    itemLabel: item.title, comment: comment, hasAttachment: !!hasAttachment
  });

  return (await queue(runner, 'delay.replied', 'delay.replied:' + commentId, recipient, built,
    { projectId: project.id, milestoneId: milestone.id })) ? 1 : 0;
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
