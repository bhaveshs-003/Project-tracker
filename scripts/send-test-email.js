/**
 * Send one real email, to prove the SMTP credentials work.
 *
 *   node scripts/send-test-email.js bhavesh.s@makoitlab.com
 *
 * This deliberately bypasses the outbox and the app entirely. If it fails, the
 * problem is the SMTP configuration and nothing else — which is the whole point
 * of having it separate from the notification pipeline.
 *
 * For Google Workspace:
 *
 *   export MAIL_TRANSPORT=smtp
 *   export SMTP_HOST=smtp.gmail.com
 *   export SMTP_PORT=587
 *   export SMTP_USER=abishek.m@makoitlab.com
 *   export SMTP_PASS='xxxx xxxx xxxx xxxx'     # App Password; spaces are fine
 *   export MAIL_FROM='Functional Tool <abishek.m@makoitlab.com>'
 *   node scripts/send-test-email.js bhavesh.s@makoitlab.com
 */

var transport = require('../server/mail/transport');

var recipient = process.argv[2];

function die(message, hint) {
  console.error('\n  FAILED  ' + message);
  if (hint) console.error('\n  ' + hint.split('\n').join('\n  '));
  console.error('');
  process.exit(1);
}

if (!recipient || recipient === '--help' || recipient === '-h') {
  console.log('\nUsage: node scripts/send-test-email.js <recipient@example.com>\n');
  console.log('Sends one real email through the configured SMTP server.');
  console.log('See the header of server/mail/transport.js for the settings.\n');
  process.exit(recipient ? 0 : 1);
}

// ---------------------------------------------------------------
// 1. Show what the process actually resolved. Most failures here are a
//    variable that never reached Node, and this makes that obvious.
// ---------------------------------------------------------------
var smtp = transport.smtpSettings();

console.log('\n  Resolved configuration');
console.log('  ----------------------');
console.log('  transport : ' + transport.config.transport);
console.log('  from      : ' + transport.config.from);
console.log('  host      : ' + smtp.host + ':' + smtp.port + (smtp.secure ? ' (TLS)' : ' (STARTTLS)'));
console.log('  user      : ' + smtp.user);
console.log('  password  : ' + (smtp.passLength
  ? smtp.passLength + ' characters after removing spaces'
  : 'NOT SET'));
console.log('  allowlist : ' + (transport.config.allowlist.length
  ? transport.config.allowlist.join(', ')
  : '(empty — every recipient is allowed)'));
console.log('  to        : ' + recipient);
console.log('');

// ---------------------------------------------------------------
// 2. Refuse rather than quietly writing another .eml and looking successful
// ---------------------------------------------------------------
if (transport.config.transport !== 'smtp') {
  die('MAIL_TRANSPORT is "' + transport.config.transport + '", not "smtp".',
    'Nothing would be sent — the log transport just writes a file into data/outbox/.\n' +
    'Set MAIL_TRANSPORT=smtp along with the SMTP_* variables and run this again.');
}

if (!smtp.passLength) {
  die('SMTP_PASS is empty.',
    'For Google Workspace this must be a 16-character App Password, not the\n' +
    'account login password. Create one at https://myaccount.google.com/apppasswords\n' +
    '(the page only exists once 2-Step Verification is enabled).');
}

if (!transport.allowed(recipient)) {
  die(recipient + ' is not on MAIL_ALLOWLIST, so it would be skipped rather than sent.',
    'Either add it to MAIL_ALLOWLIST or unset that variable for this test.');
}

var fromAddress = (transport.config.from.match(/<([^>]+)>/) || [])[1] || transport.config.from;
if (smtp.user !== '(none)' && fromAddress.toLowerCase() !== smtp.user.toLowerCase()) {
  console.log('  NOTE  MAIL_FROM (' + fromAddress + ') differs from SMTP_USER (' + smtp.user + ').');
  console.log('        Google rewrites a From header it does not recognise, so the message');
  console.log('        may arrive from ' + smtp.user + ' instead. Continuing anyway.\n');
}

// ---------------------------------------------------------------
// 3. Verify the connection before composing anything, so an auth problem is
//    distinguishable from a rejected message.
// ---------------------------------------------------------------
function explain(err) {
  var code = err.code || '';
  var response = err.response || '';

  if (code === 'EAUTH' || /535|534/.test(response)) {
    return 'The server rejected the credentials.\n' +
      '  · Use an App Password, not the normal login password.\n' +
      '  · 2-Step Verification must be enabled on ' + smtp.user + '.\n' +
      '  · A Workspace admin can disable App Passwords org-wide — if\n' +
      '    myaccount.google.com/apppasswords shows nothing, that is why.';
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION') {
    return 'Could not reach ' + smtp.host + ':' + smtp.port + ' within the timeout.\n' +
      '  · Check the host and port (587 for STARTTLS, 465 with SMTP_SECURE=true).\n' +
      '  · A firewall or network policy may be blocking outbound SMTP.';
  }
  if (code === 'EENVELOPE') {
    return 'The server accepted the connection but rejected the addresses.\n' +
      '  · MAIL_FROM must match SMTP_USER or a verified "Send mail as" alias.';
  }
  return 'Raw error code: ' + (code || '(none)') + '\n  Server said: ' + (response || '(nothing)');
}

(async function () {
  try {
    process.stdout.write('  Verifying connection and credentials … ');
    await transport.verify();
    console.log('OK');
  } catch (err) {
    console.log('FAILED');
    die(err.message, explain(err));
  }

  var stamp = new Date().toISOString();
  try {
    process.stdout.write('  Sending test message … ');
    await transport.send({
      to: recipient,
      toName: '',
      subject: 'Functional Tool — SMTP test (' + stamp.slice(0, 16).replace('T', ' ') + ')',
      text: [
        'This is a test message from Functional Tool.',
        '',
        'If you are reading it, the SMTP configuration works and approval',
        'notifications will reach this address.',
        '',
        'Sent at : ' + stamp,
        'From    : ' + transport.config.from,
        'Via     : ' + smtp.host + ':' + smtp.port,
        '',
        'Nothing in the app changed as a result of this message — it was sent',
        'directly, bypassing the notification outbox.'
      ].join('\n')
    });
    console.log('OK');
  } catch (err) {
    console.log('FAILED');
    die(err.message, explain(err));
  }

  console.log('\n  Sent to ' + recipient + '. Check that inbox (and the spam folder).');
  console.log('  If it arrived, start the app with the same variables and the approval');
  console.log('  notifications will go out for real.\n');
})();
