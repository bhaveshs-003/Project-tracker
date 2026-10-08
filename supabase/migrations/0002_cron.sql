-- Scheduled work.
--
-- Applied to Supabase only — a local Postgres has neither pg_cron nor pg_net,
-- and does not need them: `npm start` runs the outbox on an in-process timer.
--
-- Why not Vercel Cron: on the Hobby plan it fires at most once a day, which is
-- useless for approval notifications. pg_cron lives in the database the app
-- already has and runs per minute on any plan.
--
-- BEFORE APPLYING, set the two settings at the bottom. They hold the URL and
-- the shared secret, and are read at call time so rotating the secret does not
-- mean re-creating the job.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------
-- The call
--
-- pg_net is asynchronous: net.http_post queues the request and returns
-- immediately, so a slow drain never holds a cron worker open. The endpoint
-- itself is idempotent and claims rows with FOR UPDATE SKIP LOCKED, so an
-- overlapping call is safe.
-- ---------------------------------------------------------------
create or replace function public.run_scheduled_work()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  app_url text := current_setting('app.base_url', true);
  secret  text := current_setting('app.cron_secret', true);
  request_id bigint;
begin
  if app_url is null or secret is null then
    raise warning 'run_scheduled_work: app.base_url or app.cron_secret is not set; skipping';
    return null;
  end if;

  select net.http_post(
    url     := app_url || '/api/internal/cron',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || secret),
    body    := '{}'::jsonb,
    timeout_milliseconds := 25000
  ) into request_id;

  return request_id;
end $$;

revoke all on function public.run_scheduled_work() from public, anon, authenticated;

-- ---------------------------------------------------------------
-- The schedule
--
-- Every minute: drains the outbox, releases locks left by an invocation that
-- died mid-send, sweeps unclaimed uploads, and prunes the rate-limit and audit
-- tables. See POST /api/internal/cron in server/app.js.
-- ---------------------------------------------------------------
select cron.unschedule('functional-tool-cron')
 where exists (select 1 from cron.job where jobname = 'functional-tool-cron');

select cron.schedule(
  'functional-tool-cron',
  '* * * * *',
  $$select public.run_scheduled_work()$$
);

-- ---------------------------------------------------------------
-- Configuration — EDIT THESE, then run this file.
--
-- ALTER DATABASE persists them across connections. The secret must match
-- CRON_SECRET in the Vercel environment.
--
--   ALTER DATABASE postgres SET app.base_url    = 'https://your-app.vercel.app';
--   ALTER DATABASE postgres SET app.cron_secret = 'the-value-of-CRON_SECRET';
--
-- Then confirm it is running:
--
--   SELECT jobname, schedule, active FROM cron.job;
--   SELECT status, return_message, start_time
--     FROM cron.job_run_details
--    WHERE jobname = 'functional-tool-cron'
--    ORDER BY start_time DESC LIMIT 5;
--
-- And that the HTTP call itself succeeded — pg_cron only reports that the
-- function ran, not what the endpoint answered:
--
--   SELECT status_code, content FROM net._http_response ORDER BY id DESC LIMIT 5;
-- ---------------------------------------------------------------
