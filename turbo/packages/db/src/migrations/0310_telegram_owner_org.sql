-- Telegram: add owner_user_id + org_id, pivot primary key from `id uuid` to
-- `telegram_bot_id varchar` (mirrors slack_org_installations), and remap the
-- `installation_id` foreign key columns in telegram_user_links and
-- telegram_messages to reference telegram_bot_id instead of the uuid `id`.

-- 1. Add new columns as nullable so we can back-fill before locking down.
ALTER TABLE "telegram_installations" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "telegram_installations" ADD COLUMN "org_id" text;--> statement-breakpoint

-- 2. Copy ownership from the legacy admin column.
UPDATE "telegram_installations" SET "owner_user_id" = "admin_user_id";--> statement-breakpoint

-- 3. Snapshot orgId from each installation's default agent compose.
UPDATE "telegram_installations" ti
   SET "org_id" = ac."org_id"
  FROM "agent_composes" ac
 WHERE ti."default_compose_id" = ac."id";--> statement-breakpoint

-- 4. Orphaned rows (compose deleted) cannot be anchored to an org and are
--    already non-functional. Log the count, then drop.
DO $$
DECLARE orphan_count int;
BEGIN
  SELECT count(*) INTO orphan_count
    FROM "telegram_installations" WHERE "org_id" IS NULL;
  IF orphan_count > 0 THEN
    RAISE NOTICE 'telegram-migration: deleting % orphan installations (no resolvable org)', orphan_count;
  END IF;
END $$;--> statement-breakpoint
DELETE FROM "telegram_installations" WHERE "org_id" IS NULL;--> statement-breakpoint

-- 5. Lock the new columns NOT NULL.
ALTER TABLE "telegram_installations" ALTER COLUMN "owner_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_installations" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint

-- 6. Drop the legacy admin column (unreferenced after step 2).
ALTER TABLE "telegram_installations" DROP COLUMN "admin_user_id";--> statement-breakpoint

-- 7. Rewrite child FKs from uuid(id) -> varchar(telegram_bot_id).
ALTER TABLE "telegram_user_links" DROP CONSTRAINT "telegram_user_links_installation_id_telegram_installations_id_fk";--> statement-breakpoint
ALTER TABLE "telegram_messages" DROP CONSTRAINT "telegram_messages_installation_id_telegram_installations_id_fk";--> statement-breakpoint

ALTER TABLE "telegram_user_links" ADD COLUMN "installation_bot_id" varchar(255);--> statement-breakpoint
UPDATE "telegram_user_links" ul
   SET "installation_bot_id" = ti."telegram_bot_id"
  FROM "telegram_installations" ti
 WHERE ul."installation_id" = ti."id";--> statement-breakpoint
ALTER TABLE "telegram_user_links" DROP COLUMN "installation_id";--> statement-breakpoint
ALTER TABLE "telegram_user_links" RENAME COLUMN "installation_bot_id" TO "installation_id";--> statement-breakpoint
ALTER TABLE "telegram_user_links" ALTER COLUMN "installation_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "telegram_messages" ADD COLUMN "installation_bot_id" varchar(255);--> statement-breakpoint
UPDATE "telegram_messages" m
   SET "installation_bot_id" = ti."telegram_bot_id"
  FROM "telegram_installations" ti
 WHERE m."installation_id" = ti."id";--> statement-breakpoint
ALTER TABLE "telegram_messages" DROP COLUMN "installation_id";--> statement-breakpoint
ALTER TABLE "telegram_messages" RENAME COLUMN "installation_bot_id" TO "installation_id";--> statement-breakpoint
ALTER TABLE "telegram_messages" ALTER COLUMN "installation_id" SET NOT NULL;--> statement-breakpoint

-- Unique index on (telegram_user_id, installation_id) was dropped together
-- with the installation_id column; recreate it now that the new column exists.
CREATE UNIQUE INDEX "idx_telegram_user_links_user_installation" ON "telegram_user_links" USING btree ("telegram_user_id","installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_telegram_messages_unique" ON "telegram_messages" USING btree ("installation_id","chat_id","message_id");--> statement-breakpoint
CREATE INDEX "idx_telegram_messages_chat" ON "telegram_messages" USING btree ("installation_id","chat_id");--> statement-breakpoint

-- 8. Pivot telegram_installations PK to telegram_bot_id.
ALTER TABLE "telegram_installations" DROP CONSTRAINT "telegram_installations_telegram_bot_id_unique";--> statement-breakpoint
ALTER TABLE "telegram_installations" DROP CONSTRAINT "telegram_installations_pkey";--> statement-breakpoint
ALTER TABLE "telegram_installations" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "telegram_installations" ADD CONSTRAINT "telegram_installations_pkey" PRIMARY KEY ("telegram_bot_id");--> statement-breakpoint

-- 9. Re-add child FKs pointing at the new PK.
-- NOTE: Postgres truncates identifiers to 63 chars; the FK name below is the
-- post-truncation form to keep the Drizzle snapshot and DB in sync.
ALTER TABLE "telegram_user_links" ADD CONSTRAINT "telegram_user_links_installation_id_telegram_installations_tele" FOREIGN KEY ("installation_id") REFERENCES "public"."telegram_installations"("telegram_bot_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_installation_id_telegram_installations_telegr" FOREIGN KEY ("installation_id") REFERENCES "public"."telegram_installations"("telegram_bot_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- 10. New indexes to support per-user list and per-org cleanup without joins.
CREATE INDEX "idx_telegram_installations_owner" ON "telegram_installations" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_telegram_installations_org" ON "telegram_installations" USING btree ("org_id");
