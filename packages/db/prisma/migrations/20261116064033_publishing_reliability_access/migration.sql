-- Publishing reliability (ADR 013): retries, reconciliation, 15-minute pre-check, transactional outbox.
-- Same pattern as ADR 005: cross-organization work goes ONLY through SECURITY DEFINER functions owned by
-- the NOLOGIN role app_scheduler, which return identifiers; each job then works inside withTenant().
-- Every policy below is narrow (one state in, one state out) and listed in test/rls-coverage.test.ts.

-- ---------------------------------------------------------------------------------------------------------
-- publication_targets: what the scheduler role may read and change.
-- ---------------------------------------------------------------------------------------------------------
GRANT SELECT ("retry_at", "reconcile_count", "prechecked_at") ON "publication_targets" TO app_scheduler;
GRANT UPDATE ("retry_at", "prechecked_at") ON "publication_targets" TO app_scheduler;

-- retrying -> queued, once the retry time has come.
CREATE POLICY scheduler_retry ON "publication_targets" FOR UPDATE TO app_scheduler
  USING ("state" = 'retrying')
  WITH CHECK ("state" = 'queued');

-- unknown_outcome stays unknown_outcome: the scheduler only takes a lease (retry_at) on the check.
CREATE POLICY scheduler_reconcile ON "publication_targets" FOR UPDATE TO app_scheduler
  USING ("state" = 'unknown_outcome')
  WITH CHECK ("state" = 'unknown_outcome');

-- scheduled stays scheduled: the scheduler only marks the pre-check as taken (prechecked_at).
CREATE POLICY scheduler_precheck ON "publication_targets" FOR UPDATE TO app_scheduler
  USING ("state" = 'scheduled')
  WITH CHECK ("state" = 'scheduled');

CREATE INDEX "publication_targets_follow_up_idx" ON "publication_targets" ("state", "retry_at")
  WHERE "state" IN ('retrying', 'unknown_outcome');
CREATE INDEX "publication_targets_precheck_idx" ON "publication_targets" ("scheduled_at")
  WHERE "state" = 'scheduled' AND "prechecked_at" IS NULL;

-- Retries due within the horizon: retrying -> queued, new attempt number. Returns the retry time as the
-- moment to run (the job is queued with that exact delay).
CREATE FUNCTION claim_due_retries(p_horizon_seconds integer, p_limit integer)
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
    SELECT t."id", t."retry_at"
    FROM public."publication_targets" t
    WHERE t."state" = 'retrying'
      AND t."retry_at" < now() + make_interval(secs => p_horizon_seconds)
    ORDER BY t."retry_at"
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
  RETURNING t."organization_id", t."id", due."retry_at", t."attempt_count";
END
$$;

