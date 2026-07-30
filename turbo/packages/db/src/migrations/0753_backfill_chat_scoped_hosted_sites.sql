LOCK TABLE "hosted_sites", "hosted_deployments"
IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

CREATE FUNCTION "canonicalize_hosted_site_scope_0753"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."chat_thread_id" IS NOT NULL
      AND NEW."chat_thread_id" IS DISTINCT FROM OLD."chat_thread_id"
    THEN
      RAISE EXCEPTION 'Hosted site chat ownership is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."requested_slug" IS NULL THEN
    NEW."requested_slug" := NEW."slug";
  END IF;

  IF NEW."chat_thread_id" IS NULL AND NEW."created_from_run_id" IS NOT NULL THEN
    SELECT "run"."chat_thread_id"
    INTO NEW."chat_thread_id"
    FROM "zero_runs" AS "run"
    WHERE "run"."id"::text = NEW."created_from_run_id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "canonicalize_hosted_site_scope_0753"
BEFORE INSERT OR UPDATE OF "created_from_run_id", "requested_slug", "chat_thread_id"
ON "hosted_sites"
FOR EACH ROW EXECUTE FUNCTION "canonicalize_hosted_site_scope_0753"();--> statement-breakpoint

CREATE FUNCTION "enforce_hosted_deployment_scope_0753"() RETURNS trigger AS $$
DECLARE
  "site_chat_thread_id" uuid;
  "run_chat_thread_id" uuid;
BEGIN
  SELECT "site"."chat_thread_id"
  INTO "site_chat_thread_id"
  FROM "hosted_sites" AS "site"
  WHERE "site"."id" = NEW."site_id";

  IF NEW."run_id" IS NOT NULL THEN
    SELECT "run"."chat_thread_id"
    INTO "run_chat_thread_id"
    FROM "zero_runs" AS "run"
    WHERE "run"."id"::text = NEW."run_id";
  END IF;

  IF "site_chat_thread_id" IS DISTINCT FROM "run_chat_thread_id" THEN
    RAISE EXCEPTION
      'Hosted site belongs to a different chat; choose another site slug'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "enforce_hosted_deployment_scope_0753"
BEFORE INSERT ON "hosted_deployments"
FOR EACH ROW EXECUTE FUNCTION "enforce_hosted_deployment_scope_0753"();--> statement-breakpoint

UPDATE "hosted_sites"
SET "requested_slug" = "slug"
WHERE "requested_slug" IS NULL;--> statement-breakpoint

UPDATE "hosted_sites" AS "site"
SET "chat_thread_id" = "run"."chat_thread_id"
FROM "zero_runs" AS "run"
WHERE "run"."id"::text = "site"."created_from_run_id"
  AND "run"."chat_thread_id" IS NOT NULL
  AND "site"."chat_thread_id" IS NULL;
