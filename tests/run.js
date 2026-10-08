/**
 * Run every suite, in the order that fails fastest.
 *
 *   npm test
 *
 * Each suite creates and drops its own database, so they are independent and
 * none of them touches development data.
 */

var { spawnSync } = require('child_process');
var path = require('path');

var SUITES = [
  ['schema', 'Schema shape and constraints'],
  ['api', 'HTTP surface, auth, rules, attachments'],
  ['concurrency', 'Pooling and the outbox race'],
  ['performance', 'N+1 regression'],
  ['browser', 'The frontend against the migrated backend']
];

var results = [];
var failed = 0;

SUITES.forEach(function (suite) {
  var name = suite[0];
  console.log('\n' + '='.repeat(64));
  console.log('  ' + name.toUpperCase() + ' — ' + suite[1]);
  console.log('='.repeat(64));

  // The browser suite drives Chrome over a WebSocket; Node 20 needs the flag.
  var args = name === 'browser' ? ['--experimental-websocket'] : [];
  var run = spawnSync(process.execPath,
    args.concat([path.join(__dirname, name + '.test.js')]), { stdio: 'inherit' });

  results.push({ name: name, ok: run.status === 0 });
  if (run.status !== 0) failed++;
});

console.log('\n' + '='.repeat(64));
results.forEach(function (r) {
  console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.name);
});
console.log('='.repeat(64));
console.log(failed ? '\n  ' + failed + ' suite(s) failed\n' : '\n  All suites passed\n');
process.exit(failed ? 1 : 0);
