# Functional Tool

A project-tracking app for delivery work run jointly with a partner company: projects
carry milestones and sub-tasks, milestones go to the partner for approval, and any delay
has to be explicitly accepted or denied before that approval can happen.

Plain ES modules in the browser, Express and SQLite on the server. No build step — clone,
`npm install`, `npm start`.

---

## Running it

```bash
npm install
npm start          # http://localhost:3000
```

The database is created and seeded on first run. Two accounts exist:

| Role        | Email                     | Password       |
|-------------|---------------------------|----------------|
| Admin       | `abishek.m@makoitlab.com` | `Mako@123`     |
| Partner POC | `bhavesh.s@makoitlab.com` | `Partner@123`  |

To reset an existing database back to those two accounts: `node scripts/reset-accounts.js`

> Open `http://localhost:3000`, not `public/index.html` off the filesystem — the app is
> served from the same origin as the API so the session cookie works and there is no CORS.

---

## What it does

**Projects** carry three negotiated date ranges — company-provided, partner-provided and
approved — plus a type, a status that only moves forward, assigned company resources and
Partner POCs.

**Milestones and sub-tasks** are completed as On-Time or Delayed. A delay is attributed to
the company or the partner side and carries a reason. Completion is final.

**Approval.** The admin submits a completed milestone; the assigned Partner POC reviews it,
rates it 1–5 and leaves feedback that can `@`-mention anyone on the project. Feedback is
visible to the company side only — the server withholds the fields rather than trusting the
client to hide them.

**Delay negotiation.** Every delayed item on a submitted milestone becomes a thread. The POC
accepts or denies it with a comment and an optional attachment (pdf, doc, docx, xls, xlsx,
png, jpg, jpeg — 10MB). A denial blocks approval and opens a reply box for the admin, who can
answer only once a delay has actually been denied. The POC can then flip it to accepted and
approval unlocks.

**Notifications** go through an outbox: a state change writes its intent to send inside the
same transaction and returns immediately; a worker drains the queue separately with
exponential backoff. A broken mail server cannot fail an approval.

---

## Layout

```
server/
  index.js          Express app, route mounting, error handling
  db.js             schema, migrations, seed
  guards.js         sessions and the auth middleware
  scope.js          visibility as SQL — out-of-scope rows 404, they do not 403
  rules.js          the workflow state machine; every transition is checked here
  serialise.js      row → API shape, and where partner-visible fields are filtered
  uploads.js        multer config, extension allowlist, safe storage names
  routes/           session, people, projects, milestones, delays, audit, emails
  mail/             transport, outbox worker, templates, notification scenarios

public/
  index.html        the shell; everything else renders into #view
  styles.css
  js/
    api.js          the single door to the server
    router.js       History API routing with role guards
    state.js        loaded projects and people
    ui.js           modals, confirm dialogs, toasts
    format.js       dates, escaping, badges, metrics
    views/          dashboard, projects, project, people, audit, profile

scripts/
  reset-accounts.js     restore the two seeded logins
  send-test-email.js    prove SMTP credentials work, bypassing the outbox
```

---

## Authorization

Three layers, all server-side. The client keeps its own copies of the rules purely so a
button can be disabled with a visible reason — none of them is load-bearing.

1. **Identity** — `guards.requireAuth` / `guards.requireRole`. Sessions live in SQLite, so a
   restart signs nobody out; the cookie is httpOnly.
2. **Scope** — `scope.js` expresses visibility as a SQL clause. A partner requesting a project
   they are not POC on gets a 404, not a 403, so project codes cannot be discovered by
   watching the status change.
3. **Rules** — `rules.js` decides whether a transition is legal at all.

Delay decisions are persisted state written by their own authorised request, so the approval
gate reads the database rather than trusting anything in the approve payload.

Passwords are scrypt with a per-user salt, compared with `timingSafeEqual`.

Uploaded files are stored under a UUID (nothing user-controlled reaches the filesystem),
live outside the statically-served directory, and come back only through an authenticated
route that forces `Content-Disposition: attachment` with `nosniff`.

---

## Email

Notifications default to a **log** transport that writes an `.eml` into `data/outbox/` and
sends nothing, which is what tests and local development run against.

For real mail through Google Workspace:

```bash
export MAIL_TRANSPORT=smtp
export SMTP_HOST=smtp.gmail.com
export SMTP_PORT=587                 # STARTTLS; 465 with SMTP_SECURE=true
export SMTP_USER=abishek.m@makoitlab.com
export SMTP_PASS='xxxx xxxx xxxx xxxx'    # a 16-char App Password, not the login password
export MAIL_FROM='Functional Tool <abishek.m@makoitlab.com>'
export MAIL_ALLOWLIST=abishek.m@makoitlab.com,bhavesh.s@makoitlab.com
npm start
```

`MAIL_FROM` must match `SMTP_USER` or a verified "Send mail as" alias — Google silently
rewrites a From header it does not recognise. App Passwords only exist once 2-Step
Verification is enabled on the account.

Test the credentials on their own, bypassing the app entirely:

```bash
node scripts/send-test-email.js bhavesh.s@makoitlab.com
```

`MAIL_ALLOWLIST` is the staging safety net: with SMTP configured, only listed addresses are
actually sent to and everything else is recorded as skipped.

---

## Notes

- `data/` is gitignored. It holds the live database, the outbox and uploaded attachments —
  runtime state, recreated on first run.
- `old/` is the original single-file prototype, kept for reference and not wired to anything.
- `better-sqlite3` is pinned to 12.x deliberately: 13.x requires Node ≥ 22.
