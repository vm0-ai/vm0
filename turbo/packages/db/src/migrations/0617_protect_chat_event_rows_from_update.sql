CREATE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "chat_messages_reject_update"
BEFORE UPDATE ON "chat_messages"
FOR EACH ROW EXECUTE FUNCTION "reject_chat_event_source_update"();--> statement-breakpoint

CREATE TRIGGER "chat_thread_events_reject_update"
BEFORE UPDATE ON "chat_thread_events"
FOR EACH ROW EXECUTE FUNCTION "reject_chat_event_source_update"();
