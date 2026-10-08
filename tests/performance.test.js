/**
 * The N+1 regression test.
 *
 *   node tests/performance.test.js
 *
 * serialise.js used to issue a query per project, per milestone, per sub-task
 * and per comment. On in-process SQLite that cost microseconds and was never
 * noticed; across a network it is the difference between a page loading and a
 * page timing out.
 *
 * This counts the queries actually sent, for a realistic amount of data, and
 * fails if the count starts growing with the row count again. A time budget
 * alone would not catch it — on a local socket even 4,500 queries finish fast
 * enough to look acceptable.
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

var PROJECTS = 100;
var MILESTONES = 6;
var SUBTASKS = 4;

(async function () {
  harness.resetDatabase();
  var supabase = harness.install();

  var sql = require('../server/sql');
  var serialise = require('../server/serialise');

  // ---------------------------------------------------------------
  console.log('\n--- seeding ' + PROJECTS + ' x ' + MILESTONES + ' x ' + SUBTASKS + ' ---');
  var admin = await harness.createAccount(sql, supabase, {
    email: 'perf-admin@example.test', password: 'AdminPassword1', name: 'Perf Admin', role: 'admin'
  });
  var poc = await harness.createAccount(sql, supabase, {
    email: 'perf-poc@example.test', password: 'PartnerPassword1', name: 'Perf POC', role: 'partner'
  });

  var seedStarted = Date.now();
  await sql.tx(async function (t) {
    for (var p = 1; p <= PROJECTS; p++) {
      /* eslint-disable no-await-in-loop */
      var project = await t.one(
        `INSERT INTO projects (code, title, type, status, company_start, company_end)
         VALUES ($1,$2,'Migration','In-Progress','2026-01-01','2026-06-30') RETURNING id`,
        ['PERF-' + String(p).padStart(4, '0'), 'Perf project ' + p]);

      await t.run('INSERT INTO project_resources (project_id, person_id) VALUES ($1,$2)',
        [project.id, admin.id]);
      await t.run('INSERT INTO project_pocs (project_id, person_id) VALUES ($1,$2)',
        [project.id, poc.id]);

      for (var m = 0; m < MILESTONES; m++) {
        var milestone = await t.one(
          `INSERT INTO milestones (project_id, title, position, completed, outcome,
             delay_side, delay_notes, completed_at, approval)
           VALUES ($1,$2,$3,true,'Delayed','Company Side','Slipped.',current_date,'pending')
           RETURNING id`, [project.id, 'Milestone ' + m, m]);

        // A comment thread on the milestone, so the thread loader is exercised
        await t.run(
          `INSERT INTO delay_comments (item_type, item_id, milestone_id, project_id,
             author_id, author_role, decision, body)
           VALUES ('milestone',$1,$1,$2,$3,'partner','denied','Not acceptable.')`,
          [milestone.id, project.id, poc.id]);

        for (var s = 0; s < SUBTASKS; s++) {
          await t.run(
            `INSERT INTO subtasks (milestone_id, title, position, completed, outcome,
               delay_side, delay_notes, completed_at)
             VALUES ($1,$2,$3,true,'Delayed','Company Side','Slipped.',current_date)`,
            [milestone.id, 'Sub-task ' + s, s]);
        }
      }
    }
  });

  var rows = PROJECTS * MILESTONES * (1 + SUBTASKS);
  console.log('  seeded ' + PROJECTS + ' projects, ' + (PROJECTS * MILESTONES) + ' milestones, ' +
    (PROJECTS * MILESTONES * SUBTASKS) + ' sub-tasks, ' + (PROJECTS * MILESTONES) +
    ' comments in ' + ((Date.now() - seedStarted) / 1000).toFixed(1) + 's');

  // ---------------------------------------------------------------
  console.log('\n--- counting queries for one GET /api/projects ---');

  // Count at the pool, so anything the code sends is seen — including queries
  // a future refactor might add without noticing.
  var queries = 0;
  var realQuery = sql.pool.query.bind(sql.pool);
  sql.pool.query = function () { queries++; return realQuery.apply(null, arguments); };

  var started = Date.now();
  var projectRows = await sql.many('SELECT * FROM projects ORDER BY code');
  var hydrated = await serialise.hydrateProjects(projectRows, { id: admin.id, role: 'admin' });
  var elapsed = Date.now() - started;

  sql.pool.query = realQuery;

  console.log('  ' + queries + ' queries, ' + elapsed + 'ms, ' +
    hydrated.length + ' projects hydrated');

  check('every project came back', hydrated.length === PROJECTS, String(hydrated.length));
  check('  fully nested', hydrated[0].milestones.length === MILESTONES &&
    hydrated[0].milestones[0].subtasks.length === SUBTASKS,
    hydrated[0].milestones.length + ' milestones, ' +
    (hydrated[0].milestones[0] || {}).subtasks?.length + ' sub-tasks');
  check('  with the delay threads attached',
    hydrated[0].milestones[0].delayComments.length === 1,
    String(hydrated[0].milestones[0].delayComments.length));

  // The old shape would be 1 + 3P + 3PM + PMS = 4,501 here.
  var OLD_SHAPE = 1 + 3 * PROJECTS + 3 * PROJECTS * MILESTONES + PROJECTS * MILESTONES * SUBTASKS;
  check('query count is constant, not per-row (<= 10)', queries <= 10,
    queries + ' queries; the per-row shape would have been ' + OLD_SHAPE);
  check('  which is ' + Math.round(OLD_SHAPE / queries) + 'x fewer than before', queries < 50);
  check('hydration is under 500ms', elapsed < 500, elapsed + 'ms');

  // ---------------------------------------------------------------
  console.log('\n--- scoped read, as the partner ---');
  queries = 0;
  sql.pool.query = function () { queries++; return realQuery.apply(null, arguments); };
  var scoped = await serialise.hydrateProjects(
    await sql.many(
      `SELECT p.* FROM projects p
        WHERE p.id IN (SELECT project_id FROM project_pocs WHERE person_id = $1)
        ORDER BY p.code LIMIT 50`, [poc.id]),
    { id: poc.id, role: 'partner' });
  sql.pool.query = realQuery;

  check('the partner read is bounded too', queries <= 10, queries + ' queries');
  check('  feedback withheld from the partner',
    scoped.every(function (p) {
      return p.milestones.every(function (m) { return m.feedback === null; });
    }));
  check('  and the mentions query is skipped for them', queries <= 8, queries + ' queries');

  // ---------------------------------------------------------------
  console.log('\n--- single milestone read ---');
  queries = 0;
  sql.pool.query = function () { queries++; return realQuery.apply(null, arguments); };
  var one = await sql.one('SELECT * FROM milestones LIMIT 1');
  await serialise.milestone(one, { id: admin.id, role: 'admin' });
  sql.pool.query = realQuery;
  check('one milestone costs a handful of queries', queries <= 6, queries + ' queries');

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
