-- Acquire the final ALTER TABLE lock modes up front so concurrent transactions
-- cannot deadlock while this migration upgrades weaker table locks.
-- #23793 owns cutover and #23794 owns bridge cleanup.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
LOCK TABLE
  "connector_external_code_sessions",
  "connector_oauth_device_authorization_sessions",
  "connector_oauth_states",
  "connectors",
  "user_connectors",
  "user_permission_grants"
IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint

ALTER TABLE "connector_external_code_sessions" ADD COLUMN "connector_slug" varchar(64);--> statement-breakpoint
ALTER TABLE "connector_oauth_device_authorization_sessions" ADD COLUMN "connector_slug" varchar(64);--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD COLUMN "connector_slug" varchar(64);--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "connector_slug" varchar(64);--> statement-breakpoint
ALTER TABLE "user_connectors" ADD COLUMN "connector_slug" varchar(64);--> statement-breakpoint
ALTER TABLE "user_permission_grants" ADD COLUMN "connector_slug" varchar(64);--> statement-breakpoint

CREATE FUNCTION "sync_connector_slug_from_type"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."connector_slug" IS NULL THEN
      NEW."connector_slug" := NEW."type";
    ELSIF NEW."type" IS NULL THEN
      NEW."type" := NEW."connector_slug";
    ELSIF NEW."connector_slug" IS DISTINCT FROM NEW."type" THEN
      RAISE EXCEPTION 'connector_slug and type must match';
    END IF;
  ELSIF NEW."connector_slug" IS DISTINCT FROM OLD."connector_slug"
    AND NEW."type" IS NOT DISTINCT FROM OLD."type"
  THEN
    NEW."type" := NEW."connector_slug";
  ELSIF NEW."type" IS DISTINCT FROM OLD."type"
    AND NEW."connector_slug" IS NOT DISTINCT FROM OLD."connector_slug"
  THEN
    NEW."connector_slug" := NEW."type";
  ELSIF NEW."connector_slug" IS DISTINCT FROM NEW."type" THEN
    RAISE EXCEPTION 'connector_slug and type must match';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE FUNCTION "sync_connector_slug_from_connector_type"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."connector_slug" IS NULL THEN
      NEW."connector_slug" := NEW."connector_type";
    ELSIF NEW."connector_type" IS NULL THEN
      NEW."connector_type" := NEW."connector_slug";
    ELSIF NEW."connector_slug" IS DISTINCT FROM NEW."connector_type" THEN
      RAISE EXCEPTION 'connector_slug and connector_type must match';
    END IF;
  ELSIF NEW."connector_slug" IS DISTINCT FROM OLD."connector_slug"
    AND NEW."connector_type" IS NOT DISTINCT FROM OLD."connector_type"
  THEN
    NEW."connector_type" := NEW."connector_slug";
  ELSIF NEW."connector_type" IS DISTINCT FROM OLD."connector_type"
    AND NEW."connector_slug" IS NOT DISTINCT FROM OLD."connector_slug"
  THEN
    NEW."connector_slug" := NEW."connector_type";
  ELSIF NEW."connector_slug" IS DISTINCT FROM NEW."connector_type" THEN
    RAISE EXCEPTION 'connector_slug and connector_type must match';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE FUNCTION "sync_connector_slug_from_connector_ref"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."connector_slug" IS NULL THEN
      NEW."connector_slug" := NEW."connector_ref";
    ELSIF NEW."connector_ref" IS NULL THEN
      NEW."connector_ref" := NEW."connector_slug";
    ELSIF NEW."connector_slug" IS DISTINCT FROM NEW."connector_ref" THEN
      RAISE EXCEPTION 'connector_slug and connector_ref must match';
    END IF;
  ELSIF NEW."connector_slug" IS DISTINCT FROM OLD."connector_slug"
    AND NEW."connector_ref" IS NOT DISTINCT FROM OLD."connector_ref"
  THEN
    NEW."connector_ref" := NEW."connector_slug";
  ELSIF NEW."connector_ref" IS DISTINCT FROM OLD."connector_ref"
    AND NEW."connector_slug" IS NOT DISTINCT FROM OLD."connector_slug"
  THEN
    NEW."connector_slug" := NEW."connector_ref";
  ELSIF NEW."connector_slug" IS DISTINCT FROM NEW."connector_ref" THEN
    RAISE EXCEPTION 'connector_slug and connector_ref must match';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "sync_connectors_connector_slug"
