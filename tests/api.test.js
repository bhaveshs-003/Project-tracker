/**
 * The server suite. Exercises the HTTP surface the browser actually uses.
 *
 *   node tests/api.test.js
 *
 * Needs a local Postgres on the default port; it creates and drops its own
 * database, so it never touches development data.
 */

var harness = require('./harness');
var assert = require('assert');

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

function section(title) { console.log('\n--- ' + title + ' ---'); }

// ---------------------------------------------------------------
// HTTP, with a cookie jar per identity
// ---------------------------------------------------------------
var BASE;
var jars = {};

async function call(who, method, path, body, options) {
  var opts = options || {};
  var headers = Object.assign({}, opts.headers || {});
  if (jars[who]) headers.Cookie = jars[who];
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  var res = await fetch(BASE + path, {
    method: method,
    headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  });

  var setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setCookies.length) {
    var jar = {};
    (jars[who] || '').split('; ').filter(Boolean).forEach(function (c) {
      jar[c.slice(0, c.indexOf('='))] = c;
    });
    setCookies.forEach(function (c) {
      var pair = c.split(';')[0];
      var name = pair.slice(0, pair.indexOf('='));
      if (/Max-Age=0/.test(c)) delete jar[name];
      else jar[name] = pair;
    });
    jars[who] = Object.values(jar).join('; ');
  }

  var type = res.headers.get('content-type') || '';
  return {
    status: res.status,
    headers: res.headers,
    data: type.indexOf('json') > -1 ? await res.json().catch(function () { return null; })
      : await res.text(),
    setCookies: setCookies
  };
}

