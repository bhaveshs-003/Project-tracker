/**
 * Turning rows into the shapes the client expects.
 *
 * This is also where feedback is stripped for partners. Doing it in one place
 * means no route can accidentally leak it — the client never receives the
 * fields rather than being trusted to hide them.
 *
 * ---------------------------------------------------------------
 * Why this file is written set-based
 *
 * The SQLite version queried per row: one query per project for its resources,
 * one per project for its POCs, one per milestone for its sub-tasks, one per
 * sub-task for its comments, one per comment for its attachments. For six
 * projects that was 65 queries for a single GET /api/projects.
 *
 * In-process SQLite answered them in microseconds so it was never felt. Across
 * a network at ~2ms a round-trip the same shape costs ~9 seconds at a hundred
 * projects, and ~54 seconds at four hundred — it grows as P x M x S.
 *
 * So: one query per TABLE for the whole result set, then assembled in JS.
 * Eight queries, regardless of how many projects come back.
 * ---------------------------------------------------------------
 */

var sql = require('./sql');
var scope = require('./scope');

/** Group rows into a Map keyed by one column. */
function groupBy(rows, key) {
  var map = new Map();
  rows.forEach(function (row) {
    var k = row[key];
    var bucket = map.get(k);
    if (bucket) bucket.push(row);
    else map.set(k, [row]);
  });
  return map;
}

var take = function (map, key) { return map.get(key) || []; };

// ---------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------

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

// Dates are `date` columns now and arrive as 'YYYY-MM-DD' or null. The client
// has always been given '' for "not set", so keep that contract rather than
// making every view handle null.
var d = function (value) { return value == null ? '' : value; };

function commentShape(row, files) {
  return {
    id: row.id,
    authorId: row.author_id,
    authorRole: row.author_role,
    decision: row.decision,
    body: row.body,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    attachments: files.map(function (a) {
      return { id: a.id, filename: a.filename, mime: a.mime, bytes: Number(a.bytes) };
    })
  };
}

function subtaskShape(row, comments) {
  return {
    id: row.id,
    title: row.title,
    completed: row.completed,
    outcome: row.outcome,
    delaySide: row.delay_side,
    delayNotes: row.delay_notes,
    completedAt: d(row.completed_at),
    delayStatus: row.delay_status,
    delayDecidedBy: row.delay_decided_by || '',
    delayDecidedAt: d(row.delay_decided_at),
    delayComments: comments
  };
}

function milestoneShape(row, parts, user) {
  var effective = effectiveRange(row);
  var out = {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    companyStart: d(row.company_start),
    companyEnd: d(row.company_end),
    partnerStart: d(row.partner_start),
    partnerEnd: d(row.partner_end),
    approvedStart: d(row.approved_start),
    approvedEnd: d(row.approved_end),
    effectiveStart: d(effective[0]),
    effectiveEnd: d(effective[1]),
    effectiveSource: effective[2],
    completed: row.completed,
    outcome: row.outcome,
    delaySide: row.delay_side,
    delayNotes: row.delay_notes,
    completedAt: d(row.completed_at),
    approval: row.approval,
    submittedAt: d(row.submitted_at),
    approvedBy: row.approved_by || null,
    approvedAt: d(row.approved_at),
    delayStatus: row.delay_status,
    delayDecidedBy: row.delay_decided_by || '',
    delayDecidedAt: d(row.delay_decided_at),
    delayComments: parts.comments,
    subtasks: parts.subtasks
  };

  // Partner feedback is for the company side only. Withheld here rather than
  // hidden by the client, so no route can leak it by forgetting.
  if (scope.isAdmin(user) && row.feedback_rating != null) {
    out.feedback = {
      rating: row.feedback_rating,
      comment: row.feedback_comment,
      mentions: parts.mentions
    };
  } else {
    out.feedback = null;
  }
  return out;
}

function projectShape(row, parts) {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    description: row.description,
    type: row.type,
    status: row.status,
    partnerStart: d(row.partner_start),
    partnerEnd: d(row.partner_end),
    companyStart: d(row.company_start),
    companyEnd: d(row.company_end),
    approvedStart: d(row.approved_start),
    approvedEnd: d(row.approved_end),
    resources: parts.resources,
    pocs: parts.pocs,
    milestones: parts.milestones
  };
}

// ---------------------------------------------------------------
// The loader — eight queries for any number of projects
// ---------------------------------------------------------------

/**
 * Attachments and comments for a set of (item_type, item_id) pairs, grouped
 * ready to hang off their items.
 */
