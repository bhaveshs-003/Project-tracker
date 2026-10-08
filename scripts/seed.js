/**
 * Seed a Supabase project: the two accounts and some sample work.
 *
 *   node scripts/seed.js
 *   node scripts/seed.js --reset      also removes existing seeded data first
 *
 * Replaces the old seed block in server/db.js and scripts/reset-accounts.js.
 * Two things changed and both matter:
 *
 *   · Credentials come from the environment, never from source. The previous
 *     version had the real passwords inline, which is how they ended up in a
 *     public commit.
 *   · Accounts are created through Supabase Auth, so there is no password
 *     hashing here at all.
 *
 * Idempotent: running it twice changes nothing the second time.
 */

require('../server/env');

var sql = require('../server/sql');
var supabase = require('../server/supabase');

var RESET = process.argv.indexOf('--reset') > -1;

/**
 * Accounts only, by default.
 *
 * A production instance wants two logins and an empty slate — sample projects
 * are easy to add and tedious to explain away later. --with-samples restores
 * the directory people and the three demo projects for a scratch environment.
 */
var WITH_SAMPLES = process.argv.indexOf('--with-samples') > -1;

function env(name, fallback) {
  var value = process.env[name];
  if (value) return value;
  if (fallback !== undefined) return fallback;
  console.error('\n  ' + name + ' is not set. See .env.example.\n');
  process.exit(1);
}

var MIN_PASSWORD = Number(process.env.MIN_PASSWORD_LENGTH || 10);

var ADMIN = {
  name: env('SEED_ADMIN_NAME', 'Admin'),
  email: String(env('SEED_ADMIN_EMAIL')).toLowerCase(),
  password: env('SEED_ADMIN_PASSWORD'),
  jobTitle: env('SEED_ADMIN_JOB_TITLE', 'Product Manager')
};

var PARTNER = {
  name: env('SEED_PARTNER_NAME', 'Partner POC'),
  email: String(env('SEED_PARTNER_EMAIL')).toLowerCase(),
  password: env('SEED_PARTNER_PASSWORD'),
  jobTitle: env('SEED_PARTNER_JOB_TITLE', 'Partner Program Manager')
};

[ADMIN, PARTNER].forEach(function (account) {
  if (account.password.length < MIN_PASSWORD) {
    console.error('\n  The seed password for ' + account.email + ' is shorter than the ' +
      MIN_PASSWORD + '-character minimum.\n');
    process.exit(1);
  }
});

// Directory-only people: no login, by design.
var RESOURCES = [
  { name: 'Priya Nair', jobTitle: 'Tech Lead' },
  { name: 'Sam Rivera', jobTitle: 'UX Designer' },
  { name: 'Jamie Lee', jobTitle: 'QA Engineer' },
  { name: 'Riya Shah', jobTitle: 'Developer' },
  { name: 'Arun Kumar', jobTitle: 'Data Engineer' }
];

var PROJECTS = [
  {
    code: 'PRJ-001', title: 'Apollo', description: 'Partner onboarding portal revamp.',
    type: 'Custom Application', status: 'In-Progress',
    partner: ['2026-07-01', '2026-09-12'],
    company: ['2026-07-08', '2026-09-30'],
    approved: ['2026-07-06', '2026-09-25'],
    milestones: [
      { title: 'Discovery & requirements', start: '2026-07-01', end: '2026-07-20',
        subtasks: ['Stakeholder interviews', 'Requirements sign-off'] },
      { title: 'Build & integration', start: '2026-07-21', end: '2026-09-05',
        subtasks: ['API integration', 'UI implementation'] }
    ]
  },
  {
    code: 'PRJ-002', title: 'Beacon', description: 'Real-time alerting for the ops team.',
    type: 'Integration', status: 'In-Progress',
    partner: ['2026-06-15', '2026-09-30'],
    company: ['2026-06-20', '2026-10-10'],
    approved: ['2026-06-18', '2026-10-02'],
    milestones: [{ title: 'Alerting engine', start: '2026-06-20', end: '2026-08-30', subtasks: [] }]
  },
  {
    code: 'PRJ-003', title: 'Cobalt', description: 'Data warehouse migration.',
    type: 'Migration', status: 'Not Started',
    partner: ['2026-08-01', '2026-10-05'],
    company: ['2026-08-05', '2026-10-20'],
    approved: [null, null],
    milestones: []
  }
];

/** Create the auth user, or reuse the existing one and reset its password. */
async function ensureAuthUser(account, role) {
  var page = await supabase.admin.auth.admin.listUsers({ perPage: 200 });
  if (page.error) throw new Error('Could not list users: ' + page.error.message);

  var existing = (page.data.users || []).filter(function (u) {
    return String(u.email).toLowerCase() === account.email;
  })[0];

  if (existing) {
    var updated = await supabase.admin.auth.admin.updateUserById(existing.id, {
      password: account.password,
      email_confirm: true,
      app_metadata: { role: role }
    });
    if (updated.error) throw new Error('Could not update ' + account.email + ': ' + updated.error.message);
    return { id: existing.id, created: false };
  }

  var created = await supabase.admin.auth.admin.createUser({
    email: account.email,
    password: account.password,
    email_confirm: true,
    app_metadata: { role: role }
  });
  if (created.error) throw new Error('Could not create ' + account.email + ': ' + created.error.message);
  return { id: created.data.user.id, created: true };
}

