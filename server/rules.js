/**
 * The workflow state machine — the single source of truth.
 *
 * Every one of these rules used to live only in the browser, which meant a
 * hand-written request could ignore all of them. They now run here; the client
 * keeps its own copies purely so buttons can be disabled with a helpful reason.
 *
 * Each check throws a conflict (409) or forbidden (403) with a message the UI
 * can show verbatim.
 */

var db = require('./db').db;

function fail(status, message) {
  var err = new Error(message);
  err.status = status;
  throw err;
}

var conflict = function (m) { fail(409, m); };
var forbidden = function (m) { fail(403, m); };

var STATUS_FLOW = ['Not Started', 'In-Progress', 'Completed'];
var OUTCOMES = ['On-Time', 'Delayed'];
var DELAY_SIDES = ['Company Side', 'Partner Side'];

// ---------------------------------------------------------------
// Reads used by the rules
// ---------------------------------------------------------------
function milestonesOf(projectId) {
  return db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY position, id').all(projectId);
}

function subtasksOf(milestoneId) {
  return db.prepare('SELECT * FROM subtasks WHERE milestone_id = ? ORDER BY position, id').all(milestoneId);
}

function openSubtaskCount(milestoneId) {
  return db.prepare('SELECT COUNT(*) AS n FROM subtasks WHERE milestone_id = ? AND completed = 0')
    .get(milestoneId).n;
}

function pocCount(projectId) {
  return db.prepare('SELECT COUNT(*) AS n FROM project_pocs WHERE project_id = ?').get(projectId).n;
}

// A milestone only counts as finished once it is completed AND approved
function unfinishedMilestones(projectId) {
  return milestonesOf(projectId).filter(function (m) {
    return !m.completed || m.approval !== 'approved';
  });
}

// ---------------------------------------------------------------
// Project rules
// ---------------------------------------------------------------
function assertValidStatus(status) {
  if (STATUS_FLOW.indexOf(status) === -1) conflict('Unknown project status "' + status + '".');
}

function assertStatusTransition(project, next) {
  assertValidStatus(next);
  if (next === project.status) return;

  if (STATUS_FLOW.indexOf(next) < STATUS_FLOW.indexOf(project.status)) {
    conflict('Project status only moves forward. "' + project.status +
      '" cannot go back to "' + next + '".');
  }

  if (next === 'Completed') {
    var open = unfinishedMilestones(project.id);
    if (open.length) {
      var stillOpen = open.filter(function (m) { return !m.completed; }).length;
      var awaiting = open.length - stillOpen;
      var parts = [];
      if (stillOpen) parts.push(stillOpen + ' milestone' + (stillOpen === 1 ? '' : 's') + ' still open');
      if (awaiting) parts.push(awaiting + ' milestone' + (awaiting === 1 ? '' : 's') + ' awaiting partner approval');
      conflict(parts.join(' and ') +
        ' — every milestone must be completed and approved before this project can be marked Completed.');
    }
  }
}

// Milestone and sub-task status may only change while the project is running
function assertProjectInProgress(project, what) {
  if (project.status !== 'In-Progress') {
    conflict('This project is ' + project.status + ' — ' + what +
      ' is only possible while it is In-Progress.');
  }
}

// ---------------------------------------------------------------
// Milestone rules
// ---------------------------------------------------------------
function assertCanAddSubtask(milestone) {
  if (milestone.completed) {
    conflict('"' + milestone.title + '" is completed — closed milestones take no new sub-tasks.');
  }
}

function assertCanCompleteMilestone(milestone) {
  if (milestone.completed) conflict('"' + milestone.title + '" is already completed. Completion is final.');
  var open = openSubtaskCount(milestone.id);
  if (open) {
    conflict('Complete all ' + open + ' sub-task' + (open === 1 ? '' : 's') + ' first.');
  }
}

function assertCanCompleteSubtask(subtask) {
  if (subtask.completed) conflict('"' + subtask.title + '" is already completed. Completion is final.');
}

