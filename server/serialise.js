/**
 * Turning rows into the shapes the client expects.
 *
 * This is also where feedback is stripped for partners. Doing it in one place
 * means no route can accidentally leak it — the client never receives the
 * fields rather than being trusted to hide them.
 */

var db = require('./db').db;
var scope = require('./scope');

function personIds(table, projectId) {
  return db.prepare('SELECT person_id FROM ' + table + ' WHERE project_id = ?')
    .all(projectId).map(function (r) { return r.person_id; });
}

/**
 * The comment thread hanging off one delayed milestone or sub-task.
 *
 * Deliberately *not* filtered by role. Delay comments are a negotiation between
 * the two sides — unlike approval feedback below, which is company-side only,
 * both parties are meant to read every message.
 */
function delayThread(itemType, itemId) {
  var comments = db.prepare(`SELECT * FROM delay_comments
    WHERE item_type = ? AND item_id = ? ORDER BY created_at, id`).all(itemType, itemId);
  if (!comments.length) return [];

  var files = db.prepare('SELECT * FROM attachments WHERE comment_id = ? ORDER BY id');
  return comments.map(function (c) {
    return {
      id: c.id,
      authorId: c.author_id,
      authorRole: c.author_role,
      decision: c.decision,
      body: c.body,
      createdAt: c.created_at,
      attachments: files.all(c.id).map(function (a) {
        return { id: a.id, filename: a.filename, mime: a.mime, bytes: a.bytes };
      })
    };
  });
}

function subtask(row) {
  return {
    id: row.id,
    title: row.title,
    completed: !!row.completed,
    outcome: row.outcome,
    delaySide: row.delay_side,
    delayNotes: row.delay_notes,
    completedAt: row.completed_at,
    delayStatus: row.delay_status,
    delayDecidedBy: row.delay_decided_by,
    delayDecidedAt: row.delay_decided_at,
    delayComments: delayThread('subtask', row.id)
  };
}

/**
 * Which of the three pairs actually governs this milestone: what was agreed,
 * else the company's plan, else what the partner asked for. Resolved here so
 * the client never has to re-derive it and get it subtly different.
 */
function effectiveRange(row) {
  if (row.approved_start || row.approved_end) return [row.approved_start, row.approved_end, 'approved'];
  if (row.company_start || row.company_end) return [row.company_start, row.company_end, 'company'];
  return [row.partner_start, row.partner_end, 'partner'];
}

function milestone(row, user) {
  var effective = effectiveRange(row);
  var out = {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    companyStart: row.company_start,
    companyEnd: row.company_end,
    partnerStart: row.partner_start,
    partnerEnd: row.partner_end,
    approvedStart: row.approved_start,
    approvedEnd: row.approved_end,
    effectiveStart: effective[0],
    effectiveEnd: effective[1],
    effectiveSource: effective[2],
    completed: !!row.completed,
    outcome: row.outcome,
    delaySide: row.delay_side,
    delayNotes: row.delay_notes,
    completedAt: row.completed_at,
    approval: row.approval,
    submittedAt: row.submitted_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    delayStatus: row.delay_status,
    delayDecidedBy: row.delay_decided_by,
    delayDecidedAt: row.delay_decided_at,
    delayComments: delayThread('milestone', row.id),
    subtasks: db.prepare('SELECT * FROM subtasks WHERE milestone_id = ? ORDER BY position, id')
      .all(row.id).map(subtask)
  };

  // Partner feedback is for the company side only
  if (scope.isAdmin(user) && row.feedback_rating != null) {
    out.feedback = {
      rating: row.feedback_rating,
      comment: row.feedback_comment,
      mentions: db.prepare('SELECT person_id FROM milestone_mentions WHERE milestone_id = ?')
        .all(row.id).map(function (r) { return r.person_id; })
    };
  } else {
    out.feedback = null;
  }

  return out;
}

function project(row, user) {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    description: row.description,
    type: row.type,
    status: row.status,
    partnerStart: row.partner_start,
    partnerEnd: row.partner_end,
    companyStart: row.company_start,
    companyEnd: row.company_end,
    approvedStart: row.approved_start,
    approvedEnd: row.approved_end,
    resources: personIds('project_resources', row.id),
    pocs: personIds('project_pocs', row.id),
    milestones: db.prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY position, id')
      .all(row.id).map(function (m) { return milestone(m, user); })
  };
}

function person(row) {
  return { id: row.id, name: row.name, role: row.job_title, email: row.email || '', kind: row.kind };
}

function auditEntry(row) {
  return {
    id: row.id,
    at: row.at,
    category: row.category,
    action: row.action,
    target: row.target,
    detail: row.detail,
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorRole: row.actor_role
  };
}

module.exports = {
  project: project,
  milestone: milestone,
  subtask: subtask,
  person: person,
  auditEntry: auditEntry
};
