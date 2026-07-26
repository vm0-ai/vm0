-- This receiver-first compatibility classifier is installed before the API
-- writer can promote legacy Slack routes. Previous API revisions route every
-- retry on a canonical row directly into slack_chat_ingress and do not read
-- the cutover markers. Persisting an ignored tombstone keeps that old write
-- protocol idempotent without allowing the canonical processor to claim it.
CREATE FUNCTION "classify_legacy_slack_cutover_ingress"() RETURNS trigger AS $$
DECLARE
  cutover_event_id text;
  cutover_message_ts text;
  incoming_message_ts text;
BEGIN
  SELECT
    "legacy_cutover_event_id",
    "legacy_cutover_message_ts"
  INTO
    cutover_event_id,
    cutover_message_ts
  FROM "slack_chat_thread_routes"
  WHERE "id" = NEW."route_id";

  IF cutover_event_id IS NULL
    OR cutover_message_ts IS NULL
    OR NEW."event_id" = cutover_event_id THEN
    RETURN NEW;
  END IF;

  incoming_message_ts := NEW."payload"::jsonb #>> '{event,ts}';
  IF incoming_message_ts IS NULL
    OR incoming_message_ts !~ '^[0-9]+[.][0-9]+$'
    OR cutover_message_ts !~ '^[0-9]+[.][0-9]+$' THEN
    RAISE EXCEPTION 'Cannot classify Slack ingress against cutover boundary'
      USING ERRCODE = '22023';
  END IF;

  IF incoming_message_ts::numeric <= cutover_message_ts::numeric THEN
    NEW."status" := 'ignored';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "classify_legacy_slack_cutover_ingress"
BEFORE INSERT ON "slack_chat_ingress"
FOR EACH ROW
EXECUTE FUNCTION "classify_legacy_slack_cutover_ingress"();
