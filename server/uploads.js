/**
 * File attachments for delay comments.
 *
 * Three rules make this safe, and all three matter:
 *
 *  1. The extension is the gate. If it is not on the allowlist the request is
 *     refused — the browser's declared MIME type is never trusted, it is
 *     *derived* from the extension, so the stored value cannot be forged.
 *  2. Nothing user-controlled reaches the filesystem. The original name is a
 *     database column that only ever gets echoed back as escaped text; on disk
 *     the file is a UUID, so "../../.." and friends have nowhere to go.
 *  3. Uploads live in data/, which is not served statically, and come back only
 *     through an authenticated route that forces a download.
 *
 * Together those mean an uploaded file cannot be executed in this app's origin,
 * which is the failure mode that turns an attachment feature into stored XSS.
 */

var crypto = require('crypto');
var fs = require('fs');
var multer = require('multer');
var path = require('path');

var UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
var MAX_BYTES = 10 * 1024 * 1024;

// Extension → the MIME we record for it. The client's Content-Type is ignored.
var ALLOWED = {
  '.pdf':  'application/pdf',
  '.doc':  'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls':  'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg'
};

var EXTENSIONS = Object.keys(ALLOWED);
var ACCEPT_ATTRIBUTE = EXTENSIONS.join(',');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** The extension of the name the user gave us, lowercased. Never used as a path. */
function extensionOf(originalName) {
  return path.extname(String(originalName || '')).toLowerCase();
}

function isAllowed(originalName) {
  return Object.prototype.hasOwnProperty.call(ALLOWED, extensionOf(originalName));
}

var storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, UPLOAD_DIR); },
  filename: function (req, file, cb) {
    // basename() on our own generated string is belt-and-braces: the name is a
    // UUID plus an extension already checked against the allowlist.
    cb(null, path.basename(crypto.randomUUID() + extensionOf(file.originalname)));
  }
});

function fileFilter(req, file, cb) {
  if (!isAllowed(file.originalname)) {
    var err = new Error('Only ' + EXTENSIONS.join(', ') + ' files can be attached.');
    err.status = 400;
    err.code = 'FT_BAD_FILE_TYPE';
    return cb(err);
  }
  cb(null, true);
}

// One optional file per comment, under the field name "attachment"
var single = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: MAX_BYTES, files: 1, fields: 10 }
}).single('attachment');

/**
 * Wrap multer so its own errors arrive as 400s with a sentence worth reading,
 * rather than reaching the generic handler as a 500.
 */
function accept(req, res, next) {
  single(req, res, function (err) {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      err.status = 400;
      err.message = 'That file is larger than ' + Math.round(MAX_BYTES / 1024 / 1024) + 'MB.';
    } else if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      err.status = 400;
      err.message = 'Attach at most one file.';
    } else if (!err.status) {
      err.status = 400;
    }
    next(err);
  });
}

/**
 * multer writes to disk before the route runs, so anything that rejects the
 * request afterwards has to clean up or the directory fills with orphans.
 */
function discard(file) {
  if (!file || !file.path) return;
  fs.unlink(file.path, function () { /* already gone is fine */ });
}

/** The row to insert for an accepted upload. MIME comes from our table, not the client. */
function describe(file) {
  return {
    filename: String(file.originalname || 'attachment').slice(0, 255),
    stored_name: file.filename,
    mime: ALLOWED[extensionOf(file.originalname)] || 'application/octet-stream',
    bytes: file.size
  };
}

function pathOf(storedName) {
  // Resolve and re-check: a stored_name should always be a bare UUID, but this
  // is the one place a database value becomes a filesystem path.
  var full = path.join(UPLOAD_DIR, path.basename(String(storedName)));
  if (path.dirname(path.resolve(full)) !== path.resolve(UPLOAD_DIR)) return null;
  return full;
}

module.exports = {
  UPLOAD_DIR: UPLOAD_DIR,
  MAX_BYTES: MAX_BYTES,
  EXTENSIONS: EXTENSIONS,
  ACCEPT_ATTRIBUTE: ACCEPT_ATTRIBUTE,
  accept: accept,
  discard: discard,
  describe: describe,
  pathOf: pathOf
};