function assertValidCompletion(payload) {
  if (OUTCOMES.indexOf(payload.outcome) === -1) {
    conflict('Choose whether it finished On-Time or was Delayed.');
  }
  if (payload.outcome === 'Delayed' && DELAY_SIDES.indexOf(payload.delaySide) === -1) {
    conflict('Attribute the delay to either the company or the partner side.');
  }
}

// ---------------------------------------------------------------
// Approval rules
// ---------------------------------------------------------------
function assertCanSubmitForApproval(project, milestone) {
  if (!milestone.completed) {
    conflict('Complete "' + milestone.title + '" before submitting it for approval.');
  }
  if (milestone.approval !== 'none') {
    conflict('"' + milestone.title + '" has already been submitted.');
  }
  if (!pocCount(project.id)) {
    conflict('Assign a Partner POC to this project before submitting for approval.');
  }
}

function assertCanApprove(user, project, milestone, isPoc) {
  if (user.role !== 'partner') {
    forbidden('Only the assigned Partner POC can approve a milestone.');
  }
  if (!isPoc) {
    forbidden('You are not a Partner POC on this project.');
  }
  if (milestone.approval !== 'pending') {
    conflict(milestone.approval === 'approved'
      ? '"' + milestone.title + '" is already approved.'
      : '"' + milestone.title + '" has not been submitted for approval.');
  }
}

function assertValidFeedback(payload) {
  var rating = Number(payload.rating);
  if (!(rating >= 1 && rating <= 5)) conflict('Give a rating between 1 and 5.');
  if (!String(payload.comment || '').trim()) {
    conflict('Add a comment before approving this milestone.');
  }
}

// ---------------------------------------------------------------
// Delays
//
// A delay is a decision that lives in the database, not a checkbox collected on
// the approve request. That distinction is the whole point: the partner can
// deny one, walk away, and come back — and a crafted approve call cannot
// fabricate consent, because consent is state that had to be written earlier by
// a separate authorised request.
// ---------------------------------------------------------------
var isDelayed = function (item) { return !!item.completed && item.outcome === 'Delayed'; };

/** Every delayed milestone and sub-task on this milestone, in display order. */
function delayedItemsOf(milestone) {
  var items = [];
  if (isDelayed(milestone)) {
    items.push({ type: 'milestone', row: milestone, title: milestone.title });
  }
  subtasksOf(milestone.id).forEach(function (st) {
    if (isDelayed(st)) items.push({ type: 'subtask', row: st, title: st.title });
  });
  return items;
}

/**
 * The approval gate. Reads the persisted decision rather than trusting input,
 * so there is nothing for a request to lie about.
 */
function assertDelaysAccepted(milestone) {
  var undecided = [];
  var denied = [];

  delayedItemsOf(milestone).forEach(function (item) {
    var label = item.type === 'milestone' ? 'the milestone itself' : '"' + item.title + '"';
    if (item.row.delay_status === 'denied') denied.push(label);
    else if (item.row.delay_status !== 'accepted') undecided.push(label);
  });

  if (denied.length) {
    conflict('You denied the delay on ' + denied.join(', ') +
      '. Accept it, or wait for a reply, before approving this milestone.');
  }
  if (undecided.length) {
    conflict('Accept or deny the delay on ' + undecided.join(', ') +
      ' before approving this milestone.');
  }
}

/** Locate a delayed item by type and id, confirming it belongs to this milestone. */
function findDelayedItem(milestone, itemType, itemId) {
  var id = Number(itemId);
  if (itemType === 'milestone') {
    if (milestone.id !== id) return null;
    return isDelayed(milestone) ? { type: 'milestone', row: milestone, title: milestone.title } : null;
  }
  if (itemType !== 'subtask') return null;
  var found = subtasksOf(milestone.id).filter(function (st) { return st.id === id; })[0];
  if (!found || !isDelayed(found)) return null;
  return { type: 'subtask', row: found, title: found.title };
}

