-- Agents created through the CLI/API without an explicit avatar were stored
-- with a NULL avatar_url and render with no avatar at all. Give each of them
-- one of the built-in preset avatars (preset:0 .. preset:4).
--
-- DB/API rollout fallback; observed maximum version-skew window: ~102 minutes.
-- The draining API release explicitly inserts NULL for omitted avatars. Keep
-- this bridge until every API version that can make that write, plus its
-- rollback window, has drained. Remove the trigger and function in #27356.
CREATE OR REPLACE FUNCTION "bridge_zero_agent_default_avatar_0927"()
RETURNS trigger AS $$
BEGIN
  IF NEW."avatar_url" IS NULL THEN
    NEW."avatar_url" := 'preset:' || floor(random() * 5)::int;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "bridge_zero_agent_default_avatar_0927"
BEFORE INSERT ON "zero_agents"
FOR EACH ROW
EXECUTE FUNCTION "bridge_zero_agent_default_avatar_0927"();--> statement-breakpoint

UPDATE "zero_agents"
SET "avatar_url" = 'preset:' || floor(random() * 5)::int
WHERE "avatar_url" IS NULL;
