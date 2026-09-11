/**
 * Functional Tool server.
 *
 *   npm install
 *   npm start          →  http://localhost:3000
 *
 * The frontend is served from this same origin on purpose: the session cookie
 * is then sent automatically and there is no CORS to configure. Opening
 * public/index.html off the filesystem cannot work, and the client says so.
 *
 * Seeded logins (see server/db.js):
 *   abishek.m@makoitlab.com   / Mako@123     → admin
 *   bhavesh.s@makoitlab.com   / Partner@123  → partner (POC on every project)
 *
 * To reset an existing database to these accounts:  node scripts/reset-accounts.js
 */

var express = require('express');
var path = require('path');

var store = require('./db');
var guards = require('./guards');
var outbox = require('./mail/outbox');

var PORT = process.env.PORT || 3000;
var PUBLIC_DIR = path.join(__dirname, '..', 'public');

var app = express();
app.use(express.json());

// ---------------------------------------------------------------
// Request log for /api — every call, what it carried, how it ended.
// This is what turns "auth is broken" into a specific line to read.
// ---------------------------------------------------------------
app.use('/api', function (req, res, next) {
  var started = Date.now();
  var who = (req.body && req.body.email) ? ' email=' + req.body.email : '';
  var cookie = (req.headers.cookie || '').indexOf(guards.SESSION_COOKIE) > -1 ? ' cookie=yes' : ' cookie=no';
  res.on('finish', function () {
    console.log('[api] ' + new Date().toISOString().slice(11, 19) + ' ' +
      req.method + ' ' + req.originalUrl + ' -> ' + res.statusCode + who + cookie +
      ' user=' + (req.user ? req.user.id + '/' + req.user.role : '-') +
      ' (' + (Date.now() - started) + 'ms)');
  });
  next();
});

// ---------------------------------------------------------------
// API
// ---------------------------------------------------------------
app.get('/api/health', function (req, res) {
  var counts = {
    accounts: store.db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    people: store.db.prepare('SELECT COUNT(*) AS n FROM people').get().n,
    projects: store.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,
    sessions: store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n
  };
  res.json({
    ok: true, db: store.file, counts: counts,
    mail: Object.assign({ transport: require('./mail/transport').config.transport }, outbox.stats()),
    uptimeSeconds: Math.round(process.uptime())
  });
});

app.use('/api/auth', require('./routes/session'));
app.use('/api/people', require('./routes/people'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/milestones', require('./routes/milestones'));
app.use('/api/delays', require('./routes/delays'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/emails', require('./routes/emails'));

// An unknown /api path must answer as JSON. Falling through to index.html
// hands the client HTML where it expects data, which reads exactly like a
// broken session.
app.use('/api', function (req, res) {
  res.status(404).json({ error: 'No such endpoint: ' + req.method + ' ' + req.originalUrl });
});

// ---------------------------------------------------------------
// Static frontend + SPA catch-all
// ---------------------------------------------------------------
app.use(express.static(PUBLIC_DIR));

// Any non-API path renders the app, so a deep link pasted into a fresh tab
// (/projects/PRJ-001) is served by the router rather than 404ing.
app.get('*', function (req, res) {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---------------------------------------------------------------
// Errors — rules.js and scope.js throw with a status attached
// ---------------------------------------------------------------
app.use(function (err, req, res, next) {
  // multer rejects oversized or disallowed uploads with its own error class.
  // Without this they arrive as a bare 500 and the user is told nothing useful.
  var status = err.status || (err.name === 'MulterError' ? 400 : 500);
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: err.message || 'Something went wrong' });
});

var pruned = guards.pruneExpiredSessions();
if (pruned) console.log('Pruned ' + pruned + ' expired session(s)');

app.listen(PORT, function () {
  console.log('Functional Tool running at http://localhost:' + PORT);
  console.log('Database: ' + store.file);

  // Drains the outbox on a timer, and once on boot so anything queued when the
  // process last died gets picked up.
  outbox.startWorker(Number(process.env.MAIL_WORKER_MS || 15000));
});