async function upsertPerson(authUserId, account, kind, role) {
  return sql.one(
    `INSERT INTO people (user_id, name, job_title, email, kind, role)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (email) DO UPDATE
        SET user_id = excluded.user_id, name = excluded.name,
            job_title = excluded.job_title, kind = excluded.kind, role = excluded.role
     RETURNING *`,
    [authUserId, account.name, account.jobTitle, account.email, kind, role]);
}

async function run() {
  console.log('\n  Seeding ' + supabase.url + '\n');

  if (RESET) {
    // Projects cascade to milestones, sub-tasks, comments and assignments.
    var removed = await sql.run('DELETE FROM projects WHERE code = ANY($1::citext[])',
      [PROJECTS.map(function (p) { return p.code; })]);
    console.log('  reset: removed ' + removed + ' seeded project(s)');
  }

  var adminAuth = await ensureAuthUser(ADMIN, 'admin');
  var admin = await upsertPerson(adminAuth.id, ADMIN, 'company', 'admin');
  console.log('  admin   ' + ADMIN.email + (adminAuth.created ? '  (created)' : '  (updated)'));

  var partnerAuth = await ensureAuthUser(PARTNER, 'partner');
  var partner = await upsertPerson(partnerAuth.id, PARTNER, 'partner', 'partner');
  console.log('  partner ' + PARTNER.email + (partnerAuth.created ? '  (created)' : '  (updated)'));

  if (!WITH_SAMPLES) {
    console.log('\n  Accounts only. Pass --with-samples for the demo directory and projects.');
    console.log('\n  Done. Sign in as ' + ADMIN.email + '\n');
    return;
  }

  var resourceIds = [admin.id];
  for (var i = 0; i < RESOURCES.length; i++) {
    /* eslint-disable no-await-in-loop */
    var person = await sql.one(
      `INSERT INTO people (name, job_title, kind)
       SELECT $1, $2, 'company'
        WHERE NOT EXISTS (SELECT 1 FROM people WHERE name = $1 AND kind = 'company')
       RETURNING *`, [RESOURCES[i].name, RESOURCES[i].jobTitle]);
    if (!person) {
      person = await sql.one("SELECT * FROM people WHERE name = $1 AND kind = 'company'",
        [RESOURCES[i].name]);
    }
    resourceIds.push(person.id);
  }
  console.log('  people  ' + resourceIds.length + ' company, 1 partner');

  var projectCount = 0;
  for (var p = 0; p < PROJECTS.length; p++) {
    /* eslint-disable no-await-in-loop */
    var spec = PROJECTS[p];

    var existing = await sql.one('SELECT id FROM projects WHERE code = $1', [spec.code]);
    if (existing) continue;

    await sql.tx(async function (t) {
      var project = await t.one(
        `INSERT INTO projects (code, title, description, type, status,
            partner_start, partner_end, company_start, company_end,
            approved_start, approved_end)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [spec.code, spec.title, spec.description, spec.type, spec.status,
          spec.partner[0], spec.partner[1], spec.company[0], spec.company[1],
          spec.approved[0], spec.approved[1]]);

      // Two or three resources each, and the one Partner POC on everything
      var assigned = resourceIds.slice(0, 3);
      await t.run('INSERT INTO project_resources (project_id, person_id) SELECT $1, unnest($2::uuid[])',
        [project.id, assigned]);
      await t.run('INSERT INTO project_pocs (project_id, person_id) VALUES ($1, $2)',
        [project.id, partner.id]);

      for (var m = 0; m < spec.milestones.length; m++) {
        var ms = spec.milestones[m];
        // Seeded milestones have company dates agreed as-is, so approved matches
        var milestone = await t.one(
          `INSERT INTO milestones (project_id, title, position,
              company_start, company_end, approved_start, approved_end)
           VALUES ($1,$2,$3,$4,$5,$4,$5) RETURNING id`,
          [project.id, ms.title, m, ms.start, ms.end]);

        for (var s = 0; s < ms.subtasks.length; s++) {
          await t.run('INSERT INTO subtasks (milestone_id, title, position) VALUES ($1,$2,$3)',
            [milestone.id, ms.subtasks[s], s]);
        }
      }
    });
    projectCount++;
  }

  console.log('  projects ' + projectCount + ' created, ' +
    (PROJECTS.length - projectCount) + ' already present');
  console.log('\n  Done. Sign in as ' + ADMIN.email + '\n');
}

run()
  .then(function () { return sql.close(); })
  .then(function () { process.exit(0); })
  .catch(function (err) {
    console.error('\n  FAILED  ' + err.message + '\n');
    process.exit(1);
  });
