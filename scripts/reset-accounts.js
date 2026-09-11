/**
 * Bring an existing database in line with the account set in server/db.js.
 *
 *   node scripts/reset-accounts.js
 *
 * A fresh database gets these accounts from the seed. This script exists for a
 * database that already has data: it rewrites the admin, installs the single
 * Partner POC, removes every other partner, and hands their project
 * assignments over — so no project is left without someone to approve its
 * milestones.
 *
 * Idempotent: running it twice changes nothing the second time.
 */

var store = require('../server/db');
var db = store.db;

var ADMIN = {
  id: 'c1',
  name: 'Abishek',
  jobTitle: 'Product Manager',
  email: 'abishek.m@makoitlab.com',
  password: 'Mako@123'
};

var PARTNER = {
  id: 'p1',
  name: 'Bhavesh',
  jobTitle: 'Partner Program Manager',
  email: 'bhavesh.s@makoitlab.com',
  password: 'Partner@123'
};

function upsertPerson(person, kind) {
  var existing = db.prepare('SELECT id FROM people WHERE id = ?').get(person.id);
  if (existing) {
    db.prepare('UPDATE people SET name = ?, job_title = ?, email = ?, kind = ? WHERE id = ?')
      .run(person.name, person.jobTitle, person.email, kind, person.id);
  } else {
    db.prepare('INSERT INTO people (id, name, job_title, email, kind) VALUES (?, ?, ?, ?, ?)')
      .run(person.id, person.name, person.jobTitle, person.email, kind);
  }
}

function upsertAccount(person, role) {
  var creds = store.hashPassword(person.password);
  var existing = db.prepare('SELECT id FROM users WHERE id = ?').get(person.id);
  if (existing) {
    db.prepare('UPDATE users SET name = ?, email = ?, role = ?, salt = ?, hash = ? WHERE id = ?')
      .run(person.name, person.email, role, creds.salt, creds.hash, person.id);
  } else {
    db.prepare(`INSERT INTO users (id, name, email, role, salt, hash, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(person.id, person.name, person.email, role, creds.salt, creds.hash,
        new Date().toISOString());
  }
}

var summary = db.transaction(function () {
  upsertPerson(ADMIN, 'company');
  upsertAccount(ADMIN, 'admin');

  upsertPerson(PARTNER, 'partner');
  upsertAccount(PARTNER, 'partner');

  // Every other partner goes. Hand their POC seats to the one that remains
  // first, so no project is left unable to have a milestone approved.
  var doomed = db.prepare("SELECT id, name FROM people WHERE kind = 'partner' AND id != ?")
    .all(PARTNER.id);

  var reassigned = 0;
  doomed.forEach(function (person) {
    var seats = db.prepare('SELECT project_id FROM project_pocs WHERE person_id = ?').all(person.id);
    seats.forEach(function (seat) {
      var already = db.prepare('SELECT 1 FROM project_pocs WHERE project_id = ? AND person_id = ?')
        .get(seat.project_id, PARTNER.id);
      if (!already) {
        db.prepare('INSERT INTO project_pocs (project_id, person_id) VALUES (?, ?)')
          .run(seat.project_id, PARTNER.id);
        reassigned++;
      }
    });

    // users cascades to sessions; people cascades to the join tables
    db.prepare('DELETE FROM users WHERE id = ?').run(person.id);
    db.prepare('DELETE FROM people WHERE id = ?').run(person.id);
  });

  return { removed: doomed.map(function (p) { return p.name; }), reassigned: reassigned };
})();

console.log('Admin   : ' + ADMIN.name + ' <' + ADMIN.email + '>');
console.log('Partner : ' + PARTNER.name + ' <' + PARTNER.email + '>');
console.log('Removed : ' + (summary.removed.length ? summary.removed.join(', ') : 'none'));
console.log('POC seats handed to ' + PARTNER.name + ': ' + summary.reassigned);

var pocs = db.prepare(`SELECT p.code, pe.name FROM project_pocs j
  JOIN projects p ON p.id = j.project_id
  JOIN people pe ON pe.id = j.person_id ORDER BY p.code`).all();
console.log('\nPOC per project:');
pocs.forEach(function (r) { console.log('  ' + r.code + ' → ' + r.name); });

var orphaned = db.prepare(`SELECT code FROM projects
  WHERE id NOT IN (SELECT project_id FROM project_pocs)`).all();
if (orphaned.length) {
  console.log('\nWARNING — no POC, so milestones cannot be submitted for approval: ' +
    orphaned.map(function (p) { return p.code; }).join(', '));
}
