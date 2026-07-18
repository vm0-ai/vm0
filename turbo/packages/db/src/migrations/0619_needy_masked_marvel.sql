ALTER TABLE "mail_drafts" DROP CONSTRAINT "mail_drafts_id_chat_messages_mail_draft_id_fk";
--> statement-breakpoint
ALTER TABLE "mail_drafts" ALTER COLUMN "draft" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD COLUMN "chat_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD COLUMN "connector_id" uuid;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD COLUMN "gmail_draft_id" text;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD COLUMN "gmail_thread_id" text;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD COLUMN "gmail_message_id" text;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD COLUMN "sent_gmail_message_id" text;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD COLUMN "sender_name" text;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD COLUMN "sender_address" text;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD COLUMN "created_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD COLUMN "sent_at" timestamp;--> statement-breakpoint
UPDATE "mail_drafts" AS "draft"
SET "chat_thread_id" = "message"."chat_thread_id"
FROM "chat_messages" AS "message"
WHERE "message"."mail_draft_id" = "draft"."id";--> statement-breakpoint
DROP TRIGGER "chat_messages_reject_update" ON "chat_messages";--> statement-breakpoint
UPDATE "chat_messages"
SET "content" = '/mail/drafts/' || "mail_draft_id"::text
WHERE "mail_draft_id" IS NOT NULL
  AND ("content" IS NULL OR btrim("content") = '');--> statement-breakpoint
CREATE TRIGGER "chat_messages_reject_update"
BEFORE UPDATE ON "chat_messages"
FOR EACH ROW EXECUTE FUNCTION "reject_chat_event_source_update"();--> statement-breakpoint
CREATE FUNCTION "mail_drafts_fill_chat_thread_id_for_legacy_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT "chat_thread_id"
  INTO NEW."chat_thread_id"
  FROM "chat_messages"
  WHERE "mail_draft_id" = NEW."id";
  RETURN NEW;
END;
$$;--> statement-breakpoint
COMMENT ON FUNCTION "mail_drafts_fill_chat_thread_id_for_legacy_insert"() IS 'Rollout compatibility for API versions predating migration 0619; remove after those versions no longer serve traffic.';--> statement-breakpoint
CREATE TRIGGER "mail_drafts_fill_chat_thread_id_for_legacy_insert"
BEFORE INSERT ON "mail_drafts"
FOR EACH ROW
WHEN (NEW."chat_thread_id" IS NULL)
EXECUTE FUNCTION "mail_drafts_fill_chat_thread_id_for_legacy_insert"();--> statement-breakpoint
ALTER TABLE "mail_drafts" ALTER COLUMN "chat_thread_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD CONSTRAINT "mail_drafts_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD CONSTRAINT "mail_drafts_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mail_drafts_chat_thread" ON "mail_drafts" USING btree ("chat_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_drafts_connector_gmail_draft_unique" ON "mail_drafts" USING btree ("connector_id","gmail_draft_id");