var DECISIONS = ['accepted', 'denied'];

/**
 * Only the assigned Partner POC decides, and only while the milestone is
 * actually sitting with them. Once approved the negotiation is closed.
 */
function assertCanDecideDelay(user, milestone, item, decision, isPoc) {
  if (user.role !== 'partner') forbidden('Only the assigned Partner POC can accept or deny a delay.');
  if (!isPoc) forbidden('You are not a Partner POC on this project.');
  if (DECISIONS.indexOf(decision) === -1) conflict('Choose whether you accept or deny this delay.');
  if (!item) conflict('That item is not recorded as delayed.');
  if (milestone.approval === 'approved') {
    conflict('"' + milestone.title + '" is already approved — its delays are settled.');
  }
  if (milestone.approval !== 'pending') {
    conflict('"' + milestone.title + '" has not been submitted for approval yet.');
  }
}

/**
 * The admin gets a reply box on a denial and nowhere else. An accepted delay is
 * settled, and an undecided one has not been objected to yet.
 */
function assertCanReplyToDelay(user, milestone, item) {
  if (!item) conflict('That item is not recorded as delayed.');
  if (user.role === 'admin') {
    if (item.row.delay_status !== 'denied') {
      conflict('You can only reply once the Partner POC has denied this delay.');
    }
    return;
  }
  // The partner may keep talking on their own thread while it is open
  if (milestone.approval === 'approved') {
    conflict('"' + milestone.title + '" is already approved — its delays are settled.');
  }
}

function assertCommentHasSubstance(body, hasFile) {
  if (!String(body || '').trim() && !hasFile) {
    conflict('Write a comment or attach a file.');
  }
}

/** Each pair independently: an end date cannot precede its own start. */
function assertValidDatePairs(pairs) {
  Object.keys(pairs).forEach(function (label) {
    var range = pairs[label];
    if (range[0] && range[1] && range[1] < range[0]) {
      fail(400, label + ' end date cannot be before its start date.');
    }
  });
}

// Mentions must be people actually assigned to the project being reviewed
function filterMentions(projectId, personIds) {
  if (!Array.isArray(personIds) || !personIds.length) return [];
  var allowed = db.prepare(`
    SELECT person_id FROM project_resources WHERE project_id = @p
    UNION
    SELECT person_id FROM project_pocs      WHERE project_id = @p`).all({ p: projectId })
    .map(function (r) { return r.person_id; });
  return personIds.filter(function (id) { return allowed.indexOf(id) > -1; });
}

module.exports = {
  STATUS_FLOW: STATUS_FLOW,
  OUTCOMES: OUTCOMES,
  DELAY_SIDES: DELAY_SIDES,
  milestonesOf: milestonesOf,
  subtasksOf: subtasksOf,
  openSubtaskCount: openSubtaskCount,
  unfinishedMilestones: unfinishedMilestones,
  assertValidStatus: assertValidStatus,
  assertStatusTransition: assertStatusTransition,
  assertProjectInProgress: assertProjectInProgress,
  assertCanAddSubtask: assertCanAddSubtask,
  assertCanCompleteMilestone: assertCanCompleteMilestone,
  assertCanCompleteSubtask: assertCanCompleteSubtask,
  assertValidCompletion: assertValidCompletion,
  assertCanSubmitForApproval: assertCanSubmitForApproval,
  assertCanApprove: assertCanApprove,
  assertValidFeedback: assertValidFeedback,
  assertValidDatePairs: assertValidDatePairs,
  filterMentions: filterMentions,
  DECISIONS: DECISIONS,
  isDelayed: isDelayed,
  delayedItemsOf: delayedItemsOf,
  findDelayedItem: findDelayedItem,
  assertDelaysAccepted: assertDelaysAccepted,
  assertCanDecideDelay: assertCanDecideDelay,
  assertCanReplyToDelay: assertCanReplyToDelay,
  assertCommentHasSubstance: assertCommentHasSubstance
};
