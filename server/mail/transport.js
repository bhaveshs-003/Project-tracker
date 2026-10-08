/**
 * The transport seam.
 *
 * Everything above this file builds a plain { to, subject, text, html } object.
 * This is the only place that knows what happens to it — which is why tests and
 * local development never need a mail server, and why swapping providers later
 * touches one file.
 *
 *   MAIL_TRANSPORT=log   (default)  write a .eml into data/outbox/, send nothing
 *   MAIL_TRANSPORT=smtp             nodemailer against any SMTP server
 *
 * Google Workspace (what this install uses) — no third-party service needed,
 * because the app authenticates as the admin's own mailbox:
 *
 *   MAIL_TRANSPORT=smtp
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=587                      # STARTTLS. For 465 set SMTP_SECURE=true
 *   SMTP_USER=you@example.com
 *   SMTP_PASS=<16-char Google App Password, NOT the login password>
 *   MAIL_FROM='Functional Tool <noreply@example.com>'
 *
 * MAIL_FROM must match SMTP_USER (or a verified "Send mail as" alias) — Google
 * silently rewrites a From header it does not recognise.
 *
 * App Passwords only exist once 2-Step Verification is enabled on the account:
 * https://myaccount.google.com/apppasswords . If that page is missing entirely,
 * a Workspace admin has disabled them org-wide.
 *
 * Test the credentials on their own with:
 *   node scripts/send-test-email.js someone@example.com
 *
 * MAIL_ALLOWLIST is the staging safety net: with a real SMTP server configured,
 * only the listed addresses are actually sent to. Everything else is recorded
 * as skipped rather than delivered.
 */

var fs = require('fs');
var os = require('os');
var path = require('path');

var OUTBOX_DIR = path.join(__dirname, '..', '..', 'data', 'outbox');

var config = {
  transport: process.env.MAIL_TRANSPORT || 'log',
  // Notifications come from the admin's own address, so replies reach a person.
  from: process.env.MAIL_FROM || 'Functional Tool <noreply@example.com>',
  appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
  allowlist: (process.env.MAIL_ALLOWLIST || '')
    .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean)
};

function allowed(address) {
  if (!config.allowlist.length) return true;
  return config.allowlist.indexOf(String(address).toLowerCase()) > -1;
}

// ---- log transport: the default, and what the tests run against ----

/**
 * Where the .eml actually goes.
 *
 * Resolved once, lazily, because `data/` is only writable on a laptop: a
 * serverless filesystem is read-only outside the temp directory, and
 * mkdirSync would throw on every notification. Falling back to tmpdir keeps
 * the transport working anywhere; returning null means write nowhere and just
 * log, which is still better than failing the approval that queued it.
 */
var resolvedOutbox;

function outboxDir() {
  if (resolvedOutbox !== undefined) return resolvedOutbox;

  var candidates = [OUTBOX_DIR, path.join(os.tmpdir(), 'functional-tool-outbox')];
  for (var i = 0; i < candidates.length; i++) {
    try {
      fs.mkdirSync(candidates[i], { recursive: true });
      fs.accessSync(candidates[i], fs.constants.W_OK);
      if (i > 0) console.log('[mail] outbox is not writable; using ' + candidates[i]);
      resolvedOutbox = candidates[i];
      return resolvedOutbox;
    } catch { /* try the next one */ }
  }

  console.warn('[mail] no writable outbox directory; messages will be logged only');
  resolvedOutbox = null;
  return resolvedOutbox;
}

function sendToDisk(message) {
  var dir = outboxDir();
  if (!dir) {
    console.log('[mail] (not written) → ' + message.to + '  "' + message.subject + '"');
    return { transport: 'log', file: null };
  }

  var stamp = new Date().toISOString().replace(/[:.]/g, '-');
  var safeTo = message.to.replace(/[^a-z0-9@._-]/gi, '_');
  var file = path.join(dir, stamp + '__' + safeTo + '.eml');

  // A real .eml so it opens in any mail client
  var eml = [
    'From: ' + config.from,
    'To: ' + (message.toName ? '"' + message.toName + '" <' + message.to + '>' : message.to),
    'Subject: ' + message.subject,
    'Date: ' + new Date().toUTCString(),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    message.text
  ].join('\r\n');

  fs.writeFileSync(file, eml);
  console.log('[mail] wrote ' + path.basename(file) + '  →  ' + message.to + '  "' + message.subject + '"');
  return { transport: 'log', file: file };
}

// ---- smtp transport ----
var smtpTransport = null;

function smtp() {
  if (smtpTransport) return smtpTransport;
  var nodemailer = require('nodemailer');
  smtpTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'localhost',
    port: Number(process.env.SMTP_PORT || 1025),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? {
          user: process.env.SMTP_USER,
          // Google shows app passwords as "abcd efgh ijkl mnop". Pasted with
          // the spaces, auth fails with nothing to suggest why.
          pass: String(process.env.SMTP_PASS || '').replace(/\s+/g, '')
        }
      : undefined,
    // Without these, an unreachable host leaves the outbox worker hanging until
    // the OS gives up. Fail fast instead and let the retry/backoff handle it.
    connectionTimeout: Number(process.env.SMTP_TIMEOUT_MS || 10000),
    greetingTimeout: Number(process.env.SMTP_TIMEOUT_MS || 10000),
    socketTimeout: Number(process.env.SMTP_TIMEOUT_MS || 10000)
  });
  return smtpTransport;
}

/**
 * Check the connection and credentials without composing a message, so
 * "wrong password" is distinguishable from "message rejected".
 */
function verify() {
  if (config.transport !== 'smtp') {
    return Promise.reject(new Error('MAIL_TRANSPORT is "' + config.transport +
      '" — there is no server to verify against.'));
  }
  return smtp().verify();
}

function smtpSettings() {
  return {
    host: process.env.SMTP_HOST || 'localhost',
    port: Number(process.env.SMTP_PORT || 1025),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '(none)',
    passLength: String(process.env.SMTP_PASS || '').replace(/\s+/g, '').length
  };
}

async function sendOverSmtp(message) {
  var info = await smtp().sendMail({
    from: config.from,
    to: message.toName ? { name: message.toName, address: message.to } : message.to,
    subject: message.subject,
    text: message.text,
    html: message.html || undefined
  });
  console.log('[mail] sent via smtp → ' + message.to + '  "' + message.subject + '"');
  return { transport: 'smtp', messageId: info.messageId };
}

/**
 * Deliver one message. Throws on failure — the outbox decides what to do about
 * that, because retry policy is not the transport's business.
 */
async function send(message) {
  if (!allowed(message.to)) {
    console.log('[mail] skipped (not on MAIL_ALLOWLIST) → ' + message.to);
    return { transport: 'skipped' };
  }
  if (config.transport === 'smtp') return sendOverSmtp(message);
  return sendToDisk(message);
}

// Tests swap this out to prove a broken mail server cannot break an approval
var override = null;
function setTransportForTesting(fn) { override = fn; }

module.exports = {
  config: config,
  send: function (message) { return (override || send)(message); },
  setTransportForTesting: setTransportForTesting,
  verify: verify,
  smtpSettings: smtpSettings,
  allowed: allowed,
  OUTBOX_DIR: OUTBOX_DIR
};