-- Unknown outcomes to check with the platform: takes a lease (retry_at = now + lease) so a check is not
-- started twice; the reconcile job sets the next check time or a final state. Returns the check number.
CREATE FUNCTION claim_due_reconciliations(p_lease_seconds integer, p_limit integer)
RETURNS TABLE (organization_id uuid, target_id uuid, check_no integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 86400 THEN
    RAISE EXCEPTION 'p_lease_seconds must be between 1 and 86400';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 1000';
  END IF;

  RETURN QUERY
  WITH due AS (
    SELECT t."id"
    FROM public."publication_targets" t
    WHERE t."state" = 'unknown_outcome'
      AND (t."retry_at" IS NULL OR t."retry_at" <= now())
    ORDER BY t."retry_at" NULLS FIRST
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public."publication_targets" t
  SET "retry_at" = now() + make_interval(secs => p_lease_seconds),
      "updated_at" = now()
  FROM due
  WHERE t."id" = due."id"
  RETURNING t."organization_id", t."id", t."reconcile_count";
END
$$;

-- Targets due within the lead time (15 minutes) whose pre-check has not run: marks it taken, once.
CREATE FUNCTION claim_due_prechecks(p_lead_seconds integer, p_limit integer)
RETURNS TABLE (organization_id uuid, target_id uuid, scheduled_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF p_lead_seconds IS NULL OR p_lead_seconds < 0 OR p_lead_seconds > 86400 THEN
    RAISE EXCEPTION 'p_lead_seconds must be between 0 and 86400';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 1000';
  END IF;

  RETURN QUERY
  WITH due AS (
    SELECT t."id"
    FROM public."publication_targets" t
    WHERE t."state" = 'scheduled'
      AND t."prechecked_at" IS NULL
      AND t."scheduled_at" < now() + make_interval(secs => p_lead_seconds)
    ORDER BY t."scheduled_at"
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public."publication_targets" t
  SET "prechecked_at" = now(),
      "updated_at" = now()
  FROM due
  WHERE t."id" = due."id"
  RETURNING t."organization_id", t."id", t."scheduled_at";
END
$$;

-- ---------------------------------------------------------------------------------------------------------
-- outbox_events: tenant isolation for the application; the relay reads and marks across organizations.
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "outbox_events" TO app_user
  USING ("organization_id" = current_setting('app.org_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id')::uuid);

GRANT SELECT ("id", "organization_id", "type", "payload", "created_at", "claimed_at", "delivered_at")
  ON "outbox_events" TO app_scheduler;
GRANT UPDATE ("claimed_at", "delivered_at") ON "outbox_events" TO app_scheduler;
CREATE POLICY relay_read ON "outbox_events" FOR SELECT TO app_scheduler
  USING (true);
CREATE POLICY relay_mark ON "outbox_events" FOR UPDATE TO app_scheduler
  USING ("delivered_at" IS NULL)
  WITH CHECK (true);

CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" ("created_at")
  WHERE "delivered_at" IS NULL;

-- Events not delivered yet (and not leased by a live relay): leases them, oldest first.
CREATE FUNCTION claim_outbox_events(p_lease_seconds integer, p_limit integer)
RETURNS TABLE (event_id uuid, organization_id uuid, type text, payload jsonb, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'p_lease_seconds must be between 1 and 3600';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 1000';
  END IF;

  RETURN QUERY
  WITH pending AS (
    SELECT e."id"
    FROM public."outbox_events" e
    WHERE e."delivered_at" IS NULL
      AND (e."claimed_at" IS NULL OR e."claimed_at" < now() - make_interval(secs => p_lease_seconds))
    ORDER BY e."created_at"
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public."outbox_events" e
  SET "claimed_at" = now()
  FROM pending
  WHERE e."id" = pending."id"
  RETURNING e."id", e."organization_id", e."type", e."payload", e."created_at";
END
$$;

-- Marks events as handed to the queue (after the queue accepted them; the job id is the event id, so a
-- second hand-off after a crash is a no-op in the queue).
CREATE FUNCTION complete_outbox_events(p_event_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  marked integer;
BEGIN
  IF p_event_ids IS NULL OR cardinality(p_event_ids) > 1000 THEN
    RAISE EXCEPTION 'p_event_ids must hold at most 1000 ids';
  END IF;
  UPDATE public."outbox_events"
  SET "delivered_at" = now()
  WHERE "id" = ANY (p_event_ids) AND "delivered_at" IS NULL;
  GET DIAGNOSTICS marked = ROW_COUNT;
  RETURN marked;
END
$$;

ALTER FUNCTION claim_due_retries(integer, integer) OWNER TO app_scheduler;
ALTER FUNCTION claim_due_reconciliations(integer, integer) OWNER TO app_scheduler;
ALTER FUNCTION claim_due_prechecks(integer, integer) OWNER TO app_scheduler;
ALTER FUNCTION claim_outbox_events(integer, integer) OWNER TO app_scheduler;
ALTER FUNCTION complete_outbox_events(uuid[]) OWNER TO app_scheduler;
REVOKE ALL ON FUNCTION claim_due_retries(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_due_reconciliations(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_due_prechecks(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_outbox_events(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_outbox_events(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_due_retries(integer, integer) TO app_user;
GRANT EXECUTE ON FUNCTION claim_due_reconciliations(integer, integer) TO app_user;
GRANT EXECUTE ON FUNCTION claim_due_prechecks(integer, integer) TO app_user;
GRANT EXECUTE ON FUNCTION claim_outbox_events(integer, integer) TO app_user;
GRANT EXECUTE ON FUNCTION complete_outbox_events(uuid[]) TO app_user;
