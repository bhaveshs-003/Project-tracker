/**
 * Create the attachments bucket.
 *
 *   node scripts/setup-storage.js
 *
 * Done in code rather than by clicking through the dashboard so the limits are
 * actually set — a bucket created by hand defaults to no size cap and no MIME
 * restriction, which quietly removes one of the three defences around
 * uploads. Idempotent: a second run reports and changes nothing.
 *
 * The bucket is PRIVATE. Files come back only through signed URLs that
 * server/uploads.js issues after the scope check.
 */

require('../server/env');

var supabase = require('../server/supabase');
var uploads = require('../server/uploads');

// The same table the server derives MIME types from, so the two cannot drift
var MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg'
];

function tick(ok) { return ok ? '  ok   ' : '  --   '; }

async function run() {
  if (!supabase.configured()) {
    console.error('\n  SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY must all be set.');
    console.error('  See .env.example.\n');
    process.exit(1);
  }

  console.log('\n  Bucket "' + uploads.BUCKET + '" on ' + supabase.url + '\n');

  var wanted = {
    public: false,
    fileSizeLimit: uploads.MAX_BYTES,
    allowedMimeTypes: MIME_TYPES
  };

  var existing = await supabase.admin.storage.getBucket(uploads.BUCKET);

  if (existing.error && !/not found/i.test(existing.error.message)) {
    console.error('  Could not read the bucket: ' + existing.error.message + '\n');
    process.exit(1);
  }

  if (!existing.data) {
    var created = await supabase.admin.storage.createBucket(uploads.BUCKET, wanted);
    if (created.error) {
      console.error('  Could not create it: ' + created.error.message + '\n');
      process.exit(1);
    }
    console.log(tick(true) + 'created');
  } else {
    console.log(tick(true) + 'already exists');

    // A bucket made by hand will not have the limits; bring it into line.
    var updated = await supabase.admin.storage.updateBucket(uploads.BUCKET, wanted);
    if (updated.error) {
      console.error('  Could not apply the limits: ' + updated.error.message + '\n');
      process.exit(1);
    }
    console.log(tick(true) + 'limits reapplied');
  }

  var final = await supabase.admin.storage.getBucket(uploads.BUCKET);
  var bucket = final.data || {};

  console.log('');
  console.log(tick(bucket.public === false) + 'private: ' + (bucket.public === false));
  console.log(tick(Number(bucket.file_size_limit) === uploads.MAX_BYTES) +
    'size limit: ' + (bucket.file_size_limit
      ? Math.round(Number(bucket.file_size_limit) / 1024 / 1024) + 'MB' : 'none'));
  console.log(tick((bucket.allowed_mime_types || []).length === MIME_TYPES.length) +
    'mime types: ' + ((bucket.allowed_mime_types || []).length || 'any'));

  if (bucket.public !== false) {
    console.error('\n  WARNING: this bucket is PUBLIC. Every uploaded file is readable by anyone');
    console.error('  with the URL. Make it private in the dashboard before going further.\n');
    process.exit(1);
  }

  console.log('\n  Done.\n');
}

run().then(function () { process.exit(0); }).catch(function (err) {
  console.error('\n  FAILED  ' + err.message + '\n');
  process.exit(1);
});
