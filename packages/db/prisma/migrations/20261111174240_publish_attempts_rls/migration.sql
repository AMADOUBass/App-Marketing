-- publish_attempts: standard tenant isolation.
ALTER TABLE "publish_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "publish_attempts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "publish_attempts"
  USING ("organization_id" = current_setting('app.org_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id')::uuid);

-- Lease sweep (ADR 005): a worker that dies mid-publish leaves its target in a publishing state forever.
-- After the lease, the scheduler moves it to unknown_outcome: never re-published blindly, reconciled first.
GRANT SELECT ("publishing_started_at") ON "publication_targets" TO app_scheduler;
CREATE POLICY scheduler_expire ON "publication_targets" FOR UPDATE TO app_scheduler
  USING ("state" IN ('publishing', 'uploading', 'remote_processing'))
  WITH CHECK ("state" = 'unknown_outcome');

CREATE INDEX "publication_targets_in_flight_idx" ON "publication_targets" ("publishing_started_at")
  WHERE "state" IN ('publishing', 'uploading', 'remote_processing');

CREATE FUNCTION expire_stuck_publications(p_lease_seconds integer, p_limit integer)
RETURNS TABLE (organization_id uuid, target_id uuid, scheduled_at timestamptz, attempt_no integer)
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
  WITH stuck AS (
    SELECT t."id"
    FROM public."publication_targets" t
    WHERE t."state" IN ('publishing', 'uploading', 'remote_processing')
      AND t."publishing_started_at" < now() - make_interval(secs => p_lease_seconds)
    ORDER BY t."publishing_started_at"
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public."publication_targets" t
  SET "state" = 'unknown_outcome',
      "updated_at" = now()
  FROM stuck
  WHERE t."id" = stuck."id"
  RETURNING t."organization_id", t."id", t."scheduled_at", t."attempt_count";
END
$$;

ALTER FUNCTION expire_stuck_publications(integer, integer) OWNER TO app_scheduler;
REVOKE ALL ON FUNCTION expire_stuck_publications(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expire_stuck_publications(integer, integer) TO app_user;
