CREATE TABLE "mail_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_messages" DROP COLUMN "mail_draft";