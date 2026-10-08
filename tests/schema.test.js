/**
 * Schema guard.
 *
 *   node tests/schema.test.js
 *
 * Asserts the shape the application code assumes: the tables it queries, the
 * constraints it relies on instead of re-checking, the indexes that keep the
 * scoped reads cheap, and the two tables that were deliberately dropped.
 *
 * This is the test that catches a migration edited without the code, or code
 * written against a column that no longer exists.
 */

var harness = require('./harness');

var pass = 0, fail = 0;
var failures = [];

function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else {
    fail++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  FAIL  ' + name + (detail ? '  ' + detail : ''));
  }
}

var TABLES = [
  'people', 'projects', 'project_resources', 'project_pocs',
  'milestones', 'subtasks', 'milestone_mentions',
  'delay_comments', 'attachments', 'pending_uploads',
  'emails', 'audit', 'auth_attempts'
];

// Dropped in the move to Supabase Auth; their presence would mean the old
// credential handling had crept back.
var MUST_NOT_EXIST = ['users', 'sessions'];

var INDEXES = [
  ['project_pocs', 'project_pocs_person_idx'],       // every partner request
  ['milestones', 'milestones_project_idx'],
  ['subtasks', 'subtasks_milestone_idx'],
  ['delay_comments', 'delay_comments_item_idx'],
  ['delay_comments', 'delay_comments_milestone_idx'],
  ['attachments', 'attachments_comment_idx'],
  ['emails', 'emails_pending_idx'],
  ['audit', 'audit_at_idx'],
  ['auth_attempts', 'auth_attempts_lookup_idx']
];

(async function () {
  harness.resetDatabase();
  harness.install();
  var sql = require('../server/sql');

  console.log('\n--- tables ---');
  var present = (await sql.many(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"))
    .map(function (r) { return r.tablename; });

  TABLES.forEach(function (t) {
    check(t + ' exists', present.indexOf(t) > -1);
  });
  MUST_NOT_EXIST.forEach(function (t) {
    check(t + ' is gone (Supabase Auth owns credentials)', present.indexOf(t) === -1);
  });

  console.log('\n--- dates are real dates, not strings ---');
  var dateCols = await sql.many(`
    SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (column_name LIKE '%_start' OR column_name LIKE '%_end'
            OR column_name IN ('completed_at','submitted_at','approved_at','delay_decided_at'))
     ORDER BY table_name, column_name`);

  var wrongType = dateCols.filter(function (c) { return c.data_type !== 'date'; });
  check('every date column is type `date`', wrongType.length === 0,
    wrongType.map(function (c) { return c.table_name + '.' + c.column_name + '=' + c.data_type; }).join(', '));
  check('  and nullable, so "not set" is NULL rather than an empty string',
    dateCols.every(function (c) { return c.is_nullable === 'YES'; }),
    dateCols.filter(function (c) { return c.is_nullable !== 'YES'; })
      .map(function (c) { return c.table_name + '.' + c.column_name; }).join(', '));

  console.log('\n--- constraints the code relies on ---');
  async function hasCheck(table, name) {
    return sql.exists(
      `SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = $1 AND c.conname = $2 AND c.contype = 'c'`, [table, name]);
  }

  check('a project end date cannot precede its start',
    await hasCheck('projects', 'projects_approved_range'));
  check('nor can a milestone range', await hasCheck('milestones', 'milestones_company_range'));
  check('a delay side only exists on a delayed item',
    await hasCheck('milestones', 'milestones_delay_side_needs_delay'));
  check('delay_status is a closed set',
    await sql.exists(`SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'milestones' AND pg_get_constraintdef(c.oid) LIKE '%delay_status%'`));
  check('anyone who can sign in must have an email',
    await hasCheck('people', 'people_login_needs_email'));

  // Prove the constraints actually bite rather than merely existing
  var rejected = false;
  try {
    await sql.run(`INSERT INTO projects (code,title,type,approved_start,approved_end)
                   VALUES ('BAD-1','Backwards','Migration','2026-06-01','2026-01-01')`);
  } catch { rejected = true; }
  check('  and a backwards range is actually refused', rejected);

  rejected = false;
  try {
    await sql.run(`INSERT INTO subtasks (milestone_id,title,delay_status)
                   VALUES (1,'x','maybe')`);
  } catch { rejected = true; }
  check('  and an unknown delay_status is actually refused', rejected);

  console.log('\n--- unique keys ---');
  check('one project per code',
    await sql.exists(`SELECT 1 FROM pg_indexes WHERE tablename='projects'
       AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%code%'`));
  check('  case-insensitively (citext)',
    (await sql.one("SELECT data_type, udt_name FROM information_schema.columns " +
      "WHERE table_name='projects' AND column_name='code'")).udt_name === 'citext');
  check('one outbox row per dedupe_key',
    await sql.exists(`SELECT 1 FROM pg_indexes WHERE tablename='emails'
       AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%dedupe_key%'`));
  check('one attachment per stored object',
    await sql.exists(`SELECT 1 FROM pg_indexes WHERE tablename='attachments'
       AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%object_path%'`));

  console.log('\n--- indexes ---');
  for (var i = 0; i < INDEXES.length; i++) {
    /* eslint-disable no-await-in-loop */
    check(INDEXES[i][1],
      await sql.exists('SELECT 1 FROM pg_indexes WHERE tablename = $1 AND indexname = $2',
        [INDEXES[i][0], INDEXES[i][1]]));
  }

  console.log('\n--- cascades ---');
  var cascades = await sql.many(`
    SELECT t.relname AS child, c.conname, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE c.contype = 'f' AND pg_get_constraintdef(c.oid) LIKE '%ON DELETE CASCADE%'`);
  var cascading = cascades.map(function (r) { return r.child; });

  ['milestones', 'subtasks', 'delay_comments', 'attachments', 'project_pocs', 'project_resources']
    .forEach(function (t) {
      check(t + ' is removed with its parent', cascading.indexOf(t) > -1);
    });

  console.log('\n--- row level security ---');
  var unprotected = (await sql.many(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = false`))
    .map(function (r) { return r.relname; });
  check('RLS is on for every table', unprotected.length === 0, unprotected.join(', '));

  var policies = Number(await sql.value(
    "SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public'"));
  check('  with no policies granted, so a leaked anon key reads nothing',
    policies === 0, policies + ' policies exist');

  console.log('\n================  ' + pass + ' passed, ' + fail + ' failed  ================');
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(function (f) { console.log('  · ' + f); });
  }

  await sql.close();
  process.exit(fail ? 1 : 0);
})().catch(function (err) {
  console.error('\nHARNESS ERROR:', err.stack || err.message);
  process.exit(2);
});
