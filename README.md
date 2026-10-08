# Functional Tool

A project-tracking app for delivery work run jointly with a partner company: projects carry
milestones and sub-tasks, milestones go to the partner for approval, and any delay has to be
explicitly accepted or denied — with a comment and optional evidence — before that approval
can happen.

Express on Supabase Postgres, Supabase Auth and Supabase Storage. The frontend is plain ES
modules with no build step.

---

## Running it locally

You need Node 20+ and either a local Postgres or a Supabase project.

```bash
npm install
cp .env.example .env          # then fill it in
npm run migrate -- --local    # --local adds the auth.users stand-in
npm run seed
npm start                     # http://localhost:3000
```

`--local` applies `supabase/local-shim.sql`, which creates just enough of Supabase's `auth`
schema for the real migration to run against a plain Postgres. Never apply it to Supabase.

Seed accounts come from `SEED_ADMIN_*` and `SEED_PARTNER_*` in the environment. There are no
credentials in this repository.

---

## Deploying

### 1. Supabase

Create a project, then from the SQL editor (or `npm run migrate` with `DATABASE_URL` pointed
at it) apply `supabase/migrations/0001_init.sql`.

Create a **private** Storage bucket named `attachments`, with a 10 MB file-size limit and the
MIME types listed in `server/uploads.js`.

Then `supabase/migrations/0002_cron.sql`, after editing the two settings at the bottom of it:

```sql
ALTER DATABASE postgres SET app.base_url    = 'https://your-app.vercel.app';
ALTER DATABASE postgres SET app.cron_secret = '<the same value as CRON_SECRET>';
```

### 2. Vercel

Import the repository. `vercel.json` routes `/api/*` to the function and serves `public/`
from the CDN; there is nothing to build. Set every variable from `.env.example` in the
project's environment, with `NODE_ENV=production`.

### Connection strings — you need two

Supabase offers three. Which one goes where matters, and getting it wrong fails in ways
that look like something else entirely.

| Variable | Which string | Why |
|---|---|---|
| `DATABASE_URL` | **Transaction pooler**, port **6543** | What the app uses. A serverless function opens a connection per cold start, so it must go through a pooler. This is also why `sql.js` never names a prepared statement — transaction mode multiplexes one backend across callers, and a named statement from one request collides with the next. |
| `DIRECT_DATABASE_URL` | **Session pooler**, port **5432** | Migrations only. DDL, `CREATE EXTENSION` and multi-statement transactions need one backend for the whole session. `scripts/migrate.js` uses this when set. |

Not the direct connection (`db.<ref>.supabase.co`) for either: it is IPv6-only on new
projects and will not resolve from most home or office networks. Both pooler strings use the
same host and password and differ only by port.

TLS certificates are verified against the system CA store. `PGSSL_INSECURE=true` turns that
off and exists only for diagnosing a TLS problem — never leave it set.

### 3. Seed

```bash
DATABASE_URL=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
SEED_ADMIN_EMAIL=... SEED_ADMIN_PASSWORD=... \
SEED_PARTNER_EMAIL=... SEED_PARTNER_PASSWORD=... \
npm run seed
```

---

## What it does

**Projects** carry three negotiated date ranges — company-provided, partner-provided and
approved — plus a type, a status that only moves forward, assigned company resources and
Partner POCs.

**Milestones and sub-tasks** are completed as On-Time or Delayed. A delay is attributed to
the company or the partner side and carries a reason. Completion is final.

**Approval.** The admin submits a completed milestone; the assigned Partner POC rates it 1–5
and leaves feedback that can `@`-mention anyone on the project. Feedback is visible to the
company side only — the server withholds the fields rather than trusting the client to hide
them.

**Delay negotiation.** Every delayed item on a submitted milestone becomes a thread. The POC
accepts or denies it with a comment and an optional attachment. A denial blocks approval and
opens a reply box for the admin, who can answer only once a delay has actually been denied.
The POC can then flip it to accepted and approval unlocks.

**Notifications** go through an outbox: a state change writes its intent to send inside the
same transaction and returns immediately; a worker drains the queue separately with
exponential backoff. A broken mail server cannot fail an approval.

---

## Architecture notes

### Authorization — three server-side layers

The client keeps copies of the rules purely so a button can be disabled with a visible
reason. None of them is load-bearing.

