/**
 * The frontend against the migrated backend.
 *
 *   node --experimental-websocket tests/browser.test.js
 *
 * The server suites prove the API. This proves the pages still work against
 * it — which matters because three contracts moved underneath the client:
 *
 *   · /api/audit returns { entries, nextBefore } instead of a bare array
 *   · attachments upload in three steps instead of one multipart POST
 *   · sessions are Supabase tokens in cookies rather than a local session row
 *
 * Needs Chrome. Skips cleanly with exit 0 if none is installed, so CI without
 * a browser does not report a false failure.
 */

var harness = require('./harness');
var cdp = require('./cdp');

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
function section(t) { console.log('\n--- ' + t + ' ---'); }

var PORT = 3242;
var BASE = 'http://127.0.0.1:' + PORT;

// Supabase Storage is a different origin, so the stand-in is a separate
// server rather than a route on the app. Mounting it on the app would also
// put it behind the SPA catch-all, which answers everything with index.html.
var STORAGE_PORT = 3244;
var STORAGE_BASE = 'http://127.0.0.1:' + STORAGE_PORT;

var txt = function (sel) {
  return '(document.querySelector(' + JSON.stringify(sel) + ')||{}).innerText||""';
};
var has = function (sel) { return '!!document.querySelector(' + JSON.stringify(sel) + ')'; };

var typeInto = function (sel, value) {
  return '(() => { const el = document.querySelector(' + JSON.stringify(sel) + ');' +
    ' el.value = ' + JSON.stringify(value) + ';' +
    " el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()";
};

/**
 * Put a real File into a file input, the way a user picking one would.
 *
 * The size is read BEFORE the change event fires: an oversized file makes the
 * page clear the input, so reading files[0] afterwards finds nothing — which
 * is the client behaving correctly, not a failure.
 */
var setFile = function (sel, name, mime, size) {
  return `
  (() => {
    const input = document.querySelector(${JSON.stringify(sel)});
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(${size})], ${JSON.stringify(name)},
      { type: ${JSON.stringify(mime)} }));
    input.files = dt.files;
    const picked = input.files[0].size;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { picked, keptByPage: input.files.length };
  })()`;
};

