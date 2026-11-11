-- Row-level security for social_accounts and publication_targets, plus the scheduler hand-off (ADR 005).

-- social_accounts: standard tenant isolation.
ALTER TABLE "social_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "social_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "social_accounts"
  USING ("organization_id" = current_setting('app.org_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id')::uuid);

-- publication_targets: tenant isolation for the application role only. The scheduler role gets its own,
-- narrower policies below; keeping them on separate roles avoids evaluating current_setting('app.org_id')
-- (which fails without tenant context) inside the scheduler functions.
ALTER TABLE "publication_targets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "publication_targets" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "publication_targets" TO app_user
  USING ("organization_id" = current_setting('app.org_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id')::uuid);

-- app_scheduler (NOLOGIN, owner of the functions below): sees every organization's targets, but only a
-- few columns, and may only move them to 'queued'.
GRANT SELECT ("id", "organization_id", "state", "scheduled_at", "queued_at", "attempt_count")
  ON "publication_targets" TO app_scheduler;
GRANT UPDATE ("state", "queued_at", "attempt_count", "updated_at")
  ON "publication_targets" TO app_scheduler;
CREATE POLICY scheduler_read ON "publication_targets" FOR SELECT TO app_scheduler
  USING (true);
CREATE POLICY scheduler_queue ON "publication_targets" FOR UPDATE TO app_scheduler
  USING ("state" IN ('scheduled', 'queued'))
  WITH CHECK ("state" = 'queued');

-- Due and stale lookups.
CREATE INDEX "publication_targets_dispatch_idx" ON "publication_targets" ("state", "scheduled_at")
  WHERE "state" IN ('scheduled', 'queued');

-- Hands due targets to the queue: scheduled -> queued, once (FOR UPDATE SKIP LOCKED), across organizations.
-- Returns identifiers only, never content. The job then works inside withTenant(organization_id).
CREATE FUNCTION claim_due_publication_targets(p_horizon_seconds integer, p_limit integer)
RETURNS TABLE (organization_id uuid, target_id uuid, scheduled_at timestamptz, attempt_no integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF p_horizon_seconds IS NULL OR p_horizon_seconds < 0 OR p_horizon_seconds > 3600 THEN
    RAISE EXCEPTION 'p_horizon_seconds must be between 0 and 3600';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 1000';
  END IF;

  RETURN QUERY
  WITH due AS (
    SELECT t."id"
    FROM public."publication_targets" t
    WHERE t."state" = 'scheduled'
      AND t."scheduled_at" < now() + make_interval(secs => p_horizon_seconds)
    ORDER BY t."scheduled_at"
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public."publication_targets" t
  SET "state" = 'queued',
      "queued_at" = now(),
      "attempt_count" = t."attempt_count" + 1,
      "updated_at" = now()
  FROM due
  WHERE t."id" = due."id"
  RETURNING t."organization_id", t."id", t."scheduled_at", t."attempt_count";
END
$$;

-- Recovery: targets still 'queued' well after their time were probably lost between the database and the
-- queue (crash). Returns them again with the SAME attempt number, so re-adding the job is idempotent.
CREATE FUNCTION requeue_stale_publication_targets(p_grace_seconds integer, p_limit integer)
RETURNS TABLE (organization_id uuid, target_id uuid, scheduled_at timestamptz, attempt_no integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF p_grace_seconds IS NULL OR p_grace_seconds < 1 OR p_grace_seconds > 86400 THEN
    RAISE EXCEPTION 'p_grace_seconds must be between 1 and 86400';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 1000';
  END IF;

  RETURN QUERY
  WITH stale AS (
    SELECT t."id"
    FROM public."publication_targets" t
    WHERE t."state" = 'queued'
      AND t."scheduled_at" < now() - make_interval(secs => p_grace_seconds)
      AND t."queued_at" < now() - make_interval(secs => p_grace_seconds)
    ORDER BY t."scheduled_at"
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public."publication_targets" t
  SET "queued_at" = now(),
      "updated_at" = now()
  FROM stale
  WHERE t."id" = stale."id"
  RETURNING t."organization_id", t."id", t."scheduled_at", t."attempt_count";
END
$$;

-- The new owner needs USAGE and CREATE on the schema (granted here so the migration is self-contained,
-- including in Prisma's shadow database).
GRANT USAGE, CREATE ON SCHEMA public TO app_scheduler;
ALTER FUNCTION claim_due_publication_targets(integer, integer) OWNER TO app_scheduler;
ALTER FUNCTION requeue_stale_publication_targets(integer, integer) OWNER TO app_scheduler;
REVOKE ALL ON FUNCTION claim_due_publication_targets(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION requeue_stale_publication_targets(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_due_publication_targets(integer, integer) TO app_user;
GRANT EXECUTE ON FUNCTION requeue_stale_publication_targets(integer, integer) TO app_user;