(async function () {
  harness.resetDatabase();
  var supabase = harness.install();

  var sql = require('../server/sql');
  var app = require('../server/app');

  var server = await new Promise(function (resolve) {
    var s = app.listen(0, function () { resolve(s); });
  });
  BASE = 'http://127.0.0.1:' + server.address().port;

  // ---------------------------------------------------------------
  section('setup');
  var admin = await harness.createAccount(sql, supabase, {
    email: 'admin@example.test', password: 'AdminPassword1', name: 'Ada Admin', role: 'admin'
  });
  var poc = await harness.createAccount(sql, supabase, {
    email: 'poc@example.test', password: 'PartnerPassword1', name: 'Pat Partner', role: 'partner'
  });
  var outsider = await harness.createAccount(sql, supabase, {
    email: 'outsider@example.test', password: 'OutsiderPassword1', name: 'Olu Outsider', role: 'partner'
  });
  check('three accounts created', !!admin.id && !!poc.id && !!outsider.id);

  // ---------------------------------------------------------------
  section('authentication');
  var badLogin = await call('admin', 'POST', '/api/auth/login',
    { email: 'admin@example.test', password: 'wrong-password' });
  check('wrong password is refused', badLogin.status === 401, String(badLogin.status));
  check('  without revealing whether the account exists',
    badLogin.data.error === 'Invalid email or password', badLogin.data.error);

  var unknown = await call('nobody', 'POST', '/api/auth/login',
    { email: 'nosuch@example.test', password: 'whatever123' });
  check('an unknown account gives the identical message',
    unknown.data.error === badLogin.data.error, unknown.data.error);

  var login = await call('admin', 'POST', '/api/auth/login',
    { email: 'admin@example.test', password: 'AdminPassword1' });
  check('admin signs in', login.status === 200, JSON.stringify(login.data));
  check('  and is told their role', login.data.role === 'admin', login.data.role);

  var cookieHeader = login.setCookies.join(' | ');
  check('the session cookie is httpOnly', /ft_at=[^;]+;[^|]*HttpOnly/i.test(cookieHeader), cookieHeader);
  check('  and SameSite=Lax', /SameSite=Lax/i.test(cookieHeader));
  check('  and the refresh token too', /ft_rt=[^;]+;[^|]*HttpOnly/i.test(cookieHeader));

  var me = await call('admin', 'GET', '/api/auth/me');
  check('/me returns the signed-in user', me.status === 200 && me.data.email === 'admin@example.test');

  var anonymous = await call('nobody', 'GET', '/api/projects');
  check('no cookie means 401', anonymous.status === 401, String(anonymous.status));

  await call('poc', 'POST', '/api/auth/login',
    { email: 'poc@example.test', password: 'PartnerPassword1' });
  await call('outsider', 'POST', '/api/auth/login',
    { email: 'outsider@example.test', password: 'OutsiderPassword1' });
  check('both partners signed in', !!jars.poc && !!jars.outsider);

  section('rate limiting');
  var limited = null;
  for (var i = 0; i < 10; i++) {
    /* eslint-disable no-await-in-loop */
    var attempt = await call('bruteforce', 'POST', '/api/auth/login',
      { email: 'victim@example.test', password: 'guess' + i });
    if (attempt.status === 429) { limited = i + 1; break; }
  }
  check('repeated failures against one account are locked out', limited !== null,
    limited ? 'after ' + limited + ' attempts' : 'never limited in 10 tries');

  // The budgets are deliberately separate. If they were one combined counter,
  // everyone sharing an office IP would be locked out by one colleague's
  // typo — so a *different* account from the same address must still work.
  var neighbour = await call('neighbour', 'POST', '/api/auth/login',
    { email: 'poc@example.test', password: 'PartnerPassword1' });
  check('  a different account from the same IP is not collateral damage',
    neighbour.status === 200, String(neighbour.status));
  check('  and an already-signed-in session is unaffected',
    (await call('admin', 'GET', '/api/auth/me')).status === 200);

  section('token expiry and silent refresh');
  var expiring = await harness.mintAccessToken(
    [...harness.authUsers.values()].find(function (u) { return u.email === 'admin@example.test'; }), -10);
  jars.stale = 'ft_at=' + expiring + '; ' + jars.admin.split('; ')
    .filter(function (c) { return c.indexOf('ft_rt=') === 0; }).join('; ');
  var refreshed = await call('stale', 'GET', '/api/auth/me');
  check('an expired access token refreshes transparently', refreshed.status === 200,
    String(refreshed.status));
  check('  and a new cookie is issued', refreshed.setCookies.some(function (c) {
    return c.indexOf('ft_at=') === 0;
  }));

  var forged = await harness.mintAccessToken({ id: admin.user_id, email: 'x', app_metadata: {} }, 3600);
  jars.forged = 'ft_at=' + forged.slice(0, -4) + 'AAAA';
  check('a tampered signature is rejected',
    (await call('forged', 'GET', '/api/auth/me')).status === 401);

  // ---------------------------------------------------------------
  section('projects and scoping');
  var created = await call('admin', 'POST', '/api/projects', {
    code: 'PRJ-100', title: 'Scoped', type: 'Migration', status: 'In-Progress',
    companyStart: '2026-01-01', companyEnd: '2026-06-30'
  });
  check('admin creates a project', created.status === 201, JSON.stringify(created.data));
  var projectId = created.data.id;
  check('  dates come back as calendar strings',
    created.data.companyStart === '2026-01-01', created.data.companyStart);
  check('  and an unset date is empty, not null',
    created.data.approvedStart === '', JSON.stringify(created.data.approvedStart));

  var badDates = await call('admin', 'POST', '/api/projects', {
    code: 'PRJ-BAD', title: 'Backwards', type: 'Migration',
    companyStart: '2026-06-01', companyEnd: '2026-01-01'
  });
  check('an end before its start is refused', badDates.status === 400, badDates.data.error);

  var dupe = await call('admin', 'POST', '/api/projects',
    { code: 'prj-100', title: 'Case clash', type: 'Migration' });
  check('a duplicate code is refused case-insensitively', dupe.status === 409, String(dupe.status));

  var partnerBefore = await call('poc', 'GET', '/api/projects');
  check('a partner sees nothing before assignment',
    Array.isArray(partnerBefore.data) && partnerBefore.data.length === 0,
    JSON.stringify(partnerBefore.data).slice(0, 80));

  await call('admin', 'PUT', '/api/projects/' + projectId + '/pocs', { personIds: [poc.id] });
  var partnerAfter = await call('poc', 'GET', '/api/projects');
  check('and sees it once assigned', partnerAfter.data.length === 1);

  var sneak = await call('outsider', 'GET', '/api/projects/' + projectId);
  check('a non-POC gets 404, not 403', sneak.status === 404, String(sneak.status));

  var partnerWrite = await call('poc', 'POST', '/api/projects',
    { code: 'PRJ-NOPE', title: 'Not allowed', type: 'Migration' });
  check('a partner cannot create a project', partnerWrite.status === 403, String(partnerWrite.status));

  // ---------------------------------------------------------------
  section('the delay negotiation');
  var milestone = (await call('admin', 'POST', '/api/milestones', {
    projectId: projectId, title: 'Discovery', companyStart: '2026-01-01', companyEnd: '2026-02-01'
  })).data;
  check('milestone created', !!milestone.id);

  var withSub = (await call('admin', 'POST', '/api/milestones/' + milestone.id + '/subtasks',
    { title: 'Interviews' })).data;
  var subtaskId = withSub.subtasks[0].id;

  await call('admin', 'POST', '/api/milestones/subtasks/' + subtaskId + '/complete',
    { outcome: 'Delayed', delaySide: 'Company Side', delayNotes: 'Environment rebuild overran.' });
  var completed = await call('admin', 'POST', '/api/milestones/' + milestone.id + '/complete',
    { outcome: 'On-Time' });
  check('milestone completed', completed.data.completed === true);
  check('  completion date set by the database',
    /^\d{4}-\d{2}-\d{2}$/.test(completed.data.completedAt), completed.data.completedAt);

  var submitted = await call('admin', 'POST', '/api/milestones/' + milestone.id + '/submit');
  check('submitted for approval', submitted.data.approval === 'pending', submitted.data.approval);

  var early = await call('poc', 'POST', '/api/milestones/' + milestone.id + '/approve',
    { rating: 5, comment: 'Fine.' });
  check('approve is refused while a delay is undecided', early.status === 409, early.data.error);

  var forgedConsent = await call('poc', 'POST', '/api/milestones/' + milestone.id + '/approve',
    { rating: 5, comment: 'Fine.', delayAgreements: { milestone: true, subtasks: [subtaskId] } });
  check('  and a forged delayAgreements payload buys nothing',
    forgedConsent.status === 409, String(forgedConsent.status));

  var adminDecides = await call('admin', 'POST', '/api/delays/subtask/' + subtaskId + '/decision',
    { decision: 'accepted', body: 'I accept my own delay.' });
  check('an admin cannot decide a delay', adminDecides.status === 403, String(adminDecides.status));

  var noReason = await call('poc', 'POST', '/api/delays/subtask/' + subtaskId + '/decision',
    { decision: 'denied', body: '   ' });
  check('denying with no reason is refused', noReason.status === 409, noReason.data.error);

  var denied = await call('poc', 'POST', '/api/delays/subtask/' + subtaskId + '/decision',
    { decision: 'denied', body: 'That was scheduled. Not acceptable.' });
  check('the POC denies the delay', denied.status === 200, JSON.stringify(denied.data).slice(0, 100));
  var deniedSub = denied.data.subtasks.find(function (s) { return s.id === subtaskId; });
  check('  status persisted', deniedSub.delayStatus === 'denied', deniedSub.delayStatus);
  check('  the thread carries the decision',
    deniedSub.delayComments.length === 1 && deniedSub.delayComments[0].decision === 'denied');

  var stillBlocked = await call('poc', 'POST', '/api/milestones/' + milestone.id + '/approve',
    { rating: 5, comment: 'Fine.' });
  check('approve still blocked', stillBlocked.status === 409 && /denied/.test(stillBlocked.data.error),
    stillBlocked.data.error);

  var replyToAccepted = await call('admin', 'POST', '/api/delays/milestone/' + milestone.id + '/comments',
    { body: 'Context on an undelayed milestone.' });
  check('admin cannot comment on a milestone that is not delayed',
    replyToAccepted.status === 409, String(replyToAccepted.status));

  var adminReply = await call('admin', 'POST', '/api/delays/subtask/' + subtaskId + '/comments',
    { body: 'Here is the change record that authorised it.' });
  check('admin CAN reply on the denied delay', adminReply.status === 200,
    JSON.stringify(adminReply.data).slice(0, 100));
  var thread = adminReply.data.subtasks.find(function (s) { return s.id === subtaskId; }).delayComments;
  check('  thread is partner then admin, in order',
    thread.map(function (c) { return c.authorRole; }).join(',') === 'partner,admin',
    thread.map(function (c) { return c.authorRole; }).join(','));

  var accepted = await call('poc', 'POST', '/api/delays/subtask/' + subtaskId + '/decision',
    { decision: 'accepted', body: 'The record settles it.' });
  check('the POC flips it to accepted',
    accepted.data.subtasks.find(function (s) { return s.id === subtaskId; }).delayStatus === 'accepted');

  var approved = await call('poc', 'POST', '/api/milestones/' + milestone.id + '/approve',
    { rating: 4, comment: 'Approved after discussion.' });
  check('approve now succeeds', approved.status === 200, JSON.stringify(approved.data).slice(0, 120));
  check('  milestone reads approved', approved.data.approval === 'approved');

  var afterApproval = await call('poc', 'POST', '/api/delays/subtask/' + subtaskId + '/decision',
    { decision: 'denied', body: 'Changed my mind.' });
  check('delays cannot be re-decided after approval', afterApproval.status === 409);

  // ---------------------------------------------------------------
  section('accepting closes the conversation');

  // A fresh delayed sub-task, submitted and awaiting a decision
  var m3 = (await call('admin', 'POST', '/api/milestones',
    { projectId: projectId, title: 'Closure' })).data;
  var s3 = (await call('admin', 'POST', '/api/milestones/' + m3.id + '/subtasks',
    { title: 'Closable task' })).data.subtasks[0];
  await call('admin', 'POST', '/api/milestones/subtasks/' + s3.id + '/complete',
    { outcome: 'Delayed', delaySide: 'Company Side', delayNotes: 'Slipped a week.' });
  await call('admin', 'POST', '/api/milestones/' + m3.id + '/complete', { outcome: 'On-Time' });
  await call('admin', 'POST', '/api/milestones/' + m3.id + '/submit');

  // While pending, the admin has nothing to say yet
  check('admin cannot comment before a decision',
    (await call('admin', 'POST', '/api/delays/subtask/' + s3.id + '/comments',
      { body: 'Getting ahead of myself.' })).status === 409);

  // Deny: the thread opens for both sides
  var den = await call('poc', 'POST', '/api/delays/subtask/' + s3.id + '/decision',
    { decision: 'denied', body: 'A week is too much.' });
  check('denying opens the thread', den.status === 200, JSON.stringify(den.data).slice(0, 90));
  check('  admin may now reply',
    (await call('admin', 'POST', '/api/delays/subtask/' + s3.id + '/comments',
      { body: 'Here is why.' })).status === 200);
  check('  and the partner may keep talking',
    (await call('poc', 'POST', '/api/delays/subtask/' + s3.id + '/comments',
      { body: 'Still not convinced.' })).status === 200);

  // Accept: the thread closes for everyone
  var acc = await call('poc', 'POST', '/api/delays/subtask/' + s3.id + '/decision',
    { decision: 'accepted', body: 'Fine, accepted.' });
  check('accepting settles it',
    acc.data.subtasks.find(function (x) { return x.id === s3.id; }).delayStatus === 'accepted');

  check('  the admin can no longer reply',
    (await call('admin', 'POST', '/api/delays/subtask/' + s3.id + '/comments',
      { body: 'One more thing.' })).status === 409);
  check('  nor can the partner',
    (await call('poc', 'POST', '/api/delays/subtask/' + s3.id + '/comments',
      { body: 'Actually...' })).status === 409);

  var reopen = await call('poc', 'POST', '/api/delays/subtask/' + s3.id + '/decision',
    { decision: 'denied', body: 'Changed my mind after all.' });
  check('  and an acceptance cannot be reversed', reopen.status === 409, reopen.data.error);
  check('  the message says why', /settled and cannot be changed/.test(reopen.data.error || ''),
    reopen.data.error);

  section('feedback visibility');
  var adminSees = await call('admin', 'GET', '/api/projects/' + projectId);
  var pocSees = await call('poc', 'GET', '/api/projects/' + projectId);
  check('admin sees the feedback',
    adminSees.data.milestones[0].feedback && adminSees.data.milestones[0].feedback.rating === 4);
  check('the partner does not', pocSees.data.milestones[0].feedback === null,
    JSON.stringify(pocSees.data.milestones[0].feedback));

  // ---------------------------------------------------------------
  section('attachments');
  var m2 = (await call('admin', 'POST', '/api/milestones',
    { projectId: projectId, title: 'Second' })).data;
  var s2 = (await call('admin', 'POST', '/api/milestones/' + m2.id + '/subtasks',
    { title: 'Delayed task' })).data.subtasks[0];
  await call('admin', 'POST', '/api/milestones/subtasks/' + s2.id + '/complete',
    { outcome: 'Delayed', delaySide: 'Company Side', delayNotes: 'Slipped.' });
  await call('admin', 'POST', '/api/milestones/' + m2.id + '/complete', { outcome: 'On-Time' });
  await call('admin', 'POST', '/api/milestones/' + m2.id + '/submit');

  var badType = await call('poc', 'POST', '/api/delays/subtask/' + s2.id + '/upload-url',
    { filename: 'payload.svg', bytes: 100 });
  check('.svg is refused an upload URL', badType.status === 400, badType.data.error);

  var tooBig = await call('poc', 'POST', '/api/delays/subtask/' + s2.id + '/upload-url',
    { filename: 'huge.pdf', bytes: 11 * 1024 * 1024 });
  check('an 11MB file is refused up front', tooBig.status === 400, tooBig.data.error);

  var outsiderTicket = await call('outsider', 'POST', '/api/delays/subtask/' + s2.id + '/upload-url',
    { filename: 'sneaky.pdf', bytes: 1000 });
  check('a non-POC cannot get an upload URL', outsiderTicket.status === 404,
    String(outsiderTicket.status));

  var ticket = await call('poc', 'POST', '/api/delays/subtask/' + s2.id + '/upload-url',
    { filename: 'evidence.pdf', bytes: 2048 });
  check('the POC gets an upload URL', ticket.status === 200, JSON.stringify(ticket.data).slice(0, 80));
  check('  stored under a UUID, not the given name',
    /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/.test(ticket.data.objectPath), ticket.data.objectPath);

  var unclaimed = await call('poc', 'POST', '/api/delays/subtask/' + s2.id + '/decision',
    { decision: 'denied', body: 'See attached.', objectPath: ticket.data.objectPath });
  check('claiming an object never uploaded is refused', unclaimed.status === 400, unclaimed.data.error);

  harness.putObject(ticket.data.token, 2048);        // the browser's PUT
  var withFile = await call('poc', 'POST', '/api/delays/subtask/' + s2.id + '/decision',
    { decision: 'denied', body: 'See attached.', objectPath: ticket.data.objectPath });
  check('the upload is claimed by the comment', withFile.status === 200,
    JSON.stringify(withFile.data).slice(0, 120));
  var attachment = withFile.data.subtasks.find(function (s) { return s.id === s2.id; })
    .delayComments[0].attachments[0];
  check('  recorded on the comment', !!attachment && attachment.filename === 'evidence.pdf',
    JSON.stringify(attachment));
  check('  with a server-derived MIME', attachment.mime === 'application/pdf', attachment.mime);

  var reclaim = await call('poc', 'POST', '/api/delays/subtask/' + s2.id + '/comments',
    { body: 'Again.', objectPath: ticket.data.objectPath });
  check('the same object cannot be claimed twice', reclaim.status === 400, reclaim.data.error);

  var download = await call('poc', 'GET', '/api/delays/attachments/' + attachment.id + '?json=1');
  check('the POC can get a download URL', download.status === 200, String(download.status));
  check('  which forces a download', /download=evidence.pdf/.test(download.data.url || ''),
    download.data.url);

  var outsiderDownload = await call('outsider', 'GET', '/api/delays/attachments/' + attachment.id);
  check('a non-POC gets 404 for the attachment', outsiderDownload.status === 404,
    String(outsiderDownload.status));
  check('signed out gets 401',
    (await call('nobody', 'GET', '/api/delays/attachments/' + attachment.id)).status === 401);

  // ---------------------------------------------------------------
  section('hardening');
  var headers = (await call('admin', 'GET', '/api/auth/me')).headers;
  check('X-Content-Type-Options is set', headers.get('x-content-type-options') === 'nosniff');
  check('a CSP is present', !!headers.get('content-security-policy'));
  check('frames are denied',
    /frame-ancestors 'none'/.test(headers.get('content-security-policy') || ''));
  check('a request id is returned', !!headers.get('x-request-id'));
  check('x-powered-by is gone', !headers.get('x-powered-by'));

  var oversized = await fetch(BASE + '/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: jars.admin },
    body: JSON.stringify({ code: 'X', title: 'x'.repeat(400000), type: 'Migration' })
  });
  check('an oversized body is rejected', oversized.status === 413, String(oversized.status));

  var badJson = await fetch(BASE + '/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: jars.admin },
    body: '{ not json'
  });
  check('malformed JSON is a 400, not a 500', badJson.status === 400, String(badJson.status));

  var missing = await call('admin', 'GET', '/api/nope');
  check('an unknown /api path returns JSON, not HTML',
    missing.status === 404 && missing.data && !!missing.data.error);

  var cron = await call('nobody', 'POST', '/api/internal/cron');
  check('the cron endpoint needs its secret', cron.status === 401, String(cron.status));
  var cronOk = await call('nobody', 'POST', '/api/internal/cron', undefined,
    { headers: { Authorization: 'Bearer test-cron-secret' } });
  check('  and runs with it', cronOk.status === 200, JSON.stringify(cronOk.data).slice(0, 120));

  // ---------------------------------------------------------------
  section('audit trail');
  var auditPage = await call('admin', 'GET', '/api/audit?limit=5');
  check('audit is paginated', Array.isArray(auditPage.data.entries) &&
    auditPage.data.entries.length <= 5, JSON.stringify(auditPage.data).slice(0, 80));
  check('  and records the delay decisions',
    (await call('admin', 'GET', '/api/audit?limit=200')).data.entries
      .some(function (e) { return e.action === 'Delay denied'; }));
  check('a partner cannot read the audit trail',
    (await call('poc', 'GET', '/api/audit')).status === 403);

  // ---------------------------------------------------------------
  section('password change');
  var wrongCurrent = await call('admin', 'POST', '/api/auth/password',
    { currentPassword: 'nope', newPassword: 'BrandNewPassword1' });
  check('the wrong current password is refused', wrongCurrent.status === 400, wrongCurrent.data.error);

  var tooShort = await call('admin', 'POST', '/api/auth/password',
    { currentPassword: 'AdminPassword1', newPassword: 'short' });
  check('a short new password is refused', tooShort.status === 400, tooShort.data.error);

  var changed = await call('admin', 'POST', '/api/auth/password',
    { currentPassword: 'AdminPassword1', newPassword: 'BrandNewPassword1' });
  check('the password changes', changed.status === 200, JSON.stringify(changed.data));
  check('  and this browser stays signed in',
    (await call('admin', 'GET', '/api/auth/me')).status === 200);
  check('  the old password no longer works',
    (await call('throwaway', 'POST', '/api/auth/login',
      { email: 'admin@example.test', password: 'AdminPassword1' })).status === 401);

  section('forgot password');
  await call('nobody2', 'POST', '/api/auth/forgot', { email: 'poc@example.test' });
  var forgot = await call('nobody2', 'POST', '/api/auth/forgot', { email: 'admin@example.test' });
  var forgotUnknown = await call('nobody3', 'POST', '/api/auth/forgot', { email: 'ghost@example.test' });
  check('forgot-password answers identically for a real and an unknown address',
    forgot.status === forgotUnknown.status &&
    JSON.stringify(forgot.data) === JSON.stringify(forgotUnknown.data),
    JSON.stringify(forgot.data) + ' vs ' + JSON.stringify(forgotUnknown.data));

  // The emailed link carries a token_hash and nothing else — no address to
  // re-type, and one fewer field a caller can get wrong.
  var hash = 'recovery-poc@example.test';
  check('requesting a reset minted a usable link', harness.recoveryHashes.has(hash));

  var shortReset = await call('nobody4', 'POST', '/api/auth/reset',
    { tokenHash: hash, newPassword: 'short' });
  check('a short new password is refused', shortReset.status === 400, shortReset.data.error);

  var reset = await call('nobody4', 'POST', '/api/auth/reset',
    { tokenHash: hash, newPassword: 'ResetPassword123' });
  check('a valid reset link sets a new password', reset.status === 200, JSON.stringify(reset.data));
  check('  and signs the browser in', !!reset.setCookies.length);
  check('  the new password works',
    (await call('resetcheck', 'POST', '/api/auth/login',
      { email: 'poc@example.test', password: 'ResetPassword123' })).status === 200);
  check('  and the link cannot be used twice',
    (await call('nobody6', 'POST', '/api/auth/reset',
      { tokenHash: hash, newPassword: 'AnotherPassword123' })).status === 400);
  check('an invalid link is refused',
    (await call('nobody5', 'POST', '/api/auth/reset',
      { tokenHash: 'nope', newPassword: 'ResetPassword123' })).status === 400);

  // ---------------------------------------------------------------
  section('logout');
  await call('poc', 'POST', '/api/auth/logout');
  check('logging out clears the cookies',
    (await call('poc', 'GET', '/api/auth/me')).status === 401);

  console.log('\n================  ' + pass + ' passed, ' + fail + ' failed  ================');
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(function (f) { console.log('  · ' + f); });
  }

  server.close();
  await sql.close();
  process.exit(fail ? 1 : 0);
})().catch(function (err) {
  console.error('\nHARNESS ERROR:', err.stack || err.message);
  process.exit(2);
});
