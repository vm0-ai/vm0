-- Custom SQL migration file, put your code below! --

-- Temporary #30453 old-API/new-DB bridge for DB/API skew, whose observed
-- maximum exposure is about 102 minutes. Remove with #30468 only after the
-- pre-#30453 API is no longer serving, draining, or eligible for rollback.
CREATE FUNCTION "delete_chat_event_search_projection_1035"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
	DELETE FROM "public"."chat_event_search_messages"
	WHERE "chat_thread_id" = OLD."id";

	DELETE FROM "public"."chat_event_search_message_watermarks"
	WHERE "chat_thread_id" = OLD."id";

	RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "chat_threads_delete_search_projection_1035"
AFTER DELETE ON "public"."chat_threads"
FOR EACH ROW
EXECUTE FUNCTION "public"."delete_chat_event_search_projection_1035"();
