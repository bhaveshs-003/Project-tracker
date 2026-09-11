/**
 * SQLite connection, schema and seed.
 *
 * The database is the source of truth for everything the app shows. Nothing
 * business-related lives in the browser any more.
 */

var Database = require('better-sqlite3');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var DATA_DIR = path.join(__dirname, '..', 'data');
var DB_FILE = process.env.FT_DB || path.join(DATA_DIR, 'functional-tool.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

var db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');   // survives a hard kill mid-write
db.pragma('foreign_keys = ON');    // cascades are enforced, not hoped for

// ---------------------------------------------------------------
// Schema
// ---------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role       TEXT NOT NULL CHECK (role IN ('admin','partner')),
  salt       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- People are directory records. Only those with a row in users can sign in;
-- company resources deliberately cannot.
CREATE TABLE IF NOT EXISTS people (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  job_title TEXT NOT NULL,
  email     TEXT,
  kind      TEXT NOT NULL CHECK (kind IN ('company','partner'))
);

CREATE TABLE IF NOT EXISTS projects (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  type           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'Not Started'
                 CHECK (status IN ('Not Started','In-Progress','Completed')),
  partner_start  TEXT NOT NULL DEFAULT '',
  partner_end    TEXT NOT NULL DEFAULT '',
  company_start  TEXT NOT NULL DEFAULT '',
  company_end    TEXT NOT NULL DEFAULT '',
  approved_start TEXT NOT NULL DEFAULT '',
  approved_end   TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_resources (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  person_id  TEXT    NOT NULL REFERENCES people(id)   ON DELETE CASCADE,
  PRIMARY KEY (project_id, person_id)
);

CREATE TABLE IF NOT EXISTS project_pocs (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  person_id  TEXT    NOT NULL REFERENCES people(id)   ON DELETE CASCADE,
  PRIMARY KEY (project_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_pocs_person ON project_pocs(person_id);

CREATE TABLE IF NOT EXISTS milestones (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  company_start   TEXT NOT NULL DEFAULT '',
  company_end     TEXT NOT NULL DEFAULT '',
  partner_start   TEXT NOT NULL DEFAULT '',
  partner_end     TEXT NOT NULL DEFAULT '',
  approved_start  TEXT NOT NULL DEFAULT '',
  approved_end    TEXT NOT NULL DEFAULT '',
  position        INTEGER NOT NULL DEFAULT 0,
  completed       INTEGER NOT NULL DEFAULT 0,
  outcome         TEXT NOT NULL DEFAULT '',
  delay_side      TEXT NOT NULL DEFAULT '',
  delay_notes     TEXT NOT NULL DEFAULT '',
  completed_at    TEXT NOT NULL DEFAULT '',
  approval        TEXT NOT NULL DEFAULT 'none'
                  CHECK (approval IN ('none','pending','approved')),
  submitted_at    TEXT NOT NULL DEFAULT '',
  approved_by     TEXT,
  approved_at     TEXT NOT NULL DEFAULT '',
  feedback_rating INTEGER,
  feedback_comment TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(project_id);

CREATE TABLE IF NOT EXISTS milestone_mentions (
  milestone_id INTEGER NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  person_id    TEXT    NOT NULL REFERENCES people(id)     ON DELETE CASCADE,
  PRIMARY KEY (milestone_id, person_id)
);

CREATE TABLE IF NOT EXISTS subtasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  milestone_id INTEGER NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  completed    INTEGER NOT NULL DEFAULT 0,
  outcome      TEXT NOT NULL DEFAULT '',
  delay_side   TEXT NOT NULL DEFAULT '',
  delay_notes  TEXT NOT NULL DEFAULT '',
  completed_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_subtasks_milestone ON subtasks(milestone_id);

-- A delay is a negotiation, not a checkbox. Each accept/deny writes a comment
-- carrying the decision, so the thread records who changed their mind and why.
-- item_type/item_id is the delayed milestone or sub-task; milestone_id and
-- project_id are carried on every row so the cascade and the visibility check
-- are one join rather than a walk back up the tree.
CREATE TABLE IF NOT EXISTS delay_comments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_type    TEXT NOT NULL CHECK (item_type IN ('milestone','subtask')),
  item_id      INTEGER NOT NULL,
  milestone_id INTEGER NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  project_id   INTEGER NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,
  author_id    TEXT NOT NULL,
  author_role  TEXT NOT NULL CHECK (author_role IN ('admin','partner')),
  decision     TEXT NOT NULL DEFAULT ''
               CHECK (decision IN ('','accepted','denied')),
  body         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delay_comments_item ON delay_comments(item_type, item_id);
CREATE INDEX IF NOT EXISTS idx_delay_comments_project ON delay_comments(project_id);

-- filename is what the user called it and is only ever echoed back as text.
-- stored_name is what is actually on disk: a UUID, so nothing user-controlled
-- reaches the filesystem.
CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id  INTEGER NOT NULL REFERENCES delay_comments(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_comment ON attachments(comment_id);

-- Outbox. A state change writes its intent to notify here, inside the same
-- transaction; a worker delivers it afterwards. dedupe_key is UNIQUE so a
-- retry, a double-click or a crash mid-send cannot produce a second email.
CREATE TABLE IF NOT EXISTS emails (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event           TEXT NOT NULL,
  dedupe_key      TEXT NOT NULL UNIQUE,
  to_email        TEXT NOT NULL,
  to_name         TEXT NOT NULL DEFAULT '',
  subject         TEXT NOT NULL,
  text_body       TEXT NOT NULL,
  html_body       TEXT NOT NULL DEFAULT '',
  project_id      INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  milestone_id    INTEGER REFERENCES milestones(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','sent','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT NOT NULL DEFAULT '',
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  sent_at         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_emails_pending ON emails(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  category   TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  actor_id   TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_role TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at DESC);
`);

// ---------------------------------------------------------------
// Migrations
//
// CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
// new columns on existing tables need an explicit ALTER.
// ---------------------------------------------------------------
function addColumnIfMissing(table, column, definition) {
  var columns = db.pragma('table_info(' + table + ')').map(function (c) { return c.name; });
  if (columns.indexOf(column) > -1) return false;
  db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition);
  console.log('Migrated: ' + table + '.' + column + ' added');
  return true;
}

function hasColumn(table, column) {
  return db.pragma('table_info(' + table + ')').some(function (c) { return c.name === column; });
}

// Who asked for approval. The table recorded submitted_at but not the person,
// so "tell the requester it was approved" was previously unanswerable.
addColumnIfMissing('milestones', 'submitted_by', "TEXT NOT NULL DEFAULT ''");

// Milestones get the same three negotiated date pairs projects already carry,
// so there is somewhere to record that dates were agreed rather than imposed.
['company', 'partner', 'approved'].forEach(function (kind) {
  addColumnIfMissing('milestones', kind + '_start', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing('milestones', kind + '_end', "TEXT NOT NULL DEFAULT ''");
});

// The single pair that existed was the company's own plan — move it there and
// retire the old columns. SQLite 3.35+ supports DROP COLUMN; this build is 3.53.
if (hasColumn('milestones', 'start_date')) {
  db.transaction(function () {
    db.exec(`UPDATE milestones
             SET company_start = start_date, company_end = end_date
             WHERE company_start = '' AND company_end = ''`);
    db.exec('ALTER TABLE milestones DROP COLUMN start_date');
    db.exec('ALTER TABLE milestones DROP COLUMN end_date');
  })();
  console.log('Migrated: milestone start_date/end_date → company_start/company_end');
}

// The delay decision. This started as a boolean "the partner agreed", captured
// at approval time. It is now three-state and persisted on its own, because a
// partner has to be able to *deny* a delay, say why, and come back to it later.
//
// A milestone can be Delayed in its own right, not only its sub-tasks, so both
// tables carry the same three columns.
['milestones', 'subtasks'].forEach(function (table) {
  addColumnIfMissing(table, 'delay_status',
    "TEXT NOT NULL DEFAULT 'pending' CHECK (delay_status IN ('pending','accepted','denied'))");
  addColumnIfMissing(table, 'delay_decided_by', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(table, 'delay_decided_at', "TEXT NOT NULL DEFAULT ''");

  // Carry the old boolean across, then retire it. Everything that was agreed
  // becomes 'accepted'; everything else is 'pending' by column default.
  if (hasColumn(table, 'delay_agreed')) {
    db.transaction(function () {
      db.exec(`UPDATE ${table}
               SET delay_status = 'accepted',
                   delay_decided_by = delay_agreed_by,
                   delay_decided_at = delay_agreed_at
               WHERE delay_agreed = 1`);
      db.exec('ALTER TABLE ' + table + ' DROP COLUMN delay_agreed');
      db.exec('ALTER TABLE ' + table + ' DROP COLUMN delay_agreed_by');
      db.exec('ALTER TABLE ' + table + ' DROP COLUMN delay_agreed_at');
    })();
    console.log('Migrated: ' + table + '.delay_agreed → delay_status');
  }
});

// ---------------------------------------------------------------
// Passwords — scrypt with a per-user salt
// ---------------------------------------------------------------
function hashPassword(password, salt) {
  var useSalt = salt || crypto.randomBytes(16).toString('hex');
  return { salt: useSalt, hash: crypto.scryptSync(password, useSalt, 64).toString('hex') };
}

function passwordMatches(password, user) {
  var candidate = crypto.scryptSync(password, user.salt, 64);
  var stored = Buffer.from(user.hash, 'hex');
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

// ---------------------------------------------------------------
// Seed — runs once, when the database is empty
// ---------------------------------------------------------------
var SEED_PEOPLE = [
  { id: 'c1', name: 'Abishek',       job_title: 'Product Manager',                 email: 'abishek.m@makoitlab.com',    kind: 'company' },
  { id: 'c2', name: 'Priya Nair',    job_title: 'Tech Lead',                       email: 'priya@example.com',          kind: 'company' },
  { id: 'c3', name: 'Sam Rivera',    job_title: 'UX Designer',                     email: 'sam@example.com',            kind: 'company' },
  { id: 'c4', name: 'Jamie Lee',     job_title: 'QA Engineer',                     email: 'jamie@example.com',          kind: 'company' },
  { id: 'c5', name: 'Riya Shah',     job_title: 'Developer',                       email: 'riya@example.com',           kind: 'company' },
  { id: 'c6', name: 'Arun Kumar',    job_title: 'Data Engineer',                   email: 'arun@example.com',           kind: 'company' },
  { id: 'p1', name: 'Bhavesh',       job_title: 'Partner Program Manager',         email: 'bhavesh.s@makoitlab.com',    kind: 'partner' }
];

// Only these people get a login. Company resources are directory-only by design.
var SEED_ACCOUNTS = [
  { id: 'c1', role: 'admin',   password: 'Mako@123' },
  { id: 'p1', role: 'partner', password: 'Partner@123' }
];

var SEED_PROJECTS = [
  {
    code: 'PRJ-001', title: 'Apollo', description: 'Partner onboarding portal revamp.',
    type: 'Custom Application', status: 'In-Progress',
    partner_start: '2026-07-01', partner_end: '2026-09-12',
    company_start: '2026-07-08', company_end: '2026-09-30',
    approved_start: '2026-07-06', approved_end: '2026-09-25',
    resources: ['c1', 'c2', 'c3'], pocs: ['p1'],
    milestones: [
      { title: 'Discovery & requirements', start_date: '2026-07-01', end_date: '2026-07-20',
        subtasks: ['Stakeholder interviews', 'Requirements sign-off'] },
      { title: 'Build & integration', start_date: '2026-07-21', end_date: '2026-09-05',
        subtasks: ['API integration', 'UI implementation'] }
    ]
  },
  {
    code: 'PRJ-002', title: 'Beacon', description: 'Real-time alerting for the ops team.',
    type: 'Integration', status: 'In-Progress',
    partner_start: '2026-06-15', partner_end: '2026-09-30',
    company_start: '2026-06-20', company_end: '2026-10-10',
    approved_start: '2026-06-18', approved_end: '2026-10-02',
    resources: ['c2', 'c5'], pocs: ['p1'],
    milestones: [{ title: 'Alerting engine', start_date: '2026-06-20', end_date: '2026-08-30', subtasks: [] }]
  },
  {
    code: 'PRJ-003', title: 'Cobalt', description: 'Data warehouse migration.',
    type: 'Migration', status: 'Not Started',
    partner_start: '2026-08-01', partner_end: '2026-10-05',
    company_start: '2026-08-05', company_end: '2026-10-20',
    approved_start: '', approved_end: '',
    resources: ['c6'], pocs: ['p1'], milestones: []
  },
  {
    code: 'PRJ-004', title: 'Delta', description: 'Mobile app accessibility audit.',
    type: 'Custom Application', status: 'Completed',
    partner_start: '2026-05-02', partner_end: '2026-08-18',
    company_start: '2026-05-10', company_end: '2026-08-25',
    approved_start: '2026-05-11', approved_end: '2026-08-21',
    resources: ['c3', 'c4'], pocs: ['p1'], milestones: []
  }
];

function seed() {
  var now = new Date().toISOString();

  var insertPerson = db.prepare(
    'INSERT INTO people (id, name, job_title, email, kind) VALUES (@id, @name, @job_title, @email, @kind)');
  SEED_PEOPLE.forEach(function (p) { insertPerson.run(p); });

  var insertUser = db.prepare(
    'INSERT INTO users (id, name, email, role, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  SEED_ACCOUNTS.forEach(function (account) {
    var person = SEED_PEOPLE.filter(function (p) { return p.id === account.id; })[0];
    var creds = hashPassword(account.password);
    insertUser.run(person.id, person.name, person.email, account.role, creds.salt, creds.hash, now);
  });

  var insertProject = db.prepare(`INSERT INTO projects
    (code, title, description, type, status, partner_start, partner_end,
     company_start, company_end, approved_start, approved_end, created_at, updated_at)
    VALUES (@code, @title, @description, @type, @status, @partner_start, @partner_end,
            @company_start, @company_end, @approved_start, @approved_end, @created_at, @updated_at)`);
  var linkResource = db.prepare('INSERT INTO project_resources (project_id, person_id) VALUES (?, ?)');
  var linkPoc = db.prepare('INSERT INTO project_pocs (project_id, person_id) VALUES (?, ?)');
  var insertMilestone = db.prepare(`INSERT INTO milestones
    (project_id, title, company_start, company_end, approved_start, approved_end, position)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  var insertSubtask = db.prepare(
    'INSERT INTO subtasks (milestone_id, title, position) VALUES (?, ?, ?)');

  SEED_PROJECTS.forEach(function (p) {
    var row = Object.assign({}, p, { created_at: now, updated_at: now });
    delete row.resources; delete row.pocs; delete row.milestones;
    var projectId = insertProject.run(row).lastInsertRowid;

    p.resources.forEach(function (id) { linkResource.run(projectId, id); });
    p.pocs.forEach(function (id) { linkPoc.run(projectId, id); });
    p.milestones.forEach(function (m, i) {
      // Seeded milestones have company dates agreed as-is, so approved matches
      var milestoneId = insertMilestone.run(projectId, m.title,
        m.start_date, m.end_date, m.start_date, m.end_date, i).lastInsertRowid;
      m.subtasks.forEach(function (title, j) { insertSubtask.run(milestoneId, title, j); });
    });
  });

  console.log('Seeded ' + SEED_PEOPLE.length + ' people, ' + SEED_ACCOUNTS.length +
    ' accounts and ' + SEED_PROJECTS.length + ' projects');
}

if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  db.transaction(seed)();
}

module.exports = {
  db: db,
  file: DB_FILE,
  hashPassword: hashPassword,
  passwordMatches: passwordMatches
};
