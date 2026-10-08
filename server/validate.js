/**
 * Route plumbing: async error propagation and input validation.
 *
 * `asyncHandler` matters more than it looks. Express 4 does not await a
 * handler's returned promise, so once the handlers became async a rejection
 * stopped reaching the error middleware — the request would simply hang until
 * the client gave up, with nothing in the log. Every async handler is wrapped.
 *
 * The schemas replace the scattered `String(body.x || '').trim()` coercion.
 * Same effect, declared once per endpoint instead of re-derived at each use,
 * and a bad type is a 400 with a specific message rather than a silent ''.
 */

var z = require('zod');

/** Wrap an async handler so a rejected promise becomes next(err). */
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function badRequest(message) {
  var err = new Error(message);
  err.status = 400;
  return err;
}

/**
 * Parse `req.body` against a schema, or throw a 400 naming the first problem.
 * Returns the parsed value — callers use the result, never req.body, so an
 * unvalidated field cannot reach the database by accident.
 */
function body(schema, req) {
  var result = schema.safeParse(req.body || {});
  if (result.success) return result.data;

  var issue = result.error.issues[0];
  var path = issue.path.join('.');
  throw badRequest(path ? path + ': ' + issue.message : issue.message);
}

function query(schema, req) {
  var result = schema.safeParse(req.query || {});
  if (result.success) return result.data;
  var issue = result.error.issues[0];
  throw badRequest((issue.path.join('.') || 'query') + ': ' + issue.message);
}

// ---------------------------------------------------------------
// Shared field types
// ---------------------------------------------------------------

/** A trimmed, non-empty string with a cap, so a 2MB "title" cannot be stored. */
var text = function (label, max) {
  return z.string({ invalid_type_error: label + ' must be text' })
    .trim()
    .min(1, label + ' is required')
    .max(max || 200, label + ' is too long (max ' + (max || 200) + ')');
};

/** Optional free text — may be empty, still capped. */
var optionalText = function (max) {
  return z.string().trim().max(max || 2000).optional().default('');
};

/**
 * A calendar date or "not set". The client has always sent '' for an empty
 * date input; that becomes NULL rather than being stored as an empty string.
 */
var dateish = z.union([
  z.literal(''),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)')
]).optional().default('')
  .transform(function (v) { return v === '' ? null : v; });

var id = z.coerce.number().int().positive();
var uuid = z.string().uuid();

var pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  before: z.coerce.number().int().positive().optional()
});

module.exports = {
  z: z,
  asyncHandler: asyncHandler,
  badRequest: badRequest,
  body: body,
  query: query,
  text: text,
  optionalText: optionalText,
  dateish: dateish,
  id: id,
  uuid: uuid,
  pagination: pagination
};
