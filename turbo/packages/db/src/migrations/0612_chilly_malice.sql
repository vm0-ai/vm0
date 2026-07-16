ALTER TABLE "mail_drafts" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "mail_draft_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_mail_draft_id_unique" UNIQUE("mail_draft_id");--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD CONSTRAINT "mail_drafts_id_chat_messages_mail_draft_id_fk" FOREIGN KEY ("id") REFERENCES "public"."chat_messages"("mail_draft_id") ON DELETE cascade ON UPDATE no action;
