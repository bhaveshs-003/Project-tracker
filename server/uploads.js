/**
 * File attachments, held in Supabase Storage.
 *
 * The file never passes through this process. A serverless function caps the
 * request body at 4.5MB, which a 10MB attachment cannot fit through, so the
 * browser uploads straight to Storage:
 *
 *   1. POST .../upload-url   Express checks permission, issues a signed upload
 *                            URL and records the intent in pending_uploads.
 *   2. PUT  <signed url>     The browser sends the bytes to Supabase directly.
 *   3. POST .../decision     The comment claims the object; Express verifies it
 *                            exists, is the right size and type, and belongs to
 *                            the person claiming it.
 *
 * The safety rules are unchanged from the disk version and still hold:
 *
 *  · The extension is the gate. The browser's declared MIME type is never
 *    trusted — it is derived from the extension, so the stored value cannot be
 *    forged.
 *  · Nothing user-controlled reaches a path. The original name is a database
 *    column; the object is a UUID.
 *  · The bucket is private. Downloads are short-lived signed URLs issued only
 *    after the scope check, and always as attachments.
 */

var crypto = require('crypto');
var path = require('path');
var sql = require('./sql');
var supabase = require('./supabase');

var BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'attachments';
var MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024);
var UPLOAD_URL_TTL = 120;     // seconds to start the upload
var DOWNLOAD_URL_TTL = 60;    // seconds a download link stays valid

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

function conflict(message) {
  var err = new Error(message);
  err.status = 400;
  return err;
}

/** The extension of the name the user gave us, lowercased. Never used as a path. */
function extensionOf(originalName) {
  return path.extname(String(originalName || '')).toLowerCase();
}

function mimeFor(originalName) {
  return ALLOWED[extensionOf(originalName)] || null;
}

/**
 * Step 1 — issue a signed upload URL.
 *
 * The caller has already proved they may comment on this delay; this only
 * validates the file itself and reserves a path.
 */
async function createUploadTicket(person, originalName, declaredBytes) {
  var filename = String(originalName || '').trim().slice(0, 255);
  var mime = mimeFor(filename);

  if (!mime) {
    throw conflict('Only ' + EXTENSIONS.join(', ') + ' files can be attached.');
  }
  var bytes = Number(declaredBytes);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw conflict('The file appears to be empty.');
  }
  if (bytes > MAX_BYTES) {
    throw conflict('That file is larger than ' + Math.round(MAX_BYTES / 1024 / 1024) + 'MB.');
  }

  // A UUID path, namespaced by the uploader so Storage policies can scope by
  // owner later without a schema change.
  var objectPath = person.id + '/' + crypto.randomUUID() + extensionOf(filename);

  var signed = await supabase.admin.storage.from(BUCKET)
    .createSignedUploadUrl(objectPath, { upsert: false });

  if (signed.error) {
    throw new Error('Could not prepare the upload: ' + signed.error.message);
  }

  await sql.run(
    `INSERT INTO pending_uploads (object_path, person_id, filename, mime)
     VALUES ($1, $2, $3, $4)`,
    [objectPath, person.id, filename, mime]);

  return {
    objectPath: objectPath,
    uploadUrl: signed.data.signedUrl,
    token: signed.data.token,
    bucket: BUCKET,
    expiresInSeconds: UPLOAD_URL_TTL,
    maxBytes: MAX_BYTES
  };
}

/**
 * Step 3 — verify an uploaded object before a comment claims it.
 *
 * Checks the reservation, the uploader, and then the object as Storage
 * actually sees it: a client could have reserved a 1KB .pdf and uploaded 50MB
 * of something else, so the declared size is re-read rather than believed.
 */
async function claimUpload(person, objectPath, runner) {
  var db = runner || sql;
  if (!objectPath) return null;

  var pending = await db.one(
    'SELECT * FROM pending_uploads WHERE object_path = $1', [String(objectPath)]);

  if (!pending) throw conflict('That upload was not recognised. Attach the file again.');
  if (pending.person_id !== person.id) throw conflict('That upload belongs to someone else.');
  if (pending.claimed_at) throw conflict('That upload has already been attached.');

  // What Storage actually holds, not what the client claimed
  var dir = path.posix.dirname(objectPath);
  var base = path.posix.basename(objectPath);
  var listed = await supabase.admin.storage.from(BUCKET)
    .list(dir, { search: base, limit: 1 });

  if (listed.error) throw new Error('Could not verify the upload: ' + listed.error.message);
  var object = (listed.data || []).filter(function (o) { return o.name === base; })[0];
  if (!object) throw conflict('The file was not uploaded. Try attaching it again.');

  var bytes = Number(object.metadata && object.metadata.size);
  if (!Number.isFinite(bytes) || bytes <= 0) throw conflict('The uploaded file is empty.');
  if (bytes > MAX_BYTES) {
    await remove(objectPath);
    throw conflict('That file is larger than ' + Math.round(MAX_BYTES / 1024 / 1024) + 'MB.');
  }

  await db.run('UPDATE pending_uploads SET claimed_at = now() WHERE object_path = $1', [objectPath]);

  return {
    filename: pending.filename,
    object_path: objectPath,
    mime: pending.mime,        // derived from the extension, never the client
    bytes: bytes
  };
}

/**
 * A short-lived download link. `download` makes Supabase send
 * Content-Disposition: attachment, so a stored file can never be rendered in
 * this app's origin — the protection the streaming version provided.
 */
async function signedDownloadUrl(objectPath, filename) {
  var signed = await supabase.admin.storage.from(BUCKET)
    .createSignedUrl(objectPath, DOWNLOAD_URL_TTL, { download: filename || true });

  if (signed.error) {
    var err = new Error('No such attachment');
    err.status = 404;
    throw err;
  }
  return signed.data.signedUrl;
}

async function remove(objectPath) {
  try {
    await supabase.admin.storage.from(BUCKET).remove([objectPath]);
  } catch (err) {
    console.error('[storage] could not remove ' + objectPath + ':', err.message);
  }
}

/**
 * Sweep uploads that were reserved but never attached — a user who picked a
 * file and then closed the tab. Run by the cron.
 */
async function sweepUnclaimed(olderThanHours) {
  var hours = String(olderThanHours || 24);
  var stale = await sql.many(
    `SELECT object_path FROM pending_uploads
      WHERE claimed_at IS NULL AND created_at < now() - ($1 || ' hours')::interval
      LIMIT 200`, [hours]);

  if (!stale.length) return 0;
  var paths = stale.map(function (r) { return r.object_path; });

  await supabase.admin.storage.from(BUCKET).remove(paths);
  await sql.run('DELETE FROM pending_uploads WHERE object_path = ANY($1::text[])', [paths]);
  return paths.length;
}

/** Claimed rows whose comment is long gone — tidy the bookkeeping table. */
async function sweepClaimed(olderThanDays) {
  return sql.run(
    `DELETE FROM pending_uploads
      WHERE claimed_at IS NOT NULL AND claimed_at < now() - ($1 || ' days')::interval`,
    [String(olderThanDays || 7)]);
}

module.exports = {
  BUCKET: BUCKET,
  MAX_BYTES: MAX_BYTES,
  EXTENSIONS: EXTENSIONS,
  ACCEPT_ATTRIBUTE: ACCEPT_ATTRIBUTE,
  mimeFor: mimeFor,
  createUploadTicket: createUploadTicket,
  claimUpload: claimUpload,
  signedDownloadUrl: signedDownloadUrl,
  remove: remove,
  sweepUnclaimed: sweepUnclaimed,
  sweepClaimed: sweepClaimed
};
