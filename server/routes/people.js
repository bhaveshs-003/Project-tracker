/**
 * The directory, and the accounts that go with it.
 *
 * Company resources are directory records only — they have no auth user, so
 * they cannot sign in. Partner POCs get both. Supabase Auth owns the
 * credential, so "both" now spans two systems, and the order matters: the auth
 * user is created first and deleted again if the directory row fails, because
 * an orphan login is worse than an orphan row.
 */

var express = require('express');
var sql = require('../sql');
var guards = require('../guards');
var supabase = require('../supabase');
var serialise = require('../serialise');
var audit = require('../audit');
var v = require('../validate');

var router = express.Router();
var asyncHandler = v.asyncHandler;

var MIN_PASSWORD = Number(process.env.MIN_PASSWORD_LENGTH || 10);

// Everyone signed in can read the directory — it is needed to render names
// against assignments and @mentions.
router.get('/', guards.requireAuth, asyncHandler(async function (req, res) {
  var rows = await sql.many('SELECT * FROM people ORDER BY kind, name');
  res.json(rows.map(serialise.person));
}));

// Everything below is admin-only
router.use(guards.requireAuth, guards.requireRole('admin'));

var personInput = v.z.object({
  kind: v.z.enum(['company', 'partner']).default('company'),
  name: v.text('Name', 120),
  jobTitle: v.text('Job title', 120),
  email: v.z.string().trim().toLowerCase().max(320).optional().default(''),
  password: v.z.string().max(200).optional().default('')
});

function conflict(res, message) {
  return res.status(409).json({ error: message });
}

router.post('/', asyncHandler(async function (req, res) {
  var input = v.body(personInput, req);

  if (input.kind === 'partner') {
    if (!input.email) return res.status(400).json({ error: 'Email is required for a Partner POC.' });
    if (!/^\S+@\S+\.\S+$/.test(input.email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (input.password.length < MIN_PASSWORD) {
      return res.status(400).json({
        error: 'Set a password of at least ' + MIN_PASSWORD + ' characters.'
      });
    }
  }

  if (input.email && await sql.exists('SELECT 1 FROM people WHERE email = $1', [input.email])) {
    return conflict(res, 'That email is already registered.');
  }

  var authUserId = null;
  if (input.kind === 'partner') {
    var created = await supabase.admin.auth.admin.createUser({
      email: input.email,
      password: input.password,
      email_confirm: true,                      // an admin vouched for them
      app_metadata: { role: 'partner' }
    });
    if (created.error) return conflict(res, created.error.message);
    authUserId = created.data.user.id;
  }

  var person;
  try {
    person = await sql.one(
      `INSERT INTO people (user_id, name, job_title, email, kind, role)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [authUserId, input.name, input.jobTitle, input.email || null, input.kind,
        input.kind === 'partner' ? 'partner' : null]);
  } catch (err) {
    // Roll the auth user back by hand — it lives in a different system, so no
    // transaction covers it, and leaving it would block the email forever.
    if (authUserId) {
      try { await supabase.admin.auth.admin.deleteUser(authUserId); } catch { /* logged below */ }
    }
    throw err;
  }

  await audit.record(req.user, 'User', 'Created', input.name,
    (input.kind === 'partner' ? 'Partner POC' : 'Company resource') + ' · ' + input.jobTitle, null);

  res.status(201).json(serialise.person(person));
}));

router.patch('/:id', asyncHandler(async function (req, res) {
  var person = await sql.one('SELECT * FROM people WHERE id = $1',
    [v.uuid.safeParse(req.params.id).success ? req.params.id : null]);
  if (!person) return res.status(404).json({ error: 'No such person' });

  var input = v.body(v.z.object({
    name: v.text('Name', 120).optional(),
    jobTitle: v.text('Job title', 120).optional(),
    email: v.z.string().trim().toLowerCase().max(320).optional(),
    password: v.z.string().max(200).optional().default('')
  }), req);

  var name = input.name !== undefined ? input.name : person.name;
  var jobTitle = input.jobTitle !== undefined ? input.jobTitle : person.job_title;
  var email = input.email !== undefined ? input.email : (person.email || '');

  if (person.user_id) {
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (input.password && input.password.length < MIN_PASSWORD) {
      return res.status(400).json({
        error: 'The new password must be at least ' + MIN_PASSWORD + ' characters.'
      });
    }
  }

  if (email && await sql.exists('SELECT 1 FROM people WHERE email = $1 AND id <> $2',
    [email, person.id])) {
    return conflict(res, 'That email is already registered.');
  }

  // Supabase first: if it rejects the change, nothing local has moved yet.
  if (person.user_id) {
    var patch = { email: email };
    if (input.password) patch.password = input.password;
    var updated = await supabase.admin.auth.admin.updateUserById(person.user_id, patch);
    if (updated.error) return conflict(res, updated.error.message);
  }

  var saved = await sql.one(
    'UPDATE people SET name = $1, job_title = $2, email = $3 WHERE id = $4 RETURNING *',
    [name, jobTitle, email || null, person.id]);

  await audit.record(req.user, 'User', 'Updated', name,
    (person.user_id ? 'Partner POC' : 'Company resource') + ' · ' + jobTitle +
    (input.password ? ' · password changed' : ''), null);

  res.json(serialise.person(saved));
}));

router.delete('/:id', asyncHandler(async function (req, res) {
  var person = await sql.one('SELECT * FROM people WHERE id = $1',
    [v.uuid.safeParse(req.params.id).success ? req.params.id : null]);
  if (!person) return res.status(404).json({ error: 'No such person' });

  if (person.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete the account you are signed in with.' });
  }

  var assigned = Number(await sql.value(
    `SELECT count(DISTINCT project_id) FROM (
       SELECT project_id FROM project_resources WHERE person_id = $1
       UNION ALL
       SELECT project_id FROM project_pocs      WHERE person_id = $1) AS t`, [person.id]));

  // Delete the login first. If the directory row then fails, the account is
  // already unable to sign in, which is the safe direction to fail in.
  if (person.user_id) {
    var removed = await supabase.admin.auth.admin.deleteUser(person.user_id);
    if (removed.error && removed.error.status !== 404) {
      return res.status(502).json({ error: 'Could not remove the login: ' + removed.error.message });
    }
  }

  // Cascades to project_resources, project_pocs and milestone_mentions
  await sql.run('DELETE FROM people WHERE id = $1', [person.id]);

  await audit.record(req.user, 'User', 'Deleted', person.name,
    person.job_title + (assigned ? ' · unassigned from ' + assigned +
      ' project' + (assigned === 1 ? '' : 's') : ''), null);

  res.json({ ok: true, unassignedFrom: assigned });
}));

module.exports = router;
