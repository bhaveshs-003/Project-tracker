/**
 * The directory, and the accounts that go with it.
 *
 * Company resources are directory records only — they never get a row in
 * users, so they cannot sign in. Partner POCs get both, created together in
 * one transaction so a person can never exist without their login or vice versa.
 */

var express = require('express');
var db = require('../db').db;
var guards = require('../guards');
var scope = require('../scope');
var serialise = require('../serialise');
var audit = require('../audit');

var router = express.Router();

// Everyone signed in can read the directory — it is needed to render names
// against assignments and @mentions.
router.get('/', guards.requireAuth, function (req, res) {
  var rows = db.prepare('SELECT * FROM people ORDER BY kind, name').all();
  res.json(rows.map(serialise.person));
});

// Everything below is admin-only
router.use(guards.requireAuth, guards.requireRole('admin'));

function nextPersonId(prefix) {
  var rows = db.prepare("SELECT id FROM people WHERE id LIKE ?").all(prefix + '%');
  var max = rows.reduce(function (top, r) {
    return Math.max(top, parseInt(r.id.slice(1), 10) || 0);
  }, 0);
  return prefix + (max + 1);
}

router.post('/', function (req, res, next) {
  try {
    var body = req.body || {};
    var kind = body.kind === 'partner' ? 'partner' : 'company';
    var name = String(body.name || '').trim();
    var jobTitle = String(body.jobTitle || '').trim();

    if (!name) return res.status(400).json({ error: 'Name is required.' });
    if (!jobTitle) return res.status(400).json({ error: 'Job title is required.' });

    var email = String(body.email || '').trim();
    var password = String(body.password || '');

    if (kind === 'partner') {
      if (!email) return res.status(400).json({ error: 'Email is required for a Partner POC.' });
      if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
      if (password.length < 6) return res.status(400).json({ error: 'Set a password of at least 6 characters.' });
      if (guards.findUserByEmail(email)) {
        return res.status(409).json({ error: 'That email is already registered.' });
      }
    }

    var id = nextPersonId(kind === 'partner' ? 'p' : 'c');

    db.transaction(function () {
      db.prepare('INSERT INTO people (id, name, job_title, email, kind) VALUES (?, ?, ?, ?, ?)')
        .run(id, name, jobTitle, email, kind);

      if (kind === 'partner') {
        var creds = guards.hashPassword(password);
        db.prepare(`INSERT INTO users (id, name, email, role, salt, hash, created_at)
                    VALUES (?, ?, ?, 'partner', ?, ?, ?)`)
          .run(id, name, email, creds.salt, creds.hash, new Date().toISOString());
      }
    })();

    audit.record(req.user, 'User', 'Created', name,
      (kind === 'partner' ? 'Partner POC' : 'Company resource') + ' · ' + jobTitle);

    res.status(201).json(serialise.person(db.prepare('SELECT * FROM people WHERE id = ?').get(id)));
  } catch (e) { next(e); }
});

router.patch('/:id', function (req, res, next) {
  try {
    var person = db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
    if (!person) return res.status(404).json({ error: 'No such person' });

    var body = req.body || {};
    var name = body.name !== undefined ? String(body.name).trim() : person.name;
    var jobTitle = body.jobTitle !== undefined ? String(body.jobTitle).trim() : person.job_title;
    var email = body.email !== undefined ? String(body.email).trim() : person.email;
    var password = String(body.password || '');

    if (!name) return res.status(400).json({ error: 'Name is required.' });
    if (!jobTitle) return res.status(400).json({ error: 'Job title is required.' });

    if (person.kind === 'partner') {
      if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
      var clash = guards.findUserByEmail(email);
      if (clash && clash.id !== person.id) {
        return res.status(409).json({ error: 'That email is already registered.' });
      }
      if (password && password.length < 6) {
        return res.status(400).json({ error: 'The new password must be at least 6 characters.' });
      }
    }

    db.transaction(function () {
      db.prepare('UPDATE people SET name = ?, job_title = ?, email = ? WHERE id = ?')
        .run(name, jobTitle, email, person.id);

      if (person.kind === 'partner') {
        db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(name, email, person.id);
        if (password) {
          var creds = guards.hashPassword(password);
          db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?')
            .run(creds.salt, creds.hash, person.id);
        }
      }
    })();

    audit.record(req.user, 'User', 'Updated', name,
      (person.kind === 'partner' ? 'Partner POC' : 'Company resource') + ' · ' + jobTitle +
      (password ? ' · password changed' : ''));

    res.json(serialise.person(db.prepare('SELECT * FROM people WHERE id = ?').get(person.id)));
  } catch (e) { next(e); }
});

router.delete('/:id', function (req, res, next) {
  try {
    var person = db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
    if (!person) return res.status(404).json({ error: 'No such person' });

    if (person.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot delete the account you are signed in with.' });
    }

    var assigned = db.prepare(`SELECT COUNT(DISTINCT project_id) AS n FROM (
      SELECT project_id FROM project_resources WHERE person_id = @id
      UNION ALL
      SELECT project_id FROM project_pocs      WHERE person_id = @id)`).get({ id: person.id }).n;

    // people cascades to project_resources / project_pocs / milestone_mentions,
    // and users cascades to sessions, so a deleted user is signed out everywhere.
    db.transaction(function () {
      db.prepare('DELETE FROM users WHERE id = ?').run(person.id);
      db.prepare('DELETE FROM people WHERE id = ?').run(person.id);
    })();

    audit.record(req.user, 'User', 'Deleted', person.name,
      person.job_title + (assigned ? ' · unassigned from ' + assigned +
        ' project' + (assigned === 1 ? '' : 's') : ''));

    res.json({ ok: true, unassignedFrom: assigned });
  } catch (e) { next(e); }
});

module.exports = router;
