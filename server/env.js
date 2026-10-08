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

function load() {
  if (!fs.existsSync(FILE)) return 0;

  var loaded = 0;
  fs.readFileSync(FILE, 'utf8').split('\n').forEach(function (line) {
    var trimmed = line.trim();
    if (!trimmed || trimmed.charAt(0) === '#') return;

    var eq = trimmed.indexOf('=');
    if (eq < 1) return;

    var key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) return;    // real environment wins

    var value = trimmed.slice(eq + 1).trim();
    // Strip one layer of matching quotes, so a value with spaces survives
    if (value.length > 1 &&
      ((value[0] === '"' && value[value.length - 1] === '"') ||
       (value[0] === "'" && value[value.length - 1] === "'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    loaded++;
  });
  return loaded;
}

module.exports = { load: load, loaded: load() };
