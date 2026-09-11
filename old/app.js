// ===============================================================
// Directory (seeded — creating new users is not wired up yet)
// ===============================================================
var DIRECTORY_KEY = 'ft.directory';

var SEED_DIRECTORY = {
  company: [
    { id: 'c1', name: 'Alex Morgan',  role: 'Product Manager', email: 'alex@example.com' },
    { id: 'c2', name: 'Priya Nair',   role: 'Tech Lead',       email: 'priya@example.com' },
    { id: 'c3', name: 'Sam Rivera',   role: 'UX Designer',     email: 'sam@example.com' },
    { id: 'c4', name: 'Jamie Lee',    role: 'QA Engineer',     email: 'jamie@example.com' },
    { id: 'c5', name: 'Riya Shah',    role: 'Developer',       email: 'riya@example.com' },
    { id: 'c6', name: 'Arun Kumar',   role: 'Data Engineer',   email: 'arun@example.com' }
  ],
  partners: [
    { id: 'p1', name: 'Daniel Okafor', role: 'Program Director — Northwind',   email: 'daniel@northwind.example' },
    { id: 'p2', name: 'Mei Chen',      role: 'Operations Manager — Northwind', email: 'mei@northwind.example' },
    { id: 'p3', name: 'Lucas Brandt',  role: 'Account Lead — Contoso',         email: 'lucas@contoso.example' },
    { id: 'p4', name: 'Sofia Rossi',   role: 'Delivery Manager — Contoso',     email: 'sofia@contoso.example' }
  ]
};

var directory = loadDirectory();

function loadDirectory() {
  try {
    var saved = localStorage.getItem(DIRECTORY_KEY);
    if (saved) {
      var parsed = JSON.parse(saved);
      return { company: parsed.company || [], partners: parsed.partners || [] };
    }
  } catch (e) { /* storage unavailable — fall back to the seed directory */ }
  return JSON.parse(JSON.stringify(SEED_DIRECTORY));
}

function saveDirectory() {
  try {
    localStorage.setItem(DIRECTORY_KEY, JSON.stringify(directory));
  } catch (e) { /* ignore — the directory still works for this session */ }
}

function everyone() {
  return directory.company.concat(directory.partners);
}

// Next free id in the 'c' (company) or 'p' (partner) series
function nextPersonId(prefix) {
  var list = prefix === 'c' ? directory.company : directory.partners;
  var max = list.reduce(function (top, person) {
    return Math.max(top, parseInt(person.id.slice(1), 10) || 0);
  }, 0);
  return prefix + (max + 1);
}

// ===============================================================
// Roles
//   admin       — the company side: full read/write on every project
//   partner-poc — a partner contact: read-only, and only on the projects
//                 they are named as POC for
// ===============================================================
// Set from GET /api/auth/me once the session is confirmed. Its `id` is the
// same id the directory and project.pocs use, so everything downstream —
// scoping, approval permissions, audit attribution — keeps working.
var currentUser = null;

function isPartner() {
  return !!currentUser && currentUser.role === 'partner';
}

// ---------------------------------------------------------------
// API helper — cookies are same-origin, so nothing to attach by hand
// ---------------------------------------------------------------
function api(method, url, body) {
  var options = { method: method, credentials: 'same-origin' };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }

  return fetch(url, options).then(function (res) {
    return res.json()
      .catch(function () { return {}; })
      .then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || 'Request failed');
          err.status = res.status;
          throw err;
        }
        return data;
      });
  });
}

// ===============================================================
// Audit trail — every mutation in the platform lands here
// ===============================================================
var AUDIT_KEY = 'ft.audit';
var AUDIT_LIMIT = 500;          // newest first; the tail is dropped

var AUDIT_CATEGORIES = ['Project', 'Milestone', 'Sub-task', 'Approval', 'People', 'User'];

var auditLog = loadAudit();

function loadAudit() {
  try {
    var saved = localStorage.getItem(AUDIT_KEY);
    if (saved) return JSON.parse(saved);
  } catch (e) { /* storage unavailable — keep the log in memory only */ }
  return [];
}

function saveAudit() {
  try {
    localStorage.setItem(AUDIT_KEY, JSON.stringify(auditLog));
  } catch (e) { /* ignore — the log still works for this session */ }
}

function logAudit(category, action, target, detail) {
  var actor = personById(currentUser.id);
  auditLog.unshift({
    at: new Date().toISOString(),
    category: category,
    action: action,
    target: target || '',
    detail: detail || '',
    actorId: currentUser.id,
    actorName: actor ? actor.name : currentUser.id,
    actorRole: isPartner() ? 'Partner POC' : 'Admin'
  });
  if (auditLog.length > AUDIT_LIMIT) auditLog.length = AUDIT_LIMIT;
  saveAudit();
}

var PEN_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M11.3 2.2a1.4 1.4 0 0 1 2 2L5.6 11.9l-2.7.8.8-2.7z"/></svg>';

var TRASH_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M2.8 4.3h10.4M6.4 4.3V2.9h3.2v1.4M4.3 4.3l.6 8.8h6.2l.6-8.8M6.6 6.6v4.3M9.4 6.6v4.3"/></svg>';

// Milestone dates for an audit line; blank when no range was set
function dateDetail(start, end) {
  return start || end ? formatDate(start) + ' → ' + formatDate(end) : '';
}

function formatDateTime(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  var hh = String(d.getHours()).padStart(2, '0');
  var mm = String(d.getMinutes()).padStart(2, '0');
  return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ', ' + hh + ':' + mm;
}

// Partners only ever see projects they are the POC on
function visibleProjects() {
  if (!isPartner()) return projects;
  return projects.filter(function (p) {
    return p.pocs.indexOf(currentUser.id) > -1;
  });
}

function canSee(project) {
  return visibleProjects().indexOf(project) > -1;
}

// ===============================================================
// Data
// ===============================================================
var STORAGE_KEY = 'ft.projects.v2';

var seedProjects = [
  {
    id: 1, code: 'PRJ-001', title: 'Apollo', description: 'Partner onboarding portal revamp.',
    type: 'Custom Application',
    partnerStart: '2026-07-01', partnerEnd: '2026-09-12',
    companyStart: '2026-07-08', companyEnd: '2026-09-30',
    approvedStart: '2026-07-06', approvedEnd: '2026-09-25',
    status: 'In-Progress',
    resources: ['c1', 'c2', 'c3'],
    pocs: ['p1'],
    milestones: [
      {
        id: 11, title: 'Discovery & requirements', start: '2026-07-01', end: '2026-07-20',
        subtasks: [
          { id: 111, title: 'Stakeholder interviews' },
          { id: 112, title: 'Requirements sign-off' }
        ]
      },
      {
        id: 12, title: 'Build & integration', start: '2026-07-21', end: '2026-09-05',
        subtasks: [
          { id: 121, title: 'API integration' },
          { id: 122, title: 'UI implementation' }
        ]
      }
    ]
  },
  {
    id: 2, code: 'PRJ-002', title: 'Beacon', description: 'Real-time alerting for the ops team.',
    type: 'Integration',
    partnerStart: '2026-06-15', partnerEnd: '2026-09-30',
    companyStart: '2026-06-20', companyEnd: '2026-10-10',
    approvedStart: '2026-06-18', approvedEnd: '2026-10-02',
    status: 'In-Progress',
    resources: ['c2', 'c5'],
    pocs: ['p2'],
    milestones: [
      { id: 21, title: 'Alerting engine', start: '2026-06-20', end: '2026-08-30', subtasks: [] }
    ]
  },
  {
    id: 3, code: 'PRJ-003', title: 'Cobalt', description: 'Data warehouse migration.',
    type: 'Migration',
    partnerStart: '2026-08-01', partnerEnd: '2026-10-05',
    companyStart: '2026-08-05', companyEnd: '2026-10-20',
    approvedStart: '', approvedEnd: '',
    status: 'Not Started',
    resources: ['c6'], pocs: ['p3'], milestones: []
  },
  {
    id: 4, code: 'PRJ-004', title: 'Delta', description: 'Mobile app accessibility audit.',
    type: 'Custom Application',
    partnerStart: '2026-05-02', partnerEnd: '2026-08-18',
    companyStart: '2026-05-10', companyEnd: '2026-08-25',
    approvedStart: '2026-05-11', approvedEnd: '2026-08-21',
    status: 'Completed',
    resources: ['c3', 'c4'], pocs: ['p4'], milestones: []
  }
];

// The status list was reduced to three values; map the retired ones across.
// Declared before load() runs, since load() calls migrateStatus().
var RETIRED_STATUS = { 'Active': 'In-Progress', 'In Review': 'In-Progress', 'On Hold': 'Not Started' };

var projects = load();
var nextId = 1;

function load() {
  var data = seedProjects;
  try {
    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved) data = JSON.parse(saved);
  } catch (e) { /* storage unavailable — fall back to the seed data */ }

  // Fill in anything an older saved record is missing.
  return data.map(function (p) {
    p.type          = p.type || '';
    p.approvedStart = p.approvedStart || '';
    p.approvedEnd   = p.approvedEnd || '';
    p.status        = migrateStatus(p.status);
    p.resources  = p.resources  || [];
    p.pocs       = p.pocs       || [];
    p.milestones = (p.milestones || []).map(function (m) {
      m.subtasks = (m.subtasks || []).map(normalizeCompletion);
      return normalizeApproval(normalizeCompletion(m));
    });
    return p;
  });
}

function migrateStatus(status) {
  return RETIRED_STATUS[status] || status || 'Not Started';
}

function normalizeCompletion(item) {
  item.completed   = item.completed || false;
  item.outcome     = item.outcome || '';      // 'On-Time' | 'Delayed'
  item.delaySide   = item.delaySide || '';    // 'Company Side' | 'Partner Side'
  item.delayNotes  = item.delayNotes || '';
  item.completedAt = item.completedAt || '';  // stamped when marked complete
  return item;
}

// Milestones carry an approval trip: none -> pending -> approved
function normalizeApproval(m) {
  m.approval    = m.approval || 'none';
  m.submittedAt = m.submittedAt || '';
  m.approvedBy  = m.approvedBy || '';
  m.approvedAt  = m.approvedAt || '';
  m.feedback    = m.feedback || null;   // { rating, comment, mentions: [ids] }
  return m;
}

var RATING_WORDS = { 1: 'Poor', 2: 'Fair', 3: 'Good', 4: 'Very Good', 5: 'Excellent' };

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
  } catch (e) { /* ignore — the data still works for this session */ }
}

// Ids are unique across projects, milestones and sub-tasks.
function refreshNextId() {
  var max = 0;
  projects.forEach(function (p) {
    max = Math.max(max, p.id);
    p.milestones.forEach(function (m) {
      max = Math.max(max, m.id);
      m.subtasks.forEach(function (s) { max = Math.max(max, s.id); });
    });
  });
  nextId = max + 1;
}
refreshNextId();

// ===============================================================
// Helpers
// ===============================================================
var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function formatDate(value) {
  if (!value) return '—';
  var parts = value.split('-');
  return parts[2] + ' ' + MONTHS[parseInt(parts[1], 10) - 1] + ' ' + parts[0];
}

function formatRange(start, end) {
  if (!start && !end) return '<span class="muted-sm">Not set</span>';
  return formatDate(start) + ' → ' + formatDate(end);
}

// Inclusive of both end dates: 1 Jan → 3 Jan is 3 days.
function dayCount(start, end) {
  if (!start || !end) return null;
  var ms = Date.parse(end + 'T00:00:00') - Date.parse(start + 'T00:00:00');
  if (isNaN(ms) || ms < 0) return null;
  return Math.round(ms / 86400000) + 1;
}

function dayLabel(start, end) {
  var days = dayCount(start, end);
  return days === null ? '' : days + (days === 1 ? ' day' : ' days');
}

// A range plus its duration, for the table cell and the detail boxes
function formatRangeWithDays(start, end) {
  var label = dayLabel(start, end);
  return formatRange(start, end) +
    (label ? '<span class="day-count">' + label + '</span>' : '');
}