(async function () {
  if (!cdp.findChrome()) {
    console.log('\n  No Chrome found — skipping the browser suite.');
    console.log('  Set CHROME_PATH to run it.\n');
    process.exit(0);
  }

  // Signed download URLs must point somewhere a browser can actually reach
  process.env.TEST_STORAGE_BASE = STORAGE_BASE;

  harness.resetDatabase();
  var supabase = harness.install();

  var sql = require('../server/sql');
  var app = require('../server/app');

  // The browser PUTs its upload to the signed URL. In production that is
  // Supabase Storage; here the app serves the fake endpoint itself so the
  // three-step flow is genuinely exercised end to end.
  app.put('/__test_upload/:token', function (req, res) {
    var size = 0;
    req.on('data', function (c) { size += c.length; });
    req.on('end', function () {
      try {
        harness.putObject(req.params.token, size);
        res.status(200).json({ ok: true });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });
  });

  var server = await new Promise(function (r) {
    var s = app.listen(PORT, function () { r(s); });
  });

  // Supabase Storage, as far as the browser is concerned: another origin
  // answering a signed URL with Content-Disposition: attachment.
  var storage = require('http').createServer(function (req, res) {
    var parsed = new URL(req.url, STORAGE_BASE);
    var objectPath = decodeURIComponent(
      parsed.pathname.replace('/storage/v1/object/sign/', ''));
    var stored = harness.objects.get(objectPath);
    if (!stored) { res.statusCode = 404; return res.end('not found'); }

    var name = String(parsed.searchParams.get('download') || 'file');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition',
      'attachment; filename="' + name.replace(/"/g, '') + '"');
    res.end(Buffer.alloc(stored.size));
  });
  await new Promise(function (r) { storage.listen(STORAGE_PORT, r); });

  var admin = await harness.createAccount(sql, supabase, {
    email: 'admin@example.test', password: 'AdminPassword1', name: 'Ada Admin', role: 'admin'
  });
  var poc = await harness.createAccount(sql, supabase, {
    email: 'poc@example.test', password: 'PartnerPassword1', name: 'Pat Partner', role: 'partner'
  });

  // A project with a delayed sub-task, submitted and waiting on the POC
  var project = await sql.one(
    `INSERT INTO projects (code,title,description,type,status,company_start,company_end,
        approved_start, approved_end)
     VALUES ('PRJ-900','Browser','End to end.','Migration','In-Progress',
             '2026-01-01','2026-06-30','2026-01-05','2026-06-25') RETURNING *`);
  await sql.run('INSERT INTO project_resources (project_id,person_id) VALUES ($1,$2)',
    [project.id, admin.id]);
  await sql.run('INSERT INTO project_pocs (project_id,person_id) VALUES ($1,$2)',
    [project.id, poc.id]);

  var milestone = await sql.one(
    `INSERT INTO milestones (project_id,title,position,company_start,company_end,
        completed,outcome,completed_at,approval,submitted_by,submitted_at)
     VALUES ($1,'Discovery',0,'2026-01-01','2026-02-01',
             true,'On-Time',current_date,'pending',$2,current_date) RETURNING *`,
    [project.id, admin.id]);
  var subtask = await sql.one(
    `INSERT INTO subtasks (milestone_id,title,position,completed,outcome,
        delay_side,delay_notes,completed_at)
     VALUES ($1,'Interviews',0,true,'Delayed','Company Side',
             'Environment rebuild overran.',current_date) RETURNING *`, [milestone.id]);

  // The audit view is fed by real activity; this test seeds through SQL, so
  // give it a couple of entries to render.
  await sql.run(
    `INSERT INTO audit (category, action, target, detail, project_id, actor_id, actor_name, actor_role)
     VALUES ('Project','Created','PRJ-900 — Browser','Migration',$1,$2,'Ada Admin','Admin'),
            ('Approval','Submitted','Discovery','PRJ-900',$1,$2,'Ada Admin','Admin')`,
    [project.id, admin.id]);

  var browser = await cdp.launch(9333);
  var page = await cdp.connect(9333);
  var pageErrors = [];
  setInterval(function () {
    page.events.splice(0).forEach(function (e) {
      if (e.method === 'Runtime.exceptionThrown') {
        pageErrors.push((e.params.exceptionDetails.exception || {}).description ||
          e.params.exceptionDetails.text);
      }
    });
  }, 200).unref();

  try {
    await cdp.setViewport(page, 1440, 1000);

    // ---------------------------------------------------------------
    section('sign in through the new auth broker');
    await cdp.login(page, BASE, 'admin@example.test', 'AdminPassword1');
    check('admin signs in', await cdp.evaluate(page,
      "!document.getElementById('app-view').classList.contains('hidden')"));

    // The whole point of brokering through Express rather than supabase-js
    var visible = await cdp.evaluate(page, 'document.cookie');
    check('the session token is NOT readable from JavaScript',
      visible.indexOf('ft_at') === -1 && visible.indexOf('ft_rt') === -1,
      'document.cookie = ' + JSON.stringify(visible));
    check('  nor parked in localStorage',
      (await cdp.evaluate(page, 'JSON.stringify(Object.keys(localStorage))')) === '[]',
      await cdp.evaluate(page, 'JSON.stringify(Object.keys(localStorage))'));
    await cdp.screenshot(page, '01-dashboard');

    // ---------------------------------------------------------------
    section('the pages still render');
    for (var route of ['/dashboard', '/projects', '/people', '/audit', '/profile']) {
      await cdp.nav(page, route);
      var body = await cdp.evaluate(page, "document.getElementById('view').innerText");
      check(route + ' renders', body.trim().length > 20, body.slice(0, 60));
    }
    await cdp.screenshot(page, '02-audit');

    // The audit endpoint changed shape; a bare array would have thrown here
    await cdp.nav(page, '/audit');
    check('the audit table is populated from { entries }',
      (await cdp.evaluate(page, "document.querySelectorAll('#audit-rows tr').length")) > 0,
      await cdp.evaluate(page, txt('#audit-count')));
    check('  and no page error was thrown', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

    // ---------------------------------------------------------------
    section('project sub-tabs against real dates');
    await cdp.nav(page, '/projects/PRJ-900');
    check('the project opens', (await cdp.evaluate(page, txt('.detail-head'))).indexOf('Browser') > -1);
    check('  dates survived the move to `date` columns',
      (await cdp.evaluate(page, txt('.date-strip'))).indexOf('2026') > -1,
      await cdp.evaluate(page, txt('.date-strip')));
    await cdp.screenshot(page, '03-overview');

    await cdp.nav(page, '/projects/PRJ-900/milestones');
    check('the milestones tab lists the milestone', await cdp.evaluate(page, has('.milestone')));
    await cdp.nav(page, '/projects/PRJ-900/comments');
    check('the comments tab shows the delay thread', await cdp.evaluate(page, has('.delay-thread')));
    await cdp.screenshot(page, '04-comments');

    // ---------------------------------------------------------------
    section('the three-step upload, from the browser');
    await cdp.login(page, BASE, 'poc@example.test', 'PartnerPassword1');
    await cdp.nav(page, '/projects/PRJ-900/comments');

    var thread = 'subtask:' + subtask.id;
    check('the POC gets the decision buttons',
      await cdp.evaluate(page, has('[data-thread="' + thread + '"] [data-delay-decide="denied"]')));

    var big = await cdp.evaluate(page, setFile('[data-thread="' + thread + '"] input[type=file]',
      'huge.pdf', 'application/pdf', 11 * 1024 * 1024));
    await cdp.sleep(400);
    check('an 11MB file is refused before any upload starts',
      (await cdp.evaluate(page, txt('[data-thread="' + thread + '"] [data-composer-error]')))
        .indexOf('larger than 10MB') > -1,
      await cdp.evaluate(page, txt('[data-thread="' + thread + '"] [data-composer-error]')));
    check('  and the page clears it rather than holding it',
      big.keptByPage === 0, 'input still holds ' + big.keptByPage + ' file(s)');

    var sized = await cdp.evaluate(page, setFile('[data-thread="' + thread + '"] input[type=file]',
      'evidence.pdf', 'application/pdf', 2048));
    check('a 2KB PDF is accepted by the picker',
      sized.picked === 2048 && sized.keptByPage === 1, JSON.stringify(sized));

    await cdp.evaluate(page, typeInto('[data-thread="' + thread + '"] [data-field="body"]',
      'That rebuild was scheduled. Not acceptable.'));
    await cdp.evaluate(page,
      'document.querySelector(\'[data-thread="' + thread + '"] [data-delay-decide="denied"]\').click(); true');
    await cdp.sleep(2500);
    await cdp.screenshot(page, '05-denied-with-upload');

    var stored = await sql.one(
      'SELECT a.* FROM attachments a JOIN delay_comments c ON c.id = a.comment_id');
    check('the file reached storage and was recorded', !!stored,
      stored ? stored.object_path : 'no attachment row');
    check('  under a UUID path, not the chosen name',
      stored && /[0-9a-f-]{36}\.pdf$/.test(stored.object_path), stored && stored.object_path);
    check('  with the real byte count', stored && Number(stored.bytes) === 2048,
      stored && String(stored.bytes));
    check('  and the thread shows the chip',
      await cdp.evaluate(page, has('[data-thread="' + thread + '"] .attachment')));
    check('  the decision persisted',
      (await cdp.evaluate(page, txt('[data-thread="' + thread + '"] .decision-chip'))).trim() === 'Denied',
      await cdp.evaluate(page, txt('[data-thread="' + thread + '"] .decision-chip')));

    // ---------------------------------------------------------------
    section('the decision survives a full reload');
    await cdp.goto(page, BASE + '/projects/PRJ-900/comments');
    await cdp.sleep(800);
    check('still denied after a reload',
      (await cdp.evaluate(page, txt('[data-thread="' + thread + '"] .decision-chip'))).trim() === 'Denied');
    check('  and the session survived too',
      await cdp.evaluate(page, "!document.getElementById('app-view').classList.contains('hidden')"));

    // ---------------------------------------------------------------
    section('admin replies only on a denial');
    await cdp.login(page, BASE, 'admin@example.test', 'AdminPassword1');
    await cdp.nav(page, '/projects/PRJ-900/comments');
    check('admin now has a composer on the denied delay',
      await cdp.evaluate(page, has('[data-thread="' + thread + '"] .composer')));

    await cdp.evaluate(page, typeInto('[data-thread="' + thread + '"] [data-field="body"]',
      'Attaching the change record.'));
    await cdp.evaluate(page,
      'document.querySelector(\'[data-thread="' + thread + '"] [data-delay-comment]\').click(); true');
    await cdp.sleep(2000);
    check('the reply lands',
      (await cdp.evaluate(page,
        "document.querySelectorAll('[data-thread=\"" + thread + "\"] .msg').length")) === 2,
      await cdp.evaluate(page,
        "String(document.querySelectorAll('[data-thread=\"" + thread + "\"] .msg').length)"));
    await cdp.screenshot(page, '06-admin-replied');

    // ---------------------------------------------------------------
    section('attachment download');
    var dl = await cdp.evaluate(page, `
      (async () => {
        const a = document.querySelector('.attachment');
        const r = await fetch(a.getAttribute('href') + '?json=1');
        return JSON.stringify({ status: r.status, body: await r.json() });
      })()`, true);
    var parsed = JSON.parse(dl);
    check('a signed download URL comes back', parsed.status === 200, dl.slice(0, 120));
    check('  forcing a download rather than rendering',
      /download=evidence\.pdf/.test(parsed.body.url || ''), parsed.body.url);

    // ---------------------------------------------------------------
    section('profile and the avatar menu');
    await cdp.nav(page, '/profile');
    check('the Access field is still gone',
      (await cdp.evaluate(page, "document.getElementById('view').innerText")).indexOf('Access') === -1);
    check('the password form is present', await cdp.evaluate(page, has('#password-form')));

    await cdp.evaluate(page, typeInto('#pw-current', 'AdminPassword1'));
    await cdp.evaluate(page, typeInto('#pw-new', 'short'));
    await cdp.evaluate(page, typeInto('#pw-confirm', 'short'));
    await cdp.evaluate(page, "document.querySelector('#password-form').requestSubmit(); true");
    await cdp.sleep(600);
    check('a short password is refused',
      (await cdp.evaluate(page, txt('#pw-error'))).length > 0, await cdp.evaluate(page, txt('#pw-error')));

    // ---------------------------------------------------------------
    section('password recovery, end to end');

    // Signed out, following the link from the login card
    await cdp.signOut(page, BASE);

    check('the login card offers a way out',
      await cdp.evaluate(page, has('#login-view .card-foot a[href="/forgot-password"]')));

    await cdp.nav(page, '/forgot-password');
    check('/forgot-password shows its own card',
      await cdp.evaluate(page, "!document.getElementById('forgot-view').classList.contains('hidden')"));
    check('  and the login card is hidden',
      await cdp.evaluate(page, "document.getElementById('login-view').classList.contains('hidden')"));

    await cdp.evaluate(page, typeInto('#forgot-email', 'poc@example.test'));
    await cdp.evaluate(page, "document.getElementById('forgot-form').requestSubmit(); true");
    await cdp.sleep(900);
    check('requesting a link gives a neutral answer',
      (await cdp.evaluate(page, txt('#forgot-sent'))).indexOf('If that address') > -1,
      await cdp.evaluate(page, txt('#forgot-sent')));
    await cdp.screenshot(page, '07-forgot');

    // A link with no token must not offer a form that cannot work
    await cdp.goto(page, BASE + '/reset-password', '#reset-view:not(.hidden)');
    check('an incomplete link is refused up front',
      (await cdp.evaluate(page, txt('#reset-error'))).length > 0,
      await cdp.evaluate(page, txt('#reset-error')));
    check('  with the button disabled',
      await cdp.evaluate(page, "document.getElementById('reset-submit').disabled"));

    // The real thing. This URL is what the emailed link resolves to.
    var hash = 'recovery-poc@example.test';
    check('the request minted a usable link', harness.recoveryHashes.has(hash));

    await cdp.goto(page, BASE + '/reset-password?token_hash=' + encodeURIComponent(hash) +
      '&type=recovery', '#reset-view:not(.hidden)');
    check('a complete link enables the form',
      !(await cdp.evaluate(page, "document.getElementById('reset-submit').disabled")));
    await cdp.screenshot(page, '08-reset');

    await cdp.evaluate(page, typeInto('#reset-password', 'short'));
    await cdp.evaluate(page, typeInto('#reset-confirm', 'short'));
    await cdp.evaluate(page, "document.getElementById('reset-form').requestSubmit(); true");
    await cdp.sleep(500);
    check('a short password is refused',
      (await cdp.evaluate(page, txt('#reset-error'))).indexOf('at least') > -1,
      await cdp.evaluate(page, txt('#reset-error')));

    await cdp.evaluate(page, typeInto('#reset-password', 'BrandNewPassword1'));
    await cdp.evaluate(page, typeInto('#reset-confirm', 'DifferentPassword1'));
    await cdp.evaluate(page, "document.getElementById('reset-form').requestSubmit(); true");
    await cdp.sleep(500);
    check('a mismatch is refused',
      (await cdp.evaluate(page, txt('#reset-error'))).indexOf('do not match') > -1,
      await cdp.evaluate(page, txt('#reset-error')));

    await cdp.evaluate(page, typeInto('#reset-confirm', 'BrandNewPassword1'));
    await cdp.evaluate(page, "document.getElementById('reset-form').requestSubmit(); true");
    await cdp.sleep(2000);

    check('a successful reset lands signed in, not back on the card',
      await cdp.evaluate(page, "!document.getElementById('app-view').classList.contains('hidden')"),
      await cdp.evaluate(page, 'location.pathname'));
    check('  on the dashboard', (await cdp.evaluate(page, 'location.pathname')) === '/dashboard',
      await cdp.evaluate(page, 'location.pathname'));
    check('  and the token_hash is gone from the address bar',
      (await cdp.evaluate(page, 'location.search')).indexOf('token_hash') === -1,
      await cdp.evaluate(page, 'location.search'));
    check('  the session is real', (await cdp.evaluate(page, `
      (async () => (await fetch('/api/auth/me')).status)()`, true)) === 200);
    await cdp.screenshot(page, '09-reset-complete');

    check('the new password works',
      (await cdp.evaluate(page, `
        (async () => {
          const r = await fetch('/api/auth/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'poc@example.test', password: 'BrandNewPassword1' })
          });
          return r.status;
        })()`, true)) === 200);

    // ---------------------------------------------------------------
    section('one click, one comment');

    // draw() replaces #view's innerHTML but not #view itself, so a delegated
    // listener attached to #view survives every redraw. Navigating between
    // sub-tabs therefore used to stack one handler per draw, and a single
    // click posted as many comments as there had been redraws.
    // The recovery section above changed this account's password
    await cdp.login(page, BASE, 'poc@example.test', 'BrandNewPassword1');

    // The sub-task is the delayed item in this fixture, so it is the one with
    // a thread and a composer.
    var dupThread = 'subtask:' + subtask.id;
    var before = await sql.value(
      'SELECT count(*)::int FROM delay_comments WHERE item_type = $1 AND item_id = $2',
      ['subtask', subtask.id]);

    // Move around inside the SPA — no full page load, so nothing is reset
    for (var r = 0; r < 4; r++) {
      await cdp.nav(page, '/projects/PRJ-900');
      await cdp.nav(page, '/projects/PRJ-900/milestones');
      await cdp.nav(page, '/projects/PRJ-900/comments');
    }

    var listeners = await cdp.evaluate(page, `
      (() => {
        const el = document.getElementById('view');
        return el.__clickHandlers === undefined ? 'untracked' : el.__clickHandlers;
      })()`);

    // This delay is already denied, so the partner's options are "Accept and
    // close" or "Reply". Reply is the one that leaves the thread open for the
    // count to be meaningful.
    await cdp.evaluate(page, typeInto('[data-thread="' + dupThread + '"] [data-field="body"]',
      'Exactly one of these should exist.'));
    await cdp.evaluate(page,
      'document.querySelector(\'[data-thread="' + dupThread + '"] [data-delay-comment]\').click(); true');
    await cdp.sleep(2500);

    var after = await sql.value(
      'SELECT count(*)::int FROM delay_comments WHERE item_type = $1 AND item_id = $2',
      ['subtask', subtask.id]);

    check('after 12 redraws, one click writes exactly one comment',
      after - before === 1, (after - before) + ' comments written (listeners: ' + listeners + ')');
    await cdp.screenshot(page, '10-no-duplicates');

    // ---------------------------------------------------------------
    section('clicking an attachment downloads it');

    var downloadDir = require('fs').mkdtempSync(
      require('path').join(require('os').tmpdir(), 'ft-downloads-'));
    await page.send('Browser.setDownloadBehavior',
      { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true });

    // What differs between the two roles is authorisation, and that is a
    // server answer — so check it per role over HTTP. The browser mechanics
    // (click, 302, Content-Disposition, save) do not vary by who is signed in,
    // and Chrome refuses a second automatic download per origin in one
    // session, so driving the click twice would measure Chrome, not the app.
    for (var who of [['admin@example.test', 'AdminPassword1', 'admin'],
                     ['poc@example.test', 'BrandNewPassword1', 'Partner POC']]) {
      await cdp.login(page, BASE, who[0], who[1]);
      await cdp.nav(page, '/projects/PRJ-900/comments');

      check(who[2] + ' sees the attachment chip',
        await cdp.evaluate(page, has('.attachment')));

      var answer = JSON.parse(await cdp.evaluate(page, `
        (async () => {
          const a = document.querySelector('.attachment');
          const res = await fetch(a.getAttribute('href') + '?json=1');
          return JSON.stringify({ status: res.status, body: await res.json() });
        })()`, true));

      check('  ' + who[2] + ' is issued a download URL', answer.status === 200,
        JSON.stringify(answer).slice(0, 110));
      check('  forcing a save under the real name',
        /download=evidence\.pdf/.test((answer.body || {}).url || ''), (answer.body || {}).url);
    }

    // And once, for real: a click must put the file on disk, not route the
    // href as a page. The router used to swallow it — see router.js.
    var before = require('fs').readdirSync(downloadDir);
    await cdp.clickAt(page, '.attachment');
    await cdp.sleep(2500);
    var saved = require('fs').readdirSync(downloadDir)
      .filter(function (f) { return before.indexOf(f) === -1 && !/\.crdownload$/.test(f); });

    check('a click saves the file', saved.length === 1, JSON.stringify(saved));
    if (saved.length) {
      check('  under its real name, no percent-escapes',
        saved[0] === 'evidence.pdf', saved[0]);
      check('  with the right bytes',
        require('fs').statSync(require('path').join(downloadDir, saved[0])).size === 2048);
    }
    check('  and the page stayed where it was',
      (await cdp.evaluate(page, 'location.pathname')) === '/projects/PRJ-900/comments',
      await cdp.evaluate(page, 'location.pathname'));

    // ---------------------------------------------------------------
    section('accepting closes the thread on screen');

    await cdp.login(page, BASE, 'poc@example.test', 'BrandNewPassword1');
    await cdp.nav(page, '/projects/PRJ-900/comments');

    var closeThread = '[data-thread="subtask:' + subtask.id + '"]';
    check('a denied delay offers Accept-and-close and Reply',
      await cdp.evaluate(page, has(closeThread + ' [data-delay-decide="accepted"]')) &&
      await cdp.evaluate(page, has(closeThread + ' [data-delay-comment]')));
    check('  but no way to deny it again',
      !await cdp.evaluate(page, has(closeThread + ' [data-delay-decide="denied"]')));

    await cdp.evaluate(page, typeInto(closeThread + ' [data-field="body"]', 'Accepted, thanks.'));
    await cdp.evaluate(page,
      'document.querySelector(\'' + closeThread + ' [data-delay-decide="accepted"]\').click(); true');
    await cdp.sleep(2500);

    check('the partner loses the composer once accepted',
      !await cdp.evaluate(page, has(closeThread + ' .composer')),
      await cdp.evaluate(page, txt(closeThread + ' .composer-locked')));
    check('  and is told it is settled',
      /settled and the conversation is closed/.test(
        await cdp.evaluate(page, txt(closeThread + ' .composer-locked'))),
      await cdp.evaluate(page, txt(closeThread + ' .composer-locked')));
    await cdp.screenshot(page, '11-thread-closed');

    await cdp.login(page, BASE, 'admin@example.test', 'AdminPassword1');
    await cdp.nav(page, '/projects/PRJ-900/comments');
    check('the admin loses it too',
      !await cdp.evaluate(page, has(closeThread + ' .composer')),
      await cdp.evaluate(page, txt(closeThread + ' .composer-locked')));

    check('no uncaught page errors anywhere', pageErrors.length === 0,
      pageErrors.slice(0, 3).join(' | '));

  } finally {
    page.close();
    cdp.kill(browser);
    server.close();
    if (typeof storage !== 'undefined') storage.close();
  }

  console.log('\n================  ' + pass + ' passed, ' + fail + ' failed  ================');
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(function (f) { console.log('  · ' + f); });
  }
  console.log('\n  Screenshots: ' + cdp.SHOTS);

  await sql.close();
  process.exit(fail ? 1 : 0);
})().catch(function (err) {
  console.error('\nHARNESS ERROR:', err.stack || err.message);
  process.exit(2);
});
