ALTER TABLE "slack_chat_thread_routes" ALTER COLUMN "backend" SET DEFAULT 'canonical';--> statement-breakpoint
-- Keep the previous API writer compatible while the canonical-only receiver
-- rolls out. New API revisions update only chat_thread_id; the trigger satisfies
-- the old backend/thread check and makes concurrent previous-writer rows
-- canonical without requiring the new reader to select legacy routing fields.
CREATE FUNCTION "canonicalize_slack_chat_thread_route"() RETURNS trigger AS $$
BEGIN
	IF NEW."chat_thread_id" IS NOT NULL THEN
		NEW."backend" := 'canonical';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "canonicalize_slack_chat_thread_route"
BEFORE INSERT OR UPDATE OF "chat_thread_id" ON "slack_chat_thread_routes"
FOR EACH ROW
EXECUTE FUNCTION "canonicalize_slack_chat_thread_route"();
