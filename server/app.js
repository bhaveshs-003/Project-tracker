/**
 * The Express application.
 *
 * Exported rather than listened on, because the same app is both a local
 * server (server/index.js) and a serverless function (api/index.js). Nothing
 * in here may assume a long-running process, a writable filesystem, or that
 * the next request lands on the same instance.
 */

var crypto = require('crypto');
var express = require('express');
var helmet = require('helmet');
var path = require('path');

var sql = require('./sql');
var guards = require('./guards');
var audit = require('./audit');
var outbox = require('./mail/outbox');
var uploads = require('./uploads');
var transport = require('./mail/transport');

var app = express();

// Behind Vercel's proxy. Without this req.ip is the proxy's address, which
// would make the rate limiter count the whole internet as one client, and
// req.secure is false, which would stop Secure cookies being set.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ---------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // The frontend is plain ES modules served from this origin; no inline
      // script and no CDN, so the policy can stay strict.
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      // Signed Storage URLs are on the Supabase domain
      connectSrc: ["'self'", process.env.SUPABASE_URL || "'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
    }
  },
  hsts: process.env.NODE_ENV === 'production'
    ? { maxAge: 31536000, includeSubDomains: true, preload: false }
    : false,
  // Downloads redirect to Supabase, which is a different origin
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

// An explicit cap. The default is 100kb, which is fine — but it should be a
// decision rather than a default, and the error should be readable.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '256kb' }));

// ---------------------------------------------------------------
// Request log. Every /api call, what it carried, how it ended.
// The request id is what ties a user's "it failed" to a line in the log.
// ---------------------------------------------------------------
app.use('/api', function (req, res, next) {
  var started = Date.now();
  req.id = crypto.randomUUID().slice(0, 8);
  res.setHeader('X-Request-Id', req.id);

  res.on('finish', function () {
    console.log('[api] ' + req.id + ' ' + req.method + ' ' + req.originalUrl +
      ' -> ' + res.statusCode +
      ' user=' + (req.user ? req.user.id + '/' + req.user.role : '-') +
      ' (' + (Date.now() - started) + 'ms)');
  });
  next();
});

// ---------------------------------------------------------------
// API
// ---------------------------------------------------------------
app.get('/api/health', function (req, res) {
  // Deliberately shallow and unauthenticated: a health check that queries the
  // database is a free amplification endpoint. Depth lives behind /ready.
  res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
});

app.get('/api/ready', guards.requireAuth, guards.requireRole('admin'), function (req, res, next) {
  Promise.all([sql.healthy(), outbox.stats()]).then(function (results) {
    res.json({
      ok: results[0],
      database: results[0] ? 'up' : 'down',
      mail: Object.assign({ transport: transport.config.transport }, results[1])
    });
  }).catch(next);
});

app.use('/api/auth', require('./routes/session'));
app.use('/api/people', require('./routes/people'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/milestones', require('./routes/milestones'));
app.use('/api/delays', require('./routes/delays'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/emails', require('./routes/emails'));

/**
 * Scheduled work. Called by pg_cron inside Supabase, not by Vercel Cron, whose
 * free tier only fires daily. Authenticated with a shared secret compared in
 * constant time.
 */
app.post('/api/internal/cron', guards.requireCronSecret, function (req, res, next) {
  (async function () {
    await outbox.releaseStaleLocks();
    var drained = await outbox.drain();

    // Housekeeping runs on the same tick but must never stop mail going out,
    // so each is allowed to fail on its own.
    var housekeeping = await Promise.allSettled([
      uploads.sweepUnclaimed(24),
      uploads.sweepClaimed(7),
      guards.pruneAuthAttempts(),
      audit.prune()
    ]);

    res.json({
      mail: drained,
      housekeeping: housekeeping.map(function (r) {
        return r.status === 'fulfilled' ? r.value : 'failed: ' + r.reason.message;
      })
    });
  })().catch(next);
});

// An unknown /api path must answer as JSON. Falling through to index.html
// hands the client HTML where it expects data, which reads exactly like a
// broken session.
app.use('/api', function (req, res) {
  res.status(404).json({ error: 'No such endpoint: ' + req.method + ' ' + req.originalUrl });
});

// ---------------------------------------------------------------
// Static frontend + SPA catch-all
//
// On Vercel the CDN serves public/ and never reaches these; they are here so
// `npm start` behaves identically on a laptop.
// ---------------------------------------------------------------
var PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.get('*', function (req, res) {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---------------------------------------------------------------
// Errors
//
// rules.js and scope.js throw with a status attached, and those messages are
// written for the user. A 500 is not: it may carry a SQL fragment, a column
// name or a driver detail, so the client gets a generic sentence and the real
// error goes to the log against the request id.
// ---------------------------------------------------------------
app.use(function (err, req, res, next) {
  var status = err.status || err.statusCode || 500;

  // express.json rejects an oversized or malformed body with its own error
  if (err.type === 'entity.too.large') {
    status = 413;
    err.message = 'That request is too large.';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    err.message = 'That request body is not valid JSON.';
  }

  if (status >= 500) {
    console.error('[error] ' + (req.id || '-') + ' ' + req.method + ' ' + req.originalUrl,
      err.query ? '\n  query: ' + err.query : '', '\n ', err.stack || err.message);
    return res.status(status).json({
      error: 'Something went wrong on our side. Quote reference ' + (req.id || 'unknown') + '.',
      requestId: req.id
    });
  }

  res.status(status).json({ error: err.message || 'Request failed' });
});

module.exports = app;