async function loadThreads(milestoneIds) {
  if (!milestoneIds.length) return { milestone: new Map(), subtask: new Map() };

  var comments = await sql.many(
    `SELECT * FROM delay_comments WHERE milestone_id = ANY($1::bigint[])
      ORDER BY created_at, id`, [milestoneIds]);

  var byType = { milestone: new Map(), subtask: new Map() };
  if (!comments.length) return byType;

  var files = groupBy(await sql.many(
    'SELECT * FROM attachments WHERE comment_id = ANY($1::bigint[]) ORDER BY id',
    [comments.map(function (c) { return c.id; })]), 'comment_id');

  comments.forEach(function (c) {
    var map = byType[c.item_type];
    if (!map) return;
    var shaped = commentShape(c, take(files, c.id));
    var bucket = map.get(c.item_id);
    if (bucket) bucket.push(shaped);
    else map.set(c.item_id, [shaped]);
  });
  return byType;
}

/**
 * Hydrate a list of project rows. One query per table, never per row.
 *
 * Callers pass rows they have already decided the user may see — scoping is
 * scope.js's job, not this file's.
 */
async function hydrateProjects(projectRows, user) {
  if (!projectRows.length) return [];

  var projectIds = projectRows.map(function (p) { return p.id; });

  var results = await Promise.all([
    sql.many('SELECT project_id, person_id FROM project_resources WHERE project_id = ANY($1::bigint[])', [projectIds]),
    sql.many('SELECT project_id, person_id FROM project_pocs      WHERE project_id = ANY($1::bigint[])', [projectIds]),
    sql.many('SELECT * FROM milestones WHERE project_id = ANY($1::bigint[]) ORDER BY position, id', [projectIds])
  ]);
  var resources = groupBy(results[0], 'project_id');
  var pocs = groupBy(results[1], 'project_id');
  var milestoneRows = results[2];

  var milestoneIds = milestoneRows.map(function (m) { return m.id; });

  var rest = await Promise.all([
    milestoneIds.length
      ? sql.many('SELECT * FROM subtasks WHERE milestone_id = ANY($1::bigint[]) ORDER BY position, id', [milestoneIds])
      : [],
    milestoneIds.length && scope.isAdmin(user)
      ? sql.many('SELECT milestone_id, person_id FROM milestone_mentions WHERE milestone_id = ANY($1::bigint[])', [milestoneIds])
      : [],
    loadThreads(milestoneIds)
  ]);
  var subtaskRows = rest[0];
  var mentions = groupBy(rest[1], 'milestone_id');
  var threads = rest[2];

  var subtasksByMilestone = groupBy(subtaskRows, 'milestone_id');

  var milestonesByProject = new Map();
  milestoneRows.forEach(function (m) {
    var shaped = milestoneShape(m, {
      subtasks: take(subtasksByMilestone, m.id).map(function (st) {
        return subtaskShape(st, threads.subtask.get(st.id) || []);
      }),
      comments: threads.milestone.get(m.id) || [],
      mentions: take(mentions, m.id).map(function (r) { return r.person_id; })
    }, user);

    var bucket = milestonesByProject.get(m.project_id);
    if (bucket) bucket.push(shaped);
    else milestonesByProject.set(m.project_id, [shaped]);
  });

  return projectRows.map(function (p) {
    return projectShape(p, {
      resources: take(resources, p.id).map(function (r) { return r.person_id; }),
      pocs: take(pocs, p.id).map(function (r) { return r.person_id; }),
      milestones: take(milestonesByProject, p.id)
    });
  });
}

/** One project. Same loader, so the shape cannot drift from the list version. */
async function project(row, user) {
  return (await hydrateProjects([row], user))[0];
}

/**
 * One milestone, for the routes that return a single milestone after a write.
 * Loads only what that milestone needs.
 */
async function milestone(row, user) {
  if (!row) return null;

  var parts = await Promise.all([
    sql.many('SELECT * FROM subtasks WHERE milestone_id = $1 ORDER BY position, id', [row.id]),
    scope.isAdmin(user)
      ? sql.many('SELECT person_id FROM milestone_mentions WHERE milestone_id = $1', [row.id])
      : [],
    loadThreads([row.id])
  ]);

  return milestoneShape(row, {
    subtasks: parts[0].map(function (st) {
      return subtaskShape(st, parts[2].subtask.get(st.id) || []);
    }),
    comments: parts[2].milestone.get(row.id) || [],
    mentions: parts[1].map(function (r) { return r.person_id; })
  }, user);
}

function person(row) {
  return {
    id: row.id,
    name: row.name,
    role: row.job_title,
    email: row.email || '',
    kind: row.kind,
    canSignIn: !!row.user_id
  };
}

function auditEntry(row) {
  return {
    id: row.id,
    at: row.at instanceof Date ? row.at.toISOString() : row.at,
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
  hydrateProjects: hydrateProjects,
  project: project,
  milestone: milestone,
  person: person,
  auditEntry: auditEntry
};
