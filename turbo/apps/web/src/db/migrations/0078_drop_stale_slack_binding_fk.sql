-- Drop stale CASCADE foreign key on slack_bindings.slack_user_link_id
--
-- Migration 0059 created an inline REFERENCES with ON DELETE CASCADE,
-- generating the auto-named constraint "slack_bindings_slack_user_link_id_fkey".
-- Migration 0063 was supposed to drop it and replace it with ON DELETE SET NULL
-- ("slack_bindings_slack_user_link_id_slack_user_links_id_fk"), but in some
-- environments the old CASCADE constraint survived, causing bindings to be
-- deleted instead of orphaned when a user link is removed.
ALTER TABLE "slack_bindings" DROP CONSTRAINT IF EXISTS "slack_bindings_slack_user_link_id_fkey";
