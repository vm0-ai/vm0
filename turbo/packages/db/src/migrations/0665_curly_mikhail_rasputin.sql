DROP TABLE "email_reply_requests" CASCADE;--> statement-breakpoint
DROP TABLE "email_thread_sessions" CASCADE;--> statement-breakpoint
ALTER TABLE "email_outbox" DROP COLUMN "post_send_action";