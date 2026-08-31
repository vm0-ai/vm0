-- Temporary #30453 old-API/new-DB bridge. The DB deploys up to about four
-- seconds before the API. Remove with #30468 only after the pre-#30453 API
-- artifact is no longer eligible for rollback.
CREATE FUNCTION "delete_chat_event_search_projection_1034"()
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
CREATE TRIGGER "chat_threads_delete_search_projection_1034"
AFTER DELETE ON "public"."chat_threads"
FOR EACH ROW
EXECUTE FUNCTION "public"."delete_chat_event_search_projection_1034"();
