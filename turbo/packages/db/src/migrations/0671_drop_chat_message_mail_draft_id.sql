ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_mail_draft_id_unique";--> statement-breakpoint
ALTER TABLE "chat_messages" DROP COLUMN "mail_draft_id";