-- Serialize reconciliation with the invariant preflight and constraint
-- transition. The ALTER statements require this lock mode later in the same
-- transaction, so observe blockers only after both relations are locked.
LOCK TABLE
	"connector_catalog_runtime_projection_sets",
	"connector_catalog_runtime_projections"
IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint

DO $$
DECLARE
	"unsupported_version_count" bigint;
	"missing_backend_authority_count" bigint;
	"missing_payload_count" bigint;
BEGIN
	-- Any nonzero count blocks the cutover. Cap each diagnostic scan while the
	-- exclusive locks are held so corrupt historical state cannot extend the
	-- deployment lock window without bound.
	SELECT count(*)
	INTO "unsupported_version_count"
	FROM (
		SELECT 1
		FROM "connector_catalog_runtime_projection_sets"
		WHERE "projection_version" <> 2
		LIMIT 1000
	) AS "unsupported_versions";

	SELECT count(*)
	INTO "missing_backend_authority_count"
	FROM (
		SELECT 1
		FROM "connector_catalog_runtime_projection_sets"
		WHERE "catalog_validation_backend_version" IS NULL
		LIMIT 1000
	) AS "missing_backend_authorities";

	SELECT count(*)
	INTO "missing_payload_count"
	FROM (
		SELECT 1
		FROM "connector_catalog_runtime_projections"
		WHERE "connector_payload" IS NULL
		LIMIT 1000
	) AS "missing_payloads";

	IF "unsupported_version_count" > 0
		OR "missing_backend_authority_count" > 0
		OR "missing_payload_count" > 0
	THEN
		RAISE EXCEPTION
			'Connector runtime projection v2 cutover blocked: unsupported_version=%, missing_backend_authority=%, missing_payload=%',
			"unsupported_version_count",
			"missing_backend_authority_count",
			"missing_payload_count";
	END IF;
END;
$$;--> statement-breakpoint

ALTER TABLE "connector_catalog_runtime_projection_sets" DROP CONSTRAINT "connector_catalog_projection_sets_version_positive";--> statement-breakpoint
ALTER TABLE "connector_catalog_runtime_projection_sets" DROP CONSTRAINT "connector_catalog_projection_sets_validator_complete";--> statement-breakpoint
ALTER TABLE "connector_catalog_runtime_projection_sets" ALTER COLUMN "catalog_validation_backend_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_runtime_projections" ALTER COLUMN "connector" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_runtime_projections" ALTER COLUMN "connector_payload" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_runtime_projection_sets" ADD CONSTRAINT "connector_catalog_projection_sets_version_supported" CHECK ("connector_catalog_runtime_projection_sets"."projection_version" = 2);--> statement-breakpoint
ALTER TABLE "connector_catalog_runtime_projection_sets" ADD CONSTRAINT "connector_catalog_projection_sets_validator_complete" CHECK ("connector_catalog_runtime_projection_sets"."catalog_validation_backend_version" ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
          AND (
            "connector_catalog_runtime_projection_sets"."catalog_validation_build_commit_sha" IS NULL
            OR "connector_catalog_runtime_projection_sets"."catalog_validation_build_commit_sha" ~ '^[a-f0-9]{40}$'
          ));