function escapeHtml(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function initials(name) {
  return name.split(' ').map(function (w) { return w.charAt(0); }).join('').slice(0, 2);
}

var statusClass = {
  'Not Started': 'todo',
  'In-Progress': 'active',
  'Completed': 'done'
};

// Project status only ever moves forward through this sequence.
var STATUS_FLOW = ['Not Started', 'In-Progress', 'Completed'];

function statusRank(status) {
  return STATUS_FLOW.indexOf(status);
}

function isForwardMove(from, to) {
  return statusRank(to) >= statusRank(from);
}

// Disable every status a project can no longer move to: anything backwards,
// plus "Completed" while milestones are still open.
function applyStatusRules(select, p) {
  Array.prototype.slice.call(select.options).forEach(function (option) {
    option.disabled =
      statusRank(option.value) < statusRank(p.status) ||
      (option.value === 'Completed' && !allMilestonesComplete(p));
  });
}

// A milestone is only finished once it is completed AND the partner has
// approved it. A project can only be closed once every milestone is finished;
// a project with no milestones is not blocked.
function milestoneFinished(m) {
  return m.completed && m.approval === 'approved';
}

function allMilestonesComplete(p) {
  return p.milestones.every(milestoneFinished);
}

function openMilestoneCount(p) {
  return p.milestones.filter(function (m) { return !m.completed; }).length;
}

function awaitingApprovalCount(p) {
  return p.milestones.filter(function (m) {
    return m.completed && m.approval !== 'approved';
  }).length;
}

// "1 milestone still open and 2 awaiting partner approval"
function blockingSummary(p) {
  var parts = [];
  var open = openMilestoneCount(p);
  var waiting = awaitingApprovalCount(p);
  if (open)    parts.push(plural(open, 'milestone') + ' still open');
  if (waiting) parts.push(plural(waiting, 'milestone') + ' awaiting partner approval');
  return parts.join(' and ');
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

// Everything the project dashboard needs, counted in one pass.
// Milestones and sub-tasks both count as "items" toward overall progress.
function projectMetrics(p) {
  var m = {
    milestonesDone: 0, milestonesTotal: p.milestones.length,
    subtasksDone: 0,   subtasksTotal: 0,
    itemsDone: 0,      itemsTotal: 0,  percent: 0,
    onTime: 0,         delayed: 0,
    companySide: 0,    partnerSide: 0,
    delayNotes: [],
    // Milestones only — the sub-task counts above mix both kinds together
    milestonesOnTime: 0, milestonesDelayed: 0,
    // { title, days } for milestones that have both a start date and a
    // completion stamp; anything older simply cannot be measured
    cycleTimes: [],
    completions: []   // { completedAt, outcome } for the weekly trend
  };

  function tally(item, title) {
    if (!item.completed) return;
    if (item.outcome === 'Delayed') {
      m.delayed++;
      if (item.delaySide === 'Company Side') m.companySide++;
      if (item.delaySide === 'Partner Side') m.partnerSide++;
      if (item.delayNotes) {
        m.delayNotes.push({ title: title, side: item.delaySide, note: item.delayNotes });
      }
    } else {
      m.onTime++;
    }
    if (item.completedAt) {
      m.completions.push({ completedAt: item.completedAt, outcome: item.outcome });
    }
  }

  p.milestones.forEach(function (ms) {
    if (ms.completed) {
      m.milestonesDone++;
      if (ms.outcome === 'Delayed') m.milestonesDelayed++; else m.milestonesOnTime++;

      var days = dayCount(ms.start, ms.completedAt);
      if (days !== null) m.cycleTimes.push({ title: ms.title, days: days });
    }
    tally(ms, ms.title);

    m.subtasksTotal += ms.subtasks.length;
    ms.subtasks.forEach(function (st) {
      if (st.completed) m.subtasksDone++;
      tally(st, ms.title + ' › ' + st.title);
    });
  });

  m.itemsTotal = m.milestonesTotal + m.subtasksTotal;
  m.itemsDone  = m.milestonesDone + m.subtasksDone;
  m.percent    = m.itemsTotal ? Math.round((m.itemsDone / m.itemsTotal) * 100) : 0;
  return m;
}

function sharePercent(part, whole) {
  return whole ? (part / whole) * 100 : 0;
}

// The same counters as projectMetrics, folded over every project the
// signed-in user can see, plus each project's own metrics for the lists.
function portfolioMetrics() {
  var totals = {
    onTime: 0, delayed: 0, companySide: 0, partnerSide: 0,
    itemsDone: 0, itemsTotal: 0,
    perProject: [],
    delayedProjects: [],   // at least one delayed milestone or sub-task
    byType: {},            // project type -> { onTime, delayed, projects }
    completions: []        // every stamped completion, for the weekly trend
  };

  visibleProjects().forEach(function (p) {
    var m = projectMetrics(p);
    totals.onTime      += m.onTime;
    totals.delayed     += m.delayed;
    totals.companySide += m.companySide;
    totals.partnerSide += m.partnerSide;
    totals.itemsDone   += m.itemsDone;
    totals.itemsTotal  += m.itemsTotal;
    totals.perProject.push({ project: p, metrics: m });
    totals.completions = totals.completions.concat(m.completions);

    if (m.delayed > 0) totals.delayedProjects.push({ project: p, metrics: m });

    var type = p.type || 'Not set';
    if (!totals.byType[type]) totals.byType[type] = { onTime: 0, delayed: 0, projects: 0 };
    totals.byType[type].onTime  += m.onTime;
    totals.byType[type].delayed += m.delayed;
    totals.byType[type].projects++;
  });

  totals.delayedProjects.sort(function (a, b) { return b.metrics.delayed - a.metrics.delayed; });
  return totals;
}

// ---------------------------------------------------------------
// Weekly buckets for the throughput / delay trend.
// Only items carrying a completedAt stamp can appear — that field was added
// part way through the project's life, so older completions are invisible
// here and are reported separately rather than silently counted as zero.
// ---------------------------------------------------------------
var TREND_WEEKS = 8;

function mondayOf(date) {
  var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  var offset = (d.getDay() + 6) % 7;          // Monday = 0
  d.setDate(d.getDate() - offset);
  return d;
}

function isoDate(date) {
  var month = String(date.getMonth() + 1).padStart(2, '0');
  var day   = String(date.getDate()).padStart(2, '0');
  return date.getFullYear() + '-' + month + '-' + day;
}

function weeklyBuckets(completions) {
  var thisMonday = mondayOf(new Date());
  var buckets = [];
  var index = {};

  for (var i = TREND_WEEKS - 1; i >= 0; i--) {
    var start = new Date(thisMonday);
    start.setDate(start.getDate() - i * 7);
    var bucket = { weekStart: isoDate(start), onTime: 0, delayed: 0, total: 0 };
    buckets.push(bucket);
    index[bucket.weekStart] = bucket;
  }

  var outsideWindow = 0;

  completions.forEach(function (entry) {
    var parts = entry.completedAt.split('-');
    var when = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    var key = isoDate(mondayOf(when));
    var bucket = index[key];

    if (!bucket) { outsideWindow++; return; }
    if (entry.outcome === 'Delayed') bucket.delayed++; else bucket.onTime++;
    bucket.total++;
  });

  return {
    weeks: buckets,
    counted: buckets.reduce(function (sum, b) { return sum + b.total; }, 0),
    outsideWindow: outsideWindow
  };
}

function projectById(id) {
  return projects.filter(function (p) { return p.id === id; })[0] || null;
}

function personById(id) {
  return everyone().filter(function (person) { return person.id === id; })[0] || null;
}

// ===============================================================
// App
// ===============================================================
document.addEventListener('DOMContentLoaded', function () {

  var listView   = document.getElementById('list-view');
  var detailView = document.getElementById('detail-view');
  var rows       = document.getElementById('project-rows');
  var emptyMsg   = document.getElementById('empty-msg');
  var search     = document.getElementById('search');

  var formModal     = document.getElementById('form-modal');
  var itemModal     = document.getElementById('item-modal');
  var assignModal   = document.getElementById('assign-modal');
  var completeModal = document.getElementById('complete-modal');
  var confirmModal  = document.getElementById('confirm-modal');
  var approvalOverlay = document.getElementById('approval-modal');
  var personOverlay = document.getElementById('person-modal');
  var deleteOverlay = document.getElementById('delete-modal');
  var allModals     = [formModal, itemModal, assignModal, completeModal,
                       approvalOverlay, personOverlay, deleteOverlay];

  var currentProjectId = null;   // project open in the detail view
  var itemContext      = null;   // { kind, milestoneId, itemId } for the milestone/sub-task modal
  var assignKind       = null;   // 'resources' | 'pocs'

  // ---------------------------------------------------------------
  // Who is signed in
  // ---------------------------------------------------------------
  function roleLabel() {
    return isPartner() ? 'Partner POC' : 'Admin';
  }

  // The signed-in account is the source of truth; the directory entry is only
  // used for the richer details (job title) when one exists.
  function currentPerson() {
    return personById(currentUser.id) ||
      { id: currentUser.id, name: currentUser.name, role: roleLabel(), email: currentUser.email };
  }

  // Show or hide everything that only the company side may touch
  function applyRole() {
    var partner = isPartner();
    var person  = currentPerson();

    document.getElementById('topbar-name').textContent = person.name;
    document.getElementById('role-chip').textContent = roleLabel();
    document.getElementById('role-chip').className = 'role-chip' + (partner ? ' partner' : '');
    document.getElementById('topbar-avatar').textContent = initials(person.name);

    document.getElementById('new-project').classList.toggle('hidden', partner);
    document.getElementById('d-edit').classList.toggle('hidden', partner);
    document.getElementById('add-milestone').classList.toggle('hidden', partner);
    document.getElementById('assign-resources').classList.toggle('hidden', partner);
    document.getElementById('assign-pocs').classList.toggle('hidden', partner);
    document.getElementById('d-status-select').disabled = partner;
    document.getElementById('view-only-banner').classList.toggle('hidden', !partner);

    // The audit trail covers the whole platform, so it stays on the company side
    document.getElementById('audit-tab').classList.toggle('hidden', partner);
    if (partner && document.getElementById('audit').classList.contains('active')) {
      document.querySelector('.tab[data-tab="dashboard"]').click();
    }
  }

  function renderProfile() {
    var person = currentPerson();
    document.getElementById('p-avatar').textContent = initials(person.name);
    document.getElementById('p-name').textContent   = person.name;
    document.getElementById('p-email').textContent  = person.email || currentUser.email;
    document.getElementById('pf-name').value        = person.name;
    document.getElementById('pf-role').value        = person.role;

    var chip = document.getElementById('p-role-chip');
    chip.textContent = roleLabel();
    chip.className = 'role-chip' + (isPartner() ? ' partner' : '');

    document.getElementById('pf-access').value = isPartner()
      ? 'Read-only — projects where you are the Partner POC'
      : 'Full access — all projects';
  }

  // ---------------------------------------------------------------
  // User management (admin only)
  // ---------------------------------------------------------------
  var personModal = document.getElementById('person-modal');
  var personForm  = document.getElementById('person-form');
  var personError = document.getElementById('person-error');
  var personKind  = 'company';   // 'company' | 'partner'

  function renderDirectory() {
    document.getElementById('user-management').classList.toggle('hidden', isPartner());
    if (isPartner()) return;

    var resourceRows = document.getElementById('resource-rows');
    resourceRows.innerHTML = '';
    directory.company.forEach(function (person) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td><b>' + escapeHtml(person.name) + '</b></td>' +
        '<td>' + escapeHtml(person.role) + '</td>' +
        '<td class="right nowrap">' +
          '<button class="icon-btn" data-person-edit="' + person.id + '">Edit</button>' +
          '<button class="icon-btn danger" data-person-delete="' + person.id + '">Delete</button>' +
        '</td>';
      resourceRows.appendChild(tr);
    });

    var pocRows = document.getElementById('poc-rows');
    pocRows.innerHTML = '';
    directory.partners.forEach(function (person) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td><b>' + escapeHtml(person.name) + '</b></td>' +
        '<td>' + escapeHtml(person.role) + '</td>' +
        '<td>' + escapeHtml(person.email || '') + '</td>' +
        '<td class="muted-sm">Set on server</td>' +
        '<td class="right nowrap">' +
          '<button class="icon-btn" data-person-edit="' + person.id + '">Edit</button>' +
          '<button class="icon-btn danger" data-person-delete="' + person.id + '">Delete</button>' +
        '</td>';
      pocRows.appendChild(tr);
    });
  }

  function openPersonForm(kind, person) {
    if (isPartner()) return;
    personKind = kind;
    personForm.reset();
    personError.classList.add('hidden');

    var noun = kind === 'company' ? 'Resource' : 'Partner POC';
    document.getElementById('person-title').textContent = (person ? 'Edit ' : 'Add ') + noun;
    document.getElementById('person-id').value = person ? person.id : '';
    document.getElementById('credential-fields').classList.toggle('hidden', kind !== 'partner');

    if (person) {
      document.getElementById('u-name').value  = person.name;
      document.getElementById('u-role').value  = person.role;
      document.getElementById('u-email').value = person.email || '';
    }

    document.getElementById('password-hint').textContent = person
      ? 'Leave blank to keep the current password.'
      : 'At least 6 characters.';

    openModal(personModal);
    document.getElementById('u-name').focus();
  }

  document.getElementById('add-resource').addEventListener('click', function () {
    openPersonForm('company', null);
  });
  document.getElementById('add-poc').addEventListener('click', function () {
    openPersonForm('partner', null);
  });

  document.getElementById('user-management').addEventListener('click', function (e) {
    if (isPartner()) return;

    var editBtn = e.target.closest('[data-person-edit]');
    if (editBtn) {
      var toEdit = personById(editBtn.dataset.personEdit);
      if (toEdit) openPersonForm(toEdit.id.charAt(0) === 'c' ? 'company' : 'partner', toEdit);
      return;
    }

    var delBtn = e.target.closest('[data-person-delete]');
    if (delBtn) removePerson(delBtn.dataset.personDelete);
  });

  personForm.addEventListener('submit', function (e) {
    e.preventDefault();
    personError.classList.add('hidden');

    var id       = document.getElementById('person-id').value;
    var name     = document.getElementById('u-name').value.trim();
    var role     = document.getElementById('u-role').value.trim();
    var email    = document.getElementById('u-email').value.trim();
    var password = document.getElementById('u-password').value;
    var existing = id ? personById(id) : null;

    if (!name) return showError(personError, 'Name is required.');
    if (!role) return showError(personError, 'Job title is required.');

    if (personKind === 'partner') {
      if (!email) return showError(personError, 'Email is required for a Partner POC.');
      if (!/^\S+@\S+\.\S+$/.test(email)) return showError(personError, 'Enter a valid email address.');

      var taken = directory.partners.some(function (person) {
        return person.email.toLowerCase() === email.toLowerCase() && person.id !== id;
      });
      if (taken) return showError(personError, 'Another Partner POC already uses ' + email + '.');

      if (!existing && password.length < 6) {
        return showError(personError, 'Set a password of at least 6 characters.');
      }
      if (existing && password && password.length < 6) {
        return showError(personError, 'The new password must be at least 6 characters.');
      }
    }

    var kindLabel = personKind === 'company' ? 'Company resource' : 'Partner POC';

    // Partner POCs sign in, so their account lives on the server. Passwords are
    // never written to the directory — only name, job title and email are.
    var accountCall = Promise.resolve();
    var newId = null;

    if (existing) {
      if (personKind === 'partner') {
        accountCall = api('PATCH', '/api/accounts/' + existing.id, {
          name: name, email: email, password: password || undefined
        });
      }
    } else if (personKind === 'partner') {
      newId = nextPersonId('p');
      accountCall = api('POST', '/api/accounts', {
        id: newId, name: name, email: email, password: password, role: 'partner'
      });
    }

    accountCall.then(function () {
      if (existing) {
        existing.name = name;
        existing.role = role;
        if (personKind === 'partner') existing.email = email;
        logAudit('User', 'Updated', name,
          kindLabel + ' · ' + role + (password ? ' · password changed' : ''));
      } else if (personKind === 'company') {
        directory.company.push({ id: nextPersonId('c'), name: name, role: role, email: '' });
        logAudit('User', 'Created', name, kindLabel + ' · ' + role);
      } else {
        directory.partners.push({ id: newId, name: name, role: role, email: email });
        logAudit('User', 'Created', name, kindLabel + ' · ' + role + ' · ' + email);
      }

      saveDirectory();
      closeAll();
      refreshPeople();
    }).catch(function (err) {
      showError(personError, err.message || 'Could not save this account.');
    });
  });

  function removePerson(personId) {
    var person = personById(personId);
    if (!person) return;

    if (personId === currentUser.id) {
      return alert('You cannot delete the account you are signed in with.');
    }

    // Count where they are still assigned, so the warning is honest
    var assigned = projects.filter(function (p) {
      return p.resources.indexOf(personId) > -1 || p.pocs.indexOf(personId) > -1;
    }).length;

    openConfirm({
      title: 'Delete ' + person.name + '?',
      message: person.name + ' (' + person.role + ') will be removed from the directory.',
      warning: assigned
        ? 'They are currently assigned to ' + plural(assigned, 'project') +
          ' and will be unassigned from ' + (assigned === 1 ? 'it' : 'them') + '. This cannot be undone.'
        : 'This cannot be undone.',
      confirmLabel: 'Delete user',
      onConfirm: function () {
        var isPartnerAccount = personId.charAt(0) === 'p';

        // Remove the login first; a 404 just means there was never an account
        var accountCall = isPartnerAccount
          ? api('DELETE', '/api/accounts/' + personId).catch(function (err) {
              if (err.status !== 404) throw err;
            })
          : Promise.resolve();

        accountCall.then(function () {
          directory.company  = directory.company.filter(function (x) { return x.id !== personId; });
          directory.partners = directory.partners.filter(function (x) { return x.id !== personId; });

          projects.forEach(function (p) {
            p.resources = p.resources.filter(function (x) { return x !== personId; });
            p.pocs      = p.pocs.filter(function (x) { return x !== personId; });
          });

          saveDirectory();
          save();
          logAudit('User', 'Deleted', person.name,
            person.role + (assigned ? ' · unassigned from ' + plural(assigned, 'project') : ''));
          refreshPeople();
          renderAudit();
        }).catch(function (err) {
          alert('Could not delete this account: ' + (err.message || 'unknown error'));
        });
      }
    });
  }

  // The directory feeds the profile card and every project view
  function refreshPeople() {
    applyRole();
    renderProfile();
    renderDirectory();
    rerender();
  }

  // ---------------------------------------------------------------
  // Audit trail
  // ---------------------------------------------------------------
  var auditSearch   = document.getElementById('audit-search');
  var auditCategory = document.getElementById('audit-category');
  var auditSort     = document.getElementById('audit-sort');

  AUDIT_CATEGORIES.forEach(function (name) {
    var opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    auditCategory.appendChild(opt);
  });

  function renderAudit() {
    var term = auditSearch.value.trim().toLowerCase();
    var category = auditCategory.value;

    var rows = auditLog.filter(function (entry) {
      if (category && entry.category !== category) return false;
      if (!term) return true;
      return [entry.action, entry.target, entry.detail, entry.actorName, entry.category]
        .join(' ').toLowerCase().indexOf(term) > -1;
    });

    // The log is stored newest-first, so "newest" needs no sorting
    if (auditSort.value === 'oldest') {
      rows = rows.slice().reverse();
    } else if (auditSort.value === 'category') {
      rows = rows.slice().sort(function (a, b) {
        return a.category.localeCompare(b.category) || b.at.localeCompare(a.at);
      });
    } else if (auditSort.value === 'actor') {
      rows = rows.slice().sort(function (a, b) {
        return a.actorName.localeCompare(b.actorName) || b.at.localeCompare(a.at);
      });
    }

    document.getElementById('audit-count').textContent =
      rows.length === auditLog.length
        ? plural(auditLog.length, 'entry').replace('entrys', 'entries')
        : rows.length + ' of ' + auditLog.length + ' entries';

    var body = document.getElementById('audit-rows');
    body.innerHTML = '';
    rows.forEach(function (entry) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="dates">' + escapeHtml(formatDateTime(entry.at)) + '</td>' +
        '<td><span class="badge cat-' + entry.category.toLowerCase().replace(/[^a-z]/g, '') + '">' +
          escapeHtml(entry.category) + '</span></td>' +
        '<td><b>' + escapeHtml(entry.action) + '</b></td>' +
        '<td>' + escapeHtml(entry.target) + '</td>' +
        '<td class="audit-detail">' + (entry.detail ? escapeHtml(entry.detail) : '<span class="muted-sm">—</span>') + '</td>' +
        '<td class="nowrap">' + escapeHtml(entry.actorName) +
          '<span class="row-sub">' + escapeHtml(entry.actorRole) + '</span></td>';
      body.appendChild(tr);
    });

    var empty = document.getElementById('audit-empty');
    empty.textContent = auditLog.length
      ? 'No entries match this search.'
      : 'No audit entries yet.';
    empty.classList.toggle('hidden', rows.length > 0);
  }

  [auditSearch, auditCategory, auditSort].forEach(function (control) {
    control.addEventListener('input', renderAudit);
    control.addEventListener('change', renderAudit);
  });

  // ---------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------
  document.querySelectorAll('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
      document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
      tab.classList.add('active');
      document.getElementById(tab.dataset.tab).classList.add('active');
      if (tab.dataset.tab === 'projects') showList();
      if (tab.dataset.tab === 'audit') renderAudit();
    });
  });

  // ---------------------------------------------------------------
  // Modal plumbing
  // ---------------------------------------------------------------
  function openModal(el)  { el.classList.remove('hidden'); }
  function closeModal(el) { el.classList.add('hidden'); }
  function closeAll()     { allModals.forEach(closeModal); }

  document.querySelectorAll('[data-close]').forEach(function (btn) {
    btn.addEventListener('click', closeAll);
  });

  allModals.forEach(function (overlay) {
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeAll();
    });
  });

  // The confirmation modal sits on top of the others and closes on its own,
  // so cancelling it never discards whatever is open underneath.
  var confirmAction = null;

  var confirmInput = document.getElementById('confirm-input');
  var confirmOk    = document.getElementById('confirm-ok');
  var requiredText = '';

  function closeConfirm() {
    confirmModal.classList.add('hidden');
    confirmAction = null;
    requiredText = '';
    confirmInput.value = '';
  }

  function openConfirm(opts) {
    document.getElementById('confirm-title').textContent   = opts.title;
    document.getElementById('confirm-message').textContent = opts.message;
    document.getElementById('confirm-warning').textContent = opts.warning || '';
    document.getElementById('confirm-warning').classList.toggle('hidden', !opts.warning);
    confirmOk.textContent = opts.confirmLabel || 'Confirm';
    confirmAction = opts.onConfirm;

    // An irreversible step can ask the user to type something out first
    requiredText = opts.requireText || '';
    confirmInput.value = '';
    document.getElementById('confirm-typebox').classList.toggle('hidden', !requiredText);
    confirmOk.disabled = !!requiredText;
    if (requiredText) {
      document.getElementById('confirm-input-label').textContent =
        'Type ' + requiredText + ' below to enable the button';
      confirmInput.placeholder = requiredText;
    }

    openModal(confirmModal);
    if (requiredText) confirmInput.focus(); else confirmOk.focus();
  }

  function typedTextMatches() {
    return confirmInput.value.trim().toLowerCase() === requiredText.toLowerCase();
  }

  confirmInput.addEventListener('input', function () {
    confirmOk.disabled = !typedTextMatches();
  });

  // Enter in the box is the same as clicking the (now enabled) button
  confirmInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (typedTextMatches()) confirmOk.click();
    }
  });

  document.querySelectorAll('[data-confirm-close]').forEach(function (btn) {
    btn.addEventListener('click', closeConfirm);
  });

  confirmModal.addEventListener('click', function (e) {
    if (e.target === confirmModal) closeConfirm();
  });

  confirmOk.addEventListener('click', function () {
    if (requiredText && !typedTextMatches()) return;
    var run = confirmAction;
    closeConfirm();
    if (run) run();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!confirmModal.classList.contains('hidden')) return closeConfirm();
    closeAll();
  });

  // ===============================================================
  // LIST VIEW
  // ===============================================================
  function showList() {
    currentProjectId = null;
    detailView.classList.add('hidden');
    listView.classList.remove('hidden');
    renderList();
  }

  function renderList() {
    var term = search.value.trim().toLowerCase();
    var list = visibleProjects().filter(function (p) {
      return p.code.toLowerCase().indexOf(term) > -1 ||
             p.title.toLowerCase().indexOf(term) > -1;
    });
    var partner = isPartner();

    rows.innerHTML = '';
    list.forEach(function (p) {
      var tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.dataset.open = p.id;
      tr.innerHTML =
        '<td><b>' + escapeHtml(p.code) + '</b></td>' +
        '<td>' + escapeHtml(p.title) +
          '<span class="row-sub">' + p.milestones.length + ' milestone' +
          (p.milestones.length === 1 ? '' : 's') + '</span></td>' +
        '<td>' + (p.type ? escapeHtml(p.type) : '<span class="muted-sm">Not set</span>') + '</td>' +
        '<td class="dates">' + formatRange(p.partnerStart, p.partnerEnd) + '</td>' +
        '<td class="dates">' + formatRange(p.companyStart, p.companyEnd) + '</td>' +
        '<td class="dates approved-cell">' + formatRangeWithDays(p.approvedStart, p.approvedEnd) + '</td>' +
        '<td><span class="badge ' + (statusClass[p.status] || 'todo') + '">' + escapeHtml(p.status) + '</span></td>' +
        // Row click opens the project; delete sits last, at the end of the scroll
        '<td class="right nowrap actions-cell">' +
          (partner ? '<span class="muted-sm">View only</span>' :
            '<button class="glyph-btn" data-action="edit" data-id="' + p.id +
              '" title="Edit project" aria-label="Edit project">' + PEN_ICON + '</button>' +
            '<button class="glyph-btn danger" data-action="delete" data-id="' + p.id +
              '" title="Delete project" aria-label="Delete project">' + TRASH_ICON + '</button>') +
        '</td>';
      rows.appendChild(tr);
    });

    emptyMsg.textContent = partner && !visibleProjects().length
      ? 'You are not assigned as Partner POC on any project yet.'
      : 'No projects found.';
    emptyMsg.classList.toggle('hidden', list.length > 0);
    renderStats();
  }

  function renderStats() {
    var scoped = visibleProjects();
    function count(status) {
      return scoped.filter(function (p) { return p.status === status; }).length;
    }
    document.getElementById('stat-total').textContent  = scoped.length;
    document.getElementById('stat-active').textContent = count('In-Progress');
    document.getElementById('stat-review').textContent = count('Not Started');
    document.getElementById('stat-done').textContent   = count('Completed');

    renderPortfolio();
  }

  // ---------------------------------------------------------------
  // Portfolio roll-up on the landing dashboard — company side only
  // ---------------------------------------------------------------
  function renderPortfolio() {
    var section = document.getElementById('portfolio');

    // Partners keep the four scoped status tiles and nothing more
    section.classList.toggle('hidden', isPartner());
    if (isPartner()) return;

    var totals = portfolioMetrics();
    var completed = totals.onTime + totals.delayed;

    document.getElementById('pf-empty-quality').classList.toggle('hidden', completed > 0);
    document.getElementById('pf-quality').classList.toggle('hidden', completed === 0);

    if (completed) {
      document.getElementById('pf-outcome').innerHTML =
        '<div class="stack">' +
          barSegment(totals.onTime, completed, 'ontime') +
          barSegment(totals.delayed, completed, 'delayed') +
        '</div>' +
        '<ul class="legend">' +
          legendItem('ontime', 'On-Time', totals.onTime, completed) +
          legendItem('delayed', 'Delayed', totals.delayed, completed) +
        '</ul>';

      renderPortfolioDelays(totals);
    }

    renderQualityByType(totals);
    renderTrend(totals);
    renderDelayedProjects(totals);
    renderPortfolioProgress(totals);
  }

  // One stacked bar per project type — does one kind of work slip more?
  function renderQualityByType(totals) {
    var wrap = document.getElementById('pf-by-type');
    var types = Object.keys(totals.byType).sort();

    if (!types.length) {
      wrap.innerHTML = '<p class="muted-sm">No projects yet.</p>';
      return;
    }

    wrap.innerHTML = types.map(function (type) {
      var row = totals.byType[type];
      var done = row.onTime + row.delayed;

      var bar = done
        ? '<div class="stack type-stack">' +
            barSegment(row.onTime, done, 'ontime') +
            barSegment(row.delayed, done, 'delayed') +
          '</div>'
        : '<p class="muted-sm type-empty">Nothing completed yet</p>';

      return '<div class="type-row">' +
        '<div class="type-head">' +
          '<b>' + escapeHtml(type) + '</b>' +
          '<span class="muted-sm">' + plural(row.projects, 'project') +
            (done ? ' · ' + plural(done, 'completed item') : '') + '</span>' +
        '</div>' + bar +
      '</div>';
    }).join('') +
    '<ul class="legend">' +
      '<li><span class="swatch ontime"></span>On-Time</li>' +
      '<li><span class="swatch delayed"></span>Delayed</li>' +
    '</ul>';
  }

  // Columns are throughput; the split inside each column is the delay trend
  function renderTrend(totals) {
    var wrap = document.getElementById('pf-trend');
    var data = weeklyBuckets(totals.completions);

    if (!data.counted) {
      wrap.innerHTML = '<p class="muted-sm">No completions recorded in the last ' +
        TREND_WEEKS + ' weeks yet. Completion dates are only stamped from the moment an ' +
        'item is marked complete in the app, so earlier work does not appear here.</p>';
      return;
    }

    var tallest = data.weeks.reduce(function (top, w) { return Math.max(top, w.total); }, 0);

    wrap.innerHTML =
      '<div class="columns">' +
        data.weeks.map(function (week) {
          var height = sharePercent(week.total, tallest);
          var label = formatDate(week.weekStart).slice(0, 6);   // "06 Jul"
          return '<div class="column">' +
            '<span class="column-value">' + (week.total || '') + '</span>' +
            '<div class="column-track">' +
              (week.total
                ? '<div class="column-stack" style="height:' + height + '%">' +
                    (week.delayed ? '<div class="col-seg delayed" style="height:' +
                      sharePercent(week.delayed, week.total) + '%"></div>' : '') +
                    (week.onTime ? '<div class="col-seg ontime" style="height:' +
                      sharePercent(week.onTime, week.total) + '%"></div>' : '') +
                  '</div>'
                : '') +
            '</div>' +
            '<span class="column-label">' + escapeHtml(label) + '</span>' +
          '</div>';
        }).join('') +
      '</div>' +
      '<ul class="legend">' +
        '<li><span class="swatch ontime"></span>On-Time</li>' +
        '<li><span class="swatch delayed"></span>Delayed</li>' +
      '</ul>' +
      '<p class="muted-sm">' + plural(data.counted, 'completion') + ' in the last ' +
        TREND_WEEKS + ' weeks' +
        (data.outsideWindow ? ' · ' + data.outsideWindow + ' older than that' : '') + '</p>';
  }

  // Projects carrying at least one delayed milestone or sub-task
  function renderDelayedProjects(totals) {
    var list = totals.delayedProjects;
    document.getElementById('pf-delayed-count').textContent = list.length;

    var wrap = document.getElementById('pf-delayed-list');
    if (!list.length) {
      wrap.innerHTML = '<p class="muted-sm">No project is carrying a delay.</p>';
      return;
    }

    wrap.innerHTML = list.map(function (row) {
      var m = row.metrics;
      var sides = [];
      if (m.companySide) sides.push(m.companySide + ' company');
      if (m.partnerSide) sides.push(m.partnerSide + ' partner');
      var unattributed = m.delayed - m.companySide - m.partnerSide;
      if (unattributed > 0) sides.push(unattributed + ' unattributed');

      return '<div class="delayed-row clickable" data-open-project="' + row.project.id + '">' +
        '<span class="delayed-name"><b>' + escapeHtml(row.project.code) + '</b> ' +
          escapeHtml(row.project.title) +
          '<span class="row-sub">' + escapeHtml(row.project.type || 'Type not set') + '</span></span>' +
        '<span class="badge delayed">' + plural(m.delayed, 'delay') + '</span>' +
        '<span class="muted-sm">' + escapeHtml(sides.join(' · ')) + '</span>' +
      '</div>';
    }).join('');
  }

  function renderPortfolioDelays(totals) {
    var wrap = document.getElementById('pf-attribution');

    if (!totals.delayed) {
      wrap.innerHTML = '<p class="muted-sm">No delays recorded across your projects.</p>';
      document.getElementById('pf-offenders-box').classList.add('hidden');
      return;
    }

    var unattributed = totals.delayed - totals.companySide - totals.partnerSide;

    wrap.innerHTML =
      '<div class="stack">' +
        barSegment(totals.companySide, totals.delayed, 'company') +
        barSegment(totals.partnerSide, totals.delayed, 'partner') +
        barSegment(unattributed, totals.delayed, 'unattributed') +
      '</div>' +
      '<ul class="legend">' +
        legendItem('company', 'Company Side', totals.companySide, totals.delayed) +
        legendItem('partner', 'Partner Side', totals.partnerSide, totals.delayed) +
        (unattributed > 0 ? legendItem('unattributed', 'Unattributed', unattributed, totals.delayed) : '') +
      '</ul>';

    // Ranked by delay count — magnitude, so a single hue, no categorical colours
    var offenders = totals.perProject
      .filter(function (row) { return row.metrics.delayed > 0; })
      .sort(function (a, b) { return b.metrics.delayed - a.metrics.delayed; })
      .slice(0, 5);

    document.getElementById('pf-offenders-box').classList.toggle('hidden', !offenders.length);
    if (!offenders.length) return;

    var worst = offenders[0].metrics.delayed;
    document.getElementById('pf-offenders').innerHTML = offenders.map(function (row) {
      return '<div class="rank-row clickable" data-open-project="' + row.project.id + '">' +
        '<span class="rank-label"><b>' + escapeHtml(row.project.code) + '</b> ' +
          escapeHtml(row.project.title) + '</span>' +
        '<span class="rank-track">' +
          '<span class="rank-bar" style="width:' + sharePercent(row.metrics.delayed, worst) + '%"></span>' +
        '</span>' +
        '<span class="rank-count">' + row.metrics.delayed + '</span>' +
      '</div>';
    }).join('');
  }

  function renderPortfolioProgress(totals) {
    var body = document.getElementById('pf-rows');
    body.innerHTML = '';

    var rows = totals.perProject.slice().sort(function (a, b) {
      return b.metrics.percent - a.metrics.percent;
    });

    rows.forEach(function (row) {
      var p = row.project;
      var m = row.metrics;
      var tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.dataset.openProject = p.id;
      tr.innerHTML =
        '<td><b>' + escapeHtml(p.code) + '</b><span class="row-sub">' + escapeHtml(p.title) + '</span></td>' +
        '<td><span class="badge ' + (statusClass[p.status] || 'todo') + '">' + escapeHtml(p.status) + '</span></td>' +
        '<td class="progress-cell">' +
          '<span class="meter"><span class="meter-fill" style="width:' + m.percent + '%"></span></span>' +
          '<span class="progress-value">' + m.percent + '%</span>' +
        '</td>' +
        '<td class="dates">' + m.itemsDone + ' / ' + plural(m.itemsTotal, 'item') +
          '<span class="row-sub">' + m.milestonesDone + ' / ' +
          plural(m.milestonesTotal, 'milestone') + '</span></td>';
      body.appendChild(tr);
    });

    document.getElementById('pf-empty').classList.toggle('hidden', rows.length > 0);
  }

  // Dashboard rows open the project they describe
  document.getElementById('portfolio').addEventListener('click', function (e) {
    var row = e.target.closest('[data-open-project]');
    if (!row) return;

    var project = projectById(Number(row.dataset.openProject));
    if (!project || !canSee(project)) return;

    document.querySelector('.tab[data-tab="projects"]').click();
    showDetail(project.id);
  });

  rows.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');

    if (btn) {
      var project = projectById(Number(btn.dataset.id));
      if (!project || !canSee(project)) return;
      if (btn.dataset.action === 'view')   showDetail(project.id);
      if (isPartner()) return;             // partners get View and nothing else
      if (btn.dataset.action === 'edit')   openProjectForm(project);
      if (btn.dataset.action === 'delete') removeProject(project);
      return;
    }

    // Clicking anywhere else on the row opens the project
    var tr = e.target.closest('tr[data-open]');
    if (tr) showDetail(Number(tr.dataset.open));
  });

  search.addEventListener('input', renderList);

  // ---------------------------------------------------------------
  // Project create / update / delete
  // ---------------------------------------------------------------
  var projectForm = document.getElementById('project-form');
  var formError   = document.getElementById('form-error');

  function openProjectForm(project) {
    if (isPartner()) return;
    projectForm.reset();
    formError.classList.add('hidden');

    document.getElementById('form-title').textContent = project ? 'Edit Project' : 'New Project';
    document.getElementById('project-id').value = project ? project.id : '';

    if (project) {
      document.getElementById('f-code').value    = project.code;
      document.getElementById('f-type').value    = project.type || '';
      document.getElementById('f-title').value   = project.title;
      document.getElementById('f-desc').value    = project.description || '';
      document.getElementById('f-p-start').value = project.partnerStart || '';
      document.getElementById('f-p-end').value   = project.partnerEnd || '';
      document.getElementById('f-c-start').value = project.companyStart || '';
      document.getElementById('f-c-end').value   = project.companyEnd || '';
      document.getElementById('f-a-start').value = project.approvedStart || '';
      document.getElementById('f-a-end').value   = project.approvedEnd || '';
      document.getElementById('f-status').value  = project.status;
    }

    updateApprovedDays();

    // Same rules as the detail page: forward-only, and no closing with open milestones
    var formStatus = document.getElementById('f-status');
    if (project) {
      applyStatusRules(formStatus, project);
    } else {
      Array.prototype.slice.call(formStatus.options).forEach(function (o) { o.disabled = false; });
    }

    openModal(formModal);
    document.getElementById('f-code').focus();
  }

  document.getElementById('new-project').addEventListener('click', function () {
    openProjectForm(null);
  });

  // Live day count under the approved range inputs
  function updateApprovedDays() {
    var start = document.getElementById('f-a-start').value;
    var end   = document.getElementById('f-a-end').value;
    var label = dayLabel(start, end);
    document.getElementById('approved-days').textContent = label
      ? 'Approved duration: ' + label
      : (start && end ? 'End date is before the start date.' : 'No approved range set.');
  }

  ['f-a-start', 'f-a-end'].forEach(function (fieldId) {
    document.getElementById(fieldId).addEventListener('change', updateApprovedDays);
  });

  projectForm.addEventListener('submit', function (e) {
    e.preventDefault();
    formError.classList.add('hidden');

    var id     = document.getElementById('project-id').value;
    var code   = document.getElementById('f-code').value.trim();
    var pStart = document.getElementById('f-p-start').value;
    var pEnd   = document.getElementById('f-p-end').value;
    var cStart = document.getElementById('f-c-start').value;
    var cEnd   = document.getElementById('f-c-end').value;
    var aStart = document.getElementById('f-a-start').value;
    var aEnd   = document.getElementById('f-a-end').value;

    var duplicate = projects.some(function (p) {
      return p.code.toLowerCase() === code.toLowerCase() && String(p.id) !== id;
    });
    var status = document.getElementById('f-status').value;
    var editing = id ? projectById(Number(id)) : null;

    if (duplicate) return showError(formError, 'Project code "' + code + '" already exists.');
    if (status === 'Completed' && editing && !allMilestonesComplete(editing)) {
      return showError(formError, blockingSummary(editing) +
        ' — every milestone must be completed and approved first.');
    }
    if (editing && !isForwardMove(editing.status, status)) {
      return showError(formError, 'Project status only moves forward. "' + editing.status +
        '" cannot go back to "' + status + '".');
    }
    if (pStart && pEnd && pEnd < pStart) return showError(formError, 'Partner end date cannot be before its start date.');
    if (cStart && cEnd && cEnd < cStart) return showError(formError, 'Company end date cannot be before its start date.');
    if (aStart && aEnd && aEnd < aStart) return showError(formError, 'Approved end date cannot be before its start date.');

    var data = {
      code: code,
      type: document.getElementById('f-type').value,
      title: document.getElementById('f-title').value.trim(),
      description: document.getElementById('f-desc').value.trim(),
      partnerStart: pStart, partnerEnd: pEnd,
      companyStart: cStart, companyEnd: cEnd,
      approvedStart: aStart, approvedEnd: aEnd,
      status: status
    };

    function commit() {
      var target = editing;
      if (id) {
        var statusChanged = target.status !== data.status;
        var before = target.status;
        Object.keys(data).forEach(function (k) { target[k] = data[k]; });
        logAudit('Project', 'Updated', data.code + ' — ' + data.title,
          statusChanged ? 'Status ' + before + ' → ' + data.status : 'Details edited');
      } else {
        data.id = nextId++;
        data.resources = [];
        data.pocs = [];
        data.milestones = [];
        projects.push(data);
        target = data;
        logAudit('Project', 'Created', data.code + ' — ' + data.title,
          data.type + ' · ' + data.status);
      }

      save();
      closeAll();
      rerender();

      // Closing a project from the edit form prompts for anything left open
      if (status === 'Completed') promptProjectCascade(target);
    }

    // Same irreversible step as the detail page, so warn here too
    var closingProject = status === 'Completed' && (!editing || editing.status !== 'Completed');
    if (closingProject) {
      return confirmProjectCompletion({ code: code, title: data.title }, commit);
    }

    commit();
  });

  function rerender() {
    if (currentProjectId) renderDetail(); else renderList();
  }

  // Deleting a project needs a written reason, which the audit trail keeps
  var deleteModal   = document.getElementById('delete-modal');
  var deleteReason  = document.getElementById('delete-reason');
  var deleteError   = document.getElementById('delete-error');
  var deleteTarget  = null;

  function removeProject(p) {
    if (isPartner()) return;
    deleteTarget = p;
    deleteReason.value = '';
    deleteError.classList.add('hidden');
    document.getElementById('delete-subject').textContent =
      p.code + ' — ' + p.title + ' will be permanently deleted.';
    openModal(deleteModal);
    deleteReason.focus();
  }

  document.getElementById('delete-confirm').addEventListener('click', function () {
    if (!deleteTarget) return;

    var reason = deleteReason.value.trim();
    if (reason.length < 5) {
      return showError(deleteError, 'Give a reason for deleting this project (at least 5 characters).');
    }

    var p = deleteTarget;
    deleteTarget = null;

    projects = projects.filter(function (item) { return item.id !== p.id; });
    save();
    logAudit('Project', 'Deleted', p.code + ' — ' + p.title, 'Reason: ' + reason);
    closeAll();
    showList();
    renderAudit();
  });

  function showError(el, message) {
    el.textContent = message;
    el.classList.remove('hidden');
  }

  // ===============================================================
  // DETAIL VIEW
  // ===============================================================
  function showDetail(id) {
    var project = projectById(id);
    if (!project || !canSee(project)) return showList();   // not yours to open

    currentProjectId = id;
    listView.classList.add('hidden');
    detailView.classList.remove('hidden');
    renderDetail();
    window.scrollTo(0, 0);
  }

  document.getElementById('back-to-list').addEventListener('click', showList);

  document.getElementById('d-edit').addEventListener('click', function () {
    openProjectForm(projectById(currentProjectId));
  });

  // Change the project status straight from the detail page
  document.getElementById('d-status-select').addEventListener('change', function (e) {
    var p = projectById(currentProjectId);
    var next = e.target.value;

    // Neither should be reachable — both options are disabled — but never trust the UI
    if (!isForwardMove(p.status, next) ||
        (next === 'Completed' && !allMilestonesComplete(p))) {
      e.target.value = p.status;
      return;
    }
    // Closing a project is irreversible, so ask before applying it
    if (next === 'Completed') {
      e.target.value = p.status;          // hold the old value until confirmed
      return confirmProjectCompletion(p, function () {
        applyProjectStatus(p, 'Completed');
      });
    }

    var previous = p.status;
    p.status = next;
    save();
    logAudit('Project', 'Status changed', p.code + ' — ' + p.title, previous + ' → ' + next);
    renderDetail();
  });

  function applyProjectStatus(p, status) {
    var previous = p.status;
    p.status = status;
    save();
    logAudit('Project', 'Status changed', p.code + ' — ' + p.title, previous + ' → ' + status);
    rerender();
    if (status === 'Completed') promptProjectCascade(p);
  }

  function confirmProjectCompletion(p, onConfirm) {
    openConfirm({
      title: 'Mark project as Completed?',
      message: p.code + ' — ' + p.title + ' will be marked Completed.',
      warning: 'This cannot be undone. A completed project cannot be moved back to ' +
               'In-Progress or Not Started, and its milestones and sub-tasks become locked.',
      requireText: p.code,
      confirmLabel: 'Mark project Completed',
      onConfirm: onConfirm
    });
  }

  function renderDetail() {
    var p = projectById(currentProjectId);
    if (!p) return showList();

    document.getElementById('d-code').textContent  = p.code;
    document.getElementById('d-title').textContent = p.title;

    var typeChip = document.getElementById('d-type');
    typeChip.textContent = p.type || 'Type not set';
    typeChip.classList.toggle('unset', !p.type);

    var statusSelect = document.getElementById('d-status-select');
    statusSelect.value = p.status;
    statusSelect.className = 'status-' + (statusClass[p.status] || 'todo');

    // Status moves forward only, and "Completed" waits on the milestones
    applyStatusRules(statusSelect, p);

    var statusHint = document.getElementById('status-hint');
    var blocking = blockingSummary(p);

    if (p.status === 'Completed') {
      statusHint.textContent = 'This project is Completed. Its status is final and cannot be moved back.';
      statusHint.classList.remove('hidden');
    } else if (blocking) {
      statusHint.textContent = blocking +
        ' — every milestone must be completed and approved before this project can be marked Completed.';
      statusHint.classList.remove('hidden');
    } else {
      statusHint.classList.add('hidden');
    }

    var desc = document.getElementById('d-desc');
    desc.innerHTML = p.description
      ? escapeHtml(p.description)
      : '<span class="muted-sm">No description yet.</span>';

    document.getElementById('d-partner').innerHTML  = formatRangeWithDays(p.partnerStart, p.partnerEnd);
    document.getElementById('d-company').innerHTML  = formatRangeWithDays(p.companyStart, p.companyEnd);
    document.getElementById('d-approved').innerHTML = formatRangeWithDays(p.approvedStart, p.approvedEnd);

    renderDashboard(p);
    renderPeople('d-resources', p.resources, 'resources');
    renderPeople('d-pocs', p.pocs, 'pocs');
    renderMilestones(p);
  }

  // ---------------------------------------------------------------
  // Project dashboard — company side only
  // ---------------------------------------------------------------
  function renderDashboard(p) {
    var section = document.getElementById('project-dashboard');

    // Partners get the milestone list, not the analytics
    section.classList.toggle('hidden', isPartner());
    if (isPartner()) return;

    var m = projectMetrics(p);
    var hasMilestones = m.itemsTotal > 0;

    document.getElementById('dash-empty').classList.toggle('hidden', hasMilestones);
    document.getElementById('dash-body').classList.toggle('hidden', !hasMilestones);
    if (!hasMilestones) return;

    document.getElementById('dash-percent').textContent    = m.percent + '%';
    document.getElementById('dash-milestones').textContent = m.milestonesDone + ' / ' + m.milestonesTotal;
    document.getElementById('dash-subtasks').textContent   = m.subtasksDone + ' / ' + m.subtasksTotal;
    document.getElementById('dash-delayed').textContent    = m.delayed;

    // On-time is the flag chosen at completion, so it only means anything
    // once some milestones are actually done.
    var doneMs = m.milestonesDone;
    document.getElementById('dash-ontime').textContent =
      doneMs ? m.milestonesOnTime + ' / ' + doneMs : '—';
    document.getElementById('dash-ontime-sub').textContent = doneMs
      ? Math.round(sharePercent(m.milestonesOnTime, doneMs)) + '% of completed milestones'
      : 'No milestones completed yet';

    // Progress meter — one ratio against its limit
    document.getElementById('dash-meter').innerHTML =
      '<div class="meter-fill" style="width:' + m.percent + '%"></div>';
    document.getElementById('dash-meter-caption').textContent =
      m.itemsDone + ' of ' + plural(m.itemsTotal, 'item') + ' completed ' +
      '(' + m.milestonesDone + ' of ' + plural(m.milestonesTotal, 'milestone') + ', ' +
      m.subtasksDone + ' of ' + plural(m.subtasksTotal, 'sub-task') + ')';

    renderOutcomeBar(m);
    renderAttributionBar(m);
    renderCycleTime(m);
    renderDelayReasons(m);
  }

  // Average start -> completion, over the milestones that can actually be
  // measured. The caption names the sample size so a thin one is obvious.
  function renderCycleTime(m) {
    var wrap = document.getElementById('dash-cycle');
    var measured = m.cycleTimes.length;

    if (!measured) {
      wrap.innerHTML = '<p class="muted-sm">No milestones have both a start date and a ' +
        'recorded completion date yet, so cycle time cannot be measured.</p>';
      return;
    }

    var totalDays = m.cycleTimes.reduce(function (sum, entry) { return sum + entry.days; }, 0);
    var average = Math.round(totalDays / measured);

    var slowest = m.cycleTimes.slice()
      .sort(function (a, b) { return b.days - a.days; })
      .slice(0, 3);
    var longest = slowest[0].days;

    wrap.innerHTML =
      '<p class="hero-stat">' + plural(average, 'day') +
        '<span class="hero-sub">average, based on ' + measured + ' of ' +
        plural(m.milestonesTotal, 'milestone') + '</span></p>' +
      slowest.map(function (entry) {
        return '<div class="rank-row">' +
          '<span class="rank-label">' + escapeHtml(entry.title) + '</span>' +
          '<span class="rank-track"><span class="rank-bar cycle" style="width:' +
            sharePercent(entry.days, longest) + '%"></span></span>' +
          '<span class="rank-count">' + entry.days + 'd</span>' +
        '</div>';
      }).join('');
  }

  // A labelled segment of a stacked bar
  function barSegment(value, whole, klass) {
    if (!value) return '';
    return '<div class="seg ' + klass + '" style="width:' + sharePercent(value, whole) + '%">' +
      '<span class="seg-label">' + value + '</span></div>';
  }

  function legendItem(klass, label, value, whole) {
    return '<li><span class="swatch ' + klass + '"></span>' +
      escapeHtml(label) + ' <b>' + value + '</b> ' +
      '<span class="muted-sm">(' + Math.round(sharePercent(value, whole)) + '%)</span></li>';
  }

  function renderOutcomeBar(m) {
    var wrap = document.getElementById('dash-outcome');
    var done = m.onTime + m.delayed;

    if (!done) {
      wrap.innerHTML = '<p class="muted-sm">Nothing completed yet.</p>';
      return;
    }

    wrap.innerHTML =
      '<div class="stack">' +
        barSegment(m.onTime, done, 'ontime') +
        barSegment(m.delayed, done, 'delayed') +
      '</div>' +
      '<ul class="legend">' +
        legendItem('ontime', 'On-Time', m.onTime, done) +
        legendItem('delayed', 'Delayed', m.delayed, done) +
      '</ul>';
  }

  function renderAttributionBar(m) {
    var wrap = document.getElementById('dash-attribution');

    if (!m.delayed) {
      wrap.innerHTML = '<p class="muted-sm">No delays recorded on this project.</p>';
      return;
    }

    var unattributed = m.delayed - m.companySide - m.partnerSide;

    wrap.innerHTML =
      '<div class="stack">' +
        barSegment(m.companySide, m.delayed, 'company') +
        barSegment(m.partnerSide, m.delayed, 'partner') +
        barSegment(unattributed, m.delayed, 'unattributed') +
      '</div>' +
      '<ul class="legend">' +
        legendItem('company', 'Company Side', m.companySide, m.delayed) +
        legendItem('partner', 'Partner Side', m.partnerSide, m.delayed) +
        (unattributed > 0 ? legendItem('unattributed', 'Unattributed', unattributed, m.delayed) : '') +
      '</ul>';
  }

  function renderDelayReasons(m) {
    var box = document.getElementById('dash-reasons-box');
    box.classList.toggle('hidden', !m.delayNotes.length);
    if (!m.delayNotes.length) return;

    document.getElementById('dash-reasons-summary').textContent =
      'Delay reasons (' + m.delayNotes.length + ')';

    document.getElementById('dash-reasons').innerHTML = m.delayNotes.map(function (entry) {
      return '<li>' +
        '<b>' + escapeHtml(entry.title) + '</b>' +
        '<span class="badge ' + (entry.side === 'Partner Side' ? 'attr-partner' : 'attr-company') + '">' +
          escapeHtml(entry.side || 'Unattributed') + '</span>' +
        '<p>' + escapeHtml(entry.note) + '</p>' +
      '</li>';
    }).join('');
  }

  function renderPeople(containerId, ids, kind) {
    var ul = document.getElementById(containerId);
    ul.innerHTML = '';

    if (!ids.length) {
      ul.innerHTML = '<li class="muted-sm">Nobody assigned yet.</li>';
      return;
    }

    ids.forEach(function (id) {
      var person = personById(id);
      if (!person) return;
      var li = document.createElement('li');
      li.innerHTML =
        '<div class="avatar xs">' + escapeHtml(initials(person.name)) + '</div>' +
        '<div class="person-info"><b>' + escapeHtml(person.name) + '</b>' +
        '<span>' + escapeHtml(person.role) + '</span></div>' +
        (isPartner() ? '' :
          '<button class="unassign" data-unassign="' + kind + '" data-person="' + person.id + '" title="Remove">&times;</button>');
      ul.appendChild(li);
    });
  }

  // Remove an assigned person
  detailView.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-unassign]');
    if (!btn || isPartner()) return;
    var p = projectById(currentProjectId);
    var kind = btn.dataset.unassign;
    var removed = personById(btn.dataset.person);
    p[kind] = p[kind].filter(function (id) { return id !== btn.dataset.person; });
    save();
    logAudit('People', 'Unassigned', removed ? removed.name : btn.dataset.person,
      'From ' + p.code + (kind === 'pocs' ? ' (Partner POC)' : ' (Resource)'));
    renderDetail();
  });

  // ---------------------------------------------------------------
  // Assign people
  // ---------------------------------------------------------------
  document.getElementById('assign-resources').addEventListener('click', function () {
    openAssign('resources');
  });
  document.getElementById('assign-pocs').addEventListener('click', function () {
    openAssign('pocs');
  });

  function openAssign(kind) {
    if (isPartner()) return;
    assignKind = kind;
    var p = projectById(currentProjectId);
    var pool = kind === 'resources' ? directory.company : directory.partners;

    document.getElementById('assign-title').textContent =
      kind === 'resources' ? 'Assign Organisation Resources' : 'Assign Partner Company POC';

    var list = document.getElementById('assign-list');
    list.innerHTML = '';
    pool.forEach(function (person) {
      var checked = p[kind].indexOf(person.id) > -1 ? ' checked' : '';
      var label = document.createElement('label');
      label.className = 'pick';
      label.innerHTML =
        '<input type="checkbox" value="' + person.id + '"' + checked + ' />' +
        '<div class="avatar xs">' + escapeHtml(initials(person.name)) + '</div>' +
        '<div class="person-info"><b>' + escapeHtml(person.name) + '</b>' +
        '<span>' + escapeHtml(person.role) + '</span></div>';
      list.appendChild(label);
    });

    openModal(assignModal);
  }

  document.getElementById('assign-save').addEventListener('click', function () {
    var p = projectById(currentProjectId);
    var was = p[assignKind];
    p[assignKind] = Array.prototype.slice
      .call(document.querySelectorAll('#assign-list input:checked'))
      .map(function (input) { return input.value; });

    var added = p[assignKind].filter(function (id) { return was.indexOf(id) === -1; });
    var gone  = was.filter(function (id) { return p[assignKind].indexOf(id) === -1; });
    var names = function (ids) {
      return ids.map(function (id) {
        var person = personById(id);
        return person ? person.name : id;
      }).join(', ');
    };

    save();
    if (added.length || gone.length) {
      logAudit('People', 'Assignments updated',
        p.code + (assignKind === 'pocs' ? ' · Partner POCs' : ' · Resources'),
        [added.length ? 'Added ' + names(added) : '',
         gone.length ? 'Removed ' + names(gone) : ''].filter(Boolean).join(' · '));
    }
    closeAll();
    renderDetail();
  });

  // ---------------------------------------------------------------
  // Milestones & sub-tasks
  // ---------------------------------------------------------------
  // Completion badge shown on a finished milestone / sub-task
  function completionBadge(item) {
    if (!item.completed) return '';
    if (item.outcome === 'Delayed') {
      return '<span class="badge delayed">Delayed · ' + escapeHtml(item.delaySide || 'Unattributed') + '</span>';
    }
    return '<span class="badge ontime">On-Time</span>';
  }

  function delayNote(item) {
    if (!item.completed || item.outcome !== 'Delayed' || !item.delayNotes) return '';
    return '<p class="delay-note">' + escapeHtml(item.delayNotes) + '</p>';
  }

  // Marking only makes sense while the project is running, and completion is
  // final — there is deliberately no way to reopen a completed item.
  function completionButton(inProgress, item, msId, stId) {
    if (!inProgress || item.completed) return '';
    var attrs = ' data-ms="' + msId + '"' + (stId ? ' data-st="' + stId + '"' : '');
    return '<button class="icon-btn done-btn" data-action="complete' +
      (stId ? '-subtask' : '-milestone') + '"' + attrs + '>Mark Complete</button>';
  }

  function openSubtasks(m) {
    return m.subtasks.filter(function (s) { return !s.completed; }).length;
  }

  // A milestone can only be closed once every sub-task under it is closed.
  // A milestone with no sub-tasks can be closed straight away.
  function milestoneCompleteButton(inProgress, m) {
    if (!inProgress || m.completed) return '';
    var open = openSubtasks(m);
    if (!open) return completionButton(inProgress, m, m.id);
    return '<button class="icon-btn done-btn" disabled title="Complete all ' +
      plural(open, 'sub-task') + ' first">Mark Complete</button>';
  }

  // Sub-tasks cannot be added to a milestone that is already closed
  function addSubtaskButton(m) {
    if (m.completed) return '';
    return '<button class="icon-btn" data-action="add-subtask" data-ms="' + m.id + '">+ Sub-task</button>';
  }

  // ---- Approval trip -------------------------------------------------
  function approvalBadge(m) {
    if (m.approval === 'pending') {
      return '<span class="badge pending">Pending Approval</span>';
    }
    if (m.approval === 'approved') {
      var who = m.approvedBy ? personById(m.approvedBy) : null;
      return '<span class="badge approved">Approved' +
        (who ? ' · ' + escapeHtml(who.name) : '') + '</span>';
    }
    return '';
  }

  // Highlight "@Name" for anyone in the directory
  function highlightMentions(escapedText) {
    everyone().forEach(function (person) {
      var tag = '@' + escapeHtml(person.name);
      escapedText = escapedText.split(tag).join('<span class="mention">' + tag + '</span>');
    });
    return escapedText;
  }

  // The partner's review is visible to the company side only
  function feedbackBlock(m) {
    if (!m.feedback || isPartner()) return '';
    var rating = m.feedback.rating;
    var who = m.approvedBy ? personById(m.approvedBy) : null;

    return '<div class="feedback">' +
      '<div class="feedback-head">' +
        '<span class="stars">' + '★'.repeat(rating) + '☆'.repeat(5 - rating) + '</span>' +
        '<span class="rating-num">' + rating + '/5 · ' + RATING_WORDS[rating] + '</span>' +
        (who ? '<span class="muted-sm">— ' + escapeHtml(who.name) +
               (m.approvedAt ? ' on ' + formatDate(m.approvedAt) : '') + '</span>' : '') +
      '</div>' +
      '<p>' + highlightMentions(escapeHtml(m.feedback.comment)) + '</p>' +
    '</div>';
  }

  // Company side: submit a finished milestone to the partner
  function submitButton(p, m) {
    if (isPartner() || m.approval !== 'none') return '';

    if (!m.completed) {
      return '<button class="icon-btn" disabled title="Complete this milestone before submitting it for approval">' +
        'Submit for Approval</button>';
    }
    if (!p.pocs.length) {
      return '<button class="icon-btn" disabled title="Assign a Partner POC to this project first">' +
        'Submit for Approval</button>';
    }
    return '<button class="icon-btn submit-btn" data-action="submit-milestone" data-ms="' + m.id +
      '">Submit for Approval</button>';
  }

  // Partner side: approve what was submitted to them
  function approveButton(p, m) {
    if (!isPartner() || m.approval !== 'pending') return '';
    if (p.pocs.indexOf(currentUser.id) === -1) return '';
    return '<button class="icon-btn approve-btn" data-action="approve-milestone" data-ms="' + m.id +
      '">Approve</button>';
  }

  function renderMilestones(p) {
    var wrap = document.getElementById('d-milestones');
    var readOnly   = isPartner();
    var inProgress = p.status === 'In-Progress' && !readOnly;
    wrap.innerHTML = '';

    if (!p.milestones.length) {
      wrap.innerHTML = readOnly
        ? '<p class="empty">No milestones have been added to this project yet.</p>'
        : '<p class="empty">No milestones yet. Add the first one to get started.</p>';
      return;
    }

    // Partners get the banner at the top of the page instead of this hint
    if (!inProgress && !readOnly) {
      var hint = document.createElement('p');
      hint.className = 'hint-bar';
      hint.textContent = p.status === 'Completed'
        ? 'This project is Completed — milestone and sub-task statuses are locked.'
        : 'Milestone and sub-task statuses cannot be changed until this project is In-Progress.';
      wrap.appendChild(hint);
    }

    p.milestones.forEach(function (m) {
      var card = document.createElement('div');
      card.className = 'milestone' + (m.completed ? ' is-done' : '');

      var subtaskHtml = m.subtasks.length
        ? m.subtasks.map(function (s) {
            return '<li' + (s.completed ? ' class="is-done"' : '') + '>' +
              '<span class="st-title">' + escapeHtml(s.title) + completionBadge(s) + delayNote(s) + '</span>' +
              (readOnly ? '' :
                '<span class="st-actions">' +
                  completionButton(inProgress, s, m.id, s.id) +
                  '<button class="icon-btn" data-action="edit-subtask" data-ms="' + m.id + '" data-st="' + s.id + '">Edit</button>' +
                  '<button class="icon-btn danger" data-action="delete-subtask" data-ms="' + m.id + '" data-st="' + s.id + '">Delete</button>' +
                '</span>') +
              '</li>';
          }).join('')
        : '<li class="muted-sm">No sub-tasks yet.</li>';

      var doneCount = m.subtasks.filter(function (s) { return s.completed; }).length;

      card.innerHTML =
        '<div class="ms-head">' +
          '<div>' +
            '<h4>' + escapeHtml(m.title) + completionBadge(m) + approvalBadge(m) + '</h4>' +
            '<span class="dates">' + formatRangeWithDays(m.start, m.end) + '</span>' +
            '<span class="row-sub">' + doneCount + ' of ' + m.subtasks.length + ' sub-tasks completed</span>' +
            delayNote(m) +
          '</div>' +
          (readOnly
            ? '<div class="nowrap">' + approveButton(p, m) + '</div>'
            : '<div class="nowrap">' +
                milestoneCompleteButton(inProgress, m) +
                submitButton(p, m) +
                addSubtaskButton(m) +
                '<button class="icon-btn" data-action="edit-milestone" data-ms="' + m.id + '">Edit</button>' +
                '<button class="icon-btn danger" data-action="delete-milestone" data-ms="' + m.id + '">Delete</button>' +
              '</div>') +
        '</div>' +
        feedbackBlock(m) +
        '<ul class="subtasks">' + subtaskHtml + '</ul>';

      wrap.appendChild(card);
    });
  }

  document.getElementById('add-milestone').addEventListener('click', function () {
    openItemForm({ kind: 'milestone' });
  });

  document.getElementById('d-milestones').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    // Approving is the one thing a partner may do; everything else is read-only
    if (isPartner() && btn.dataset.action !== 'approve-milestone') return;

    var p = projectById(currentProjectId);
    if (!p || !canSee(p)) return;      // no project open, or not one you may touch

    var ms = p.milestones.filter(function (m) { return m.id === Number(btn.dataset.ms); })[0];
    if (!ms) return;

    switch (btn.dataset.action) {
      case 'add-subtask':
        if (ms.completed) return;   // closed milestones take no new sub-tasks
        openItemForm({ kind: 'subtask', milestoneId: ms.id });
        break;
      case 'edit-milestone':
        openItemForm({ kind: 'milestone', itemId: ms.id }, ms);
        break;
      case 'delete-milestone':
        if (!confirm('Delete milestone "' + ms.title + '" and its ' + ms.subtasks.length + ' sub-task(s)?')) return;
        p.milestones = p.milestones.filter(function (m) { return m.id !== ms.id; });
        save();
        logAudit('Milestone', 'Deleted', ms.title, 'From ' + p.code +
          ' · ' + plural(ms.subtasks.length, 'sub-task') + ' removed with it');
        renderDetail();
        break;
      case 'edit-subtask':
        var st = ms.subtasks.filter(function (s) { return s.id === Number(btn.dataset.st); })[0];
        if (st) openItemForm({ kind: 'subtask', milestoneId: ms.id, itemId: st.id }, st);
        break;
      case 'delete-subtask':
        var target = ms.subtasks.filter(function (s) { return s.id === Number(btn.dataset.st); })[0];
        if (!target || !confirm('Delete sub-task "' + target.title + '"?')) return;
        ms.subtasks = ms.subtasks.filter(function (s) { return s.id !== target.id; });
        save();
        logAudit('Sub-task', 'Deleted', target.title, 'From ' + p.code + ' › ' + ms.title);
        renderDetail();
        break;

      case 'complete-milestone':
        completeMilestone(ms);
        break;
      case 'complete-subtask':
        var toFinish = subtaskOf(ms, btn.dataset.st);
        if (toFinish) openCompleteForm({
          title: 'Mark Sub-task as Completed',
          subject: toFinish.title,
          primary: [toFinish]
        });
        break;

      case 'submit-milestone':
        submitForApproval(p, ms);
        break;
      case 'approve-milestone':
        approveMilestone(p, ms);
        break;
    }
  });

  // Company side sends a finished milestone to the partner POC
  function submitForApproval(p, ms) {
    if (isPartner() || !ms.completed || ms.approval !== 'none' || !p.pocs.length) return;

    var names = p.pocs.map(function (id) {
      var person = personById(id);
      return person ? person.name : id;
    }).join(', ');

    if (!confirm('Submit "' + ms.title + '" to ' + names + ' for approval?')) return;

    ms.approval    = 'pending';
    ms.submittedAt = today();
    save();
    logAudit('Approval', 'Submitted for approval', p.code + ' › ' + ms.title, 'Sent to ' + names);
    renderDetail();
  }

  // Partner POC approves what was submitted to them, via the feedback form
  function approveMilestone(p, ms) {
    if (!isPartner() || ms.approval !== 'pending') return;
    if (p.pocs.indexOf(currentUser.id) === -1) return;   // not your project
    openApprovalForm(p, ms);
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  // ---------------------------------------------------------------
  // Approval feedback form: rating slider + comment with @ mentions
  // ---------------------------------------------------------------
  var approvalModal  = document.getElementById('approval-modal');
  var ratingInput    = document.getElementById('a-rating');
  var ratingLabel    = document.getElementById('a-rating-label');
  var commentInput   = document.getElementById('a-comment');
  var mentionList    = document.getElementById('mention-list');
  var approvalError  = document.getElementById('approval-error');

  var approvalTarget = null;   // { project, milestone }
  var mentionPeople  = [];     // everyone assigned to the project being reviewed
  var mentionStart   = -1;     // where the "@" token begins in the textarea
  var mentionIndex   = 0;      // highlighted row in the dropdown

  function showRating() {
    ratingLabel.textContent = ratingInput.value + '/5 · ' + RATING_WORDS[ratingInput.value];
  }
  ratingInput.addEventListener('input', showRating);

  function openApprovalForm(p, ms) {
    approvalTarget = { project: p, milestone: ms };

    // Only people actually on this project can be tagged
    mentionPeople = p.resources.concat(p.pocs)
      .map(personById)
      .filter(function (person) { return !!person; });

    document.getElementById('approval-subject').textContent =
      p.code + ' — ' + p.title + ' · ' + ms.title;

    ratingInput.value = '4';
    showRating();
    commentInput.value = '';
    approvalError.classList.add('hidden');
    hideMentions();

    openModal(approvalModal);
    commentInput.focus();
  }

  function hideMentions() {
    mentionList.classList.add('hidden');
    mentionList.innerHTML = '';
    mentionStart = -1;
  }

  function currentMatches() {
    return Array.prototype.slice.call(mentionList.querySelectorAll('li'));
  }

  // Look back from the caret for an "@word" being typed
  commentInput.addEventListener('input', function () {
    var caret = commentInput.selectionStart;
    var match = commentInput.value.slice(0, caret).match(/@([A-Za-z]*)$/);
    if (!match) return hideMentions();

    mentionStart = caret - match[0].length;
    var query = match[1].toLowerCase();
    var matches = mentionPeople.filter(function (person) {
      return person.name.toLowerCase().indexOf(query) > -1;
    });

    if (!matches.length) return hideMentions();

    mentionIndex = 0;
    mentionList.innerHTML = matches.map(function (person, i) {
      return '<li data-id="' + person.id + '"' + (i === 0 ? ' class="active"' : '') + '>' +
        '<div class="avatar xs">' + escapeHtml(initials(person.name)) + '</div>' +
        '<div class="person-info"><b>' + escapeHtml(person.name) + '</b>' +
        '<span>' + escapeHtml(person.role) + '</span></div></li>';
    }).join('');
    mentionList.classList.remove('hidden');
  });

  commentInput.addEventListener('keydown', function (e) {
    if (mentionList.classList.contains('hidden')) return;
    var rows = currentMatches();

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      mentionIndex = (mentionIndex + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
      rows.forEach(function (row, i) { row.classList.toggle('active', i === mentionIndex); });
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      insertMention(rows[mentionIndex].dataset.id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideMentions();
    }
  });

  mentionList.addEventListener('mousedown', function (e) {
    var row = e.target.closest('li');
    if (!row) return;
    e.preventDefault();
    insertMention(row.dataset.id);
  });

  function insertMention(personId) {
    var person = personById(personId);
    if (!person || mentionStart < 0) return;

    var caret = commentInput.selectionStart;
    var before = commentInput.value.slice(0, mentionStart);
    var after  = commentInput.value.slice(caret);
    var tag    = '@' + person.name + ' ';

    commentInput.value = before + tag + after;
    var pos = (before + tag).length;
    commentInput.setSelectionRange(pos, pos);
    commentInput.focus();
    hideMentions();
  }

  // Derived from the final text, so deleting a tag drops the mention too
  function mentionsIn(text) {
    return mentionPeople
      .filter(function (person) { return text.indexOf('@' + person.name) > -1; })
      .map(function (person) { return person.id; });
  }

  document.getElementById('approval-submit').addEventListener('click', function () {
    if (!approvalTarget) return;
    approvalError.classList.add('hidden');

    var comment = commentInput.value.trim();
    if (!comment) {
      approvalError.textContent = 'Add a comment before approving this milestone.';
      approvalError.classList.remove('hidden');
      return;
    }

    var p  = approvalTarget.project;
    var ms = approvalTarget.milestone;

    // Re-check the rules — the modal may have sat open for a while
    if (!isPartner() || ms.approval !== 'pending' || p.pocs.indexOf(currentUser.id) === -1) {
      closeAll();
      return;
    }

    ms.approval   = 'approved';
    ms.approvedBy = currentUser.id;
    ms.approvedAt = today();
    ms.feedback   = {
      rating: Number(ratingInput.value),
      comment: comment,
      mentions: mentionsIn(comment)
    };
    logAudit('Approval', 'Approved', p.code + ' › ' + ms.title,
      'Rating ' + ms.feedback.rating + '/5' +
      (ms.feedback.mentions.length ? ' · tagged ' + plural(ms.feedback.mentions.length, 'person').replace('persons', 'people') : ''));

    approvalTarget = null;
    save();
    closeAll();
    renderDetail();
  });

  function subtaskOf(milestone, id) {
    return milestone.subtasks.filter(function (s) { return s.id === Number(id); })[0];
  }

  // ---------------------------------------------------------------
  // Mark a milestone / sub-task complete
  // ---------------------------------------------------------------
  var completeForm  = document.getElementById('complete-form');
  var completeError = document.getElementById('complete-error');
  var outcomeSelect = document.getElementById('c-outcome');
  var delayFields   = document.getElementById('delay-fields');
  var cascadeRow    = document.getElementById('cascade-row');
  var cascadeBox    = document.getElementById('c-cascade');

  var completePrimary = [];   // marked outright
  var completeCascade = [];   // only the still-open items, marked if the box is ticked

  // opts: { title, subject, primary, cascade, cascadeLabel, submitLabel, cascadeChecked }
  function openCompleteForm(opts) {
    completePrimary = opts.primary || [];
    completeCascade = opts.cascade || [];

    completeForm.reset();
    completeError.classList.add('hidden');
    delayFields.classList.add('hidden');

    document.getElementById('complete-title').textContent   = opts.title;
    document.getElementById('complete-subject').textContent = opts.subject;
    document.getElementById('complete-submit').textContent  = opts.submitLabel || 'Mark Completed';

    // The cascade prompt only appears when there is something to cascade to,
    // and it never ticks itself — closing extra items has to be a deliberate choice.
    cascadeRow.classList.toggle('hidden', completeCascade.length === 0);
    cascadeBox.checked = opts.cascadeChecked === true;
    if (completeCascade.length) {
      document.getElementById('cascade-label').textContent = opts.cascadeLabel;
    }

    openModal(document.getElementById('complete-modal'));
    outcomeSelect.focus();
  }

  // A milestone is only closable once its sub-tasks are all closed
  function completeMilestone(ms) {
    if (openSubtasks(ms)) return;
    openCompleteForm({
      title: 'Mark Milestone as Completed',
      subject: ms.title,
      primary: [ms]
    });
  }

  // Ask to close everything still open on a project being marked Completed
  function promptProjectCascade(p) {
    var open = [];
    p.milestones.forEach(function (m) {
      if (!m.completed) open.push(m);
      m.subtasks.forEach(function (s) { if (!s.completed) open.push(s); });
    });
    if (!open.length) return;

    openCompleteForm({
      title: 'Mark Remaining Items as Completed?',
      subject: p.code + ' — ' + p.title + ' was marked Completed, but ' +
               plural(open.length, 'item') + ' below it ' +
               (open.length === 1 ? 'is' : 'are') + ' still open.',
      primary: [],
      cascade: open,
      cascadeLabel: 'Mark all ' + plural(open.length, 'remaining item') +
                    ' (milestones and sub-tasks) as completed, with the same outcome',
      submitLabel: 'Mark All Completed'
    });
  }

  // The delay attribution fields only appear for a delayed completion
  outcomeSelect.addEventListener('change', function () {
    delayFields.classList.toggle('hidden', outcomeSelect.value !== 'Delayed');
  });

  completeForm.addEventListener('submit', function (e) {
    e.preventDefault();
    completeError.classList.add('hidden');

    var outcome = outcomeSelect.value;
    var side    = document.getElementById('c-side').value;

    if (!outcome) return showError(completeError, 'Choose whether it finished on time or was delayed.');
    if (outcome === 'Delayed' && !side) {
      return showError(completeError, 'Attribute the delay to either the company or the partner side.');
    }

    var notes = outcome === 'Delayed' ? document.getElementById('c-notes').value.trim() : '';

    function apply(item) {
      item.completed   = true;
      item.outcome     = outcome;
      item.delaySide   = outcome === 'Delayed' ? side : '';
      item.delayNotes  = notes;
      item.completedAt = today();
    }

    var projectForLog = projectById(currentProjectId);
    var codeForLog = projectForLog ? projectForLog.code : '';

    function applyAndLog(item, cascaded) {
      apply(item);
      logAudit(item.subtasks ? 'Milestone' : 'Sub-task', 'Marked complete',
        codeForLog + ' › ' + item.title,
        outcome + (outcome === 'Delayed' ? ' · ' + side : '') + (cascaded ? ' (cascaded)' : ''));
    }

    completePrimary.forEach(function (item) { applyAndLog(item, false); });
    if (cascadeBox.checked) completeCascade.forEach(function (item) { applyAndLog(item, true); });

    save();
    closeAll();
    rerender();
  });

  var itemForm  = document.getElementById('item-form');
  var itemError = document.getElementById('item-error');

  function openItemForm(context, item) {
    if (isPartner()) return;
    itemContext = context;
    itemForm.reset();
    itemError.classList.add('hidden');

    var isMilestone = context.kind === 'milestone';
    var noun = isMilestone ? 'Milestone' : 'Sub-task';
    document.getElementById('item-title').textContent = (context.itemId ? 'Edit ' : 'Add ') + noun;

    // Date ranges belong to milestones only
    document.getElementById('item-dates').classList.toggle('hidden', !isMilestone);

    if (item && isMilestone) {
      document.getElementById('i-start').value = item.start || '';
      document.getElementById('i-end').value   = item.end || '';
    }
    if (item) document.getElementById('i-title').value = item.title;

    updateItemDays();

    openModal(itemModal);
    document.getElementById('i-title').focus();
  }

  // Live day count under the milestone date inputs
  function updateItemDays() {
    var start = document.getElementById('i-start').value;
    var end   = document.getElementById('i-end').value;
    var label = dayLabel(start, end);
    document.getElementById('item-days').textContent = label ? 'Duration: ' + label : '';
  }

  ['i-start', 'i-end'].forEach(function (fieldId) {
    document.getElementById(fieldId).addEventListener('change', updateItemDays);
  });

  itemForm.addEventListener('submit', function (e) {
    e.preventDefault();
    itemError.classList.add('hidden');

    var title = document.getElementById('i-title').value.trim();
    var isMilestone = itemContext.kind === 'milestone';
    var start = isMilestone ? document.getElementById('i-start').value : '';
    var end   = isMilestone ? document.getElementById('i-end').value : '';

    if (start && end && end < start) {
      return showError(itemError, 'End date cannot be before the start date.');
    }

    var p = projectById(currentProjectId);

    if (itemContext.kind === 'milestone') {
      if (itemContext.itemId) {
        var ms = p.milestones.filter(function (m) { return m.id === itemContext.itemId; })[0];
        ms.title = title; ms.start = start; ms.end = end;
        logAudit('Milestone', 'Updated', p.code + ' › ' + title, dateDetail(start, end));
      } else {
        p.milestones.push({ id: nextId++, title: title, start: start, end: end, subtasks: [] });
        logAudit('Milestone', 'Created', p.code + ' › ' + title, dateDetail(start, end));
      }
    } else {
      // Sub-tasks carry no dates — they sit inside their milestone's range
      var parent = p.milestones.filter(function (m) { return m.id === itemContext.milestoneId; })[0];
      if (itemContext.itemId) {
        var st = parent.subtasks.filter(function (s) { return s.id === itemContext.itemId; })[0];
        st.title = title;
        logAudit('Sub-task', 'Updated', p.code + ' › ' + parent.title + ' › ' + title, '');
      } else {
        parent.subtasks.push({ id: nextId++, title: title });
        logAudit('Sub-task', 'Created', p.code + ' › ' + parent.title + ' › ' + title, '');
      }
    }

    save();
    closeAll();
    renderDetail();
  });

  // ---------------------------------------------------------------
  // ---------------------------------------------------------------
  // Sign in / sign out
  // ---------------------------------------------------------------
  var loginView  = document.getElementById('login-view');
  var appView    = document.getElementById('app-view');
  var loginForm  = document.getElementById('login-form');
  var loginError = document.getElementById('login-error');

  function renderApp() {
    applyRole();
    renderProfile();
    renderDirectory();
    renderAudit();
    showList();
    document.querySelector('.tab[data-tab="dashboard"]').click();
  }

  function showApp(user) {
    currentUser = user;
    loginForm.reset();
    loginError.textContent = '';
    loginError.classList.add('hidden');
    loginView.classList.add('hidden');
    appView.classList.remove('hidden');
    renderApp();
  }

  function showLogin() {
    currentUser = null;
    appView.classList.add('hidden');
    loginView.classList.remove('hidden');
    loginForm.reset();
    loginError.classList.add('hidden');
    document.getElementById('login-email').focus();
  }

  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (location.protocol === 'file:') return;   // nothing to talk to
    loginError.classList.add('hidden');

    var submit = document.getElementById('login-submit');
    submit.disabled = true;

    api('POST', '/api/auth/login', {
      email: document.getElementById('login-email').value.trim(),
      password: document.getElementById('login-password').value
    }).then(function (user) {
      submit.disabled = false;
      showApp(user);
    }).catch(function (err) {
      submit.disabled = false;
      document.getElementById('login-password').value = '';
      // No status means the request never reached the server
      showError(loginError, err.status
        ? (err.message || 'Could not sign in.')
        : 'Could not reach the server. Check it is running and try again.');
    });
  });

  document.getElementById('logout').addEventListener('click', function () {
    api('POST', '/api/auth/logout')
      .catch(function () { /* sign out locally regardless */ })
      .then(showLogin);
  });

  // Opened by double-clicking index.html rather than through the server: every
  // /api call resolves against file:// and can never succeed. Say so plainly,
  // because "could not reach the server" sends people hunting a server that is
  // in fact running perfectly well.
  if (location.protocol === 'file:') {
    showLogin();
    document.getElementById('file-warning').classList.remove('hidden');
    document.getElementById('login-submit').disabled = true;
    document.getElementById('login-email').disabled = true;
    document.getElementById('login-password').disabled = true;
    return;
  }

  // Restore an existing session. Only a 401 means "not signed in" — a network
  // blip or a server hiccup must not silently dump a signed-in user onto the
  // login screen, so those get one retry and then an explicit message.
  function restoreSession(isRetry) {
    return api('GET', '/api/auth/me')
      .then(showApp)
      .catch(function (err) {
        if (err.status === 401) return showLogin();

        if (!isRetry) {
          return new Promise(function (resolve) {
            setTimeout(function () { resolve(restoreSession(true)); }, 800);
          });
        }

        showLogin();
        showError(loginError, 'Could not reach the server. Check it is running, then sign in again.');
      });
  }

  restoreSession(false);
});