1. **Identity** — `server/guards.js`. Supabase Auth owns credentials, but the browser never
   holds a token: Express brokers the sign-in and stores both tokens in **httpOnly cookies**,
   so an injected script cannot read or replay a session. Access tokens are verified locally
   against the JWKS, which keeps authentication off the network path.
2. **Scope** — `server/scope.js` expresses visibility as a SQL clause. A partner requesting a
   project they are not POC on gets **404, not 403**, so project codes cannot be discovered
   by watching the status change.
3. **Rules** — `server/rules.js` decides whether a transition is legal at all.

Delay decisions are persisted state written by their own authorised request, so the approval
gate reads the database rather than trusting anything in the approve payload.

RLS is enabled with no policies on every table. Express uses the service role and bypasses
it; the policies exist so a leaked anon key — or a future client talking to Supabase
directly — reads nothing rather than everything.

### Reads are set-based

`server/serialise.js` loads one query per *table* for a whole result set, never one per row.
The per-row shape it replaced cost 4,501 queries for a hundred projects; this costs 8,
whatever the row count. `tests/performance.test.js` fails if that starts growing again.

### Uploads never pass through the function

A serverless request body is capped at 4.5 MB, which a 10 MB attachment cannot fit through.
So Express checks permission and issues a signed upload URL, the browser PUTs the bytes
straight to Storage, and the comment then claims the object — at which point the server
re-reads its real size and type rather than believing the client. Downloads are 60-second
signed URLs that force `Content-Disposition: attachment`, so a stored file can never execute
in this app's origin.

### Scheduled work

There is no long-running process on serverless, so `pg_cron` inside Supabase calls
`POST /api/internal/cron` every minute. It drains the outbox, releases locks left by an
invocation that died mid-send, sweeps unclaimed uploads, and prunes the rate-limit and audit
tables. Rows are claimed with `FOR UPDATE SKIP LOCKED`, so two overlapping runs cannot send
the same message twice.

Running `npm start` locally uses an in-process timer instead; set `MAIL_WORKER_MS=off` to
disable it.

---

## Layout

```
api/index.js            Vercel entry point — exports the app, starts nothing
server/
  app.js                the Express app: headers, routes, error shaping
  index.js              local server: listen, in-process mail worker, shutdown
  sql.js                the only place that talks to Postgres
  supabase.js           Auth and Storage clients, JWT verification
  guards.js             sessions, role checks, rate limiting
  scope.js              visibility as SQL — out-of-scope rows 404, not 403
  rules.js              the workflow state machine
  serialise.js          set-based loading, and where partner-visible fields are filtered
  uploads.js            signed upload/download URLs, extension allowlist
  validate.js           asyncHandler and the zod schemas
  audit.js              the trail, with retention by age
  routes/               session, people, projects, milestones, delays, audit, emails
  mail/                 transport, outbox, templates, notification scenarios
public/                 the frontend: index.html, styles.css, js/
supabase/
  migrations/           0001_init.sql, 0002_cron.sql
  local-shim.sql        auth.users stand-in for a plain Postgres
scripts/
  migrate.js            apply migrations; --status, --local
  seed.js               accounts and sample data, from the environment
  send-test-email.js    prove SMTP works, bypassing the outbox
tests/                  see below
```

---

## Tests

```bash
npm test                  every suite
npm run test:api          HTTP surface, auth, rules, attachments
npm run test:schema       tables, constraints, indexes, RLS
npm run test:concurrency  pooling and the outbox race
npm run test:perf         N+1 regression
```

Each suite creates and drops its own database, so they never touch development data. They
need a local Postgres on the default port; the browser suite also needs Chrome and skips
cleanly without it.

The schema, every query, every rule, JWT verification, cookie handling, rate limiting and
error shaping are all real. Only Supabase Auth's password store and Supabase Storage are
faked, at their edges, in `tests/harness.js`.

---

## Email

Notifications default to a **log** transport that writes an `.eml` into `data/outbox/` and
sends nothing. For real mail, set `MAIL_TRANSPORT=smtp` with the `SMTP_*` variables.

Test the credentials alone, bypassing the app entirely:

```bash
node scripts/send-test-email.js someone@example.com
```

`MAIL_ALLOWLIST` is the staging safety net: with SMTP configured, only listed addresses are
actually sent to and everything else is recorded as skipped.

---

## Notes

- `data/` is gitignored. It holds the local mail outbox — runtime state only.
- `old/` is the original single-file prototype, kept for reference and wired to nothing.
- `@supabase/supabase-js` warns on Node 20. Vercel should be set to the Node 22 runtime.
