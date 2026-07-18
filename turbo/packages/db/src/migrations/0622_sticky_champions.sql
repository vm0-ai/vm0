DELETE FROM "chat_messages"
WHERE "mail_draft_id" IS NOT NULL
   OR ("role" = 'assistant' AND "content" LIKE '%/mail/drafts/%');--> statement-breakpoint
DELETE FROM "mail_drafts";--> statement-breakpoint
ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_mail_draft_id_unique";--> statement-breakpoint
ALTER TABLE "mail_drafts" ALTER COLUMN "chat_thread_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_drafts" ALTER COLUMN "gmail_draft_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_drafts" ALTER COLUMN "gmail_thread_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_drafts" ALTER COLUMN "gmail_message_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_drafts" ALTER COLUMN "status" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_drafts" ALTER COLUMN "sender_address" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_drafts" ALTER COLUMN "subject" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" DROP COLUMN "mail_draft_id";--> statement-breakpoint
ALTER TABLE "mail_drafts" DROP COLUMN "draft";
