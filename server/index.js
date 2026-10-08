/**
 * Local server.
 *
 *   npm install
 *   npm start          →  http://localhost:3000
 *
 * On Vercel the entry point is api/index.js instead; both load the same
 * server/app.js, so what runs locally is what runs deployed.
 *
 * The frontend is served from this same origin on purpose: the session cookie
 * is then sent automatically and there is no CORS to configure.
 *
 * Configuration lives entirely in the environment — see .env.example.
 * To create the two seeded accounts: node scripts/seed.js
 */

require('./env');

var app = require('./app');
var sql = require('./sql');
var outbox = require('./mail/outbox');
var transport = require('./mail/transport');

var PORT = process.env.PORT || 3000;

var server = app.listen(PORT, function () {
  console.log('Functional Tool running at http://localhost:' + PORT);
  console.log('Database: ' + String(process.env.DATABASE_URL || '').replace(/:[^:@/]+@/, ':****@'));
  console.log('[mail] transport=' + transport.config.transport);

  // Only here, never in the serverless entry point: a long-running process can
  // hold a timer, a function invocation cannot. In production pg_cron calls
  // /api/internal/cron instead.
  if (process.env.MAIL_WORKER_MS !== 'off') {
    var every = Number(process.env.MAIL_WORKER_MS || 15000);
    var tick = function () {
      outbox.drain().catch(function (err) {
        console.error('[mail] worker error:', err.message);
      });
    };
    tick();
    var timer = setInterval(tick, every);
    timer.unref();
    console.log('[mail] local outbox worker every ' + Math.round(every / 1000) + 's');
  }
});

/**
 * Finish in-flight requests, then let the pool go. Without this a deploy or a
 * Ctrl-C drops whatever was mid-transaction.
 */
function shutdown(signal) {
  console.log('\n' + signal + ' received, shutting down');
  server.close(function () {
    sql.close()
      .then(function () { process.exit(0); })
      .catch(function () { process.exit(1); });
  });
  // Do not hang forever on a stuck connection
  setTimeout(function () {
    console.error('Shutdown timed out, exiting anyway');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', function () { shutdown('SIGTERM'); });
process.on('SIGINT', function () { shutdown('SIGINT'); });

module.exports = server;
