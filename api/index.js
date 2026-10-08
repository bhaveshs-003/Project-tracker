/**
 * Vercel entry point.
 *
 * Exports the app as a serverless handler. Nothing is started here: there is
 * no listen(), no timer and no warm-up, because the process may be frozen
 * between requests and will not be the same instance next time.
 *
 * Scheduled work runs through POST /api/internal/cron, called by pg_cron
 * inside Supabase. See server/app.js.
 */

require('../server/env');

module.exports = require('../server/app');
