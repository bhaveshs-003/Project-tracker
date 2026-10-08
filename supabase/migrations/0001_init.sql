-- Functional Tool — initial Postgres schema.
--
-- Not a transliteration of the SQLite schema. Three things deliberately change:
--
--   · Dates are real `date` columns, nullable. SQLite stored '' for "not set",
--     which made every comparison lexical — `end < start` happened to work on
--     ISO strings and would have failed silently on anything else.
--   · `users` is gone. Supabase Auth owns credentials; `people.user_id` points
--     at auth.users for the people who can sign in, and is NULL for company
--     resources, which by design cannot.
--   · `sessions` is gone for the same reason.
--
-- Everything else — the delay/approval state machine, the CHECK constraints,
-- the cascade behaviour — carries across unchanged.

create extension if not exists citext;

-- ---------------------------------------------------------------
-- People
--
-- One row per human. A row with user_id can sign in; a company resource is a
-- directory record with no login, which is why user_id is nullable rather than
-- this being two tables.
-- ---------------------------------------------------------------
create table people (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid unique references auth.users(id) on delete set null,
  name       text   not null check (length(trim(name)) > 0),
  job_title  text   not null default '',
  email      citext unique,
  kind       text   not null check (kind in ('company','partner')),
  -- Mirrored from the JWT's app_metadata so it can be queried and joined.
  -- Authorization reads the token, never this column.
  role       text   check (role in ('admin','partner')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Anyone who can sign in must have an address to sign in with
  constraint people_login_needs_email check (user_id is null or email is not null)
);
create index people_kind_idx on people (kind);

-- ---------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------
create table projects (
  id             bigint generated always as identity primary key,
  code           citext not null unique,
  title          text   not null check (length(trim(title)) > 0),
  description    text   not null default '',
  type           text   not null default '',
  status         text   not null default 'Not Started'
                 check (status in ('Not Started','In-Progress','Completed')),

  -- The three negotiated ranges. NULL means "not set" — no more empty strings.
  partner_start  date, partner_end  date,
  company_start  date, company_end  date,
  approved_start date, approved_end date,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint projects_partner_range  check (partner_end  is null or partner_start  is null or partner_end  >= partner_start),
  constraint projects_company_range  check (company_end  is null or company_start  is null or company_end  >= company_start),
  constraint projects_approved_range check (approved_end is null or approved_start is null or approved_end >= approved_start)
);
create index projects_status_idx on projects (status);

create table project_resources (
  project_id bigint not null references projects(id) on delete cascade,
  person_id  uuid   not null references people(id)   on delete cascade,
  primary key (project_id, person_id)
);
create index project_resources_person_idx on project_resources (person_id);

create table project_pocs (
  project_id bigint not null references projects(id) on delete cascade,
  person_id  uuid   not null references people(id)   on delete cascade,
  primary key (project_id, person_id)
);
-- Every request from a partner filters through this index (see scope.js)
create index project_pocs_person_idx on project_pocs (person_id);

-- ---------------------------------------------------------------
-- Milestones and sub-tasks
-- ---------------------------------------------------------------
create table milestones (
  id             bigint generated always as identity primary key,
  project_id     bigint not null references projects(id) on delete cascade,
  title          text   not null check (length(trim(title)) > 0),
  position       integer not null default 0,

  company_start  date, company_end  date,
  partner_start  date, partner_end  date,
  approved_start date, approved_end date,

  completed      boolean not null default false,
  outcome        text    not null default '' check (outcome in ('','On-Time','Delayed')),
  delay_side     text    not null default '' check (delay_side in ('','Company Side','Partner Side')),
  delay_notes    text    not null default '',
  completed_at   date,

  approval       text    not null default 'none' check (approval in ('none','pending','approved')),
  submitted_at   date,
  submitted_by   uuid references people(id) on delete set null,
  approved_by    uuid references people(id) on delete set null,
  approved_at    date,

  feedback_rating   integer check (feedback_rating between 1 and 5),
  feedback_comment  text not null default '',

  -- The delay decision: persisted state written by its own authorised request,
  -- which is what stops an approve call from fabricating consent.
  delay_status      text not null default 'pending'
                    check (delay_status in ('pending','accepted','denied')),
  delay_decided_by  uuid references people(id) on delete set null,
  delay_decided_at  date,

  constraint milestones_company_range  check (company_end  is null or company_start  is null or company_end  >= company_start),
  constraint milestones_partner_range  check (partner_end  is null or partner_start  is null or partner_end  >= partner_start),
  constraint milestones_approved_range check (approved_end is null or approved_start is null or approved_end >= approved_start),
  -- A delay side and notes only mean something on a delayed item
  constraint milestones_delay_side_needs_delay check (delay_side = '' or outcome = 'Delayed')
);
create index milestones_project_idx on milestones (project_id, position, id);
create index milestones_approval_idx on milestones (approval) where approval = 'pending';

create table subtasks (
  id           bigint generated always as identity primary key,
  milestone_id bigint not null references milestones(id) on delete cascade,
  title        text   not null check (length(trim(title)) > 0),
  position     integer not null default 0,
  completed    boolean not null default false,
  outcome      text    not null default '' check (outcome in ('','On-Time','Delayed')),
  delay_side   text    not null default '' check (delay_side in ('','Company Side','Partner Side')),
  delay_notes  text    not null default '',
  completed_at date,

  delay_status     text not null default 'pending'
                   check (delay_status in ('pending','accepted','denied')),
  delay_decided_by uuid references people(id) on delete set null,
  delay_decided_at date,

  constraint subtasks_delay_side_needs_delay check (delay_side = '' or outcome = 'Delayed')
);
create index subtasks_milestone_idx on subtasks (milestone_id, position, id);

create table milestone_mentions (
  milestone_id bigint not null references milestones(id) on delete cascade,
  person_id    uuid   not null references people(id)     on delete cascade,
  primary key (milestone_id, person_id)
);

-- ---------------------------------------------------------------
-- Delay negotiation
-- ---------------------------------------------------------------
create table delay_comments (
  id           bigint generated always as identity primary key,
  item_type    text   not null check (item_type in ('milestone','subtask')),
  item_id      bigint not null,
  -- Carried on every row so the cascade and the visibility check are one join
  milestone_id bigint not null references milestones(id) on delete cascade,
  project_id   bigint not null references projects(id)   on delete cascade,
  author_id    uuid   not null references people(id)     on delete cascade,
  author_role  text   not null check (author_role in ('admin','partner')),
  decision     text   not null default '' check (decision in ('','accepted','denied')),
  body         text   not null default '',
  created_at   timestamptz not null default now()
);
create index delay_comments_item_idx    on delay_comments (item_type, item_id, created_at, id);
create index delay_comments_project_idx on delay_comments (project_id);
create index delay_comments_milestone_idx on delay_comments (milestone_id);

-- filename is what the user called it and is only ever echoed back as escaped
-- text. object_path is where it actually lives in Supabase Storage: a UUID, so
-- nothing user-controlled ever reaches a path.
create table attachments (
  id          bigint generated always as identity primary key,
  comment_id  bigint not null references delay_comments(id) on delete cascade,
  filename    text   not null,
  object_path text   not null unique,
  mime        text   not null,
  bytes       bigint not null check (bytes > 0),
  created_at  timestamptz not null default now()
);
create index attachments_comment_idx on attachments (comment_id, id);

-- A signed upload URL is issued before the comment exists, so the intent is
-- recorded here and reconciled when the comment claims it. Anything left
-- unclaimed is swept by the same cron that drains the outbox.
create table pending_uploads (
  object_path text primary key,
  person_id   uuid not null references people(id) on delete cascade,
  filename    text not null,
  mime        text not null,
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz
);
create index pending_uploads_unclaimed_idx on pending_uploads (created_at) where claimed_at is null;

-- ---------------------------------------------------------------
-- Outbox
--
-- dedupe_key is UNIQUE so a retry, a double-click or a crash mid-send cannot
-- enqueue twice. locked_until is the separate guard against two concurrent
-- cron invocations *sending* the same queued row twice.
-- ---------------------------------------------------------------
create table emails (
  id              bigint generated always as identity primary key,
  event           text not null,
  dedupe_key      text not null unique,
  to_email        citext not null,
  to_name         text not null default '',
  subject         text not null,
  text_body       text not null,
  html_body       text not null default '',
  project_id      bigint references projects(id)   on delete set null,
  milestone_id    bigint references milestones(id) on delete set null,
  status          text not null default 'queued' check (status in ('queued','sent','failed')),
  attempts        integer not null default 0,
  last_error      text not null default '',
  next_attempt_at timestamptz not null default now(),
  locked_until    timestamptz,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);
create index emails_pending_idx on emails (next_attempt_at, id)
  where status <> 'sent';

-- ---------------------------------------------------------------
-- Audit
--
-- Deliberately has no row cap. The SQLite version kept only the newest 500 and
-- DELETEd the rest, which makes it a recent-activity feed rather than an audit
-- trail. Retention is by age, run by the cron, and long enough to be evidence.
-- ---------------------------------------------------------------
create table audit (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  category   text not null,
  action     text not null,
  target     text not null default '',
  detail     text not null default '',
  project_id bigint references projects(id) on delete set null,
  actor_id   uuid,
  actor_name text not null,
  actor_role text not null
);
create index audit_at_idx on audit (at desc, id desc);
create index audit_project_idx on audit (project_id, at desc);

-- ---------------------------------------------------------------
-- Rate limiting
--
-- Postgres-backed on purpose: an in-memory counter is useless on serverless,
-- where each invocation may be a different instance.
-- ---------------------------------------------------------------
create table auth_attempts (
  id         bigint generated always as identity primary key,
  email      citext,
  ip         inet,
  kind       text not null check (kind in ('login','forgot','reset')),
  successful boolean not null default false,
  at         timestamptz not null default now()
);
create index auth_attempts_lookup_idx on auth_attempts (kind, email, ip, at desc);

-- ---------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger projects_touch before update on projects
  for each row execute function touch_updated_at();
create trigger people_touch before update on people
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------
-- Row Level Security
--
-- Express connects with the service-role key, which bypasses RLS entirely, so
-- these policies do not participate in the request path today. They exist so
-- that a client which later talks to Supabase directly — or a leaked anon key —
-- reads nothing rather than everything. Default deny, no policies granted.
-- ---------------------------------------------------------------
alter table people             enable row level security;
alter table projects           enable row level security;
alter table project_resources  enable row level security;
alter table project_pocs       enable row level security;
alter table milestones         enable row level security;
alter table subtasks           enable row level security;
alter table milestone_mentions enable row level security;
alter table delay_comments     enable row level security;
alter table attachments        enable row level security;
alter table pending_uploads    enable row level security;
alter table emails             enable row level security;
alter table audit              enable row level security;
alter table auth_attempts      enable row level security;

alter table people             force row level security;
alter table projects           force row level security;
alter table project_resources  force row level security;
alter table project_pocs       force row level security;
alter table milestones         force row level security;
alter table subtasks           force row level security;
alter table milestone_mentions force row level security;
alter table delay_comments     force row level security;
alter table attachments        force row level security;
alter table pending_uploads    force row level security;
alter table emails             force row level security;
alter table audit              force row level security;
alter table auth_attempts      force row level security;
