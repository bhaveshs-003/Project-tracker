/**
 * Load .env for local development.
 *
 * Deliberately hand-rolled rather than pulling in dotenv: it is twenty lines,
 * and on Vercel the environment is already populated so this does nothing.
 * Variables already set always win, so an explicit `FOO=bar npm start` beats
 * the file.
 */

var fs = require('fs');
var path = require('path');

var FILE = path.join(__dirname, '..', '.env');

/**
 * Two rules, and the order they apply in matters:
 *
 *   1. Within the file, the LAST occurrence of a key wins. Appending a
 *      corrected value to the bottom of .env must override the stale one
 *      above it — which is what dotenv does, and what anyone editing the file
 *      expects. (This used to be first-wins, because the "already set" check
 *      ran inside the loop: paste a fixed DATABASE_URL at the bottom and the
 *      placeholder at the top silently beat it.)
 *
 *   2. The real environment beats the file entirely, so
 *      `FOO=bar npm start` still overrides.
 */
function load() {
  if (!fs.existsSync(FILE)) return 0;

  var fromFile = {};
  var seen = {};
  var duplicates = [];

  fs.readFileSync(FILE, 'utf8').split('\n').forEach(function (line) {
    var trimmed = line.trim();
    if (!trimmed || trimmed.charAt(0) === '#') return;

    var eq = trimmed.indexOf('=');
    if (eq < 1) return;

    var key = trimmed.slice(0, eq).trim();
    var value = trimmed.slice(eq + 1).trim();

    // Strip one layer of matching quotes, so a value with spaces survives
    if (value.length > 1 &&
      ((value[0] === '"' && value[value.length - 1] === '"') ||
       (value[0] === "'" && value[value.length - 1] === "'"))) {
      value = value.slice(1, -1);
    }

    if (seen[key] && duplicates.indexOf(key) === -1) duplicates.push(key);
    seen[key] = true;
    fromFile[key] = value;
  });

  // A duplicate key is almost always a half-finished edit. Say so — silently
  // picking one is how a stale connection string survives a correction.
  if (duplicates.length) {
    console.warn('[env] .env defines these more than once; the last wins: ' +
      duplicates.join(', '));
  }

  var loaded = 0;
  Object.keys(fromFile).forEach(function (key) {
    if (process.env[key] !== undefined) return;    // real environment wins
    process.env[key] = fromFile[key];
    loaded++;
  });
  return loaded;
}

module.exports = { load: load, loaded: load() };