BEFORE INSERT OR UPDATE ON "connectors"
FOR EACH ROW EXECUTE FUNCTION "sync_connector_slug_from_type"();--> statement-breakpoint
CREATE TRIGGER "sync_connector_oauth_states_connector_slug"
BEFORE INSERT OR UPDATE ON "connector_oauth_states"
FOR EACH ROW EXECUTE FUNCTION "sync_connector_slug_from_type"();--> statement-breakpoint
CREATE TRIGGER "sync_user_connectors_connector_slug"
BEFORE INSERT OR UPDATE ON "user_connectors"
FOR EACH ROW EXECUTE FUNCTION "sync_connector_slug_from_connector_type"();--> statement-breakpoint
CREATE TRIGGER "sync_connector_oauth_device_sessions_connector_slug"
BEFORE INSERT OR UPDATE ON "connector_oauth_device_authorization_sessions"
FOR EACH ROW EXECUTE FUNCTION "sync_connector_slug_from_connector_type"();--> statement-breakpoint
CREATE TRIGGER "sync_connector_external_code_sessions_connector_slug"
BEFORE INSERT OR UPDATE ON "connector_external_code_sessions"
FOR EACH ROW EXECUTE FUNCTION "sync_connector_slug_from_connector_type"();--> statement-breakpoint
CREATE TRIGGER "sync_user_permission_grants_connector_slug"
BEFORE INSERT OR UPDATE ON "user_permission_grants"
FOR EACH ROW EXECUTE FUNCTION "sync_connector_slug_from_connector_ref"();--> statement-breakpoint

UPDATE "connectors"
SET "connector_slug" = "type"
WHERE "connector_slug" IS DISTINCT FROM "type";--> statement-breakpoint
UPDATE "connector_oauth_states"
SET "connector_slug" = "type"
WHERE "connector_slug" IS DISTINCT FROM "type";--> statement-breakpoint
UPDATE "user_connectors"
SET "connector_slug" = "connector_type"
WHERE "connector_slug" IS DISTINCT FROM "connector_type";--> statement-breakpoint
UPDATE "connector_oauth_device_authorization_sessions"
SET "connector_slug" = "connector_type"
WHERE "connector_slug" IS DISTINCT FROM "connector_type";--> statement-breakpoint
UPDATE "connector_external_code_sessions"
SET "connector_slug" = "connector_type"
WHERE "connector_slug" IS DISTINCT FROM "connector_type";--> statement-breakpoint
UPDATE "user_permission_grants"
SET "connector_slug" = "connector_ref"
WHERE "connector_slug" IS DISTINCT FROM "connector_ref";--> statement-breakpoint

CREATE INDEX "idx_connector_external_code_sessions_owner_slug_status" ON "connector_external_code_sessions" USING btree ("org_id","user_id","connector_slug","auth_method","status");--> statement-breakpoint
CREATE INDEX "idx_connector_oauth_device_sessions_owner_slug_status" ON "connector_oauth_device_authorization_sessions" USING btree ("org_id","user_id","connector_slug","auth_method","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connectors_org_user_slug" ON "connectors" USING btree ("org_id","user_id","connector_slug") WHERE "connectors"."connector_slug" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_connectors_unique_slug" ON "user_connectors" USING btree ("org_id","user_id","agent_id","connector_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_permission_grants_slug_permission" ON "user_permission_grants" USING btree ("org_id","user_id","agent_id","connector_slug","permission");--> statement-breakpoint
ALTER TABLE "connector_external_code_sessions" ADD CONSTRAINT "chk_connector_external_code_sessions_slug_matches_type" CHECK ("connector_external_code_sessions"."connector_slug" IS NOT NULL
          AND "connector_external_code_sessions"."connector_slug" = "connector_external_code_sessions"."connector_type");--> statement-breakpoint
ALTER TABLE "connector_oauth_device_authorization_sessions" ADD CONSTRAINT "chk_connector_oauth_device_sessions_slug_matches_type" CHECK ("connector_oauth_device_authorization_sessions"."connector_slug" IS NOT NULL
          AND "connector_oauth_device_authorization_sessions"."connector_slug" = "connector_oauth_device_authorization_sessions"."connector_type");--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD CONSTRAINT "chk_connector_oauth_states_slug_matches_type" CHECK ("connector_oauth_states"."connector_slug" IS NOT DISTINCT FROM "connector_oauth_states"."type");--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "chk_connectors_connector_slug_matches_type" CHECK ("connectors"."connector_slug" IS NOT DISTINCT FROM "connectors"."type");--> statement-breakpoint
ALTER TABLE "user_connectors" ADD CONSTRAINT "chk_user_connectors_slug_matches_type" CHECK ("user_connectors"."connector_slug" IS NOT NULL
          AND "user_connectors"."connector_slug" = "user_connectors"."connector_type");--> statement-breakpoint
ALTER TABLE "user_permission_grants" ADD CONSTRAINT "chk_user_permission_grants_slug_matches_ref" CHECK ("user_permission_grants"."connector_slug" IS NOT NULL
          AND "user_permission_grants"."connector_slug" = "user_permission_grants"."connector_ref");
