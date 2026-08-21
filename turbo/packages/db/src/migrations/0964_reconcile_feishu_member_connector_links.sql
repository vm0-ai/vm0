-- The exact Feishu member writer has been deployed since api-v1.464.0. It
-- commits the member connector link and Feishu external identity together.
-- Serialize with the production custom-connector reconciler before reading an
-- installation target. The reconciler uses this key while it repairs a null or
-- stale custom_connector_id, so observing its previous committed value could
-- otherwise delete a member relationship that is concurrently becoming exact.
DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'feishu_custom_connector:' || "installation"."id"::text,
      0
    )
  )
  FROM "feishu_org_installations" AS "installation"
  ORDER BY "installation"."id";
END;
$$;

-- Block concurrent status/connect/disconnect transactions so reconciliation
-- cannot delete a member row after a reconnect has selected it but before that
-- reconnect writes the exact relationship.
LOCK TABLE "feishu_org_connections" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  "repaired_identity_count" bigint;
  "relinked_member_count" bigint;
  "deleted_member_count" bigint;
BEGIN
  -- Migration 0946 linked historical member rows before Feishu external
  -- identity was stored on connector accounts. The existing exact relationship
  -- is authoritative only when installation target, organization, member, and
  -- OAuth account ownership all agree.
  UPDATE "connectors" AS "connector"
  SET
    "external_id" = "feishu_connection"."feishu_open_id",
    "updated_at" = CURRENT_TIMESTAMP
  FROM "feishu_org_connections" AS "feishu_connection"
  INNER JOIN "feishu_org_installations" AS "installation"
    ON "installation"."id" = "feishu_connection"."installation_id"
  WHERE "connector"."id" = "feishu_connection"."connector_id"
    AND "installation"."custom_connector_id" IS NOT NULL
    AND "connector"."custom_connector_id" = "installation"."custom_connector_id"
    AND "connector"."org_id" = "installation"."org_id"
    AND "connector"."user_id" = "feishu_connection"."user_id"
    AND "connector"."auth_method" = 'oauth'
    AND "connector"."external_id" IS NULL;
  GET DIAGNOSTICS "repaired_identity_count" = ROW_COUNT;

  -- A null member link can be repaired only by exact external identity. Account
  -- cardinality is not identity authority, and an account already claimed by
  -- another member relationship cannot be reassigned.
  WITH "candidate_pairs" AS (
    SELECT
      "feishu_connection"."id" AS "feishu_connection_id",
      "connector"."id" AS "connector_id",
      count(*) OVER (
        PARTITION BY "feishu_connection"."id"
      ) AS "connection_match_count",
      count(*) OVER (
        PARTITION BY "connector"."id"
      ) AS "connector_match_count"
    FROM "feishu_org_connections" AS "feishu_connection"
    INNER JOIN "feishu_org_installations" AS "installation"
      ON "installation"."id" = "feishu_connection"."installation_id"
    INNER JOIN "connectors" AS "connector"
      ON "connector"."custom_connector_id" = "installation"."custom_connector_id"
      AND "connector"."org_id" = "installation"."org_id"
      AND "connector"."user_id" = "feishu_connection"."user_id"
      AND "connector"."auth_method" = 'oauth'
      AND "connector"."external_id" = "feishu_connection"."feishu_open_id"
    WHERE "feishu_connection"."connector_id" IS NULL
      AND "installation"."custom_connector_id" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM "feishu_org_connections" AS "claimed_connection"
        WHERE "claimed_connection"."connector_id" = "connector"."id"
      )
  ),
  "exact_candidates" AS (
    SELECT
      "feishu_connection_id",
      "connector_id"
    FROM "candidate_pairs"
    WHERE "connection_match_count" = 1
      AND "connector_match_count" = 1
  )
  UPDATE "feishu_org_connections" AS "feishu_connection"
  SET
    "connector_id" = "candidate"."connector_id",
    "updated_at" = CURRENT_TIMESTAMP
  FROM "exact_candidates" AS "candidate"
  WHERE "feishu_connection"."id" = "candidate"."feishu_connection_id";
  GET DIAGNOSTICS "relinked_member_count" = ROW_COUNT;

  -- A remaining row cannot be authenticated by current exact authorities. Drop
  -- only the member relationship; it does not own arbitrary connector
  -- credentials and therefore cannot authorize deleting a connector account.
  DELETE FROM "feishu_org_connections" AS "feishu_connection"
  WHERE NOT EXISTS (
    SELECT 1
    FROM "feishu_org_installations" AS "installation"
    INNER JOIN "connectors" AS "connector"
      ON "connector"."id" = "feishu_connection"."connector_id"
      AND "connector"."custom_connector_id" = "installation"."custom_connector_id"
      AND "connector"."org_id" = "installation"."org_id"
      AND "connector"."user_id" = "feishu_connection"."user_id"
      AND "connector"."auth_method" = 'oauth'
      AND "connector"."external_id" = "feishu_connection"."feishu_open_id"
    WHERE "installation"."id" = "feishu_connection"."installation_id"
      AND "installation"."custom_connector_id" IS NOT NULL
  );
  GET DIAGNOSTICS "deleted_member_count" = ROW_COUNT;

  IF EXISTS (
    SELECT 1
    FROM "feishu_org_connections" AS "feishu_connection"
    WHERE NOT EXISTS (
      SELECT 1
      FROM "feishu_org_installations" AS "installation"
      INNER JOIN "connectors" AS "connector"
        ON "connector"."id" = "feishu_connection"."connector_id"
        AND "connector"."custom_connector_id" = "installation"."custom_connector_id"
        AND "connector"."org_id" = "installation"."org_id"
        AND "connector"."user_id" = "feishu_connection"."user_id"
        AND "connector"."auth_method" = 'oauth'
        AND "connector"."external_id" = "feishu_connection"."feishu_open_id"
      WHERE "installation"."id" = "feishu_connection"."installation_id"
        AND "installation"."custom_connector_id" IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'Invalid Feishu member connector relationships remain after reconciliation';
  END IF;

  RAISE NOTICE
    'Feishu member connector reconciliation complete: repaired identities=%, relinked members=%, deleted invalid members=%',
    "repaired_identity_count",
    "relinked_member_count",
    "deleted_member_count";
END;
$$;
